import type { Page, Locator } from "patchright";
import { SELECTORS, joinSelectors } from "./selectors.js";
import { firstResolved, requireSelector, requireSelectorPatient, goHome } from "./chatgpt.js";
import { listProjects } from "../api/projects.js";
import { PreSubmitInteractionError, TurnTimeoutError } from "../errors.js";
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
  } else if (opts.gizmoId || opts.gizmoShortUrl) {
    const slug = opts.gizmoShortUrl ?? opts.gizmoId!;
    await goHome(page, { model: opts.model });
    // The Project directory row below is this branch's real readiness gate;
    // the home composer was a surface-dependent proxy for the same thing, and
    // it was required BEFORE the Chat surface was selected -- so a profile
    // that landed or persisted on the "Work" surface (whose composer cgpro
    // never types into) failed a check that exists to enable the switch
    // (P-035 planning-lane incident 2026-09-16: five of eight dispatches).
    // ensureChatTab is idempotent; it no-ops on a single-surface UI.
    await ensureChatTab(page);
    await page.waitForTimeout(5_000);
    const projects = await listProjects(page);
    const project = projects.find((p) =>
      (!opts.gizmoId || p.id === opts.gizmoId) &&
      (p.id === slug || p.shortUrl === slug));
    if (!project || projects.filter((p) => p.name === project.name).length !== 1) {
      throw new Error("Requested ChatGPT Project could not be uniquely identified");
    }
    // The directory row prepares Project metadata before client navigation.
    // A cold deep link can instead hit the unavailable locked-chats endpoint.
    // The click exists to land on the projects directory, so that is what
    // counts as done -- not whether the click promise resolved. See
    // clickFirstActionable for the measurement behind this.
    const onProjectsDirectory = () => {
      try {
        return new URL(page.url()).pathname === "/projects";
      } catch {
        return false;
      }
    };
    if (!onProjectsDirectory()) {
      await requireSelectorPatient(page, SELECTORS.projectsNavigation, "Projects navigation");
      await page.waitForTimeout(5_000);
      await clickFirstActionable(
        page, SELECTORS.projectsNavigation, "Projects navigation", 3, onProjectsDirectory,
      );
    }
    // A saturated host can take longer than one budget to hydrate the
    // directory, and this locator is the only place the vendor clicks a
    // sidebar row. Re-resolve it per attempt instead of failing once, the
    // same shape the send button already uses (P-035 2026-09-16).
    const rowLocator = () => page.locator(joinSelectors(SELECTORS.projectRows)).filter({
      has: page.getByRole("button", { name: `Open project options for ${project.name}`, exact: true }),
    }).first();
    let row = rowLocator();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        row = rowLocator();
        await row.waitFor({ state: "visible", timeout: 20_000 });
        break;
      } catch (error) {
        if (attempt === 2 || page.isClosed()) throw error;
        await page.waitForTimeout(5_000);
        row = rowLocator();
      }
    }
    // The loop above waits for the ROW; the click below targets a text node
    // INSIDE it, and that node had nothing waiting for it -- the 5s budget was
    // the click's own actionability wait, which is why a saturated host turned
    // this line into 21 timeouts in seven days across three different projects.
    // Waiting for what we actually click is the fix; a longer blind timeout
    // would only have moved the boundary. The fixed 5s settle this replaces was
    // a hedge for the same thing, and click() re-resolves per retry anyway, so
    // a row that re-renders mid-click is already covered.
    const label = row.getByText(project.name, { exact: true }).first();
    await label.waitFor({ state: "visible", timeout: 20_000 });
    await label.click({ timeout: 10_000 });
    await page.waitForURL((url) => url.origin === "https://chatgpt.com" &&
      (url.pathname === `/g/${project.id}/project` ||
       (project.shortUrl !== undefined && url.pathname === `/g/${project.shortUrl}/project`)),
    { timeout: 20_000 });
  } else {
    const url = new URL("https://chatgpt.com/");
    if (opts.model) url.searchParams.set("model", opts.model);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  await requireSelectorPatient(page, SELECTORS.composer, "composer", 20_000);

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

/** Verify the current 6 Pro power control before any prompt is submitted. */
export async function ensureProSixMaximum(page: Page): Promise<{ model: string; power: number }> {
  const button = await requireSelector(page, SELECTORS.thinkingPowerButton, "thinking control");
  await page.waitForTimeout(5_000);
  try {
    await button.click({ timeout: 5_000 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Timeout")) throw error;
    // Playwright can time out while React has already opened the Radix menu.
    // Inspect the honest UI postcondition before treating the click as failed.
    const slider = await firstResolved(page, SELECTORS.thinkingPowerSlider);
    let opened = slider !== null;
    if (!opened) {
      const [expanded, state] = await Promise.all([
        button.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null),
        button.getAttribute("data-state", { timeout: 1_000 }).catch(() => null),
      ]);
      opened = expanded === "true" || state === "open";
    }
    if (!opened) {
      throw new PreSubmitInteractionError(
        "model_control_activation_timeout",
        "model_verification",
        "ChatGPT 6 Pro control did not open before submission",
        { cause: error },
      );
    }
  }
  try {
    await page.waitForTimeout(5_000);
    const slider = await requireSelector(page, SELECTORS.thinkingPowerSlider, "thinking power");
    const maximum = await slider.getAttribute("aria-valuemax");
    const minimum = await slider.getAttribute("aria-valuemin");
    const max = maximum === null ? NaN : Number(maximum);
    const min = minimum === null ? NaN : Number(minimum);
    if (!Number.isFinite(max) || !Number.isFinite(min) || max <= min) {
      throw new Error("6 Pro thinking power range could not be verified");
    }
    // P-035 2026-09-16: ChatGPT renders `role="slider"` on its hidden
    // ThumbInput span, which is sometimes not visible. `press()` waits for an
    // actionability check that a hidden element can never pass, so it timed out
    // at 5s and failed the whole turn ("locator.press: Timeout 5000ms
    // exceeded", observed on the personal lane during the 18:30 sweep).
    // Focus only requires the element to be attached, and the keyboard event
    // reaches it either way; the aria-valuenow postcondition below still
    // rejects a press that did not land, so this cannot fail silently.
    await slider.focus({ timeout: 5_000 });
    await page.keyboard.press("End");
    await page.waitForTimeout(5_000);
    const current = await slider.getAttribute("aria-valuenow");
    if (current === null || Number(current) !== max) {
      throw new Error("6 Pro thinking power did not reach its maximum");
    }
    // On the current UI, moving the power slider upgrades High to 6 Pro.
    // Verify the resulting model, rather than rejecting the lower initial level.
    const model = await requireSelector(page, SELECTORS.selectedPowerModel, "selected thinking model");
    if (!/^6\s*Pro$/i.test((await model.textContent() ?? "").trim())) {
      throw new Error("6 Pro is not selected in the thinking menu");
    }
    return { model: "gpt-6-pro", power: max };
  } finally {
    await closeOpenMenus(page);
  }
}

const MENU_CLOSE_ATTEMPTS = Math.max(1, Number(process.env.CGPRO_MENU_CLOSE_ATTEMPTS ?? 4));

/** Count Radix-style overlays that trap focus. Mirrors the `menus` field in the delivery diagnostic. */
const OPEN_MENU_SELECTOR = '[role="menu"],[role="listbox"],[role="dialog"],[aria-modal="true"]';

/**
 * Close any open menu and PROVE it closed.
 *
 * P-035 2026-09-18: the Escape here used to be fire-and-forget, so this function
 * opened a menu and left proving it closed to nobody. Leaving a Radix overlay
 * open behind us is wrong on its own terms -- it holds a focus trap over a
 * composer the very next step types into -- and closing it is cheap.
 *
 * HONESTY NOTE, same day. This was first written claiming it fixed the
 * 2026-09-17T03:36:43Z truncation ("6059 of 7026 characters landed", with
 * `menus: 1` and `active: "span._9wXMRW_ThumbInput[role=slider]"` in the
 * capture). That claim does not survive review, twice over. The capture is
 * taken at VERIFY time, and `ensureProSixMaximum` runs between the insert and
 * the verify, so a focused slider and an open menu there are what a normal turn
 * looks like -- not evidence about what held focus during the insert. And
 * `inputEvents` was 64 on a prompt with 64 non-empty lines, so every insert
 * dispatched on the composer; a trap that stole focus mid-insert would have
 * sent the tail somewhere else and left that count short. The real cause is
 * still open; `inputCommitted` and `landedTail` in the delivery diagnostic exist
 * to settle it.
 *
 * Warn rather than throw: `verifyComposerHoldsPrompt` already refuses to submit
 * a short prompt, so the expensive failure is prevented either way. Treat this
 * as hygiene, not as the repair.
 */
async function closeOpenMenus(page: Page): Promise<void> {
  // This runs from a `finally`, so it must never throw: an exception here would
  // replace whatever real error the caller was already reporting.
  try {
    for (let attempt = 0; attempt < MENU_CLOSE_ATTEMPTS; attempt++) {
      await page.keyboard.press("Escape").catch(() => undefined);
      const open = await page
        .evaluate((selector) => document.querySelectorAll(selector).length, OPEN_MENU_SELECTOR)
        .catch(() => -1);
      if (open === 0) return;
      await page.waitForTimeout(250);
    }
    console.error(
      "[cgpro:model] WARNING: a menu is still open after setting the thinking control. Its focus trap can truncate the prompt mid-insert; the composer verification will refuse to submit if it does.",
    );
  } catch {
    // Best effort only. The composer verification remains the backstop.
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

/**
 * Select ChatGPT's native Deep Research mode in the composer.
 *
 * Deep Research and Web Search/connectors are different execution modes.
 * The orchestrator enforces that boundary before browser work; this function
 * then fails closed unless the native radio is observably selected.
 */
export async function setDeepResearch(page: Page, on = true): Promise<boolean> {
  const verifyMaximum = async (): Promise<void> => {
    await ensureProSixMaximum(page);
  };

  // The selected mode is rendered as a blue composer chip. This is the
  // strongest current-state signal and avoids reopening the picker merely to
  // inspect an ARIA attribute that the current UI no longer supplies.
  const alreadySelected = await firstResolved(page, SELECTORS.deepResearchSelected);
  if (on && alreadySelected) {
    await verifyMaximum();
    return true;
  }

  await page.waitForTimeout(5_000);
  if (!(await openComposerToolsPopover(page))) {
    throw new Error("ChatGPT native Deep Research picker is unavailable");
  }

  // Project composers hydrate their tool menu asynchronously. A snapshot
  // taken immediately after opening the menu can falsely report no mode.
  await page.waitForTimeout(5_000);
  const toggle = await requireSelector(page, SELECTORS.deepResearchToggle, "native Deep Research", 8_000)
    .catch(() => null);
  if (!toggle) {
    const visible = await recordConnectorDiagnostics(page);
    await page.keyboard.press("Escape").catch(() => undefined);
    const detail = visible.length > 0 ? `; visible entries=${JSON.stringify(visible)}` : "";
    throw new Error(`ChatGPT native Deep Research is not exposed in the composer tool picker${detail}`);
  }

  const selected = async (candidate: Locator): Promise<boolean> => {
    const checked = (await candidate.getAttribute("aria-checked").catch(() => null)) === "true";
    const pressed = (await candidate.getAttribute("aria-pressed").catch(() => null)) === "true";
    const state = (await candidate.getAttribute("data-state").catch(() => null)) === "checked";
    return checked || pressed || state;
  };

  if ((await selected(toggle)) === on) {
    await page.keyboard.press("Escape").catch(() => undefined);
    if (on) await verifyMaximum();
    return on;
  }

  try {
    await toggle.click({ timeout: 5_000 });
  } catch {
    // Some current ChatGPT builds expose only a nested label while the React
    // click handler lives on an unroled ancestor. Dispatch through the nearest
    // interactive row (or let the label's click bubble) and rely on the
    // composer-chip postcondition below; the fallback alone is never success.
    const dispatched = await toggle.evaluate((element) => {
      const target = element.closest(
        'button, [role="menuitem"], [role="menuitemradio"], [role="option"], [data-radix-collection-item], div.__menu-item[tabindex="0"]',
      ) as HTMLElement | null;
      const clickable = target ?? element as HTMLElement;
      if (typeof clickable.click !== "function") return false;
      clickable.click();
      return true;
    }).catch(() => false);
    if (!dispatched) {
      await recordConnectorDiagnostics(page);
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new Error("ChatGPT native Deep Research was visible but could not be selected");
    }
  }

  // The picker normally closes after selection. Verify the fresh composer
  // chip instead of trusting a successful click or a stale picker locator.
  await page.waitForTimeout(5_000);
  await page.keyboard.press("Escape").catch(() => undefined);
  const verified = on
    ? await requireSelector(page, SELECTORS.deepResearchSelected, "selected native Deep Research", 8_000).catch(() => null)
    : await firstResolved(page, SELECTORS.deepResearchSelected);
  if ((verified !== null) !== on) {
    throw new Error("ChatGPT native Deep Research selection did not become active");
  }
  if (on) {
    await verifyMaximum();
  }
  return on;
}

async function openComposerToolsPopover(page: Page): Promise<boolean> {
  // Every fallback must be a POPOVER TRIGGER. The old middle entry was a bare
  // `button[aria-label*="Add files" i]`, which also matches an upload-only
  // control — clicking that fires the hidden file input and raises a native
  // macOS picker instead of opening the tools menu. Requiring the menu ARIA
  // contract keeps an upload button from ever being clicked here.
  const plus = await firstResolved(page, [
    'button[data-testid="composer-plus-btn"]',
    'button[aria-label*="Add files" i][aria-haspopup]',
    'button[aria-label*="Add files" i][aria-expanded]',
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
  // Let the browser narrow the DOM before crossing the automation boundary.
  // Scanning every button and span with serial isVisible/innerText calls made
  // one nominally bounded picker poll take minutes on large Project pages.
  const matchingCandidate = async (selector: string): Promise<Locator | null> => {
    const candidates = page.locator(selector).filter({ hasText: name });
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const label = await candidate.innerText().catch(() => "");
      if (exactConnectorLabelIndex([label], name) === 0) return candidate;
    }
    return null;
  };

  const interactive = await matchingCandidate(
    '[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button',
  );
  if (interactive) return interactive;
  // The current @ plugin chooser renders the selectable app label as plain
  // spans inside a keyboard-command row with no ARIA option/menuitem role.
  return matchingCandidate("span");
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

async function recordConnectorDiagnostics(page: Page): Promise<string[]> {
  if (process.env.CGPRO_DEBUG !== "1") return [];
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
  const deepResearchNodes = await page
    .locator("button, [role], [data-testid], span, div")
    .filter({ hasText: /^\s*Deep research\s*$/i })
    .evaluateAll((elements) => elements.slice(0, 20).map((element) => {
      const describe = (node: Element | null): Record<string, string | null> | null => node ? {
        tag: node.tagName.toLocaleLowerCase(),
        role: node.getAttribute("role"),
        testid: node.getAttribute("data-testid"),
        ariaLabel: node.getAttribute("aria-label"),
        tabIndex: node.getAttribute("tabindex"),
        className: typeof node.className === "string" ? node.className.slice(0, 160) : null,
      } : null;
      const ancestors: Array<Record<string, string | null> | null> = [];
      let ancestor = element.parentElement;
      for (let depth = 0; depth < 7 && ancestor; depth++) {
        ancestors.push(describe(ancestor));
        ancestor = ancestor.parentElement;
      }
      return {
        self: describe(element),
        ancestors,
      };
    }))
    .catch(() => [] as Array<Record<string, unknown>>);
  console.error(`[cgpro:connector] deep-research-nodes=${JSON.stringify(deepResearchNodes)}`);
  const screenshotPath = `${process.env.TMPDIR || "/tmp"}/cgpro-connector-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
  console.error(`[cgpro:connector] screenshot=${screenshotPath}`);
  return boundedLabels;
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

/** How many ancestor levels `attachedState` walks before failing closed. */
const ATTACHED_STATE_ANCESTOR_DEPTH = 3;

/** Read the first present attached-state attribute value on a row, without interpreting it. */
async function presentState(row: Locator): Promise<string | null> {
  for (const attribute of ATTACHED_STATE_ATTRIBUTES) {
    const value = await row.getAttribute(attribute).catch(() => null);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Read the attached-state attribute value when the row or its nearest
 * state-bearing ancestor reports attached, else null.
 *
 * The chatgpt.com picker can render the exact label as a plain span while
 * its enclosing interactive row carries the state attribute (live lane-1
 * acceptance evidence), so reading only the label row is not enough. The
 * walk stops at the nearest row that carries one of the accepted state
 * attributes; only the exact values "true" / "checked" accept, anything
 * else stays fail-closed. Patchright resolves `..` as the parent element.
 */
async function attachedState(row: Locator): Promise<string | null> {
  const accept = (value: string | null): string | null =>
    value === "true" || value === "checked" ? value : null;
  const own = await presentState(row);
  if (own !== null) return accept(own);
  let ancestor: Locator = row;
  for (let depth = 0; depth < ATTACHED_STATE_ANCESTOR_DEPTH; depth++) {
    ancestor = ancestor.locator("..");
    const raw = await presentState(ancestor);
    if (raw !== null) return accept(raw);
  }
  return null;
}

/**
 * Whether an exact-label element is mounted in the composer itself.
 *
 * Current ChatGPT builds replace the picker row with a visible connector
 * pill beside the prompt textarea after a successful selection. That pill
 * carries no checked/pressed attribute, so picker-row state alone produces a
 * false negative. Requiring the label to share the composer form with the
 * prompt textarea keeps this proof distinct from same-label sidebar, picker,
 * or dialog text.
 */
async function isComposerMountedTool(row: Locator): Promise<boolean> {
  return row.evaluate((element) => {
    const form = element.closest("form");
    return Boolean(form?.querySelector("#prompt-textarea, [data-testid=\"prompt-textarea\"]"));
  }).catch(() => false);
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
  if (row && (await isComposerMountedTool(row))) return;
  if (!row) {
    // The picker is gone - reopen the composer "+" tools popover, where an
    // attached tool row reports its checked state.
    const composer = await requireSelector(page, SELECTORS.composer, "composer");
    await composer.click();
    if (!(await openComposerToolsPopover(page))) {
      await recordConnectorDiagnostics(page);
      throw new Error(notAttached("composer tools popover did not open"));
    }
    // Direct row first: a non-MCP connector can be directly visible and
    // attached in the reopened popover alongside a Developer-mode entry.
    // Accept it before entering Developer mode, which can clear the row.
    row = await visibleComposerTool(page, connectorName);
    if (row && ((await isComposerMountedTool(row)) || (await attachedState(row)))) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return;
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
  if ((await isComposerMountedTool(row)) || (await attachedState(row))) {
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
async function clickConnector(page: Page, row: Locator, name: string): Promise<void> {
  try {
    await row.click({ timeout: 5_000 });
  } catch (error) {
    // ChatGPT can replace the @ results between observation and click. Resolve
    // one fresh exact row; never force-click through a popover or toggle off an
    // attachment that mounted while the first click was timing out.
    if (!(error instanceof Error) || !error.message.includes("Timeout")) throw error;
    const refreshed = await waitForComposerTool(page, name);
    if (!refreshed) {
      throw new PreSubmitInteractionError(
        "connector_control_activation_timeout",
        "connector_selection",
        `ChatGPT connector "${name}" did not activate before submission`,
        { cause: error },
      );
    }
    if (await isComposerMountedTool(refreshed) || await attachedState(refreshed)) return;
    try {
      await refreshed.click({ timeout: 5_000 });
    } catch (retryError) {
      if (!(retryError instanceof Error) || !retryError.message.includes("Timeout")) throw retryError;
      const finalRow = await waitForComposerTool(page, name);
      if (finalRow && (await isComposerMountedTool(finalRow) || await attachedState(finalRow))) return;
      throw new PreSubmitInteractionError(
        "connector_control_activation_timeout",
        "connector_selection",
        `ChatGPT connector "${name}" did not activate before submission`,
        { cause: retryError },
      );
    }
  }
}

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
    await clickConnector(page, connector, connectorName);
    await page.waitForTimeout(300);
    await assertConnectorAttached(page, connectorName);
    // Dismiss the @-picker, exactly as the already-attached branch above does.
    // Leaving it open was the 2026-09-17 prompt-loss bug: CDP insertText goes to
    // whatever holds focus, so the whole prompt was typed into the picker's
    // search field and the composer kept only the mention. Measured twice on
    // intelli, same numbers both times -- 33 of 2982 characters, and
    // `p035-low-risk-workstation-intelli` is exactly 33 characters long.
    //
    // It reads as intermittent because it depends on which branch runs: a page
    // whose connector is already attached escapes and delivers, a freshly
    // started one clicks and did not. That is the cold-page failure rate (3 of
    // 10 cold first turns against 12 of 999 warm), and it is why a restart --
    // when every lane is cold -- looked like a connector outage.
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(150);
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
    await clickConnector(page, connector, connectorName);
  } catch (error) {
    await recordConnectorDiagnostics(page);
    await page.keyboard.press("Escape").catch(() => undefined);
    if (error instanceof PreSubmitInteractionError) throw error;
    const reason = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "unknown click error";
    throw new Error(`ChatGPT connector "${connectorName}" was visible but could not be selected: ${reason}`, { cause: error });
  }
  await page.waitForTimeout(300);
  await assertConnectorAttached(page, connectorName);
  // The fallback path's missing dismissal. Every other exit from setConnector
  // escapes -- the not-exposed throw, the already-attached return, the failed
  // click -- but the two post-click success exits did not, and this is the one
  // intelli takes. Its connector is a personal Pro custom MCP, so the ordinary
  // `@` search never surfaces it and selection always runs the Developer mode
  // route: 25s of picker work against 1-2s on the fast path, every single turn.
  // The menu stayed open, CDP insertText wrote the prompt into it, and the
  // composer kept only the mention -- 33 of 2982 characters, three times, with
  // identical counts. Deterministic per account, which is why intelli failed
  // every canary while personal, strengths and ms1980 passed.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(150);
}

export async function clearComposer(page: Page): Promise<void> {
  const composer = await requireSelector(page, SELECTORS.composer, "composer");
  await composer.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(5_000);
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
  verifySubmission?: () => Promise<void>,
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
    await clearComposer(page);
  }
  // Put the caret in the composer's text flow before inserting anything. This
  // replaces a "Meta+End" that could not do the job: see focusComposerEnd.
  // Fail OPEN here and let the delivery check decide -- it is the thing that
  // actually knows whether the prompt arrived.
  if (!(await focusComposerEnd(page, composer))) {
    console.error("[cgpro:composer] could not seat the caret in the composer text flow; inserting anyway");
  }
  // Composer is a contenteditable div on modern chatgpt.com. Insert the whole
  // prompt in one CDP `Input.insertText` instead of typing it character by
  // character: at 4ms/char a planning prompt spent MINUTES streaming synthetic
  // keystrokes into a live React composer (invocation a9f3717e on 2026-08-27
  // sat 4m46s between connector_selected and prompt_submitted). Every one of
  // those keystrokes is a chance for an inline `@`/`/` menu to swallow the
  // input and activate something — including the composer's file upload, which
  // is how a native Finder dialog ended up on Maik's screen mid-run.
  // insertText fires the same beforeinput/input events React listens for, but
  // atomically and without triggering keyboard-driven menus.
  // Escape hatch: CGPRO_TYPE_KEYSTROKES=1 restores the old per-character path.
  if (process.env.CGPRO_TYPE_KEYSTROKES === "1") {
    const lines = prompt.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(lines[i], { delay: 4 });
    }
  } else {
    await insertComposerText(page, prompt);
  }
  const priorAssistantCount = await assistantCount();
  if (cancelled?.()) return priorAssistantCount;

  // Typing may change inline modes. Verify the composed request, not just
  // the empty composer, and let failures stop both click and Enter submission.
  await verifySubmission?.();
  if (cancelled?.()) return priorAssistantCount;

  // Last thing before the send click: does the composer hold the prompt? This
  // sits AFTER verifySubmission deliberately -- that step opens and closes the
  // thinking-power menu, so anything it does to the draft has already happened.
  await verifyComposerHoldsPrompt(page, composer, prompt, preserveExisting);
  if (cancelled?.()) return priorAssistantCount;

  const clicked = await clickSendButtonWithRetries(page, cancelled);
  if (!clicked && !cancelled?.()) {
    // The final model check moves focus into a menu. Re-resolve the composer
    // before the keyboard fallback instead of pressing Enter on that menu.
    const currentComposer = await requireSelector(page, SELECTORS.composer, "composer");
    await currentComposer.click();
    if (!cancelled?.()) await page.keyboard.press("Enter");
  }
  return priorAssistantCount;
}

/**
 * Put `text` into the focused composer without emitting key events.
 *
 * Paste first, type only if the paste delivered nothing. Both paths avoid key
 * events, so chatgpt.com's inline `@` mention and `/` command menus cannot open
 * and no menu entry (notably "Add photos & files") can be activated by the
 * prompt's own characters. The typed path additionally sends newlines through
 * Shift+Enter, because the composer treats a bare "\n" as submit-adjacent.
 *
 * Typing is the fallback rather than the default because it loses text: see
 * pasteComposerText for the measurement.
 *
 * Falls back to per-character typing when the inserted text does not land
 * COMPLETE, so a build that rejects or drops inserted text degrades to the old
 * behaviour rather than submitting a partial prompt to a paid run. A second
 * incomplete attempt throws: a truncated prompt burns a Pro turn, returns an
 * answer to a question nobody asked, and takes the account out of routing, so
 * refusing to submit is strictly cheaper than submitting.
 *
 * Escape hatch: CGPRO_SKIP_COMPOSER_VERIFY=1 restores the unverified path.
 */
async function insertComposerText(
  page: Page,
  text: string,
  force?: DeliveryPath,
): Promise<DeliveryPath> {
  if (force !== "typed" && await pasteComposerText(page, text)) return "paste";
  await insertLines(page, text.split("\n"));
  return "typed";
}

/** Which of the two delivery paths actually put the prompt in the composer. */
export type DeliveryPath = "paste" | "typed";

/**
 * Deliver the whole prompt through the composer's PASTE path, in one operation.
 *
 * P-035 2026-09-18, measured cause. Typing the prompt line by line runs it
 * through ProseMirror's markdown INPUT RULES, and the inline-code rule destroys
 * any line whose closing backtick is the last character of the insertion: 18 of
 * 18 such lines vanished in the reproduction, while 28 of 29 lines carrying
 * inline code elsewhere survived. Clipboard input is parsed by a different code
 * path that never consults input rules, so a paste cannot trigger the rule that
 * eats these lines -- and it replaces 109 CDP round-trips with one.
 *
 * The event is constructed and dispatched INSIDE the page. That keeps this on
 * in-tab JavaScript and away from the real clipboard, so it neither injects OS
 * input nor disturbs whatever Maik has copied (C-037).
 *
 * Returns whether the composer actually grew, which is a measurement rather
 * than an inference: `dispatchEvent` reports only whether something called
 * preventDefault. A false return falls back to the typed path, and either way
 * `verifyComposerHoldsPrompt` is still the thing that decides whether this turn
 * may be submitted.
 */
/**
 * The composer's rendered length, without shipping the composer back.
 *
 * `innerText()` returns the whole thing, and the per-line guard below calls
 * this twice per rule-fatal line against a composer that grows to tens of
 * thousands of characters -- measured in review at roughly 3.6 MB over CDP for
 * one large delivery. Nothing here wants the text, only whether it grew.
 */
async function composerTextLength(composer: Locator): Promise<number> {
  return composer
    .evaluate((element) => (element as HTMLElement).innerText.length)
    .catch(() => 0);
}

async function pasteComposerText(page: Page, text: string): Promise<boolean> {
  if (process.env.CGPRO_SKIP_COMPOSER_PASTE === "1") return false;
  const composer = page.locator(joinSelectors(SELECTORS.composer)).first();
  const read = async (): Promise<number> => composerTextLength(composer);
  const before = await read();
  const dispatched = await composer
    .evaluate((element, body) => {
      const data = new DataTransfer();
      data.setData("text/plain", body);
      return element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text)
    .then(() => true)
    .catch((error) => {
      console.error(
        `[cgpro:composer] paste delivery could not be dispatched (${error instanceof Error ? error.message : String(error)}); typing instead`,
      );
      return false;
    });
  if (!dispatched) return false;
  // Poll rather than sleep once. A single 250 ms wait silently failed every
  // prompt above roughly 6,000 characters (measured 2026-09-18: 2.0 KB and
  // 5.7 KB pasted, 12.0 KB, 19.7 KB and 27.9 KB did not), because a large
  // paste has not rendered yet when the one read happens. The fallback that
  // then ran is the typed path, which is exactly the path that loses lines.
  const deadline = Date.now() + COMPOSER_PASTE_SETTLE_MAX_MS;
  for (;;) {
    await page.waitForTimeout(COMPOSER_PASTE_POLL_MS);
    if (await read() > before) return true;
    if (Date.now() >= deadline) return false;
  }
}

/**
 * Did a paste that we gave up on land anyway?
 *
 * A `false` from `pasteComposerText` means "it had not landed by the deadline",
 * not "it will never land". Typing the line on top of a late one duplicates it,
 * and `composerHoldsPrompt` only enforces a length FLOOR -- a composer that is
 * too LONG passes -- so the duplicate would be submitted and a Pro turn spent
 * on corrupted input, which is the exact failure this guard exists to prevent.
 * Found in review 2026-09-18; never observed live, and cheap to make impossible.
 */
async function pasteLandedLate(page: Page, before: number): Promise<boolean> {
  const composer = page.locator(joinSelectors(SELECTORS.composer)).first();
  return (await composerTextLength(composer)) > before;
}

/** React commits the pasted transaction asynchronously, and a big one takes its time. */
const COMPOSER_PASTE_POLL_MS = Math.max(1, Number(process.env.CGPRO_COMPOSER_PASTE_POLL_MS ?? 250));
// Bounded deliberately low. Measured 2026-09-18: a whole-prompt paste above
// roughly 6,000 characters does not land at all, however long you wait, so a
// generous ceiling buys nothing and costs that much dead time on every large
// prompt. A paste that WILL land does so inside one poll.
const COMPOSER_PASTE_SETTLE_MAX_MS = Math.max(
  COMPOSER_PASTE_POLL_MS,
  Number(process.env.CGPRO_COMPOSER_PASTE_SETTLE_MAX_MS ?? 1_500),
);

export interface PromptDeliveryProbe {
  requestedChars: number;
  /** -1 when the composer could not be read at all. */
  arrivedChars: number;
  complete: boolean;
  deliveredBy?: DeliveryPath;
  divergence?: string;
  /**
   * The composer's own text, returned ONLY when less arrived than was asked
   * for. `describeDivergence` is a greedy anchor scan: its drop LENGTHS are
   * reliable and its excerpts are windows rather than quotations, which is
   * enough to notice a loss and not enough to diagnose one. The caller diffs
   * this against the prompt it already holds. It is a probe-only field; a real
   * turn never carries it.
   */
  landed?: string;
}

/**
 * Deliver a prompt, measure what arrived, then clear it WITHOUT submitting.
 *
 * P-035 2026-09-18. Proving a delivery repair used to cost a Pro turn: the
 * `--traffic-class synthetic` flag is a telemetry label and stops nothing, so a
 * replay was free only while delivery was still broken. That is backwards --
 * the moment a fix works, testing it starts costing money. This runs the exact
 * sequence `sendPrompt` runs, up to but never including the send click.
 *
 * The clear afterwards is not tidiness. ChatGPT persists composer drafts, so
 * residue left here would be inherited by the next real turn on this lane;
 * asserting the composer is empty is what makes the probe safe to point at
 * production.
 */
export async function probePromptDelivery(
  page: Page,
  prompt: string,
  force?: DeliveryPath,
): Promise<PromptDeliveryProbe> {
  const composer = await requireSelector(page, SELECTORS.composer, "composer");
  await composer.click();
  await page.waitForTimeout(120);
  await clearComposer(page);
  await focusComposerEnd(page, composer);
  const deliveredBy = await insertComposerText(page, prompt, force);

  const want = normaliseComposerText(prompt);
  const landed = await readComposer(page, composer);
  const probe: PromptDeliveryProbe = {
    requestedChars: want.length,
    arrivedChars: landed?.length ?? -1,
    complete: landed !== null && composerHoldsPrompt(landed, want),
    deliveredBy,
  };
  // Also on a shortfall that PASSES the floor: the 2026-09-18 replay delivered
  // 30 of 30 prompts whole by the completeness rule, while the largest of them
  // arrived 193 characters short on all three lanes. A probe that hides the one
  // number it exists to expose is worth nothing.
  if (!probe.complete || (landed !== null && landed.length < want.length)) {
    probe.divergence = landed === null
      ? "composer unreadable"
      : describeDivergence(landed, want);
    if (landed !== null) probe.landed = landed;
  }

  await clearComposer(page);
  const residue = await readComposer(page, composer);
  if (residue === null || residue.trim().length > 0) {
    throw new Error(
      "prompt delivery probe could not clear the composer; the next turn on this lane would "
      + `inherit it (residue=${JSON.stringify((residue ?? "<unreadable>").slice(0, 80))})`,
    );
  }
  return probe;
}

/**
 * Focus the composer and collapse the caret to the end of its content.
 *
 * This is the 2026-09-17 prompt-loss fix, and the capture that earned it reads:
 *
 *   active: "a.focus-visible:focus-ring.inline-flex", activeEditable: false,
 *   activeIsComposer: false, activeInComposer: true, editables: 1
 *
 * The connector attaches as an inline selection pill -- an anchor carrying
 * `contenteditable="false"` inside the ProseMirror document. After the click
 * that attaches it, focus sits ON that anchor: inside the composer, but on a
 * node that cannot be typed into. CDP Input.insertText writes to the focused
 * editable, so every insert was silently dropped and the composer kept only the
 * mention -- 33 of 2982 characters on intelli, five times, identical counts.
 *
 * It looked account-specific because it is only reliably reached through the
 * slow Developer mode route, which is the only way intelli's personal Pro custom
 * MCP connector can be selected.
 *
 * Two earlier repairs failed against exactly this, and both failures make sense
 * here. `composer.click()` targets the element's CENTRE, and when the composer
 * holds nothing but the pill, the centre IS the pill -- so re-clicking put focus
 * straight back on the anchor. `Meta+End` on a non-editable anchor moves no
 * ProseMirror selection at all. Focusing the contenteditable host directly and
 * collapsing a Range past the pill avoids both traps.
 */
async function focusComposerEnd(page: Page, composer: Locator): Promise<boolean> {
  for (let attempt = 0; attempt < COMPOSER_CARET_ATTEMPTS; attempt++) {
    const seated = await composer
      .evaluate((element) => {
        const counter = window as unknown as {
          __cgproInputCount?: number;
          __cgproCommitCount?: number;
        };
        const marked = element as unknown as { __cgproCounted?: boolean };
        if (marked.__cgproCounted !== true) {
          marked.__cgproCounted = true;
          // `beforeinput` is cancellable and fires BEFORE the mutation, so it
          // counts attempts. `input` fires only after one committed. Counting
          // just the first is what made 2026-09-17T03:36:43Z unreadable: 64
          // events on a 64-line prompt was taken as proof every line landed,
          // when a prevented insert increments it exactly the same way.
          element.addEventListener("beforeinput", () => {
            counter.__cgproInputCount = (counter.__cgproInputCount ?? 0) + 1;
          });
          element.addEventListener("input", () => {
            counter.__cgproCommitCount = (counter.__cgproCommitCount ?? 0) + 1;
          });
        }
        counter.__cgproInputCount = 0;
        counter.__cgproCommitCount = 0;

        (element as HTMLElement).focus();
        const range = document.createRange();
        // The last BLOCK CHILD, not the host. Collapsing to the host's content
        // end lands between block children, and ProseMirror can map that
        // position straight back onto the pill's NodeSelection -- which is the
        // state this function exists to escape.
        range.selectNodeContents(element.lastElementChild ?? element);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        // Postcondition, not hope. Without it this is a blind write followed by
        // a timeout, which is exactly how the previous three repairs passed
        // their own checks and lost the prompt anyway.
        const anchor = selection?.anchorNode ?? null;
        const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
        return document.activeElement === element
          && anchorElement !== null
          && element.contains(anchorElement)
          && anchorElement.closest('[contenteditable="false"]') === null;
      })
      .catch(() => false);
    if (seated) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

const COMPOSER_CARET_ATTEMPTS = Math.max(1, Number(process.env.CGPRO_COMPOSER_CARET_ATTEMPTS ?? 3));

/**
 * Refuse to send a prompt the composer does not actually hold.
 *
 * Called immediately before the send click, NOT right after insertion. The
 * model-thinking check runs in between and opens the thinking-power menu with
 * three five-second waits; if that interaction is what loses the draft, a check
 * that ran before it would pass and the turn would still go out empty.
 *
 * On a connector turn `preserveExisting` is true (orchestrator.ts: every turn
 * with a connector), and the connector's inline mention lives INSIDE the
 * composer. `clearComposer` would therefore strip the connector, and re-typing
 * would submit a connector-required prompt with no connector attached -- which
 * produces the genuine `connector_required_not_used` this whole change exists
 * to prevent. A connector turn therefore retries by APPENDING, never clearing.
 *
 * That append is safe only when the prompt is wholly absent, which is the shape
 * this actually fails in. Measured on intelli 2026-09-17T23:33Z: 33 of 2982
 * characters landed, and `p035-low-risk-workstation-intelli` is exactly 33 --
 * the composer held the mention and nothing else. The mention surviving while
 * the prompt did not proves the insert never landed rather than being cleared
 * afterwards; a later clear would have taken the mention with it. So the retry
 * re-establishes focus and inserts again. A PARTIAL prompt gets no retry: an
 * append would duplicate the head, so that case still fails honestly.
 */
async function verifyComposerHoldsPrompt(
  page: Page, composer: Locator, text: string, preserveExisting: boolean,
): Promise<void> {
  if (text.trim().length === 0) return;
  if (process.env.CGPRO_SKIP_COMPOSER_VERIFY === "1") return;

  const want = normaliseComposerText(text);
  // Fail CLOSED on an unreadable composer. The old code returned early there,
  // reasoning that an unreadable read must not cause a duplicate write -- true,
  // but not writing and not SUBMITTING are different things, and submitting a
  // prompt we could not verify is the expensive half.
  let landed = await readComposer(page, composer);
  if (landed !== null && composerHoldsPrompt(landed, want)) {
    // Passing this check is not the same as losing nothing: it allows a 10%
    // shortfall by design. After the 2026-09-18 paste repair the expected
    // shortfall is zero, so say so when it is not, rather than letting a
    // smaller version of the same fault pass silently under the threshold.
    if (landed.length < want.length) {
      console.error(
        `[cgpro:composer] prompt delivered with a shortfall: ${landed.length} of ${want.length} characters `
        + `(within the ${COMPOSER_MIN_LANDED_RATIO} floor, so this turn proceeds) ${describeDivergence(landed, want)}`,
      );
    }
    return;
  }

  const retry = !preserveExisting
    ? "clear"
    : landed !== null && promptIsWhollyAbsent(landed, want)
      ? "append"
      : "none";
  if (retry !== "none") {
    console.error(
      `[cgpro:composer] composer ${landed === null ? "could not be read" : `holds ${landed.length} of ${want.length} expected characters`}; re-inserting once (${retry})`,
    );
    if (retry === "clear") {
      await clearComposer(page);
    }
    // Re-seat the caret in the composer's text flow. An earlier version clicked
    // the composer here, which is what a centre-click does to a composer holding
    // only a pill: it re-focused the pill and the retry inserted nothing either.
    await focusComposerEnd(page, composer);
    await insertLines(page, text.split("\n"));
    landed = await readComposer(page, composer);
    if (landed !== null && composerHoldsPrompt(landed, want)) return;
  }
  // Diagnostics, because "33 of 2982 landed" twice with identical numbers does
  // not say WHICH of two very different faults this is: the prompt never
  // reached the composer, or it reached a composer we are not the one reading.
  // `matches` separates them -- more than one match means this locator is
  // ambiguous and the refusal may be reading the wrong node. `head` shows
  // whether what landed is the connector mention or the start of the prompt.
  const selector = joinSelectors(SELECTORS.composer);
  const matches = await page.locator(selector).count().catch(() => -1);
  const diagnostics = await composerDiagnostics(page, selector);
  throw new PreSubmitInteractionError(
    "prompt_delivery_incomplete",
    "prompt_delivery",
    landed === null
      ? `composer delivery unverifiable: the composer could not be read ${diagnostics}`
      : `composer delivery incomplete: ${landed.length} of ${want.length} characters landed `
        + `(composer matches=${matches}, held=${JSON.stringify(landed.slice(0, 60))}) `
        + `${describeDivergence(landed, want)} ${diagnostics}`,
  );
}

/**
 * Where the composer's text first stops matching the prompt, and what sits there.
 *
 * P-035 2026-09-18. Every explanation of this fault so far has been about the
 * TAIL, and the tail is not where the loss is. The 22:39Z and 22:48Z refusals
 * held both the head ("p035-...SYSTEM: You are supporting") and the invocation
 * contract at the end, so the missing 1426 characters came out of the middle.
 * A length and an endpoint cannot locate a middle drop; only the first
 * mismatching offset can.
 *
 * `resumes_at` is the part that turns this into a diagnosis rather than a
 * coordinate. If the text after the divergence reappears further along the
 * prompt, the loss is one contiguous block, `dropped` is exactly its length,
 * and the `want` window shows what sits immediately before whatever swallowed
 * it. If it never reappears, the composer holds something we never sent, which
 * is a different fault entirely.
 *
 * Both sides are already whitespace-normalised, so a difference here is real
 * content rather than a rendering artefact.
 */
/**
 * P-035 2026-09-18. Five drops were enough to see that every one is a whole
 * line, and not enough to say which lines: the five reported were simply the
 * first five, and fitting a predicate to the 1383-character total instead of
 * reading the list is how the tail-truncation theory survived two days. Report
 * the whole list and let the pattern be read off it.
 */
const DIVERGENCE_MAX_DROPS = Math.max(1, Number(process.env.CGPRO_DIVERGENCE_MAX_DROPS ?? 40));

export function describeDivergence(landedRaw: string, want: string): string {
  // On a connector turn the composer holds the connector mention BEFORE the
  // prompt, and `want` never contains it, so a comparison anchored at index 0
  // mismatches on the first character and reports nothing. The first run of
  // this function did exactly that: `divergence=0/7978`, want "SYSTEM: You are
  // supporting Mai", landed "p035-low-risk-workstation-inte". Align on where
  // the prompt actually starts inside the composer before comparing anything.
  const anchor = want.slice(0, 40);
  const start = anchor.length > 0 ? landedRaw.indexOf(anchor) : 0;
  const prefix = start > 0 ? `mention_prefix=${start} ` : "";
  const landed = start > 0 ? landedRaw.slice(start) : landedRaw;

  // Report every drop, not just the first. The first live measurement on
  // 2026-09-18 returned dropped=77, which is EXACTLY one source line of the
  // planning preamble plus its joining newline -- against a total shortfall of
  // 1451 characters. So this fault drops whole lines, repeatedly, and a single
  // sample cannot show what the dropped lines have in common. Five samples from
  // one free reproduction can.
  const drops: string[] = [];
  let l = 0;
  let w = 0;
  while (drops.length < DIVERGENCE_MAX_DROPS && l < landed.length && w < want.length) {
    if (landed[l] === want[w]) {
      l += 1;
      w += 1;
      continue;
    }
    // 40 characters is long enough that a coincidental re-match is implausible
    // and short enough to survive a second, later drop.
    const probe = landed.slice(l, l + 40);
    const resume = probe.length > 0 ? want.indexOf(probe, w) : -1;
    if (resume < 0) {
      drops.push(`at=${w} resume=not-found landed=${JSON.stringify(probe)}`);
      break;
    }
    drops.push(`at=${w} dropped=${resume - w} text=${JSON.stringify(want.slice(w, Math.min(resume, w + 110)))}`);
    w = resume;
  }
  if (drops.length === 0) {
    return `${prefix}divergence=none landed_is_prefix short_by=${want.length - landed.length}`;
  }
  return `${prefix}drops=${drops.length} short_by=${want.length - landed.length} `
    + drops.map((drop, i) => `[${i} ${drop}]`).join(" ");
}

/**
 * Page state at the moment delivery is refused.
 *
 * CDP insertText writes to whatever the page treats as focused, so a refusal is
 * only actionable if it says what that was. Three fixes were shipped against
 * this fault on inference alone and all three missed; this reports the facts
 * each of them assumed instead. `activeInComposer` separates a focus problem
 * from everything else, `editables` and `composer` separate "wrote to the wrong
 * node" from "wrote nowhere", and `menus` shows whether a picker is still open.
 */
async function composerDiagnostics(page: Page, selector: string): Promise<string> {
  return page
    .evaluate(({ sel, sent }) => {
      const describe = (el: Element | null): string => {
        if (el === null) return "none";
        const id = el.id ? `#${el.id}` : "";
        const role = el.getAttribute("role");
        const cls = typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
        return `${el.tagName.toLowerCase()}${id}${cls}${role ? `[role=${role}]` : ""}`;
      };
      const active = document.activeElement;
      const composer = document.querySelector(sel);
      return JSON.stringify({
        active: describe(active),
        activeEditable: active instanceof HTMLElement ? active.isContentEditable : null,
        activeIsComposer: composer !== null && active === composer,
        activeInComposer: composer !== null && active !== null ? composer.contains(active) : null,
        composer: describe(composer),
        composerEditable: composer instanceof HTMLElement ? composer.isContentEditable : null,
        editables: document.querySelectorAll('[contenteditable="true"]').length,
        menus: document.querySelectorAll(
          '[role="menu"],[role="listbox"],[role="dialog"],[aria-modal="true"]',
        ).length,
        // document.activeElement is a proxy for what Blink commits against; the
        // editing selection is the real target. These separate "the caret never
        // got there" from "the caret got there and something moved it back".
        sel: (() => {
          const selection = window.getSelection();
          const anchor = selection?.anchorNode ?? null;
          const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
          return {
            anchor: describe(anchorElement),
            collapsed: selection?.isCollapsed ?? null,
            inComposer: composer !== null && anchor !== null ? composer.contains(anchor) : null,
            inNonEditable: anchorElement?.closest('[contenteditable="false"]') != null,
          };
        })(),
        // Both counted from just before the first insert. `inputEvents` counts
        // ATTEMPTS (`beforeinput`, cancellable, fires before the mutation);
        // `inputCommitted` counts the mutations that actually happened. Equal
        // means every insert landed and the loss is downstream; a shortfall
        // means the editor refused the difference. Reading `inputEvents` alone
        // as "the insert committed" is how the 03:36:43Z capture was
        // misdiagnosed as a focus trap.
        inputEvents: (window as unknown as { __cgproInputCount?: number }).__cgproInputCount ?? null,
        inputCommitted:
          (window as unknown as { __cgproCommitCount?: number }).__cgproCommitCount ?? null,
        // P-035 2026-09-18. `readComposer` verifies against `innerText`, which
        // is the RENDERED text; `textContent` is everything in the node. On the
        // 22:39:12Z refusal every insert committed (inputEvents 109 ===
        // inputCommitted 109), the head and the trailing invocation contract
        // were both present, and 1426 characters were missing from the middle --
        // a shape that fits a read that cannot see all of the node far better
        // than it fits a write that lost content from the centre. If these two
        // lengths disagree, the prompt is intact and this guard has been
        // refusing good turns; if they agree, the loss is real. Nothing else
        // separates those two, and they need opposite fixes.
        innerTextChars: composer instanceof HTMLElement
          ? composer.innerText.replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim().length
          : null,
        textContentChars: composer === null
          ? null
          : (composer.textContent ?? "").replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim().length,
        // The composer's last 80 characters. A truncation names its own boundary
        // here: the tail is the connector invocation contract, so seeing where
        // the text actually stops separates a lost tail from a lost middle.
        landedTail: composer === null
          ? null
          : ((composer as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(-80),
        // The REQUESTED side of the insert, from the Node process. Without it,
        // "109 requested, 109 arrived" and "128 requested, 109 arrived" look
        // identical in the log and have opposite causes: the first means the
        // editor dropped content it accepted, the second means insertLines
        // never asked for those lines at all.
        sentLines: sent.lines,
        sentInserts: sent.requested,
        sentChars: sent.chars,
        // How many line nodes the composer ended up holding. ProseMirror gives
        // each Shift+Enter line its own block node, so this is the DOM's own
        // count of lines against `sentInserts`.
        lineNodes: composer === null ? null : composer.childElementCount,
        html: composer === null ? null : composer.outerHTML.slice(0, 1200),
      });
    }, { sel: selector, sent: lastInsert })
    .catch((error) => `capture failed: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * The composer renders each line as its own node and trims, so whitespace
 * differences are expected and meaningless.
 */
function normaliseComposerText(text: string): string {
  // ProseMirror emits zero-width characters around inline nodes and hard breaks,
  // and JS \s matches neither U+200B/200C/200D nor U+2060. Strip them first or
  // they inflate the composer's length against a source text that has none.
  return text.replace(/[​‌‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Does the composer hold the prompt we meant to send?
 *
 * NOT a character-for-character comparison, and the first cut of this check
 * learned that the hard way in production (P-035 2026-09-17): chatgpt.com's
 * composer RENDERS markdown, so `innerText` never contains the backticks, the
 * `# ` of a heading, or the `1. ` of an ordered list. A 4,060-character
 * planning prompt came back as 4,033 -- 16 backticks + one heading mark + three
 * list markers, exactly 27 -- and an endsWith check failed a healthy turn.
 * Reimplementing the renderer to compare exactly is a losing game.
 *
 * So check two things that markdown rendering cannot touch:
 *
 *  - the last rendering-invariant token of the prompt is present. Alphanumeric
 *    runs survive any formatting, and the final one in a planning prompt is the
 *    connector's invocation UUID -- the exact thing whose loss caused the
 *    incident. This is what catches a dropped tail.
 *  - the composer is not grossly shorter than intended. Markdown syntax is well
 *    under 1% of a real prompt, so a 10% floor is far outside that noise while
 *    still catching a prompt that arrived in pieces.
 *
 * preserveExisting appends to existing composer content, hence `>=`, not `===`.
 */
export function composerHoldsPrompt(landed: string, want: string): boolean {
  if (landed.length < Math.floor(want.length * COMPOSER_MIN_LANDED_RATIO)) return false;
  const tail = lastInvariantToken(want);
  return tail === null || landed.includes(tail);
}

/** Longest trailing run of characters no markdown renderer rewrites. */
function lastInvariantToken(text: string): string | null {
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9-]{7,}/g);
  return tokens === null || tokens.length === 0 ? null : tokens[tokens.length - 1];
}

const COMPOSER_MIN_LANDED_RATIO = Number(process.env.CGPRO_COMPOSER_MIN_LANDED_RATIO ?? 0.9);

/**
 * Did the prompt fail to arrive at all, as opposed to arriving partially?
 *
 * Only an outright absence is repairable by appending; appending on top of a
 * partial prompt would duplicate its head. The observed failure leaves the
 * connector mention alone in the composer -- 33 characters against 2982 -- so
 * any ceiling comfortably above the longest connector name and far below a real
 * prompt separates the two. The floor matters for short prompts, where a ratio
 * alone would drop under the mention's own length.
 */
function promptIsWhollyAbsent(landed: string, want: string): boolean {
  return landed.length <= Math.max(80, Math.floor(want.length * 0.05));
}

/**
 * Read the composer, tolerating a transient failure. Only a composer that stays
 * unreadable across attempts is treated as unverifiable, so one flaky read under
 * load does not fail a turn that was actually fine.
 */
async function readComposer(page: Page, composer: Locator): Promise<string | null> {
  for (let attempt = 0; attempt < COMPOSER_READ_ATTEMPTS; attempt++) {
    const raw = await composer.innerText().catch(() => null);
    if (raw !== null) return normaliseComposerText(raw);
    await page.waitForTimeout(250);
  }
  return null;
}

const COMPOSER_READ_ATTEMPTS = Math.max(1, Number(process.env.CGPRO_COMPOSER_READ_ATTEMPTS ?? 3));

/**
 * What the last insert run actually asked the page to do.
 *
 * P-035 2026-09-18: the composer diagnostics count events the composer
 * RECEIVED (`inputEvents`) and mutations it COMMITTED (`inputCommitted`), both
 * 109 on the refusal that lost 1451 characters in whole-line chunks. Neither
 * says how many insertions were requested, so "109 sent, 109 arrived" and
 * "128 sent, 109 arrived" are indistinguishable -- and they have opposite
 * causes. This records the requested side.
 *
 * A module-level counter is safe because a lane serialises turns behind a
 * single page lease; there is no second insert run to interleave with.
 */
let lastInsert = { lines: 0, requested: 0, chars: 0, pasted: 0 };

async function insertLines(page: Page, lines: string[]): Promise<void> {
  lastInsert = { lines: lines.length, requested: 0, chars: 0, pasted: 0 };
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press("Shift+Enter");
    const line = lines[i];
    if (line.length === 0) continue;
    // A line whose inline-code span closes at its end is destroyed by the
    // composer's markdown input rule. The first repair typed the line with a
    // trailing space and deleted the space again; measured on 2026-09-18 that
    // saves a line ending `x`. and does NOT save one ending `x`, because a
    // space typed straight after the closing backtick is itself the rule's
    // trigger. Paste is parsed by a different code path and carries both
    // shapes intact, so the fallback hands those lines to paste rather than
    // trying to out-type an input rule.
    if (CODE_SPAN_AT_LINE_END.test(line)) {
      const before = await composerTextLength(
        page.locator(joinSelectors(SELECTORS.composer)).first(),
      );
      if (await pasteComposerText(page, line) || await pasteLandedLate(page, before)) {
        lastInsert.pasted += 1;
      } else {
        await page.keyboard.insertText(line);
      }
    } else {
      await page.keyboard.insertText(line);
    }
    lastInsert.requested += 1;
    lastInsert.chars += line.length;
  }
}

/** A line whose last inline-code span closes at its end, bar one punctuation mark. */
const CODE_SPAN_AT_LINE_END = /`[^`]*`[.:,;)]?\s*$/;


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
    pollEvidence?: (force?: boolean) => Promise<void>;
    externalComplete?: () => boolean;
    confirmComplete?: () => Promise<boolean>;
  } = {},
): Promise<void> {
  let deadline = Date.now() + timeoutMs;
  let lastText = "";
  let lastChangedAt = Date.now();

  for (;;) {
    if (control.cancelled?.()) return;
    await control.pollEvidence?.(Date.now() >= deadline);
    if (control.cancelled?.()) return;
    if (control.externalComplete?.()) return;
    const requestedConversation = control.consumeReload?.() ?? null;
    const expired = Date.now() >= deadline;
    if (requestedConversation || expired) {
      const conversationId =
        requestedConversation ?? control.conversationId?.() ?? currentConversationId(page);
      if (!conversationId) {
        if (expired) throw new TurnTimeoutError(Math.ceil(timeoutMs / 1_000));
      } else {
        let working = false;
        setExpectedReloadNavigation(page, true);
        try {
          await page.goto(`https://chatgpt.com/c/${conversationId}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          if (control.cancelled?.()) return;
          // Native Deep Research replaces the composer with a progress view
          // while the report is active. Check the turn state first; requiring
          // a composer before this check falsely turns a healthy continuation
          // into "selector composer no longer resolves".
          const settleDeadline = Date.now() + Math.min(10_000, Math.max(1_000, timeoutMs));
          do {
            working = await turnIsWorking(page);
            if (working) break;
            const count = await page.locator(SELECTORS.assistantMessages.join(", ")).count();
            if (count > priorAssistantCount) break;
            if (Date.now() >= settleDeadline) break;
            await page.waitForTimeout(250);
          } while (!control.cancelled?.());
          if (control.cancelled?.()) return;
          if (control.externalComplete) {
            await control.pollEvidence?.(true);
            if (control.cancelled?.() || control.externalComplete()) return;
            // App plans/clarifications may have stable text but no report.
            // They must release the lane instead of reloading indefinitely.
            if (expired && !working) throw new TurnTimeoutError(Math.ceil(timeoutMs / 1_000));
          }
          if (!working) {
            await requireSelector(page, SELECTORS.composer, "composer", 20_000);
          }
        } finally {
          setExpectedReloadNavigation(page, false);
        }

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
          if (!text || (control.confirmComplete && !(await control.confirmComplete()))) {
            throw new TurnTimeoutError(Math.ceil(timeoutMs / 1_000));
          }
          return;
        }
        lastText = "";
        lastChangedAt = Date.now();
      }
    }

    if (control.externalComplete) {
      await page.waitForTimeout(400);
      continue;
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
      if (control.confirmComplete && !(await control.confirmComplete())) {
        lastChangedAt = Date.now();
        continue;
      }
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


/**
 * Click the first candidate Playwright can actually reach, resolving afresh
 * each attempt.
 *
 * The sidebar link is present long before it is actionable: a saturated host
 * leaves it mid-transition or under a pointer-intercepting overlay, and a
 * single 5s click budget then fails a turn the next attempt would pass
 * (P-035 planning-lane incident 2026-09-16, `a[href="/projects"]`). Resolving
 * per attempt mirrors the send path; choosing among matches imperatively
 * avoids a `{ visible: true }` filter, which is re-evaluated at action time
 * and broke the composer click earlier the same day.
 *
 * Readiness gates stay patient (`requireSelectorPatient`); this is only the
 * click itself.
 */
/**
 * `settled` asks whether the click's PURPOSE is already achieved, which is a
 * different question from whether the click promise resolved.
 *
 * Measured 2026-09-18, invocation d3518975: the Projects navigation click
 * reported "could not be clicked after 3 attempts (matches=1, visible=1,
 * url=https://chatgpt.com/projects)". That url is the destination. `goHome`
 * had navigated to chatgpt.com/ and `listProjects` is a pure API read, so
 * nothing but one of those three clicks could have moved the page there: the
 * first click did its job, its promise timed out anyway, and the two retries
 * then ran against an already-correct page whose sidebar item now carried
 * `data-active`. Both hung in "scrolling into view if needed" and never
 * reached the hit test. That is 3 x 15s plus 6s of waiting, and then a failed
 * turn, for a navigation that had already happened.
 *
 * Without a predicate a click helper cannot tell those apart, so it re-tries
 * the one case where re-trying is both useless and prone to hang.
 */
async function clickFirstActionable(
  page: Page,
  candidates: string[],
  name: string,
  attempts = 3,
  settled?: () => boolean,
): Promise<void> {
  const selector = joinSelectors(candidates);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (settled?.()) return;
    const matches = page.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = matches.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      try {
        await candidate.click({ timeout: 15_000 });
        return;
      } catch (error) {
        lastError = error;
        if (settled?.()) return;
      }
    }
    if (page.isClosed()) break;
    await page.waitForTimeout(3_000);
  }
  if (settled?.()) return;
  const matches = page.locator(selector);
  const count = await matches.count().catch(() => -1);
  let visible = 0;
  for (let index = 0; index < count; index++) {
    if (await matches.nth(index).isVisible().catch(() => false)) visible++;
  }
  throw new Error(
    `${name} could not be clicked after ${attempts} attempts ` +
      `(matches=${count}, visible=${visible}, url=${page.url()})` +
      (lastError instanceof Error ? `: ${lastError.message}` : ""),
  );
}
