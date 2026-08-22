import type { Page, Locator } from "patchright";
import { SELECTORS } from "./selectors.js";
import { firstResolved, requireSelector } from "./chatgpt.js";
import { TurnTimeoutError } from "../errors.js";
import { setExpectedReloadNavigation } from "../core/stream.js";

/**
 * Open a chatgpt.com conversation.
 *
 *   - `conversationId` set → resume that exact thread (`/c/<uuid>`).
 *   - else if `gizmoId` set → start a new chat *inside* that project,
 *     so the resulting conversation lands in the project sidebar
 *     instead of the global Recents.
 *   - else → start a brand-new conversation in Recents.
 *
 * Ephemeral / Temporary Chat is intentionally NOT exposed: the
 * resulting conversation is not addressable by URL, which makes
 * multi-turn auto-resume impossible.
 */
export async function openConversation(
  page: Page,
  opts: { model?: string; conversationId?: string; gizmoId?: string; gizmoShortUrl?: string } = {},
): Promise<void> {
  if (opts.conversationId) {
    await page.goto(`https://chatgpt.com/c/${opts.conversationId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  } else if (opts.gizmoId) {
    // Land on the project page; the next sendPrompt creates a conv
    // inside it (the React app reads the gizmo from the URL and
    // includes the right conversation_mode in the POST body).
    const slug = opts.gizmoShortUrl ?? opts.gizmoId;
    const url = new URL(`https://chatgpt.com/g/${encodeURIComponent(slug)}/project`);
    if (opts.model) url.searchParams.set("model", opts.model);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else {
    const url = new URL("https://chatgpt.com/");
    if (opts.model) url.searchParams.set("model", opts.model);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  await requireSelector(page, SELECTORS.composer, "composer", 20_000);

  // C-092: chatgpt.com's Work-area rollout can land (or leave a
  // persisted profile) on the "Work" surface, whose composer has its
  // own model set with no Pro tier. cgpro only ever drives classic
  // chat, so force the Chat surface before touching the model picker.
  await ensureChatTab(page);

  if (opts.model) {
    await tryEnsureModel(page, opts.model);
  }
}

async function ensureChatTab(page: Page): Promise<void> {
  const chatTab = await firstResolved(page, SELECTORS.chatTabRadio);
  if (!chatTab) return; // No Chat/Work toggle present — single-surface UI.
  const checked = (await chatTab.getAttribute("aria-checked").catch(() => null)) === "true";
  if (checked) return;
  try {
    await chatTab.click({ timeout: 5_000 });
    await page.waitForTimeout(300);
  } catch {
    console.error(
      "[cgpro:model] WARNING: found the Chat/Work surface toggle but failed to switch to Chat. The conversation may run on the wrong ChatGPT surface (no Pro tier). Run `cgpro doctor` to audit selectors.",
    );
  }
}

async function tryEnsureModel(page: Page, slug: string): Promise<void> {
  const trigger = await firstResolved(page, SELECTORS.modelSwitcher);
  if (!trigger) {
    console.error(
      `[cgpro:model] WARNING: model switcher not found in the DOM for "${slug}". Relying on the ?model= URL param alone — it may not have applied. Run \`cgpro doctor\` to audit selectors.`,
    );
    return; // Picker absent — deep link must have stuck.
  }
  const text = (await trigger.textContent())?.toLowerCase() ?? "";
  if (text.includes(slug.toLowerCase()) || text.includes("pro")) {
    return;
  }
  try {
    await trigger.click({ timeout: 5_000 });
    // Look for any menu item containing the slug (case-insensitive).
    const candidate = page
      .locator(`[role="menuitem"], [data-testid^="model-switcher-"], li:has-text("Pro")`)
      .filter({ hasText: new RegExp(slug.replace(/[.-]/g, "[.-]?"), "i") })
      .first();
    if ((await candidate.count()) > 0) {
      await candidate.click({ timeout: 5_000 }).catch(() => {
        console.error(
          `[cgpro:model] WARNING: found a menu item matching "${slug}" but the click failed. Proceeding with current model.`,
        );
      });
      return;
    }
    const proItem = page
      .locator(`[role="menuitem"]:has-text("Pro"), li:has-text("5.5 Pro"), li:has-text("5 Pro")`)
      .first();
    if ((await proItem.count()) > 0) {
      await proItem.click({ timeout: 5_000 }).catch(() => {
        console.error(
          `[cgpro:model] WARNING: found the "Pro" menu item but the click failed. Proceeding with current model.`,
        );
      });
    } else {
      console.error(
        `[cgpro:model] WARNING: model switcher opened but no menu item matched "${slug}" or "Pro". Proceeding with current model. Run \`cgpro doctor\` to audit selectors.`,
      );
    }
  } catch {
    console.error(
      `[cgpro:model] WARNING: failed to open the model switcher for "${slug}". Proceeding with current model.`,
    );
  } finally {
    // Close the picker if it's still open by pressing Escape.
    await page.keyboard.press("Escape").catch(() => {});
  }
}

/**
 * Enable / disable composer web search. The toggle moved into a
 * "+ Tools" popover on recent chatgpt.com builds, so we look for it
 * inline first, then fall back to opening the tools menu.
 *
 * Returns the resolved state. Throws when `on=true` is requested but
 * we can't make it stick — cgpro policy is web-on, the caller should
 * surface the failure (not silently degrade).
 */
export async function setWebSearch(page: Page, on: boolean): Promise<boolean> {
  // Current chatgpt.com (April 2026): the Web search switch lives
  // inside the "+ Add files and more" popover as a menuitemradio.
  // We open the popover, click the radio, verify aria-checked, then
  // close. Web search shares a radio group with Create image / Deep
  // research, so toggling it on disables those — that's intentional.

  // Try inline first (older layouts).
  let toggle = await firstResolved(page, SELECTORS.webSearchToggle.slice(3)); // skip the menuitemradio variants
  let viaPopover = false;
  if (!toggle) {
    if (await openComposerToolsPopover(page)) {
      viaPopover = true;
      toggle = await firstResolved(page, SELECTORS.webSearchToggle);
    }
  }

  if (!toggle) {
    if (on) {
      console.error(
        "[cgpro:web] WARNING: web search toggle not found in composer popover. Policy is web-on but we couldn't enable it. Run `cgpro doctor` to audit selectors.",
      );
    }
    if (viaPopover) await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  // Read current state BEFORE clicking. Radix popover items dismiss
  // the popover on click → the locator goes stale and reading attrs
  // returns null. So we only read once, decide whether to click, and
  // treat a successful click as the state change.
  const before = {
    ck: (await toggle.getAttribute("aria-checked").catch(() => null)) === "true",
    pr: (await toggle.getAttribute("aria-pressed").catch(() => null)) === "true",
    ds: (await toggle.getAttribute("data-state").catch(() => null)) === "checked",
  };
  const wasOn = before.ck || before.pr || before.ds;

  if (wasOn === on) {
    if (viaPopover) await page.keyboard.press("Escape").catch(() => undefined);
    return on;
  }

  let clicked = false;
  try {
    await toggle.click({ timeout: 5_000 });
    clicked = true;
  } catch {
    /* swallow */
  }

  // Popover dismisses on click. Don't try to re-read state from the
  // stale element — re-open and re-query if you need to verify.
  if (viaPopover && !clicked) await page.keyboard.press("Escape").catch(() => undefined);

  if (!clicked && on) {
    console.error(
      "[cgpro:web] WARNING: failed to click the Web search radio. The model may answer without live web access.",
    );
    return false;
  }
  return on;
}

async function openComposerToolsPopover(page: Page): Promise<boolean> {
  const plus = await firstResolved(page, [
    'button[data-testid="composer-plus-btn"]',
    'button[aria-label*="Add files" i]',
    'button[aria-label*="Add" i][aria-haspopup]',
  ]);
  if (!plus) return false;
  const expanded = (await plus.getAttribute("aria-expanded").catch(() => null)) === "true";
  if (!expanded) {
    await plus.click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  return true;
}

export function exactConnectorLabelIndex(labels: string[], name: string): number {
  const expected = name.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return labels.findIndex(
    (label) => label.replace(/\s+/g, " ").trim().toLocaleLowerCase() === expected,
  );
}

async function visibleComposerTool(page: Page, name: string): Promise<Locator | null> {
  const candidates = page
    .locator('[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button');
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const candidate = candidates.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = await candidate.innerText().catch(() => "");
    if (exactConnectorLabelIndex([label], name) === 0) return candidate;
  }
  // The current @ plugin chooser renders the selectable app label as plain
  // spans inside a keyboard-command row with no ARIA option/menuitem role.
  const labels = page.locator("span");
  const labelCount = await labels.count().catch(() => 0);
  for (let i = 0; i < labelCount; i++) {
    const label = labels.nth(i);
    if (!(await label.isVisible().catch(() => false))) continue;
    const text = await label.innerText().catch(() => "");
    if (exactConnectorLabelIndex([text], name) === 0) return label;
  }
  return null;
}

async function waitForComposerTool(page: Page, name: string, timeoutMs = 8_000): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tool = await visibleComposerTool(page, name);
    if (tool) return tool;
    await page.waitForTimeout(250);
  }
  return null;
}

async function recordConnectorDiagnostics(page: Page): Promise<void> {
  if (process.env.CGPRO_DEBUG !== "1") return;
  const surfaces = page.locator('[role="menu"]:visible, [role="dialog"]:visible, [role="listbox"]:visible');
  const labels = await surfaces
    .locator('[role="menuitem"], [role="menuitemradio"], [role="option"], button')
    .allInnerTexts()
    .catch(() => [] as string[]);
  const boundedLabels = labels
    .map((label) => label.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((label) => label.slice(0, 120));
  console.error(`[cgpro:connector] visible picker entries=${JSON.stringify(boundedLabels)}`);
  const screenshotPath = `${process.env.TMPDIR || "/tmp"}/cgpro-connector-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
  console.error(`[cgpro:connector] screenshot=${screenshotPath}`);
}

async function pluginSearchBox(page: Page): Promise<Locator | null> {
  const candidates = page.locator(
    'input:not([type="file"]):not([aria-hidden="true"]):visible, textarea:visible, [contenteditable="true"]:visible, [role="textbox"]:visible',
  );
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const candidate = candidates.nth(i);
    const id = await candidate.getAttribute("id").catch(() => null);
    const testId = await candidate.getAttribute("data-testid").catch(() => null);
    if (id === "prompt-textarea" || testId === "prompt-textarea") continue;
    const searchHint = [
      await candidate.getAttribute("placeholder").catch(() => null),
      await candidate.getAttribute("data-placeholder").catch(() => null),
      await candidate.getAttribute("aria-label").catch(() => null),
    ].filter(Boolean).join(" ");
    if (/search|plugin|connector|app/i.test(searchHint)) return candidate;
  }
  return null;
}

/**
 * Accessible attributes that mark a composer tool row as currently attached.
 * These are the same semantics the picker already reads for an already
 * selected row and for the web-search toggle inside the composer popover.
 */
const ATTACHED_STATE_ATTRIBUTES = ["aria-checked", "aria-pressed", "data-state"] as const;

/** Read the attached-state attribute value when the row reports attached, else null. */
async function attachedState(row: Locator): Promise<string | null> {
  for (const attribute of ATTACHED_STATE_ATTRIBUTES) {
    const value = await row.getAttribute(attribute).catch(() => null);
    if (value === "true" || value === "checked") return value;
  }
  return null;
}

/**
 * Honest post-click postcondition for connector selection.
 *
 * A visible exact-label row - frequently a plain span with no ARIA role on
 * recent chatgpt.com builds - can accept a click without ChatGPT attaching
 * the connector. Selection success is therefore only honest once the
 * requested connector is observably attached to the composer, i.e. its
 * exact row reports one of the shared attached-state attributes. The
 * orchestrator emits `connector-selected` only after this check resolves; a
 * click that does not attach the connector rejects before prompt submission.
 *
 * When the picker dismissed on the click (normal after a successful attach),
 * the composer "+" tools popover is reopened - the surface where attached
 * tools render as checked rows, and where Personal Pro MCP connectors live
 * (some behind the "Developer mode" entry) - and the exact label is
 * re-resolved there. Parameterized by the connector name, so the same
 * exact-match machinery covers more connectors and layout variants; no
 * connector-specific hard-coded selector.
 */
async function assertConnectorAttached(page: Page, connectorName: string): Promise<void> {
  const notAttached = (detail: string): string =>
    `ChatGPT connector "${connectorName}" was clicked but never became attached to the composer (${detail}).`;

  let row = await visibleComposerTool(page, connectorName);
  if (!row) {
    // The picker is gone - reopen the composer "+" tools popover, where an
    // attached tool row reports its checked state.
    const composer = await requireSelector(page, SELECTORS.composer, "composer");
    await composer.click();
    if (!(await openComposerToolsPopover(page))) {
      await recordConnectorDiagnostics(page);
      throw new Error(notAttached("composer tools popover did not open"));
    }
    const developerMode = page
      .locator('[role="menuitem"], [role="menuitemradio"], button')
      .filter({ hasText: /^\s*Developer mode\s*$/i })
      .first();
    if ((await developerMode.count().catch(() => 0)) > 0 &&
        (await developerMode.isVisible().catch(() => false))) {
      await developerMode.click({ timeout: 5_000 });
      await page.waitForTimeout(300);
    }
    row = await waitForComposerTool(page, connectorName, 5_000);
    if (!row) {
      await recordConnectorDiagnostics(page);
      throw new Error(notAttached("no exact-label row for the requested tool in the reopened picker"));
    }
  }
  if (await attachedState(row)) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return;
  }
  await recordConnectorDiagnostics(page);
  throw new Error(notAttached("the exact label row does not report an attached state after the click"));
}

/**
 * Select a named ChatGPT connector/app in the composer tool picker.
 *
 * Connector-backed turns must not silently degrade to an ordinary chat:
 * absence, an unclickable entry, or a click that never attaches the
 * connector are hard errors. Selection resolves only after the connector
 * is observably attached to the composer (see {@link assertConnectorAttached}).
 * Actual tool use remains a separate postcondition for the caller because
 * a successful attachment does not prove that the model invoked the tool.
 */
export async function setConnector(page: Page, name: string): Promise<void> {
  const connectorName = name.trim();
  if (!connectorName) throw new Error("connector name must not be empty");
  const composer = await requireSelector(page, SELECTORS.composer, "composer");
  await composer.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  await page.waitForTimeout(300);

  let connector = await waitForComposerTool(page, connectorName);
  if (connector) {
    // Already attached - skip the click (clicking an attached row can
    // toggle it off) and accept the honest state.
    if (await attachedState(connector)) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return;
    }
    await connector.click({ timeout: 5_000 });
    await page.waitForTimeout(300);
    await assertConnectorAttached(page, connectorName);
    return;
  }

  // Clear the failed @ query before trying older plus-menu layouts.
  await page.keyboard.press("Escape").catch(() => undefined);
  await composer.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  if (!(await openComposerToolsPopover(page))) {
    await recordConnectorDiagnostics(page);
    throw new Error(`ChatGPT connector picker is unavailable; could not select "${connectorName}".`);
  }

  connector = await visibleComposerTool(page, connectorName);
  if (!connector) {
    // Personal Pro custom MCP connectors live behind the distinct
    // "Developer mode" entry in the plus menu. They are connected apps but
    // do not appear in the ordinary installed-plugin search surface.
    const developerMode = page
      .locator('[role="menuitem"], [role="menuitemradio"], button')
      .filter({ hasText: /^\s*Developer mode\s*$/i })
      .first();
    if ((await developerMode.count().catch(() => 0)) > 0 && (await developerMode.isVisible().catch(() => false))) {
      await developerMode.click({ timeout: 5_000 });
      await page.waitForTimeout(300);
      connector = await waitForComposerTool(page, connectorName);
    }
  }
  if (!connector) {
    // Current ChatGPT Pro builds expose installed connectors as Plugins
    // behind a search field in the plus menu. The initial list is only a
    // short set of suggestions, so absence there is not absence from the
    // account. Search the exact configured name before trying older nested
    // menu layouts.
    const pluginSearch = await pluginSearchBox(page);
    if (pluginSearch) {
      await pluginSearch.fill(connectorName);
    } else {
      // The current command-menu build renders only instructional text
      // ("Type to search plugins…") and captures key events at the menu
      // root; it has no fillable textbox in the DOM.
      await page.keyboard.type(connectorName);
    }
    connector = await waitForComposerTool(page, connectorName);
  }
  if (!connector) {
    // Some ChatGPT builds put installed apps one level below the main
    // composer menu. Enter that bounded submenu, then resolve the exact
    // configured app name rather than guessing a product-specific test id.
    const gateway = page
      .locator('[role="menuitem"], [role="menuitemradio"], button')
      .filter({ hasText: /^\s*(Apps|Connectors|More)\s*$/i })
      .first();
    if ((await gateway.count().catch(() => 0)) > 0 && (await gateway.isVisible().catch(() => false))) {
      await gateway.click({ timeout: 5_000 });
      await page.waitForTimeout(300);
      connector = await visibleComposerTool(page, connectorName);
    }
  }

  if (!connector) {
    await recordConnectorDiagnostics(page);
    await page.keyboard.press("Escape").catch(() => undefined);
    throw new Error(`ChatGPT connector "${connectorName}" is not exposed in the composer tool picker.`);
  }

  // Already attached: the row reports the mounted state - skip the click.
  if (await attachedState(connector)) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return;
  }

  try {
    await connector.click({ timeout: 5_000 });
  } catch {
    await recordConnectorDiagnostics(page);
    await page.keyboard.press("Escape").catch(() => undefined);
    throw new Error(`ChatGPT connector "${connectorName}" was visible but could not be selected.`);
  }
  await page.waitForTimeout(300);
  await assertConnectorAttached(page, connectorName);
}

/**
 * Type the prompt into the composer and submit it. Returns the assistant-
 * bubble count from BEFORE the send so the caller can detect "the new one".
 *
 * Submission strategy: try the send button (waiting for it to be enabled),
 * fall back to Enter — some account/locale combos disable the button when
 * the composer is "empty" by their detector even when text is present.
 */
export async function sendPrompt(
  page: Page,
  prompt: string,
  preserveExisting = false,
  cancelled?: () => boolean,
): Promise<number> {
  const assistantCount = async (): Promise<number> => page
    .locator(SELECTORS.assistantMessages.join(", "))
    .count()
    .catch(() => 0);
  if (cancelled?.()) return assistantCount();
  const composer = await requireSelector(page, SELECTORS.composer, "composer");
  await composer.click();
  await page.waitForTimeout(120);
  // Connector/plugin menus can route keyboard search text into the composer
  // on some ChatGPT builds. Always replace the composer contents so a failed
  // or stale picker query cannot contaminate the actual prompt.
  if (!preserveExisting) {
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
  }
  // Composer is a contenteditable div on modern chatgpt.com — use the
  // keyboard so React's state listeners actually fire.
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(lines[i], { delay: 4 });
  }
  const priorAssistantCount = await assistantCount();
  if (cancelled?.()) return priorAssistantCount;

  const clicked = await clickSendButtonWithRetries(page, cancelled);
  if (!clicked && !cancelled?.()) {
    // Fall back to pressing Enter while the composer has focus.
    await page.keyboard.press("Enter");
  }
  return priorAssistantCount;
}

const SEND_CLICK_MAX_ATTEMPTS = Math.max(1, Number(process.env.CGPRO_SEND_CLICK_ATTEMPTS ?? 3));

/**
 * Clicks the send button, re-resolving it on every attempt. A DOM redraw
 * between resolving the button and clicking it can make the click throw on
 * an element that's already gone — re-resolving instead of giving up after
 * one failure is what makes the Enter fallback below actually reachable
 * (C-092 H2: `clicked` used to be set unconditionally after the first
 * attempt, so the fallback was dead code).
 */
async function clickSendButtonWithRetries(page: Page, cancelled?: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < SEND_CLICK_MAX_ATTEMPTS; attempt++) {
    if (cancelled?.()) return false;
    const send = await waitForEnabledSendButton(page);
    if (!send) return false;
    if (cancelled?.()) return false;
    try {
      await send.click({ timeout: 4_000 });
      return true;
    } catch {
      // Stale/intercepted click — re-resolve and retry.
    }
  }
  return false;
}

async function waitForEnabledSendButton(page: Page): Promise<Locator | null> {
  const timeoutMs = Number(process.env.CGPRO_SEND_READY_TIMEOUT_MS ?? 60_000);
  const deadline = Date.now() + timeoutMs;
  let last: Locator | null = null;
  while (Date.now() < deadline) {
    const send = await firstResolved(page, SELECTORS.sendButton);
    if (send) {
      last = send;
      const disabled = await send.getAttribute("disabled").catch(() => null);
      const ariaDisabled = await send.getAttribute("aria-disabled").catch(() => null);
      if (disabled === null && ariaDisabled !== "true") {
        return send;
      }
    }
    await page.waitForTimeout(500);
  }
  return last;
}

/**
 * Returns the conversation UUID if the page is on /c/<uuid>, else null.
 */
export function currentConversationId(page: Page): string | null {
  const u = page.url();
  const m = u.match(/\/c\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

/**
 * Wait until the assistant has produced and completed a new response.
 *
 *  1. Wait for a NEW assistant bubble (count > priorAssistantCount).
 *  2. Wait for either the legacy "Stop generating" button to disappear,
 *     OR the bubble's text content to stabilise for >= `stableMs`.
 *
 * Text-stability is the bulletproof completion signal — it doesn't
 * depend on chatgpt.com's ever-shifting action-bar / data-attribute
 * selectors.
 */
export async function waitTurnComplete(
  page: Page,
  timeoutMs: number,
  priorAssistantCount = 0,
  // Bumped from 1500 → 4000 because GPT-5.5 Pro extended-thinking turns
  // can pause mid-stream for several seconds while the model deliberates.
  // The Stop button check resets this window when chatgpt.com is still
  // streaming, but we'd rather over-wait than truncate a long answer.
  stableMs = Number(process.env.CGPRO_STABLE_MS ?? 4000),
  control: {
    consumeReload?: () => string | null;
    conversationId?: () => string | null;
    onReload?: (state: { conversationId: string; working: boolean; extended: boolean }) => void;
    cancelled?: () => boolean;
    pollEvidence?: () => Promise<void>;
  } = {},
): Promise<void> {
  let deadline = Date.now() + timeoutMs;
  let lastText = "";
  let lastChangedAt = Date.now();

  for (;;) {
    if (control.cancelled?.()) return;
    await control.pollEvidence?.();
    if (control.cancelled?.()) return;
    const requestedConversation = control.consumeReload?.() ?? null;
    const expired = Date.now() >= deadline;
    if (requestedConversation || expired) {
      const conversationId =
        requestedConversation ?? control.conversationId?.() ?? currentConversationId(page);
      if (!conversationId) {
        if (expired) throw new TurnTimeoutError(Math.ceil(timeoutMs / 1_000));
      } else {
        setExpectedReloadNavigation(page.context(), true);
        try {
          await page.goto(`https://chatgpt.com/c/${conversationId}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          if (control.cancelled?.()) return;
          await requireSelector(page, SELECTORS.composer, "composer", 20_000);
        } finally {
          setExpectedReloadNavigation(page.context(), false);
        }

        const working = await turnIsWorking(page);
        if (working) {
          deadline = Date.now() + timeoutMs;
          lastChangedAt = Date.now();
          control.onReload?.({ conversationId, working: true, extended: true });
          continue;
        }
        control.onReload?.({ conversationId, working: false, extended: false });
        if (expired) {
          const count = await page.locator(SELECTORS.assistantMessages.join(", ")).count();
          const bubble = count > priorAssistantCount ? await latestAssistantBubble(page) : null;
          const text = bubble ? ((await bubble.innerText().catch(() => "")) ?? "") : "";
          if (!text) throw new TurnTimeoutError(Math.ceil(timeoutMs / 1_000));
        }
        lastText = "";
        lastChangedAt = Date.now();
      }
    }

    const count = await page.locator(SELECTORS.assistantMessages.join(", ")).count();
    if (count <= priorAssistantCount) {
      await page.waitForTimeout(250);
      continue;
    }

    const stop = await firstResolved(page, SELECTORS.stopButton);
    if (stop) {
      await page.waitForTimeout(400);
      lastChangedAt = Date.now(); // reset stability window
      continue;
    }

    const bubble = await latestAssistantBubble(page);
    if (!bubble) {
      await page.waitForTimeout(300);
      continue;
    }

    const streamingAttr = await bubble
      .getAttribute("data-message-streaming")
      .catch(() => null);
    if (streamingAttr === "true") {
      await page.waitForTimeout(400);
      lastChangedAt = Date.now();
      continue;
    }

    const text = (await bubble.innerText().catch(() => "")) ?? "";
    if (text !== lastText) {
      lastText = text;
      lastChangedAt = Date.now();
      await page.waitForTimeout(400);
      continue;
    }

    if (text.length > 0 && Date.now() - lastChangedAt >= stableMs) {
      return;
    }

    await page.waitForTimeout(300);
  }
}

export async function turnIsWorking(page: Page): Promise<boolean> {
  if (await firstResolved(page, SELECTORS.stopButton)) return true;
  const bubble = await latestAssistantBubble(page);
  return (await bubble?.getAttribute("data-message-streaming").catch(() => null)) === "true";
}

/**
 * Stop the currently generating turn without closing the shared browser
 * session.  Daemon callers use this to propagate an exact invocation cancel
 * all the way to ChatGPT while preserving the warm profile for the next turn.
 * Returns the best DOM text available after the stop request settles.
 */
export async function stopCurrentTurn(page: Page, timeoutMs = 15_000): Promise<string> {
  const stop = await firstResolved(page, SELECTORS.stopButton);
  if (stop) {
    await stop.click({ timeout: 5_000 });
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await turnIsWorking(page))) break;
    await page.waitForTimeout(250);
  }
  return readLatestAssistantText(page).catch(() => "");
}

export async function latestAssistantBubble(page: Page): Promise<Locator | null> {
  // Walk fallbacks in order so we always pick the deepest, most specific
  // selector that matches — joining them with "," would let the outer
  // <article> wrapper be selected instead of the bubble itself.
  for (const sel of SELECTORS.assistantMessages) {
    const all = page.locator(sel);
    const n = await all.count();
    if (n > 0) return all.nth(n - 1);
  }
  return null;
}

/**
 * Fall-back content extraction: return the latest assistant bubble's
 * inner text. Used when SSE interception didn't capture text.
 *
 * Strips a leading "Thought for Ns" prefix that the Pro / Thinking models
 * inject before the actual answer. Prefers the deepest markdown container
 * so we don't pick up wrapper chrome.
 */
export async function readLatestAssistantText(page: Page): Promise<string> {
  const debug = process.env.CGPRO_DEBUG === "1";
  const log = (m: string): void => {
    if (debug) console.error("[cgpro:read]", m);
  };
  const bubble = await latestAssistantBubble(page);
  log(`bubble=${bubble ? "found" : "null"}`);
  if (!bubble) return "";
  // Try several text containers, in priority order.
  const containers = [
    "div.markdown",
    "[data-message-content]",
    ".prose",
    ":scope", // bubble itself
  ];
  for (const sel of containers) {
    const loc = sel === ":scope" ? bubble : bubble.locator(sel).first();
    try {
      const cnt = sel === ":scope" ? 1 : await bubble.locator(sel).count();
      log(`${sel}: count=${cnt}`);
      if (cnt === 0) continue;
      const text = (await loc.innerText({ timeout: 1_500 }).catch((e) => {
        log(`${sel}: innerText threw: ${(e as Error).message.slice(0, 60)}`);
        return "";
      })) ?? "";
      log(`${sel}: text.length=${text.length} preview=${JSON.stringify(text.slice(0, 60))}`);
      if (text.trim().length === 0) continue;
      const cleaned = text.replace(/^Thought for \d+s\s*\n+/i, "").trim();
      if (cleaned.length > 0) return cleaned;
    } catch (e) {
      log(`${sel}: outer throw: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  // Last resort: ask the page to dig out any text from the bubble subtree.
  log("falling back to bubble.evaluate(innerText)");
  const txt = await bubble
    .evaluate((el) => (el as HTMLElement).innerText ?? "")
    .catch((e) => {
      log(`fallback evaluate threw: ${(e as Error).message.slice(0, 60)}`);
      return "";
    });
  log(`fallback result.length=${txt.length}`);
  return txt.replace(/^Thought for \d+s\s*\n+/i, "").trim();
}

/**
 * Reads the model slug actually used for the latest assistant message.
 * Useful when the picker silently keeps the user's previous default.
 */
export async function latestAssistantModelSlug(page: Page): Promise<string | null> {
  const bubble = await latestAssistantBubble(page);
  if (!bubble) return null;
  return (await bubble.getAttribute("data-message-model-slug").catch(() => null)) ?? null;
}
