import type { Page, Locator } from "patchright";
import { PREFLIGHT_CHROME, SELECTORS, joinSelectors } from "./selectors.js";
import { firstResolved, requireSelector, requireSelectorPatient, goHome } from "./chatgpt.js";
import { deepResearchQuota, parseDeepResearchExhausted, parseDeepResearchRemaining, recordDeepResearchExhausted, recordDeepResearchRow, recordDeepResearchTooltip, type DeepResearchQuota } from "./deep-research-quota.js";
import { listProjects } from "../api/projects.js";
import { fetchModelsWithReason, findProModel, type ChatgptModel } from "../api/models.js";
import { classifyInteractionFailure, type InteractionFailure, PreSubmitInteractionError, PreflightDraftProtectedError, ProUsageLimitAfterSubmitError, type ReplyStalledDetails, ReplyStalledError, SelectorBrokenError, type SubmittedTurnNotRenderedDetails, SubmittedTurnNotRenderedError, TurnTimeoutError } from "../errors.js";
import { setExpectedReloadNavigation, streamBreakCount } from "../core/stream.js";

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
export type ProjectNavigationPhase =
  | "project-home" | "project-chat-surface" | "project-list-wait" | "project-list"
  | "project-identity" | "project-navigation-direct" | "project-navigation-lookup" | "project-navigation-wait"
  | "project-navigation-click" | "project-row-wait" | "project-row-retry-wait"
  | "project-label-wait" | "project-label-click" | "project-destination-wait"
  | "project-composer" | "project-model";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * P-035 2026-09-27 r11. Bound on the composer hydration wait that sits between
 * a home navigation and the protected-draft guard that judges its surface.
 *
 * P-035 2026-10-03 G3. Raised from 20 s. Live ms1980 refused
 * `composer_count:0` 12 times under heavy workstation load (cold lane starts
 * 95-130 s), once with `timeline=slot-page:0+982,home:982+0`: the home page was
 * still loading when the guard judged it. The brief asked for 60 s, but one
 * ordinary preflight can issue five of these waits (first guard, home, the
 * Project flow's home and chat-surface waits in `openConversation`, and
 * cleanup-home), and all five must fit inside the daemon's 140 s preflight
 * deadline (`PREFLIGHT_TIMEOUT_MS`, src/daemon/server.ts), so 5 x 28 s = 140 s
 * is the largest bound that does.
 */
export const COMPOSER_HYDRATION_TIMEOUT_MS = 28_000;

/** The light-version notice leads a Deep Research reply; read no deeper. */
const LIGHT_NOTICE_HEAD = 300;

/**
 * Bounded wait for the composer to become visible.
 *
 * P-035 2026-09-27 r11. Live ms1980 (vendor 9af999b, two fresh daemons): the
 * home guard judged a half-loaded page about 1.4 s after `goHome` and refused
 * `composer_count:0` on a composer that had simply not hydrated yet -- the
 * selector diagnostic read `ready=interactive`, heading "Ready when you are.",
 * `composer=false`, every composer candidate count 0, and the capture showed
 * the pre-hydration shell. The login wait that already covers this ran only
 * AFTER that guard, so the guard came first against an unhydrated surface.
 *
 * This wait never admits or refuses anything: a failure to observe the
 * composer -- its own timeout, a page that cannot answer the visibility
 * question yet, a closed target -- is swallowed, and the draft guard that runs
 * immediately after stays the only admission authority. An absent composer
 * therefore still refuses with exactly the error and reason it refused with
 * before this wait existed (fail closed).
 *
 * P-035 2026-09-28 r13. The same race then surfaced one navigation later: live
 * ms1980 (vendor afbea7c) passed the `home` phase and refused at
 * `failedPhase=project-chat-surface` with `reason=composer_count:0`, because
 * `openConversation` judged the surface immediately after its own `goHome`.
 * The wait now lives here, beside every caller that judges a just-navigated
 * surface, and `runInteractionPreflight` imports it for its home guard.
 */
export async function waitForComposerHydrated(page: Page, timeoutMs = COMPOSER_HYDRATION_TIMEOUT_MS): Promise<void> {
  try {
    await page.locator(joinSelectors(SELECTORS.composer)).first()
      .waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    // Absence is not a verdict here; the following guard is.
  }
}

export async function openConversation(
  page: Page,
  opts: { model?: string; conversationId?: string; gizmoId?: string; gizmoShortUrl?: string } = {},
  onPhase?: (phase: ProjectNavigationPhase) => void,
  protectDraft = false,
  ownedConnector?: string,
): Promise<void> {
  // Every protected step proves the CURRENT surface empty before it acts, so
  // the composer-free Projects directory (the one surface this flow visits
  // without a composer) is admissible only after the step before it -- home --
  // was itself proven empty in this same guarded navigation.
  let sourceProvenEmpty = false;
  // P-035 2026-09-28 r20. The protected navigation is the phase where a lane's
  // OWN configured connector chip can still be sitting on the home composer:
  // an earlier preflight attached it, refused later, and left the residue,
  // while `ownedConnector` in the preflight stays undefined until its own
  // `setConnector` returns. Threading that identity here is what lets the
  // guard admit the chip-only surface instead of refusing `connector_unowned`
  // and never reaching the steps that clear the residue. Undefined keeps the
  // exact behaviour every other caller had: no owned connector.
  const guard = async (): Promise<void> => {
    await assertPreflightDraftSafe(page, { connector: ownedConnector });
    sourceProvenEmpty = true;
  };
  if (opts.conversationId) {
    onPhase?.("project-home");
    if (protectDraft) await guard();
    await page.goto(`https://chatgpt.com/c/${opts.conversationId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  } else if (opts.gizmoId || opts.gizmoShortUrl) {
    const slug = opts.gizmoShortUrl ?? opts.gizmoId!;
    onPhase?.("project-home");
    if (protectDraft) await guard();
    await goHome(page, { model: opts.model });
    // P-035 2026-09-28 r13. `goHome` resolves on `domcontentloaded`, so the
    // guard below judged a half-loaded page and refused `composer_count:0` on
    // a composer that had simply not hydrated yet (live ms1980, vendor
    // afbea7c: preflight passed `home`, then refused at this phase). Bounded,
    // and never itself a verdict: the guard still decides, exactly as today.
    if (protectDraft) await waitForComposerHydrated(page);
    // The Project directory row below is this branch's real readiness gate;
    // the home composer was a surface-dependent proxy for the same thing, and
    // it was required BEFORE the Chat surface was selected -- so a profile
    // that landed or persisted on the "Work" surface (whose composer cgpro
    // never types into) failed a check that exists to enable the switch
    // (P-035 planning-lane incident 2026-09-16: five of eight dispatches).
    // ensureChatTab is idempotent; it no-ops on a single-surface UI.
    onPhase?.("project-chat-surface");
    if (protectDraft) await guard();
    await ensureChatTab(page);
    onPhase?.("project-list-wait");
    await page.waitForTimeout(5_000);
    onPhase?.("project-list");
    const projects = await listProjects(page);
    onPhase?.("project-identity");
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
    // P-035 2026-09-26: the sidebar no longer links to /projects (Projects is a
    // section heading), but the directory page itself still loads. The list
    // wait above already let the sidebar render, so no link now means the new
    // UI, not a slow one. A direct load of the DIRECTORY is not the cold
    // Project deep link warned about above; the row click below stays client
    // navigation.
    if (!onProjectsDirectory() &&
        await page.locator(joinSelectors(SELECTORS.projectsNavigation)).count() === 0) {
      onPhase?.("project-navigation-direct");
      if (protectDraft) await guard();
      await page.goto("https://chatgpt.com/projects", { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    if (!onProjectsDirectory()) {
      onPhase?.("project-navigation-lookup");
      await requireSelectorPatient(page, SELECTORS.projectsNavigation, "Projects navigation");
      onPhase?.("project-navigation-wait");
      await page.waitForTimeout(5_000);
      onPhase?.("project-navigation-click");
      if (protectDraft) await guard();
      await clickFirstActionable(
        page, SELECTORS.projectsNavigation, "Projects navigation", 3, onProjectsDirectory,
        protectDraft ? guard : undefined,
      );
    }
    // A saturated host can take longer than one budget to hydrate the
    // directory, and this locator is the only place the vendor clicks a
    // sidebar row. Re-resolve it per attempt instead of failing once, the
    // same shape the send button already uses (P-035 2026-09-16).
    const rowLocator = () => page.locator(joinSelectors(SELECTORS.projectRows)).filter({
      // Renamed from "Open project options for" on 2026-09-26 (P-035).
      has: page.getByRole("button", {
        name: new RegExp(`^(?:Open project options|Project actions) for ${escapeRegExp(project.name)}$`),
      }),
    }).first();
    let row = rowLocator();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        row = rowLocator();
        onPhase?.("project-row-wait");
        await row.waitFor({ state: "visible", timeout: 20_000 });
        break;
      } catch (error) {
        if (attempt === 2 || page.isClosed()) throw error;
        onPhase?.("project-row-retry-wait");
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
    // P-035 2026-09-26: clicking the name now only expands the row; the row's
    // "Start new chat in project" button is what opens /g/<id>/project (read
    // live on ms1980). Older rows have no such button and navigate on the name.
    const startChat = row.getByRole("button", { name: "Start new chat in project", exact: true }).first();
    const label = await startChat.count() > 0 ? startChat : row.getByText(project.name, { exact: true }).first();
    onPhase?.("project-label-wait");
    await label.waitFor({ state: "visible", timeout: 20_000 });
    onPhase?.("project-label-click");
    // The row's label lives on the Projects directory, the one composer-free
    // surface in this flow. Admit it only as that known phase, and only after
    // both the home source and this directory page were proven free of drafts.
    if (protectDraft) {
      await assertPreflightDraftSafe(page, { directory: true, sourceProvenEmpty });
      sourceProvenEmpty = true;
    }
    await label.click({ timeout: 10_000 });
    onPhase?.("project-destination-wait");
    await page.waitForURL((url) => url.origin === "https://chatgpt.com" &&
      (url.pathname === `/g/${project.id}/project` ||
       (project.shortUrl !== undefined && url.pathname === `/g/${project.shortUrl}/project`)),
    { timeout: 20_000 });
  } else {
    const url = new URL("https://chatgpt.com/");
    if (opts.model) url.searchParams.set("model", opts.model);
    onPhase?.("project-home");
    if (protectDraft) await guard();
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  onPhase?.("project-composer");
  await requireSelectorPatient(page, SELECTORS.composer, "composer", 20_000);

  // C-092: chatgpt.com's Work-area rollout can land (or leave a
  // persisted profile) on the "Work" surface, whose composer has its
  // own model set with no Pro tier. cgpro only ever drives classic
  // chat, so force the Chat surface before touching the model picker.
  onPhase?.("project-chat-surface");
  // P-035 2026-09-28 r13. The second branch of the same shape: the plain
  // Recents branch navigates to the home URL by hand (the `goHome` equivalent)
  // and lands here, so it gets the same bounded hydration wait before the
  // guard judges the surface. Inert wherever the composer patient wait above
  // has already proven the composer visible.
  if (protectDraft) await waitForComposerHydrated(page);
  if (protectDraft) await guard();
  await ensureChatTab(page);

  if (opts.model) {
    onPhase?.("project-model");
    if (protectDraft) await guard();
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
  // P-035 2026-09-21. This used to return regardless of the outcome, so every
  // downstream model assumption ran against a surface it never verified -- and
  // the Work surface's composer carries no Pro tier at all. That is a fail-open
  // precondition in a system whose doctrine is fail-closed, and it is exactly
  // how an off-list model label reaches the model-control gate with nothing
  // having reported the surface. Prove the switch landed, or refuse before
  // spending a turn.
  const settled = (await chatTab.getAttribute("aria-checked", { timeout: 2_000 }).catch(() => null)) === "true";
  if (!settled) {
    throw new PreSubmitInteractionError(
      "chat_surface_unconfirmed",
      "model_verification",
      "ChatGPT Chat surface could not be confirmed before submission",
    );
  }
}

export type ModelVerificationPhase =
  | "model-control-lookup" | "model-control-wait" | "model-control-click"
  | "model-catalogue-read"
  | "model-open-slider" | "model-button-state" | "model-slider-wait"
  | "model-slider-lookup" | "model-slider-maximum" | "model-slider-minimum"
  | "model-slider-focus" | "model-slider-end" | "model-value-wait"
  | "model-slider-current" | "model-selected-lookup" | "model-selected-text"
  | "model-cleanup-escape" | "model-cleanup-menu-count" | "model-cleanup-wait";

/**
 * The labels that denote the TOP power state in the thinking menu, and nothing
 * else. The row `selectedPowerModel` resolves carries a power-state label whose
 * vocabulary belongs to ChatGPT, not to us, and it moved.
 *
 * P-035 2026-09-21, observed live on the intelli lane with the slider at 3/3:
 * the row's text is `Extra High` -- the top state's label under the current UI
 * -- where the code previously required `6 Pro`.
 *
 * That observation was answered twice, and the second answer is the one that
 * holds. First the accepted labels were widened to `6 Pro|Extra High`, which is
 * a HEDGE: it cannot tell "one top state under two names" from "a lower tier
 * wearing a different label", and it left the gate unable to corroborate the
 * model NAME at all.
 *
 * Maik, 2026-09-21 13:41: "6 Pro is still mandatory", and the label should be
 * deterministic on any subscribed account. So the expected label is no longer
 * written here at all: it is read from the ACCOUNT'S OWN catalogue, which states
 * the Pro model's title in whatever vocabulary that account renders. A rename
 * therefore moves both sides together, an account without the Pro model fails
 * closed with `model_control_unresolved`, and a page sitting on a different
 * model fails loudly naming both the observed text and the expected title.
 * `High`, `5.6Pro` and `Instant` keep failing because they are not the
 * catalogued Pro model's title.
 */

/**
 * The catalogue read, with one retry, for the pre-submit model check.
 *
 * P-035 2026-09-21. It returns WHY it found nothing, because the two ways to find
 * nothing are different facts and the gate used to state the wrong one: a failed
 * read (a real 401, a raced execution context) was reported as "the account's
 * catalogue carries no Pro model", which sends the reader to the account when the
 * fault is in the read.
 */
/**
 * P-035 2026-09-22. `MAX_EFFORT_ROW_LABELS` and `modelVersion` used to live here.
 * Both rested on reading the composer's row as a model name. Maik's three ordered
 * screenshots of the live composer settled it: the row carries the EFFORT level
 * ("6 Pro" collapsed, "Extra High" on a second account, "6Pro" on a third -- the
 * same Pro level in three rollout spellings), and the model is chosen separately
 * in the model list behind it. So the effort vocabulary was never needed to
 * recognise a model, and comparing an effort label's digits to the catalogue's
 * model version was comparing two different axes. See `readPickerModel`.
 *
 * What survives is the one job the effort label still has: the levels BELOW the
 * top. The slider's own `aria-valuenow` is what proves the effort, so a row that
 * still names one of these while the slider reports its maximum is a
 * contradiction, and P-035 2026-09-21 recorded exactly that shape live -- the
 * Deep Research gate saw `High` with the chip selected and the slider at maximum.
 * A paid turn is not admitted on a contradiction. Matched on the whole
 * normalised label, never as a substring: `Extra High` normalises to `extrahigh`
 * and is the TOP level, not a lower one.
 */
const LOWER_EFFORT_LABELS = new Set(["high", "medium", "low", "instant", "minimal"]);

/**
 * The app's own affordance for "always the newest model", by its on-screen name.
 *
 * P-035 2026-09-22. A live review objected to the first version of the picker
 * read, correctly: "the checked entry is the first entry" proves POSITION, not
 * recency, so an app that ever promotes a pinned or recommended entry above the
 * newest model would be certified as newest while every other part of the gate
 * still validated. A dump of every attribute each entry carries was taken to
 * find an independent recency signal, and there is none: the only per-entry
 * attribute is the checked state itself, and the only icon is the checkmark on
 * the checked entry. So "which entry does the app call latest" is the strongest
 * signal available, and it is a NAME rather than a position.
 *
 * This is deliberately not a model name. `Latest` is a control the app offers --
 * the same one Maik reads as "where we should stay" -- so a rename fails CLOSED
 * and loudly (the whole list is logged) instead of certifying an older model.
 * A silent false positive cost this project a week once already; a loud refusal
 * costs one turn.
 */
const NEWEST_MODEL_SENTINELS = new Set(["latest"]);

async function readCatalogueForModelCheck(
  page: Page,
): Promise<{ models: ChatgptModel[]; reason: string }> {
  let reason = "the read was never attempted";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await fetchModelsWithReason(page).catch((error: Error) => ({
      models: [] as ChatgptModel[],
      status: -1,
      reason: error.message.slice(0, 80),
    }));
    if (result.models.length > 0) return { models: result.models, reason: result.reason };
    reason = `attempt ${attempt + 1}: ${result.reason}`;
    if (attempt === 0) await page.waitForTimeout(1_000);
  }
  return { models: [], reason };
}

const MODEL_MENU_TEXT_MAX = 60;

/**
 * Describe the composer pill's open popover, chrome only.
 *
 * P-035 2026-09-21: capture the menu WHILE IT IS STILL OPEN. The daemon's
 * selector diagnostic runs after this path has called closeOpenMenus, so its row
 * reading can only ever say `absent` -- it did, on a live failure, and that is
 * why repairing this assertion has cost guess after guess.
 *
 * P-035 2026-09-22: each item now carries its own aria-label, aria-checked and
 * data-state, and the open-menu count is recorded. "Which model does the picker
 * say is selected" is a question about those attributes, and the effort-label
 * branch was answering it from the catalogue instead of asking.
 *
 * Bounded and chrome-only: the row the gate reads, the menu's item labels and
 * their state, and the slider's values. No prompt or answer text can be here.
 * Never throws -- a diagnostic must not mask the failure it describes.
 */
async function describeModelMenu(page: Page): Promise<string> {
  try {
    return await page.evaluate(
      ({ selectedSelector, max }: { selectedSelector: string; max: number }) => {
        const clean = (value: string | null): string =>
          (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
        const row = document.querySelector(selectedSelector);
        const items = Array.from(
          document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'),
        )
          .slice(0, 10)
          .map(
            (el) =>
              `"${clean(el.textContent)}"[label=${clean(el.getAttribute("aria-label")) || "-"}` +
              ` checked=${el.getAttribute("aria-checked") ?? "-"}` +
              ` state=${el.getAttribute("data-state") ?? "-"}]`,
          );
        const sliders = Array.from(document.querySelectorAll('[role="slider"]'))
          .slice(0, 4)
          .map((el) => `${el.getAttribute("aria-valuenow")}/${el.getAttribute("aria-valuemax")}`);
        const menus = document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"]').length;
        return (
          `row="${clean(row ? row.textContent : null)}" menus=${menus} ` +
          `menuItems=[${items.join(" ")}] sliders=[${sliders.join(" ")}]`
        );
      },
      { selectedSelector: SELECTORS.selectedPowerModel[0], max: MODEL_MENU_TEXT_MAX },
    );
  } catch {
    return "unavailable";
  }
}

interface PickedModel {
  /** Every selectable entry, in the picker's own order (newest first). */
  entries: string[];
  /** Text of the checked entry, "" when none is checked. */
  checked: string;
  /** Text of the first entry: the newest model, by the app's own ordering. */
  first: string;
  /** Index of the checked entry, -1 when none is checked. */
  checkedIndex: number;
}

/**
 * Every attribute a picker entry carries, one bounded line each.
 *
 * P-035 2026-09-22. This exists to answer ONE open question that a live ChatGPT
 * Pro review raised against `readPickerModel`: "the checked entry is the first
 * entry" proves POSITION, not recency, so an app that ever promotes a pinned or
 * recommended entry above the newest model would be certified as newest while
 * every other part of the gate still validates. If the picker marks recency in
 * any way of its own -- a badge, a title, an aria-description, an icon, a testid
 * on a wrapper -- that mark is the signal the gate should anchor on instead.
 *
 * Gated on `CGPRO_PICKER_DUMP=1` rather than logged every turn: it is a layout
 * question with one answer, and the answer is meant to make this function
 * unnecessary. Chrome only and bounded on every axis; never throws.
 */
async function describePickerEntries(page: Page): Promise<string> {
  try {
    return await page.evaluate(
      ({ max, htmlMax }: { max: number; htmlMax: number }) => {
        const clean = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
        const selectable = Array.from(
          document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'),
        ).filter(
          (el) =>
            el.getAttribute("aria-checked") !== null || el.getAttribute("data-state") !== null,
        );
        return selectable
          .map((el, index) => {
            const attrs = ["aria-label", "aria-checked", "aria-description", "data-state", "title", "data-testid"]
              .map((name) => {
                const value = el.getAttribute(name);
                return value ? `${name}=${clean(value)}` : null;
              })
              .filter(Boolean)
              .join(" ");
            // `getAttribute`, never `.className`: on an SVG element that is an
            // SVGAnimatedString, and the first run of this dump died on it.
            const icon = Array.from(el.querySelectorAll("svg use, svg"))
              .slice(0, 2)
              .map((node) =>
                clean(node.getAttribute("href") ?? node.getAttribute("data-testid") ?? node.getAttribute("class")),
              )
              .filter(Boolean)
              .join("|");
            return (
              `[${index}] text="${clean(el.textContent)}" ${attrs || "no-attrs"}` +
              `${icon ? ` icon=${icon}` : ""} html=${clean(el.outerHTML).slice(0, htmlMax)}`
            );
          })
          .join(" ;; ");
      },
      { max: MODEL_MENU_TEXT_MAX, htmlMax: 220 },
    );
  } catch {
    return "picker entries unavailable";
  }
}

/**
 * The model the composer is actually on, from the picker's own checked entry.
 *
 * P-035 2026-09-22, from Maik's three ordered screenshots of the live composer:
 * the collapsed pill reads "6 Pro"; the first click opens the EFFORT panel (a
 * "6 Pro >" row plus the power slider); clicking that row switches to the MODEL
 * list, where "Latest" carries the check above "GPT-5.6 Sol" and "GPT-5.5
 * Leaving on October 14". "6 Pro" therefore names the maximum thinking-EFFORT
 * level, not a model, and the model is a separate axis.
 *
 * Selectable entries are the ones carrying `aria-checked` or `data-state`; the
 * two control rows in the same popover (`aria-label="Select model"` and
 * `aria-label="Power"`) carry neither. That separates the model list from the
 * controls without hardcoding a single model name. The app orders the list
 * newest first, so "the checked entry is the first" is a structural fact about
 * the composer rather than a label this repo would have to keep in step.
 *
 * One click on the row labelled "Select model" opens the model list when the
 * effort panel is showing; when the entries are already rendered, no click is
 * needed. Never throws: an unreadable picker returns no entries, which the
 * caller refuses on.
 */
async function readPickerModel(page: Page, row: Locator): Promise<PickedModel> {
  const read = async (): Promise<{ entries: string[]; checkedIndex: number }> => {
    try {
      return await page.evaluate(
        ({ max }: { max: number }) => {
          const clean = (value: string | null): string =>
            (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
          const selectable = Array.from(
            document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'),
          ).filter(
            (el) =>
              el.getAttribute("aria-checked") !== null || el.getAttribute("data-state") !== null,
          );
          return {
            entries: selectable.map((el) => clean(el.textContent)),
            checkedIndex: selectable.findIndex(
              (el) =>
                el.getAttribute("aria-checked") === "true" ||
                el.getAttribute("data-state") === "checked",
            ),
          };
        },
        { max: MODEL_MENU_TEXT_MAX },
      );
    } catch {
      return { entries: [], checkedIndex: -1 };
    }
  };

  let { entries, checkedIndex } = await read();
  if (checkedIndex < 0) {
    await row.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    ({ entries, checkedIndex } = await read());
  }
  return {
    entries,
    checked: checkedIndex >= 0 ? entries[checkedIndex] ?? "" : "",
    first: entries[0] ?? "",
    checkedIndex,
  };
}

/** The picker rows this Pro-limit check inspects. Same query `readPickerModel` uses. */
const MODEL_MENU_ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"]';
/** Playwright's own hover is the only pointer this check uses; OS input is never involved. */
const PRO_TOOLTIP_SELECTOR = '[role="tooltip"]';
/** The disabled row's visible label, matched trimmed and case-sensitive. */
const PRO_ITEM_LABEL = "Pro";
/** Cap on the tooltip text carried on the error and the event. */
const PRO_LIMIT_TEXT_MAX = 200;
/** How long a hover is given to surface its tooltip. */
const PRO_TOOLTIP_WAIT_MS = 3_000;
/** Selector tiers the post-hover poll prefers, in order, before falling back to any element. */
const PRO_LIMIT_TEXT_TIERS = [
  PRO_TOOLTIP_SELECTOR,
  "[data-radix-popper-content-wrapper]",
  "[data-side]",
];
/** How many ancestor levels above the disabled row the passive read walks. */
const PRO_PASSIVE_ANCESTOR_LEVELS = 4;
/** One poll step; the deadline still caps the whole wait at PRO_TOOLTIP_WAIT_MS. */
const PRO_TOOLTIP_POLL_MS = 100;
/** Hard attempt cap, so a mocked (instant) clock cannot spin the poll loop. */
const PRO_TOOLTIP_POLL_ATTEMPTS = 40;
/** Stepped pointer move: start this far OUTSIDE the disabled row's left edge. */
const PRO_STEPPED_APPROACH_PX = 4;
/** Steps in the final Playwright-mouse move onto the disabled row's centre. */
const PRO_STEPPED_STEPS = 8;
/** The popover shapes the content-free `none` evidence line probes, and counts. */
const PRO_LIMIT_EVIDENCE_PROBES = [
  PRO_TOOLTIP_SELECTOR,
  "[data-radix-popper-content-wrapper]",
  "[data-side]",
  '[data-state$="open"]',
];

/** Month names as ChatGPT spells them in the limit tooltip. */
const PRO_MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** ISO 8601 for a local instant, carrying the local UTC offset (`...T00:00:00+08:00`). */
function formatLocalIso(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:00` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/**
 * `Try again after <date>` -> ISO 8601 local instant.
 *
 * A named date with no time is the START of that local day (`T00:00:00` plus the
 * local offset); a date WITH a time is that local time. Anything the tooltip does
 * not spell unambiguously returns null, which the caller reports as no known
 * availability rather than inventing one.
 */
export function parseProAvailableAfter(text: string): string | null {
  const match =
    /try again after\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?/i.exec(text);
  if (!match) return null;
  const month = PRO_MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = 0;
  let minute = 0;
  if (match[4] !== undefined) {
    hour = Number(match[4]);
    minute = Number(match[5]);
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (match[6].toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (match[6].toLowerCase() === "am" && hour === 12) hour = 0;
  }
  const date = new Date(year, month, day, hour, minute, 0, 0);
  // Reject a rolled-over day (Feb 30 -> Mar 2): the tooltip must name a real date.
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return formatLocalIso(date);
}

/** The account usage panel's own reading: percent, period and reset instant. */
export interface UsagePanelRead {
  percent: number | null;
  period: "week" | "day" | "month" | null;
  resetAt: string | null;
}

/**
 * How far a year-less panel date may sit in the past before it is read as next
 * year's. The panel names the NEXT reset, so a date just behind us is a page
 * rendered mid-day, not a year-old instant.
 */
const USAGE_PANEL_PAST_GRACE_MS = 24 * 60 * 60 * 1_000;

const USAGE_PANEL_PERCENT_RE = /(\d{1,3})%\s*usage remaining/i;
const USAGE_PANEL_PERIOD_RE = /resets every\s+(week|day|month)/i;
/**
 * `Next reset is on <Mon> <d> at <h:mm> <AM|PM>`, with the year and the time both
 * optional. The live panel (2026-09-28 15:25) read `Next reset is on Oct 4 at
 * 12:58 AM` -- no year at all.
 */
const USAGE_PANEL_RESET_RE =
  /next reset is on\s+([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+at\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?/i;

/**
 * The usage panel's text -> its percent, period and reset instant.
 *
 * P-035 G3 r45 (2026-09-28). The live panel read `6% usage remaining · Resets
 * every week · Next reset is on Oct 4 at 12:58 AM`. The reset line carries no
 * year, so the current local year is used; a date that would sit more than 24 h
 * in the past rolls to the next year. A missing time means the start of that
 * local day (`T00:00:00`), the same convention `parseProAvailableAfter` uses.
 * Anything else returns null, which the caller reports as no known availability
 * rather than inventing one.
 *
 * Pure and page-free, so the parser is unit-testable without a browser.
 */
export function parseUsagePanelText(text: string, now: Date = new Date()): UsagePanelRead | null {
  const match = USAGE_PANEL_RESET_RE.exec(text);
  if (!match) return null;
  const month = PRO_MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  let hour = 0;
  let minute = 0;
  if (match[4] !== undefined) {
    hour = Number(match[4]);
    minute = Number(match[5]);
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (match[6].toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (match[6].toLowerCase() === "am" && hour === 12) hour = 0;
  }
  let year = match[3] === undefined ? now.getFullYear() : Number(match[3]);
  let date = new Date(year, month, day, hour, minute, 0, 0);
  // Reject a rolled-over day (Feb 30 -> Mar 2): the panel must name a real date.
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  if (match[3] === undefined && date.getTime() < now.getTime() - USAGE_PANEL_PAST_GRACE_MS) {
    year += 1;
    date = new Date(year, month, day, hour, minute, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  }
  const percentMatch = USAGE_PANEL_PERCENT_RE.exec(text);
  const periodMatch = USAGE_PANEL_PERIOD_RE.exec(text);
  return {
    percent: percentMatch ? Number(percentMatch[1]) : null,
    period: periodMatch ? (periodMatch[1].toLowerCase() as "week" | "day" | "month") : null,
    resetAt: formatLocalIso(date),
  };
}

/**
 * The account usage panel as ONE unit: percent, period and reset instant.
 *
 * P-035 G3 r45 (2026-09-28). The r42 probe found the percent but no reset, be-
 * cause the reset sentence lives in a SIBLING of the percent line. The panel is
 * therefore the SMALLEST visible element whose text carries BOTH phrases -- for
 * two sibling lines that is their lowest common ancestor, the panel container --
 * and only that element's text is parsed. Read-only through the page's own
 * `evaluate`; only the three parsed fields leave the page. Never throws: an
 * absent, hidden or unreadable panel is null.
 */
export async function readUsagePanel(page: Page): Promise<UsagePanelRead | null> {
  try {
    const found = await page.evaluate(
      ({ usagePanelProbe }: { usagePanelProbe: boolean }) => {
        void usagePanelProbe;
        const percentRe = /(\d{1,3})%\s*usage remaining/i;
        const resetRe = /next reset is on/i;
        const visible = (element: Element): boolean => {
          const style = window.getComputedStyle(element);
          if (style.visibility === "hidden" || style.display === "none") return false;
          if (Number.parseFloat(style.opacity || "1") === 0) return false;
          const rect = element.getBoundingClientRect();
          return !(rect.width === 0 && rect.height === 0);
        };
        let smallest: string | null = null;
        for (const element of Array.from(document.querySelectorAll("body *"))) {
          const html = element as HTMLElement;
          const text =
            typeof html.innerText === "string" && html.innerText.length > 0
              ? html.innerText
              : (element.textContent ?? "");
          if (!percentRe.test(text) || !resetRe.test(text)) continue;
          if (!visible(element)) continue;
          if (smallest === null || text.length < smallest.length) smallest = text;
        }
        return smallest;
      },
      { usagePanelProbe: true },
    );
    if (typeof found !== "string" || found.length === 0) return null;
    return parseUsagePanelText(found);
  } catch {
    return null;
  }
}

/**
 * The reset instant for a limit notice, falling back to the account usage panel.
 *
 * P-035 G3 r45 (2026-09-28). The notice's own date always wins; the panel is
 * read only when the notice names none (today's intelli record carried
 * `limit_text: null`). The Python side then read a six-hour guess, where the
 * panel states the real weekly reset. One content-free stderr line records the
 * fallback; the panel's text never appears in it.
 */
async function availableAfterOrUsagePanel(page: Page, noticeDate: string | null): Promise<string | null> {
  if (noticeDate !== null) return noticeDate;
  const panel = await readUsagePanel(page);
  if (panel?.resetAt) {
    console.error(
      `[cgpro:limit] reset from usage panel resetAt=${panel.resetAt} percent=${panel.percent ?? "-"}`,
    );
    return panel.resetAt;
  }
  return null;
}

/**
 * Index of the disabled `Pro` picker row, or -1 when it is absent or enabled.
 *
 * Reads only the row labels and their disabled attributes; never throws.
 */
async function findDisabledProItemIndex(page: Page): Promise<number> {
  try {
    const found = await page.evaluate(
      ({ proLimitProbe, label }: { proLimitProbe: boolean; label: string }) => {
        void proLimitProbe;
        const items = Array.from(
          document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'),
        );
        for (let index = 0; index < items.length; index++) {
          const element = items[index];
          const text = (element.textContent ?? "").trim();
          if (text !== label) continue;
          const disabled =
            element.getAttribute("aria-disabled") === "true" ||
            element.hasAttribute("data-disabled") ||
            element.hasAttribute("disabled") ||
            element.getAttribute("data-state") === "disabled";
          return disabled ? index : -1;
        }
        return -1;
      },
      { proLimitProbe: true, label: PRO_ITEM_LABEL },
    );
    // Only a numeric index is evidence; anything else means "not found", so a
    // page (or a fixture) that answers with the wrong shape can never make this
    // check reach for a locator it does not have.
    return typeof found === "number" && Number.isInteger(found) ? found : -1;
  } catch {
    return -1;
  }
}

interface ProUsageLimit {
  availableAfter: string | null;
  limitText: string | null;
}

/** Where the limit sentence was read from. Logged content-free, never page text. */
type ProLimitTextSource =
  | "passive-title"
  | "passive-aria"
  | "describedby"
  | "passive-descendant"
  | "hover-row"
  | "hover-ancestor"
  | "hover-stepped"
  | "none";

/** What one forced hover did. `skipped` means it was never needed. */
type ProHoverOutcome = "resolved" | "rejected" | "skipped";

interface ProLimitText {
  source: ProLimitTextSource;
  text: string;
}

/**
 * The limit sentence read WITHOUT any pointer interaction.
 *
 * P-035 2026-09-27. The live intelli lane produced no visible `[role="tooltip"]`
 * within three seconds of a plain `locator.hover()` on the greyed `Pro` row, so
 * the sentence has to be looked for where the page may already carry it: as a
 * `title`, as a RELEVANT `aria-label`, or as the text of an `aria-describedby`
 * target on the disabled row or one of its ancestors. The walk starts at the row
 * and climbs at most four levels, stopping after the menu boundary.
 *
 * Read-only and never throws: any failure means "nothing passive here", and the
 * caller falls back to a forced hover.
 *
 * Every passive candidate is gated on the limit wording. That gate cannot lose a
 * date -- `parseProAvailableAfter` needs `Try again after <month> <day>, <year>`
 * anyway -- and it stops a benign `title="Pro"` (the row's own name) from being
 * recorded as the limit text and masking the real tooltip.
 */
async function readProLimitTextPassive(page: Page, index: number): Promise<ProLimitText | null> {
  try {
    const found = await page.evaluate(
      ({ proLimitPassiveAt, levels }: { proLimitPassiveAt: number; levels: number }) => {
        const relevant = /Limit reached|Try again after/i;
        const items = Array.from(
          document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'),
        );
        const row = items[proLimitPassiveAt];
        if (!row) return null;
        const chain: Element[] = [row];
        let node: Element | null = row.parentElement;
        for (let level = 0; level < levels && node; level++) {
          chain.push(node);
          if (node.getAttribute("role") === "menu") break;
          node = node.parentElement;
        }
        for (const element of chain) {
          const title = (element.getAttribute("title") ?? "").trim();
          if (title.length > 0 && relevant.test(title)) {
            return { source: "passive-title" as const, text: title };
          }
          const aria = (element.getAttribute("aria-label") ?? "").trim();
          if (aria.length > 0 && relevant.test(aria)) {
            return { source: "passive-aria" as const, text: aria };
          }
          const describedBy = (element.getAttribute("aria-describedby") ?? "").trim();
          if (describedBy.length > 0) {
            for (const id of describedBy.split(/\s+/)) {
              const target = document.getElementById(id);
              const text = (target?.textContent ?? "").trim();
              if (text.length > 0 && relevant.test(text)) {
                return { source: "describedby" as const, text };
              }
            }
          }
        }
        // P-035 2026-09-27. The sentence can also sit on a chip or label INSIDE
        // the disabled row, on an element the pointer path never reaches. Scan
        // the row's descendants LAST, so the existing sources keep the order and
        // precedence they had: title, aria-label, describedby target, own text,
        // none of them gated on visibility (a hidden tooltip still names the date).
        for (const descendant of Array.from(row.querySelectorAll("*"))) {
          const title = (descendant.getAttribute("title") ?? "").trim();
          if (title.length > 0 && relevant.test(title)) {
            return { source: "passive-descendant" as const, text: title };
          }
          const aria = (descendant.getAttribute("aria-label") ?? "").trim();
          if (aria.length > 0 && relevant.test(aria)) {
            return { source: "passive-descendant" as const, text: aria };
          }
          const describedBy = (descendant.getAttribute("aria-describedby") ?? "").trim();
          if (describedBy.length > 0) {
            for (const id of describedBy.split(/\s+/)) {
              const target = document.getElementById(id);
              const text = (target?.textContent ?? "").trim();
              if (text.length > 0 && relevant.test(text)) {
                return { source: "passive-descendant" as const, text };
              }
            }
          }
          const own = (descendant.textContent ?? "").trim();
          if (own.length > 0 && relevant.test(own)) {
            return { source: "passive-descendant" as const, text: own };
          }
        }
        return null;
      },
      { proLimitPassiveAt: index, levels: PRO_PASSIVE_ANCESTOR_LEVELS },
    );
    if (!found || typeof found.text !== "string" || found.text.length === 0) return null;
    return { source: found.source, text: found.text };
  } catch {
    return null;
  }
}

/** Hover with Playwright's own pointer and `force`, the way the live lane needs. */
async function forcedHover(target: Locator): Promise<ProHoverOutcome> {
  try {
    // `force` skips the actionability check that refuses a greyed,
    // pointer-events-none row; the pointer is still Playwright's, never OS input.
    await target.hover({ force: true, timeout: PRO_TOOLTIP_WAIT_MS });
    return "resolved";
  } catch {
    return "rejected";
  }
}

/** One document-wide, read-only look for a VISIBLE element carrying the sentence. */
async function scanVisibleLimitText(page: Page): Promise<string | null> {
  return page.evaluate(
    ({ tiers }: { tiers: string[] }) => {
      const relevant = /Limit reached|Try again after/i;
      const textOf = (element: Element): string => (element.textContent ?? "").trim();
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") return false;
        if (Number.parseFloat(style.opacity || "1") === 0) return false;
        const rect = element.getBoundingClientRect();
        return !(rect.width === 0 && rect.height === 0);
      };
      for (const selector of tiers) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          const text = textOf(element);
          if (text.length > 0 && relevant.test(text) && visible(element)) return text;
        }
      }
      // No known wrapper carried it: the innermost matching element wins, so the
      // answer is the sentence itself rather than every ancestor's whole subtree.
      let smallest: string | null = null;
      for (const element of Array.from(document.querySelectorAll("body *"))) {
        const text = textOf(element);
        if (text.length === 0 || !relevant.test(text) || !visible(element)) continue;
        if (smallest === null || text.length < smallest.length) smallest = text;
      }
      return smallest;
    },
    { proLimitScan: true, tiers: [...PRO_LIMIT_TEXT_TIERS] },
  );
}

/** Poll for the sentence after one hover, up to the hover's own 3 s budget. */
async function pollVisibleLimitText(page: Page): Promise<string | null> {
  const deadline = Date.now() + PRO_TOOLTIP_WAIT_MS;
  for (let attempt = 0; attempt < PRO_TOOLTIP_POLL_ATTEMPTS; attempt++) {
    const text = await scanVisibleLimitText(page).catch(() => null);
    if (text) return text;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(PRO_TOOLTIP_POLL_MS).catch(() => undefined);
  }
  return null;
}

/**
 * One stepped Playwright-mouse move from just outside the disabled row's left
 * edge onto its centre.
 *
 * P-035 2026-09-27. The live intelli lane answered `source=none` even though both
 * forced hovers reported `resolved`. A forced `hover()` jumps the pointer straight
 * onto the target, which some Radix popovers ignore; a pointer that arrives in
 * steps is the shape a real mouse makes. `page.mouse` is Playwright's own input
 * layer, never OS input. Returns the same `resolved`/`rejected` vocabulary the
 * forced hovers use, and never throws.
 */
async function steppedRowHover(page: Page, row: Locator): Promise<ProHoverOutcome> {
  try {
    const box = await row.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) return "rejected";
    const centreY = box.y + box.height / 2;
    await page.mouse.move(box.x - PRO_STEPPED_APPROACH_PX, centreY);
    await page.mouse.move(box.x + box.width / 2, centreY, { steps: PRO_STEPPED_STEPS });
    return "resolved";
  } catch {
    return "rejected";
  }
}

/**
 * The content-free evidence line for a `none` result.
 *
 * P-035 2026-09-27. When every source fails, the probe line says only `none`.
 * This reader answers WHY with page SHAPE, never page content: the disabled row's
 * tagName/role/attribute NAMES and only the four state attributes' values, its
 * descendant count, whether the document has focus, what element sits at the row
 * centre, how many popover-shaped elements exist and how many are visible, and
 * the count, tags and attribute NAMES of every element whose text or any
 * attribute VALUE matches the limit wording. No text, typed value or attribute
 * value of a page element is ever carried -- only the four state values named
 * above. Never throws; a page that cannot answer yields no line.
 */
async function readProLimitEvidence(page: Page, index: number): Promise<Record<string, unknown> | null> {
  try {
    return await page.evaluate(
      ({ proLimitEvidence, at, probes }: { proLimitEvidence: boolean; at: number; probes: string[] }) => {
        void proLimitEvidence;
        const relevant = /Limit reached|Try again after/i;
        const items = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="menuitem"],[role="menuitemradio"]',
        ));
        const row = items[at];
        if (!row) return null;
        const visible = (element: Element): boolean => {
          const style = window.getComputedStyle(element);
          if (style.visibility === "hidden" || style.display === "none") return false;
          if (Number.parseFloat(style.opacity || "1") === 0) return false;
          const rect = element.getBoundingClientRect();
          return !(rect.width === 0 && rect.height === 0);
        };
        const stateNames = ["data-state", "data-disabled", "aria-disabled", "disabled"];
        const stateValues: Record<string, string | null> = {};
        for (const name of stateNames) stateValues[name] = row.getAttribute(name);
        const rect = row.getBoundingClientRect();
        const point = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        const popovers: Record<string, { total: number; visible: number }> = {};
        for (const selector of probes) {
          const all = Array.from(document.querySelectorAll(selector));
          popovers[selector] = { total: all.length, visible: all.filter(visible).length };
        }
        // Every element, visible or hidden, whose own text or any attribute value
        // carries the wording: the sentence, each ancestor of it, and any element
        // whose attribute names the date. Only tags and attribute NAMES are kept.
        const matching = Array.from(document.querySelectorAll("body *"))
          .filter((element) =>
            relevant.test(element.textContent ?? "") ||
            Array.from(element.attributes).some((attribute) => relevant.test(attribute.value ?? "")),
          )
          .map((element) => ({
            tag: element.tagName,
            attributes: Array.from(element.attributes).map((attribute) => attribute.name),
          }));
        return {
          row: {
            tag: row.tagName,
            role: row.getAttribute("role"),
            attributeNames: Array.from(row.attributes).map((attribute) => attribute.name),
            stateValues,
          },
          rowDescendants: row.querySelectorAll("*").length,
          hasFocus: document.hasFocus(),
          elementFromPoint: point
            ? {
              tag: point.tagName,
              role: point.getAttribute("role"),
              testId: point.getAttribute("data-testid"),
            }
            : null,
          popovers,
          matchingCount: matching.length,
          matching,
        };
      },
      { proLimitEvidence: true, at: index, probes: [...PRO_LIMIT_EVIDENCE_PROBES] },
    );
  } catch {
    return null;
  }
}

/**
 * Is the picker's `Pro` row disabled, and if so when does Pro return?
 *
 * P-035 2026-09-27. Maik's intelli screenshot showed the live shape: the picker
 * lists `Latest` (checked), `GPT-5.6 Sol`, `GPT-5.5 Leaving on October 14` and a
 * greyed `Pro`, whose tooltip reads `Limit reached. Try again after Sep 30, 2026.`
 * The composer still names `Latest`, so nothing the model checks look at changes
 * -- which is why the limit has to be read off the row itself. Absent or enabled
 * `Pro` returns null and the caller behaves exactly as before.
 *
 * The sentence is read in four widening steps, because a real pointer showed a
 * tooltip that a plain `hover()` could not reach: the passive attributes (now
 * including the row's descendants) first, then a forced hover on the row, then a
 * forced hover on the nearest ancestor that is not the menu itself, then one
 * stepped Playwright-mouse move onto the row's centre. Every source uses the
 * page's own Playwright API; the sentence is the only page content read, and it
 * is capped before it leaves this function. Exactly one content-free diagnostic
 * line is logged per detection, naming the source and each hover or move outcome
 * but never the page text; when nothing answered, one further content-free line
 * describes the page SHAPE around the row and still carries no page text.
 */
async function detectProUsageLimit(page: Page): Promise<ProUsageLimit | null> {
  const index = await findDisabledProItemIndex(page);
  if (index < 0) return null;
  const item = page.locator(MODEL_MENU_ITEM_SELECTOR).nth(index);

  let source: ProLimitTextSource = "none";
  let limitText: string | null = null;
  let rowHover: ProHoverOutcome = "skipped";
  let ancestorHover: ProHoverOutcome = "skipped";
  let steppedMove: ProHoverOutcome = "skipped";

  // 1. Passive sources: no pointer needed, and nothing is left hovered behind.
  const passive = await readProLimitTextPassive(page, index);
  if (passive) {
    source = passive.source;
    limitText = passive.text.slice(0, PRO_LIMIT_TEXT_MAX);
  }
  // 2. A forced hover on the disabled row itself.
  if (limitText === null) {
    rowHover = await forcedHover(item);
    if (rowHover === "resolved") {
      const text = await pollVisibleLimitText(page);
      if (text) {
        source = "hover-row";
        limitText = text.slice(0, PRO_LIMIT_TEXT_MAX);
      }
    }
  }
  // 3. Still nothing: the tooltip can be bound to a wrapper around the row rather
  // than to the row, so the nearest ancestor that is not the menu gets the hover.
  if (limitText === null) {
    const ancestor = item.locator("xpath=ancestor::*[not(@role='menu')][1]");
    ancestorHover = await forcedHover(ancestor);
    if (ancestorHover === "resolved") {
      const text = await pollVisibleLimitText(page);
      if (text) {
        source = "hover-ancestor";
        limitText = text.slice(0, PRO_LIMIT_TEXT_MAX);
      }
    }
  }

  // 4. Still nothing: a forced `hover()` lands the pointer in one jump, which a
  // Radix popover can ignore. One stepped Playwright-mouse move from outside the
  // row's left edge onto its centre is the shape a real pointer makes.
  if (limitText === null) {
    steppedMove = await steppedRowHover(page, item);
    if (steppedMove === "resolved") {
      const text = await pollVisibleLimitText(page);
      if (text) {
        source = "hover-stepped";
        limitText = text.slice(0, PRO_LIMIT_TEXT_MAX);
      }
    }
  }

  // 5. One content-free line per detection: which source answered and whether
  // each hover or stepped move resolved or rejected. The page's own text never
  // appears here.
  console.error(
    `[cgpro:model] pro usage limit probe: source=${source} ` +
      `rowHover=${rowHover} ancestorHover=${ancestorHover} steppedMove=${steppedMove}`,
  );

  // 6. Nothing answered at all: one extra content-free line describing the page
  // SHAPE around the disabled row, so the next session can tell a missing
  // popover from a popover the pointer never reaches. No page text in that line.
  if (source === "none") {
    const evidence = await readProLimitEvidence(page, index);
    if (evidence) {
      console.error(`[cgpro:model] pro usage limit evidence: ${JSON.stringify(evidence)}`);
    }
  }

  // Dismiss the hover the way the existing menu cleanup does, so the popover is
  // left as found before the typed refusal is thrown.
  await page.keyboard.press("Escape").catch(() => undefined);
  return { availableAfter: limitText ? parseProAvailableAfter(limitText) : null, limitText };
}

/** Verify the current Pro effort at maximum on the newest model, before any prompt is submitted. */
export async function ensureProSixMaximum(
  page: Page,
  onPhase?: (phase: ModelVerificationPhase, failedPhase?: ModelVerificationPhase, failure?: InteractionFailure) => void,
): Promise<{ model: string; power: number }> {
  let phase: ModelVerificationPhase = "model-control-lookup";
  let failedPhase: ModelVerificationPhase | undefined;
  let failure: InteractionFailure | undefined;
  const mark = (next: ModelVerificationPhase): void => {
    phase = next;
    onPhase?.(phase, failedPhase, failure);
  };
  mark("model-control-lookup");
  let button: Locator;
  try {
    button = await requireSelector(page, SELECTORS.thinkingPowerButton, "thinking control");
  } catch (error) {
    if (!(error instanceof SelectorBrokenError)) throw error;
    // P-035 2026-09-21. A miss here is NOT proof that ChatGPT's UI changed, and
    // reporting it that way cost this project five turns. The pill can be absent,
    // or present with a label outside the three text-exact candidates, or the page
    // can be on a surface whose composer carries no Pro tier -- the code cannot
    // tell those apart, so it must not assert the strongest one. What it CAN do is
    // fail the turn as a proven pre-submit refusal with a closed code, which is
    // what makes the daemon mark the slot degraded (server.ts:1343 needs ev.code)
    // instead of leaving every consumer reading the lane as healthy.
    // The surrounding `finally` cannot cover this path (the lookup precedes the
    // try), so close any menu the earlier steps left open here, to the same
    // prove-it-closed standard.
    const unresolved = new PreSubmitInteractionError(
      "model_control_unresolved",
      "model_verification",
      "ChatGPT 6 Pro model control did not resolve before submission",
      { cause: error },
    );
    // Classify the TYPED error, not the raw one. The phase callback publishes
    // `failure` upward and the preflight's outer catch uses `failure ??= ...`, so
    // pre-classifying the raw SelectorBrokenError here would pin the reported code
    // to `selector_unresolved` and the typed code would never be seen -- which is
    // exactly what the first acceptance run after this change showed.
    failedPhase = phase;
    failure = classifyInteractionFailure(unresolved);
    await closeOpenMenus(page, mark);
    throw unresolved;
  }
  mark("model-control-wait");
  await page.waitForTimeout(5_000);
  try {
    mark("model-control-click");
    await button.click({ timeout: 5_000 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Timeout")) throw error;
    // Playwright can time out while React has already opened the Radix menu.
    // Inspect the honest UI postcondition before treating the click as failed.
    mark("model-open-slider");
    const slider = await firstResolved(page, SELECTORS.thinkingPowerSlider);
    let opened = slider !== null;
    if (!opened) {
      mark("model-button-state");
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
    mark("model-slider-wait");
    await page.waitForTimeout(5_000);
    mark("model-slider-lookup");
    const slider = await requireSelector(page, SELECTORS.thinkingPowerSlider, "thinking power");
    mark("model-slider-maximum");
    const maximum = await slider.getAttribute("aria-valuemax");
    mark("model-slider-minimum");
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
    mark("model-slider-focus");
    await slider.focus({ timeout: 5_000 });
    mark("model-slider-end");
    await page.keyboard.press("End");
    mark("model-value-wait");
    await page.waitForTimeout(5_000);
    mark("model-slider-current");
    const current = await slider.getAttribute("aria-valuenow");
    if (current === null || Number(current) !== max) {
      throw new Error("6 Pro thinking power did not reach its maximum");
    }
    // On the current UI, moving the power slider is what puts the composer on Pro
    // effort; the model is a separate choice made in the same popover.
    mark("model-selected-lookup");
    const model = await requireSelector(page, SELECTORS.selectedPowerModel, "selected thinking model");
    mark("model-selected-text");
    const effortLabel = (await model.textContent() ?? "").trim();
    // The slider above already proved the effort reached its maximum; a row that
    // still names a LOWER level contradicts it. P-035 2026-09-21 kept this
    // refusal for the Deep Research gate, which saw `High` with the native chip
    // selected and the slider at maximum -- and it keeps refusing now, on the
    // axis it was always about (effort), rather than by comparing the label to a
    // catalogue model title.
    if (LOWER_EFFORT_LABELS.has(effortLabel.toLowerCase().replace(/\s+/g, ""))) {
      const unresolved = new PreSubmitInteractionError(
        "model_control_unresolved",
        "model_verification",
        `The composer shows "${effortLabel}" where the thinking control reports its maximum, so Pro effort could not be verified`,
      );
      failedPhase = phase;
      failure = classifyInteractionFailure(unresolved);
      throw unresolved;
    }
    // P-035 2026-09-21. What the account offers is read from the account's OWN
    // catalogue, never written here. Hardcoding a label is what made a rename read
    // as a broken UI and cost this project a week. The catalogue is now evidence
    // about the ACCOUNT, not the anchor for the composer: Maik's screenshots show
    // the API still lists GPT-5.5 Pro while the picker offers a newer list, so a
    // catalogue can lag a rollout and must not be what the composer is judged by.
    mark("model-catalogue-read");
    const catalogue = await readCatalogueForModelCheck(page);
    const proModel = findProModel(catalogue.models);
    if (catalogue.models.length === 0) {
      const why = `the catalogue read returned nothing (${catalogue.reason})`;
      const unresolved = new PreSubmitInteractionError(
        "model_control_unresolved",
        "model_verification",
        `The account's model catalogue could not be resolved, so a paid turn could not be proven to run on 6 Pro: ${why}`,
      );
      failedPhase = phase;
      failure = classifyInteractionFailure(unresolved);
      throw unresolved;
    }
    // P-035 2026-10-03: Maik ruled to accept the 6-series Latest Pro entry.
    // With no catalogue Pro entry, entitlement rests on account eligibility
    // plus the picker proof below, not on a catalogue Pro entry.
    const catalogueLabel = proModel ? proModel.title ?? proModel.slug : "none";
    // The model comes from the picker's checked entry, and the requirement is the
    // picker's NEWEST model. The effort label this row carries ("Extra High",
    // "6Pro" and "6 Pro" are the same Pro level in three rollout spellings) is no
    // opinion about the model at all, so it is recorded and never compared.
    const picked = await readPickerModel(page, model);
    // P-035 2026-09-27. A greyed-out `Pro` row is not UI drift and not a model
    // choice: it is the account's Pro usage limit. It is read HERE -- the picker
    // items are already enumerated, before the newest-model check -- which is
    // AFTER sendPrompt has typed the prompt (the model check runs deliberately
    // after the insert) and before anything is sent. The lane therefore reports
    // the real cause instead of the "selector no longer resolves" misreport that
    // a later failure produced, and the refusal now leaves the just-typed prompt
    // in the composer for `sendPrompt` to remove.
    const proLimit = await detectProUsageLimit(page);
    if (proLimit) {
      // P-035 G3 r45 (2026-09-28). The notice can name no date at all (today's
      // intelli record: limit_text null), and the old fallback was a six-hour
      // guess. The account usage panel states the real reset, so it is read here
      // and only when the notice itself carries nothing.
      const availableAfter = await availableAfterOrUsagePanel(page, proLimit.availableAfter);
      console.error(
        `[cgpro:model] pro usage limit: availableAfter=${availableAfter ?? "null"}`,
      );
      const limited = new PreSubmitInteractionError(
        "pro_usage_limit_reached",
        "model_verification",
        proLimit.limitText
          ? `ChatGPT Pro usage limit reached before submission: ${proLimit.limitText}`
          : "ChatGPT Pro usage limit reached before submission",
        { availableAfter, limitText: proLimit.limitText },
      );
      failedPhase = phase;
      failure = classifyInteractionFailure(limited);
      throw limited;
    }
    // Two conditions, because position alone is not evidence of recency (see
    // NEWEST_MODEL_SENTINELS): the checked entry must be the picker's own
    // newest-model affordance, and it must be the entry the picker puts first.
    // Either one failing refuses, with the whole list on the record.
    const checkedIsNewest = NEWEST_MODEL_SENTINELS.has(
      picked.checked.toLowerCase().replace(/\s+/g, ""),
    );
    if (!checkedIsNewest || picked.checkedIndex !== 0) {
      const detail = await describeModelMenu(page);
      console.error(
        `[cgpro:model] the composer is not on the picker's newest model: ${detail} ` +
          `catalogue="${catalogueLabel}"`,
      );
      const wrongModel = new PreSubmitInteractionError(
        "model_control_unresolved",
        "model_verification",
        picked.entries.length === 0
          ? "The composer's model picker named no selected model, so a paid turn could not be proven to run on the newest model at Pro effort"
          : `The composer's model picker has "${picked.checked}" selected, where the newest model is "${picked.first}"`,
      );
      failedPhase = phase;
      failure = classifyInteractionFailure(wrongModel);
      throw wrongModel;
    }
    console.error(
      `[cgpro:model] Pro effort on the picker's newest model: effort="${effortLabel}" ` +
        `selected="${picked.checked}" of [${picked.entries.join(", ")}] ` +
        `catalogue="${catalogueLabel}"` +
        (process.env.CGPRO_PICKER_DUMP === "1"
          ? ` pickerEntries=${await describePickerEntries(page)}`
          : ""),
    );
    // The model reported is the one the picker showed, not the catalogue's slug.
    // The catalogue can lag the composer (it lists GPT-5.5 Pro while the picker
    // offers a newer list), so naming it here would record a model nobody read.
    return { model: picked.checked, power: max };
  } catch (error) {
    failedPhase = phase;
    failure = classifyInteractionFailure(error);
    throw error;
  } finally {
    await closeOpenMenus(page, mark);
  }
}

const MENU_CLOSE_ATTEMPTS = Math.max(1, Number(process.env.CGPRO_MENU_CLOSE_ATTEMPTS ?? 4));

/** Count Radix-style overlays that trap focus. Mirrors the `menus` field in the delivery diagnostic. */
const OPEN_MENU_SELECTOR = '[role="menu"],[role="listbox"],[role="dialog"],[aria-modal="true"]';

/**
 * Anything that can sit over the page and eat a click, whether or not it
 * exposes a role. The role-based set alone was blind to the overlay that killed
 * a turn on 2026-09-22; see SELECTORS.blockingOverlay.
 */
const POINTER_BLOCKER_SELECTOR = `${OPEN_MENU_SELECTOR}, ${joinSelectors(SELECTORS.blockingOverlay)}`;

const BLOCKER_TEXT_MAX = 60;

/**
 * Press Escape until no pointer blocker is left, bounded, and never throwing.
 * Returns the number STILL attached: 0 when the page is clear, -1 when the page
 * could not answer at all.
 *
 * P-035 2026-09-22. This is the dismissal `closeOpenMenus` was doing all along,
 * lifted out so the click path can use it too. The distinction it introduces is
 * the point: a leftover count of 0 means "provably clear", and everything else
 * means "not proven", which the caller must not read as success.
 */
async function dismissPointerBlockers(
  page: Page,
  onPhase?: (phase: ModelVerificationPhase) => void,
): Promise<number> {
  try {
    for (let attempt = 0; attempt < MENU_CLOSE_ATTEMPTS; attempt++) {
      onPhase?.("model-cleanup-escape");
      await page.keyboard.press("Escape").catch(() => undefined);
      onPhase?.("model-cleanup-menu-count");
      const open = await page
        .evaluate((selector) => document.querySelectorAll(selector).length, POINTER_BLOCKER_SELECTOR)
        .catch(() => -1);
      if (open === 0) return 0;
      onPhase?.("model-cleanup-wait");
      await page.waitForTimeout(250);
    }
    return await page
      .evaluate((selector) => document.querySelectorAll(selector).length, POINTER_BLOCKER_SELECTOR)
      .catch(() => -1);
  } catch {
    // A dismissal runs on the failure path; it may never replace the real error.
    return -1;
  }
}

/**
 * Name the overlay that is eating the click, for the failure message.
 *
 * Chrome only, bounded, and never throwing: what this exists for is the case
 * where Playwright says "subtree intercepts pointer events" and nothing else
 * names the element. The user asked to be able to see what page a failure
 * happened on, and an element id is what makes that answerable after the fact.
 */
async function describePointerBlocker(page: Page): Promise<string> {
  try {
    return await page.evaluate(
      ({ host, max }: { host: string; max: number }) => {
        const clean = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
        const el = document.querySelector(host);
        if (!el) return "";
        const attrs = ["id", "data-testid", "role", "data-state", "class"]
          .map((name) => {
            const value = el.getAttribute(name);
            if (!value) return null;
            // A class list is long and mostly styling; keep only the shape
            // markers that identify the overlay.
            const trimmed = name === "class"
              ? value.split(/\s+/).filter((c) => /^(fixed|absolute|inset-0|z-\d+)$/.test(c)).join(" ")
              : value;
            return trimmed ? `${name}=${clean(trimmed)}` : null;
          })
          .filter(Boolean)
          .join(" ");
        const inside = Array.from(el.querySelectorAll('[role="dialog"],button,[role="menuitem"]'))
          .slice(0, 3)
          .map((node) => `"${clean(node.textContent)}"`)
          .join(" ");
        return `${el.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ""}${inside ? ` text=[${inside}]` : ""}`;
      },
      { host: SELECTORS.blockingOverlay[0], max: BLOCKER_TEXT_MAX },
    );
  } catch {
    return "";
  }
}

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
async function closeOpenMenus(page: Page, onPhase?: (phase: ModelVerificationPhase) => void): Promise<void> {
  // This runs from a `finally`, so it must never throw: an exception here would
  // replace whatever real error the caller was already reporting.
  const left = await dismissPointerBlockers(page, onPhase);
  if (left !== 0) {
    console.error(
      "[cgpro:model] WARNING: a menu is still open after setting the thinking control. Its focus trap can truncate the prompt mid-insert; the composer verification will refuse to submit if it does.",
    );
  }
}

/**
 * True when the composer's pill has opened the THINKING-EFFORT menu rather than
 * a model list, identified by the power slider the effort menu contains.
 *
 * P-035 2026-09-21. On the current UI the pill renders the effort level ("Extra
 * High"), no model name appears anywhere in the composer, and `tryEnsureModel`'s
 * model-name search could therefore never match again: it printed "no menu item
 * matched" on EVERY turn. A warning that always fires is one nobody reads, and
 * the day it fires for a real reason it will look identical.
 *
 * Attached count, not visibility: ChatGPT renders `role="slider"` on a hidden
 * ThumbInput span, so a visible-first lookup would miss the one element that
 * identifies this menu. Silence here is only safe because the paid-model
 * outcome is owned downstream by `ensureProSixMaximum`, which fails the turn
 * closed before submission; a menu that is NOT the effort menu and still lacks
 * the requested model keeps its loud warning, because that is a real regression.
 */
export async function menuIsThinkingEffort(page: Page): Promise<boolean> {
  let attached = 0;
  for (const candidate of SELECTORS.thinkingPowerSlider) {
    attached += await page.locator(candidate).count().catch(() => 0);
  }
  return attached > 0;
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
    } else if (!(await menuIsThinkingEffort(page))) {
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
  let toggle = await firstResolved(page, SELECTORS.webSearchToggle.slice(4)); // skip the popover-only variants
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

  // P-035 2026-10-03 G3-B (sixth run). Live intelli: the persisted mode can
  // also render as an app mention (`@deep-research`) that
  // `SELECTORS.deepResearchSelected` does not know, and the draft guard admits
  // it as an own chip. Turning the mode off therefore removes the mention
  // first: place the caret directly after it, press Backspace once, check
  // again, try once more, and fail before submit if it is still there.
  let mentionRemoved = false;
  if (!on && await deepResearchMention(page, false)) {
    for (let attempt = 0; attempt < 2 && !mentionRemoved; attempt += 1) {
      if (await deepResearchMention(page, true)) {
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(300);
      }
      mentionRemoved = !(await deepResearchMention(page, false));
    }
    if (!mentionRemoved) throw new Error("ChatGPT native Deep Research mention could not be removed");
  }

  // The selected mode is rendered as a blue composer chip. This is the
  // strongest current-state signal and avoids reopening the picker merely to
  // inspect an ARIA attribute that the current UI no longer supplies.
  const alreadySelected = await firstResolved(page, SELECTORS.deepResearchSelected);
  if (on && alreadySelected) {
    await verifyMaximum();
    return true;
  }
  // P-035 2026-10-03 G3-B. Live intelli: a failed Deep Research turn left the
  // chip in the home composer and ChatGPT kept it across restarts. Turning the
  // mode off is judged by the chip alone: no chip means nothing to undo, so
  // neither the picker nor any row is touched.
  if (!on && !alreadySelected) return mentionRemoved;

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
  // P-035 2026-10-03 G4-A. Read the row's remaining counter before it is
  // touched. Text only: the read never clicks and never changes the selection.
  // G4-C: without a count in the row text it hovers the row for its tooltip.
  if (on) await readDeepResearchRow(page, toggle);

  const selected = async (candidate: Locator): Promise<boolean> => {
    const checked = (await candidate.getAttribute("aria-checked").catch(() => null)) === "true";
    const pressed = (await candidate.getAttribute("aria-pressed").catch(() => null)) === "true";
    const state = (await candidate.getAttribute("data-state").catch(() => null)) === "checked";
    return checked || pressed || state;
  };

  // Off is only reached with the chip present, and the chip is the truth: the
  // picker row's ARIA state is not consulted, the same row is clicked again.
  if (on && (await selected(toggle))) {
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
      throw new Error(on
        ? "ChatGPT native Deep Research was visible but could not be selected"
        : "ChatGPT native Deep Research could not be turned off");
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
    const visible = await recordConnectorDiagnostics(page);
    const detail = visible.length > 0 ? `; visible entries=${JSON.stringify(visible)}` : "";
    throw new Error(on
      ? `ChatGPT native Deep Research selection did not become active${detail}`
      : `ChatGPT native Deep Research could not be turned off${detail}`);
  }
  if (on) {
    await verifyMaximum();
  }
  // G3-B (sixth run): on the off path the chip was removed, so report it.
  return true;
}

/**
 * P-035 2026-10-03 G3-B (sixth run). Whether a composer holds the Deep Research
 * app mention, judged by the same `PREFLIGHT_CHROME.deepResearchMention*` parts
 * the draft guard uses. With `placeCaret`, the matching composer is focused and
 * a collapsed selection is put directly after the mention (`Range.setStartAfter`)
 * so one Backspace removes exactly that mention. In-tab JavaScript only.
 */
async function deepResearchMention(page: Page, placeCaret: boolean): Promise<boolean> {
  const found = await page.evaluate(({ composerSelector, mentionSelector, text, attributes, pattern, placeCaret }) => {
    const matcher = new RegExp(pattern, "i");
    for (const composer of Array.from(document.querySelectorAll<HTMLElement>(composerSelector))) {
      const mention = Array.from(composer.querySelectorAll<HTMLElement>(mentionSelector)).find(element =>
        element !== composer
        && (element.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === text
        && attributes.some(name => matcher.test(element.getAttribute(name) ?? "")));
      if (!mention) continue;
      if (placeCaret) {
        composer.focus();
        const range = document.createRange();
        range.setStartAfter(mention);
        range.collapse(true);
        const selection = window.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return true;
    }
    return false;
  }, {
    composerSelector: joinSelectors(SELECTORS.composer),
    mentionSelector: PREFLIGHT_CHROME.deepResearchMention,
    text: PREFLIGHT_CHROME.deepResearchMentionText,
    attributes: [...PREFLIGHT_CHROME.deepResearchMentionAttributes],
    pattern: PREFLIGHT_CHROME.deepResearchMentionPattern,
    placeCaret,
  });
  return found === true;
}

/** Interactive ancestors a Deep research label may sit inside; the row is the nearest one. */
const DEEP_RESEARCH_ROW_ANCESTORS =
  'button, [role="menuitem"], [role="menuitemradio"], [role="option"], [data-radix-collection-item], div.__menu-item';

/**
 * P-035 2026-10-03 G4-A. One bounded read of the Deep research row's text,
 * recorded as this process's quota reading. The row is the nearest interactive
 * ancestor of the resolved label (the count may be a sibling of the label).
 * Returns false, recording nothing, when the row cannot be read.
 */
async function readDeepResearchRow(page: Page, toggle: Locator): Promise<boolean> {
  const text = await toggle.evaluate((element, ancestors) => {
    const row = (element.closest(ancestors) as HTMLElement | null) ?? element as HTMLElement;
    return typeof row.innerText === "string" ? row.innerText : "";
  }, DEEP_RESEARCH_ROW_ANCESTORS, { timeout: PICKER_READ_TIMEOUT_MS }).catch(() => null);
  if (typeof text !== "string") return false;
  recordDeepResearchRow(text);
  if (parseDeepResearchRemaining(text) === null) await readDeepResearchTooltip(page, toggle);
  return true;
}

/** How long the row's hover tooltip may take to appear, and how often it is looked for. */
const DEEP_RESEARCH_TOOLTIP_WAIT_MS = 1_500;
const DEEP_RESEARCH_TOOLTIP_POLL_MS = 150;

/**
 * P-035 2026-10-03 G4-C. Live: the tools row's own text carries no count
 * ("Deep research Get a detailed report"). OpenAI's help page says: "Your
 * in-product usage counter shows your remaining tasks." The counter is a
 * tooltip beside the row (`25 left`), shown on hover. So, when the row names
 * no count, hover it (Playwright/CDP mouse movement inside the page, never OS
 * input) and read the first visible tooltip within 1500 ms: the element named
 * by `aria-describedby`, then `PREFLIGHT_CHROME.deepResearchTooltip` in order.
 * Bounded and never throws; it never clicks and never types.
 */
async function readDeepResearchTooltip(page: Page, toggle: Locator): Promise<void> {
  let tooltip: string | null = null;
  try {
    const deadline = Date.now() + DEEP_RESEARCH_TOOLTIP_WAIT_MS;
    await toggle.hover({ timeout: DEEP_RESEARCH_TOOLTIP_WAIT_MS });
    const polls = Math.ceil(DEEP_RESEARCH_TOOLTIP_WAIT_MS / DEEP_RESEARCH_TOOLTIP_POLL_MS);
    for (let poll = 0; poll < polls && tooltip === null && Date.now() < deadline; poll += 1) {
      const found = await toggle.evaluate((element, { ancestors, tooltipSelectors }) => {
        const row = (element.closest(ancestors) as HTMLElement | null) ?? element as HTMLElement;
        const ids = [element.getAttribute("aria-describedby"), row.getAttribute("aria-describedby")]
          .join(" ").split(/\s+/).filter(id => id !== "");
        const candidates: Element[] = [];
        for (const id of ids) {
          const node = document.getElementById(id);
          if (node) candidates.push(node);
        }
        for (const selector of tooltipSelectors) candidates.push(...Array.from(document.querySelectorAll(selector)));
        for (const node of candidates) {
          if (node.contains(row) || row.contains(node)) continue;
          const style = window.getComputedStyle(node);
          if (node.getClientRects().length === 0 || style.visibility === "hidden" || style.display === "none") continue;
          const text = (node as HTMLElement).innerText;
          if (typeof text === "string" && text.trim() !== "") return text;
        }
        return null;
      }, {
        ancestors: DEEP_RESEARCH_ROW_ANCESTORS,
        tooltipSelectors: [...PREFLIGHT_CHROME.deepResearchTooltip],
      }, { timeout: Math.max(1, Math.min(PICKER_READ_TIMEOUT_MS, deadline - Date.now())) }).catch(() => null);
      if (typeof found === "string") tooltip = found;
      else await page.waitForTimeout(DEEP_RESEARCH_TOOLTIP_POLL_MS);
    }
  } catch {
    // A failed hover or poll leaves the row's reading as it was.
  }
  recordDeepResearchTooltip(tooltip);
}

/**
 * P-035 2026-10-03 G4-A. Read the Deep Research quota on an idle page: the
 * preflight's home step (`goHome` + `waitForComposerHydrated`), then the tools
 * popover, then the row's text (and, G4-C, its hover tooltip when the text
 * names no count), then Escape and a check that the popover
 * closed. It never clicks the row, never types and never submits.
 */
export async function readDeepResearchQuota(page: Page): Promise<DeepResearchQuota> {
  await goHome(page);
  await waitForComposerHydrated(page);
  if (!(await openComposerToolsPopover(page))) {
    throw new Error("ChatGPT composer tools popover is unavailable");
  }
  const toggle = await requireSelector(page, SELECTORS.deepResearchToggle, "native Deep Research", 8_000)
    .catch(() => null);
  if (!toggle) {
    await page.keyboard.press("Escape").catch(() => undefined);
    throw new Error("ChatGPT native Deep Research is not exposed in the composer tool picker");
  }
  const read = await readDeepResearchRow(page, toggle);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  if (await toggle.isVisible().catch(() => false)) {
    throw new Error("ChatGPT composer tools popover did not close after Escape");
  }
  if (!read) throw new Error("ChatGPT native Deep Research row could not be read");
  return deepResearchQuota();
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

/**
 * P-035 2026-09-23. Ceiling on each element read along the connector picker path.
 * Playwright waits 30 s by default for a locator that does not resolve, and a
 * picker row the app closed or re-rendered does not resolve: `attachedState`
 * could spend 30 s on each of up to 12 reads, and the picker-click step measured
 * 80.8 s and 168 s on intelli. A bounded read comes back empty and the step's
 * own retry and deadline decide. `isVisible` and `count` never wait.
 */
const PICKER_READ_TIMEOUT_MS = 1_000;

async function visibleComposerTool(page: Page, name: string): Promise<Locator | null> {
  // Let the browser narrow the DOM before crossing the automation boundary, then
  // decide visibility and the exact label in ONE in-page pass per selector.
  // Previews of earlier Project chats ("@<connector> SYSTEM: ...") also contain
  // the name, so per-candidate isVisible/innerText round trips grew with the
  // Project's history: on 2026-09-26 picker-wait went from a 3 s median to 29 s
  // (max 147 s) and every lane preflight hit its 140 s budget.
  const expected = name.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const matchingCandidate = async (selector: string): Promise<Locator | null> => {
    const candidates = page.locator(selector).filter({ hasText: name });
    const [index, scanned] = await candidates
      .evaluateAll((elements, label) => [elements.findIndex((element) => {
        const el = element as HTMLElement;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 &&
          el.checkVisibility({ visibilityProperty: true }) &&
          el.innerText.replace(/\s+/g, " ").trim().toLocaleLowerCase() === label;
      }), elements.length], expected)
      .catch(() => [-1, 0]);
    // Diagnostic for the picker-click stall (P-035 2026-09-26): how many page
    // elements a locator that resolves by this filter must scan.
    if (scanned > 20) console.error(`[cgpro:connector] lookup selector=${selector.slice(0, 20)} candidates=${scanned} match=${index}`);
    // ponytail: a re-render between this pass and the caller's use can shift
    // nth(); callers re-verify the row (attached state, exact click) and retry.
    return index >= 0 ? candidates.nth(index) : null;
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
  const labels = await page
    .locator(joinSelectors(SELECTORS.connectorDiagnosticLabels))
    .allInnerTexts()
    .catch(() => [] as string[]);
  const boundedLabels = labels
    .map((label) => label.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((label) => label.slice(0, 120));
  console.error(`[cgpro:connector] visible picker entries=${JSON.stringify(boundedLabels)}`);
  if (process.env.CGPRO_DEBUG !== "1") return boundedLabels;
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
    if (await candidate.getAttribute("data-composer-markdown").catch(() => null) !== null) continue;
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

/**
 * Read the attached-state attribute value when the row or its nearest
 * state-bearing ancestor reports attached, else null.
 *
 * The chatgpt.com picker can render the exact label as a plain span while
 * its enclosing interactive row carries the state attribute (live lane-1
 * acceptance evidence), so reading only the label row is not enough. The
 * walk stops at the nearest row that carries one of the accepted state
 * attributes; only the exact values "true" / "checked" accept, anything
 * else stays fail-closed.
 */
export async function attachedState(row: Locator): Promise<string | null> {
  // One in-page pass. Each Locator read re-resolves the row's `span:has-text`
  // filter over the whole page, and this walk made up to 12 of them: on
  // 2026-09-26 it took about 29 s of a 31 s picker-click step on a long Project
  // while the click itself took 1.7 s. An unreadable row fails closed and the
  // caller's click/retry path decides.
  const raw = await row.evaluate((element, [attributes, depth]) => {
    let el: Element | null = element;
    for (let level = 0; el && level <= depth; level++, el = el.parentElement) {
      for (const attribute of attributes) {
        const value = el.getAttribute(attribute);
        if (value !== null) return value;
      }
    }
    return null;
  }, [ATTACHED_STATE_ATTRIBUTES, ATTACHED_STATE_ANCESTOR_DEPTH] as const, { timeout: PICKER_READ_TIMEOUT_MS })
    .catch(() => null);
  return raw === "true" || raw === "checked" ? raw : null;
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
    return Boolean(form?.querySelector("#prompt-textarea, [data-testid=\"prompt-textarea\"], [data-composer-markdown]"));
  }, undefined, { timeout: PICKER_READ_TIMEOUT_MS }).catch(() => false);
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
/**
 * P-035 2026-09-23. Why a click stalled lives in the LAST lines of Playwright's
 * call log ("element is not stable", "<div …> intercepts pointer events",
 * "element was detached"); the first line only says it timed out. The connector
 * click costs 3-60 s across the lanes and nothing on record says why, so name
 * the cause before changing the click.
 */
function clickStallReason(error: Error): string {
  return error.message.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("-"))
    .slice(-2).join(" | ").slice(0, 240) || "no call log";
}

async function clickConnector(page: Page, row: Locator, name: string): Promise<void> {
  const clickStart = Date.now();
  const mark = (what: string) => console.error(`[cgpro:connector] click-sub ${what} ms=${Date.now() - clickStart}`);
  try {
    await row.click({ timeout: 5_000 });
    mark("first-click-done");
  } catch (error) {
    mark("first-click-threw");
    // ChatGPT can replace the @ results between observation and click. Resolve
    // one fresh exact row; never force-click through a popover or toggle off an
    // attachment that mounted while the first click was timing out.
    if (!(error instanceof Error) || !error.message.includes("Timeout")) throw error;
    console.error(`[cgpro:connector] click-timeout attempt=1 reason=${clickStallReason(error)}`);
    const refreshed = await waitForComposerTool(page, name);
    mark(`refresh-lookup found=${Boolean(refreshed)}`);
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
      console.error(`[cgpro:connector] click-timeout attempt=2 reason=${clickStallReason(retryError)}`);
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

/**
 * P-035 2026-09-28 r33. The clear of the `@` this call itself typed: Escape,
 * composer click, Meta+A, Backspace, each step preceded by the same
 * `{ text: "@" }` guard the pre-attach steps use when `protectDraft`. Two
 * branches need exactly this sequence -- the picker-missing fallback and the
 * found-but-click-failed branch -- so it lives here once. The CALLER decides
 * whether its own errors propagate (picker-missing) or are swallowed
 * (found-but-click-failed, where the ORIGINAL error must reach the caller).
 */
async function clearTypedConnectorQuery(page: Page, composer: Locator, protectDraft: boolean): Promise<void> {
  if (protectDraft) await assertPreflightDraftSafe(page, { text: "@" });
  await page.keyboard.press("Escape").catch(() => undefined);
  await composer.click();
  if (protectDraft) await assertPreflightDraftSafe(page, { text: "@" });
  await page.keyboard.press("Meta+A");
  if (protectDraft) await assertPreflightDraftSafe(page, { text: "@" });
  await page.keyboard.press("Backspace");
}

export async function setConnector(page: Page, name: string, protectDraft = false): Promise<void> {
  const connectorName = name.trim();
  if (!connectorName) throw new Error("connector name must not be empty");
  // P-035 2026-09-21. Per-step timing on stderr, where the daemon already
  // captures this module's diagnostics. The phase timeline calls this whole
  // function one 114.8-second block, and every wait inside it is small and
  // bounded (3-8s), so the cost is in how MANY of them run rather than in any
  // one -- which is invisible at phase resolution and obvious at step
  // resolution. Nine marks, one line each.
  let markAt = Date.now();
  const step = (label: string): void => {
    console.error(`[cgpro:connector] step=${label} ms=${Date.now() - markAt}`);
    markAt = Date.now();
  };
  const composer = await requireSelector(page, SELECTORS.composer, "composer");
  // P-035 2026-09-28 r20. The three pre-attach guards judge the surface this
  // call is about to clear, and the one chip that surface may legitimately
  // hold is this call's OWN connector -- attached by an earlier refused run
  // and persisted. Passing the trimmed name lets the guard admit that residue
  // by identity (exactly the same rule the preflight's own guard uses) so the
  // steps that clear it actually run. The `{ text: "@" }` guards below are
  // unchanged: they judge a different, already-cleared surface.
  if (protectDraft) await assertPreflightDraftSafe(page, { connector: connectorName });
  await composer.click();
  if (protectDraft) await assertPreflightDraftSafe(page, { connector: connectorName });
  await page.keyboard.press("Meta+A");
  if (protectDraft) await assertPreflightDraftSafe(page, { connector: connectorName });
  await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  await page.waitForTimeout(300);
  step("at-sign-typed");

  let connector = await waitForComposerTool(page, connectorName);
  step("picker-wait");
  if (connector) {
    // Already attached - skip the click (clicking an attached row can
    // toggle it off) and accept the honest state.
    if (await attachedState(connector)) {
      await page.keyboard.press("Escape").catch(() => undefined);
      step("already-attached");
      return;
    }
    try {
      await clickConnector(page, connector, connectorName);
      step("picker-click");
      await page.waitForTimeout(300);
      await assertConnectorAttached(page, connectorName);
      step("attach-assert");
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
    } catch (error) {
      // P-035 2026-09-28 r33. Live intelli 06:21: the found-connector branch ran
      // `clickConnector` (first-click-threw, attempt=1 and attempt=2) and threw,
      // and the `@` our code had typed stayed in the composer. Every later
      // preflight then refused `text_present`, so the lane restarted every tick.
      // The picker-missing branch already clears that `@`; this branch did not.
      // Run the SAME guarded clear here, swallowing only its own errors so the
      // ORIGINAL click/attach error is what reaches the caller.
      await clearTypedConnectorQuery(page, composer, protectDraft).catch(() => undefined);
      throw error;
    }
  }

  // Clear the failed @ query before trying older plus-menu layouts.
  await clearTypedConnectorQuery(page, composer, protectDraft);
  step("picker-missing");
  if (!(await openComposerToolsPopover(page))) {
    if (!protectDraft) await recordConnectorDiagnostics(page);
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
    step("plus-popover");
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
    if (!protectDraft) await recordConnectorDiagnostics(page);
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
    if (!protectDraft) await recordConnectorDiagnostics(page);
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

/**
 * Content-free shape of the text node a `foreign_text` refusal stopped on:
 * the parent tag, its sanitised role and nearest sanitised `data-testid`, why
 * it is hidden, the trimmed text length, and whether that text is the owned
 * connector. Never the text and never any other attribute value.
 *
 * P-035 2026-09-28 r18. The planner needs to know whether the refused span is
 * UI chrome (a chip placeholder/hint) or a mirror of draft text before any
 * admission rule changes, so the shape carries six more content-free features:
 * whether the text contains the owned connector, whether it equals any
 * composer placeholder attribute value, whether it equals the composer's own
 * text, its word count, the parent-first tag path up to the form (tags only),
 * and how many elements on that path carry an `aria-label` (count only).
 */
interface ForeignTextShape {
  tag: string;
  role: string;
  testid: string;
  hidden: string;
  len: number;
  equalsConnector: string;
  containsConnector: string;
  /**
   * P-035 2026-09-28 r28. Which part of the in-force proof the refused node
   * agrees with, so a live refusal names it without any character of the node.
   * `contains_prefix` and `contains_marker` are `yes`/`no` under a provenance
   * proof and `n/a` without one; `contains_text` is `yes`/`no` under an exact
   * owned-text proof and `n/a` without one.
   */
  containsPrefix: string;
  containsMarker: string;
  containsText: string;
  /**
   * P-035 2026-09-28 r29. The refused node passed chip identity and (under a
   * provenance proof) still failed the mirror rule, so the planner needs to
   * know HOW the header differs inside the mirror without a character of it.
   * With `m = norm(unescape(nodeText))` and `p = norm(provenance.prefix)`:
   * `header_at` is where `p`'s first 40 characters sit in `m` (`-1` when
   * absent), `header_run` is the common run from there, and `have_char` /
   * `want_char` classify the first position after that run (`end` when a side
   * ran out). `alnum_contains` and `alnum_header_at` repeat the question with
   * every non-letter and non-digit removed, so a punctuation-only divergence
   * shows as `yes` with the header found. All six are `n/a` without a
   * provenance proof. Never a character from the page: classes and counts only.
   */
  headerAt: string;
  headerRun: string;
  haveChar: string;
  wantChar: string;
  alnumContains: string;
  alnumHeaderAt: string;
  equalsPlaceholder: string;
  equalsComposerText: string;
  words: number;
  path: string;
  labels: number;
}

/**
 * P-035 2026-09-28 r25. The owned-text comparison refused `owned_text_mismatch`
 * without saying how far the two sides agreed, so a live refusal left the
 * mismatch class -- an extra character, a truncation, a wholly different string
 * -- unknown. The shape carries three counts and no text: the two normalised
 * lengths and the length of their longest common prefix.
 */
interface OwnedTextShape {
  haveLen: number;
  wantLen: number;
  commonPrefix: number;
}

/**
 * P-035 2026-09-28 r26. The provenance mode admits a draft this facade composed
 * without naming its text, so a refusal must say which of the three provenance
 * conditions failed. Booleans and one length only: never a character.
 */
interface ProvenanceShape {
  prefix: boolean;
  marker: boolean;
  invocation: boolean;
  len: number;
}

/**
 * P-035 2026-09-28 r31. Live evidence 05:54 (vendor e15e417, Intelli pid 50146):
 * provenance mode admitted the owned draft on the FIRST provenance call, then
 * the final empty check refused `rich_attr:data-composer-inline-atom-selected`
 * -> `draft_persisted`. The token branch above found no outermost
 * `[contenteditable="false"]` token, so the refusing node is some inline atom
 * that survived the clear and is not a token. The shape names it without a
 * character of the page: the sanitised tag, the sanitised `contenteditable`
 * value, counts of the node and of the composer it sat in, whether its trimmed
 * text equals the owned connector, and its depth below the composer. Counts and
 * tag names only, never page text and never any other attribute value.
 */
interface RichAttrShape {
  tag: string;
  ce: string;
  textLen: number;
  children: number;
  childTags: string;
  composerLen: number;
  composerWords: number;
  tokens: number;
  atoms: number;
  equalsConnector: string;
  depth: number;
}

/**
 * P-035 2026-10-03 G3-B (fifth run). One element of a token's shape: its
 * sanitised tag, its attribute NAMES, and the values of only the attributes in
 * `TOKEN_SHAPE_VALUES`, each capped at 80 characters (`null` when absent).
 */
interface TokenNodeShape {
  tag: string;
  attrs: string[];
  values: Record<string, string | null>;
}

/**
 * The only attributes whose values a token shape may carry. G3-B (sixth run):
 * the three app-mention attributes the Deep Research mention is recognised by,
 * so a future miss shows their values.
 */
const TOKEN_SHAPE_VALUES = [
  "data-id", "data-type", "role", "aria-label", "class",
  "app-mention-name", "app-mention-path", "data-prompt-link-label",
] as const;

/**
 * P-035 2026-10-03 G3-B (fifth run). Live intelli refused `connector_token_text`
 * on a composer showing only a `deep-research` token, and the pill selector did
 * not match the outermost atom. The shape of the FIRST outermost token says
 * where the pill attributes really are: the token, its parent and grandparent
 * (stopping at the composer, `null` past it), its text length and whether its
 * whitespace-collapsed text is a slug, and whether any ancestor inside the form
 * carries `[data-inline-selection-pill]`. Never the token's text.
 */
interface TokenShape {
  node: TokenNodeShape;
  textLen: number;
  slug: boolean;
  parent: TokenNodeShape | null;
  grandparent: TokenNodeShape | null;
  pillAncestor: boolean;
}

/**
 * P-035 2026-10-03 G3-B (fifth run). Live ms1980 refused
 * `directory_forbidden_node:embed` on a clean /projects page. One entry per
 * matching `iframe`/`object`/`embed`, up to 3: the sanitised tag, the `src`
 * origin and pathname only (`none` without a `src`), the rounded client rect,
 * computed `display`/`visibility`, `aria-hidden`, `tabindex`, and `id`/`name`
 * capped at 40. `count` is how many elements matched in total.
 * G3-B (sixth run): only frames that refused, so unrendered frames are neither
 * listed nor counted.
 */
interface EmbedShape {
  count: number;
  frames: Array<{
    tag: string; src: string; width: number; height: number; display: string; visibility: string;
    ariaHidden: string | null; tabindex: string | null; id: string | null; name: string | null;
  }>;
}

/** The content-free diagnostics a single refusal may carry beside its reason. */
type PreflightDiagnostic =
  | {
    reason: string; chipRemainder: { len: number; ws: number; cf: number; other: number };
    foreignShape?: undefined; ownedTextShape?: undefined; provenanceShape?: undefined;
    richAttrShape?: undefined; noTokenShape?: undefined; tokenShape?: undefined; embedShape?: undefined;
  }
  | { reason: string; foreignShape: ForeignTextShape; chipRemainder?: undefined; ownedTextShape?: undefined;
    provenanceShape?: undefined; richAttrShape?: undefined; noTokenShape?: undefined; tokenShape?: undefined;
    embedShape?: undefined }
  | { reason: string; ownedTextShape: OwnedTextShape; chipRemainder?: undefined; foreignShape?: undefined;
    provenanceShape?: undefined; richAttrShape?: undefined; noTokenShape?: undefined; tokenShape?: undefined;
    embedShape?: undefined }
  | { reason: string; provenanceShape: ProvenanceShape; chipRemainder?: undefined; foreignShape?: undefined;
    ownedTextShape?: undefined; richAttrShape?: undefined; noTokenShape?: undefined; tokenShape?: undefined;
    embedShape?: undefined }
  | { reason: string; richAttrShape: RichAttrShape; chipRemainder?: undefined; foreignShape?: undefined;
    ownedTextShape?: undefined; provenanceShape?: undefined; noTokenShape?: undefined; tokenShape?: undefined;
    embedShape?: undefined }
  | {
    reason: string; noTokenShape: { len: number; ws: number; cf: number; at: number; other: number };
    chipRemainder?: undefined; foreignShape?: undefined; ownedTextShape?: undefined;
    provenanceShape?: undefined; richAttrShape?: undefined; tokenShape?: undefined; embedShape?: undefined;
  }
  | { reason: string; tokenShape: TokenShape; chipRemainder?: undefined; foreignShape?: undefined;
    ownedTextShape?: undefined; provenanceShape?: undefined; richAttrShape?: undefined; noTokenShape?: undefined;
    embedShape?: undefined }
  | { reason: string; embedShape: EmbedShape; chipRemainder?: undefined; foreignShape?: undefined;
    ownedTextShape?: undefined; provenanceShape?: undefined; richAttrShape?: undefined; noTokenShape?: undefined;
    tokenShape?: undefined };

/** One token-shape element as `tag=<t> attrs=<a,b> data-id="<v>" ...`; `-` for none. */
function formatTokenNode(shape: TokenNodeShape | null): string {
  if (!shape) return "-";
  const values = TOKEN_SHAPE_VALUES
    .map(name => `${name}=${shape.values[name] === null || shape.values[name] === undefined
      ? "-" : JSON.stringify(shape.values[name])}`);
  return [`tag=${shape.tag}`, `attrs=${shape.attrs.join(",") || "-"}`, ...values].join(" ");
}

/**
 * Read-only, content-free admission for the no-submit preflight. Unknown rich
 * nodes or controls are protected, not converted into a text backup. Only the
 * exact probe text, the single connector token introduced by this call, or that
 * token followed by this call's exact text (the connector-turn shape) may pass.
 *
 * Safe draft admission depends on the known navigation PHASE, never on a
 * universal composer count. A composer-free page is admissible only as the
 * exact ChatGPT Projects directory step (`owned.directory`) of a guarded
 * navigation whose preceding surface was already proven empty
 * (`owned.sourceProvenEmpty`); every other no-composer page still refuses.
 */
export async function assertPreflightDraftSafe(
  page: Page,
  owned: {
    text?: string; connector?: string; directory?: boolean; sourceProvenEmpty?: boolean;
    /** r26: prove a composed draft by its planning header, marker and invocation id, never by its text. */
    provenance?: { prefix: string; marker: string };
  } = {},
): Promise<void> {
  let safe = false;
  let reason: string | null = null;
  try {
    const outcome = await page.evaluate(({
      selector, chromeSelectors, owned, tokenShapeValues,
    }): true | string | PreflightDiagnostic => {
      // P-035 2026-09-27. The guard still answers a single bit: `true` admits,
      // a string is the FIRST check that refused, named by a closed, content-free
      // reason code. The branch order and every condition are exactly as before,
      // so admission is unchanged; only the refusal now says which branch it was.
      /** Keep a code to UI chrome: [A-Za-z0-9 _.:-], trimmed, capped at 60. */
      const chrome = (value: string): string =>
        value.replace(/[^A-Za-z0-9 _.:-]/g, "").trim().slice(0, 60);
      // P-035 2026-09-28 r25. Whitespace is a rendering artefact: `innerText`
      // renders the paragraph breaks of pasted multi-line text differently from
      // the source newlines, so the owned-text comparison normalises every run
      // of whitespace to one space and trims. Every non-whitespace character
      // must still match exactly and in order; only the whitespace between them
      // is forgiven.
      const norm = (value: string): string => value.replace(/\s+/g, " ").trim();
      // P-035 2026-09-28 r28. The hidden composer mirror is a Markdown/HTML
      // serialisation of the draft, so the same content arrives with backslash
      // escapes (`\-`, `\*`, `\_`) and HTML entities (`&lt;`, `&gt;`, `&amp;`,
      // `&quot;`, `&#39;`, `&#x27;`, `&nbsp;`) instead of the literal characters
      // the composer renders. Undo exactly that escaping, in ONE pass, before
      // the mirror is compared to the proof: first drop the backslash before an
      // ASCII punctuation character, then decode exactly those seven entities
      // (`&nbsp;` to a space). Entities are decoded once, so an escaped entity
      // (`&amp;lt;`) stays an escaped entity rather than being decoded twice.
      // Only the mirror text is unescaped; the owned proof is never transformed.
      const entityMap: Record<string, string> = {
        "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": "\"",
        "&#39;": "'", "&#x27;": "'", "&nbsp;": " ",
      };
      const unescape = (value: string): string => value
        .replace(/\\([!-\/:-@\[-`{-~])/g, "$1")
        .replace(/&(?:lt|gt|amp|quot|#39|#x27|nbsp);/g, entity => entityMap[entity] ?? entity);
      // P-035 2026-09-28 r26. Two ownership proofs can be in force: the exact
      // owned text (r23/r24) and, mutually exclusive with it, the provenance
      // triple. Both name the whole draft this call introduced, so the `Expand`
      // and paste-marker exemptions below key off this one flag instead of the
      // text alone.
      const combinedProof = owned.text !== undefined || owned.provenance !== undefined;
      // The length of the longest common prefix of two strings, code unit by
      // code unit. A count only: never any character.
      const commonPrefixLength = (a: string, b: string): number => {
        const max = Math.min(a.length, b.length);
        let index = 0;
        while (index < max && a[index] === b[index]) index += 1;
        return index;
      };
      // P-035 2026-09-28 r30. The planning header's letters and digits, in order
      // but with every separator dropped: the hidden mirror renders the header
      // with different punctuation and line breaks (`-` becomes a Markdown `*`,
      // paragraph breaks collapse), so the same header arrives as a different
      // literal string while every letter and digit stays contiguous and in
      // order. Lowercased so case is not a divergence either. ONE helper, used
      // both by the live shape line (r29) and by the mirror admission rule (r30).
      const reduceAlnum = (value: string): string =>
        value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
      // P-035 2026-09-28 r29. The content-free CLASS of one code point, so a
      // header divergence can be named in a live line without ever printing a
      // character from the page: `ws` for whitespace, `P:<hex code point>` for
      // ASCII punctuation or symbol (e.g. `P:2a` for `*`, `P:2d` for `-`),
      // `L` for any letter, `N` for any digit, and `O:<general category>` for
      // anything else (`O:Po`, `O:Sm`, `O:Cf`, ...); `end` when a side ran out.
      // The category is found by testing the property escapes in turn, since JS
      // exposes no direct general-category accessor; unmatched is `Cn`.
      const generalCategories: Array<[RegExp, string]> = [
        [/\p{Mn}/u, "Mn"], [/\p{Mc}/u, "Mc"], [/\p{Me}/u, "Me"],
        [/\p{Pc}/u, "Pc"], [/\p{Pd}/u, "Pd"], [/\p{Ps}/u, "Ps"], [/\p{Pe}/u, "Pe"],
        [/\p{Pi}/u, "Pi"], [/\p{Pf}/u, "Pf"], [/\p{Po}/u, "Po"],
        [/\p{Sm}/u, "Sm"], [/\p{Sc}/u, "Sc"], [/\p{Sk}/u, "Sk"], [/\p{So}/u, "So"],
        [/\p{Zs}/u, "Zs"], [/\p{Zl}/u, "Zl"], [/\p{Zp}/u, "Zp"],
        [/\p{Cc}/u, "Cc"], [/\p{Cf}/u, "Cf"], [/\p{Cs}/u, "Cs"], [/\p{Co}/u, "Co"],
      ];
      const charClass = (character: string | undefined): string => {
        if (character === undefined) return "end";
        if (/\s/u.test(character)) return "ws";
        if (/[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/.test(character)) {
          return `P:${(character.codePointAt(0) ?? 0).toString(16)}`;
        }
        if (/\p{L}/u.test(character)) return "L";
        if (/\p{N}/u.test(character)) return "N";
        const match = generalCategories.find(([pattern]) => pattern.test(character));
        return `O:${match ? match[1] : "Cn"}`;
      };
      /** UI chrome only for a control: data-testid, else aria-label, else tag name. */
      const identify = (element: { getAttribute?: (name: string) => string | null; tagName?: string }): string => {
        let raw = "";
        try { raw = element.getAttribute?.("data-testid") ?? ""; } catch { /* not a DOM element */ }
        if (!raw) { try { raw = element.getAttribute?.("aria-label") ?? ""; } catch { /* not a DOM element */ } }
        if (!raw) raw = element.tagName ?? "";
        return chrome(raw) || "unknown";
      };
      /** The selector kinds the one combined media query used, for the reason code. */
      const mediaKinds: Array<[string, string]> = [
        ["img", "img"], ["video", "video"], ["audio", "audio"], ["canvas", "canvas"],
        ["object", "object"], ["iframe", "iframe"],
        ["attachment", '[data-testid*="attachment" i]'],
        ["upload", '[data-testid*="upload" i]:not(input)'],
        ["data-type", "[data-type]"],
        ["remove", '[aria-label*="remove" i]'],
      ];
      const composers = Array.from(document.querySelectorAll<HTMLElement>(selector));
      if (location.href === "about:blank") {
        return composers.length === 0 && document.body?.childNodes.length === 0
          ? true : "blank_page_not_empty";
      }
      if (location.origin !== "https://chatgpt.com") return "foreign_origin";
      // Uploads can be outside the editable document, and an empty text value
      // says nothing about files, pending uploads, or non-text tokens.
      if (Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
        .some(input => input.files === null || input.files.length > 0)) return "file_input_has_files";
      if (composers.length !== 1) {
        // The Projects directory is the single composer-free surface the
        // vendor flow is known to visit. Admit it ONLY when the caller names
        // that phase, its preceding surface was proven empty in this guarded
        // navigation, the route is exactly /projects, and read-only DOM checks
        // find no editor, attachment/upload marker, unknown nested surface or
        // typed value. A missing composer alone is never a safe condition.
        if (!owned.directory || !owned.sourceProvenEmpty) return `composer_count:${composers.length}`;
        if (location.pathname !== "/projects") return "directory_path_not_projects";
        // P-035 2026-10-03 G3-B (fourth run). Live ms1980 refused
        // `directory_forbidden_node` three times on a clean-looking /projects
        // page, and the one combined query could not say which part matched.
        // The same selectors, split into named groups: the FIRST matching group
        // names the refusal `directory_forbidden_node:<code>`. Content-free
        // codes only; which nodes refuse is unchanged.
        const directoryForbidden: Array<[string, string]> = [
          ["editor", 'textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'],
          ["data_type", "[data-type]"],
          ["attachment", '[data-testid*="attachment" i]'],
          ["upload", '[data-testid*="upload" i]:not(input)'],
          ["aria_remove", '[aria-label*="remove" i]'],
          ["blob_img", 'img[src^="blob:"]'],
          ["embed", "iframe, object, embed"],
          ["canvas", "canvas"],
          ["media", "video, audio"],
        ];
        // P-035 2026-10-03 G3-B (fifth run). The `embed` refusal also carries
        // the content-free shape of up to 3 matching frames, so one live round
        // says whether they are visible and where they load from. The reason
        // is exactly as before. Each read is guarded: an unreadable property
        // reads `unknown`, never a different refusal.
        const embedFrame = (element: Element): EmbedShape["frames"][number] => {
          const attribute = (name: string): string | null => {
            try { return element.getAttribute?.(name) ?? null; } catch { return null; }
          };
          let src = "none";
          const rawSrc = attribute("src");
          if (rawSrc !== null) {
            try {
              const url = new URL(rawSrc, location.href);
              src = `${url.origin}${url.pathname}`.slice(0, 200);
            } catch { src = "invalid"; }
          }
          let width = -1;
          let height = -1;
          try {
            const rect = element.getBoundingClientRect();
            width = Math.round(rect.width);
            height = Math.round(rect.height);
          } catch { /* not laid out or not a DOM element */ }
          let display = "unknown";
          let visibility = "unknown";
          try {
            const style = getComputedStyle(element);
            display = chrome(style.display) || "-";
            visibility = chrome(style.visibility) || "-";
          } catch { /* no computed style */ }
          const capped = (value: string | null): string | null => value === null ? null : value.slice(0, 40);
          return {
            tag: chrome(element.tagName ?? "") || "unknown", src, width, height, display, visibility,
            ariaHidden: capped(attribute("aria-hidden")), tabindex: capped(attribute("tabindex")),
            id: capped(attribute("id")), name: capped(attribute("name")),
          };
        };
        // P-035 2026-10-03 G3-B (sixth run). Live ms1980 (built 2134f76)
        // refused at `project-label-click` on a clean /projects page:
        //   [cgpro:preflight] draft guard refused: reason=directory_forbidden_node:embed
        //   [cgpro:preflight] directory embed shape: index=1 count=1 tag=IFRAME src=none width=1 height=1 display=block visibility=hidden aria_hidden=- tabindex=- id=- name=-
        // A frame that is not rendered cannot hold a draft. The `embed` group
        // skips a frame whose computed `display` is `none`, or whose computed
        // `visibility` is `hidden` or `collapse`, or whose client rect is at most
        // 1 px wide AND at most 1 px high. A frame that cannot be read is not
        // proven hidden and still refuses. Every other frame refuses exactly as
        // before, and the shape lists only the frames that refused.
        const unrenderedFrame = (element: Element): boolean => {
          try {
            const style = getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
          } catch { /* no computed style */ }
          try {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 1 && rect.height <= 1) return true;
          } catch { /* not laid out or not a DOM element */ }
          return false;
        };
        for (const [code, forbidden] of directoryForbidden) {
          const all = Array.from(document.querySelectorAll(forbidden));
          const matches = code === "embed" ? all.filter(element => !unrenderedFrame(element)) : all;
          if (matches.length > 0) {
            const reason = `directory_forbidden_node:${code}`;
            if (code !== "embed") return reason;
            try {
              return {
                reason,
                embedShape: { count: matches.length, frames: matches.slice(0, 3).map(embedFrame) },
              };
            } catch { return reason; }
          }
        }
        for (const field of Array.from(document.querySelectorAll<HTMLInputElement>(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])' +
          ':not([type="button"]):not([type="submit"]):not([type="file"])',
        ))) {
          // A typed search/value on the directory is a draft like any other.
          if ((field.value ?? "").length > 0) return "directory_typed_value";
        }
        return true;
      }
      const composer = composers[0];
      const form = composer.closest("form");
      if (!form || !composer.isConnected || composer.getClientRects().length === 0) return "composer_not_rendered";
      // P-035 2026-10-03 G3-B. Live intelli: a failed Deep Research turn left the
      // native "Deep research" chip in the home composer, ChatGPT kept it across
      // restarts, and every preflight refused `form_media:img` on the chip's own
      // icon. The automation's own chip is a non-editable atom inside the
      // composer (outermost only) or a non-picker `button` in the form whose
      // whitespace-collapsed text is EXACTLY one of the chip labels. Media inside
      // such a chip, and the chip itself as a control, are chrome; its atom is
      // removed from the clone and its label from the text below. Any other
      // media, control or text refuses exactly as before.
      //
      // P-035 2026-10-03 G3-B (fourth run). Live intelli passed `home` and then
      // refused `connector_token_text` after the Project flow's `goHome`: the
      // composer held only the same persisted mode in its pill form, text
      // `deep-research`, which the exact labels miss. An atom or button that IS
      // or CONTAINS a `deepResearchChipPill` match is an own chip too; its text
      // to strip is then its own whitespace-collapsed `textContent`. A
      // `[contenteditable="false"]` token without that data-id refuses as before.
      const ownChipLabel = (element: Element): string | null => {
        const label = norm(element.textContent ?? "");
        return (chromeSelectors.deepResearchChipLabels as readonly string[]).includes(label) ? label : null;
      };
      //
      // P-035 2026-10-03 G3-B (fifth run). Live intelli still refused
      // `connector_token_text` at `home`: the outermost atom neither matched nor
      // contained the pill selector, so the pill attributes may sit on an
      // ANCESTOR of the atom. An element whose nearest pill ancestor is strictly
      // inside `scope` (the composer, or its clone) is an own chip too; a pill
      // ancestor that is the scope itself or outside it never counts.
      const ownChipPill = (element: Element, scope: Element): boolean => {
        try {
          if (element.matches?.(chromeSelectors.deepResearchChipPill)
            || element.querySelector?.(chromeSelectors.deepResearchChipPill)) return true;
          const holder = element.parentElement?.closest?.(chromeSelectors.deepResearchChipPill) ?? null;
          return !!holder && holder !== scope && !!scope.contains?.(holder);
        } catch { return false; }
      };
      //
      // P-035 2026-10-03 G3-B (sixth run). Live intelli (built 2134f76) refused
      // `connector_token_text` at `home` on a composer holding one token:
      //   [cgpro:preflight] token shape: tag=SPAN attrs=app-mention-name,app-mention-display-name,app-mention-path,... text_len=13 slug=yes parent=[tag=P ...] pill_ancestor=no
      // A third rendering of the persisted mode: the app mention
      // `@deep-research`. It is an own chip exactly when the
      // `deepResearchMention*` parts all hold: a `[contenteditable="false"]`
      // element strictly inside `scope` carrying `app-mention-name`, text
      // exactly `deep-research` (case-insensitive, whitespace collapsed), and
      // a matching value in at least one of the named attributes. Any other
      // app mention, or this text without a matching value, refuses as before.
      // `setDeepResearch(page, false)` removes it before an ordinary turn.
      const ownChipMention = (element: Element, scope: Element): boolean => {
        try {
          if (!element.matches?.(chromeSelectors.deepResearchMention)) return false;
          if (element === scope || !scope.contains?.(element)) return false;
          if (norm(element.textContent ?? "").toLowerCase() !== chromeSelectors.deepResearchMentionText) return false;
          const pattern = new RegExp(chromeSelectors.deepResearchMentionPattern, "i");
          return (chromeSelectors.deepResearchMentionAttributes as readonly string[])
            .some(name => pattern.test(element.getAttribute?.(name) ?? ""));
        } catch { return false; }
      };
      /** The text an own chip renders (its label, or a pill's or mention's own text), else null. */
      const ownChipText = (element: Element, scope: Element = composer): string | null =>
        ownChipLabel(element)
        ?? (ownChipPill(element, scope) || ownChipMention(element, scope) ? norm(element.textContent ?? "") : null);
      // A root that cannot be queried (not a DOM element) holds no own chip.
      const ownChipAtoms = (root: Element): HTMLElement[] =>
        Array.from(root.querySelectorAll?.<HTMLElement>(chromeSelectors.deepResearchChipAtom) ?? []).filter(atom =>
          !atom.parentElement?.closest('[contenteditable="false"]') && ownChipText(atom, root) !== null);
      const ownChips: Element[] = [
        ...ownChipAtoms(composer),
        ...Array.from(form.querySelectorAll(chromeSelectors.deepResearchChipButton))
          .filter(button => ownChipText(button) !== null),
      ];
      const inOwnChip = (node: Element): boolean => ownChips.some(chip => chip.contains(node));
      for (const [kind, mediaSelector] of mediaKinds) {
        if (form.querySelector(mediaSelector)
          && Array.from(form.querySelectorAll(mediaSelector)).some(media => !inOwnChip(media))) {
          return `form_media:${kind}`;
        }
      }
      // P-035 2026-09-27. On this account's UI variant the composer `+` carries
      // aria-label="Add files and more" and no composer-plus-btn testid, so an
      // empty home lane refused `unknown_control:Add files and more`. It is the
      // same control, admitted here; nothing else newly joins the allowlist.
      // The refusal now names EVERY unknown control at once (existing sanitized
      // identifier, de-duplicated, DOM order, at most 5, whole code capped at
      // 200 chars) so any further variant control shows up in one round.
      const unknownControls: string[] = [];
      // P-035 2026-10-03 G3. Live ms1980: after a successful Deep Research turn
      // ChatGPT shows "Take this further in ChatGPT Work" above the composer,
      // with a "Try Work" button and an X, and the watchdog preflight refused
      // `unknown_control:BUTTON|Dismiss ChatGPT beacon banner` and restarted the
      // lane. The banner is an ancestor of that X which does NOT contain the
      // composer (G3-B below: the outermost one); a `button` inside it is
      // chrome, not a draft. An unnamed `BUTTON` anywhere else, a
      // `[role="button"]` on another tag, and every control when no such
      // ancestor exists still refuse exactly as before.
      //
      // P-035 2026-10-03 G3-B. In the live capture the heading, the line and
      // "Try Work" are siblings of the X inside one card, so the X's direct
      // parent need not be the whole card. The banner is now the OUTERMOST
      // ancestor of the X that is inside the form and does not contain the
      // composer: walk up from the X and stop before the first ancestor that
      // holds the composer or is the form. Inside it, every `button` is chrome
      // and the foreign-text walk below skips its text; text or controls
      // outside it refuse exactly as before.
      const beaconBanners: Element[] = [];
      for (const dismiss of Array.from(form.querySelectorAll(chromeSelectors.beaconBannerDismiss))) {
        let banner: Element | null = null;
        for (let element = dismiss.parentElement; element && element !== form && !element.contains(composer);
          element = element.parentElement) banner = element;
        if (banner) beaconBanners.push(banner);
      }
      for (const control of Array.from(form.querySelectorAll('button, [role="button"]'))) {
        if (composer.contains(control) || control.closest('[role="menu"], [role="listbox"]')) continue;
        if (inOwnChip(control)) continue;
        if (control.tagName === "BUTTON" && beaconBanners.some(banner => banner.contains(control))) continue;
        if (control.matches('button[data-testid="composer-plus-btn"], button[aria-label="Add files and more"], button[data-testid="send-button"], button[data-testid="composer-send-button"], button[aria-label="Select ChatGPT model"], button.__composer-pill[aria-haspopup="menu"], button[data-testid="model-switcher-dropdown-button"]')) continue;
        const id = identify(control);
        // P-035 2026-09-27. The empty home composer also carries its dictation
        // (microphone) and voice-mode buttons, so the same lane refused
        // `unknown_control:Dictate|Start Voice`. Both are UI chrome with no
        // draft content. Admit a `button` whose OWN sanitized identifier -- the
        // exact string the refusal names -- is `Dictate` or `Start Voice`;
        // nothing else, exact match only, and never `[role="button"]` on
        // another tag. Checked after `matches` so the allowlist is unchanged.
        //
        // P-035 2026-09-28 r12. Live ms1980 (vendor 1684dee): with the hydration
        // wait working, the SAME empty home lane refused `unknown_control:Send`
        // -- its only unknown control. On this UI variant the empty composer's
        // send arrow carries identifier `Send` and neither `send-button` nor
        // `composer-send-button` testid. It is the same UI chrome, admitted here
        // by that exact sanitized identifier, on a `button` only, exactly as r8
        // admitted `Dictate` and `Start Voice`. No prefix match, no case fold:
        // `Send now`, `Send a message` and a `div[role="button"]` named `Send`
        // all still refuse. The text checks below are untouched, so typed text
        // with this button present still refuses `text_present`.
        //
        // P-035 2026-09-28 r23. A long draft renders its expander on the
        // composer, and the lone `Expand` button refused the whole surface as
        // `unknown_control:Expand` even when every other check had already
        // proven the composer held EXACTLY this call's own connector chip and
        // prompt. Admit that one identifier only while a combined exact-text
        // proof is in force (`owned.text !== undefined`, the same condition the
        // token branch below uses): the caller has then named the full owned
        // draft, so the expander is chrome over content this call introduced.
        // r26 extends that same condition to the provenance proof
        // (`combinedProof`): a caller that named its planning header, marker and
        // invocation id has named the whole draft just as exactly.
        // Any other caller -- and every `[role="button"]` -- still refuses
        // `unknown_control:Expand` exactly as before.
        if (control.tagName === "BUTTON"
          && (id === "Dictate" || id === "Start Voice" || id === "Send"
            || (id === "Expand" && combinedProof))) continue;
        if (unknownControls.length < 5 && !unknownControls.includes(id)) unknownControls.push(id);
      }
      if (unknownControls.length > 0) return `unknown_control:${unknownControls.join("|")}`.slice(0, 200);
      const copy = composer.cloneNode(true) as HTMLElement;
      // G3-B: the automation's own Deep Research atom is not a connector token
      // and not draft content; drop it from the clone before tokens are counted.
      // G3-B (third run): how many were removed decides the whitespace rule in
      // the no-token text check below.
      let removedOwnChipAtoms = 0;
      for (const atom of ownChipAtoms(copy)) {
        atom.remove();
        removedOwnChipAtoms += 1;
      }
      // P-035 2026-09-28 r14. Ownership is proven by the chip's TEXT, never its
      // tag: ms1980's owned chip is not an `A` while intelli's is, so the old
      // `tagName !== "A"` clause refused the very chip this call attached. The
      // single `connector_token_mismatch` also named four conditions at once.
      // Tokens are the OUTERMOST `[contenteditable="false"]` elements only: a
      // token nested inside another token (a chip's own icon, say) is part of
      // that chip, not a second token. Each refusal below now names its own
      // condition, content-free.
      const allTokens = Array.from(copy.querySelectorAll<HTMLElement>('[contenteditable="false"]'));
      const tokens = allTokens.filter(
        token => !token.parentElement?.closest('[contenteditable="false"]'),
      );
      // P-035 2026-10-03 G3-B (fifth run). Content-free shape of the FIRST
      // outermost token for the three token refusals. Read on the ORIGINAL
      // composer (own chip atoms excluded, as in the clone) so the ancestor
      // walk can reach the form; the clone's token is the fallback. Tags,
      // attribute names, the capped `TOKEN_SHAPE_VALUES`, one length and one
      // slug bit: never the token's text.
      const tokenNode = (element: Element): TokenNodeShape => {
        const values: Record<string, string | null> = {};
        for (const name of tokenShapeValues) {
          let value: string | null = null;
          try { value = element.getAttribute?.(name) ?? null; } catch { value = null; }
          values[name] = value === null ? null : value.slice(0, 80);
        }
        let attrs: string[] = [];
        try {
          attrs = Array.from(element.attributes ?? []).map(attribute => chrome(attribute.name) || "unknown").slice(0, 20);
        } catch { attrs = []; }
        return { tag: chrome(element.tagName ?? "") || "unknown", attrs, values };
      };
      const tokenShape = (fallback: HTMLElement): TokenShape => {
        const originalFirst = Array.from(composer.querySelectorAll<HTMLElement>('[contenteditable="false"]'))
          .filter(token => !token.parentElement?.closest('[contenteditable="false"]') && !ownChips.includes(token))[0];
        const token = originalFirst ?? fallback;
        const root = originalFirst ? composer : copy;
        const text = token.textContent ?? "";
        const parent = token.parentElement && token.parentElement !== root ? token.parentElement : null;
        const grandparent = parent?.parentElement && parent.parentElement !== root ? parent.parentElement : null;
        // Ancestors strictly inside the form; the clone's walk ends at its root.
        let pillAncestor = false;
        for (let element = token.parentElement; element && element !== form && !pillAncestor;
          element = element === copy ? null : element.parentElement) {
          try { pillAncestor = !!element.matches?.("[data-inline-selection-pill]"); } catch { /* unqueryable */ }
        }
        return {
          node: tokenNode(token),
          textLen: text.length,
          slug: /^[a-z0-9-]+$/.test(norm(text)),
          parent: parent ? tokenNode(parent) : null,
          grandparent: grandparent ? tokenNode(grandparent) : null,
          pillAncestor,
        };
      };
      // The diagnostic never changes the refusal: an unreadable shape returns the bare reason.
      const withTokenShape = (reason: string): string | PreflightDiagnostic => {
        try { return { reason, tokenShape: tokenShape(tokens[0]) }; } catch { return reason; }
      };
      let ownedToken: HTMLElement | undefined;
      if (tokens.length) {
        if (!owned.connector) return withTokenShape("connector_unowned");
        if (tokens.length !== 1) return withTokenShape(`connector_token_count:${tokens.length}`);
        if (tokens[0].textContent?.trim() !== owned.connector) return withTokenShape("connector_token_text");
        ownedToken = tokens[0];
        // Remove exactly the outermost element, with its nested content, so the
        // rich-node and text checks below judge only what remains.
        ownedToken.remove();
      }
      // Only familiar text formatting is admissible. Unrecognised rich nodes
      // (including empty mentions) fail closed even when their text is empty.
      //
      // P-035 2026-09-27. On this account's empty home composer the editor
      // renders its placeholder paragraph as `<p data-empty-paragraph="">` --
      // vendor UI chrome for an empty draft, not content. Live ms1980 (vendor
      // 858d698) then refused the same node's `data-placeholder`/`class`:
      // admitting attribute NAMES one live round at a time is the wrong rule.
      // A P with no text and only BR children cannot carry draft content,
      // whatever attributes it has, and the text/media/token/control checks
      // already run independently. So exempt exactly that shape from the
      // attribute refusal ENTIRELY: on a placeholder paragraph the attribute
      // loop is skipped, for all attributes at once. Any other tag, or a P
      // with any text or any non-BR child element, still gets the full check
      // and its `rich_attr:<a>|<b>` reason. The refusal names EVERY refused
      // attribute on the FIRST refusing node (de-duplicated, DOM attribute
      // order, at most 5, whole code capped at 200). Attribute names only,
      // never a value: still content-free.
      const placeholderParagraph = (element: Element): boolean =>
        element.tagName === "P"
        && (element.textContent ?? "").trim() === ""
        && Array.from(element.children).every(child => child.tagName === "BR");
      // P-035 2026-09-28 r31. Content-free shape of a `rich_attr` refusal. The
      // clone already had the owned token removed, so its trimmed text and word
      // count are what SURVIVED that removal; the token and inline-atom counts
      // come from the ORIGINAL composer, where the token is still present. Tag
      // names, counts, the sanitised `contenteditable` value and one
      // yes/no/n/a only: never page text, never any other attribute value.
      const richAttrShape = (node: Element): RichAttrShape => {
        const nodeText = node.textContent?.trim() ?? "";
        let contentEditable: string | null = null;
        try { contentEditable = node.getAttribute?.("contenteditable") ?? null; } catch { contentEditable = null; }
        const editable = contentEditable === null ? "" : chrome(contentEditable);
        const nodeChildren = Array.from(node.children ?? []);
        const copyText = (copy.textContent ?? "").trim();
        const originalTokens = Array.from(composer.querySelectorAll<HTMLElement>('[contenteditable="false"]'))
          .filter(token => !token.parentElement?.closest('[contenteditable="false"]')).length;
        const originalAtoms = Array.from(composer.querySelectorAll("*"))
          .filter(element => Array.from(element.attributes ?? [])
            .some(attribute => attribute.name.startsWith("data-composer-inline-atom"))).length;
        // Ancestors from the node up to the composer clone, the composer itself
        // included, so a node directly under the composer reads depth=1.
        let depth = 1;
        for (let element = node.parentElement; element && element !== copy; element = element.parentElement) {
          depth += 1;
        }
        return {
          tag: chrome(node.tagName ?? "") || "-",
          ce: editable || "-",
          textLen: nodeText.length,
          children: nodeChildren.length,
          childTags: nodeChildren.slice(0, 5).map(child => chrome(child.tagName ?? "") || "unknown").join(",") || "-",
          composerLen: copyText.length,
          composerWords: copyText.split(/\s+/).filter(Boolean).length,
          tokens: originalTokens,
          atoms: originalAtoms,
          equalsConnector: owned.connector === undefined ? "n/a" : nodeText === owned.connector ? "yes" : "no",
          depth,
        };
      };
      for (const child of Array.from(copy.querySelectorAll("*"))) {
        if (!/^(P|BR|SPAN|STRONG|EM|B|I|CODE|PRE|UL|OL|LI)$/.test(child.tagName)) return `rich_node:${chrome(child.tagName) || "unknown"}`;
        if (placeholderParagraph(child)) continue;
        const refusedAttributes: string[] = [];
        for (const attribute of Array.from(child.attributes)) {
          // P-035 2026-09-28 r24. ChatGPT tags each paragraph our automation
          // pasted with `data-prompt-literal-paste`, so a draft this call itself
          // introduced refused `rich_attr:data-prompt-literal-paste` before the
          // exact-text comparison below ever ran. Skip exactly that attribute
          // name ONLY while a combined exact-text proof is in force
          // (`owned.text !== undefined`, the same condition the token and Expand
          // branches use): the caller has then named the full owned draft, and
          // the text comparison still decides admission, so a foreign draft
          // beside it refuses exactly as before. Every other attribute on the
          // node -- and this attribute without an owned text -- refuse unchanged.
          // P-035 2026-09-28 r32. Our own `clearComposer` presses `Meta+A`
          // before `Backspace`, and the editor marks every selected node with
          // `data-composer-inline-atom-selected`. That attribute is TRANSIENT
          // SELECTION STATE this call's own keystroke created, not draft
          // content, so it refuses on the same terms as the r24 paste marker:
          // skipped only while a combined proof is in force (the text or the
          // provenance comparison still decides admission), and every other
          // attribute on the node -- and this attribute without an owned proof
          // -- refuses unchanged.
          if (combinedProof
            && (attribute.name === "data-prompt-literal-paste"
              || attribute.name === "data-composer-inline-atom-selected")) continue;
          if (!/^(data-|contenteditable|role|aria-|hidden|style)/.test(attribute.name)) continue;
          const name = chrome(attribute.name) || "unknown";
          if (refusedAttributes.length < 5 && !refusedAttributes.includes(name)) refusedAttributes.push(name);
        }
        if (refusedAttributes.length > 0) {
          // The reason string is unchanged and admission is unchanged; only the
          // refusal now carries the content-free shape of the refusing node.
          return {
            reason: `rich_attr:${refusedAttributes.join("|")}`.slice(0, 200),
            richAttrShape: richAttrShape(child),
          };
        }
      }
      let text = composer instanceof HTMLTextAreaElement ? composer.value : composer.innerText;
      // G3-B: strip each own chip's label once per chip rendered in the
      // composer, so the chip alone reads as an empty composer. Text beside it
      // still decides admission exactly as before. A pill strips its own text.
      for (const chip of ownChips) {
        const label = composer.contains(chip) ? ownChipText(chip) : null;
        if (label) text = text.replace(label, "");
      }
      // The token branch above already proved exactly one outermost token
      // carrying the owned connector's own trimmed text; what remains decides
      // admission.
      let textAdmitted = false;
      // P-035 2026-09-28 r34. A DISTINCT flag for exactly the r33 lone-`@`
      // admission, set in both branches below and nowhere else. The foreign-text
      // walk needs it to admit the editor's hidden mirror of that same `@`
      // without reusing any broader flag: an empty chip remainder and an owned
      // token plus text leave it false, so those paths are unchanged.
      let loneAtAdmitted = false;
      if (ownedToken) {
        if (owned.provenance !== undefined) {
          // P-035 2026-09-28 r26. Provenance mode: the draft this facade
          // composed is proven by its own shape, never by its text. Remove the
          // token's rendered text exactly as the exact-text branch does, then
          // require ALL THREE on the normalised remainder: it starts with the
          // normalised planning header, it carries the hidden invocation marker
          // as a literal substring, and it carries one `invocation_id="<uuid>"`.
          // The header alone is shared by every planning request, so the marker
          // and the invocation id are what make this draft ours; the remainder
          // may hold a different request after the header and still admit.
          // `provenance` and `text` are mutually exclusive, and this branch is
          // only reachable with an owned token: without one, text refuses
          // exactly as before.
          const tokenName = ownedToken.textContent?.trim() ?? "";
          const remainder = norm(text.replace(tokenName, ""));
          const prefixOk = remainder.startsWith(norm(owned.provenance.prefix));
          const markerOk = remainder.includes(owned.provenance.marker);
          const invocationOk = /invocation_id="[0-9a-f-]{36}"/.test(remainder);
          if (!(prefixOk && markerOk && invocationOk)) {
            return {
              reason: "provenance_mismatch",
              provenanceShape: { prefix: prefixOk, marker: markerOk, invocation: invocationOk, len: remainder.length },
            };
          }
          textAdmitted = true;
        } else if (owned.text !== undefined) {
          // P-035 2026-09-27. Combined ownership: a connector turn places the
          // owned token AND this call's prompt in one inline flow, so neither
          // half alone can prove the draft. Remove the token's own rendered
          // text from the composer read and compare what is left to the owned
          // text, normalising whitespace on both sides (r25). An extra draft
          // beside the prompt, a different prompt, or a token name that is not
          // the one removed first changes the remainder and refuses.
          const tokenName = ownedToken.textContent?.trim() ?? "";
          const remainder = text.replace(tokenName, "");
          // P-035 2026-09-28 r25. Was `remainder.trim() !== owned.text`, a
          // whitespace-strict comparison: the live 908-char multi-line prompt
          // rendered as `innerText` never matched its own source newlines, so an
          // exact owned draft was refused. Compare with whitespace normalised on
          // BOTH sides instead; every non-whitespace character still decides.
          const have = norm(remainder);
          const want = norm(owned.text);
          if (have !== want) {
            return {
              reason: "owned_text_mismatch",
              ownedTextShape: { haveLen: have.length, wantLen: want.length, commonPrefix: commonPrefixLength(have, want) },
            };
          }
          textAdmitted = true;
        } else {
          // A sole owned connector token is admissible, not arbitrary text that
          // happens to contain the connector name. Text beside the chip is a
          // draft like any other, so it refuses with the plain text code.
          //
          // P-035 2026-09-28 r16. Live ms1980 (vendor f74220e): the composer held
          // ONLY this call's own connector chip, and this branch still refused
          // `text_present`. The old rule compared the composer's RENDERED
          // `innerText` to the connector string, but the chip's own textContent
          // already equals that connector exactly, so anything the editor renders
          // beyond it -- an invisible character such as U+200B, or chip chrome the
          // clone does not carry -- made the comparison fail on a chip-only
          // composer. Judge this branch the way an empty composer is judged
          // instead: by the detached copy AFTER the owned token was removed.
          // Whitespace and Unicode format characters (`\p{Cf}`, e.g. U+200B,
          // U+200C, U+200D, U+2060, U+FEFF) carry no draft content, so a
          // remainder of only those is the same as an empty composer.
          const remainder = copy.textContent ?? "";
          const stripped = remainder.replace(/[\s\p{Cf}]/gu, "");
          // P-035 2026-09-28 r33. A lone `@` is the residue a FAILED connector
          // click leaves in the composer (r33 in `setConnector`): our own code
          // typed it, it carries no user content, and a later guard's plain
          // `text_present` refusal would restart the lane every tick. Admit it
          // -- but ONLY while a lane connector identity is in force
          // (`owned.connector`, the same identity the r15/r20 chip residue uses)
          // and only when NOTHING else survives after whitespace and `\p{Cf}`
          // are removed. Without that identity, or with any other character, the
          // refusal below is exactly as before.
          //
          // P-035 2026-09-28 r34. Name that lone-`@` admission as its own flag
          // (`loneAtAdmitted`) so the foreign-text walk can admit the hidden
          // mirror of the same `@`; the empty-remainder admission below leaves
          // the flag false, so nothing else changes.
          const loneAt = owned.connector !== undefined && stripped === "@";
          if (stripped.length > 0 && !loneAt) {
            // Content-free shape of the refused remainder: how many of its code
            // points are whitespace, `\p{Cf}`, or anything else. Counts only,
            // never a character or any text.
            let ws = 0;
            let cf = 0;
            let other = 0;
            for (const codePoint of remainder) {
              if (/\p{Cf}/u.test(codePoint)) cf += 1;
              else if (/\s/.test(codePoint)) ws += 1;
              else other += 1;
            }
            return { reason: "text_present", chipRemainder: { len: ws + cf + other, ws, cf, other } };
          }
          text = "";
          textAdmitted = true;
          if (loneAt) loneAtAdmitted = true;
        }
      }
      if (!textAdmitted) {
        if (owned.text !== undefined) {
          // P-035 2026-09-28 r25. Was `text !== owned.text`, the same
          // whitespace-strict rule as the combined branch above, so a
          // multi-line prompt could never match here either. Normalise
          // whitespace on both sides; every non-whitespace character still
          // decides.
          const have = norm(text);
          const want = norm(owned.text);
          if (have !== want) {
            return {
              reason: "owned_text_mismatch",
              ownedTextShape: { haveLen: have.length, wantLen: want.length, commonPrefix: commonPrefixLength(have, want) },
            };
          }
        } else {
          // P-035 2026-09-28 r33. Same residue rule as the token-else branch
          // above, for a composer with NO owned token: a lone `@` our own failed
          // connector click typed is admitted while a lane connector identity is
          // in force, and refused exactly as before otherwise. The refusal now
          // carries ONE content-free shape line -- counts of the remainder's
          // whitespace, `\p{Cf}`, `@` and everything else, never a character --
          // so a live round names whether the leftover was really our `@`.
          const remainder = copy.textContent ?? "";
          const stripped = remainder.replace(/[\s\p{Cf}]/gu, "");
          if (owned.connector !== undefined && stripped === "@") {
            textAdmitted = true;
            // P-035 2026-09-28 r34. Same distinct flag as the token branch
            // above: this is the no-token lone-`@` admission r33 added.
            loneAtAdmitted = true;
          } else {
            const noTokenShape = (value: string): { len: number; ws: number; cf: number; at: number; other: number } => {
              let ws = 0;
              let cf = 0;
              let at = 0;
              let other = 0;
              for (const codePoint of value) {
                if (codePoint === "@") at += 1;
                else if (/\p{Cf}/u.test(codePoint)) cf += 1;
                else if (/\s/.test(codePoint)) ws += 1;
                else other += 1;
              }
              return { len: ws + cf + at + other, ws, cf, at, other };
            };
            // P-035 2026-10-03 G3-B. Live intelli (built ca3fb0f): the home
            // composer held only the native "Deep research" chip, its atom was
            // removed from the clone above, and this branch still refused:
            //   [cgpro:preflight] no-token text shape: len=1 ws=1 cf=0 at=0 other=0
            // The one whitespace is what the editor keeps beside an inline atom.
            // Treat the remainder as empty ONLY when at least one own chip atom
            // was removed, the remainder is nothing but whitespace or `\p{Cf}`
            // (no `@`, nothing else), the rendered text is empty after the label
            // strip, and the composer is not a textarea. Any other remainder, and
            // every composer without an own chip, refuses exactly as before.
            const chipWhitespaceOnly = removedOwnChipAtoms > 0
              && !(composer instanceof HTMLTextAreaElement)
              && stripped.length === 0
              && text.trim() === "";
            if (text.trim() || (remainder.length > 0 && !chipWhitespaceOnly)) {
              return { reason: "text_present", noTokenShape: noTokenShape(remainder) };
            }
            if (composer instanceof HTMLTextAreaElement && text.length > 0) {
              return { reason: "text_present", noTokenShape: noTokenShape(remainder) };
            }
          }
        }
      }
      // Non-control text outside the editable region may be a rich draft chip.
      //
      // P-035 2026-09-28 r17. This is the one refusal that named no node: live
      // ms1980 refused `foreign_text` on a composer whose only visible content
      // was this call's own chip, so the refusing text node is probably UI
      // chrome (a hidden mirror, tooltip or live region) rather than a draft.
      // The reason stays `foreign_text` and admission is unchanged; only the
      // refusal now carries a content-free shape of that node -- parent tag,
      // sanitised role, the nearest sanitised `data-testid` within the form,
      // why it is hidden, the trimmed text length, and whether that text is the
      // owned connector. Never the text, never any other attribute value.
      const inForm = (element: Element | null): boolean =>
        !!element && (element === form || form.contains(element));
      const foreignShape = (node: Node): ForeignTextShape => {
        const parent = node.parentElement;
        const text = node.textContent?.trim() ?? "";
        // Ancestors WITHIN the form only: the walk is over `form`, so the scan
        // stops at the form element instead of escaping it.
        const chain: Element[] = [];
        for (let element = parent; inForm(element); element = element?.parentElement ?? null) {
          chain.push(element as Element);
          if (element === form) break;
        }
        const hidden = chain.some(element => element.getAttribute("aria-hidden") === "true") ? "aria"
          : chain.some(element => element.hasAttribute("hidden")) ? "attr"
            : parent && parent.getClientRects().length === 0 ? "layout"
              : "no";
        const testid = chain
          .map(element => chrome(element.getAttribute("data-testid") ?? ""))
          .find(candidate => candidate.length > 0) ?? "";
        // P-035 2026-09-28 r18. Placeholder attribute values live on the live
        // composer itself or on a descendant (the editor's placeholder
        // paragraph, say). Attribute VALUES are only ever compared with the
        // trimmed text, never logged.
        const placeholderValues: string[] = [];
        const readPlaceholder = (element: Element | null): void => {
          if (!element) return;
          for (const name of ["data-placeholder", "placeholder"]) {
            let value: string | null | undefined;
            try { value = element.getAttribute?.(name); } catch { value = null; }
            if (value != null) placeholderValues.push(value.trim());
          }
        };
        readPlaceholder(composer);
        try {
          for (const descendant of Array.from(composer.querySelectorAll?.("*") ?? [])) {
            readPlaceholder(descendant);
          }
        } catch { /* not a DOM element */ }
        const composerText = ((composer instanceof HTMLTextAreaElement
          ? composer.value : composer.innerText) ?? "").trim();
        // P-035 2026-09-28 r28. Which part of the in-force proof this refused
        // node agrees with, judged the way the r27 mirror rule judges it: on the
        // unescaped, normalised text for the prefix and the exact owned text, and
        // on the unescaped text for the literal marker. `n/a` when that proof is
        // not in force. Booleans only, never any character of the node.
        const unescaped = unescape(text);
        const mirror = norm(unescaped);
        // P-035 2026-09-28 r29. Where the normalised planning header sits in the
        // normalised mirror, how far it agrees, and the class of the first
        // position where it stops agreeing -- all six fields `n/a` without a
        // provenance proof. Content-free by construction: indexes, counts and
        // character CLASSES only, never a character of the page.
        let headerAt = "n/a";
        let headerRun = "n/a";
        let haveChar = "n/a";
        let wantChar = "n/a";
        let alnumContains = "n/a";
        let alnumHeaderAt = "n/a";
        if (owned.provenance !== undefined) {
          const proof = norm(owned.provenance.prefix);
          const at = mirror.indexOf(proof.slice(0, 40));
          headerAt = String(at);
          if (at === -1) {
            // The header's leading 40 characters are absent from the mirror, so
            // no aligned run exists to classify.
            headerRun = "0";
          } else {
            const mirrorTail = Array.from(mirror.slice(at));
            const proofChars = Array.from(proof);
            let run = 0;
            while (run < mirrorTail.length && run < proofChars.length
              && mirrorTail[run] === proofChars[run]) run += 1;
            headerRun = String(run);
            haveChar = charClass(mirrorTail[run]);
            wantChar = charClass(proofChars[run]);
          }
          // The same question with every non-letter and non-digit removed, so a
          // punctuation-only divergence (Markdown `-` rendered as `*`, say)
          // still reports the header as present in words. The helper is hoisted
          // to the evaluation scope (r30) and shared with the mirror rule.
          const mirrorAlnum = reduceAlnum(mirror);
          const proofAlnum = reduceAlnum(proof);
          alnumContains = mirrorAlnum.includes(proofAlnum) ? "yes" : "no";
          alnumHeaderAt = String(mirrorAlnum.indexOf(proofAlnum.slice(0, 40)));
        }
        // Parent-first tag names of the ancestor chain, form included, capped
        // at 8. Tags only: no attribute value and no descendant text.
        const path = chain.slice(0, 8).map(element => chrome(element.tagName ?? "")).join("<");
        // How many elements on that chain carry an `aria-label`: a count only,
        // never the value.
        const labels = chain.filter(element => {
          try { return element.getAttribute?.("aria-label") != null; } catch { return false; }
        }).length;
        return {
          tag: (parent && chrome(parent.tagName)) || "-",
          role: (parent && chrome(parent.getAttribute("role") ?? "")) || "-",
          testid: testid || "-",
          hidden,
          len: text.length,
          equalsConnector: owned.connector === undefined
            ? "n/a" : text === owned.connector ? "yes" : "no",
          containsConnector: owned.connector === undefined
            ? "n/a" : text.includes(owned.connector) ? "yes" : "no",
          containsPrefix: owned.provenance === undefined
            ? "n/a" : mirror.includes(norm(owned.provenance.prefix)) ? "yes" : "no",
          containsMarker: owned.provenance === undefined
            ? "n/a" : unescaped.includes(owned.provenance.marker) ? "yes" : "no",
          containsText: owned.text === undefined
            ? "n/a" : mirror.includes(norm(owned.text)) ? "yes" : "no",
          headerAt,
          headerRun,
          haveChar,
          wantChar,
          alnumContains,
          alnumHeaderAt,
          equalsPlaceholder: placeholderValues.length === 0
            ? "none" : placeholderValues.includes(text) ? "yes" : "no",
          equalsComposerText: text === composerText ? "yes" : "no",
          words: text.split(/\s+/).filter(Boolean).length,
          path: path || "-",
          labels,
        };
      };
      // P-035 2026-09-28 r19. Live ms1980 refused `foreign_text` (shape:
      // `tag=SPAN role=- testid=- hidden=aria len=84 equals_connector=no
      // contains_connector=yes equals_placeholder=none equals_composer_text=no
      // words=1 path=SPAN<FORM labels=0`) on a composer already proven to hold
      // only this call's own chip, and only while the chip was present. That
      // span is a hidden, whitespace-free serialisation mirroring the chip (an
      // aria-hidden live region or tooltip), not a draft: a draft is visible and
      // carries its own words. Admit exactly that shape -- a hidden single token
      // that contains the owned connector AND was only reachable because this
      // call's own token was admitted above. Every other node still refuses
      // exactly as before: visible text, hidden text without the owned
      // connector, hidden text with whitespace, and any such node when no owned
      // token was admitted (the `n/a` path).
      const hiddenByAria = (node: Node): boolean => {
        for (let element = node.parentElement; inForm(element); element = element?.parentElement ?? null) {
          const current = element as Element;
          if (current.getAttribute("aria-hidden") === "true") return true;
          if (current === form) break;
        }
        return false;
      };
      const walker = document.createTreeWalker(form, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const nodeText = node.textContent?.trim() ?? "";
        if (!nodeText || composer.contains(node)) continue;
        const parent = node.parentElement;
        if (parent?.closest('button, [role="button"], [role="menu"], [role="listbox"]')) continue;
        // G3-B: the beacon banner's heading and line are chrome (see above).
        if (beaconBanners.some(banner => banner.contains(node))) continue;
        if (ownedToken && owned.connector && hiddenByAria(node)
          && !/\s/.test(nodeText) && nodeText.includes(owned.connector)) continue;
        // P-035 2026-09-28 r27. Live ms1980 (vendor bad524b) passed chip
        // identity and the provenance proof, then refused `foreign_text` (shape:
        // `tag=SPAN hidden=aria len=3141 contains_connector=yes words=435
        // path=SPAN<FORM`): with a TEXT draft the same hidden composer mirror
        // r19 admits only as a whitespace-free single token carries the WHOLE
        // serialised draft instead. Admit that node only while it provably
        // MIRRORS the content already proven in this call: this call's own token
        // was admitted, the node is hidden by aria, its normalised text carries
        // the owned connector, and it also carries the owned proof -- the whole
        // owned text under an exact-text proof, or the planning header plus the
        // literal invocation marker under a provenance proof. Without an owned
        // text or provenance this rule never applies, so r19 and every other
        // refusal are unchanged.
        if (ownedToken && owned.connector && hiddenByAria(node)) {
          // r28: the mirror is a Markdown/HTML serialisation, so it is unescaped
          // first. The connector, the exact owned text and the planning header
          // are compared on the unescaped, normalised mirror; the literal marker
          // is compared on the unescaped mirror (its own spacing is part of the
          // marker, never normalised away). Nothing else changes: this still
          // needs an admitted owned token and an owned proof.
          //
          // P-035 2026-09-28 r30. Live evidence 05:45 (vendor 9b08542, Intelli
          // pid 86290): the visible composer passed the full provenance proof,
          // yet the hidden mirror still refused `foreign_text` with
          // `contains_prefix=no ... alnum_contains=yes alnum_header_at=71` --
          // the header's letters and digits are all present, contiguous and in
          // order, only its punctuation and whitespace differ (the Markdown list
          // `-` serialised as `*`, paragraph breaks collapsed). So under a
          // provenance proof the header condition is the literal match OR the
          // letters-and-digits match: the same letters and digits, in order,
          // ignoring every separator and case. The 40-character floor keeps the
          // relaxed match meaningful -- a shorter prefix is not a proof that a
          // full header mirrored. Every other requirement is unchanged: the
          // owned connector, the literal marker and the aria-hidden ancestor.
          const unescaped = unescape(nodeText);
          const mirror = norm(unescaped);
          const mirrorsOwned = owned.text !== undefined
            ? mirror.includes(norm(owned.text))
            : owned.provenance !== undefined
              && (mirror.includes(norm(owned.provenance.prefix))
                || (reduceAlnum(owned.provenance.prefix).length >= 40
                  && reduceAlnum(mirror).includes(reduceAlnum(owned.provenance.prefix))))
              && unescaped.includes(owned.provenance.marker);
          if (mirror.includes(owned.connector) && mirrorsOwned) continue;
        }
        // P-035 2026-09-28 r34. Live 06:59 (vendor 90f7c9d): r33 admitted the
        // composer's lone `@`, then this walk refused `foreign_text` on the
        // editor's own hidden mirror of that same `@` (shape: `tag=SPAN
        // hidden=aria len=1 equals_connector=no contains_connector=no
        // equals_composer_text=yes words=1 path=SPAN<FORM`). Both mirror rules
        // above need an admitted owned token, which a lone `@` does not have, so
        // neither can admit it. Admit exactly that node here, and ONLY while
        // this call's own lone `@` was admitted above (`loneAtAdmitted`): the
        // node must still be hidden by aria, and its text stripped of whitespace
        // and `\p{Cf}` must be exactly `@`, or -- only when an owned token was
        // admitted, the chip+`@` shape -- exactly the owned connector with
        // whitespace removed, preceded or followed by `@`. Everything else
        // (visible, `@x`, a different token's name, or any node when
        // `loneAtAdmitted` is false) refuses exactly as today.
        if (loneAtAdmitted && hiddenByAria(node)) {
          const stripped = nodeText.replace(/[\s\p{Cf}]/gu, "");
          const connector = (owned.connector ?? "").replace(/\s+/gu, "");
          if (stripped === "@"
            || (ownedToken && connector.length > 0
              && (stripped === `${connector}@` || stripped === `@${connector}`))) continue;
        }
        return { reason: "foreign_text", foreignShape: foreignShape(node) };
      }
      return true;
    }, {
      selector: joinSelectors(SELECTORS.composer), chromeSelectors: PREFLIGHT_CHROME, owned,
      tokenShapeValues: TOKEN_SHAPE_VALUES,
    });
    if (outcome === true) safe = true;
    else if (typeof outcome === "string") reason = outcome;
    else if (typeof outcome === "object" && "reason" in outcome) {
      // P-035 2026-09-28 r16. The sole-owned-token text refusal carries the
      // content-free shape of the chip's remainder, so a live round names which
      // class the extra code points were without ever naming a character.
      reason = outcome.reason;
      if (outcome.chipRemainder) {
        const { len, ws, cf, other } = outcome.chipRemainder;
        console.error(`[cgpro:preflight] chip remainder shape: len=${len} ws=${ws} cf=${cf} other=${other}`);
      }
      // P-035 2026-09-28 r33. Exactly one content-free shape line for the
      // no-token `text_present` refusal, so a live round names whether the
      // leftover was our own `@` (at=1, other=0) or real user text beside it.
      // Counts only, in the same code-point classes the chip remainder uses,
      // with `@` counted on its own: never a character.
      if (outcome.noTokenShape) {
        const { len, ws, cf, at, other } = outcome.noTokenShape;
        console.error(`[cgpro:preflight] no-token text shape: len=${len} ws=${ws} cf=${cf} at=${at} other=${other}`);
      }
      // P-035 2026-10-03 G3-B (fifth run). Exactly one content-free shape line
      // for the token refusals (`connector_token_text`, `connector_unowned`,
      // `connector_token_count:*`): where the pill attributes sit on or above
      // the first outermost token. Never the token's text.
      if (outcome.tokenShape) {
        const { node, textLen, slug, parent, grandparent, pillAncestor } = outcome.tokenShape;
        console.error(
          `[cgpro:preflight] token shape: ${formatTokenNode(node)} text_len=${textLen} slug=${slug ? "yes" : "no"} `
          + `parent=[${formatTokenNode(parent)}] grandparent=[${formatTokenNode(grandparent)}] `
          + `pill_ancestor=${pillAncestor ? "yes" : "no"}`,
        );
      }
      // P-035 2026-10-03 G3-B (fifth run). One content-free line per matching
      // frame (at most 3) for `directory_forbidden_node:embed`.
      if (outcome.embedShape) {
        const { count, frames } = outcome.embedShape;
        const quoted = (value: string | null): string => value === null ? "-" : JSON.stringify(value);
        frames.forEach((frame, index) => {
          console.error(
            `[cgpro:preflight] directory embed shape: index=${index + 1} count=${count} tag=${frame.tag} `
            + `src=${frame.src} width=${frame.width} height=${frame.height} display=${frame.display} `
            + `visibility=${frame.visibility} aria_hidden=${quoted(frame.ariaHidden)} `
            + `tabindex=${quoted(frame.tabindex)} id=${quoted(frame.id)} name=${quoted(frame.name)}`,
          );
        });
      }
      // P-035 2026-09-28 r17. Exactly one content-free shape line for the
      // foreign-text refusal, so the next live round names the node class. It
      // carries no text and no attribute value beyond the sanitised role and
      // testid.
      //
      // P-035 2026-09-28 r18. Six more content-free features appended to the
      // SAME single line, so one live round decides whether the span is UI
      // chrome (a chip placeholder/hint) or a mirror of draft text: whether the
      // text contains the owned connector, whether it equals any composer
      // placeholder value, whether it equals the composer's own text, its word
      // count, the parent-first tag path to the form, and how many elements on
      // that path carry an `aria-label`. Admission and the reason stay exactly
      // as before.
      if (outcome.foreignShape) {
        const {
          tag, role, testid, hidden, len, equalsConnector, containsConnector,
          containsPrefix, containsMarker, containsText,
          headerAt, headerRun, haveChar, wantChar, alnumContains, alnumHeaderAt,
          equalsPlaceholder, equalsComposerText, words, path, labels,
        } = outcome.foreignShape;
        console.error(
          `[cgpro:preflight] foreign text shape: tag=${tag} role=${role} testid=${testid} `
          + `hidden=${hidden} len=${len} equals_connector=${equalsConnector} `
          + `contains_connector=${containsConnector} equals_placeholder=${equalsPlaceholder} `
          + `equals_composer_text=${equalsComposerText} words=${words} path=${path} labels=${labels} `
          + `contains_prefix=${containsPrefix} contains_marker=${containsMarker} contains_text=${containsText} `
          + `header_at=${headerAt} header_run=${headerRun} have_char=${haveChar} want_char=${wantChar} `
          + `alnum_contains=${alnumContains} alnum_header_at=${alnumHeaderAt}`,
        );
      }
      // P-035 2026-09-28 r25. Exactly one content-free shape line for the
      // owned-text refusal, so a live round names how far the composer's text
      // agreed with the owned text: the two normalised lengths and the length
      // of their longest common prefix. Counts only, never any text.
      if (outcome.ownedTextShape) {
        const { haveLen, wantLen, commonPrefix } = outcome.ownedTextShape;
        console.error(
          `[cgpro:preflight] owned text shape: have_len=${haveLen} want_len=${wantLen} common_prefix=${commonPrefix}`,
        );
      }
      // P-035 2026-09-28 r26. Exactly one content-free shape line for the
      // provenance refusal, so one live round names which of the three
      // conditions failed without naming any character of the draft. The
      // booleans are `yes`/`no`; `len` is the normalised remainder length.
      if (outcome.provenanceShape) {
        const { prefix, marker, invocation, len } = outcome.provenanceShape;
        console.error(
          `[cgpro:preflight] provenance shape: prefix=${prefix ? "yes" : "no"} `
          + `marker=${marker ? "yes" : "no"} invocation=${invocation ? "yes" : "no"} len=${len}`,
        );
      }
      // P-035 2026-09-28 r31. Exactly one content-free shape line for the
      // rich-attribute refusal, so one live round names what survived the clear
      // without a character of page text: tag names, counts, the sanitised
      // `contenteditable` value and one yes/no/n/a only.
      if (outcome.richAttrShape) {
        const {
          tag, ce, textLen, children, childTags, composerLen, composerWords, tokens, atoms, equalsConnector, depth,
        } = outcome.richAttrShape;
        console.error(
          `[cgpro:preflight] rich attr shape: tag=${tag} ce=${ce} text_len=${textLen} `
          + `children=${children} child_tags=${childTags} composer_len=${composerLen} `
          + `composer_words=${composerWords} tokens=${tokens} atoms=${atoms} `
          + `equals_connector=${equalsConnector} depth=${depth}`,
        );
      }
    }
  } catch { /* Evaluation failure is unknown, never empty. */ }
  if (safe !== true) {
    // Exactly one content-free line per refusal. No branch answered means the
    // evaluation itself failed, which is unknown, never empty: still a refusal.
    if (reason === null) reason = "evaluation_failed";
    console.error(`[cgpro:preflight] draft guard refused: reason=${reason}`);
    throw new PreflightDraftProtectedError(reason);
  }
}

export async function clearComposer(page: Page, guard?: () => Promise<void>): Promise<void> {
  await guard?.();
  const composer = await requireSelector(page, SELECTORS.composer, "composer");
  await composer.click();
  await guard?.();
  await page.keyboard.press("Meta+A");
  await guard?.();
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
  ownedConnector?: string,
  /**
   * P-035 G3 r38 (2026-09-28). Optional output slot for the pre-submit
   * `SELECTORS.anyMessages` count, captured next to `priorAssistantCount` below.
   * `waitTurnComplete` needs it to tell "the user's own message never rendered"
   * from "only the assistant turn is missing". Left untouched on the early
   * returns, so a caller that reads it after a cancelled call sees `undefined`
   * and its own unknown-prior path (the rule stays off).
   */
  submitCounts?: { priorAnyMessages?: number },
): Promise<number> {
  const assistantCount = async (): Promise<number> => page
    .locator(SELECTORS.assistantMessages.join(", "))
    .count()
    .catch(() => 0);
  const anyMessageCount = async (): Promise<number> => page
    .locator(SELECTORS.anyMessages.join(", "))
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
  // P-035 G3 r38. Captured next to the assistant count, before the send: the
  // not-rendered rule compares the live anyMessages count against this to prove
  // the submitted turn (the user's own message included) never rendered.
  if (submitCounts) submitCounts.priorAnyMessages = await anyMessageCount();
  if (cancelled?.()) return priorAssistantCount;

  // Typing may change inline modes. Verify the composed request, not just
  // the empty composer, and let failures stop both click and Enter submission.
  //
  // A pre-submit refusal here (the Pro usage limit is the live one) fires
  // AFTER the prompt is already in the composer. ChatGPT persists that draft
  // across a lane restart, and the next preflight then refuses it as an
  // unowned draft and wedges the lane until a human clears it. So this call
  // removes what it itself inserted, and only while ownership is still
  // provable here in the same call. The refusal itself is re-thrown
  // unchanged: this is cleanup, not a different outcome.
  try {
    await verifySubmission?.();
  } catch (error) {
    if (error instanceof PreSubmitInteractionError) {
      await discardOwnedPresubmitDraft(page, composer, prompt, preserveExisting, ownedConnector);
    }
    throw error;
  }
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
 * Remove the draft THIS call inserted, immediately after a pre-submit refusal.
 *
 * P-035 2026-09-27. The model check runs after the insert on purpose (see the
 * comment at its call site), so its refusal leaves the prompt sitting in the
 * composer. ChatGPT keeps that draft across a lane restart, and the next
 * preflight then refuses it as an unowned draft (`reason=unknown_control:...`,
 * the restored prompt in the capture): the lane is stuck until a human clears
 * it. Clearing it here, in the same call that typed it, is the only point at
 * which ownership is provable.
 *
 * Ownership is proven by `assertPreflightDraftSafe`, which admits only when
 * the composer holds exactly this call's owned content. On a non-preserving
 * turn the spec is the prompt alone. On a connector turn `preserveExisting` is
 * true because the connector mention placed by this same invocation lives
 * inside the composer; when the caller also names that connector, the spec is
 * the COMBINED `{ connector, text: prompt }` shape -- the owned token followed
 * by the prompt and nothing else. Anything else -- different text, a different
 * token, an extra node, an evaluation failure, a connector turn whose
 * connector was not passed -- is not proven ours and the composer is left
 * untouched. The refusal is the caller's to re-throw; nothing here may replace
 * or mask it.
 *
 * Exactly one content-free line is logged, and it never carries page or
 * prompt text.
 */
async function discardOwnedPresubmitDraft(
  page: Page, composer: Locator, prompt: string, preserveExisting: boolean, ownedConnector?: string,
): Promise<void> {
  try {
    // A preserving turn with no owned connector cannot prove ownership from
    // the prompt alone: the pre-existing content may be someone else's draft.
    // Only the connector form of a preserving turn is provable, below.
    if (preserveExisting && ownedConnector === undefined) {
      console.error("[cgpro:presubmit] owned draft cleared=no reason=preserve_existing");
      return;
    }
    let owned = false;
    try {
      // Admissible only as exactly what this call inserted: the prompt alone,
      // or the owned connector token followed by the prompt. A refusal here is
      // "not ours", never a reason to clear anything.
      await assertPreflightDraftSafe(
        page,
        preserveExisting ? { connector: ownedConnector, text: prompt } : { text: prompt },
      );
      owned = true;
    } catch {
      owned = false;
    }
    if (!owned) {
      console.error("[cgpro:presubmit] owned draft cleared=no reason=not_owned");
      return;
    }
    // Playwright's own keyboard, scoped to the composer this call focused:
    // select the whole draft, then delete it.
    await composer.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Delete");
    const remaining = await readComposer(page, composer);
    if (remaining === null || remaining.length > 0) {
      console.error("[cgpro:presubmit] owned draft cleared=no reason=clear_failed");
      return;
    }
    console.error("[cgpro:presubmit] owned draft cleared=yes reason=owned");
  } catch {
    // Cleanup must never mask the refusal it is repairing. No composer state
    // is read or reported beyond the content-free outcome.
    console.error("[cgpro:presubmit] owned draft cleared=no reason=clear_failed");
  }
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
  if (force !== "typed") {
    if (process.env.CGPRO_SKIP_COMPOSER_PASTE === "1" && force !== "paste") {
      await insertLines(page, text.split("\n"));
      return "typed";
    }
    const composer = page.locator(joinSelectors(SELECTORS.composer)).first();
    const before = await composerTextLength(composer);
    if ((await pasteComposerText(page, text)) || (await pasteLandedLate(page, before))) {
      return "paste";
    }
    if (force === "paste") {
      throw new PreSubmitInteractionError(
        "prompt_delivery_incomplete",
        "prompt_delivery",
        "forced paste delivery failed or was unconfirmed",
      );
    }
  }
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
        `[cgpro:composer] paste delivery could not be dispatched (${error instanceof Error ? error.message : String(error)})`,
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
  ownedConnector?: string,
): Promise<PromptDeliveryProbe> {
  const composer = await requireSelector(page, SELECTORS.composer, "composer");
  const guard = ownedConnector === undefined ? undefined : () => assertPreflightDraftSafe(page, { connector: ownedConnector });
  await guard?.();
  await composer.click();
  await page.waitForTimeout(120);
  await clearComposer(page, guard);
  if (guard) await assertPreflightDraftSafe(page);
  await focusComposerEnd(page, composer);
  if (guard) await assertPreflightDraftSafe(page);
  let failed = false;
  try {
    const deliveredBy = await insertComposerText(page, prompt, force);

    if (guard) await assertPreflightDraftSafe(page, { text: prompt });
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
    return probe;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await clearComposer(page, guard ? () => assertPreflightDraftSafe(page, { text: prompt }) : undefined);
      const residue = await readComposer(page, composer);
      if (residue === null || residue.trim().length > 0) {
        throw new Error("probe cleanup unverified");
      }
    } catch (error) {
      if (error instanceof PreflightDraftProtectedError) throw error;
      // Keep the typed delivery failure and never put composer contents into
      // an error. The orchestrator's existing cleanup still guards this lane.
      if (failed) console.warn("[cgpro:composer] probe cleanup unverified after delivery failure");
      else throw new Error("prompt delivery probe could not clear the composer");
    }
  }
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
let lastInsert = { lines: 0, requested: 0, chars: 0 };

async function insertLines(page: Page, lines: string[]): Promise<void> {
  lastInsert = { lines: lines.length, requested: 0, chars: 0 };
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
      if (!(await pasteComposerText(page, line) || await pasteLandedLate(page, before))) {
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
 * P-035 G2 r22 (2026-09-28). Content-free heartbeat for the silent turn wait.
 *
 * Live ms1980 (vendor 1dbb6bf): a routed acceptance (invocation 5f46e486)
 * passed preflight, connector selection and `prompt_submitted`, then produced
 * `connector_tool_count 0` and `response_bytes 0` for 3000 s until the client
 * cancelled it. The daemon log showed nothing after submission: this loop
 * waits silently, so a page error, a limit screen and an endless thinking
 * state are indistinguishable from outside. One bounded diagnostic line per
 * minute makes the next turn readable without another paid probe.
 *
 * Still observation only where the page is concerned: it never admits, refuses,
 * navigates, reloads, cancels or extends the wait, and every read the page
 * cannot answer is swallowed, so such a page leaves the pre-existing behaviour
 * exactly as it was. The printed line never carries page text, an attribute
 * value, a conversation id or a URL -- only counts and yes/no flags. G3 r37
 * added one refusal built ON these observations (the post-submit Pro limit,
 * below); the alert text travels only on that typed error.
 */
const TURN_HEARTBEAT_INTERVAL_MS = 60_000;
const TURN_ALERT_SELECTOR = '[role="alert"], [role="status"], [data-testid*="toast"]';
const TURN_ERROR_HINT_RE = /something went wrong|error|network|try again|regenerate/i;
const TURN_LIMIT_HINT_RE = /limit|usage|reached|upgrade|try again after/i;
/**
 * P-035 G3 r37 (2026-09-28). The limit spells itself in its own words, and the
 * loose hint above is far too wide to act on: `usage` alone matches a healthy
 * "4% usage remaining" counter. These are the phrases the limit screen actually
 * uses, and `parseProAvailableAfter` covers the explicit reset date.
 */
const TURN_LIMIT_EXACT_RE = /limit reached|reached your limit|usage limit/i;
/**
 * Consecutive heartbeat observations of the limit before the wait stops. One is
 * not enough: the alert may be a stale toast from the previous turn, and the
 * whole point of the early exit is to be right about a paid lane.
 */
const TURN_LIMIT_CONSECUTIVE_OBSERVATIONS = 2;
/**
 * P-035 G3 r38 (2026-09-28). Three consecutive observations that the submitted
 * turn rendered nothing at all before the wait stops. The first heartbeat is at
 * 60 s, so this is >= 3 minutes after submit.
 */
const TURN_NOT_RENDERED_CONSECUTIVE_OBSERVATIONS = 3;
/**
 * P-035 G3 r43 (2026-09-28). Ten consecutive observations of a frozen reply
 * before the wait stops. r41 keeps watching the page after an in-page reader
 * break because ChatGPT keeps producing the answer while the page stays; the
 * turn that never produces one any more has to be bounded instead of holding
 * the full timeout. Ten is the deliberately generous side of that trade: the
 * first heartbeat is at 60 s, so this is >= 10 minutes of an assistant turn
 * that exists, is not working, and whose trimmed text never changes, and any
 * observation with a working turn, a changed length or a failed read restarts
 * the streak.
 */
const REPLY_STALL_CONSECUTIVE_OBSERVATIONS = 10;
/**
 * The fixed, content-free alert vocabulary. A heartbeat shape reports which of
 * these words an alert text matched, case-insensitively, never the text itself.
 * Order here is the order they are joined on the line, so the shape is
 * deterministic for one alert text.
 */
const TURN_ALERT_TOKENS: ReadonlyArray<readonly [token: string, pattern: RegExp]> = [
  ["limit", /limit/i],
  ["usage", /usage/i],
  ["reached", /reached/i],
  ["upgrade", /upgrade/i],
  ["try-again", /try again/i],
  ["error", /error/i],
  ["network", /network/i],
  ["remaining", /remaining/i],
  ["reset", /reset/i],
  ["plan", /plan/i],
  ["pro", /pro/i],
  ["unable", /unable/i],
  ["rate", /rate/i],
];

/**
 * One visible alert's content-free shape: the length of its trimmed text and
 * the fixed-vocabulary tokens it matched, or `none`. The text is never returned
 * or logged, only its length and these fixed words.
 */
function alertShape(text: string): string {
  const trimmed = text.trim();
  const matched = TURN_ALERT_TOKENS
    .filter(([, pattern]) => pattern.test(trimmed))
    .map(([token]) => token);
  return `len:${trimmed.length}:${matched.length > 0 ? matched.join("+") : "none"}`;
}

/**
 * Visible alert/status/toast elements on the page, plus their individual texts.
 * The texts stay local: only the visible count and two hint booleans derived
 * from them ever leave this function unless the limit is proven. Hidden matches
 * are skipped for both the count and the texts, so the count and the hints
 * describe the same set of elements.
 */
async function readTurnAlerts(page: Page): Promise<{ count: number; texts: string[] }> {
  const alerts = page.locator(TURN_ALERT_SELECTOR);
  const total = await alerts.count();
  const texts: string[] = [];
  for (let i = 0; i < total; i++) {
    const el = alerts.nth(i);
    if (!(await el.isVisible())) continue;
    texts.push((await el.innerText().catch(() => "")) ?? "");
  }
  return { count: texts.length, texts };
}

/**
 * The trimmed alert text that named the Pro limit, or null when none did. The
 * text is returned whole so the reset date is parsed from what the page really
 * said; callers cap it for the error.
 */
function matchTurnLimitAlert(texts: string[]): string | null {
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (parseProAvailableAfter(trimmed) !== null || TURN_LIMIT_EXACT_RE.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

/** The post-submit Pro limit, proven by two consecutive heartbeat observations. */
interface TurnLimitAfterSubmit {
  availableAfter: string | null;
  limitText: string;
}

/**
 * The stalled-reply facts ONE observation showed: an assistant turn exists for
 * this submission, nothing is working, and this is the bubble's trimmed length.
 * Whether the length stopped changing is the heartbeat's question, not this
 * read's, so the length travels and the streak is counted above.
 */
interface TurnStalledObservation {
  elapsedSeconds: number;
  bubbleLength: number;
  streamBreaks: number;
  alertShapes: string;
}

/**
 * One heartbeat observation: the diagnostic line to print, the post-submit Pro
 * limit when THIS observation proved it, the "submitted turn never rendered"
 * facts when this observation showed them, and the stalled-reply facts when
 * this observation showed an idle assistant turn. Any read that a page cannot
 * answer propagates to the caller, which owns the try/catch.
 *
 * The line carries every field but the stalled-reply streak; the heartbeat
 * owner appends `stall=N/10` because it owns that counter.
 *
 * The limit only counts when no assistant turn for this submission has appeared
 * at all -- the assistant count has not moved, no bubble text exists and nothing
 * is working. A matching alert beside a live or finished turn is left to the
 * pre-existing completion path.
 *
 * P-035 G3 r38 (2026-09-28) adds the not-rendered observation: nothing rendered
 * for this submission at all, the user's own message included -- the
 * `anyMessages` count has not grown past its pre-submit value. It is only
 * computed when the caller supplied that prior value; an unknown prior count
 * disables the rule rather than guessing.
 *
 * P-035 G3 r43 (2026-09-28) adds the stalled-reply observation: an assistant
 * turn for this submission DOES exist and nothing is working. It is the exact
 * opposite of the two rules above on the assistant count, which is also why
 * they can never agree on one observation.
 */
async function readTurnHeartbeat(
  page: Page,
  elapsedMs: number,
  priorAssistantCount: number,
  priorAnyMessages: number | null,
  deepResearch = false,
): Promise<{
  line: string;
  limit: TurnLimitAfterSubmit | null;
  notRendered: SubmittedTurnNotRenderedDetails | null;
  stall: TurnStalledObservation | null;
  lightNotice: { resetsAt: string | null } | null;
}> {
  const count = await page.locator(SELECTORS.assistantMessages.join(", ")).count();
  const msgs = await page.locator(SELECTORS.anyMessages.join(", ")).count();
  const stop = (await firstResolved(page, SELECTORS.stopButton)) !== null;
  const bubble = await latestAssistantBubble(page);
  const streaming =
    bubble === null
      ? null
      : await bubble.getAttribute("data-message-streaming").catch(() => null);
  const bubbleText = bubble === null ? "" : ((await bubble.innerText().catch(() => "")) ?? "");
  const alerts = await readTurnAlerts(page);
  const composer = (await firstResolved(page, SELECTORS.composer)) !== null;
  const conversation = currentConversationId(page) !== null;
  // Hints come from the alert/status/toast text and the latest assistant
  // bubble only, and leave this function as booleans.
  const alertText = alerts.texts.join("\n");
  const haystack = `${alertText}\n${bubbleText}`;
  const working = stop || streaming === "true";
  const limitMatch = matchTurnLimitAlert(alerts.texts);
  // P-035 2026-10-03 G4-A. On a Deep Research turn the alerts, or the opening
  // of the reply, may carry the light-version notice: a quota fact, never a
  // failure. Only the opening: a report that quotes the notice further down
  // must not mark its own account exhausted.
  // ponytail: a report whose first 300 chars quote the notice still misreads; anchor to the notice's own node if one shows live.
  const lightNotice = deepResearch
    ? parseDeepResearchExhausted(`${alertText}\n${bubbleText.slice(0, LIGHT_NOTICE_HEAD)}`, new Date())
    : null;
  const noAssistantTurn = count <= priorAssistantCount && bubbleText.trim().length === 0 && !working;
  // Content-free: the visible alert count plus one shape per visible alert.
  const alertShapes = alerts.texts.map(alertShape).join(",");
  const yesNo = (value: boolean): string => (value ? "yes" : "no");
  return {
    line: [
      "[cgpro:turn]",
      `t=${Math.floor(elapsedMs / 1_000)}`,
      `assistant=${count}/${priorAssistantCount}`,
      `msgs=${msgs}/${priorAnyMessages === null ? "-" : priorAnyMessages}`,
      `working=${yesNo(working)}`,
      `stop=${yesNo(stop)}`,
      `bubble_len=${count > priorAssistantCount ? bubbleText.trim().length : 0}`,
      `conv=${yesNo(conversation)}`,
      `composer=${yesNo(composer)}`,
      `alerts=${alerts.count}`,
      `alert_shapes=${alertShapes || "-"}`,
      `error_hint=${yesNo(TURN_ERROR_HINT_RE.test(haystack))}`,
      `limit_hint=${yesNo(TURN_LIMIT_HINT_RE.test(haystack))}`,
      `limit_exact=${yesNo(limitMatch !== null)}`,
    ].join(" "),
    limit: noAssistantTurn && limitMatch !== null
      ? {
          availableAfter: parseProAvailableAfter(limitMatch),
          limitText: limitMatch.slice(0, PRO_LIMIT_TEXT_MAX),
        }
      : null,
    notRendered: priorAnyMessages !== null && msgs <= priorAnyMessages && noAssistantTurn
      ? {
          elapsedSeconds: Math.floor(elapsedMs / 1_000),
          msgs,
          priorMsgs: priorAnyMessages,
          alertCount: alerts.count,
          alertShapes,
        }
      : null,
    stall: count > priorAssistantCount && !working
      ? {
          elapsedSeconds: Math.floor(elapsedMs / 1_000),
          bubbleLength: bubbleText.trim().length,
          streamBreaks: streamBreakCount(page),
          alertShapes,
        }
      : null,
    lightNotice: lightNotice ? { resetsAt: lightNotice.resetsAt } : null,
  };
}

/**
 * At most one heartbeat line per 60 s of the wait, the first one 60 s after
 * entry. Errors are swallowed here so the heartbeat can never change the turn,
 * and a read that failed is never counted as an observation of any rule.
 *
 * The heartbeat records the limit once rule 1's condition holds for two
 * consecutive observations, the not-rendered facts once rule 2's condition
 * holds for three, and the stalled-reply facts once rule 3's condition holds
 * for ten. `waitTurnComplete` owns the throws, so this stays a diagnostic that
 * cannot itself change the turn.
 */
function turnHeartbeat(
  page: Page,
  priorAssistantCount: number,
  priorAnyMessages: number | null,
  deepResearch = false,
): {
  tick: () => Promise<void>;
  limitAfterSubmit: () => TurnLimitAfterSubmit | null;
  submittedTurnNotRendered: () => SubmittedTurnNotRenderedDetails | null;
  replyStalled: () => ReplyStalledDetails | null;
} {
  const startedAt = Date.now();
  let lastEmittedAt: number | null = null;
  let limitObservations = 0;
  let notRenderedObservations = 0;
  let stallStreak = 0;
  let stallLength: number | null = null;
  let confirmed: TurnLimitAfterSubmit | null = null;
  let notRendered: SubmittedTurnNotRenderedDetails | null = null;
  let stalled: ReplyStalledDetails | null = null;
  let lightNoticeRecorded = false;
  const tick = async (): Promise<void> => {
    try {
      const now = Date.now();
      const elapsed = now - startedAt;
      if (elapsed < TURN_HEARTBEAT_INTERVAL_MS) return;
      if (lastEmittedAt !== null && now - lastEmittedAt < TURN_HEARTBEAT_INTERVAL_MS) return;
      lastEmittedAt = now;
      const read = await readTurnHeartbeat(page, elapsed, priorAssistantCount, priorAnyMessages, deepResearch);
      // Recorded once per turn; the turn itself goes on and returns its answer.
      if (read.lightNotice !== null && !lightNoticeRecorded) {
        lightNoticeRecorded = true;
        recordDeepResearchExhausted(read.lightNotice.resetsAt);
      }
      limitObservations = read.limit === null ? 0 : limitObservations + 1;
      if (read.limit !== null && limitObservations >= TURN_LIMIT_CONSECUTIVE_OBSERVATIONS && confirmed === null) {
        // P-035 G3 r45 (2026-09-28). The post-submit notice can name no date,
        // exactly like the pre-send one. The account usage panel is read ONCE,
        // here at the confirming observation -- never on every heartbeat -- and
        // only when the notice itself carries no date.
        confirmed = {
          ...read.limit,
          availableAfter: await availableAfterOrUsagePanel(page, read.limit.availableAfter),
        };
      }
      notRenderedObservations = read.notRendered === null ? 0 : notRenderedObservations + 1;
      if (read.notRendered !== null && notRenderedObservations >= TURN_NOT_RENDERED_CONSECUTIVE_OBSERVATIONS) {
        notRendered = read.notRendered;
      }
      // Rule 3 counts observations of one UNCHANGED trimmed length, so the
      // first observation of a length starts a fresh streak and a different
      // length does not extend the old one.
      if (read.stall === null) {
        stallStreak = 0;
        stallLength = null;
      } else if (stallLength !== null && read.stall.bubbleLength === stallLength) {
        stallStreak += 1;
      } else {
        stallLength = read.stall.bubbleLength;
        stallStreak = 1;
      }
      if (read.stall !== null && stallStreak >= REPLY_STALL_CONSECUTIVE_OBSERVATIONS) {
        stalled = read.stall;
      }
      console.error(`${read.line} stall=${stallStreak}/${REPLY_STALL_CONSECUTIVE_OBSERVATIONS}`);
    } catch {
      // Diagnostic only: a page that cannot answer the heartbeat's reads must
      // not change the wait it observes, and an unreadable heartbeat is not an
      // observation of any rule either.
      limitObservations = 0;
      notRenderedObservations = 0;
      stallStreak = 0;
      stallLength = null;
    }
  };
  return {
    tick,
    limitAfterSubmit: () => confirmed,
    submittedTurnNotRendered: () => notRendered,
    replyStalled: () => stalled,
  };
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
 *
 * P-035 G3 r37 (2026-09-28). A third way out: the Pro usage limit that ChatGPT
 * reveals only after the prompt was submitted. Two consecutive heartbeats that
 * see a limit alert while no assistant turn exists end the wait with
 * `ProUsageLimitAfterSubmitError` instead of holding the full timeout. Every
 * other stall still waits the configured timeout, unchanged.
 *
 * P-035 G3 r38 (2026-09-28). A fourth way out: the submitted turn that never
 * rendered anything, the user's own message included. Three consecutive
 * heartbeats (>= 3 minutes) that see no assistant turn AND no growth in the
 * `anyMessages` count past its pre-submit value end the wait with
 * `SubmittedTurnNotRenderedError`, so the daemon's failure capture runs instead
 * of a silent 2 h timeout. The prior `anyMessages` count is optional: when the
 * caller cannot supply it, this rule stays off. A proven limit is checked first
 * and wins.
 *
 * P-035 G3 r43 (2026-09-28). A fifth way out: the submitted turn whose reply
 * froze. r41 restored the rule that an in-page reader break does not end the
 * turn, because ChatGPT keeps producing the answer while the page stays; the
 * genuinely frozen reply this leaves open is bounded here instead. Ten
 * consecutive heartbeats (>= 10 minutes) that see an assistant turn for this
 * submission, NOT working, and one unchanged trimmed length end the wait with
 * `ReplyStalledError`. Checked after the limit and the never-rendered turn, so
 * those keep their exits, and before the timeout/reload branch, so the freeze
 * fails fast instead of waiting out the deadline. A genuine completion returns
 * from an earlier iteration as soon as its own stability window and backend
 * confirmation hold, so it always wins: ten unchanged observations cannot
 * accumulate while the completion path is returning.
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
    /** G4-A: a Deep Research turn, whose heartbeat also reads the light-version notice. */
    deepResearch?: boolean;
  } = {},
  /**
   * `SELECTORS.anyMessages` count captured before submit. Optional: null (the
   * default) means unknown, which disables the not-rendered rule entirely.
   */
  priorAnyMessages: number | null = null,
): Promise<void> {
  let deadline = Date.now() + timeoutMs;
  let lastText = "";
  let lastChangedAt = Date.now();
  const heartbeat = turnHeartbeat(page, priorAssistantCount, priorAnyMessages, control.deepResearch === true);

  for (;;) {
    if (control.cancelled?.()) return;
    await heartbeat.tick();
    await control.pollEvidence?.(Date.now() >= deadline);
    if (control.cancelled?.()) return;
    if (control.externalComplete?.()) return;
    // Checked after cancel and external completion, so a genuine completion
    // always wins, and before the timeout/reload branch, so the proven limit,
    // the never-rendered turn or the frozen reply fails fast instead of waiting
    // out the deadline. The limit is checked first and wins when both rules
    // hold; r37 and r38 stay ahead of r43.
    const postSubmitLimit = heartbeat.limitAfterSubmit();
    if (postSubmitLimit !== null) {
      throw new ProUsageLimitAfterSubmitError(postSubmitLimit);
    }
    const notRendered = heartbeat.submittedTurnNotRendered();
    if (notRendered !== null) {
      throw new SubmittedTurnNotRenderedError(notRendered);
    }
    const stalled = heartbeat.replyStalled();
    if (stalled !== null) {
      throw new ReplyStalledError(stalled);
    }
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
 * A leading progress header ChatGPT prints above a Pro / Thinking answer:
 * "Thought for 12s" (older UI) and "Worked for 9m 26s" / "Worked for 45s" (the
 * 2026-09-28 Pro answer). It is chrome, not answer text, so exactly one leading
 * such line is stripped -- the way the reader already stripped "Thought for Ns".
 */
const LEADING_PROGRESS_LINE_RE =
  /^(?:Thought for \d+s|Worked for \d+(?:m\s*\d+)?s)\s*\n+/i;

/**
 * The bubble container that may repeat: the live 2026-09 assistant unit carried
 * several `[class*="markdown"]` blocks, not one.
 */
const MARKDOWN_ANY_SELECTOR = '[class*="markdown"]';

/**
 * Text of every `[class*="markdown"]` block in the bubble, in document order,
 * joined with a blank line.
 *
 * P-035 2026-09-28 (vendor r40). Reading `.first()` here would return only one
 * of several markdown blocks (six were counted live). Only the OUTERMOST matched
 * blocks are read, so a block nested inside another matched block is not counted
 * twice (which would duplicate its own text in the answer). Each block's text is
 * trimmed before the join and empty blocks are dropped. Never throws: an
 * unanswerable block yields empty text and the caller keeps walking fallbacks.
 */
async function joinMarkdownBlockText(scope: Locator, count: number): Promise<string> {
  const all = scope.locator(MARKDOWN_ANY_SELECTOR);
  const outermost = await all
    .evaluateAll((elements) =>
      elements
        .map((element, index) => ({
          index,
          nested: elements.some((other) => other !== element && other.contains(element)),
        }))
        .filter((entry) => !entry.nested)
        .map((entry) => entry.index),
    )
    .catch(() => Array.from({ length: count }, (_, index) => index));
  const parts: string[] = [];
  for (const index of outermost) {
    const block = (await all.nth(index).innerText({ timeout: 1_500 }).catch(() => "")) ?? "";
    if (block.trim().length > 0) parts.push(block.trim());
  }
  return parts.join("\n\n");
}

/**
 * Fall-back content extraction: return the latest assistant bubble's
 * inner text. Used when SSE interception didn't capture text.
 *
 * Strips a leading "Thought for Ns" / "Worked for <duration>" header that the
 * Pro / Thinking models inject before the actual answer. Prefers the deepest
 * markdown container so we don't pick up wrapper chrome.
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
  // P-035 2026-09-28 (vendor r40): the live assistant unit renders its answer in
  // a `[class*="markdown"]` block rather than a `div.markdown`, so that class
  // match is added right after `div.markdown`, ahead of the older fallbacks.
  const containers = [
    "div.markdown",
    MARKDOWN_ANY_SELECTOR,
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
      const text = sel === MARKDOWN_ANY_SELECTOR
        ? await joinMarkdownBlockText(bubble, cnt)
        : (await loc.innerText({ timeout: 1_500 }).catch((e) => {
          log(`${sel}: innerText threw: ${(e as Error).message.slice(0, 60)}`);
          return "";
        })) ?? "";
      log(`${sel}: text.length=${text.length} preview=${JSON.stringify(text.slice(0, 60))}`);
      if (text.trim().length === 0) continue;
      const cleaned = text.replace(LEADING_PROGRESS_LINE_RE, "").trim();
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
  return txt.replace(LEADING_PROGRESS_LINE_RE, "").trim();
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
  guard?: () => Promise<void>,
): Promise<void> {
  const selector = joinSelectors(candidates);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (settled?.()) return;
    // P-035 2026-09-22. Retrying the identical click is what wasted the turn: a
    // pointer-intercepting overlay (`#modal-beacon`) sat over the sidebar, so
    // three 15s attempts ran against the same blocker and the turn died -- while
    // a preflight nineteen seconds later cleared the ladder in 55s. Dismiss first,
    // then click. Only between attempts, so the happy path is untouched.
    await guard?.();
    if (attempt > 0) await dismissPointerBlockers(page);
    const matches = page.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = matches.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      await guard?.();
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
  // Name the blocker when one is still up. Playwright's own message says
  // "subtree intercepts pointer events" without saying what the subtree IS.
  const blocker = await describePointerBlocker(page);
  throw new Error(
    `${name} could not be clicked after ${attempts} attempts ` +
      `(matches=${count}, visible=${visible}, url=${page.url()}` +
      `${blocker ? `, blockedBy=${blocker}` : ""})` +
      (lastError instanceof Error ? `: ${lastError.message}` : ""),
  );
}
