import { it, expect } from "vitest";
import type { BrowserContext, Page } from "patchright";
import {
  ensureInterceptorInstalled,
  setActiveEmitter,
  StreamEmitter,
  type StreamEvent,
} from "../src/core/stream.js";

// The bindings are context-scoped; each call carries the page it fired on
// (`_src.page`), and that page is the routing key (P-035 D23.0 / D2).
type Binding = (src: { page?: Page }, ...args: unknown[]) => void;

async function installOnFakeContext(): Promise<Record<string, Binding>> {
  const bindings: Record<string, Binding> = {};
  const context = {
    exposeBinding: async (name: string, callback: Binding) => {
      bindings[name] = callback;
    },
    addInitScript: async () => {},
  } as unknown as BrowserContext;
  await ensureInterceptorInstalled(context);
  return bindings;
}

class CollectingEmitter extends StreamEmitter {
  events: StreamEvent[] = [];
  override push(event: StreamEvent): void {
    this.events.push(event);
    super.push(event);
  }
}

const deltas = (emitter: CollectingEmitter): string[] =>
  emitter.events.flatMap((event) => (event.type === "delta" ? [event.text] : []));

it("routes chunks to the emitter of the page they came from and resets pages independently", async () => {
  const { __cgproStart: start, __cgproChunk: chunk, __cgproDone: done } = await installOnFakeContext();
  const pageA = { name: "A" } as unknown as Page;
  const pageB = { name: "B" } as unknown as Page;
  const emitterA = new CollectingEmitter();
  const emitterB = new CollectingEmitter();
  setActiveEmitter(pageA, emitterA);
  setActiveEmitter(pageB, emitterB);

  start({ page: pageA }, "obs-a");
  chunk({ page: pageA }, "obs-a", 'data: {"v":"Hel"}\n\n');
  expect(deltas(emitterA)).toEqual(["Hel"]);
  expect(emitterB.events).toEqual([]);

  // Resetting B leaves A's generation, observers and half-parsed frame alone.
  chunk({ page: pageA }, "obs-a", 'data: {"v":"lo"}');
  setActiveEmitter(pageB, null);
  chunk({ page: pageA }, "obs-a", "\n\n");
  expect(deltas(emitterA)).toEqual(["Hel", "lo"]);
  expect(emitterB.events).toEqual([]);

  // B's stream error stays on B.
  const emitterB2 = new CollectingEmitter();
  setActiveEmitter(pageB, emitterB2);
  start({ page: pageB }, "obs-b");
  done({ page: pageB }, "obs-b", { reason: "error" });
  expect(emitterB2.events).toEqual([{ type: "error", message: "fetch interceptor caught a stream error" }]);
  expect(emitterA.isFinished()).toBe(false);

  // A's own reset drops the old observer's chunks (generation guard), as before.
  const emitterA2 = new CollectingEmitter();
  setActiveEmitter(pageA, emitterA2);
  chunk({ page: pageA }, "obs-a", 'data: {"v":"stale"}\n\n');
  expect(emitterA2.events).toEqual([]);
  expect(deltas(emitterA)).toEqual(["Hel", "lo"]);
});
