/**
 * HTTP+SSE client for the cgpro daemon. Mirrors the `AskRunner` shape
 * exported by `core/orchestrator.ts` so callers (the `ask` and `chat`
 * commands) can swap between cold-start and daemon mode without
 * branching their stream-handling logic.
 */

import { request } from "node:http";
import { CgproError } from "../errors.js";
import { StreamEmitter, type StreamEvent } from "../core/stream.js";
import {
  pidIsAlive,
  readDaemonInfo,
  type AskRequest,
  type AskSummary,
  type DaemonInfo,
  type ReloadResponse,
  type StatusResponse,
} from "./protocol.js";
import { profileDir } from "../store/paths.js";
import type { AskOptions, AskResult, AskRunner } from "../core/orchestrator.js";

// Bounded retry for HTTP 429 ("queue full") against the daemon's bounded
// FIFO — small and capped so a persistently-full queue still fails
// promptly instead of hanging the caller (C-092 F5).
export interface RetryPolicy {
  maxAttempts: number;
  totalBudgetMs: number;
  backoffMs: (attempt: number) => number;
}

// Injectable so tests can swap in a near-instant policy instead of
// sleeping through real backoff delays; production callers get this
// default via askViaDaemon's optional third parameter.
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  totalBudgetMs: 60_000,
  backoffMs: (attempt) => Math.min(2 ** attempt * 500, 15_000),
};

function sleep(ms: number, token?: CancelToken): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    token?.onCancel(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Lets cancel() interrupt an in-flight backoff sleep instead of only
// destroying the current httpReq (which no-ops between attempts) — the
// AskRunner.cancel() contract must stop the retry loop promptly even
// while it's asleep between a 429 and the next attempt (C-092 P-026 r3 G2).
class CancelToken {
  private cancelled = false;
  private listeners: Array<() => void> = [];

  get isCancelled(): boolean {
    return this.cancelled;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners) listener();
    this.listeners = [];
  }

  onCancel(cb: () => void): void {
    if (this.cancelled) {
      cb();
      return;
    }
    this.listeners.push(cb);
  }
}

/**
 * Throw a clear error if the daemon owns the cgpro profile. Cold-start
 * commands (`status`, `models`, `doctor`, `adopt`, `login`, `logout`,
 * `chat`, `thread sync`) all `launchPersistentContext` against the same
 * profile dir as the daemon — Chromium's process-singleton lock makes
 * those mutually exclusive. Surface that to the user instead of letting
 * them see `ProfileLockedError`.
 */
// C-092 P-026 xfam r1 H6: the daemon holds a lock on the browser profile
// directory it was started against, not on "any profile" — a live daemon
// on profile A never conflicts with a cold-start command targeting a
// different profile B. Both sides are normalized through profileDir() so
// `undefined` (the default profile) compares equal to itself regardless
// of which call site left it unset.
export async function assertNoDaemon(commandName: string, targetProfile?: string): Promise<void> {
  const live = await getLiveDaemon();
  if (!live) return;
  if (profileDir(live.profile) !== profileDir(targetProfile)) return;
  throw new CgproError(
    `\`cgpro ${commandName}\` cannot run while the daemon owns the profile.`,
    8,
    "Stop the daemon first: `cgpro daemon stop`",
  );
}

/**
 * Returns the daemon connection if a live daemon is running on this
 * box, else null. Cleans up stale daemon.json files (orphan pid +
 * unreachable port) so subsequent calls don't keep retrying them.
 */
export async function getLiveDaemon(): Promise<DaemonInfo | null> {
  const info = readDaemonInfo();
  if (!info) return null;
  if (!pidIsAlive(info.pid)) return null;
  const ok = await healthCheck(info, 800);
  if (!ok) return null;
  return info;
}

async function healthCheck(info: DaemonInfo, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: info.port,
        path: "/healthz",
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        // Drain so the socket frees.
        res.resume();
        resolve((res.statusCode ?? 0) === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function getDaemonStatus(info: DaemonInfo): Promise<StatusResponse | null> {
  return await jsonRequest<StatusResponse>(info, "GET", "/status", null);
}

export async function requestDaemonReload(
  info: DaemonInfo,
  conversationId?: string,
): Promise<ReloadResponse | null> {
  return await jsonRequest<ReloadResponse>(info, "POST", "/reload", conversationId ? { conversationId } : {});
}

export async function shutdownDaemon(info: DaemonInfo): Promise<boolean> {
  const r = await jsonRequest<{ ok: boolean }>(info, "POST", "/shutdown", {});
  return r?.ok === true;
}

function jsonRequest<T>(
  info: DaemonInfo,
  method: string,
  path: string,
  body: unknown,
): Promise<T | null> {
  return new Promise((resolve) => {
    const payload = body === null ? undefined : JSON.stringify(body);
    const req = request(
      {
        hostname: "127.0.0.1",
        port: info.port,
        path,
        method,
        timeout: 5_000,
        headers: {
          Authorization: `Bearer ${info.token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) return resolve(null);
          try {
            resolve(JSON.parse(buf) as T);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Talks to the daemon's POST /ask endpoint, parses the SSE response,
 * and exposes the same `AskRunner` shape as `runAsk` so callers can
 * stay agnostic.
 */
type AttemptOutcome =
  | { kind: "success"; result: AskResult }
  | { kind: "retry"; message: string }
  | { kind: "fatal"; error: Error };

export function askViaDaemon(
  info: DaemonInfo,
  opts: AskOptions,
  retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
): AskRunner {
  const emitter = new StreamEmitter();
  const collected: StreamEvent[] = [];
  let summary: AskSummary | null = null;
  let httpReq: ReturnType<typeof request> | null = null;
  const cancelToken = new CancelToken();

  const askBody: AskRequest = {
    prompt: opts.prompt,
    model: opts.model,
    web: opts.web,
    images: opts.images,
    conversationId: opts.conversationId,
    timeoutSec: opts.timeoutSec,
  };
  const payload = JSON.stringify(askBody);

  function attemptOnce(): Promise<AttemptOutcome> {
    return new Promise((resolve) => {
      httpReq = request(
        {
          hostname: "127.0.0.1",
          port: info.port,
          path: "/ask",
          method: "POST",
          // Generous read window: GPT-5.5 Pro can think for many minutes.
          timeout: Math.max(60_000, (opts.timeoutSec + 30) * 1_000),
          headers: {
            Authorization: `Bearer ${info.token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            Accept: "text/event-stream",
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status === 429) {
            res.resume();
            resolve({ kind: "retry", message: "daemon queue is full" });
            return;
          }
          if (status === 504) {
            res.resume();
            resolve({ kind: "fatal", error: new Error("daemon queue wait timed out") });
            return;
          }
          if (status === 409) {
            // Dead branch against the current server (never returns 409 —
            // see AskQueue in daemon/server.ts), kept only so an old
            // still-running daemon gets a graceful message instead of
            // falling into the generic >=400 body-read branch below.
            res.resume();
            resolve({ kind: "fatal", error: new Error("daemon is busy with another turn") });
            return;
          }
          if (status >= 400) {
            let buf = "";
            res.setEncoding("utf-8");
            res.on("data", (c) => (buf += c));
            res.on("end", () => {
              const msg = buf.length > 0 ? buf : `daemon returned ${status}`;
              resolve({ kind: "fatal", error: new Error(msg) });
            });
            return;
          }
          consumeSseStream(res, (event, data) => {
            if (event === "summary") {
              summary = data as AskSummary;
              return;
            }
            // The server emits the same event names as our StreamEvent union.
            // Validate the type before pushing.
            const ev = data as StreamEvent;
            if (ev && typeof ev.type === "string") {
              emitter.push(ev);
            }
          }).then(() => {
            const finalText = summary?.finalText ?? extractFinalText(collected);
            const conversationId = summary?.conversationId ?? null;
            if (!emitter.isFinished()) {
              emitter.push({ type: "done", finalText });
            }
            resolve({ kind: "success", result: { conversationId, finalText, events: collected } });
          }).catch((err) => {
            resolve({ kind: "fatal", error: err as Error });
          });
        },
      );
      httpReq.on("error", (err) => resolve({ kind: "fatal", error: err as Error }));
      httpReq.on("timeout", () => {
        httpReq?.destroy();
        resolve({ kind: "fatal", error: new Error("daemon request timed out") });
      });
      httpReq.write(payload);
      httpReq.end();
    });
  }

  const result: Promise<AskResult> = (async () => {
    const deadline = Date.now() + retryPolicy.totalBudgetMs;
    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
      if (cancelToken.isCancelled) {
        emitter.push({ type: "error", message: "cancelled" });
        return { conversationId: null, finalText: "", events: collected };
      }
      const outcome = await attemptOnce();
      if (outcome.kind === "success") return outcome.result;
      if (outcome.kind === "fatal") {
        emitter.push({ type: "error", message: outcome.error.message });
        return { conversationId: null, finalText: "", events: collected };
      }
      const remaining = deadline - Date.now();
      if (attempt === retryPolicy.maxAttempts || remaining <= 0) {
        emitter.push({ type: "error", message: `${outcome.message} — giving up after ${attempt} attempt(s)` });
        return { conversationId: null, finalText: "", events: collected };
      }
      await sleep(Math.min(retryPolicy.backoffMs(attempt), remaining), cancelToken);
    }
    // Unreachable (loop always returns), kept for TS control-flow analysis.
    emitter.push({ type: "error", message: "daemon queue is full" });
    return { conversationId: null, finalText: "", events: collected };
  })();

  return {
    events: teeEvents(emitter, collected),
    result,
    async cancel(): Promise<void> {
      cancelToken.cancel();
      try {
        httpReq?.destroy();
      } catch {
        /* swallow */
      }
    },
  };
}

async function consumeSseStream(
  res: NodeJS.ReadableStream,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    res.setEncoding("utf-8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseSseBlock(block);
        if (parsed) onEvent(parsed.event, parsed.data);
      }
    });
    res.on("end", () => resolve());
    res.on("error", (err: Error) => reject(err));
  });
}

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

function extractFinalText(events: StreamEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "done" && ev.finalText) return ev.finalText;
  }
  let buf = "";
  for (const ev of events) {
    if (ev.type === "delta") buf += ev.text;
  }
  return buf;
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
