import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { TurnTimeoutError } from "../src/errors.js";

const firstResolved = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: vi.fn(),
}));

const { waitTurnComplete } = await import("../src/browser/conversation.js");

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
    const page = {} as Page;

    await expect(waitTurnComplete(page, 1_200_000)).rejects.toEqual(
      new TurnTimeoutError(1_200),
    );
  });
});
