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

// What the fake composer currently holds. sendPrompt reads the composer back to
// confirm the whole prompt landed, so a stub that answers a constant string no
// longer models anything useful -- it would pass the completeness check for a
// composer that had never been written to.
let composed = "";

function fakeLocator(overrides: { click?: () => Promise<void>; innerText?: string } = {}) {
  return {
    click: overrides.click ?? (async () => {}),
    getAttribute: async () => null, // disabled=null, aria-disabled!=="true" -> enabled
    innerText: async () => overrides.innerText ?? composed,
  };
}

/** Accepts every write; `dropAfter` makes it accept only the first N writes. */
function fakePage(dropAfter = Infinity): Page {
  let writes = 0;
  const write = (text: string): void => {
    if (++writes > dropAfter) return;
    composed += text;
  };
  return {
    locator: vi.fn(() => ({ count: async () => 0 })),
    keyboard: {
      press: vi.fn(async (key: string) => {
        if (key === "Shift+Enter") write("\n");
        if (key === "Backspace") composed = ""; // Meta+A then Backspace clears
      }),
      type: vi.fn(async (text: string) => write(text)),
      insertText: vi.fn(async (text: string) => write(text)),
    },
    waitForTimeout: vi.fn(async () => {}),
  } as unknown as Page;
}

beforeEach(() => {
  composed = "";
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

  it("retypes when the prompt does not land, then refuses to submit", async () => {
    // insertText silently doing nothing must never submit an empty prompt to a
    // paid Pro run: the keystroke fallback gets one attempt, and a composer that
    // still does not hold the prompt throws instead of sending.
    requireSelector.mockResolvedValue(fakeLocator({ innerText: "   " }));
    firstResolved.mockResolvedValueOnce(fakeLocator());
    const page = fakePage();

    await expect(sendPrompt(page, "hello", true)).rejects.toThrow("composer delivery incomplete");

    expect(page.keyboard.insertText).toHaveBeenCalledWith("hello");
    expect(page.keyboard.type).toHaveBeenCalledWith("hello", { delay: 4 });
  });

  it("refuses to submit a prompt whose tail was dropped (P-035 2026-09-17)", async () => {
    // The invocation_id every connector tool requires is the LAST line of a
    // planning prompt. On 2026-09-17 two prompts reached ChatGPT without it:
    // the model answered the preamble it could see, asked for the id it could
    // not, called no tool, and both accounts were latched out of routing. The
    // old check asked only "is the composer empty?", so a composer holding the
    // head and nothing else passed.
    const click = vi.fn(async () => {});
    firstResolved.mockResolvedValue(fakeLocator({ click }));
    const page = fakePage(2); // takes the first line, drops everything after

    await expect(
      sendPrompt(page, 'question\nmore context\ninvocation_id="e4adf507"', false),
    ).rejects.toThrow("composer delivery incomplete");

    expect(click).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Enter");
  });

  it("refuses to submit when the composer cannot be read at all", async () => {
    // Fail CLOSED. Not re-typing into an unreadable composer is right; sending a
    // prompt we could not verify is not. The read is retried first so one flaky
    // innerText under load does not fail a turn that was actually fine.
    const click = vi.fn(async () => {});
    firstResolved.mockResolvedValue(fakeLocator({ click }));
    const unreadable = {
      ...fakeLocator(),
      innerText: async () => { throw new Error("Target page, context or browser has been closed"); },
    };
    requireSelector.mockResolvedValue(unreadable);
    const page = fakePage();

    await expect(sendPrompt(page, "hello", false)).rejects.toThrow("composer delivery unverifiable");

    expect(click).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Enter");
  });

  it("accepts a composer that recovers on a later read attempt", async () => {
    let reads = 0;
    const flaky = {
      ...fakeLocator(),
      innerText: async () => {
        if (++reads === 1) throw new Error("transient");
        return composed;
      },
    };
    requireSelector.mockResolvedValue(flaky);
    firstResolved.mockResolvedValue(fakeLocator());
    const page = fakePage();

    await expect(sendPrompt(page, "hello", false)).resolves.toBeDefined();
    expect(page.keyboard.type).not.toHaveBeenCalled(); // no needless retype
  });

  it("accepts a composer that already held text in preserveExisting mode", async () => {
    // preserveExisting appends to an inline connector pill's text, so the
    // composer legitimately holds more than the prompt. What must be intact is
    // the text just inserted, which is why the check is endsWith, not equality.
    composed = "pill text ";
    firstResolved.mockResolvedValue(fakeLocator());
    const page = fakePage();

    await expect(sendPrompt(page, "hello", true)).resolves.toBeDefined();
  });

  it("does not compose or submit after exact cancellation owns the turn", async () => {
    const page = fakePage();

    await expect(sendPrompt(page, "hello", false, () => true)).resolves.toBe(0);

    expect(firstResolved).not.toHaveBeenCalled();
    expect(page.keyboard.type).not.toHaveBeenCalled();
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Enter");
  });

  it("verifies the composed request after insertion and before sending", async () => {
    const order: string[] = [];
    firstResolved.mockResolvedValue(fakeLocator({ click: async () => { order.push("send"); } }));
    const page = fakePage();
    vi.mocked(page.keyboard.insertText).mockImplementation(async (text: string) => {
      order.push("insert");
      composed += text;
    });
    await sendPrompt(page, "research this", true, undefined, async () => { order.push("verify"); });
    expect(order).toEqual(["insert", "verify", "send"]);
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Backspace");
  });

  it("never clicks Send or presses Enter when the final mode check fails", async () => {
    const click = vi.fn(async () => {});
    firstResolved.mockResolvedValue(fakeLocator({ click }));
    const page = fakePage();
    await expect(sendPrompt(page, "research this", true, undefined, async () => {
      throw new Error("native mode missing");
    })).rejects.toThrow("native mode missing");
    expect(click).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Enter");
  });

  it("restores composer focus for Enter after verification moved focus into a menu", async () => {
    let focus = "none";
    requireSelector.mockResolvedValue(fakeLocator({ click: async () => { focus = "composer"; } }));
    firstResolved.mockResolvedValue(fakeLocator({ click: async () => { throw new Error("detached"); } }));
    const page = fakePage();
    vi.mocked(page.keyboard.press).mockImplementation(async (key) => {
      if (key === "Enter") expect(focus).toBe("composer");
    });
    await sendPrompt(page, "hello", true, undefined, async () => { focus = "menu"; });
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
  });
});
