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
import { dirname, join } from "node:path";
import type { Page } from "patchright";
import { openSession, parkWindow, showWindow, type Session } from "../browser/session.js";
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
  type InteractionPreflightPhase,
  type AskOptions,
  type AskRunner,
} from "../core/orchestrator.js";
import { classifyInteractionFailure, type InteractionFailure, NotLoggedInError, PreSubmitInteractionError, SelectorBrokenError } from "../errors.js";
import { SELECTORS, TURN_CRITICAL_SELECTORS, type SelectorSet } from "../browser/selectors.js";
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

/** The largest prompt /preflight will deliver-and-discard; real prompts run well under this. */
const PROBE_PROMPT_MAX_CHARS = 200_000;
// Reserve ten seconds inside the callers' existing 150s / 300s ceilings.
const PREFLIGHT_TIMEOUT_MS = 140_000;
const PROBE_PREFLIGHT_TIMEOUT_MS = 290_000;
const PREFLIGHT_CLOSE_TIMEOUT_MS = 10_000;
// The preflight diagnostic budget stays where it was (3s): the daemon-slots
// quarantine test's timing depends on it, and its whole point is a prompt 409.
const PREFLIGHT_DIAGNOSTIC_TIMEOUT_MS = 3_000;
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
  /**
   * When `account` was last read from the page (ms epoch). P-035 2026-09-21:
   * the probe used to run only once, at startup, so a lane whose entitlement
   * changed mid-life kept serving the old answer until its next restart. This
   * is what `/status` consults to decide whether to re-read.
   */
  accountProbedAt?: number;
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
    accountProbedAt: account ? Date.now() : undefined,
    maxSlots,
  };
}

/**
 * How long a cached capability probe may answer `/status` before it is re-read.
 *
 * P-035 2026-09-21. `proModelAvailable` gates routing to a paid lane, and it was
 * read exactly once, at daemon start: a lane could run for days on an
 * entitlement that had since been revoked. The refresh rides `/status` -- the
 * one place the value is served -- rather than adding a per-turn API call, and
 * the ceiling is 45 minutes so an hourly observer, or any consumer polling less
 * often than that, always sees a value at most one poll old.
 */
const ACCOUNT_PROBE_TTL_MS = Math.max(
  60_000,
  Number(process.env.CGPRO_ACCOUNT_PROBE_TTL_MS ?? 45 * 60_000) || 45 * 60_000,
);

type DaemonAccount = NonNullable<ServerState["account"]>;

/** Read the account's capability facts from the page this daemon already holds. */
async function probeAccountCapabilities(page: Page): Promise<DaemonAccount> {
  return (await readAccountCapabilities(page)).account;
}

/**
 * The capability read, plus whether it is EVIDENCE at all.
 *
 * P-035 2026-09-21, caught by a test rather than in production. A failed read and
 * a genuine revocation have the same shape: `proModelAvailable: false`. The
 * first refresh I wrote accepted either, so one transient blip would have
 * rewritten an entitled lane as unentitled and taken it out of routing --
 * a failed read turned into a fact, which is the same defect this project has
 * been unwinding all week, pointing the other way. `proved` is what lets the
 * refresh keep the previous answer instead.
 */
async function readAccountCapabilities(
  page: Page,
): Promise<{ account: DaemonAccount; proved: boolean }> {
  const auth = await fetchAuthSessionInPage(page);
  const { me, models } = await fetchDaemonAccountCapabilities(page);
  const proModelAvailable = findProSlug(models) !== null;
  const detectedPlan = detectPlan(me);
  const email = me?.email ?? auth?.user?.email;
  return {
    account: {
      email,
      // ChatGPT currently omits a plan label for this account while returning
      // the authenticated Pro model catalogue. The entitlement is the stronger
      // capability fact; never promote a known non-Pro label.
      plan: detectedPlan === "unknown" && proModelAvailable ? "pro" : detectedPlan,
      proModelAvailable,
    },
    // An authenticated identity AND a model catalogue that actually came back.
    // Either missing means this read says nothing about the account.
    proved: Boolean(email) && models.length > 0,
  };
}

/** Slot 0 as a view over the server state's own turn fields. */
function slotZero(state: ServerState): SlotState {
  return {
    id: 0,
    busy: false,
    leasedBy: null,
    get page() { return state.session.page; },
    set page(page: Page | null) { if (page) state.session.page = page; },
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

/**
 * P-035 2026-09-21. The window posture follows the work.
 *
 * A lane's window must be minimised while the lane is idle -- four of them at once
 * must never appear in front of Maik -- but a minimised window is not drawn, and
 * the page inside it then crawls and sometimes never renders: measured on one lane
 * at 415x on `project-chat-surface` and 1600x on `project-navigation-lookup`
 * against the same page un-minimised. Hiding and rendering are disjoint on this
 * stack (minimising starves the page; headless is Cloudflare-challenged), so the
 * window is shown while its slot is leased and parked the moment it is released.
 *
 * Best-effort by construction. A posture that failed is strictly better than a
 * daemon that refused a turn, so this never throws and never blocks: it is fired
 * without await, on the same rule the diagnostics follow -- telemetry and posture
 * never gate capacity. Lanes started in front (`--no-background`, CGPRO_VISIBLE=1)
 * are already visible and are left alone; one of those being parked on release
 * would hide the very window Maik asked to see.
 */
function applyWorkPosture(state: ServerState, slot: SlotState, show: boolean): void {
  if (!state.background) return;
  const page = slot.page;
  if (!page || page.isClosed()) return;
  let work: Promise<void>;
  try {
    const context = page.context();
    work = show ? showWindow(context, page) : parkWindow(context, page);
  } catch {
    // A lease must never fail because its window could not be touched.
    return;
  }
  void work.catch(() => undefined);
}

/** Leases the lowest free slot. Callers hold queue capacity first, so one is always free. */
function leaseSlot(state: ServerState, reason: string): SlotState {
  const slot = slotsOf(state).find((s) => !s.busy);
  if (!slot) throw new Error("no free slot despite free capacity");
  slot.busy = true;
  slot.leasedBy = reason;
  applyWorkPosture(state, slot, true);
  log.info(`slot leased slot=${slot.id} by=${reason}`);
  return slot;
}

/**
 * Releases a lease and says why, so a lease and its release pair up in the log
 * instead of leaving an absence to interpret (P-035 2026-09-16). Additive: the
 * flag is cleared exactly as before.
 */
function releaseSlot(state: ServerState, slot: SlotState, reason: string): void {
  slot.busy = false;
  slot.leasedBy = null;
  applyWorkPosture(state, slot, false);
  log.info(`slot released slot=${slot.id} by=${reason}`);
}

/** The slot's page; slots 1..N-1 are opened on first use with the daemon start checks. */
async function slotPage(
  state: ServerState,
  slot: SlotState,
  capture?: (page: Page) => void,
): Promise<Page> {
  if (slot.page && !slot.page.isClosed()) {
    capture?.(slot.page);
    return slot.page;
  }
  const page = await state.session.context.newPage();
  // Publish ownership before navigation/authentication, which may themselves hang.
  slot.page = page;
  capture?.(page);
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

  // Headed by default: the long-standing claim is that chatgpt.com challenges
  // headless Chromium even with a warmed profile. That claim carries no test
  // date and predates Chrome 132 removing the separate headless shell, so
  // CGPRO_HEADLESS=1 exists to MEASURE it on one lane at a time. Absent the
  // env var nothing changes. Screening evidence must cover several separate
  // launches and a long turn before anyone considers moving the default; one
  // lucky pass is not evidence (P-035 D23.s14, 2026-09-17).
  const headless = process.env.CGPRO_HEADLESS === "1";
  const session = await openSession({
    headed: !headless,
    profilePath: opts.profile,
    background: opts.background ?? true,
  });
  if (headless) log.info("launched HEADLESS (CGPRO_HEADLESS=1) - screening mode, not the default");

  let account: { email?: string; plan: string; proModelAvailable: boolean };
  try {
    log.info("session open, going home…");
    await goHome(session.page);
    // Chromium still prefixes the product with "Headless" when the headless
    // switch is set, so the UA is the single cheapest fingerprint fact worth
    // having in the log. Recorded on every start, not only headless ones: a
    // baseline you did not capture before the change is not a baseline.
    const userAgent = await session.page
      .evaluate(() => navigator.userAgent)
      .catch(() => "unreadable");
    log.info(`userAgent=${userAgent}`);
    if (!(await isLoggedIn(session.page, 8_000))) {
      // "not logged in" is where this daemon refuses to start, and on its own
      // it cannot tell apart an expired profile, an anonymous /api/auth/session
      // and an edge challenge holding the page. isLoggedIn already polled for
      // 8s, so slowness is not the explanation by the time we get here; say
      // what was actually on the page instead of leaving the next reader to
      // guess. Every probe is best-effort: diagnostics must not mask the
      // original refusal.
      const url = session.page.url();
      const title = await session.page.title().catch(() => "unreadable");
      const probe = await fetchAuthSessionInPage(session.page).catch(() => null);
      const identity = probe?.user?.id ? `user_id=${probe.user.id}` : "no user in session payload";
      log.error(
        `not logged in — refusing to start daemon (url=${url} title="${title}" ${identity})`,
      );
      throw new NotLoggedInError();
    }
    account = await probeAccountCapabilities(session.page);
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

  // P-035 2026-09-16: a selector audit that runs on the page this process
  // already holds. `cgpro doctor` opens its own browser against the profile and
  // could not authenticate on a profile this daemon authenticates on, so it
  // audited the login page and reported every selector broken. Counting is
  // read-only -- no click, no type -- so it is safe beside a live turn, and the
  // in-flight count is returned so a caller knows what it audited.
  if (method === "GET" && url.pathname === "/selectors") {
    const slots = slotsOf(state);
    const page = slots.map((slot) => slot.page).find((candidate): candidate is Page => candidate != null && !candidate.isClosed());
    if (!page) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no_page", detail: "no slot holds an open page" }));
      return;
    }
    const results: Array<{ key: string; candidates: string[]; firstWorking: number }> = [];
    for (const key of Object.keys(SELECTORS) as Array<keyof SelectorSet>) {
      const candidates = SELECTORS[key];
      let firstWorking = -1;
      for (let i = 0; i < candidates.length; i++) {
        try {
          const count = await page.locator(candidates[i]).first().count();
          if (count > 0) {
            firstWorking = i;
            break;
          }
        } catch {
          /* try next */
        }
      }
      results.push({ key: key.toString(), candidates, firstWorking });
    }
    const inFlight = slots.filter((slot) => slot.busy).length;
    // A bare lane page legitimately resolves fewer than half of these keys: no
    // conversation is open, no tools popover, no Projects directory. Only a
    // TURN_CRITICAL_SELECTORS miss is drift, so the caller can act on it
    // (P-035 2026-09-16).
    const missingCritical = results
      .filter((result) => result.firstWorking === -1)
      .map((result) => result.key)
      .filter((key) => TURN_CRITICAL_SELECTORS.some((critical) => critical.toString() === key));
    const fallback = results.filter((result) => result.firstWorking > 0).length;
    const resolved = results.filter((result) => result.firstWorking === 0).length;
    // P-035 2026-09-21. Every unresolved key on a live page has two readings --
    // "the page is not the app" and "the audit ran before the app rendered" --
    // and they are indistinguishable from the counts alone. The identity read
    // says which, so a reading taken mid-load cannot be mistaken for a finding.
    const pageIdentity = await withTimeout(describePageIdentity(page), IDENTITY_TIMEOUT_MS, "page identity timed out");
    log.info(
      `selector audit served file=${DAEMON_FILE} in_flight=${inFlight} ` +
        `resolved=${resolved}/${results.length} absent=${results.length - resolved - fallback} ` +
        `fallback=${fallback} critical_missing=${missingCritical.length} ${pageIdentity}`,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true, inFlight, results, critical: TURN_CRITICAL_SELECTORS, missingCritical, pageIdentity,
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/status") {
    const slots = slotsOf(state);
    const busySlots = slots.filter((s) => s.busy).length;
    // P-035 2026-09-21. Re-read the capability facts when they are stale, and
    // only while the lane is provably idle: the probe drives the page this
    // daemon holds, and `/status` is polled every five minutes by the watchdog,
    // so it must never contend with a live turn. A failed re-read keeps the
    // previous answer and says so -- `/status` staying available matters more
    // than it being fresh, and the staleness is then bounded by the next poll.
    if (
      state.account &&
      typeof state.accountProbedAt === "number" &&
      busySlots === 0 &&
      !state.queue.busy &&
      !state.askInFlight &&
      Date.now() - state.accountProbedAt > ACCOUNT_PROBE_TTL_MS
    ) {
      try {
        const refreshed = await readAccountCapabilities(state.session.page);
        if (refreshed.proved) {
          state.account = refreshed.account;
          state.accountProbedAt = Date.now();
          log.info(
            `account capability refreshed profile=${state.profile ?? "default"} ` +
              `pro_model_available=${state.account.proModelAvailable}`,
          );
        } else {
          // A read that cannot be told apart from a failed one is not evidence.
          // Keep the previous answer and leave the clock running, so the next
          // poll tries again rather than waiting out another full TTL.
          log.error("account capability refresh returned no readable session or catalogue; keeping the previous answer");
        }
      } catch (error) {
        log.error(`account capability refresh failed: ${(error as Error).message}`);
      }
    }
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
        `STOP refused via /shutdown file=${DAEMON_FILE} caller=${caller} remote=${remote} in_flight=${busy.length} queued=${state.queue.depth} holders=${busy.map((slot) => `${slot.id}:${slot.leasedBy ?? "unknown"}`).join(",")}`,
      );
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "lane_busy",
        in_flight: busy.length,
        // Waiting requests hold no page, so they cannot appear as holders. They
        // are recorded because a waiter only exists while every page is busy:
        // the lease test above already covers them, and this says so.
        queued: state.queue.depth,
        holders: busy.map((slot) => ({ slot: slot.id, leasedBy: slot.leasedBy, invocationId: slot.currentInvocation })),
        force_hint: "resend with header x-cgpro-force: 1 to stop anyway",
      }));
      return;
    }
    log.info(
      `shutdown accepted via /shutdown file=${DAEMON_FILE} caller=${caller} remote=${remote} in_flight=${inFlight} queued=${state.queue.depth} forced=${forced}`,
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
        !body.expectedAccountEmail.includes("@") ||
        (body.probePrompt !== undefined
          && (typeof body.probePrompt !== "string" || body.probePrompt.length > PROBE_PROMPT_MAX_CHARS))
        || (body.probeDeliveryPath !== undefined
          && body.probeDeliveryPath !== "paste" && body.probeDeliveryPath !== "typed")) {
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
    let phase: InteractionPreflightPhase | "slot-page" = "slot-page";
    let failedPhase: InteractionPreflightPhase | undefined;
    let failure: InteractionFailure | undefined;
    const startedAt = performance.now();
    let phaseStartedAt = startedAt;
    let stoppedAt: number | undefined;
    const timeline: Array<{ phase: InteractionPreflightPhase | "slot-page"; startedMs: number; durationMs: number }> = [
      { phase, startedMs: 0, durationMs: 0 },
    ];
    let activeTiming: typeof timeline[number] | undefined = timeline[0];
    let timelineTruncated = false;
    const freezeTiming = (): void => {
      stoppedAt ??= performance.now();
      if (activeTiming) activeTiming.durationMs = Math.round(stoppedAt - phaseStartedAt);
    };
    let cancelled: "interaction_preflight_timeout" | "interaction_preflight_disconnected" | undefined;
    let signalCancel!: () => void;
    const cancellation = new Promise<void>((resolve) => { signalCancel = resolve; });
    const cancel = (reason: typeof cancelled): void => {
      freezeTiming();
      cancelled ??= reason;
      signalCancel();
    };
    const onDisconnect = (): void => cancel("interaction_preflight_disconnected");
    res.once("close", onDisconnect);
    if (res.destroyed) onDisconnect();
    const timer = setTimeout(() => cancel("interaction_preflight_timeout"),
      body.probePrompt === undefined ? PREFLIGHT_TIMEOUT_MS : PROBE_PREFLIGHT_TIMEOUT_MS);
    // A late newPage must also be closed; its lease cannot escape the deadline.
    let capture!: (page: Page | null) => void;
    const ownedPage = new Promise<Page | null>((resolve) => { capture = resolve; });
    // Set when a real page exists, so the diagnostics below never wait on a
    // promise that cannot settle: a stuck newPage is quarantined, not awaited.
    let pageCaptured = false;
    const work = (async () => {
      try {
        const page = await slotPage(state, slot, (page) => {
          capture(page);
          if (page) pageCaptured = true;
          if (cancelled) throw new Error(cancelled);
        });
        if (cancelled) throw new Error(cancelled);
        return await runInteractionPreflight(body, slotSession(state, slot, page), (next, failed, originalFailure) => {
          // Freeze evidence at cancellation; closing the page can trigger later cleanup.
          if (!cancelled) {
            if (next !== phase) {
              const now = performance.now();
              if (activeTiming) activeTiming.durationMs = Math.round(now - phaseStartedAt);
              phaseStartedAt = now;
              activeTiming = undefined;
              if (timeline.length < 64) {
                activeTiming = { phase: next, startedMs: Math.round(now - startedAt), durationMs: 0 };
                timeline.push(activeTiming);
              } else {
                timelineTruncated = true;
              }
              phase = next;
            }
            failedPhase = failed;
            failure ??= originalFailure;
          }
        });
      } finally {
        capture(null); // Only used if page creation failed before capturing a page.
      }
    })();
    const settled = work.then(() => undefined, () => undefined);
    let release = true;
    try {
      const result = await Promise.race([
        work,
        cancellation.then(() => { throw new Error(cancelled); }),
      ]);
      if (cancelled) throw new Error(cancelled);
      slot.interaction = { state: "ready", checkedAt: new Date().toISOString() };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      freezeTiming();
      // P-035 2026-09-21. This diagnostic used to be emitted on the ask path only,
      // so the one sanctioned NO-SUBMIT probe -- this preflight -- could fail at a
      // selector gate and still leave the decisive evidence to be bought with a real
      // paid turn. Emit the same bounded, content-free picture here, before the page
      // is closed below. Diagnostics never mask the failure.
      try {
        // P-035 2026-09-21. Only when a page actually existed; a stuck newPage is
        // quarantined rather than awaited, and waiting on it here hung the 409 --
        // caught by the daemon-slots quarantine test, whose budget this must not
        // eat into.
        const diagPage = pageCaptured ? await ownedPage : null;
        if (diagPage && !diagPage.isClosed()) {
          log.error(`selector diagnostic: ${await describeFailure(diagPage, PREFLIGHT_DIAGNOSTIC_TIMEOUT_MS)}`);
        }
      } catch {
        /* never let diagnostics mask the real failure */
      }
      if (!cancelled) failure ??= classifyInteractionFailure(error);
      if (cancelled) {
        slot.interaction = { state: "degraded", checkedAt: new Date().toISOString(), failureCode: cancelled };
        // A timed-out promise is still running. Never release its page to a new
        // turn until exact-page closure AND original work settlement are proven.
        release = false;
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        const quiesced = (async () => {
          const page = await ownedPage;
          if (page) {
            await page.close({ runBeforeUnload: false });
            if (!page.isClosed()) throw new Error("preflight page closure unverified");
          }
          await settled;
          return true;
        })();
        try {
          release = await Promise.race([
            quiesced.catch(() => false),
            new Promise<false>((resolve) => {
              closeTimer = setTimeout(() => resolve(false), PREFLIGHT_CLOSE_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(closeTimer);
        }
        // ponytail: an unproven close stays quarantined; governed recovery owns
        // escalation instead of risking other paid turns in this browser.
        if (!release) slot.leasedBy = "preflight-quarantined";
      }
      const failureCode = !release ? "interaction_preflight_recovery_required"
        : cancelled ?? failure?.code;
      slot.interaction = {
        state: "degraded",
        checkedAt: new Date().toISOString(),
        ...(failureCode ? { failureCode } : {}),
      };
      if (!res.destroyed && cancelled !== "interaction_preflight_disconnected") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "interaction_preflight_failed",
          ...(failureCode ? { code: failureCode } : {}),
          phase: cancelled ? phase : error instanceof PreSubmitInteractionError ? error.phase : phase,
          ...(failedPhase ? { failedPhase } : {}),
          ...(failure ? { failure } : {}),
          elapsedMs: Math.round(stoppedAt! - startedAt),
          phaseElapsedMs: Math.round(stoppedAt! - phaseStartedAt),
          timeline,
          timelineTruncated,
        }));
      }
    } finally {
      clearTimeout(timer);
      res.off("close", onDisconnect);
      if (release) {
        releaseSlot(state, slot, "preflight");
        state.queue.release();
      }
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
    } finally { releaseSlot(state, slot, "archive"); state.queue.release(); }
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
      releaseSlot(state, slot, "reload-inner");
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
        // P-035 2026-09-21. This used to await the unbounded capture. On a page
        // whose selectors stopped resolving, one capture took 20m41s (daemon.log
        // 01:13:34 -> 01:34:15, invocation 46c030c5) and held slot 0, askInFlight
        // and the client's SSE stream for all of it -- after the turn had already
        // failed. The client then needed an external SIGTERM at 15 min and reported
        // "cancellation unconfirmed", and `STOP refused ... in_flight=1` was
        // CORRECT throughout, because a handler really was still running. One leak,
        // three symptoms. Telemetry never gates capacity.
        const diagnostic = await describeFailure(slot.page);
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
    releaseSlot(state, slot, "ask");
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
 * A bounded picture of the page at the moment a selector gate failed: what
 * resolves, what is visible, which surface is mounted, and -- since
 * 2026-09-21 -- the two chrome labels a model-control gate reads. Counts and
 * booleans elsewhere; never user content.
 *
 * Why the labels are captured at all: the gate below asserts `^6\s*Pro$` against
 * the text of a menu row, deliberately text-exact, because a looser match could
 * let a paid turn run below maximum power. When it fails, nothing recorded what
 * the label actually held, so every repair attempt was a guess.
 */
// P-035 2026-09-21. Both selector-diagnostic call sites need the same rule: a
// capture is telemetry, so it may never hold a slot, an in-flight turn or an open
// SSE stream. The default is generous because a healthy capture is ~70 CDP
// round-trips and finishing it is worth a few seconds; the floor exists so the
// bound itself is testable. Read per call, not at module load, so a test can
// lower it without re-importing the module.
function selectorDiagnosticTimeoutMs(): number {
  const raw = Number(process.env.CGPRO_SELECTOR_DIAGNOSTIC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 50 ? raw : 8_000;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // The losing promise keeps running read-only; callers wrap it in a catch,
      // so abandoning it cannot surface as an unhandled rejection.
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describeSelectorStateBounded(
  page: Page,
  timeoutMs = selectorDiagnosticTimeoutMs(),
): Promise<string> {
  return withTimeout(
    describeSelectorState(page).catch(() => "unavailable"),
    timeoutMs,
    `timed out after ${timeoutMs}ms`,
  );
}

// P-035 2026-09-21. The identity read is one CDP round-trip against a shell that
// may already be broken, so it gets its own small slice and goes FIRST. The
// selector dump below is ~70 round-trips and is what starves: asking for the
// page's name after it meant the name never arrived, and both diagnostics on the
// running daemons read `timed out after 3000ms` and nothing else. The slices
// share one budget, so the composite cannot outlast the caller's own bound.
const IDENTITY_TIMEOUT_MS = 1_200;

async function describeFailure(page: Page, timeoutMs = selectorDiagnosticTimeoutMs()): Promise<string> {
  const startedAt = Date.now();
  const identity = await withTimeout(
    describePageIdentity(page),
    Math.min(IDENTITY_TIMEOUT_MS, timeoutMs),
    "page identity timed out",
  );
  // `remaining()` after every slice, so the composite still cannot outlast the
  // caller's own bound however many slices are added.
  const remaining = (): number => Math.max(200, timeoutMs - (Date.now() - startedAt));
  const shot = await withTimeout(
    captureFailureShot(page),
    Math.min(SCREENSHOT_TIMEOUT_MS, remaining()),
    "screenshot timed out",
  );
  return `${identity} shot=${shot} ${await describeSelectorStateBounded(page, remaining())}`;
}

const SCREENSHOT_TIMEOUT_MS = 3_000;

/**
 * P-035 2026-09-21. A picture beside the identity. The identity says which page
 * this is in words; the picture says what it looked like, which is what a human
 * can read at a glance and what no amount of counting replaces.
 *
 * Written to `<log dir>/failures/`, NOT to the temp dir the older failure
 * screenshots use: those evaporate on the next reboot, and this one is the
 * artifact someone is asked to look at later. Best-effort in both directions --
 * a screenshot never masks the failure it illustrates, and it is bounded so a
 * throttled renderer cannot hold the slot for it.
 */
async function captureFailureShot(page: Page): Promise<string> {
  const dir = join(dirname(DAEMON_LOG), "failures");
  const path = join(dir, `${Date.now()}-pid${process.pid}.png`);
  try {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path, fullPage: false });
    return path;
  } catch (error) {
    return `unavailable (${(error as Error).message.slice(0, 60)})`;
  }
}

const IDENTITY_CAPTURE_MAX = 120;

/**
 * P-035 2026-09-21. Names the page a failure happened on: its address, title,
 * heading and a few structural markers.
 *
 * Why this exists: when every turn-critical selector came back unresolved on a
 * page the preflight was holding, three explanations fit equally -- a page that
 * is not the app (logged out, or an interstitial), a shell whose app never
 * mounted, and a renamed control -- and nothing recorded which. One cheap read
 * separates them. `appRoot` is the decisive one: a root element with no children
 * means the script ran and rendered nothing, which no rename can explain, while
 * `challenge` and `login` identify the other two pages by name.
 *
 * Content-free by construction: address, title and heading text only, all
 * length-capped. A heading is chrome ("ChatGPT", "Log in or sign up", "Just a
 * moment..."), never conversation or composer text, so this stays safe to log on
 * an authenticated profile. `hidden` is recorded because a backgrounded or
 * minimised window can suppress rendering, which is a live candidate here.
 */
async function describePageIdentity(page: Page): Promise<string> {
  try {
    return await page.evaluate(
      ({ max }: { max: number }) => {
        const clean = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
        const has = (selector: string): boolean => document.querySelector(selector) !== null;
        const root = document.querySelector("#__next, #root, #app");
        const appRoot = !root ? "absent" : root.children.length === 0 ? "empty" : "rendered";
        return (
          `url="${clean(location.href)}" title="${clean(document.title)}" ` +
          `ready=${document.readyState} hidden=${document.visibilityState} ` +
          `heading="${clean(document.querySelector("h1, h2")?.textContent)}" appRoot=${appRoot} ` +
          `composer=${has("#prompt-textarea") || has('[data-testid="prompt-textarea"]')} ` +
          `login=${has('[data-testid="login-button"]') || has('a[href*="/auth/login"]')} ` +
          `challenge=${has("#challenge-form") || has("#cf-wrapper") || has("#challenge-stage")} ` +
          `scripts=${document.scripts.length}`
        );
      },
      { max: IDENTITY_CAPTURE_MAX },
    );
  } catch {
    return "page identity unavailable";
  }
}

async function describeSelectorState(page: Page): Promise<string> {
  const groups: Array<[string, string[]]> = [
    ["composer", SELECTORS.composer],
    ["thinkingPowerButton", SELECTORS.thinkingPowerButton],
    ["modelSwitcher", SELECTORS.modelSwitcher],
    ["thinkingPowerSlider", SELECTORS.thinkingPowerSlider],
    ["projectsNavigation", SELECTORS.projectsNavigation],
    ["projectRows", SELECTORS.projectRows],
    ["chatTabRadio", SELECTORS.chatTabRadio],
  ];
  const parts: string[] = [];
  for (const [name, candidates] of groups) {
    const counts: string[] = [];
    for (const candidate of candidates.slice(0, 5)) {
      // P-035 2026-09-21. The model-control gate matches a VISIBLE first element
      // (`firstResolved` -> chatgpt.ts:257), but this diagnostic reported attached
      // count alone, so "attached but invisible" and "absent" read identically --
      // the one distinction that matters when that gate fails. Report both:
      // `<attached>/<v|->`. Counts and booleans only; never page text.
      const loc = page.locator(candidate);
      const count = await loc.count().catch(() => -1);
      const visible = count > 0 ? await loc.first().isVisible().catch(() => false) : false;
      counts.push(`${candidate}=${count}/${visible ? "v" : "-"}`);
    }
    parts.push(`${name}[${counts.join(" ")}]`);
  }
  // The Chat/Work surface decides whether the composer has a Pro tier at all, so
  // record how many radios are actually checked, not just that one is mounted.
  const checkedRadios = await page
    .locator('[role="radio"][aria-checked="true"]')
    .count()
    .catch(() => -1);
  const editables = await page.locator('[contenteditable="true"]').count().catch(() => -1);
  const rows = await page.locator('[role="row"]').count().catch(() => -1);
  const chrome = await describeChromeLabels(page);
  return `${parts.join(" ")} checkedRadios=${checkedRadios} contenteditable=${editables} roleRow=${rows} ${chrome}`
    .slice(0, 2000);
}

const LABEL_CAPTURE_MAX = 60;

/**
 * P-035 2026-09-21. Two chrome labels, captured so a model-control failure names
 * its own cause instead of costing another guess:
 *
 * - `pill` -- the composer's model pill, the element that DISPLAYS the selected
 *   model to the user. Always mounted, so it is capturable whatever the failure.
 * - `row` -- the menu row the `model-selected-text` assertion compares against.
 *   Only exists while that menu is open, and the failing path closes the menu
 *   before this diagnostic runs, so `absent` here is expected and means nothing.
 *
 * Both are whitespace-collapsed and length-capped, and both are UI chrome: a
 * model name and an aria-label. Neither can carry prompt or answer text.
 */
async function describeChromeLabels(page: Page): Promise<string> {
  return page
    .evaluate(
      ({ pill, row, max }) => {
        const clean = (value: string | null): string =>
          (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
        const describe = (selector: string): string => {
          const el = document.querySelector(selector);
          if (!el) return "absent";
          return `text="${clean(el.textContent)}" inner="${clean((el as HTMLElement).innerText)}" aria="${clean(
            el.getAttribute("aria-label"),
          )}"`;
        };
        return `pill(${describe(pill)}) modelRow(${describe(row)})`;
      },
      { pill: SELECTORS.thinkingPowerButton[0], row: SELECTORS.selectedPowerModel[0], max: LABEL_CAPTURE_MAX },
    )
    .catch(() => "unavailable");
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
