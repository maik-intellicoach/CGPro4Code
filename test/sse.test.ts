import { describe, it, expect } from "vitest";
import type { BrowserContext } from "patchright";
import {
  ensureInterceptorInstalled,
  setActiveEmitter,
  setExpectedReloadNavigation,
  SseParser,
  StreamEmitter,
} from "../src/core/stream.js";

describe("SseParser", () => {
  it("parses simple {v: text} append deltas", () => {
    const p = new SseParser();
    const e1 = p.feed('data: {"v":"hello "}\n\n');
    const e2 = p.feed('data: {"v":"world"}\n\n');
    const text1 = e1.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    const text2 = e2.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text1).toBe("hello ");
    expect(text2).toBe("world");
    expect(p.cumulativeText()).toBe("hello world");
  });

  it("parses {p, o, v} json patches that target message parts", () => {
    const p = new SseParser();
    const events = p.feed(
      'data: {"p":"/message/content/parts/0","o":"append","v":"Bonjour"}\n\n' +
        'data: {"p":"/message/content/parts/0","o":"append","v":" monde"}\n\n',
    );
    const text = events
      .filter((e) => e.type === "delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("Bonjour monde");
  });

  it("handles cumulative {message.content.parts} replacement", () => {
    const p = new SseParser();
    const e1 = p.feed(
      'data: {"message":{"content":{"parts":["Hello"]}}}\n\n',
    );
    const e2 = p.feed(
      'data: {"message":{"content":{"parts":["Hello world"]}}}\n\n',
    );
    const t1 = e1.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    const t2 = e2.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(t1).toBe("Hello");
    expect(t2).toBe(" world");
    expect(p.cumulativeText()).toBe("Hello world");
  });

  it("emits a single 'started' before the first delta", () => {
    const p = new SseParser();
    const events = p.feed(
      'data: {"v":"a"}\n\ndata: {"v":"b"}\n\n',
    );
    const started = events.filter((e) => e.type === "started");
    expect(started.length).toBe(1);
  });

  it("captures conversation_id from the stream", () => {
    const p = new SseParser();
    const events = p.feed(
      'data: {"conversation_id":"abc","v":"hi"}\n\n',
    );
    const started = events.find((e) => e.type === "started") as { conversationId?: string } | undefined;
    expect(started?.conversationId).toBe("abc");
  });

  it("ignores [DONE] sentinel and malformed JSON", () => {
    const p = new SseParser();
    const events = p.feed(
      'data: {"v":"ok"}\n\ndata: not json\n\ndata: [DONE]\n\n',
    );
    const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("ok");
  });

  it("handles fragmented chunks across feed() calls", () => {
    const p = new SseParser();
    p.feed('data: {"v":"hel');
    p.feed('lo"}\n\ndata: {"v":" world"');
    const events = p.feed('}\n\n');
    const text = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe(" world");
    expect(p.cumulativeText()).toBe("hello world");
  });

  it("names custom connector tool results from invoked_resource metadata", () => {
    const p = new SseParser("p035-low-risk-workstation");
    const events = p.feed(
      'data: {"message":{"id":"tool-call-1","author":{"role":"tool"},"recipient":"all","content":{"content_type":"code","text":"{}"},"metadata":{"invoked_resource":{"resource_uri":"/asdk_app_redacted/link_redacted/search_context","app_name":"p035-low-risk-workstation"}}}}\n\n',
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool",
      name: "search_context",
      meta: { source: "sse", connector: "p035-low-risk-workstation", callId: "tool-call-1" },
    }));
  });

  it("rejects a correct tool tail from the wrong connector app", () => {
    const p = new SseParser("p035-low-risk-workstation");
    const events = p.feed(
      'data: {"message":{"author":{"role":"tool"},"recipient":"all","metadata":{"invoked_resource":{"resource_uri":"/app/link/search_context","app_name":"wrong-connector"}}}}\n\n',
    );
    expect(events.filter((event) => event.type === "tool")).toEqual([]);
  });
});

it("deduplicates the same connector call across branch and SSE evidence", async () => {
  const emitter = new StreamEmitter();
  emitter.push({
    type: "tool",
    name: "search_context",
    meta: { source: "latest-conversation-turn", callId: "call-1" },
  });
  emitter.push({
    type: "tool",
    name: "search_context",
    meta: { source: "sse", callId: "call-1" },
  });
  emitter.push({
    type: "tool",
    name: "search_context",
    meta: { source: "sse", callId: "call-2" },
  });
  emitter.push({ type: "done" });

  const events = [];
  for await (const event of emitter) events.push(event);
  expect(events.filter((event) => event.type === "tool")).toEqual([
    expect.objectContaining({ name: "search_context", meta: expect.objectContaining({ callId: "call-1" }) }),
    expect.objectContaining({ name: "search_context", meta: expect.objectContaining({ callId: "call-2" }) }),
  ]);
});

it("suppresses observer failures only during expected reload navigation", async () => {
  const setup = async (): Promise<{
    context: BrowserContext;
    start: (source: unknown, observerId: string) => void;
    done: (source: unknown, observerId: string, payload?: { reason?: string }) => void;
    emitter: StreamEmitter;
  }> => {
    let start: ((source: unknown, observerId: string) => void) | undefined;
    let done: ((source: unknown, observerId: string, payload?: { reason?: string }) => void) | undefined;
    const context = {
      exposeBinding: async (name: string, callback: typeof done | typeof start) => {
        if (name === "__cgproStart") start = callback as typeof start;
        if (name === "__cgproDone") done = callback;
      },
      addInitScript: async () => {},
    } as unknown as BrowserContext;
    await ensureInterceptorInstalled(context);
    const emitter = new StreamEmitter();
    setActiveEmitter(context, emitter);
    return { context, start: start!, done: done!, emitter };
  };

  const normal = await setup();
  normal.start({}, "normal");
  normal.done({}, "normal", { reason: "error" });
  expect(normal.emitter.isFinished()).toBe(true);

  const reloading = await setup();
  setExpectedReloadNavigation(reloading.context, true);
  reloading.start({}, "reloading");
  reloading.done({}, "reloading", { reason: "error" });
  expect(reloading.emitter.isFinished()).toBe(false);
});

it("does not deliver a late observer error to the next turn", async () => {
  let start: ((source: unknown, observerId: string) => void) | undefined;
  let done: ((source: unknown, observerId: string, payload?: { reason?: string }) => void) | undefined;
  const context = {
    exposeBinding: async (name: string, callback: typeof done | typeof start) => {
      if (name === "__cgproStart") start = callback as typeof start;
      if (name === "__cgproDone") done = callback as typeof done;
    },
    addInitScript: async () => {},
  } as unknown as BrowserContext;
  await ensureInterceptorInstalled(context);

  const first = new StreamEmitter();
  setActiveEmitter(context, first);
  start!({}, "old-observer");

  const second = new StreamEmitter();
  setActiveEmitter(context, second);
  done!({}, "old-observer", { reason: "error" });

  expect(second.isFinished()).toBe(false);
});
