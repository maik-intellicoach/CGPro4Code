import type { Page } from "patchright";
import { openSession, type Session } from "../browser/session.js";
import { goHome, isLoggedIn, requireSelector } from "../browser/chatgpt.js";
import {
  assertPreflightDraftSafe,
  clearComposer,
  currentConversationId,
  latestAssistantModelSlug,
  openConversation,
  ensureProSixMaximum,
  type ModelVerificationPhase,
  type ProjectNavigationPhase,
  probePromptDelivery,
  type DeliveryPath,
  type PromptDeliveryProbe,
  readLatestAssistantText,
  sendPrompt,
  setConnector,
  setDeepResearch,
  setWebSearch,
  stopCurrentTurn,
  waitForComposerHydrated,
  waitTurnComplete,
} from "../browser/conversation.js";
import {
  setActiveEmitter,
  StreamEmitter,
  type StreamEvent,
} from "./stream.js";
import { classifyInteractionFailure, ConnectorEvidenceRateLimitError, type InteractionFailure, NotLoggedInError, PreflightDraftProtectedError, PreSubmitInteractionError, TurnTimeoutError } from "../errors.js";
import { requireAccount, verifyFiling, type FilingProof } from "../api/conversation-filing.js";
import { joinSelectors, SELECTORS as SELECTORS_DUMP } from "../browser/selectors.js";
import { fetchLatestTurnConnectorState, type LatestTurnConnectorState, fetchLatestNativeResearchReport, fetchNativeResearchUserNodes, type NativeResearchReport } from "../api/conversations.js";

const CONNECTOR_EVIDENCE_POLL_MS = 30_000;
const CONNECTOR_EVIDENCE_RATE_LIMIT_BACKOFF_MS = 120_000;
// P-035 2026-09-23. How long a mid-turn 404 on a just-created conversation counts
// as "not readable yet" before it is the missing conversation it may really be.
const CONNECTOR_NOT_FOUND_GRACE_MS = 120_000;

export interface AskOptions {
  prompt: string;
  model?: string;
  web?: boolean;
  /** Select ChatGPT's native Deep Research mode for this turn. */
  deepResearch?: boolean;
  /** Exact ChatGPT connector/app name to select before sending. */
  connector?: string;
  images?: string[];
  /** Resume a previous conversation by its chatgpt.com UUID. */
  conversationId?: string;
  /**
   * Pin the new conversation to a ChatGPT Project (gizmo). Ignored
   * when `conversationId` is set — resumed convs already belong to
   * a project (or none).
   */
  gizmoId?: string;
  /** Optional shortUrl for the gizmo so the URL is human-readable. */
  gizmoShortUrl?: string;
  timeoutSec: number;
  headless: boolean;
  /** Hide the browser window off-screen for unobtrusive runs. */
  background?: boolean;
  profile?: string;
  /** Daemon-only hook: consume a guarded reload request for this turn. */
  consumeReload?: () => string | null;
  /** Stable facade invocation ID used for exact cancellation attribution. */
  invocationId?: string;
  expectedAccountEmail?: string;
}

export interface AskResult {
  conversationId: string | null;
  finalText: string;
  events: StreamEvent[];
  filing?: FilingProof;
}

export interface AskRunner {
  events: AsyncIterable<StreamEvent>;
  result: Promise<AskResult>;
  cancel: () => Promise<void>;
}

export interface InteractionPreflightOptions {
  model: "gpt-6-pro";
  connector: string;
  gizmoId: string;
  gizmoShortUrl?: string;
  expectedAccountEmail: string;
  /** When present, deliver and measure this prompt WITHOUT submitting it. */
  probePrompt?: string;
  /** Force one delivery path, so either can be tested on demand. */
  probeDeliveryPath?: DeliveryPath;
}

export interface InteractionPreflightResult {
  accountVerified: true;
  projectVerified: true;
  connectorVerified: true;
  model: "gpt-6-pro";
  power: number;
  promptDelivery?: PromptDeliveryProbe;
}

/** Fixed labels only: no prompt, account, connector or URL enters phase evidence. */
export type InteractionPreflightPhase =
  | ModelVerificationPhase | ProjectNavigationPhase
  | "home" | "login" | "account-home" | "project" | "account-project"
  | "composer" | "connector" | "model" | "prompt-delivery"
  | "cleanup-escape" | "cleanup-home" | "cleanup-composer";

/** Verify current controls on an idle daemon lane without submitting a prompt. */
export async function runInteractionPreflight(
  opts: InteractionPreflightOptions,
  session: Session,
  onPhase?: (phase: InteractionPreflightPhase, failedPhase?: InteractionPreflightPhase, failure?: InteractionFailure) => void,
): Promise<InteractionPreflightResult> {
  const page = session.page;
  let verificationError: unknown;
  let admitted = false;
  let protectedDraft = false;
  // P-035 2026-09-28 r15. The lane's own configured connector is not a user
  // draft. An earlier preflight on this lane attached the chip, the guard then
  // refused for an unrelated reason, `protectedDraft` skipped cleanup by
  // design, and ChatGPT persisted the chip. Every guard before `setConnector`
  // -- and every cleanup guard after `goHome` resets `ownedConnector` -- then
  // ran with no owned connector, refused the lane's own residue as
  // `connector_unowned`, and left the lane permanently stuck. `ownedConnector`
  // stays the authority once this run has attached a connector; before and
  // after that, the one connector this lane may own is the one it is
  // configured to use.
  const configuredConnector = opts.connector?.trim() || undefined;
  let ownedConnector: string | undefined;
  const guard = async (): Promise<void> => {
    try { await assertPreflightDraftSafe(page, { connector: ownedConnector ?? configuredConnector }); }
    catch (error) { protectedDraft = true; throw error; }
  };
  let phase: InteractionPreflightPhase = "home";
  let failedPhase: InteractionPreflightPhase | undefined;
  let failure: InteractionFailure | undefined;
  const mark = (next: InteractionPreflightPhase): void => {
    phase = next;
    onPhase?.(phase, failedPhase, failure);
  };
  try {
    await guard();
    admitted = true;
    mark("home");
    await goHome(page);
    // Wait for the hydrated composer BEFORE the home guard: the guard reads the
    // composer to decide admission, so judging a half-loaded page refuses a
    // perfectly clean lane. Bounded, and never itself a failure.
    await waitForComposerHydrated(page);
    await guard();
    mark("login");
    if (!(await isLoggedIn(page, 10_000))) throw new NotLoggedInError();
    mark("account-home");
    await requireAccount(page, opts.expectedAccountEmail);
    await guard();
    mark("project");
    await openConversation(page, {
      model: opts.model,
      gizmoId: opts.gizmoId,
      gizmoShortUrl: opts.gizmoShortUrl,
    }, mark, true, configuredConnector);
    mark("account-project");
    await requireAccount(page, opts.expectedAccountEmail);
    mark("composer");
    await clearComposer(page, guard);
    mark("connector");
    await guard();
    await setConnector(page, opts.connector, true);
    ownedConnector = opts.connector.trim();
    await guard();
    mark("model");
    const selection = await ensureProSixMaximum(page, (next, failed, originalFailure) => {
      failedPhase ??= failed;
      failure ??= originalFailure;
      mark(next);
    });
    // Last, so the probe runs against exactly the controls a real turn would
    // use: same account, same Project, same connector, same model selection.
    if (opts.probePrompt !== undefined) mark("prompt-delivery");
    const promptDelivery = opts.probePrompt === undefined
      ? undefined
      : await probePromptDelivery(page, opts.probePrompt, opts.probeDeliveryPath, ownedConnector);
    await guard();
    return {
      accountVerified: true,
      projectVerified: true,
      connectorVerified: true,
      model: "gpt-6-pro",
      power: selection.power,
      ...(promptDelivery === undefined ? {} : { promptDelivery }),
    };
  } catch (error) {
    if (error instanceof PreflightDraftProtectedError) protectedDraft = true;
    failedPhase ??= phase;
    failure ??= classifyInteractionFailure(error);
    onPhase?.(phase, failedPhase, failure);
    verificationError = error;
    throw error;
  } finally {
    // Never let finally undo the guard's refusal. A second read also catches
    // drafts that arrived while a model/account operation failed.
    if (admitted && !protectedDraft) {
      try {
        await guard();
        mark("cleanup-escape");
        await page.keyboard.press("Escape").catch(() => undefined);
        await guard();
        mark("cleanup-home");
        await goHome(page, { model: opts.model });
        // P-035 2026-09-28 r21. The same race, one navigation later again: live
        // ms1980 (vendor 57d8588, lane ms1980, pid 90325) passed account,
        // Project, composer, connector and model, then refused
        // `reason=composer_count:0` at `failedPhase=cleanup-home`, on the
        // pre-hydration home shell this cleanup `goHome` had just landed on.
        // The cleanup guard reads the composer for the same admission decision
        // the home guard does, so it needs the same bounded hydration wait
        // before it. Bounded, and never itself a failure -- the guard stays the
        // only admission authority, so an absent composer still refuses
        // `composer_count:0` exactly as it did without this wait.
        await waitForComposerHydrated(page);
        ownedConnector = undefined;
        await guard();
        mark("cleanup-composer");
        await clearComposer(page, guard);
        await guard();
      } catch (error) {
        failedPhase ??= phase;
        failure ??= classifyInteractionFailure(error);
        onPhase?.(phase, failedPhase, failure);
        if (verificationError === undefined) {
          if (error instanceof PreflightDraftProtectedError) throw error;
          throw new Error("interaction preflight cleanup failed", { cause: error });
        }
      }
    }
  }
}

/**
 * Drives a single ask turn end to end. Yields stream events to the caller
 * and resolves a final summary once the turn completes (or fails).
 *
 * Cold-start path: opens a fresh browser session, runs the turn, closes it.
 * Use `runAskOnSession` to reuse a long-lived session (daemon mode).
 */
export function runAsk(opts: AskOptions): AskRunner {
  return runAskInner(opts, null, true);
}

/**
 * Same as `runAsk` but reuses an existing browser session that the caller
 * owns and won't be closed when the turn completes. Used by the daemon
 * server so multiple turns can share one warm Chromium.
 */
export function runAskOnSession(opts: AskOptions, session: Session): AskRunner {
  return runAskInner(opts, session, false);
}

function runAskInner(
  opts: AskOptions,
  providedSession: Session | null,
  closeOnFinish: boolean,
): AskRunner {
  const emitter = new StreamEmitter();
  const collected: StreamEvent[] = [];

  let session: Session | null = providedSession;
  let cancelled = false;
  const observedConnectorCallIds = new Set<string>();
  let lastConnectorEvidencePollAt = -Infinity;
  let connectorSnapshot: LatestTurnConnectorState | null = null;
  let connectorCompletionConfirmed = false;
  let connectorEvidenceBackoffUntil = 0;
  let consecutiveConnector429s = 0;
  let connectorNotFoundSince: number | null = null;
  let connectorNotFoundError: Error | null = null;
  let connectorEvidencePollInFlight: Promise<void> | null = null;
  const nativeState: { report: NativeResearchReport | null } = { report: null };
  let nextNativeReportPollAt = 0;
  let nativeMaximumVerified = false;
  // The connector this turn owns once `setConnector` succeeded, in the same
  // trimmed form the preflight records. Passed to `sendPrompt` so a pre-submit
  // refusal can prove the connector turn's own draft (token plus prompt) before
  // clearing it. Undefined on every turn without a connector.
  let ownedConnector: string | undefined;

  const result: Promise<AskResult> = (async () => {
    if (!session) {
      session = await openSession({
        headed: !opts.headless,
        profilePath: opts.profile,
        background: opts.background,
      });
    }
    setActiveEmitter(session.page, emitter, opts.connector);
    try {
      if (opts.deepResearch && opts.connector !== undefined) {
        throw new Error("native Deep Research and connectors are mutually exclusive");
      }
      const page = session.page;
      const debug = process.env.CGPRO_DEBUG === "1";
      const log = (m: string): void => {
        if (debug) console.error("[cgpro]", m);
      };
      log("goHome…");
      await goHome(page);
      log(`goHome done, url=${page.url()}`);
      if (!(await isLoggedIn(page, 10_000))) {
        throw new NotLoggedInError();
      }
      log("isLoggedIn ✓");
      if (opts.expectedAccountEmail) await requireAccount(page, opts.expectedAccountEmail);

      // Model resolution:
      // - If caller passed --model, use it verbatim (chatgpt.com falls
      //   back silently to the account default if the slug is unknown).
      // - Otherwise let the page pick the user's default model (which
      //   for ChatGPT Pro accounts is gpt-5-5-pro). We confirm what was
      //   actually used after the turn via data-message-model-slug.
      const modelSlug = opts.model;

      log(
        `openConversation model=${modelSlug ?? "(account default)"} resume=${opts.conversationId ?? "no"} gizmo=${opts.gizmoId ?? "none"}…`,
      );
      await openConversation(page, {
        model: modelSlug,
        conversationId: opts.conversationId,
        gizmoId: opts.gizmoId,
        gizmoShortUrl: opts.gizmoShortUrl,
      });
      log(`openConversation done, url=${page.url()}`);
      if (opts.gizmoId && opts.expectedAccountEmail) {
        // New Project navigation is checked by openConversation. A resumed chat
        // must also prove actual membership before it receives another prompt.
        await requireAccount(page, opts.expectedAccountEmail);
        if (opts.conversationId) {
          const prior = await verifyFiling(page, opts.conversationId, opts.gizmoId, opts.expectedAccountEmail);
          if (prior.status !== "verified") throw new Error("ChatGPT Project membership not verified before submission");
        }
        emitter.push({ type: "tool", name: "filing-context-verified", meta: { projectId: opts.gizmoId, accountVerified: true } });
      }


      if (opts.deepResearch) {
        await clearComposer(page);
        log("setDeepResearch true…");
        await setDeepResearch(page, true);
        emitter.push({ type: "tool", name: "deep-research-selected" });
      } else if (opts.web !== undefined) {
        log(`setWebSearch ${opts.web}…`);
        await setWebSearch(page, opts.web);
      }

      if (opts.connector !== undefined) {
        log(`setConnector ${opts.connector}…`);
        await setConnector(page, opts.connector);
        ownedConnector = opts.connector.trim();
        emitter.push({ type: "tool", name: "connector-selected", meta: { connector: opts.connector } });
      }

      await attachImages(page, opts.images ?? []);

      // A stale GET after Send must never satisfy this run with an old report.
      const existingNativeConversation = opts.deepResearch || opts.connector !== undefined
        ? currentConversationId(page) ?? opts.conversationId : null;
      const priorNativeUsers = existingNativeConversation
        ? await fetchNativeResearchUserNodes(page, existingNativeConversation) : new Set<string>();

      log("sendPrompt…");
      const priorBubbles = await sendPrompt(
        page, opts.prompt, opts.connector !== undefined || opts.deepResearch === true, () => cancelled,
        async () => {
          if (opts.deepResearch) {
            await requireSelector(page, SELECTORS_DUMP.deepResearchSelected, "native Deep Research before submission", 8_000);
          }
          if (modelSlug === "gpt-6-pro" || opts.deepResearch) {
            const selection = await ensureProSixMaximum(page);
            if (opts.deepResearch) nativeMaximumVerified = true;
            emitter.push({ type: "tool", name: "model-thinking-verified", meta: selection });
          }
        },
        ownedConnector,
      );
      if (opts.deepResearch && !cancelled && !nativeMaximumVerified) {
        throw new Error("Native research maximum UI setting was not verified before submission");
      }
      if (!cancelled) {
        emitter.push({ type: "tool", name: "prompt-submitted", meta: opts.connector === undefined ? {} : { connector: opts.connector } });
      }
      log(`sendPrompt done (priorBubbles=${priorBubbles}), url=${page.url()}`);
      const submittedAt = Date.now();

      const runConnectorEvidencePoll = async (force = false): Promise<void> => {
        if (opts.connector === undefined || cancelled) return;
        const now = Date.now();
        if (!force) {
          if (now < connectorEvidenceBackoffUntil || now - lastConnectorEvidencePollAt < CONNECTOR_EVIDENCE_POLL_MS) return;
        }
        for (const event of collected) {
          if (event.type !== "tool" || !event.meta || typeof event.meta !== "object") continue;
          const callId = (event.meta as Record<string, unknown>).callId;
          if (typeof callId === "string") observedConnectorCallIds.add(callId);
        }
        const started = collected.find((event) => event.type === "started");
        const urlConversationId = currentConversationId(page);
        const conversationId = urlConversationId ??
          (started?.type === "started" ? started.conversationId ?? null : null);
        if (!conversationId) return;
        lastConnectorEvidencePollAt = now;
        connectorSnapshot = null;
        let state;
        try {
          state = await fetchLatestTurnConnectorState(
            page,
            conversationId,
            opts.connector,
            // Completion shares this read, so retain its original 10s budget.
            10_000,
            // All attempts share the streak and Retry-After budget here,
            // including terminal reads. Hidden API retries would bypass both.
            false,
          );
        } catch (err) {
          const status = err instanceof Error ? Number(/\bHTTP (\d{3})\b/.exec(err.message)?.[1] ?? 0) : 0;
          // P-035 2026-09-23. Content-free, one line per failed read: settles
          // whether a post-Send 404 clears (read-after-create lag) or persists.
          console.error(
            `[cgpro:connector] ${new Date(now).toISOString()} evidence read failed ` +
              `invocation=${opts.invocationId ?? "-"} status=${status || "none"}` +
              `${status ? "" : ` err=${err instanceof Error ? err.name : typeof err}`} ` +
              `source=${urlConversationId ? "url" : "sse"} sinceSubmitMs=${now - submittedAt} forced=${force}`,
          );
          // P-035 2026-09-23. The SSE `started` id exists ~1 s after Send, before
          // GET /conversation/<id> serves it, and a 404 there killed every intelli
          // connector turn (91ae62ef, and three times on 09-21). It is "not readable
          // yet" -- but only for a bounded window from the first 404, so a
          // conversation that really is missing still fails as HTTP 404 in bounded
          // time instead of stalling completion until the turn's deadline.
          if (!force && status === 404) {
            connectorNotFoundSince ??= now;
            connectorNotFoundError = err as Error;
            if (now - connectorNotFoundSince < CONNECTOR_NOT_FOUND_GRACE_MS) return;
          }
          // Other denials cannot recover through progress polling; surface them
          // and preserve partial output. 429 has its own backoff below.
          if (status === 429) {
            consecutiveConnector429s += 1;
            if (consecutiveConnector429s >= 3) throw new ConnectorEvidenceRateLimitError(err);
            const retryAfterMs = (err as Error & { retryAfterMs?: number }).retryAfterMs;
            connectorEvidenceBackoffUntil = Date.now() + Math.max(
              CONNECTOR_EVIDENCE_RATE_LIMIT_BACKOFF_MS,
              typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
            );
          }
          if (force || (status >= 400 && status < 500 && status !== 429)) throw err;
          return;
        }
        consecutiveConnector429s = 0;
        connectorNotFoundSince = null;
        connectorNotFoundError = null;
        // A resumed conversation GET can lag Send and still expose an old turn.
        if (!state.currentUserNodeId || priorNativeUsers.has(state.currentUserNodeId)) return;
        connectorSnapshot = state;
        for (const call of state.calls) {
          if (observedConnectorCallIds.has(call.id)) continue;
          observedConnectorCallIds.add(call.id);
          emitter.push({
            type: "tool",
            name: call.name,
            meta: { source: "latest-conversation-turn", connector: opts.connector, callId: call.id },
          });
        }
      };

      const pollConnectorEvidence = async (force = false): Promise<void> => {
        if (connectorEvidencePollInFlight) await connectorEvidencePollInFlight;
        if (force && connectorCompletionConfirmed) return;
        if (force && Date.now() < connectorEvidenceBackoffUntil) {
          throw new Error("conversation connector state fetch deferred after HTTP 429");
        }
        if (connectorEvidencePollInFlight) return connectorEvidencePollInFlight;
        connectorEvidencePollInFlight = runConnectorEvidencePoll(force)
          .finally(() => { connectorEvidencePollInFlight = null; });
        await connectorEvidencePollInFlight;
      };

      const confirmConnectorCompletion = async (): Promise<boolean> => {
        if (opts.connector === undefined || cancelled) return true;
        // Tools and DOM-completion candidates share one bounded GET and backoff.
        await pollConnectorEvidence();
        const state = connectorSnapshot;
        connectorCompletionConfirmed = state !== null &&
          state.currentRole === "assistant" &&
          state.currentStatus === "finished_successfully" &&
          state.currentEndTurn === true &&
          state.currentContentType === "text" &&
          !state.currentIsThinkingPreamble;
        return connectorCompletionConfirmed;
      };

      // Wait for the turn to settle. The SSE interceptor will normally push
      // a `done` event; if the network missed (cached response, schema we
      // didn't recognize), we fall back to DOM detection.
      log(`waitTurnComplete (timeout ${opts.timeoutSec}s)…`);
      const pollNativeReport = async (force = false): Promise<void> => {
        if (!opts.deepResearch || nativeState.report || (!force && Date.now() < nextNativeReportPollAt)) return;
        const started = collected.find((event) => event.type === "started");
        const id = currentConversationId(page) ??
          (started?.type === "started" ? started.conversationId ?? null : null);
        if (!id) return;
        try {
          const report = await fetchLatestNativeResearchReport(page, id);
          if (report && !priorNativeUsers.has(report.userNodeId)) nativeState.report = report;
        } catch (error) {
          console.error(`[cgpro:native] ${String(error)}; report read deferred`);
        } finally {
          nextNativeReportPollAt = Date.now() + 30_000;
        }
      };
      try {
        await waitTurnComplete(page, opts.timeoutSec * 1_000, priorBubbles, undefined, {
          consumeReload: opts.consumeReload,
          conversationId: () => {
            const started = collected.find((event) => event.type === "started");
            return currentConversationId(page) ??
              (started?.type === "started" ? started.conversationId ?? null : null);
          },
          onReload: ({ conversationId, working, extended }) => {
            emitter.push({
              type: "tool",
              name: extended ? "wait-extended" : "conversation-reloaded",
              meta: { conversationId, working, waitExtendedSec: extended ? opts.timeoutSec : 0 },
            });
          },
          cancelled: () => cancelled,
          pollEvidence: async (force = false) => {
            await pollConnectorEvidence(false);
            await pollNativeReport(force);
          },
          externalComplete: opts.deepResearch ? () => nativeState.report !== null : undefined,
          confirmComplete: opts.deepResearch ? async () => nativeState.report !== null : confirmConnectorCompletion,
        });
      } catch (err) {
        if (debug) {
          try {
            const screenshotPath = `${process.env.TEMP || "."}/cgpro-debug-${Date.now()}.png`;
            await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
            log(`screenshot saved: ${screenshotPath}`);
            const url = page.url();
            const composerCount = await page.locator("#prompt-textarea").count();
            const sendCount = await page.locator('button[data-testid="send-button"]').count();
            const bubbleCount = await page
              .locator(SELECTORS_DUMP.assistantMessages.join(", "))
              .count();
            const composerText = await page
              .locator("#prompt-textarea")
              .first()
              .innerText()
              .catch(() => "");
            const visibleControls = await page
              .locator("main button:visible, form button:visible")
              .evaluateAll((buttons) => buttons.slice(-20).map((button) => ({
                text: (button.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
                ariaLabel: button.getAttribute("aria-label"),
                testid: button.getAttribute("data-testid"),
                className: typeof button.className === "string" ? button.className.slice(0, 160) : null,
                svgTestid: button.querySelector("svg")?.getAttribute("data-testid") ?? null,
                hasRect: Boolean(button.querySelector("svg rect")),
              })))
              .catch(() => []);
            log(
              `state: url=${url} composer=${composerCount} send=${sendCount} bubbles=${bubbleCount} composerText=${JSON.stringify(composerText.slice(0, 80))}`,
            );
            log(`visible-controls=${JSON.stringify(visibleControls)}`);
          } catch (diagnosticErr) {
            log(`debug diagnostics unavailable: ${(diagnosticErr as Error).message}`);
          }
        }
        if (!cancelled) {
          if (!collected.some(e => e.type === "delta" || e.type === "done")) {
            const count = await page.locator(SELECTORS_DUMP.assistantMessages.join(", ")).count().catch(() => 0);
            if (count > priorBubbles) {
              const partial = await readLatestAssistantText(page).catch(() => "");
              if (partial) emitter.push({ type: "delta", text: partial });
            }
          }
          // A turn shorter than the 404 grace would otherwise end as a timeout
          // that hides the 404 it was waiting out (P-035 2026-09-23 review).
          if (err instanceof TurnTimeoutError && connectorNotFoundError) {
            throw Object.assign(connectorNotFoundError, { cause: err });
          }
          throw err;
        }
      }
      log(`waitTurnComplete done, url=${page.url()}`);

      if (cancelled) {
        const finalText = await readLatestAssistantText(page).catch(() => "");
        if (!emitter.isFinished()) {
          emitter.push({ type: "done", finalText });
        }
        return {
          conversationId: currentConversationId(page),
          finalText,
          events: collected,
        };
      }

      // Conversation id can come from two sources:
      //  - the URL once the page navigates to /c/<uuid> (regular chats)
      //  - the SSE `started` event payload (ephemeral chats keep the
      //    composer URL as-is but the backend still mints a UUID)
      let conversationId = currentConversationId(page);
      if (!conversationId) {
        const startedEv = collected.find((e) => e.type === "started") as
          | { conversationId?: string }
          | undefined;
        if (startedEv?.conversationId) {
          conversationId = startedEv.conversationId;
        }
      }
      const actualModel = nativeState.report ? nativeState.report.model : await latestAssistantModelSlug(page);
      log(`actualModel=${actualModel ?? "(unknown)"} conv=${conversationId ?? "(none)"}`);

      if (opts.connector !== undefined && conversationId) {
        try { await pollConnectorEvidence(true); }
        catch (error) {
          if (!collected.some(e => e.type === "delta" || e.type === "done")) {
            const partial = await readLatestAssistantText(page).catch(() => "");
            if (partial) emitter.push({ type: "delta", text: partial });
          }
          throw error;
        }
      }

      // Native research uses a separate app engine. Maik approved the verified
      // maximum UI setting as its acceptance basis (2026-09-09); retain the
      // engine identity as provenance without claiming it is the UI model.
      const wantedPro = (modelSlug ?? "").toLowerCase().includes("pro");
      const gotPro = (actualModel ?? "").toLowerCase().includes("pro");
      if (wantedPro && !gotPro && !(nativeState.report && nativeMaximumVerified)) {
        const msg = opts.deepResearch
          ? `Native research reports engine "${actualModel ?? "unknown"}" while the requested UI model was "${modelSlug}"; their identity mapping is unverified.`
          :
          `cgpro asked for "${modelSlug}" but the response came from "${actualModel ?? "unknown"}" — ` +
          `the model picker did not switch. Common causes: project default model overrides, ` +
          `or a stale conversation that resumed with its previous model.`;
        console.error(`[cgpro:model] ⚠ ${msg}`);
        emitter.push({ type: "tool", name: "model-mismatch", meta: { wanted: modelSlug, got: actualModel } });
      }

      // Always pull the DOM text — the SSE interceptor may have missed
      // the URL pattern and the DOM is the authoritative final state.
      const domText = nativeState.report?.text ?? await readLatestAssistantText(page);
      if (nativeState.report) {
        emitter.push({ type: "tool", name: "native-research-report", meta: { model: nativeState.report.model, source: "widget_state", selectionBasis: "verified-ui-maximum", uiModel: "gpt-6-pro" } });
      }

      if (!emitter.isFinished()) {
        emitter.push({ type: "done", finalText: domText });
      }

      const finalEvent = collected
        .slice()
        .reverse()
        .find((e) => e.type === "done") as { finalText?: string } | undefined;
      const finalText = nativeState.report?.text ?? ((finalEvent?.finalText && finalEvent.finalText.length > 0)
        ? finalEvent.finalText
        : domText);

      const filing = conversationId && opts.gizmoId && opts.expectedAccountEmail
        ? await verifyFiling(page, conversationId, opts.gizmoId, opts.expectedAccountEmail)
        : undefined;
      if (filing) filing.preSubmitVerified = true;
      return { conversationId, finalText, events: collected, filing };
    } catch (err) {
      if (err instanceof ConnectorEvidenceRateLimitError && session && !cancelled) {
        // Stop this page's exact turn without turning the failure into a
        // successful cancellation or disturbing another daemon slot.
        await stopCurrentTurn(session.page).catch(() => "");
      }
      const message = (err as Error).message ?? String(err);
      emitter.push(err instanceof PreSubmitInteractionError
        ? {
            type: "error",
            message,
            code: err.code,
            phase: err.phase,
            promptSubmitted: err.promptSubmitted,
            // P-035 2026-09-27. The facade reads the reset date from THIS streamed
            // event, not from the daemon's later one, so a Pro usage limit carries
            // when Pro returns and the capped tooltip it read. Every other
            // pre-submit code keeps exactly today's event shape -- no new fields.
            ...(err.code === "pro_usage_limit_reached"
              ? { availableAfter: err.availableAfter ?? null, limitText: err.limitText ?? null }
              : {}),
          }
        : { type: "error", message });
      throw err;
    } finally {
      // Reset the active emitter so a stale binding doesn't leak into
      // the next turn on the same page (daemon mode).
      if (session) setActiveEmitter(session.page, null);
      if (closeOnFinish) {
        await session?.close().catch(() => {});
      }
    }
  })();

  const teed = teeEvents(emitter, collected);

  return {
    events: teed,
    result,
    async cancel(): Promise<void> {
      cancelled = true;
      if (closeOnFinish) {
        try {
          await session?.close();
        } catch {
          /* swallow */
        }
      } else if (session) {
        // The daemon owns the persistent browser context.  Stop only the
        // active ChatGPT turn so the warm profile remains usable.
        await stopCurrentTurn(session.page).catch(() => "");
      }
    },
  };
}

async function attachImages(page: Page, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  // Through the table, not a repeated literal: selectors.ts is the single place
  // a ChatGPT UI change is absorbed (P-035 2026-09-16).
  const inputs = page.locator(joinSelectors(SELECTORS_DUMP.fileUpload));
  const count = await inputs.count();
  if (count === 0) return;
  await inputs.first().setInputFiles(paths).catch(() => {
    /* ignore: composer may not accept this batch */
  });
  const settleMs = Number(process.env.CGPRO_UPLOAD_SETTLE_MS ?? 5_000);
  await page.waitForTimeout(settleMs);
}

async function* teeEvents(
  emitter: StreamEmitter,
  collected: StreamEvent[],
): AsyncIterable<StreamEvent> {
  for await (const ev of emitter) {
    collected.push(ev);
    yield ev;
  }
}
