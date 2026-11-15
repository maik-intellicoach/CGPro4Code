import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Session } from "../src/browser/session.js";

// Every browser, HTTP listener, authentication probe and exit is fake.
const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  openSession: vi.fn(),
  goHome: vi.fn(),
  clearDaemonInfo: vi.fn(),
  writeDaemonInfo: vi.fn(),
  runAskOnSession: vi.fn(),
  runInteractionPreflight: vi.fn(),
  archiveSavedConversation: vi.fn(),
}));
vi.mock("node:http", () => ({ createServer: mocks.createServer }));
vi.mock("../src/browser/session.js", () => ({
  openSession: mocks.openSession,
  describeWindow: async () => "window=fixture",
  isP045LaneProfile: () => false,
  parkWindow: vi.fn(),
  showWindow: vi.fn(),
}));
vi.mock("../src/browser/chatgpt.js", () => ({
  goHome: mocks.goHome,
  isLoggedIn: async () => true,
  fetchAuthSessionInPage: async () => null,
}));
vi.mock("../src/browser/conversation.js", () => ({
  assertPreflightDraftSafe: vi.fn(),
  clearComposer: vi.fn(),
  currentConversationId: () => null,
  openConversation: vi.fn(),
  readDeepResearchQuota: vi.fn(),
  readLatestAssistantText: vi.fn(),
  turnIsWorking: vi.fn(),
  waitForComposerHydrated: vi.fn(),
}));
vi.mock("../src/api/me.js", () => ({ fetchMe: async () => null, detectPlan: () => "unknown" }));
vi.mock("../src/api/models.js", () => ({ fetchModels: async () => [], findProSlug: () => null }));
vi.mock("../src/core/orchestrator.js", () => ({
  runAskOnSession: mocks.runAskOnSession,
  runInteractionPreflight: mocks.runInteractionPreflight,
}));
vi.mock("../src/api/conversation-filing.js", () => ({
  archiveSavedConversation: mocks.archiveSavedConversation,
}));
vi.mock("../src/daemon/protocol.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/protocol.js")>()),
  clearDaemonInfo: mocks.clearDaemonInfo,
  writeDaemonInfo: mocks.writeDaemonInfo,
}));

import {
  closeDaemonSessionBeforeExit,
  createServerState,
  handleRequest,
  LaneBrowserConnection,
  runDaemonServer,
  slotsOf,
  type ServerState,
} from "../src/daemon/server.js";
import { StreamEmitter } from "../src/core/stream.js";

const LANE = "http://127.0.0.1:9252";
const CLOSED = "browserContext.newPage: Target page, context or browser has been closed";
const order: string[] = [];
const connections: LaneBrowserConnection[] = [];
const signalListeners = new Map<NodeJS.Signals, Set<Function>>();
let logStart = 0;

function fakeSession(lane: string | undefined = LANE) {
  const browser = Object.assign(new EventEmitter(), {
    isConnected: vi.fn(() => true),
    close: vi.fn(),
  });
  const page = Object.assign(new EventEmitter(), {
    isClosed: vi.fn(() => false),
    url: () => "https://chatgpt.com/",
    evaluate: vi.fn(async () => "fixture user agent"),
    close: vi.fn(async () => undefined),
  });
  const context = {
    browser: () => browser,
    newPage: vi.fn(async () => page),
    close: vi.fn(),
  };
  const close = vi.fn(async () => { order.push("session close"); });
  const session = { lane, page, context, close } as unknown as Session;
  return { session, browser, context, page, close };
}

function install(state: ServerState) {
  const exit = vi.fn((_code: number) => {
    expect(mocks.clearDaemonInfo).toHaveBeenCalledWith(process.pid);
    order.push(`exit ${_code}`);
    return undefined as never;
  });
  const connection = new LaneBrowserConnection(state, state.session.context.browser()!, async () => {
    expect(state.queue.busy).toBe(false);
    expect(slotsOf(state).every((slot) => !slot.busy && !slot.askInFlight)).toBe(true);
    await closeDaemonSessionBeforeExit(state.session, exit, undefined, 1);
  });
  state.browserLink = connection;
  connections.push(connection);
  return { connection, exit };
}

function request(state: ServerState, path: string, body?: unknown) {
  const req = Object.assign(new EventEmitter(), {
    method: body === undefined ? "GET" : "POST",
    url: path,
    headers: { authorization: `Bearer ${state.token}` },
    setEncoding: vi.fn(),
  });
  const response = { status: 0, text: "", ended: false };
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    writeHead(status: number) { response.status = status; this.headersSent = true; },
    write(text: string) { response.text += text; return true; },
    end(text = "") {
      response.text += text;
      response.ended = true;
      order.push("response end");
    },
  });
  const pending = handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, state);
  if (body !== undefined) {
    req.emit("data", JSON.stringify(body));
    req.emit("end");
  }
  return { pending, response };
}

function logLines() {
  return readFileSync(process.env.CGPRO_DAEMON_LOG!, "utf8").slice(logStart).split("\n")
    .filter((line) => line.includes("[error]") && line.includes("lane browser link lost"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.goHome.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("CGPRO_DAEMON_SLOTS", "1");
  order.length = 0;
  logStart = readFileSync(process.env.CGPRO_DAEMON_LOG!, "utf8").length;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    signalListeners.set(signal, new Set(process.listeners(signal)));
  }
});

afterEach(() => {
  for (const connection of connections.splice(0)) connection.dispose();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signalListeners.get(signal)!.has(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("lane browser connection loss", () => {
  it("keeps the other slot's ask alive after a connected page-level closed error", async () => {
    vi.stubEnv("CGPRO_DAEMON_SLOTS", "2");
    const { session, browser, close } = fakeSession();
    const state = createServerState(session, { background: false });
    const { connection, exit } = install(state);
    const events = new StreamEmitter();
    let complete!: (value: { finalText: string }) => void;
    const result = new Promise<{ finalText: string }>((resolve) => { complete = resolve; });
    const pageError = "page.evaluate: Target page, context or browser has been closed";
    mocks.runAskOnSession
      .mockImplementationOnce(() => ({ events, result, cancel: vi.fn() }))
      .mockImplementationOnce(() => { throw new Error(pageError); });
    const healthy = request(state, "/ask", { prompt: "healthy" });
    await vi.waitFor(() => expect(mocks.runAskOnSession).toHaveBeenCalledTimes(1));
    const failed = request(state, "/ask", { prompt: "closed tab" });
    await failed.pending;
    expect(failed.response.text).toContain(pageError);
    expect(failed.response.ended).toBe(true);
    expect(browser.isConnected()).toBe(true);
    expect(connection.failure).toBeUndefined();
    expect(healthy.response.ended).toBe(false);
    events.push({ type: "done", finalText: "healthy answer" });
    complete({ finalText: "healthy answer" });
    await healthy.pending;
    expect(healthy.response.text).toContain("event: summary");
    expect(healthy.response.text).toContain("healthy answer");
    expect(healthy.response.ended).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(connection.closing).toBeUndefined();
  });

  it("rejects queued asks promptly on link loss even with quarantined capacity", async () => {
    const { session, browser } = fakeSession();
    const state = createServerState(session, { background: false });
    // Model the permanent capacity reservation of a quarantined preflight.
    expect(state.queue.tryAcquire()).toBe(true);
    const slot = slotsOf(state)[0];
    slot.busy = true;
    slot.leasedBy = "preflight-quarantined";
    const exit = vi.fn(() => undefined as never);
    const connection = new LaneBrowserConnection(state, session.context.browser()!, async () => {
      await closeDaemonSessionBeforeExit(session, exit, undefined, 1);
    });
    state.browserLink = connection;
    connections.push(connection);
    const queued = request(state, "/ask", { prompt: "waiting" });
    await vi.waitFor(() => expect(state.queue.depth).toBe(1));
    browser.emit("disconnected");
    await queued.pending;
    await connection.closing;
    expect(queued.response.status).toBe(503);
    expect(queued.response.text).toContain("lane browser link lost");
    expect(queued.response.ended).toBe(true);
    expect(state.queue.depth).toBe(0);
    expect(state.queue.busy).toBe(true);
    expect(mocks.runAskOnSession).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(order).toEqual(["response end", "session close"]);
  }, 1_000);

  it("logs the lane once, clears registration, and exits nonzero after a disconnect", async () => {
    const { session, browser, context, close } = fakeSession();
    const state = createServerState(session, { background: false });
    const { connection, exit } = install(state);
    browser.emit("disconnected");
    browser.emit("disconnected");
    await connection.closing;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["session close", "exit 1"]);
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toContain(LANE);
    expect(context.close).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it("fails an in-flight ask even when its iterator and result never settle", async () => {
    const { session, browser } = fakeSession();
    const state = createServerState(session, { background: false });
    const { connection, exit } = install(state);
    mocks.runAskOnSession.mockReturnValue({
      events: new StreamEmitter(), result: new Promise(() => {}), cancel: vi.fn(),
    });
    const { pending, response } = request(state, "/ask", { prompt: "fixture" });
    await vi.waitFor(() => expect(mocks.runAskOnSession).toHaveBeenCalledTimes(1));
    browser.emit("disconnected");
    await pending;
    expect(response.ended).toBe(true);
    expect(response.text).toContain("event: error");
    expect(response.text).toContain("lane browser link lost");
    await connection.closing;
    expect(order).toEqual(["response end", "session close", "exit 1"]);
    expect(state.currentRunner).toBeNull();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails a closed-context ask before cleanup, without needing a disconnect event", async () => {
    const { session, browser } = fakeSession();
    const state = createServerState(session, { background: false });
    const { connection, exit } = install(state);
    mocks.runAskOnSession.mockImplementation(() => { throw new Error(CLOSED); });
    const { pending, response } = request(state, "/ask", { prompt: "fixture" });
    await pending;
    expect(response.text).toContain(CLOSED);
    expect(response.text).toContain("event: error");
    expect(response.ended).toBe(true);
    expect(browser.isConnected()).toBe(true);
    expect(connection.failure).toBeDefined();
    browser.emit("disconnected"); // The later event must not start a second exit.
    await connection.closing;
    expect(order).toEqual(["response end", "session close", "exit 1"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logLines()).toHaveLength(1);
  });

  it("catches the closed-context symptom from the ask stream without waiting for result", async () => {
    const { session } = fakeSession();
    const state = createServerState(session, { background: false });
    const { connection } = install(state);
    const events = new StreamEmitter();
    events.push({ type: "error", message: CLOSED });
    mocks.runAskOnSession.mockReturnValue({ events, result: new Promise(() => {}), cancel: vi.fn() });
    const { pending, response } = request(state, "/ask", { prompt: "fixture" });
    await pending;
    await connection.closing;
    expect(response.ended).toBe(true);
    expect(response.text.match(/event: error/g)).toHaveLength(1);
    expect(order).toEqual(["response end", "session close", "exit 1"]);
  });

  it("catches a rejected ask result even when the event iterator never settles", async () => {
    const { session } = fakeSession();
    const state = createServerState(session, { background: false });
    const { connection } = install(state);
    mocks.runAskOnSession.mockImplementation(() => ({
      events: new StreamEmitter(), result: Promise.reject(new Error(CLOSED)), cancel: vi.fn(),
    }));
    const { pending, response } = request(state, "/ask", { prompt: "fixture" });
    await pending;
    await connection.closing;
    expect(response.ended).toBe(true);
    expect(response.text).toContain("event: error");
    expect(order).toEqual(["response end", "session close", "exit 1"]);
  });

  it.each(["/preflight", "/archive-saved"])("handles the closed-context symptom from %s", async (path) => {
    const { session } = fakeSession();
    const state = createServerState(session, { background: false });
    const { connection, exit } = install(state);
    mocks.runInteractionPreflight.mockRejectedValue(new Error(CLOSED));
    mocks.archiveSavedConversation.mockRejectedValue(new Error(CLOSED));
    const body = path === "/preflight"
      ? { model: "gpt-6-pro", connector: "fixture", gizmoId: "g-p-fixture", expectedAccountEmail: "fixture@example.test" }
      : { conversationId: "00000000-0000-0000-0000-000000000001", projectId: "g-p-fixture", expectedEmail: "fixture@example.test", fingerprint: "a".repeat(64) };
    const { pending, response } = request(state, path, body);
    await pending;
    await connection.closing;
    expect(response.status).toBe(409);
    expect(response.text).toContain(CLOSED);
    expect(order).toEqual(["response end", "session close", "exit 1"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("unregisters and exits even when cleanup rejects after link loss", async () => {
    const { session, browser, close } = fakeSession();
    close.mockRejectedValue(new Error(CLOSED));
    const state = createServerState(session, { background: false });
    const { connection, exit } = install(state);
    browser.emit("disconnected");
    await connection.closing;
    expect(mocks.clearDaemonInfo).toHaveBeenCalledWith(process.pid);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not treat an intentional session close as a lost connection", async () => {
    const { session, browser } = fakeSession();
    const state = createServerState(session, { background: false });
    const { connection, exit } = install(state);
    connection.dispose();
    browser.emit("disconnected");
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).not.toHaveBeenCalled();
    expect(connection.failure).toBeUndefined();
    expect(logLines()).toHaveLength(0);
  });
});

it.each([true, false])("reports browserConnected=%s and preserves status and health fields", async (connected) => {
  const { session, browser } = fakeSession();
  browser.isConnected.mockReturnValue(connected);
  const state = createServerState(session, { background: false });
  const status = request(state, "/status");
  await status.pending;
  expect(JSON.parse(status.response.text)).toMatchObject({
    pid: process.pid, startedAt: state.startedAt.toISOString(), background: false,
    busy: false, browserConnected: connected, currentConversation: null,
    lastConversation: null, interaction: { state: "unknown" },
    slots: { total: 1, busy: 0, free: 1 },
  });
  const health = request(state, "/healthz");
  await health.pending;
  expect(JSON.parse(health.response.text)).toEqual({ daemon: "cgpro", version: 1, queueDepth: 0, browserConnected: connected });
});

it.each([true, false])("installs the disconnect watcher only when session.lane is set (%s)", async (lane) => {
  const { session, browser, close } = fakeSession(lane ? LANE : "");
  mocks.openSession.mockResolvedValue(session);
  const server = Object.assign(new EventEmitter(), {
    listening: false,
    listen: vi.fn((_port: number, _host: string, callback: () => void) => {
      server.listening = true;
      callback();
    }),
    address: () => ({ port: 12345 }),
    close: vi.fn(),
  });
  mocks.createServer.mockReturnValue(server);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  await runDaemonServer({ background: false });
  expect(mocks.writeDaemonInfo).toHaveBeenCalledTimes(1);
  expect(browser.listenerCount("disconnected")).toBe(lane ? 1 : 0);
  browser.emit("disconnected");
  if (lane) {
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.clearDaemonInfo).toHaveBeenCalledWith(process.pid);
  } else {
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  }
});

it("exits on a link drop during a startup probe without registering a listener", async () => {
  const { session, browser } = fakeSession();
  mocks.openSession.mockResolvedValue(session);
  mocks.goHome.mockReturnValue(new Promise(() => {}));
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const starting = runDaemonServer({ background: false });
  await vi.waitFor(() => expect(browser.listenerCount("disconnected")).toBe(1));
  browser.emit("disconnected");
  await starting;
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(mocks.createServer).not.toHaveBeenCalled();
  expect(mocks.writeDaemonInfo).not.toHaveBeenCalled();
  expect(mocks.clearDaemonInfo).toHaveBeenCalledWith(process.pid);
});

it("keeps a non-lane closed-context ask on its existing request-error path", async () => {
  const { session, page, close } = fakeSession("");
  page.isClosed.mockReturnValue(true);
  const state = createServerState(session, { background: false });
  mocks.runAskOnSession.mockImplementation(() => { throw new Error(CLOSED); });
  const { pending, response } = request(state, "/ask", { prompt: "fixture" });
  await pending;
  expect(response.text).toContain(CLOSED);
  expect(response.ended).toBe(true);
  expect(close).not.toHaveBeenCalled();
  expect(state.queue.busy).toBe(false);
  expect(mocks.clearDaemonInfo).not.toHaveBeenCalled();
  expect(logLines()).toHaveLength(0);
});
