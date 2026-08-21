import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "patchright";

// waitForEnabledSendButton resolves the send button via firstResolved —
// mock it so we can control exactly which Locator each attempt sees,
// without needing a full Playwright/patchright Page fake (C-092 P-026
// xfam r1 H2: the send-button click retry chain).
const firstResolved = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: vi.fn(async () => fakeLocator()),
}));

// Bound retries small so a "all attempts fail" test doesn't need to wait
// out the real default.
process.env.CGPRO_SEND_CLICK_ATTEMPTS = "2";

const { sendPrompt } = await import("../src/browser/conversation.js");

function fakeLocator(overrides: { click?: () => Promise<void> } = {}) {
  return {
    click: overrides.click ?? (async () => {}),
    getAttribute: async () => null, // disabled=null, aria-disabled!=="true" -> enabled
  };
}

function fakePage(): Page {
  return {
    locator: vi.fn(() => ({ count: async () => 0 })),
    keyboard: {
      press: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {}),
  } as unknown as Page;
}

beforeEach(() => {
  firstResolved.mockReset();
});

describe("sendPrompt send-button fallback (C-092 H2)", () => {
  it("re-resolves the send button and retries after a click failure, without falling through to Enter", async () => {
    const clickA = vi.fn(async () => {
      throw new Error("element detached (DOM redraw)");
    });
    const clickB = vi.fn(async () => {});
    firstResolved.mockResolvedValueOnce(fakeLocator({ click: clickA }));
    firstResolved.mockResolvedValueOnce(fakeLocator({ click: clickB }));

    const page = fakePage();
    await sendPrompt(page, "hello");

    expect(clickA).toHaveBeenCalledTimes(1);
    expect(clickB).toHaveBeenCalledTimes(1); // the fallback chain WAS reachable
    expect(firstResolved).toHaveBeenCalledTimes(2); // re-resolved, not reused stale locator
    expect(page.keyboard.press).toHaveBeenCalledWith("Meta+A");
    expect(page.keyboard.press).toHaveBeenCalledWith("Backspace");
    expect((page.keyboard.press as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith("Enter");
  });

  it("falls back to Enter once every bounded click attempt fails", async () => {
    const click = vi.fn(async () => {
      throw new Error("always fails");
    });
    firstResolved.mockImplementation(async () => fakeLocator({ click }));

    const page = fakePage();
    await sendPrompt(page, "hello");

    expect(click).toHaveBeenCalledTimes(2); // CGPRO_SEND_CLICK_ATTEMPTS=2
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
  });

  it("uses the first successful click and never falls back when it succeeds immediately", async () => {
    const click = vi.fn(async () => {});
    firstResolved.mockResolvedValueOnce(fakeLocator({ click }));

    const page = fakePage();
    await sendPrompt(page, "hello");

    expect(click).toHaveBeenCalledTimes(1);
    expect(firstResolved).toHaveBeenCalledTimes(1);
    expect((page.keyboard.press as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith("Enter");
  });

  it("preserves an inline connector pill when requested", async () => {
    firstResolved.mockResolvedValueOnce(fakeLocator());
    const page = fakePage();

    await sendPrompt(page, "hello", true);

    expect(page.keyboard.press).not.toHaveBeenCalledWith("Meta+A");
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Backspace");
    expect(page.keyboard.type).toHaveBeenCalledWith("hello", { delay: 4 });
  });
});
