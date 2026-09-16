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
 *      One ask in flight per slot (CGPRO_DAEMON_SLOTS, default 1: one tab,
 *      one turn at a time); concurrent calls queue FIFO behind them
 *      (bounded depth + wait, C-092 / C-073 ADR003 p5). Extra slots are
 *      further tabs in the same Chrome profile (P-035 D23.0).
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
import type { Page } from "patchright";
import { openSession, type Session } from "../browser/session.js";
import { fetchAuthSessionInPage, goHome, isLoggedIn } from "../browser/chatgpt.js";
import {
  currentConversationId,
  openConversation,
  readLatestAssistantText,
  turnIsWorking,
} from "../browser/conversation.js";
import { detectPlan, fetchMe, type MeResponse } from "../api/me.js";
import { archiveSavedConversation } from "../api/conversation-filing.js";
import { fetchModels, findProSlug, type ChatgptModel } from "../api/models.js";
import {
  runAskOnSession,
  runInteractionPreflight,
  type AskOptions,
  type AskRunner,
} from "../core/orchestrator.js";
import { NotLoggedInError, PreSubmitInteractionError, SelectorBrokenError } from "../errors.js";
import { SELECTORS } from "../browser/selectors.js";
import {
  clearDaemonInfo,
  DAEMON_FILE,
  DAEMON_LOG,
  writeDaemonInfo,
  type DaemonInfo,
  type AskRequest,
  type InteractionStatus,
  type PreflightRequest,
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
 * Bounded FIFO admission for the browser lanes: up to `capacity` asks run
 * at once (one per slot, default 1), later arrivals queue in order behind
 * them. A new arrival is rejected
 * outright once the *waiting* line (not counting the one in flight) hits
 * maxDepth; a waiter that sits past maxWaitMs is rejected with a timeout
 * instead of running forever. An optional AbortSignal (wired to the
 * client's socket by the caller) lets a still-queued waiter cancel out
 * immediately on disconnect instead of holding its slot — and therefore
 * `depth` — until the timeout or its eventual (wasted) turn (C-092 F1).
 */
export class AskQueue {
  private waiting: WaitingEntry[] = [];
  private active = 0;

  constructor(
    private readonly maxDepth: number,
    private readonly maxWaitMs: number,
    private readonly capacity = 1,
  ) {}

  /** Requests currently waiting (excludes the one in flight, if any). */
  get depth(): number {
    return this.waiting.length;
  }

  /** True while every slot is running an ask (no free capacity). */
  get busy(): boolean {
    return this.active >= this.capacity;
  }

  tryAcquire(): boolean {
    if (this.busy || this.waiting.length > 0) return false;
    this.active++;
    return true;
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
    if (this.active > 0) this.active--;
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
    while (!this.busy && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      clearTimeout(next.timer);
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      this.active++;
      next.resolve();
    }
  }
}

/** One tab the daemon can run a turn on (P-035 D23.0). */
export interface SlotState {
  id: number;
  /** Slot 0 drives `session.page`; higher slots are created lazily and dropped once closed or crashed. */
  page: Page | null;
  /** Leased by an /ask, /preflight, /archive-saved or idle /reload. */
  busy: boolean;
  /**
   * Which handler holds the lease. A slot that is busy with no invocation and
   * no queue entry used to be indistinguishable from a live turn, and the
   * idle-only restart guard refused the lane for a reason that was not true
   * (P-035 2026-09-16).
   */
  leasedBy: string | null;
  askInFlight: boolean;
  currentInvocation: string | null;
  currentRunner: AskRunner | null;
  currentConversation: string | null;
  lastConversation: string | null;
  reloadConversation: string | null;
  interaction: InteractionStatus;
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
  // Slot 0's turn state lives on the server state itself (the shape the
  // facade tests build); slotsOf() exposes it as slots[0].
  askInFlight: boolean;
  currentInvocation: string | null;
  currentRunner: AskRunner | null;
  currentConversation: string | null;
  lastConversation: string | null;
  reloadConversation: string | null;
  interaction: InteractionStatus;
  account?: {
    email?: string;
    plan: string;
    proModelAvailable: boolean;
  };
  /** CGPRO_DAEMON_SLOTS clamped to 1..4; absent means 1. */
  maxSlots?: number;
  slots?: SlotState[];
  /** Slot whose turn finished most recently (status lastConversation, bare /reload). */
  lastFinishedSlot?: number;
}

export function daemonSlotCount(raw = process.env.CGPRO_DAEMON_SLOTS): number {
  return Math.min(4, Math.max(1, Math.trunc(Number(raw)) || 1));
}

export function createServerState(
  session: Session,
  opts: DaemonServerOptions,
  account?: ServerState["account"],
): ServerState {
  const maxSlots = daemonSlotCount();
  return {
    session,
    token: randomBytes(32).toString("hex"),
    startedAt: new Date(),
    background: opts.background ?? true,
    profile: opts.profile,
    queue: new AskQueue(QUEUE_MAX, QUEUE_MAX_WAIT_MS, maxSlots),
    readerBudget: new PreAdmissionReaderBudget(PREADMIT_MAX_READERS),
    askInFlight: false,
    currentInvocation: null,
    currentRunner: null,
    currentConversation: null,
    lastConversation: null,
    reloadConversation: null,
    interaction: { state: "unknown" },
    account,
    maxSlots,
  };
}

/** Slot 0 as a view over the server state's own turn fields. */
function slotZero(state: ServerState): SlotState {
  return {
    id: 0,
    busy: false,
    leasedBy: null,
    get page() { return state.session.page; },
    get askInFlight() { return state.askInFlight; },
    set askInFlight(v) { state.askInFlight = v; },
    get currentInvocation() { return state.currentInvocation; },
    set currentInvocation(v) { state.currentInvocation = v; },
    get currentRunner() { return state.currentRunner; },
    set currentRunner(v) { state.currentRunner = v; },
    get currentConversation() { return state.currentConversation; },
    set currentConversation(v) { state.currentConversation = v; },
    get lastConversation() { return state.lastConversation; },
    set lastConversation(v) { state.lastConversation = v; },
    get reloadConversation() { return state.reloadConversation; },
    set reloadConversation(v) { state.reloadConversation = v; },
    get interaction() { return state.interaction; },
    set interaction(v) { state.interaction = v; },
  };
}

export function slotsOf(state: ServerState): SlotState[] {
  state.slots ??= [
    slotZero(state),
    ...Array.from({ length: (state.maxSlots ?? 1) - 1 }, (_, i): SlotState => ({
      id: i + 1,
      page: null,
      busy: false,
      leasedBy: null,
      askInFlight: false,
      currentInvocation: null,
      currentRunner: null,
      currentConversation: null,
      lastConversation: null,
      reloadConversation: null,
      interaction: { state: "unknown" },
    })),
  ];
  return state.slots;
}

/** Leases the lowest free slot. Callers hold queue capacity first, so one is always free. */
function leaseSlot(state: ServerState, reason: string): SlotState {
  const slot = slotsOf(state).find((s) => !s.busy);
  if (!slot) throw new Error("no free slot despite free capacity");
  slot.busy = true;
  slot.leasedBy = reason;
  log.info(`slot leased slot=${slot.id} by=${reason}`);
  return slot;
}

/**
 * Releases a lease and says why, so a lease and its release pair up in the log
 * instead of leaving an absence to interpret (P-035 2026-09-16). Additive: the
 * flag is cleared exactly as before.
 */
function releaseSlot(slot: SlotState, reason: string): void {
  slot.busy = false;
  slot.leasedBy = null;
  log.info(`slot released slot=${slot.id} by=${reason}`);
}

/** The slot's page; slots 1..N-1 are opened on first use with the daemon start checks. */
async function slotPage(state: ServerState, slot: SlotState): Promise<Page> {
  if (slot.id === 0) return state.session.page;
  if (slot.page && !slot.page.isClosed()) return slot.page;
  const page = await state.session.context.newPage();
  try {
    await goHome(page);
    if (!(await isLoggedIn(page, 8_000))) throw new NotLoggedInError();
  } catch (err) {
    await page.close().catch(() => undefined);
    throw err;
  }
  page.once("crash", () => {
    if (slot.page === page) slot.page = null;
  });
  slot.page = page;
  return page;
}

/** What a runner sees as its session: the daemon session for slot 0, a page-bound view otherwise. */
function slotSession(state: ServerState, slot: SlotState, page: Page): Session {
  if (slot.id === 0) return state.session;
  return {
    context: state.session.context,
    page,
    close: async () => {
      throw new Error("slot sessions are not closable");
    },
  };
}

/** Conversation of the slot's in-flight turn: the first stream event, else the page URL. */
function activeConversation(slot: SlotState): string | null {
  return slot.currentConversation ?? (slot.askInFlight && slot.page ? currentConversationId(slot.page) : null);
}

const INTERACTION_RANK: Record<InteractionStatus["state"], number> = { unknown: 0, ready: 1, degraded: 2 };

/** Worst-of across slots: degraded > ready > unknown; the latest checkedAt wins a tie. */
function worstInteraction(slots: SlotState[]): InteractionStatus {
  return slots.map((s) => s.interaction).reduce((worst, next) => {
    const rank = INTERACTION_RANK[next.state] - INTERACTION_RANK[worst.state];
    return rank > 0 || (rank === 0 && (next.checkedAt ?? "") > (worst.checkedAt ?? "")) ? next : worst;
  });
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

export async function fetchDaemonAccountCapabilities(
  page: Page,
  attempts = 3,
  fetchers: {
    me: (page: Page) => Promise<MeResponse | null>;
    models: (page: Page) => Promise<ChatgptModel[]>;
  } = { me: fetchMe, models: fetchModels },
): Promise<{ me: MeResponse | null; models: ChatgptModel[] }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const [me, models] = await Promise.all([
        fetchers.me(page),
        fetchers.models(page),
      ]);
      return { me, models };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await page.waitForTimeout(1_000);
    }
  }
  throw lastError;
}

export async function closeDaemonSessionBeforeExit(
  session: Session,
  exit: (code: number) => never = process.exit,
): Promise<never> {
  await closeDaemonSession(session);
  return exit(0);
}

export async function closeDaemonSession(session: Session): Promise<void> {
  await session.close();
  clearDaemonInfo(process.pid);
}

export async function runDaemonServer(opts: DaemonServerOptions = {}): Promise<void> {
  log.info(`daemon-server starting (pid=${process.pid})`);

  const session = await openSession({
    headed: true, // we always need a real Chromium fingerprint
    profilePath: opts.profile,
    background: opts.background ?? true,
  });

  let account: { email?: string; plan: string; proModelAvailable: boolean };
  try {
    log.info("session open, going home…");
    await goHome(session.page);
    if (!(await isLoggedIn(session.page, 8_000))) {
      log.error("not logged in — refusing to start daemon");
      throw new NotLoggedInError();
    }
    const auth = await fetchAuthSessionInPage(session.page);
    const { me, models } = await fetchDaemonAccountCapabilities(session.page);
    const proModelAvailable = findProSlug(models) !== null;
    const detectedPlan = detectPlan(me);
    account = {
      email: me?.email ?? auth?.user?.email,
      // ChatGPT currently omits a plan label for this account while returning
      // the authenticated Pro model catalogue. The entitlement is the stronger
      // capability fact; never promote a known non-Pro label.
      plan: detectedPlan === "unknown" && proModelAvailable ? "pro" : detectedPlan,
      proModelAvailable,
    };
  } catch (error) {
    // A failed pre-listener probe used to terminate Node while Chrome still
    // owned the persistent profile. Chrome then marked the profile as crashed
    // and showed "Restore pages?" on the next start.
    await session.close().catch(() => {});
    throw error;
  }
  log.info("auth verified, starting http listener");

  const state = createServerState(session, opts, account);

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
    log.info(`listening on 127.0.0.1:${port} slots=${state.maxSlots}`);
  });

  // Graceful shutdown on common signals.
  const shutdown = async (signal: string): Promise<never> => {
    // Attribution (P-035 2026-09-16): the signal name alone cannot say
    // whether a live turn was killed or who asked. The parent pid is the
    // sender in the common cases (launchd, a shell, a supervisor), and the
    // in-flight count says what was lost.
    const inFlight = slotsOf(state).filter((slot) => slot.busy).length;
    log.info(
      `received ${signal} file=${DAEMON_FILE} ppid=${process.ppid} in_flight=${inFlight} — shutting down`,
    );
    server.close();
    return closeDaemonSessionBeforeExit(session);
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
    const slots = slotsOf(state);
    const busySlots = slots.filter((s) => s.busy).length;
    const status: StatusResponse = {
      pid: process.pid,
      startedAt: state.startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - state.startedAt.getTime()) / 1000),
      background: state.background,
      profile: state.profile,
      busy: state.queue.busy,
      account: state.account,
      currentConversation: slots.find((s) => s.currentConversation !== null)?.currentConversation ?? null,
      lastConversation: slots[state.lastFinishedSlot ?? 0].lastConversation,
      interaction: worstInteraction(slots),
      slots: {
        total: slots.length,
        busy: busySlots,
        free: slots.length - busySlots,
        items: slots.map((s) => ({
          slot: s.id,
          busy: s.busy,
          leasedBy: s.leasedBy,
          invocationId: s.currentInvocation,
          conversationId: s.currentConversation,
          interaction: s.interaction,
        })),
      },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  if (method === "POST" && url.pathname === "/shutdown") {
    // Attribution (P-035 2026-09-16): a stop at 07:22 could not be traced
    // to any caller, and the registration file is the only thing that says
    // which lane a runtime belongs to. File, caller header, peer address and
    // the in-flight count are recorded before the session closes. Those fields
    // are best-effort — a missing header or socket only makes the log less
    // informative. The one thing that can refuse is an unforced stop while a
    // page is leased, below.
    const callerHeader = req.headers["x-cgpro-caller"];
    const caller = typeof callerHeader === "string" && callerHeader ? callerHeader : "-";
    const remote = req.socket?.remoteAddress ?? "-";
    const inFlight = slotsOf(state).filter((slot) => slot.busy).length;
    const forceHeader = req.headers["x-cgpro-force"];
    const forced = typeof forceHeader === "string" && forceHeader === "1";
    const busy = slotsOf(state).filter((slot) => slot.busy);
    // P-035 2026-09-16 (Maik approved): a raw stop that carried a live turn is
    // the incident this room keeps having. The governed helper waits for idle
    // and then stops, but a caller that skips the wait used to end the turn.
    // The route now refuses while any page is leased unless the caller says
    // force, and names the holder so a stuck lease is distinguishable from a
    // live turn. Forcing stays available for a wedged lane.
    if (busy.length > 0 && !forced) {
      log.info(
        `STOP refused via /shutdown file=${DAEMON_FILE} caller=${caller} remote=${remote} in_flight=${busy.length} holders=${busy.map((slot) => `${slot.id}:${slot.leasedBy ?? "unknown"}`).join(",")}`,
      );
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "lane_busy",
        in_flight: busy.length,
        holders: busy.map((slot) => ({ slot: slot.id, leasedBy: slot.leasedBy, invocationId: slot.currentInvocation })),
        force_hint: "resend with header x-cgpro-force: 1 to stop anyway",
      }));
      return;
    }
    log.info(
      `shutdown accepted via /shutdown file=${DAEMON_FILE} caller=${caller} remote=${remote} in_flight=${inFlight} forced=${forced}`,
    );
    // Do not acknowledge until the persistent browser has closed. The old
    // fire-and-exit path let the caller start a replacement against the same
    // profile while Chrome was still winding down, leaving crash markers and
    // the recurring "Restore pages?" bubble.
    await closeDaemonSession(state.session);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      process.exit(0);
    }, 50);
    return;
  }

  if (method === "POST" && url.pathname === "/cancel") {
    let body: { invocationId?: string } | null;
    try {
      body = await readJsonBody<{ invocationId?: string }>(req);
    } catch (err) {
      const status = err instanceof BodyTimeoutError ? 408 : err instanceof BodyTooLargeError ? 413 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: status === 408 ? "body_timeout" : status === 413 ? "body_too_large" : "invalid_request" }));
      return;
    }
    const invocationId = body?.invocationId?.trim() ?? "";
    if (!invocationId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_invocation_id" }));
      return;
    }
    const slot = slotsOf(state).find((s) => s.askInFlight && s.currentInvocation === invocationId);
    const runner = slot?.currentRunner;
    if (!slot || !runner) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invocation_not_active" }));
      return;
    }
    await runner.cancel();
    // Do not acknowledge cancellation while the original /ask handler can
    // still report this slot as busy. Its terminal result closes the event
    // stream and lets that handler clear askInFlight in its existing finally.
    await runner.result.catch(() => undefined);
    const partialText = await readLatestAssistantText(slot.page!).catch(() => "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      invocationId,
      conversationId: slot.currentConversation,
      partialText,
    }));
    return;
  }

  if (method === "POST" && url.pathname === "/ask") {
    await handleAsk(req, res, state);
    return;
  }

  if (method === "POST" && url.pathname === "/preflight") {
    let body: PreflightRequest | null;
    try {
      state.readerBudget.acquire();
    } catch {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "reader_budget_exceeded" }));
      return;
    }
    try {
      try {
        body = await readJsonBody<PreflightRequest>(req);
      } catch (error) {
        const status = error instanceof BodyTooLargeError ? 413
          : error instanceof BodyTimeoutError ? 408
            : 400;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_preflight_request" }));
        return;
      }
    } finally {
      state.readerBudget.release();
    }
    if (!body || body.model !== "gpt-6-pro" || typeof body.connector !== "string" || !body.connector.trim() ||
        typeof body.gizmoId !== "string" || !/^g-p-[A-Za-z0-9_-]+$/.test(body.gizmoId) ||
        (body.gizmoShortUrl !== undefined && !/^[A-Za-z0-9_-]+$/.test(body.gizmoShortUrl)) ||
        typeof body.expectedAccountEmail !== "string" || body.expectedAccountEmail.length > 320 ||
        !body.expectedAccountEmail.includes("@")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_preflight_identity" }));
      return;
    }
    if (!state.queue.tryAcquire()) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "lane_busy" }));
      return;
    }
    const slot = leaseSlot(state, "preflight");
    try {
      const result = await runInteractionPreflight(body, slotSession(state, slot, await slotPage(state, slot)));
      slot.interaction = { state: "ready", checkedAt: new Date().toISOString() };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      slot.interaction = {
        state: "degraded",
        checkedAt: new Date().toISOString(),
        ...(error instanceof PreSubmitInteractionError ? { failureCode: error.code } : {}),
      };
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "interaction_preflight_failed",
        ...(error instanceof PreSubmitInteractionError ? { code: error.code, phase: error.phase } : {}),
      }));
    } finally {
      releaseSlot(slot, "preflight");
      state.queue.release();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/archive-saved") {
    let body: { conversationId: string; projectId: string; expectedEmail: string; fingerprint: string } | null;
    try {
      state.readerBudget.acquire();
    } catch {
      res.writeHead(429); res.end(JSON.stringify({ error: "reader_budget_exceeded" })); return;
    }
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: "invalid_request" })); return;
    } finally { state.readerBudget.release(); }
    if (!body || typeof body.conversationId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.conversationId) ||
        typeof body.projectId !== "string" ||
        !/^g-p-[A-Za-z0-9_-]+$/.test(body.projectId ?? "") ||
        typeof body.expectedEmail !== "string" || body.expectedEmail.length > 320 || !body.expectedEmail.includes("@") ||
        typeof body.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.fingerprint ?? "")) {
      res.writeHead(400); res.end(JSON.stringify({ error: "invalid_archive_identity" })); return;
    }
    if (!state.queue.tryAcquire()) {
      res.writeHead(409); res.end(JSON.stringify({ error: "lane_busy" })); return;
    }
    const slot = leaseSlot(state, "archive");
    try {
      const filing = await archiveSavedConversation(await slotPage(state, slot), body);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(filing));
    } catch (error) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (error as Error).message }));
    } finally { releaseSlot(slot, "archive"); state.queue.release(); }
    return;
  }

  if (method === "POST" && url.pathname === "/reload") {
    let body: { conversationId?: string } | null;
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
    try {
      body = await readJsonBody<{ conversationId?: string }>(req);
    } catch (err) {
      const status = err instanceof BodyTimeoutError ? 408 : err instanceof BodyTooLargeError ? 413 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: status === 408 ? "body_timeout" : status === 413 ? "body_too_large" : "invalid_request" }));
      return;
    } finally {
      state.readerBudget.release();
    }
    const requested = body?.conversationId?.trim();
    if (requested && !/^[0-9a-f-]{36}$/i.test(requested)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_conversation_id" }));
      return;
    }
    const slots = slotsOf(state);
    // The slot whose in-flight turn is on the requested conversation (with
    // no id: the first slot with a turn in flight) picks the reload up at
    // its next poll.
    const owner = requested
      ? slots.find((s) => activeConversation(s) === requested)
      : slots.find((s) => activeConversation(s) !== null);
    if (owner) {
      const current = activeConversation(owner)!;
      owner.currentConversation = current;
      owner.reloadConversation = current;
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, conversationId: current, queued: true }));
      return;
    }
    // Idle path: the slot that last ran the conversation, else the slot that
    // finished most recently (slot 0 until any turn has run).
    const slot = (requested && slots.find((s) => s.lastConversation === requested)) ||
      slots[state.lastFinishedSlot ?? 0];
    const current = activeConversation(slot);
    if (current) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "conversation_mismatch", currentConversation: current }));
      return;
    }

    const target = requested || slot.lastConversation;
    if (!target) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no_conversation" }));
      return;
    }
    if (slot.busy || !state.queue.tryAcquire()) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "current_conversation_pending" }));
      return;
    }
    slot.busy = true;
    slot.leasedBy = "reload-inner";
    log.info(`slot leased slot=${slot.id} by=reload-inner`);
    try {
      const page = await slotPage(state, slot);
      await openConversation(page, { conversationId: target });
      const working = await turnIsWorking(page);
      const finalText = working ? "" : await readLatestAssistantText(page);
      slot.lastConversation = target;
      state.lastFinishedSlot = slot.id;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, conversationId: target, queued: false, working, finalText }));
    } finally {
      releaseSlot(slot, "reload-inner");
      state.queue.release();
    }
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
  if (
    (body.gizmoId !== undefined && (
      typeof body.gizmoId !== "string" || !/^g-p-[A-Za-z0-9_-]+$/.test(body.gizmoId)
    )) ||
    (body.gizmoShortUrl !== undefined && (
      typeof body.gizmoShortUrl !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.gizmoShortUrl)
    )) || (body.expectedAccountEmail !== undefined &&
      (typeof body.expectedAccountEmail !== "string" || body.expectedAccountEmail.length > 320 || !body.expectedAccountEmail.includes("@")))
  ) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_project_identity" }));
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

  const slot = leaseSlot(state, "ask");
  slot.askInFlight = true;
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
      deepResearch: body.deepResearch === true,
      connector: typeof body.connector === "string" ? body.connector : undefined,
      images: body.images ?? [],
      conversationId: body.conversationId,
      gizmoId: body.gizmoId,
      expectedAccountEmail: body.expectedAccountEmail,
      gizmoShortUrl: body.gizmoShortUrl,
      timeoutSec,
      invocationId: typeof body.invocationId === "string" ? body.invocationId : undefined,
      headless: false,
      background: state.background,
      profile: state.profile,
      consumeReload: () => {
        if (!slot.reloadConversation || slot.reloadConversation !== slot.currentConversation) return null;
        const conversationId = slot.reloadConversation;
        slot.reloadConversation = null;
        return conversationId;
      },
    };

    const writeEvent = (event: string, data: unknown): void => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Client disconnected — keep going so the conversation lands cleanly.
      }
    };

    let clientGone = false;
    let connectorVerified = body.connector === undefined;
    res.on("close", () => {
      clientGone = true;
    });

    try {
      // A slot whose tab must first be opened (slots 1..N-1) fails here on a
      // login check, so it takes the same error event path as the turn.
      const runner = runAskOnSession(askOpts, slotSession(state, slot, await slotPage(state, slot)));
      slot.currentInvocation = askOpts.invocationId ?? null;
      slot.currentRunner = runner;
      for await (const ev of runner.events) {
        if (ev.type === "started" && ev.conversationId) {
          slot.currentConversation = ev.conversationId;
        }
        if (!clientGone) writeEvent(ev.type, ev);
        if (ev.type === "tool" && ev.name === "connector-selected") connectorVerified = true;
        if (ev.type === "tool" && ev.name === "model-thinking-verified" && connectorVerified) {
          slot.interaction = { state: "ready", checkedAt: new Date().toISOString() };
        }
        if (ev.type === "error" && ev.promptSubmitted === false && ev.code) {
          slot.interaction = {
            state: "degraded",
            checkedAt: new Date().toISOString(),
            failureCode: ev.code,
          };
        }
      }
      const summary = await runner.result;
      slot.lastConversation = summary.conversationId ?? slot.currentConversation;
      state.lastFinishedSlot = slot.id;
      if (!clientGone) {
        writeEvent("summary", {
          conversationId: summary.conversationId,
          finalText: summary.finalText,
          filing: summary.filing,
        });
        res.end();
      }
    } catch (err) {
      slot.lastConversation = slot.currentConversation ?? slot.lastConversation;
      state.lastFinishedSlot = slot.id;
      // Every failed turn now names its lane, slot, invocation and page, and
      // a selector failure carries what the DOM actually looked like. Without
      // this the 2026-09-16 planning-lane incident was undiagnosable after the
      // fact: the log said "selector broke" and nothing else.
      log.error(
        `ask turn failed: ${(err as Error).message} slot=${slot.id} ` +
        `invocation=${slot.currentInvocation ?? "-"} url=${slot.page?.url() ?? "-"}`,
      );
      if (err instanceof SelectorBrokenError && slot.page && !slot.page.isClosed()) {
        const diagnostic = await describeSelectorState(slot.page).catch(() => "unavailable");
        log.error(`selector diagnostic: ${diagnostic}`);
      }
      if (!clientGone) {
        writeEvent("error", err instanceof PreSubmitInteractionError
          ? {
              message: err.message,
              code: err.code,
              phase: err.phase,
              promptSubmitted: err.promptSubmitted,
            }
          : { message: (err as Error).message });
        res.end();
      }
    } finally {
      slot.reloadConversation = null;
      slot.currentConversation = null;
      slot.currentInvocation = null;
      slot.currentRunner = null;
    }
  } finally {
    slot.askInFlight = false;
    releaseSlot(slot, "ask");
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

/**
 * A bounded, content-free picture of the page at the moment a selector gate
 * failed: what resolves, what is visible, and which surface is mounted. It
 * names selectors and counts only -- never page text.
 */
async function describeSelectorState(page: Page): Promise<string> {
  const groups: Array<[string, string[]]> = [
    ["composer", SELECTORS.composer],
    ["projectsNavigation", SELECTORS.projectsNavigation],
    ["projectRows", SELECTORS.projectRows],
    ["chatTabRadio", SELECTORS.chatTabRadio],
  ];
  const parts: string[] = [];
  for (const [name, candidates] of groups) {
    const counts: string[] = [];
    for (const candidate of candidates.slice(0, 6)) {
      const count = await page.locator(candidate).count().catch(() => -1);
      counts.push(`${candidate}=${count}`);
    }
    parts.push(`${name}[${counts.join(" ")}]`);
  }
  const editables = await page.locator('[contenteditable="true"]').count().catch(() => -1);
  const rows = await page.locator('[role="row"]').count().catch(() => -1);
  return `${parts.join(" ")} contenteditable=${editables} roleRow=${rows}`
    .slice(0, 2000);
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
