import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "patchright";

// waitForEnabledSendButton resolves the send button via firstResolved —
// mock it so we can control exactly which Locator each attempt sees,
// without needing a full Playwright/patchright Page fake (C-092 P-026
// xfam r1 H2: the send-button click retry chain).
const firstResolved = vi.fn();
const requireSelector = vi.fn(async () => fakeLocator());
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));

// Bound retries small so a "all attempts fail" test doesn't need to wait
// out the real default.
process.env.CGPRO_SEND_CLICK_ATTEMPTS = "2";

const { sendPrompt } = await import("../src/browser/conversation.js");

function fakeLocator(overrides: { click?: () => Promise<void>; innerText?: string } = {}) {
  return {
    click: overrides.click ?? (async () => {}),
    getAttribute: async () => null, // disabled=null, aria-disabled!=="true" -> enabled
    // Non-empty by default: sendPrompt reads the composer back to confirm the
    // inserted prompt landed, and only retypes when it observes it empty.
    innerText: async () => overrides.innerText ?? "composed",
  };
}

function fakePage(): Page {
  return {
    locator: vi.fn(() => ({ count: async () => 0 })),
    keyboard: {
      press: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      insertText: vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {}),
  } as unknown as Page;
}

beforeEach(() => {
  firstResolved.mockReset();
  requireSelector.mockReset();
  requireSelector.mockImplementation(async () => fakeLocator());
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
    // The prompt is inserted, not typed: per-character typing let chatgpt.com's
    // inline @ / menus swallow keystrokes and open a native file picker
    // mid-run (2026-08-27). insertText emits no keydown, so no menu can fire.
    expect(page.keyboard.insertText).toHaveBeenCalledWith("hello");
    expect(page.keyboard.type).not.toHaveBeenCalled();
  });

  it("retypes the prompt only when the composer is positively observed empty", async () => {
    // insertText silently doing nothing must never submit an empty prompt to a
    // paid Pro run, so an observed-empty composer falls back to typing.
    const composer = fakeLocator({ innerText: "   " });
    requireSelector.mockResolvedValueOnce(composer);
    firstResolved.mockResolvedValueOnce(fakeLocator());
    const page = fakePage();

    await sendPrompt(page, "hello", true);

    expect(page.keyboard.insertText).toHaveBeenCalledWith("hello");
    expect(page.keyboard.type).toHaveBeenCalledWith("hello", { delay: 4 });
  });

  it("does not compose or submit after exact cancellation owns the turn", async () => {
    const page = fakePage();

    await expect(sendPrompt(page, "hello", false, () => true)).resolves.toBe(0);

    expect(firstResolved).not.toHaveBeenCalled();
    expect(page.keyboard.type).not.toHaveBeenCalled();
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Enter");
  });
});
