import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

// Same stubbing as test/daemon-http.test.ts: the runner drives real
// Chromium, so it is mocked; the slot-opening checks (goHome/isLoggedIn) are
// mocked too so a second tab can be "opened" without a browser (P-035 D23.0).
const runAskOnSession = vi.fn();
const runInteractionPreflight = vi.fn();
vi.mock("../src/core/orchestrator.js", () => ({
  runAskOnSession: (...args: unknown[]) => runAskOnSession(...args),
  runInteractionPreflight: (...args: unknown[]) => runInteractionPreflight(...args),
}));

const chatgpt = vi.hoisted(() => ({
  goHome: vi.fn(async () => {}),
  isLoggedIn: vi.fn(async () => true),
}));
vi.mock("../src/browser/chatgpt.js", async () => {
  const actual = await vi.importActual<typeof import("../src/browser/chatgpt.js")>("../src/browser/chatgpt.js");
  return { ...actual, ...chatgpt };
});

const browserConversation = vi.hoisted(() => ({
  openConversation: vi.fn(),
  readLatestAssistantText: vi.fn(async () => "partial"),
  turnIsWorking: vi.fn(),
}));
vi.mock("../src/browser/conversation.js", async () => {
  const actual = await vi.importActual<typeof import("../src/browser/conversation.js")>(
    "../src/browser/conversation.js",
  );
  return { ...actual, ...browserConversation };
});

const {
  AskQueue,
  createServerState,
  daemonSlotCount,
  handleRequest,
} = await import("../src/daemon/server.js");
import type { ServerState } from "../src/daemon/server.js";
import type { Session } from "../src/browser/session.js";
import { StreamEmitter } from "../src/core/stream.js";

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

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakePage(name: string): { name: string; isClosed: () => boolean; once: ReturnType<typeof vi.fn>; url: () => string } {
  return { name, isClosed: () => false, once: vi.fn(), url: () => "https://chatgpt.com/" };
}

function fakeSession(): Session {
  const page = fakePage("slot-0");
  const context = { newPage: vi.fn(async () => fakePage("slot-1")) };
  return { context, page, close: vi.fn() } as unknown as Session;
}

function call(state: ServerState, method: string, url: string, body?: unknown): { res: FakeRes; pending: Promise<void> } {
  const req = new FakeReq();
  const res = new FakeRes();
  Object.assign(req, { method, url, headers: { authorization: `Bearer ${state.token}` } });
  const pending = handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, state);
  if (body !== undefined) {
    req.emit("data", JSON.stringify(body));
    req.emit("end");
  }
  return { res, pending };
}

const ask = (state: ServerState, invocationId: string): { res: FakeRes; pending: Promise<void> } =>
  call(state, "POST", "/ask", { prompt: "hi", invocationId, timeoutSec: 60 });

async function status(state: ServerState): Promise<Record<string, any>> {
  const { res, pending } = call(state, "GET", "/status");
  await pending;
  return JSON.parse(res.writes.join("")) as Record<string, any>;
}

/** A runner that streams `started` immediately and finishes on demand. */
function pendingRunner(conversationId: string): {
  runner: { events: StreamEmitter; result: Promise<unknown>; cancel: ReturnType<typeof vi.fn> };
  finish: () => void;
} {
  const events = new StreamEmitter();
  events.push({ type: "started", conversationId });
  let finish!: () => void;
  const result = new Promise<unknown>((resolve) => {
    finish = () => {
      events.push({ type: "done", finalText: "ok" });
      resolve({ conversationId, finalText: "ok", events: [] });
    };
  });
  const cancel = vi.fn(async () => finish());
  return { runner: { events, result, cancel }, finish };
}

beforeEach(() => {
  runAskOnSession.mockReset();
  runInteractionPreflight.mockReset();
  chatgpt.goHome.mockClear();
  chatgpt.isLoggedIn.mockClear();
  delete process.env.CGPRO_DAEMON_SLOTS;
});

describe("CGPRO_DAEMON_SLOTS", () => {
  it("is an integer clamped to 1..3, default 1", () => {
    expect(daemonSlotCount(undefined)).toBe(1);
    expect(daemonSlotCount("")).toBe(1);
    expect(daemonSlotCount("abc")).toBe(1);
    expect(daemonSlotCount("0")).toBe(1);
    expect(daemonSlotCount("2.9")).toBe(2);
    expect(daemonSlotCount("4")).toBe(4);
    expect(daemonSlotCount("9")).toBe(4);
  });

  it("gives AskQueue a matching capacity; capacity 1 keeps today's single-lane semantics", async () => {
    const queue = new AskQueue(8, 60_000, 2);
    expect(queue.tryAcquire()).toBe(true);
    expect(queue.busy).toBe(false);
    await queue.acquire();
    expect(queue.busy).toBe(true);
    expect(queue.tryAcquire()).toBe(false);
    queue.release();
    expect(queue.busy).toBe(false);
    queue.release();

    const single = new AskQueue(8, 60_000);
    expect(single.tryAcquire()).toBe(true);
    expect(single.busy).toBe(true);
  });
});

describe("per-slot daemon instancing", () => {
  it("streams two asks concurrently on two tabs, queues the third, cancels one slot exactly", async () => {
    process.env.CGPRO_DAEMON_SLOTS = "2";
    const state = createServerState(fakeSession(), { background: true });
    expect(state.maxSlots).toBe(2);
    const first = pendingRunner("conv-1");
    const second = pendingRunner("conv-2");
    const third = pendingRunner("conv-3");
    runAskOnSession
      .mockReturnValueOnce(first.runner)
      .mockReturnValueOnce(second.runner)
      .mockReturnValueOnce(third.runner);

    const ask1 = ask(state, "inv-1");
    await tick();
    const ask2 = ask(state, "inv-2");
    await tick();

    for (const { res } of [ask1, ask2]) {
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "text/event-stream" }));
    }
    expect(ask1.res.writes.join("")).toContain("conv-1");
    expect(ask2.res.writes.join("")).toContain("conv-2");

    // Slot 0 runs on the daemon session; slot 1 is a lazily opened tab that
    // passed the same home + login checks as daemon start and cannot be closed.
    expect(runAskOnSession.mock.calls[0][1]).toBe(state.session);
    const slotSession = runAskOnSession.mock.calls[1][1] as Session & { page: { name: string } };
    expect(slotSession.page.name).toBe("slot-1");
    expect(slotSession.context).toBe(state.session.context);
    expect(chatgpt.goHome).toHaveBeenCalledWith(slotSession.page);
    expect(chatgpt.isLoggedIn).toHaveBeenCalledWith(slotSession.page, 8_000);
    await expect(slotSession.close()).rejects.toThrow("slot sessions are not closable");

    const full = await status(state);
    expect(full).toMatchObject({ busy: true, currentConversation: "conv-1", slots: { total: 2, busy: 2, free: 0 } });
    expect(full.slots.items.map((item: { invocationId: string }) => item.invocationId)).toEqual(["inv-1", "inv-2"]);

    // No free capacity: a third ask waits in the FIFO line (today's /ask
    // admission), a preflight answers 409 lane_busy.
    const ask3 = ask(state, "inv-3");
    await tick();
    expect(state.queue.depth).toBe(1);
    expect(ask3.res.writeHead).not.toHaveBeenCalled();
    const preflight = call(state, "POST", "/preflight", {
      model: "gpt-6-pro", connector: "connector", gizmoId: "g-p-project", expectedAccountEmail: "account@example.test",
    });
    await preflight.pending;
    expect(preflight.res.statusCode).toBe(409);
    expect(JSON.parse(preflight.res.writes.join(""))).toEqual({ error: "lane_busy" });

    // Cancel by invocation id reaches only the slot running it.
    const cancel = call(state, "POST", "/cancel", { invocationId: "inv-2" });
    await cancel.pending;
    expect(cancel.res.statusCode).toBe(200);
    expect(JSON.parse(cancel.res.writes.join(""))).toMatchObject({ ok: true, invocationId: "inv-2" });
    expect(second.runner.cancel).toHaveBeenCalledTimes(1);
    expect(first.runner.cancel).not.toHaveBeenCalled();
    await ask2.pending;

    // The freed slot admits the queued ask on the already-open second tab.
    await tick();
    expect(state.queue.depth).toBe(0);
    expect(runAskOnSession).toHaveBeenCalledTimes(3);
    expect((runAskOnSession.mock.calls[2][1] as Session).page).toBe(slotSession.page);
    expect((state.session.context as unknown as { newPage: ReturnType<typeof vi.fn> }).newPage).toHaveBeenCalledTimes(1);

    third.finish();
    await ask3.pending;
    expect(await status(state)).toMatchObject({
      busy: false, lastConversation: "conv-3", slots: { total: 2, busy: 1, free: 1 },
    });

    first.finish();
    await ask1.pending;
    expect(await status(state)).toMatchObject({
      busy: false, currentConversation: null, lastConversation: "conv-1", slots: { total: 2, busy: 0, free: 2 },
    });
  });

  it("keeps today's single lane when the env is unset", async () => {
    const state = createServerState(fakeSession(), { background: true });
    expect(state.maxSlots).toBe(1);
    const first = pendingRunner("conv-1");
    const second = pendingRunner("conv-2");
    runAskOnSession.mockReturnValueOnce(first.runner).mockReturnValueOnce(second.runner);

    const ask1 = ask(state, "inv-1");
    await tick();
    const ask2 = ask(state, "inv-2");
    await tick();

    expect(ask1.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "text/event-stream" }));
    expect(ask2.res.writeHead).not.toHaveBeenCalled();
    expect(state.queue.depth).toBe(1);
    expect(await status(state)).toMatchObject({ busy: true, slots: { total: 1, busy: 1, free: 0 } });
    const preflight = call(state, "POST", "/preflight", {
      model: "gpt-6-pro", connector: "connector", gizmoId: "g-p-project", expectedAccountEmail: "account@example.test",
    });
    await preflight.pending;
    expect(preflight.res.statusCode).toBe(409);

    first.finish();
    await ask1.pending;
    await tick();
    expect(runAskOnSession).toHaveBeenCalledTimes(2);
    expect(runAskOnSession.mock.calls[1][1]).toBe(state.session);
    expect((state.session.context as unknown as { newPage: ReturnType<typeof vi.fn> }).newPage).not.toHaveBeenCalled();
    second.finish();
    await ask2.pending;
    expect(await status(state)).toMatchObject({ busy: false, lastConversation: "conv-2", slots: { total: 1, busy: 0, free: 1 } });
  });
});


describe("bounded preflight lease lifecycle", () => {
  const body = { model: "gpt-6-pro", connector: "fixture", gizmoId: "g-p-fixture", expectedAccountEmail: "a@b.test" };
  const flush = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function fixture() {
    const session = fakeSession();
    let closed = false;
    const page = Object.assign(session.page, {
      isClosed: () => closed,
      close: vi.fn(async () => { closed = true; }),
    });
    const state = createServerState(session, { background: true });
    return { state, page, session };
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("normal success releases once without closing its page", async () => {
    const { state, page } = fixture();
    runInteractionPreflight.mockResolvedValue({ model: "gpt-6-pro" });
    const request = call(state, "POST", "/preflight", body);
    await request.pending;
    expect(request.res.statusCode).toBe(200);
    expect(state.queue.busy).toBe(false);
    expect(page.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the exact page when verification/cleanup hangs, fencing until work settles", async () => {
    const { state, page, session } = fixture();
    const work = deferred();
    runInteractionPreflight.mockReturnValue(work.promise);
    const request = call(state, "POST", "/preflight", body);
    await flush();
    await vi.advanceTimersByTimeAsync(140_000);
    expect(page.close).toHaveBeenCalledWith({ runBeforeUnload: false });
    expect(state.queue.busy).toBe(true); // closed page alone is insufficient
    work.resolve();
    await request.pending;
    expect(request.res.statusCode).toBe(409);
    expect(state.interaction.failureCode).toBe("interaction_preflight_timeout");
    expect(state.queue.busy).toBe(false);
    // Slot zero must recreate a closed page before the next operation.
    runInteractionPreflight.mockResolvedValue({});
    const next = call(state, "POST", "/preflight", body);
    await next.pending;
    expect(session.context.newPage).toHaveBeenCalledOnce();
    expect(runInteractionPreflight.mock.calls[1][1].page).not.toBe(page);
    const recreated = await vi.mocked(session.context.newPage).mock.results[0].value;
    expect(state.session.page).toBe(recreated);
    expect(state.slots![0].page).toBe(recreated);
    expect(runInteractionPreflight.mock.calls[1][1].page).toBe(recreated);
    const paid = pendingRunner("recreated-slot-zero");
    runAskOnSession.mockReturnValue(paid.runner);
    const paidRequest = ask(state, "recreated-invocation");
    await flush();
    expect(runAskOnSession.mock.calls[0][1].page).toBe(recreated);
    paid.finish();
    await paidRequest.pending;
  });

  it.each(["throws", "hangs", "returns without closure"])("quarantines when page close %s, even if work later settles", async (mode) => {
    const { state, page } = fixture();
    const work = deferred();
    runInteractionPreflight.mockReturnValue(work.promise);
    page.close.mockImplementation(async () => {
      if (mode === "throws") throw new Error("private detail");
      if (mode === "hangs") await new Promise(() => {});
    });
    const request = call(state, "POST", "/preflight", body);
    await flush();
    await vi.advanceTimersByTimeAsync(150_000);
    await request.pending;
    expect(state.slots![0].leasedBy).toBe("preflight-quarantined");
    expect(state.queue.busy).toBe(true);
    expect(state.interaction.failureCode).toBe("interaction_preflight_recovery_required");
    expect(request.res.writes.join("")).not.toContain("private detail");
    work.resolve();
    await flush();
    expect(state.queue.tryAcquire()).toBe(false);
    expect(state.interaction.state).toBe("degraded");
  });

  it("keeps the fence when the page closes but original work never settles", async () => {
    const { state } = fixture();
    runInteractionPreflight.mockReturnValue(new Promise(() => {}));
    const request = call(state, "POST", "/preflight", body);
    await flush();
    await vi.advanceTimersByTimeAsync(150_000);
    await request.pending;
    expect(state.slots![0].leasedBy).toBe("preflight-quarantined");
    expect(state.queue.busy).toBe(true);
  });

  it("disconnect closes only the preflight page and preserves a sibling paid ask", async () => {
    process.env.CGPRO_DAEMON_SLOTS = "2";
    const { state, page, session } = fixture();
    const paid = pendingRunner("paid-conversation");
    runAskOnSession.mockReturnValue(paid.runner);
    const paidRequest = ask(state, "paid-invocation");
    await flush();
    const work = deferred();
    let probeClosed = false;
    const probe = Object.assign(fakePage("probe"), {
      isClosed: () => probeClosed,
      close: vi.fn(async () => { probeClosed = true; work.reject(new Error("page closed")); }),
    });
    vi.mocked(session.context.newPage).mockResolvedValue(probe as any);
    runInteractionPreflight.mockReturnValue(work.promise);
    const request = call(state, "POST", "/preflight", body);
    await flush();
    request.res.emit("close");
    await request.pending;
    expect(probe.close).toHaveBeenCalledOnce();
    expect(page.close).not.toHaveBeenCalled();
    expect(paid.runner.cancel).not.toHaveBeenCalled();
    expect(state.slots![0].currentInvocation).toBe("paid-invocation");
    expect(state.slots![0].busy).toBe(true);
    expect(state.slots![1].busy).toBe(false);
    expect(request.res.end).not.toHaveBeenCalled();
    paid.finish();
    await paidRequest.pending;
  });

  it("captures a new page before a hanging initialization and never starts preflight after cancellation", async () => {
    const { state, page, session } = fixture();
    await page.close();
    const opening = deferred<any>();
    vi.mocked(session.context.newPage).mockReturnValue(opening.promise);
    const request = call(state, "POST", "/preflight", body);
    await flush();
    await vi.advanceTimersByTimeAsync(140_000);
    const created = Object.assign(fakePage("late"), { close: vi.fn(async () => {}), isClosed: () => true });
    opening.resolve(created);
    await request.pending;
    expect(created.close).toHaveBeenCalled();
    expect(runInteractionPreflight).not.toHaveBeenCalled();
    expect(state.queue.busy).toBe(false);
  });

  it("closes a captured page while its initialization is hung", async () => {
    const { state, page, session } = fixture();
    await page.close();
    const navigation = deferred();
    chatgpt.goHome.mockImplementationOnce(() => navigation.promise);
    let closed = false;
    const created = Object.assign(fakePage("initializing"), {
      isClosed: () => closed,
      close: vi.fn(async () => { closed = true; navigation.reject(new Error("closed")); }),
    });
    vi.mocked(session.context.newPage).mockResolvedValue(created as any);
    const request = call(state, "POST", "/preflight", body);
    await flush();
    await vi.advanceTimersByTimeAsync(140_000);
    await request.pending;
    expect(created.close).toHaveBeenCalled();
    expect(runInteractionPreflight).not.toHaveBeenCalled();
    expect(state.queue.busy).toBe(false);
  });

  it("quarantines a stuck newPage and closes it if it arrives after the cleanup budget", async () => {
    const { state, page, session } = fixture();
    await page.close();
    const opening = deferred<any>();
    vi.mocked(session.context.newPage).mockReturnValue(opening.promise);
    const request = call(state, "POST", "/preflight", body);
    await flush();
    await vi.advanceTimersByTimeAsync(150_000);
    await request.pending;
    expect(state.slots![0].leasedBy).toBe("preflight-quarantined");
    let closed = false;
    const created = Object.assign(fakePage("very-late"), {
      close: vi.fn(async () => { closed = true; }), isClosed: () => closed,
    });
    opening.resolve(created);
    await flush();
    expect(created.close).toHaveBeenCalledOnce();
    expect(runInteractionPreflight).not.toHaveBeenCalled();
    expect(state.queue.busy).toBe(true);
    expect(state.interaction.failureCode).toBe("interaction_preflight_recovery_required");
  });


  it.each(["prompt-delivery", "cleanup-home", "cleanup-composer"])("freezes content-free timeout evidence at %s", async (phase) => {
    const { state, page } = fixture();
    const work = deferred();
    let observer!: (phase: string, failed?: string) => void;
    const failed = phase.startsWith("cleanup-") ? "connector" : undefined;
    runInteractionPreflight.mockImplementation((_opts, _session, report) => {
      observer = report;
      report(phase, failed);
      return work.promise;
    });
    const originalClose = page.close.getMockImplementation()!;
    page.close.mockImplementation(async () => {
      await originalClose();
      // Browser closure can advance finally; it must not overwrite deadline evidence.
      observer("cleanup-composer", failed);
      work.reject(new Error("private prompt/account/https://private.example/"));
    });
    const request = call(state, "POST", "/preflight", {
      ...body, probePrompt: "private prompt", expectedAccountEmail: "private@private.example",
    });
    await flush();
    await vi.advanceTimersByTimeAsync(290_000);
    await request.pending;
    expect(JSON.parse(request.res.writes.join(""))).toEqual({
      error: "interaction_preflight_failed", code: "interaction_preflight_timeout",
      phase, ...(failed ? { failedPhase: failed } : {}),
      elapsedMs: expect.any(Number), phaseElapsedMs: expect.any(Number),
      timeline: expect.any(Array), timelineTruncated: false,
      // P-035 2026-09-21. The refusal carries its own sentence as well as its
      // code: "which gate refused" and "what it saw" are different facts, and
      // the second is what a diagnosis runs on.
      message: expect.any(String),
    });
    // The intent here is that exception INTERNALS never reach the wire -- no
    // cause, no stack, no CLI hint. It used to assert the absence of the word
    // "private", which the fixture's own selector name contains and which the
    // message legitimately carries, so it tested the wrong thing twice.
    const wire = request.res.writes.join("");
    expect(wire).not.toContain('"cause"');
    expect(wire).not.toContain("stack");
    expect(wire).not.toContain('"hint"');
    expect(state.queue.busy).toBe(false);
  });


  it("distinguishes a late model stage from the whole budget and freezes before close", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { state, page } = fixture();
      const work = deferred();
      let report!: (phase: string, failed?: string, failure?: { code: string }) => void;
      runInteractionPreflight.mockImplementation((_opts, _session, observer) => { report = observer; return work.promise; });
      const originalClose = page.close.getMockImplementation()!;
      page.close.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await originalClose();
        report("cleanup-composer", "model-slider-focus", { code: "unclassified_error" });
        work.reject(new Error("closed"));
      });
      const request = call(state, "POST", "/preflight", body);
      await flush();
      now = 1_000;
      report("project-row-wait");
      await vi.advanceTimersByTimeAsync(138_000);
      now = 138_000;
      report("model-slider-focus");
      now = 140_000;
      await vi.advanceTimersByTimeAsync(2_000);
      now = 145_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await request.pending;
      expect(JSON.parse(request.res.writes.join(""))).toEqual({
        error: "interaction_preflight_failed", code: "interaction_preflight_timeout",
        phase: "model-slider-focus", elapsedMs: 140_000, phaseElapsedMs: 2_000,
        message: expect.any(String),
        timeline: [
          { phase: "slot-page", startedMs: 0, durationMs: 1_000 },
          { phase: "project-row-wait", startedMs: 1_000, durationMs: 137_000 },
          { phase: "model-slider-focus", startedMs: 138_000, durationMs: 2_000 },
        ], timelineTruncated: false,
      });
    } finally { clock.mockRestore(); }
  });

  it("caps the timeline and retains original classified failure through cancellation", async () => {
    const { state, page } = fixture();
    const work = deferred();
    runInteractionPreflight.mockImplementation((_opts, _session, report) => {
      for (let i = 0; i < 70; i++) report(i % 2 ? "project-row-wait" : "project-row-retry-wait");
      report("cleanup-home", "project-row-wait", { code: "browser_operation_timeout" });
      return work.promise;
    });
    const originalClose = page.close.getMockImplementation()!;
    page.close.mockImplementation(async () => { await originalClose(); work.reject(new Error("private")); });
    const request = call(state, "POST", "/preflight", body);
    await flush();
    await vi.advanceTimersByTimeAsync(140_000);
    await request.pending;
    const result = JSON.parse(request.res.writes.join(""));
    expect(result.timeline).toHaveLength(64);
    expect(result.timelineTruncated).toBe(true);
    expect(result.phase).toBe("cleanup-home");
    expect(result.failedPhase).toBe("project-row-wait");
    expect(result.failure).toEqual({ code: "browser_operation_timeout" });
    expect(request.res.writes.join("")).not.toContain("private");
  });

});
