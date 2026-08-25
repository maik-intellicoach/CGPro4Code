import type { Page } from "patchright";
import { openSession, type Session } from "../browser/session.js";
import { goHome, isLoggedIn } from "../browser/chatgpt.js";
import {
  currentConversationId,
  latestAssistantModelSlug,
  openConversation,
  readLatestAssistantText,
  sendPrompt,
  setConnector,
  setDeepResearch,
  setWebSearch,
  stopCurrentTurn,
  waitTurnComplete,
} from "../browser/conversation.js";
import {
  setActiveEmitter,
  StreamEmitter,
  type StreamEvent,
} from "./stream.js";
import { NotLoggedInError } from "../errors.js";
import { SELECTORS as SELECTORS_DUMP } from "../browser/selectors.js";
import { fetchLatestTurnConnectorState, fetchLatestTurnToolCalls } from "../api/conversations.js";

const CONNECTOR_EVIDENCE_POLL_MS = 30_000;
const CONNECTOR_EVIDENCE_RATE_LIMIT_BACKOFF_MS = 120_000;

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
}

export interface AskResult {
  conversationId: string | null;
  finalText: string;
  events: StreamEvent[];
}

export interface AskRunner {
  events: AsyncIterable<StreamEvent>;
  result: Promise<AskResult>;
  cancel: () => Promise<void>;
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
  let lastConnectorEvidencePollAt = 0;
  let connectorEvidenceBackoffUntil = 0;
  let connectorEvidencePollInFlight: Promise<void> | null = null;

  const result: Promise<AskResult> = (async () => {
    if (!session) {
      session = await openSession({
        headed: !opts.headless,
        profilePath: opts.profile,
        background: opts.background,
      });
    }
    setActiveEmitter(session.context, emitter, opts.connector);
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

      if (opts.deepResearch) {
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
        emitter.push({ type: "tool", name: "connector-selected", meta: { connector: opts.connector } });
      }

      await attachImages(page, opts.images ?? []);

      log("sendPrompt…");
      const priorBubbles = await sendPrompt(page, opts.prompt, opts.connector !== undefined, () => cancelled);
      if (opts.connector !== undefined && !cancelled) {
        emitter.push({ type: "tool", name: "prompt-submitted", meta: { connector: opts.connector } });
      }
      log(`sendPrompt done (priorBubbles=${priorBubbles}), url=${page.url()}`);

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
        const conversationId = currentConversationId(page) ??
          (started?.type === "started" ? started.conversationId ?? null : null);
        if (!conversationId) return;
        if (!force) lastConnectorEvidencePollAt = now;
        let calls;
        try {
          calls = await fetchLatestTurnToolCalls(
            page,
            conversationId,
            opts.connector,
            force ? 10_000 : 1_000,
          );
        } catch (err) {
          if (force) throw err;
          if (err instanceof Error && err.message.includes("HTTP 429")) {
            connectorEvidenceBackoffUntil = Date.now() + CONNECTOR_EVIDENCE_RATE_LIMIT_BACKOFF_MS;
          }
          return;
        }
        for (const call of calls) {
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
        if (force) {
          if (connectorEvidencePollInFlight) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2_500);
              connectorEvidencePollInFlight?.catch(() => undefined).finally(() => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
          await runConnectorEvidencePoll(true);
          return;
        }
        if (connectorEvidencePollInFlight) return;
        connectorEvidencePollInFlight = runConnectorEvidencePoll(false)
          .finally(() => { connectorEvidencePollInFlight = null; });
      };

      const confirmConnectorCompletion = async (): Promise<boolean> => {
        if (opts.connector === undefined || cancelled) return true;
        const started = collected.find((event) => event.type === "started");
        const conversationId = currentConversationId(page) ??
          (started?.type === "started" ? started.conversationId ?? null : null);
        if (!conversationId) return false;
        const state = await fetchLatestTurnConnectorState(
          page,
          conversationId,
          opts.connector,
          10_000,
        );
        return state.currentRole === "assistant" &&
          state.currentStatus === "finished_successfully" &&
          state.currentEndTurn === true &&
          state.currentContentType === "text" &&
          !state.currentIsThinkingPreamble;
      };

      // Wait for the turn to settle. The SSE interceptor will normally push
      // a `done` event; if the network missed (cached response, schema we
      // didn't recognize), we fall back to DOM detection.
      log(`waitTurnComplete (timeout ${opts.timeoutSec}s)…`);
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
          pollEvidence: () => pollConnectorEvidence(false),
          confirmComplete: confirmConnectorCompletion,
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
        if (!cancelled) throw err;
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
      const actualModel = await latestAssistantModelSlug(page);
      log(`actualModel=${actualModel ?? "(unknown)"} conv=${conversationId ?? "(none)"}`);

      if (opts.connector !== undefined && conversationId) {
        await pollConnectorEvidence(true);
      }

      // GPT-5.5 Pro is policy. If the bubble's model slug doesn't include
      // "pro", warn loudly to stderr — the user almost certainly wanted
      // Pro and got the regular Thinking model. Common cause: the model
      // picker silently kept the chat's previous default, or the project
      // we navigated into pinned a non-Pro model.
      const wantedPro = (modelSlug ?? "").toLowerCase().includes("pro");
      const gotPro = (actualModel ?? "").toLowerCase().includes("pro");
      if (wantedPro && !gotPro) {
        const msg =
          `cgpro asked for "${modelSlug}" but the response came from "${actualModel ?? "unknown"}" — ` +
          `the model picker did not switch. Common causes: project default model overrides, ` +
          `or a stale conversation that resumed with its previous model.`;
        console.error(`[cgpro:model] ⚠ ${msg}`);
        emitter.push({ type: "tool", name: "model-mismatch", meta: { wanted: modelSlug, got: actualModel } });
      }

      // Always pull the DOM text — the SSE interceptor may have missed
      // the URL pattern and the DOM is the authoritative final state.
      const domText = await readLatestAssistantText(page);

      if (!emitter.isFinished()) {
        emitter.push({ type: "done", finalText: domText });
      }

      const finalEvent = collected
        .slice()
        .reverse()
        .find((e) => e.type === "done") as { finalText?: string } | undefined;
      const finalText = (finalEvent?.finalText && finalEvent.finalText.length > 0)
        ? finalEvent.finalText
        : domText;

      return { conversationId, finalText, events: collected };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      emitter.push({ type: "error", message });
      throw err;
    } finally {
      // Reset the active emitter so a stale binding doesn't leak into
      // the next turn on the same context (daemon mode).
      if (session) setActiveEmitter(session.context, null);
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
  const inputs = page.locator('input[type="file"]');
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
