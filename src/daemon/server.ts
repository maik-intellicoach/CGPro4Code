/**
 * Long-lived `cgpro` daemon — keeps a Chromium open + warm so that
 * subsequent `cgpro ask` calls don't pay the ~3-5s cold-start tax.
 *
 * Process lifecycle
 * -----------------
 *   1. `cgpro daemon start` spawns this module detached, with
 *      stdio redirected to ~/.cgpro/logs/daemon.log
 *   2. We open a browser session, verify the cookie jar is authenticated,
 *      then bind an HTTP server on 127.0.0.1:<random-port>.
 *   3. On `listen`, we write daemon.json (pid, port, token) so clients
 *      can find us. We accept Bearer-token auth on every protected route.
 *   4. POST /ask → text/event-stream of {delta,thinking,tool,done,error}.
 *      One ask in flight at a time; concurrent calls queue FIFO behind it
 *      (bounded depth + wait, C-092 / C-073 ADR003 p5). No parallel browser
 *      use — same single Chrome profile, one turn at a time.
 *   5. POST /shutdown closes the browser, deletes daemon.json, exits.
 *
 * Failure model
 * -------------
 *   - browser context dies → we exit with code 1 (the wrapper writes a
 *     log line; user re-runs `cgpro daemon start`). We don't try to
 *     resurrect the browser silently because cookie/auth state may
 *     have changed and a clean restart is the honest fix.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync, openSync, writeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSession, type Session } from "../browser/session.js";
import { fetchAuthSessionInPage, goHome, isLoggedIn } from "../browser/chatgpt.js";
import { detectPlan, fetchMe } from "../api/me.js";
import { fetchModels, findProSlug } from "../api/models.js";
import { runAskOnSession, type AskOptions } from "../core/orchestrator.js";
import { NotLoggedInError } from "../errors.js";
import {
  clearDaemonInfo,
  DAEMON_LOG,
  writeDaemonInfo,
  type DaemonInfo,
  type AskRequest,
  type StatusResponse,
} from "./protocol.js";

const log = makeLogger();

const QUEUE_MAX = Math.max(1, Number(process.env.CGPRO_DAEMON_QUEUE_MAX) || 4);
const QUEUE_MAX_WAIT_MS = Math.max(1, Number(process.env.CGPRO_DAEMON_QUEUE_MAX_WAIT_MS) || 7_200_000);

export class QueueFullError extends Error {
  constructor(public readonly depth: number) {
    super(`queue full at depth ${depth}`);
  }
}

export class QueueWaitTimeoutError extends Error {
  constructor() {
    super("queue wait timed out");
  }
}

export class QueueCancelledError extends Error {
  constructor() {
    super("queue wait cancelled by client disconnect");
  }
}

export class BodyTimeoutError extends Error {
  constructor() {
    super("body read timed out");
  }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("body exceeds max size");
  }
}

class BodyDisconnectedError extends Error {
  constructor() {
    super("client disconnected before body was fully read");
  }
}

// C-092 P-026 xfam r1 H1: bounds on receiving the /ask body — these run
// BEFORE queue admission, so a client that never finishes its body can
// never occupy a queue slot (see handleAsk). Exported for tests.
export const BODY_READ_TIMEOUT_MS = Math.max(1, Number(process.env.CGPRO_DAEMON_BODY_TIMEOUT_MS) || 30_000);
export const BODY_MAX_BYTES = Math.max(1, Number(process.env.CGPRO_DAEMON_BODY_MAX_BYTES) || 20 * 1024 * 1024);

// C-092 P-026 xfam r2 B1: bound only the PRE-response phase (receiving
// headers, then the request body) — Node clears both timers once the full
// request has arrived, so they never touch a long SSE response. The
// whole-connection idle timeout (`server.timeout`, applied in
// applyServerTimeouts) stays 0 so a quiet "thinking" gap mid-turn can't
// get killed.
export const HEADERS_TIMEOUT_MS = Math.max(1, Number(process.env.CGPRO_DAEMON_HEADERS_TIMEOUT_MS) || 60_000);
export const REQUEST_TIMEOUT_MS = Math.max(
  1,
  Number(process.env.CGPRO_DAEMON_REQUEST_TIMEOUT_MS) || HEADERS_TIMEOUT_MS + BODY_READ_TIMEOUT_MS + 30_000,
);

// C-092 P-026 xfam r2 B2: caps how many /ask bodies may be read
// concurrently BEFORE queue admission. Each reader can retain up to
// BODY_MAX_BYTES for up to BODY_READ_TIMEOUT_MS, so aggregate
// pre-admission memory is bounded to maxReaders * BODY_MAX_BYTES
// regardless of QUEUE_MAX (the queue guard only applies once a body has
// already been fully read — see handleAsk).
export class ReaderBudgetExceededError extends Error {
  constructor(public readonly active: number) {
    super(`pre-admission reader budget exceeded at ${active}`);
  }
}

export class PreAdmissionReaderBudget {
  private active = 0;
  constructor(private readonly maxReaders: number) {}

  get activeCount(): number {
    return this.active;
  }

  acquire(): void {
    if (this.active >= this.maxReaders) {
      throw new ReaderBudgetExceededError(this.active);
    }
    this.active++;
  }

  release(): void {
    if (this.active > 0) this.active--;
  }
}

export const PREADMIT_MAX_READERS = Math.max(1, Number(process.env.CGPRO_DAEMON_PREADMIT_MAX_READERS) || 4);

interface WaitingEntry {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Bounded FIFO admission for the single browser lane: one ask runs at a
 * time, later arrivals queue in order behind it. A new arrival is rejected
 * outright once the *waiting* line (not counting the one in flight) hits
 * maxDepth; a waiter that sits past maxWaitMs is rejected with a timeout
 * instead of running forever. An optional AbortSignal (wired to the
 * client's socket by the caller) lets a still-queued waiter cancel out
 * immediately on disconnect instead of holding its slot — and therefore
 * `depth` — until the timeout or its eventual (wasted) turn (C-092 F1).
 */
export class AskQueue {
  private waiting: WaitingEntry[] = [];
  private active = false;

  constructor(
    private readonly maxDepth: number,
    private readonly maxWaitMs: number,
  ) {}

  /** Requests currently waiting (excludes the one in flight, if any). */
  get depth(): number {
    return this.waiting.length;
  }

  /** True while an ask is running against the browser. */
  get busy(): boolean {
    return this.active;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (this.waiting.length >= this.maxDepth) {
      return Promise.reject(new QueueFullError(this.waiting.length));
    }
    if (signal?.aborted) {
      return Promise.reject(new QueueCancelledError());
    }
    return new Promise<void>((resolve, reject) => {
      const entry: WaitingEntry = {
        resolve,
        timer: setTimeout(() => {
          if (this.removeWaiting(entry)) reject(new QueueWaitTimeoutError());
        }, this.maxWaitMs),
        signal,
      };
      if (signal) {
        entry.onAbort = () => {
          if (this.removeWaiting(entry)) reject(new QueueCancelledError());
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.waiting.push(entry);
      this.pump();
    });
  }

  release(): void {
    this.active = false;
    this.pump();
  }

  /** Removes a still-waiting entry and clears its timer/listener. Returns
   * false if it was already dequeued (active or resolved by pump). */
  private removeWaiting(entry: WaitingEntry): boolean {
    const idx = this.waiting.indexOf(entry);
    if (idx < 0) return false;
    this.waiting.splice(idx, 1);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    return true;
  }

  private pump(): void {
    if (this.active || this.waiting.length === 0) return;
    const next = this.waiting.shift()!;
    clearTimeout(next.timer);
    if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
    this.active = true;
    next.resolve();
  }
}

// Exported for the HTTP-level integration test (C-092 P-026 r2).
export interface ServerState {
  session: Session;
  token: string;
  startedAt: Date;
  background: boolean;
  profile?: string;
  queue: AskQueue;
  readerBudget: PreAdmissionReaderBudget;
  currentConversation: string | null;
  lastConversation: string | null;
  account?: {
    email?: string;
    plan: string;
    proModelAvailable: boolean;
  };
}

// C-092 P-026 xfam r2 B1: extracted so a lightweight integration test can
// exercise the real timeout behavior against a bare http.Server, without
// needing the browser/session stack runDaemonServer depends on.
//
// `server.headersTimeout`/`server.requestTimeout` are set below for
// defense-in-depth, but the ACTUAL enforcement is the manual
// `socket.setTimeout()` on each raw connection: a standalone repro
// against this runtime (Node v26.5.0) showed the built-in properties
// (set either post-construction or via the createServer() options
// object) never fire — not even after 6s against a 150ms/2000ms
// config — while `net.Socket#setTimeout()` fires reliably both stand
// alone and inside an http.Server's "connection" handler. Ground-truth
// over recall: don't rely on a built-in that verifiably does nothing
// here. The bound is re-armed after each response finishes so a
// reused keep-alive connection's NEXT request headers are covered too.
export function applyServerTimeouts(server: import("node:http").Server): void {
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  // Whole-connection idle timeout and keep-alive linger stay disabled —
  // long Pro turns may stream text sporadically across the SSE channel,
  // and we'd rather rely on waitTurnComplete's deadline than the
  // http.Server killing the response.
  server.timeout = 0;
  server.keepAliveTimeout = 0;

  server.on("connection", (socket) => {
    socket.setTimeout(HEADERS_TIMEOUT_MS, () => socket.destroy());
  });
  server.on("request", (req, res) => {
    // Headers are fully parsed once "request" fires — release the
    // header-phase bound so it can't kill a (separately app-bounded)
    // slow body read or a long-running SSE response.
    req.socket.setTimeout(0);
    res.on("finish", () => {
      if (!req.socket.destroyed) {
        req.socket.setTimeout(HEADERS_TIMEOUT_MS, () => req.socket.destroy());
      }
    });
  });
}

export interface DaemonServerOptions {
  /** Stay in the foreground (don't redirect stdio). Used in dev. */
  foreground?: boolean;
  background?: boolean;
  profile?: string;
  /** Force a port instead of letting the OS pick. */
  port?: number;
}

export async function runDaemonServer(opts: DaemonServerOptions = {}): Promise<void> {
  log.info(`daemon-server starting (pid=${process.pid})`);

  const session = await openSession({
    headed: true, // we always need a real Chromium fingerprint
    profilePath: opts.profile,
    background: opts.background ?? true,
  });

  log.info("session open, going home…");
  await goHome(session.page);
  if (!(await isLoggedIn(session.page, 8_000))) {
    log.error("not logged in — refusing to start daemon");
    await session.close().catch(() => {});
    throw new NotLoggedInError();
  }
  const auth = await fetchAuthSessionInPage(session.page);
  const [me, models] = await Promise.all([
    fetchMe(session.page, auth?.accessToken),
    fetchModels(session.page, auth?.accessToken),
  ]);
  const proModelAvailable = findProSlug(models) !== null;
  const detectedPlan = detectPlan(me);
  const account = {
    email: me?.email ?? auth?.user?.email,
    // ChatGPT currently omits a plan label for this account while returning
    // the authenticated Pro model catalogue. The entitlement is the stronger
    // capability fact; never promote a known non-Pro label.
    plan: detectedPlan === "unknown" && proModelAvailable ? "pro" : detectedPlan,
    proModelAvailable,
  };
  log.info("auth verified, starting http listener");

  const state: ServerState = {
    session,
    token: randomBytes(32).toString("hex"),
    startedAt: new Date(),
    background: opts.background ?? true,
    profile: opts.profile,
    queue: new AskQueue(QUEUE_MAX, QUEUE_MAX_WAIT_MS),
    readerBudget: new PreAdmissionReaderBudget(PREADMIT_MAX_READERS),
    currentConversation: null,
    lastConversation: null,
    account,
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, state).catch((err: unknown) => {
      log.error(`unhandled: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  });
  applyServerTimeouts(server);

  // Bind on loopback only; the token covers same-host adversaries.
  server.listen(opts.port ?? 0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const info: DaemonInfo = {
      version: 1,
      pid: process.pid,
      port,
      token: state.token,
      startedAt: state.startedAt.toISOString(),
      profile: opts.profile,
      background: opts.background ?? true,
    };
    writeDaemonInfo(info);
    log.info(`listening on 127.0.0.1:${port}`);
  });

  // Graceful shutdown on common signals.
  const shutdown = async (signal: string): Promise<never> => {
    log.info(`received ${signal} — shutting down`);
    server.close();
    await session.close().catch(() => {});
    clearDaemonInfo();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1/");
  const method = req.method ?? "GET";

  // Healthz is the only un-authed route — clients use it to confirm
  // "this port belongs to a cgpro daemon" before sending the token.
  if (method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ daemon: "cgpro", version: 1, queueDepth: state.queue.depth }));
    return;
  }

  if (!hasValidToken(req, state.token)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (method === "GET" && url.pathname === "/status") {
    const status: StatusResponse = {
      pid: process.pid,
      startedAt: state.startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - state.startedAt.getTime()) / 1000),
      background: state.background,
      profile: state.profile,
      busy: state.queue.busy,
      account: state.account,
      currentConversation: state.currentConversation,
      lastConversation: state.lastConversation,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  if (method === "POST" && url.pathname === "/shutdown") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      log.info("shutdown requested via /shutdown");
      void state.session.close().catch(() => {});
      clearDaemonInfo();
      process.exit(0);
    }, 50);
    return;
  }

  if (method === "POST" && url.pathname === "/ask") {
    await handleAsk(req, res, state);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

// Exported for the HTTP-level integration test (C-092 P-026 r2 test-gap
// concession) — not part of the public daemon API otherwise.
export async function handleAsk(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
): Promise<void> {
  // C-092 P-026 xfam r1 H1: the body must be fully received and validated
  // BEFORE we ever touch the queue. Server-level request timeouts are
  // disabled (long Pro turns need that), so an authenticated client that
  // sends headers then stalls the body used to hold its admitted slot
  // indefinitely once it reached queue.acquire(). Bounding this read here
  // means a stalled/oversized/malformed body is rejected without ever
  // consuming a slot.
  // C-092 P-026 xfam r2 B2: bound how many bodies may be read concurrently
  // BEFORE queue admission — the queue guard below only applies once a
  // body has already been fully read, so without this a burst of
  // concurrent authenticated requests could each retain BODY_MAX_BYTES
  // for up to BODY_READ_TIMEOUT_MS with no aggregate ceiling.
  try {
    state.readerBudget.acquire();
  } catch (err) {
    if (err instanceof ReaderBudgetExceededError) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "reader_budget_exceeded", active: err.active }));
      return;
    }
    throw err;
  }

  let body: AskRequest | null;
  try {
    body = await readJsonBody<AskRequest>(req);
  } catch (err) {
    if (err instanceof BodyTimeoutError) {
      res.writeHead(408, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body_timeout" }));
      return;
    }
    if (err instanceof BodyTooLargeError) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body_too_large" }));
      return;
    }
    // BodyDisconnectedError — client is already gone, nothing to respond to.
    return;
  } finally {
    state.readerBudget.release();
  }

  if (!body || typeof body.prompt !== "string" || body.prompt.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_request" }));
    return;
  }

  // Watch for the client disconnecting WHILE queued (before acquire()
  // resolves) — nothing else observes req/res during that window, so a
  // gone client used to hold its slot until dequeue or the maxWaitMs
  // timer, corrupting queueDepth (C-092 F1). Only needed pre-acquire:
  // once active, the existing res.on("close") below covers disconnects.
  const disconnectController = new AbortController();
  const onEarlyDisconnect = (): void => disconnectController.abort();
  req.on("close", onEarlyDisconnect);
  req.on("aborted", onEarlyDisconnect);
  try {
    await state.queue.acquire(disconnectController.signal);
  } catch (err) {
    if (err instanceof QueueFullError) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "queue_full", depth: err.depth }));
      return;
    }
    if (err instanceof QueueWaitTimeoutError) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "queue_wait_timeout" }));
      return;
    }
    if (err instanceof QueueCancelledError) {
      // Client is already gone — nothing left to write a response to.
      return;
    }
    throw err;
  } finally {
    req.off("close", onEarlyDisconnect);
    req.off("aborted", onEarlyDisconnect);
  }

  try {
    // 4 hours upper bound — covers the longest GPT-5.5 Pro turns we've
    // seen in practice. Browser-side stays alive because the daemon owns
    // the persistent context and Node's http.Server has no inactivity
    // timeout once response headers are sent.
    const timeoutSec = Math.max(10, Math.min(14_400, body.timeoutSec ?? 7_200));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const askOpts: AskOptions = {
      prompt: body.prompt,
      model: body.model,
      web: body.web,
      images: body.images ?? [],
      conversationId: body.conversationId,
      timeoutSec,
      headless: false,
      background: state.background,
      profile: state.profile,
    };

    const runner = runAskOnSession(askOpts, state.session);

    const writeEvent = (event: string, data: unknown): void => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Client disconnected — keep going so the conversation lands cleanly.
      }
    };

    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
    });

    try {
      for await (const ev of runner.events) {
        if (ev.type === "started" && ev.conversationId) {
          state.currentConversation = ev.conversationId;
        }
        if (!clientGone) writeEvent(ev.type, ev);
      }
      const summary = await runner.result;
      state.lastConversation = summary.conversationId ?? state.currentConversation;
      if (!clientGone) {
        writeEvent("summary", {
          conversationId: summary.conversationId,
          finalText: summary.finalText,
        });
        res.end();
      }
    } catch (err) {
      log.error(`ask turn failed: ${(err as Error).message}`);
      if (!clientGone) {
        writeEvent("error", { message: (err as Error).message });
        res.end();
      }
    } finally {
      state.currentConversation = null;
    }
  } finally {
    state.queue.release();
  }
}

function hasValidToken(req: IncomingMessage, token: string): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return false;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // constant-time-ish equality; the token is hex so length is fixed
  if (m[1].length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= m[1].charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

function readJsonBody<T>(
  req: IncomingMessage,
  timeoutMs: number = BODY_READ_TIMEOUT_MS,
  maxBytes: number = BODY_MAX_BYTES,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => settle(() => reject(new BodyTimeoutError())), timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
      req.off("aborted", onClose);
    };
    function settle(run: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      run();
    }

    const onData = (chunk: string): void => {
      bytes += Buffer.byteLength(chunk, "utf-8");
      if (bytes > maxBytes) {
        settle(() => reject(new BodyTooLargeError()));
        return;
      }
      buf += chunk;
    };
    const onEnd = (): void => {
      if (buf.length === 0) {
        settle(() => resolve(null));
        return;
      }
      try {
        const parsed = JSON.parse(buf) as T;
        settle(() => resolve(parsed));
      } catch {
        settle(() => resolve(null));
      }
    };
    const onError = (): void => settle(() => resolve(null));
    // Fires on a normal completed upload too, but only AFTER "end" has
    // already settled us (verified: Node emits close after data/end on a
    // healthy request) — settle() is a no-op past the first call, so this
    // never cancels a request that finished sending its body.
    const onClose = (): void => settle(() => reject(new BodyDisconnectedError()));

    req.setEncoding("utf-8");
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
    req.on("aborted", onClose);
  });
}

function makeLogger(): { info: (m: string) => void; error: (m: string) => void } {
  try {
    mkdirSync(dirname(DAEMON_LOG), { recursive: true });
  } catch {
    /* swallow */
  }
  const fd = (() => {
    try {
      return openSync(DAEMON_LOG, "a");
    } catch {
      return -1;
    }
  })();
  const write = (level: string, m: string): void => {
    // Lanes 1 and 2 share DAEMON_LOG (C-092 F6, advisory) — prefix each
    // line with the daemon's own pid so interleaved lane output stays
    // attributable without needing a per-lane log file.
    const line = `${new Date().toISOString()} [pid=${process.pid}] [${level}] ${m}\n`;
    if (fd >= 0) {
      try {
        writeSync(fd, line);
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      appendFileSync(DAEMON_LOG, line);
    } catch {
      /* swallow */
    }
  };
  return {
    info: (m) => write("info", m),
    error: (m) => write("error", m),
  };
}
