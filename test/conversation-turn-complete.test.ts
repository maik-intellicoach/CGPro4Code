import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { TurnTimeoutError } from "../src/errors.js";

const firstResolved = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: vi.fn(),
}));

const { openConversation, waitTurnComplete } = await import("../src/browser/conversation.js");

afterEach(() => {
  firstResolved.mockReset();
  vi.restoreAllMocks();
});

describe("waitTurnComplete error classification", () => {
  it("propagates a phase-1 closed-page error unchanged", async () => {
    const closed = new Error("Target page, context or browser has been closed");
    const page = {
      locator: vi.fn(() => ({ count: async () => { throw closed; } })),
      waitForTimeout: vi.fn(async () => {}),
    } as unknown as Page;

    await expect(waitTurnComplete(page, 1_200_000)).rejects.toBe(closed);
  });

  it("propagates a phase-2 closed-page error unchanged", async () => {
    const closed = new Error("Target page, context or browser has been closed");
    const count = vi.fn()
      .mockResolvedValueOnce(1) // phase 1 sees the new assistant bubble
      .mockRejectedValueOnce(closed); // phase 2 loses the page while reading it
    const page = {
      locator: vi.fn(() => ({ count, nth: vi.fn() })),
      waitForTimeout: vi.fn(async () => {}),
    } as unknown as Page;
    firstResolved.mockResolvedValue(null);

    await expect(waitTurnComplete(page, 1_200_000)).rejects.toBe(closed);
  });

  it("uses TurnTimeoutError only after the actual 1200-second deadline", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(1_200_000);
    const page = { url: () => "https://chatgpt.com/" } as Page;

    await expect(waitTurnComplete(page, 1_200_000)).rejects.toEqual(
      new TurnTimeoutError(1_200),
    );
  });

  it("returns when cancellation arrives while the turn waiter is active", async () => {
    let cancelled = false;
    const page = {
      locator: vi.fn(() => ({ count: vi.fn(async () => 0) })),
      waitForTimeout: vi.fn(async () => { cancelled = true; }),
    } as unknown as Page;

    await expect(
      waitTurnComplete(page, 1_200_000, 0, undefined, { cancelled: () => cancelled }),
    ).resolves.toBeUndefined();

    expect(page.waitForTimeout).toHaveBeenCalledTimes(1);
  });

  it("reloads the exact conversation and extends while ChatGPT is still working", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let reloaded = false;
      const bubble = {
        getAttribute: vi.fn(async () => null),
        innerText: vi.fn(async () => "ready"),
      };
      const locator = {
        count: vi.fn(async () => reloaded ? 1 : 0),
        nth: vi.fn(() => bubble),
      };
      const page = {
        locator: vi.fn(() => locator),
        goto: vi.fn(async () => { reloaded = true; }),
        context: vi.fn(() => ({})),
        waitForTimeout: vi.fn(async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); }),
      } as unknown as Page;
      firstResolved.mockResolvedValueOnce({}).mockResolvedValue(null);
      const onReload = vi.fn();

      await waitTurnComplete(page, 10_000, 0, 100, {
        conversationId: () => "conv-1",
        onReload,
      });

      expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/c/conv-1", expect.any(Object));
      expect(onReload).toHaveBeenCalledWith({ conversationId: "conv-1", working: true, extended: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

it("opens a new conversation inside a Project when only its stable short URL is configured", async () => {
  firstResolved.mockResolvedValue(null);
  const page = {
    goto: vi.fn(async () => {}),
  } as unknown as Page;

  await openConversation(page, { gizmoShortUrl: "p35-work-team" });

  expect(page.goto).toHaveBeenCalledWith(
    "https://chatgpt.com/g/p35-work-team/project",
    expect.objectContaining({ waitUntil: "domcontentloaded" }),
  );
});
