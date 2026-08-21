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
  setWebSearch,
  waitTurnComplete,
} from "../browser/conversation.js";
import {
  setActiveEmitter,
  StreamEmitter,
  type StreamEvent,
} from "./stream.js";
import { NotLoggedInError } from "../errors.js";
import { SELECTORS as SELECTORS_DUMP } from "../browser/selectors.js";
import { fetchLatestTurnToolNames } from "../api/conversations.js";

export interface AskOptions {
  prompt: string;
  model?: string;
  web?: boolean;
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

  const result: Promise<AskResult> = (async () => {
    if (!session) {
      session = await openSession({
        headed: !opts.headless,
        profilePath: opts.profile,
        background: opts.background,
      });
    }
    setActiveEmitter(session.context, emitter);
    try {
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

      if (opts.web !== undefined) {
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
      const priorBubbles = await sendPrompt(page, opts.prompt, opts.connector !== undefined);
      log(`sendPrompt done (priorBubbles=${priorBubbles}), url=${page.url()}`);

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
            log(
              `state: url=${url} composer=${composerCount} send=${sendCount} bubbles=${bubbleCount} composerText=${JSON.stringify(composerText.slice(0, 80))}`,
            );
          } catch (diagnosticErr) {
            log(`debug diagnostics unavailable: ${(diagnosticErr as Error).message}`);
          }
        }
        if (!cancelled) throw err;
      }
      log(`waitTurnComplete done, url=${page.url()}`);

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
        const observedNames = new Set(
          collected.filter((event) => event.type === "tool").map((event) => event.name),
        );
        const conversationToolNames = await fetchLatestTurnToolNames(page, conversationId);
        for (const name of conversationToolNames) {
          if (observedNames.has(name)) continue;
          observedNames.add(name);
          emitter.push({ type: "tool", name, meta: { source: "latest-conversation-turn" } });
        }
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
      // In cold-start mode we own the session, so killing it cancels.
      // In daemon mode we just stop streaming; the daemon decides what
      // to do with the in-flight turn.
      if (closeOnFinish) {
        try {
          await session?.close();
        } catch {
          /* swallow */
        }
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
