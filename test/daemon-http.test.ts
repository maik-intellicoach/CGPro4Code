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

const { AskQueue, handleAsk } = await import("../src/daemon/server.js");
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

beforeEach(() => {
  runAskOnSession.mockReset();
});

describe("handleAsk HTTP-level wiring", () => {
  it("returns 429 with queue_full when the queue's waiting line is full", async () => {
    const state = fakeState({ queue: new AskQueue(1, 60_000) });
    await state.queue.acquire(); // occupies the one running slot
    void state.queue.acquire(); // fills the one waiting slot (maxDepth=1)

    const req = new FakeReq() as unknown as IncomingMessage;
    const res = new FakeRes() as unknown as ServerResponse;
    await handleAsk(req, res as unknown as ServerResponse, state);

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
      const pending = handleAsk(req, res as unknown as ServerResponse, state);
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

    const bodyText = JSON.stringify({ prompt: "hi" });
    const reqEmitter = req as unknown as FakeReq;
    const pending = handleAsk(req, res as unknown as ServerResponse, state);
    // Let acquire()'s promise chain settle before readJsonBody's data/end
    // listeners are wired up.
    await new Promise((resolve) => setImmediate(resolve));
    reqEmitter.emit("data", bodyText);
    reqEmitter.emit("end");
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
});
