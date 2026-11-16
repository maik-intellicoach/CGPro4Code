import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

// P-035 2026-11-16. /archive-saved recycles exactly the daemon-owned tab of a
// conversation it just verified archived, and nothing else. Browser work is
// faked at the module seams, as in test/daemon-slots.test.ts.
const runAskOnSession = vi.fn();
vi.mock("../src/core/orchestrator.js", () => ({
  runAskOnSession: (...args: unknown[]) => runAskOnSession(...args),
  runInteractionPreflight: vi.fn(),
}));

const filing = vi.hoisted(() => ({ archiveSavedConversation: vi.fn() }));
vi.mock("../src/api/conversation-filing.js", () => filing);

const chatgpt = vi.hoisted(() => ({
  goHome: vi.fn(async () => {}),
  isLoggedIn: vi.fn(async () => true),
}));
vi.mock("../src/browser/chatgpt.js", async () => {
  const actual = await vi.importActual<typeof import("../src/browser/chatgpt.js")>("../src/browser/chatgpt.js");
  return { ...actual, ...chatgpt };
});

const guards = vi.hoisted(() => ({
  turnIsWorking: vi.fn(async (_page: unknown) => false),
  assertPreflightDraftSafe: vi.fn(async (_page: unknown): Promise<undefined> => undefined),
}));
vi.mock("../src/browser/conversation.js", async () => {
  const actual = await vi.importActual<typeof import("../src/browser/conversation.js")>(
    "../src/browser/conversation.js",
  );
  return { ...actual, ...guards };
});

const posture = vi.hoisted(() => ({
  showWindow: vi.fn(async () => 7),
  parkWindow: vi.fn(async () => 7),
}));
vi.mock("../src/browser/session.js", async () => {
  const actual = await vi.importActual<typeof import("../src/browser/session.js")>("../src/browser/session.js");
  return { ...actual, ...posture };
});

const { createServerState, handleRequest, slotsOf } = await import("../src/daemon/server.js");
import type { ServerState } from "../src/daemon/server.js";
import type { Session } from "../src/browser/session.js";
import { StreamEmitter } from "../src/core/stream.js";

const TARGET = "6aa51e0c-0688-83ec-a868-8dffde427046";
const OTHER = "7bb51e0c-0688-83ec-a868-8dffde427047";
const identity = { conversationId: TARGET, projectId: "g-p-fixture", expectedEmail: "fixture@example.com", fingerprint: "a".repeat(64) };
const verified = { status: "verified", conversationId: TARGET, projectId: "g-p-fixture", accountVerified: true, archived: true, fingerprint: "a".repeat(64) };

class FakeReq extends EventEmitter {
  headers: Record<string, string> = {};
  setEncoding = vi.fn();
}

class FakeRes extends EventEmitter {
  headersSent = false;
  statusCode = 0;
  writes: string[] = [];
  writeHead = vi.fn((status: number) => { this.statusCode = status; this.headersSent = true; return this; });
  write = vi.fn((chunk: string) => { this.writes.push(chunk); return true; });
  end = vi.fn((chunk?: string) => { if (chunk) this.writes.push(chunk); });
}

type FakePage = {
  name: string;
  url: () => string;
  isClosed: () => boolean;
  once: ReturnType<typeof vi.fn>;
  context: () => object;
  close: ReturnType<typeof vi.fn>;
};

function fakePage(name: string, conversation: string | null = null): FakePage {
  let closed = false;
  return {
    name,
    url: () => (conversation ? `https://chatgpt.com/c/${conversation}` : "https://chatgpt.com/"),
    isClosed: () => closed,
    once: vi.fn(),
    context: () => ({}),
    close: vi.fn(async () => { closed = true; }),
  };
}

/** A P-045 lane session (lane set) unless `lane` is false: a private persistent profile. */
function fakeSession(first: FakePage, lane = true): Session & { context: { newPage: ReturnType<typeof vi.fn> } } {
  const context = { newPage: vi.fn(async () => fakePage("recreated")) };
  return {
    context,
    page: first,
    close: vi.fn(),
    ...(lane ? { lane: "http://127.0.0.1:9252", adopt: vi.fn() } : {}),
  } as unknown as Session & { context: { newPage: ReturnType<typeof vi.fn> } };
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

async function archive(state: ServerState): Promise<FakeRes> {
  const { res, pending } = call(state, "POST", "/archive-saved", identity);
  await pending;
  return res;
}

function pendingRunner(conversationId: string): { runner: unknown; finish: () => void } {
  const events = new StreamEmitter();
  events.push({ type: "started", conversationId });
  let finish!: () => void;
  const result = new Promise<unknown>((resolve) => {
    finish = () => {
      events.push({ type: "done", finalText: "ok" });
      resolve({ conversationId, finalText: "ok", events: [] });
    };
  });
  return { runner: { events, result, cancel: vi.fn(async () => finish()) }, finish };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.clearAllMocks();
  guards.turnIsWorking.mockImplementation(async () => false);
  guards.assertPreflightDraftSafe.mockImplementation(async () => undefined);
  filing.archiveSavedConversation.mockResolvedValue(verified);
  delete process.env.CGPRO_DAEMON_SLOTS;
});

describe("/archive-saved recycles only a verified, idle, owned target page", () => {
  it("closes the lane's slot-0 tab after the answer and the next ask transparently recreates it", async () => {
    const first = fakePage("slot-0", TARGET);
    const session = fakeSession(first);
    const state = createServerState(session, { background: false });
    let statusAtClose = 0;
    const res = new FakeRes();
    first.close.mockImplementation(async () => {
      statusAtClose = res.statusCode;
      (first as { isClosed: () => boolean }).isClosed = () => true;
    });
    const req = new FakeReq();
    Object.assign(req, { method: "POST", url: "/archive-saved", headers: { authorization: `Bearer ${state.token}` } });
    const pending = handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, state);
    req.emit("data", JSON.stringify(identity)); req.emit("end");
    await pending;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.writes.join(""))).toEqual(verified);
    // The answer was already sent when the tab closed; the lease was still held.
    expect(statusAtClose).toBe(200);
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledWith({ runBeforeUnload: false });
    expect(guards.turnIsWorking).toHaveBeenCalledWith(first);
    expect(guards.assertPreflightDraftSafe).toHaveBeenCalledWith(first);
    expect(state.slots![0].busy).toBe(false);
    expect(state.queue.busy).toBe(false);
    // Browser and context stay warm; the session is never closed.
    expect(session.close).not.toHaveBeenCalled();

    const paid = pendingRunner(OTHER);
    runAskOnSession.mockReturnValue(paid.runner);
    const next = call(state, "POST", "/ask", { prompt: "hi", invocationId: "after-recycle", timeoutSec: 60 });
    await flush();
    expect(session.context.newPage).toHaveBeenCalledOnce();
    const recreated = await session.context.newPage.mock.results[0].value;
    expect(state.session.page).toBe(recreated);
    expect(state.slots![0].page).toBe(recreated);
    expect(session.adopt).toHaveBeenCalledWith(recreated);
    expect(runAskOnSession.mock.calls[0][1]).toBe(state.session);
    expect((runAskOnSession.mock.calls[0][1] as Session).page).toBe(recreated);
    paid.finish();
    await next.pending;
  });

  it("prefers the free slot already showing the target and recycles only that tab", async () => {
    process.env.CGPRO_DAEMON_SLOTS = "2";
    const zero = fakePage("slot-0", OTHER);
    const session = fakeSession(zero);
    const state = createServerState(session, { background: false });
    const one = fakePage("slot-1", TARGET);
    slotsOf(state)[1].page = one as never;

    expect((await archive(state)).statusCode).toBe(200);
    expect(filing.archiveSavedConversation.mock.calls[0][0]).toBe(one);
    expect(one.close).toHaveBeenCalledOnce();
    expect(state.slots![1].page).toBeNull();
    expect(zero.close).not.toHaveBeenCalled();
    expect(state.session.page).toBe(zero);
    expect(session.context.newPage).not.toHaveBeenCalled();
  });

  it("recycles a matching extra slot in a private profile but never that profile's slot-0 page", async () => {
    process.env.CGPRO_DAEMON_SLOTS = "2";
    const zero = fakePage("slot-0", TARGET);
    const state = createServerState(fakeSession(zero, false), { background: false });
    expect((await archive(state)).statusCode).toBe(200);
    expect(zero.close).not.toHaveBeenCalled();

    const one = fakePage("slot-1", TARGET);
    slotsOf(state)[1].page = one as never;
    (zero as { url: () => string }).url = () => `https://chatgpt.com/c/${OTHER}`;
    expect((await archive(state)).statusCode).toBe(200);
    expect(one.close).toHaveBeenCalledOnce();
    expect(zero.close).not.toHaveBeenCalled();
  });

  it("keeps a page that was only an API transport for another conversation", async () => {
    const first = fakePage("slot-0", OTHER);
    const state = createServerState(fakeSession(first), { background: false });
    const res = await archive(state);
    expect(res.statusCode).toBe(200);
    expect(filing.archiveSavedConversation.mock.calls[0][0]).toBe(first);
    expect(first.close).not.toHaveBeenCalled();
    expect(guards.turnIsWorking).not.toHaveBeenCalled();
  });

  it("never takes or waits for a busy matching slot, and keeps every page while a sibling works", async () => {
    process.env.CGPRO_DAEMON_SLOTS = "2";
    const zero = fakePage("slot-0", TARGET);
    const state = createServerState(fakeSession(zero), { background: false });
    const one = fakePage("slot-1", TARGET);
    slotsOf(state)[0].busy = true;
    slotsOf(state)[0].leasedBy = "ask";
    slotsOf(state)[1].page = one as never;

    expect((await archive(state)).statusCode).toBe(200);
    // Slot 1 was the only free one; slot 0's ask is untouched.
    expect(filing.archiveSavedConversation.mock.calls[0][0]).toBe(one);
    expect(state.slots![0].busy).toBe(true);
    expect(one.close).not.toHaveBeenCalled();
    expect(zero.close).not.toHaveBeenCalled();
  });

  it("re-checks after inspection: work queued meanwhile keeps the page", async () => {
    const first = fakePage("slot-0", TARGET);
    const state = createServerState(fakeSession(first), { background: false });
    let queued: Promise<void> | undefined;
    guards.turnIsWorking.mockImplementation(async () => {
      queued = state.queue.acquire();
      return false;
    });
    expect((await archive(state)).statusCode).toBe(200);
    expect(first.close).not.toHaveBeenCalled();
    expect(guards.assertPreflightDraftSafe).not.toHaveBeenCalled();
    await queued;
    state.queue.release();
  });

  it("re-checks after the composer read: a sibling lease taken meanwhile keeps the page", async () => {
    process.env.CGPRO_DAEMON_SLOTS = "2";
    const first = fakePage("slot-0", TARGET);
    const state = createServerState(fakeSession(first), { background: false });
    guards.assertPreflightDraftSafe.mockImplementation(async () => {
      slotsOf(state)[1].busy = true;
      return undefined;
    });
    expect((await archive(state)).statusCode).toBe(200);
    expect(first.close).not.toHaveBeenCalled();
  });

  it.each([
    ["a generating turn", () => guards.turnIsWorking.mockResolvedValue(true)],
    ["an unreadable working state", () => guards.turnIsWorking.mockRejectedValue(new Error("detached"))],
    ["a draft or unknown composer", () => guards.assertPreflightDraftSafe.mockRejectedValue(new Error("draft guard refused"))],
  ])("keeps the page on %s and still answers the verified archive", async (_name, arrange) => {
    arrange();
    const first = fakePage("slot-0", TARGET);
    const state = createServerState(fakeSession(first), { background: false });
    const res = await archive(state);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.writes.join(""))).toEqual(verified);
    expect(first.close).not.toHaveBeenCalled();
    expect(state.queue.busy).toBe(false);
  });

  it.each([
    ["an archive/fingerprint refusal", () => filing.archiveSavedConversation.mockRejectedValue(new Error("archive refused: account, Project or conversation content changed")), 409],
    ["an unarchived proof", () => filing.archiveSavedConversation.mockResolvedValue({ ...verified, archived: false }), 200],
    ["a proof for another conversation", () => filing.archiveSavedConversation.mockResolvedValue({ ...verified, conversationId: OTHER }), 200],
  ])("keeps the page after %s", async (_name, arrange, code) => {
    arrange();
    const first = fakePage("slot-0", TARGET);
    const state = createServerState(fakeSession(first), { background: false });
    expect((await archive(state)).statusCode).toBe(code);
    expect(first.close).not.toHaveBeenCalled();
    expect(guards.turnIsWorking).not.toHaveBeenCalled();
    expect(state.queue.busy).toBe(false);
  });

  it("a failed close leaves the archive answer, the lease release and the output untouched, with no replay", async () => {
    const first = fakePage("slot-0", TARGET);
    first.close.mockRejectedValue(new Error("target closed"));
    const state = createServerState(fakeSession(first), { background: false });
    const res = await archive(state);
    expect(res.statusCode).toBe(200);
    expect(res.writeHead).toHaveBeenCalledOnce();
    expect(JSON.parse(res.writes.join(""))).toEqual(verified);
    expect(filing.archiveSavedConversation).toHaveBeenCalledOnce();
    expect(runAskOnSession).not.toHaveBeenCalled();
    expect(state.slots![0].busy).toBe(false);
    expect(state.queue.busy).toBe(false);
  });

  describe("bounded cleanup", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("an inspection that hangs is abandoned without closing and the lease is released", async () => {
      const first = fakePage("slot-0", TARGET);
      let finishInspection!: (working: boolean) => void;
      guards.turnIsWorking.mockImplementation(() => new Promise<boolean>((resolve) => { finishInspection = resolve; }));
      const state = createServerState(fakeSession(first), { background: false });
      const { res, pending } = call(state, "POST", "/archive-saved", identity);
      await flush();
      expect(res.statusCode).toBe(200);
      expect(guards.turnIsWorking).toHaveBeenCalledOnce();
      expect(state.queue.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(state.queue.busy).toBe(false);
      expect(state.slots![0].busy).toBe(false);
      // A late answer from the abandoned inspection must not close the page.
      finishInspection(false);
      await flush();
      expect(guards.assertPreflightDraftSafe).not.toHaveBeenCalled();
      expect(first.close).not.toHaveBeenCalled();
    });

    // P-035 2026-11-16 correction. A close that already STARTED cannot lose
    // custody at the bound: a late close would interrupt the next ask's page.
    /** Makes `page.close()` start and stay pending until the test settles it. */
    function hangClose(page: FakePage): { finish: (closed: boolean) => void; fail: (closed: boolean) => void } {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      page.close.mockImplementation(() => new Promise<void>((res, rej) => { resolve = res; reject = rej; }));
      const mark = (closed: boolean): void => { (page as { isClosed: () => boolean }).isClosed = () => closed; };
      return {
        finish: (closed) => { mark(closed); resolve(); },
        fail: (closed) => { mark(closed); reject(new Error("Target page, context or browser has been closed")); },
      };
    }

    const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

    async function archiveWithHungClose(state: ServerState, first: FakePage): Promise<FakeRes> {
      const { res, pending } = call(state, "POST", "/archive-saved", identity);
      await flush();
      expect(first.close).toHaveBeenCalledOnce();
      await advance(10_000);
      await pending;
      // The archive answer and its saved-output proof are untouched by cleanup.
      expect(res.statusCode).toBe(200);
      expect(res.writeHead).toHaveBeenCalledOnce();
      expect(JSON.parse(res.writes.join(""))).toEqual(verified);
      expect(filing.archiveSavedConversation).toHaveBeenCalledOnce();
      return res;
    }

    it("a close pending past the bound keeps custody; the waiting ask gets a fresh page only after it settles", async () => {
      const first = fakePage("slot-0", TARGET);
      const session = fakeSession(first);
      const state = createServerState(session, { background: false });
      const close = hangClose(first);
      await archiveWithHungClose(state, first);

      // Custody and capacity stay held: the dying page cannot be leased.
      expect(state.slots![0].busy).toBe(true);
      expect(state.slots![0].leasedBy).toBe("archive-recycle-closing");
      expect(state.queue.busy).toBe(true);
      expect(state.queue.tryAcquire()).toBe(false);

      const paid = pendingRunner(OTHER);
      runAskOnSession.mockReturnValue(paid.runner);
      const next = call(state, "POST", "/ask", { prompt: "hi", invocationId: "during-close", timeoutSec: 60 });
      await advance(0);
      // The ask waits for capacity; it never receives the closing page.
      expect(state.queue.depth).toBe(1);
      expect(runAskOnSession).not.toHaveBeenCalled();
      expect(session.context.newPage).not.toHaveBeenCalled();

      close.finish(true);
      await advance(0);
      // Released exactly once on settlement; the ask then opens a fresh page.
      expect(state.queue.depth).toBe(0);
      expect(session.context.newPage).toHaveBeenCalledOnce();
      const recreated = await session.context.newPage.mock.results[0].value;
      expect(runAskOnSession).toHaveBeenCalledOnce();
      expect((runAskOnSession.mock.calls[0][1] as Session).page).toBe(recreated);
      expect((runAskOnSession.mock.calls[0][1] as Session).page).not.toBe(first);
      expect(state.slots![0].leasedBy).toBe("ask");
      // The late close already happened on the old page; nothing closes the new one.
      expect(first.close).toHaveBeenCalledOnce();
      expect((recreated as FakePage).close).not.toHaveBeenCalled();
      expect(session.close).not.toHaveBeenCalled();

      paid.finish();
      await advance(0);
      await next.pending;
      expect(state.slots![0].busy).toBe(false);
      expect(state.queue.busy).toBe(false);
      // Capacity is exactly one again: no leak and no overcount.
      expect(state.queue.tryAcquire()).toBe(true);
      expect(state.queue.tryAcquire()).toBe(false);
      state.queue.release();
    });

    it.each([
      ["browser disconnect (page gone)", true],
      ["close rejection (page still reported open)", false],
    ])("a late %s settles custody once with consistent capacity and no replay", async (_name, closedAfter) => {
      const first = fakePage("slot-0", TARGET);
      const state = createServerState(fakeSession(first), { background: false });
      const close = hangClose(first);
      await archiveWithHungClose(state, first);
      expect(state.slots![0].leasedBy).toBe("archive-recycle-closing");
      expect(state.queue.busy).toBe(true);

      close.fail(closedAfter);
      await advance(0);
      expect(state.slots![0].busy).toBe(false);
      expect(state.slots![0].leasedBy).toBeNull();
      expect(state.queue.busy).toBe(false);
      expect(state.queue.tryAcquire()).toBe(true);
      expect(state.queue.tryAcquire()).toBe(false);
      state.queue.release();
      // Cleanup never replays the archive or an ask, and never closes twice.
      expect(filing.archiveSavedConversation).toHaveBeenCalledOnce();
      expect(runAskOnSession).not.toHaveBeenCalled();
      expect(first.close).toHaveBeenCalledOnce();
    });

    it("a close that never settles leaves the slot explicitly quarantined without overcounting capacity", async () => {
      process.env.CGPRO_DAEMON_SLOTS = "2";
      const first = fakePage("slot-0", TARGET);
      const session = fakeSession(first);
      const state = createServerState(session, { background: false });
      hangClose(first);
      await archiveWithHungClose(state, first);
      expect(state.slots![0].busy).toBe(true);
      expect(state.slots![0].leasedBy).toBe("archive-recycle-closing");

      // A new ask leases the other slot on a fresh page, never the closing one.
      const paid = pendingRunner(OTHER);
      runAskOnSession.mockReturnValue(paid.runner);
      const next = call(state, "POST", "/ask", { prompt: "hi", invocationId: "beside-close", timeoutSec: 60 });
      await advance(0);
      expect(runAskOnSession).toHaveBeenCalledOnce();
      const recreated = await session.context.newPage.mock.results[0].value;
      expect(state.slots![1].page).toBe(recreated);
      expect((runAskOnSession.mock.calls[0][1] as Session).page).toBe(recreated);
      expect(state.slots![1].leasedBy).toBe("ask");
      paid.finish();
      await advance(0);
      await next.pending;

      await advance(60_000);
      // Still quarantined, holding exactly its one unit of capacity.
      expect(state.slots![0].busy).toBe(true);
      expect(state.slots![0].leasedBy).toBe("archive-recycle-closing");
      expect(state.slots![1].busy).toBe(false);
      expect(state.queue.busy).toBe(false);
      expect(state.queue.tryAcquire()).toBe(true);
      expect(state.queue.tryAcquire()).toBe(false);
      state.queue.release();
      expect(first.close).toHaveBeenCalledOnce();
    });

    it("an inspection still pending at the bound can no longer start a close, even if it answers later", async () => {
      const first = fakePage("slot-0", TARGET);
      let finishComposer!: () => void;
      guards.assertPreflightDraftSafe.mockImplementation(
        () => new Promise<undefined>((resolve) => { finishComposer = () => resolve(undefined); }),
      );
      const state = createServerState(fakeSession(first), { background: false });
      const { pending } = call(state, "POST", "/archive-saved", identity);
      await flush();
      expect(guards.assertPreflightDraftSafe).toHaveBeenCalledOnce();
      await advance(10_000);
      await pending;
      // No close started: the ordinary release applies.
      expect(state.slots![0].busy).toBe(false);
      expect(state.queue.busy).toBe(false);
      finishComposer();
      await flush();
      expect(first.close).not.toHaveBeenCalled();
    });
  });
});
