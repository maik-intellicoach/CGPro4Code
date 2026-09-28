import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "patchright";
import {
  ensureInterceptorInstalled,
  setActiveEmitter,
  setExpectedReloadNavigation,
  streamBreakCount,
  StreamEmitter,
  type StreamEvent,
} from "../src/core/stream.js";

/**
 * P-035 G3 r41 (2026-09-28). A break in the in-page reader of ChatGPT's own
 * POST /backend-api/conversation SSE is not the end of the turn.
 *
 * Two live Pro turns under r40 (16:40 personal, 17:35 ms1980) had that reader
 * throw 1-2 min after submit while the assistant bubble was still growing and
 * the stop button was still on the page, and both conversations held the reply
 * afterwards. The terminal `error` event this branch used to push ended the
 * turn at 55-118 bytes and threw the reply away. These tests pin the three
 * properties of the restore: the emitter is never finished by a break, the
 * break is counted per page and per turn, and a reload CGPro itself asked for
 * is not a break at all.
 */

type Binding = (src: { page?: Page }, ...args: unknown[]) => void;

class CollectingEmitter extends StreamEmitter {
  events: StreamEvent[] = [];
  override push(event: StreamEvent): void {
    this.events.push(event);
    super.push(event);
  }
}

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

const noCapture = { lines: [] as string[], restore: (): void => {} };
let capture = noCapture;

/** Capture the content-free break lines the binding prints on stderr. */
function captureStderr(): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(String(args[0]));
  });
  capture = { lines, restore: () => spy.mockRestore() };
  return lines;
}

afterEach(() => {
  capture.restore();
  capture = noCapture;
});

describe("a stream break is not the end of the turn", () => {
  it("keeps the emitter open and counts the break instead of pushing a terminal error", async () => {
    const lines = captureStderr();
    const { __cgproStart: start, __cgproDone: done } = await installOnFakeContext();
    const page = { name: "A" } as unknown as Page;
    const emitter = new CollectingEmitter();
    setActiveEmitter(page, emitter);

    start({ page }, "obs-1");
    done({ page }, "obs-1", { reason: "error" });

    expect(emitter.isFinished()).toBe(false);
    expect(emitter.events).toEqual([]);
    expect(streamBreakCount(page)).toBe(1);
    expect(lines).toEqual(["[cgpro:stream] break=1 reason=error"]);
  });

  it("counts each break of the same turn and reports the running total", async () => {
    const lines = captureStderr();
    const { __cgproStart: start, __cgproDone: done } = await installOnFakeContext();
    const page = { name: "A" } as unknown as Page;
    const emitter = new CollectingEmitter();
    setActiveEmitter(page, emitter);

    start({ page }, "obs-1");
    done({ page }, "obs-1", { reason: "error" });
    start({ page }, "obs-2");
    done({ page }, "obs-2", { reason: "error" });

    expect(streamBreakCount(page)).toBe(2);
    expect(lines).toEqual([
      "[cgpro:stream] break=1 reason=error",
      "[cgpro:stream] break=2 reason=error",
    ]);
  });

  it("does not count a break during a reload CGPro itself asked for", async () => {
    const lines = captureStderr();
    const { __cgproStart: start, __cgproDone: done } = await installOnFakeContext();
    const page = { name: "A" } as unknown as Page;
    const emitter = new CollectingEmitter();
    setActiveEmitter(page, emitter);
    setExpectedReloadNavigation(page, true);

    start({ page }, "obs-1");
    done({ page }, "obs-1", { reason: "error" });

    expect(streamBreakCount(page)).toBe(0);
    expect(lines).toEqual([]);
    expect(emitter.isFinished()).toBe(false);
  });

  it("restarts the count on the next turn of the same page", async () => {
    const lines = captureStderr();
    const { __cgproStart: start, __cgproDone: done } = await installOnFakeContext();
    const page = { name: "A" } as unknown as Page;
    setActiveEmitter(page, new CollectingEmitter());
    start({ page }, "obs-1");
    done({ page }, "obs-1", { reason: "error" });
    expect(streamBreakCount(page)).toBe(1);

    // The page outlives the turn, so `break=1` has to mean the first break of
    // THIS turn, not the second break of the page's life.
    const next = new CollectingEmitter();
    setActiveEmitter(page, next);
    expect(streamBreakCount(page)).toBe(0);
    start({ page }, "obs-2");
    done({ page }, "obs-2", { reason: "error" });

    expect(lines).toEqual([
      "[cgpro:stream] break=1 reason=error",
      "[cgpro:stream] break=1 reason=error",
    ]);
    expect(next.isFinished()).toBe(false);
  });

  it("counts and reports nothing for a clean reader end", async () => {
    const lines = captureStderr();
    const { __cgproStart: start, __cgproDone: done } = await installOnFakeContext();
    const page = { name: "A" } as unknown as Page;
    const emitter = new CollectingEmitter();
    setActiveEmitter(page, emitter);

    start({ page }, "obs-1");
    done({ page }, "obs-1");

    expect(streamBreakCount(page)).toBe(0);
    expect(lines).toEqual([]);
    expect(emitter.isFinished()).toBe(false);
  });
});
