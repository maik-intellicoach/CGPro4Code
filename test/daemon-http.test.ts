import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

// runAskOnSession drives real Chromium — stub it so handleAsk's HTTP-level
// wiring (queue admission, status codes, header/body ordering) can be
// exercised without a browser (C-092 P-026 r2 test-gap concession).
const runAskOnSession = vi.fn();
vi.mock("../src/core/orchestrator.js", () => ({
  runAskOnSession: (...args: unknown[]) => runAskOnSession(...args),
}));

// Small bounds so the body-timeout/body-too-large tests don't need to wait
// out (or allocate) the real production defaults (C-092 P-026 xfam r1 H1).
process.env.CGPRO_DAEMON_BODY_TIMEOUT_MS = "200";
process.env.CGPRO_DAEMON_BODY_MAX_BYTES = "64";

const { AskQueue, PreAdmissionReaderBudget, handleAsk, handleRequest } = await import("../src/daemon/server.js");
import type { ServerState } from "../src/daemon/server.js";
import type { Session } from "../src/browser/session.js";
import { StreamEmitter } from "../src/core/stream.js";

function fakeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    session: {} as unknown as Session,
    token: "test-token",
    startedAt: new Date(),
    background: true,
    queue: new AskQueue(8, 60_000),
    readerBudget: new PreAdmissionReaderBudget(8),
    currentConversation: null,
    lastConversation: null,
    ...overrides,
  };
}

class FakeReq extends EventEmitter {
  headers: Record<string, string> = {};
  setEncoding = vi.fn();
}

class FakeRes extends EventEmitter {
  headersSent = false;
  statusCode = 0;
  writeHead = vi.fn((status: number, _headers?: unknown) => {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  });
  writes: string[] = [];
  write = vi.fn((chunk: string) => {
    this.writes.push(chunk);
    return true;
  });
  ended = false;
  end = vi.fn((chunk?: string) => {
    if (chunk) this.writes.push(chunk);
    this.ended = true;
  });
}

function parseJsonBody(res: FakeRes): unknown {
  return JSON.parse(res.writes.join(""));
}

function sendBody(req: IncomingMessage, obj: unknown): void {
  const emitter = req as unknown as FakeReq;
  emitter.emit("data", JSON.stringify(obj));
  emitter.emit("end");
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  runAskOnSession.mockReset();
});

it("returns authenticated account facts from daemon status", async () => {
  const state = fakeState({
    account: { email: "account@example.test", plan: "pro", proModelAvailable: true },
  });
  const req = new FakeReq() as unknown as IncomingMessage;
  const res = new FakeRes() as unknown as ServerResponse;
  Object.assign(req, { method: "GET", url: "/status", headers: { authorization: "Bearer test-token" } });

  await handleRequest(req, res, state);

  expect((res as unknown as FakeRes).statusCode).toBe(200);
  expect(parseJsonBody(res as unknown as FakeRes)).toMatchObject({
    account: { email: "account@example.test", plan: "pro", proModelAvailable: true },
  });
});

describe("handleAsk HTTP-level wiring", () => {
  it("returns 429 with queue_full when the queue's waiting line is full", async () => {
    const state = fakeState({ queue: new AskQueue(1, 60_000) });
    await state.queue.acquire(); // occupies the one running slot
    void state.queue.acquire(); // fills the one waiting slot (maxDepth=1)

    const req = new FakeReq() as unknown as IncomingMessage;
    const res = new FakeRes() as unknown as ServerResponse;
    Object.assign(req, { method: "POST" });
    const pending = handleAsk(req, res as unknown as ServerResponse, state);
    sendBody(req, { prompt: "hi" }); // body read completes; only then is admission attempted
    await pending;

    const fakeRes = res as unknown as FakeRes;
    expect(fakeRes.statusCode).toBe(429);
    expect(parseJsonBody(fakeRes)).toMatchObject({ error: "queue_full" });
    expect(runAskOnSession).not.toHaveBeenCalled();
  });

  it("returns 504 with queue_wait_timeout when the wait exceeds maxWaitMs", async () => {
    vi.useFakeTimers();
    try {
      const state = fakeState({ queue: new AskQueue(8, 1_000) });
      await state.queue.acquire(); // keep the running slot occupied

      const req = new FakeReq() as unknown as IncomingMessage;
      const res = new FakeRes() as unknown as ServerResponse;
      Object.assign(req, { method: "POST" });
      const pending = handleAsk(req, res as unknown as ServerResponse, state);
      sendBody(req, { prompt: "hi" }); // completes immediately; queue wait starts after
      await vi.advanceTimersByTimeAsync(1_001);
      await pending;

      const fakeRes = res as unknown as FakeRes;
      expect(fakeRes.statusCode).toBe(504);
      expect(parseJsonBody(fakeRes)).toMatchObject({ error: "queue_wait_timeout" });
      expect(runAskOnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends SSE headers before any event bytes on the success path", async () => {
    const emitter = new StreamEmitter();
    emitter.push({ type: "started", conversationId: "conv-1" });
    emitter.push({ type: "delta", text: "hi" });
    emitter.push({ type: "done", finalText: "hi" });
    runAskOnSession.mockReturnValue({
      events: emitter,
      result: Promise.resolve({ conversationId: "conv-1", finalText: "hi", events: [] }),
      cancel: async () => {},
    });

    const state = fakeState();
    const req = new FakeReq() as unknown as IncomingMessage;
    const res = new FakeRes() as unknown as ServerResponse;
    Object.assign(req, { method: "POST" });

    const pending = handleAsk(req, res as unknown as ServerResponse, state);
    sendBody(req, { prompt: "hi" }); // readJsonBody's listeners are wired synchronously
    await pending;

    const fakeRes = res as unknown as FakeRes;
    expect(fakeRes.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "text/event-stream" }),
    );
    // Headers must be sent (writeHead call recorded) strictly before the
    // first SSE byte is written.
    const writeHeadOrder = fakeRes.writeHead.mock.invocationCallOrder[0];
    const firstWriteOrder = fakeRes.write.mock.invocationCallOrder[0];
    expect(firstWriteOrder).toBeGreaterThan(writeHeadOrder);
    expect(fakeRes.writes.join("")).toContain("event: delta");
  });

  it("drops queueDepth and writes nothing when a queued client closes before acquire() resolves, then admits the next waiter in order (C-092 P-026 r3 G3)", async () => {
    const state = fakeState({ queue: new AskQueue(8, 60_000) });
    await state.queue.acquire(); // occupy the running slot so both requests below queue

    // Request A finishes sending its body, queues behind the running slot,
    // then disconnects while still waiting — exercises the round-1 blocker
    // wiring (server.ts req "close"/"aborted" -> disconnectController).
    const reqA = new FakeReq() as unknown as IncomingMessage;
    const resA = new FakeRes() as unknown as ServerResponse;
    Object.assign(reqA, { method: "POST" });
    const pendingA = handleAsk(reqA, resA as unknown as ServerResponse, state);
    sendBody(reqA, { prompt: "hi" });
    await tick();
    expect(state.queue.depth).toBe(1);

    // Request B queues behind A — still connected, must be admitted next.
    const reqB = new FakeReq() as unknown as IncomingMessage;
    const resB = new FakeRes() as unknown as ServerResponse;
    Object.assign(reqB, { method: "POST" });
    const pendingB = handleAsk(reqB, resB as unknown as ServerResponse, state);
    sendBody(reqB, { prompt: "hi" });
    await tick();
    expect(state.queue.depth).toBe(2);

    (reqA as unknown as FakeReq).emit("close");
    await pendingA;

    expect(state.queue.depth).toBe(1); // A's waiting slot released, only B remains
    const fakeResA = resA as unknown as FakeRes;
    expect(fakeResA.writeHead).not.toHaveBeenCalled();
    expect(fakeResA.write).not.toHaveBeenCalled();
    expect(fakeResA.end).not.toHaveBeenCalled();

    const emitter = new StreamEmitter();
    emitter.push({ type: "done", finalText: "hi" });
    runAskOnSession.mockReturnValue({
      events: emitter,
      result: Promise.resolve({ conversationId: null, finalText: "hi", events: [] }),
      cancel: async () => {},
    });

    state.queue.release(); // free the running slot acquired above
    await pendingB;

    const fakeResB = resB as unknown as FakeRes;
    expect(fakeResB.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "text/event-stream" }),
    );
    expect(state.queue.depth).toBe(0); // B was dequeued and admitted, in order
  });

  it("H1: a stalled/never-completing body never occupies a queue slot", async () => {
    vi.useFakeTimers();
    try {
      const state = fakeState({ queue: new AskQueue(1, 60_000) });

      const req = new FakeReq() as unknown as IncomingMessage;
      const res = new FakeRes() as unknown as ServerResponse;
      Object.assign(req, { method: "POST" });
      const pending = handleAsk(req, res as unknown as ServerResponse, state);
      // readJsonBody's listeners (and its timeout timer) are wired up
      // synchronously before handleAsk's first await, so no tick is needed.

      // No "data"/"end" ever emitted — the body never arrives, well past
      // the 200ms test bound, yet the slot stays free the whole time.
      await vi.advanceTimersByTimeAsync(100);
      expect(state.queue.depth).toBe(0);
      expect(state.queue.busy).toBe(false);

      // A second, healthy request must be able to use the (untouched) slot.
      const acquired = state.queue.acquire();
      state.queue.release();
      await acquired;

      await vi.advanceTimersByTimeAsync(200); // let the stalled request's body-read timer fire
      await pending;
      expect(state.queue.depth).toBe(0);
      expect(state.queue.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("H1: body read timeout returns 408 without ever touching the queue", async () => {
    vi.useFakeTimers();
    try {
      const state = fakeState({ queue: new AskQueue(8, 60_000) });
      const req = new FakeReq() as unknown as IncomingMessage;
      const res = new FakeRes() as unknown as ServerResponse;
      Object.assign(req, { method: "POST" });
      const pending = handleAsk(req, res as unknown as ServerResponse, state);

      await vi.advanceTimersByTimeAsync(201); // > CGPRO_DAEMON_BODY_TIMEOUT_MS=200 set above
      await pending;

      const fakeRes = res as unknown as FakeRes;
      expect(fakeRes.statusCode).toBe(408);
      expect(parseJsonBody(fakeRes)).toMatchObject({ error: "body_timeout" });
      expect(state.queue.depth).toBe(0);
      expect(state.queue.busy).toBe(false);
      expect(runAskOnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("H1: an oversized body returns 413 without ever touching the queue", async () => {
    const state = fakeState({ queue: new AskQueue(8, 60_000) });
    const req = new FakeReq() as unknown as IncomingMessage;
    const res = new FakeRes() as unknown as ServerResponse;
    Object.assign(req, { method: "POST" });
    const pending = handleAsk(req, res as unknown as ServerResponse, state);

    const reqEmitter = req as unknown as FakeReq;
    reqEmitter.emit("data", JSON.stringify({ prompt: "x".repeat(100) })); // > CGPRO_DAEMON_BODY_MAX_BYTES=64
    await pending;

    const fakeRes = res as unknown as FakeRes;
    expect(fakeRes.statusCode).toBe(413);
    expect(parseJsonBody(fakeRes)).toMatchObject({ error: "body_too_large" });
    expect(state.queue.depth).toBe(0);
    expect(state.queue.busy).toBe(false);
    expect(runAskOnSession).not.toHaveBeenCalled();
  });

  // ---- B2: pre-admission reader budget ----

  it("B2: rejects the Nth+1 concurrent pre-admission reader with 429 while the queue stays empty", async () => {
    const state = fakeState({ queue: new AskQueue(8, 60_000), readerBudget: new PreAdmissionReaderBudget(2) });

    // Two readers hold their slots by never finishing their body — never
    // touches the queue at all (H1 still holds: no data sent).
    const reqA = new FakeReq() as unknown as IncomingMessage;
    const resA = new FakeRes() as unknown as ServerResponse;
    Object.assign(reqA, { method: "POST" });
    const pendingA = handleAsk(reqA, resA as unknown as ServerResponse, state);

    const reqB = new FakeReq() as unknown as IncomingMessage;
    const resB = new FakeRes() as unknown as ServerResponse;
    Object.assign(reqB, { method: "POST" });
    const pendingB = handleAsk(reqB, resB as unknown as ServerResponse, state);

    await tick();
    expect(state.readerBudget.activeCount).toBe(2);

    // Third concurrent reader is rejected immediately — no queue slot ever
    // touched, no body ever read.
    const reqC = new FakeReq() as unknown as IncomingMessage;
    const resC = new FakeRes() as unknown as ServerResponse;
    Object.assign(reqC, { method: "POST" });
    await handleAsk(reqC, resC as unknown as ServerResponse, state);

    const fakeResC = resC as unknown as FakeRes;
    expect(fakeResC.statusCode).toBe(429);
    expect(parseJsonBody(fakeResC)).toMatchObject({ error: "reader_budget_exceeded", active: 2 });
    expect(state.queue.depth).toBe(0);
    expect(state.queue.busy).toBe(false);

    // Finishing A's body frees its slot; C's rejection didn't consume one.
    sendBody(reqA, { prompt: "hi" });
    await pendingA;
    sendBody(reqB, { prompt: "hi" });
    await pendingB;
    expect(state.readerBudget.activeCount).toBe(0);
  });

  it("B2: the reader budget is released even when the body read times out", async () => {
    vi.useFakeTimers();
    try {
      const state = fakeState({ readerBudget: new PreAdmissionReaderBudget(1) });
      const req = new FakeReq() as unknown as IncomingMessage;
      const res = new FakeRes() as unknown as ServerResponse;
      Object.assign(req, { method: "POST" });
      const pending = handleAsk(req, res as unknown as ServerResponse, state);

      await vi.advanceTimersByTimeAsync(201); // > CGPRO_DAEMON_BODY_TIMEOUT_MS=200 set above
      await pending;

      expect(state.readerBudget.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
