import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";

const firstResolved = vi.fn();
const requireSelector = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));

process.env.CGPRO_SEND_CLICK_ATTEMPTS = "1";
process.env.CGPRO_COMPOSER_PASTE_SETTLE_MS = "0";

const { sendPrompt } = await import("../src/browser/conversation.js");

// P-035 2026-09-18, the measured cause of the delivery losses. Typing the
// prompt line by line runs it through ProseMirror's markdown input rules, and
// the inline-code rule destroyed 18 of 18 lines whose closing backtick was the
// last character of the insertion. Pasting is parsed by a different code path,
// so these tests are about one thing: does the prompt go through paste, and
// does it still arrive when paste is the one thing that fails?
describe("composer paste delivery", () => {
  let composed = "";
  // Meta+A selects all; Backspace then deletes the selection. Without that
  // state a plain Backspace looks like a clear, and the typed path's
  // input-rule guard (insert a trailing space, delete it) would wipe the
  // composer instead of removing one character.
  let selectedAll = false;

  /** `delivers` models what the page does with the dispatched paste event. */
  function fakePage(delivers: "all" | "nothing" | "throws"): Page {
    const composer = {
      innerText: async () => composed,
      evaluate: async (_fn: unknown, body: string) => {
        if (delivers === "throws") throw new Error("Illegal invocation");
        if (delivers === "all") composed += body;
        return true;
      },
    };
    return {
      locator: vi.fn(() => ({ count: async () => 1, first: () => composer })),
      keyboard: {
        press: vi.fn(async (key: string) => {
          if (key === "Shift+Enter") composed += "\n";
          if (key === "Meta+A") selectedAll = true;
          if (key === "Backspace") {
            composed = selectedAll ? "" : composed.slice(0, -1);
            selectedAll = false;
          }
        }),
        type: vi.fn(async (text: string) => { composed += text; }),
        insertText: vi.fn(async (text: string) => { composed += text; }),
      },
      waitForTimeout: vi.fn(async () => {}),
      evaluate: vi.fn(async () => '{"stub":true}'),
    } as unknown as Page;
  }

  beforeEach(() => {
    composed = "";
    selectedAll = false;
    delete process.env.CGPRO_SKIP_COMPOSER_PASTE;
    firstResolved.mockReset();
    requireSelector.mockReset();
    // The composer locator sendPrompt itself resolves: reading it must return
    // what the fake page currently holds, or the completeness check is testing
    // a constant rather than the delivery.
    requireSelector.mockImplementation(async () => ({
      click: async () => {},
      getAttribute: async () => null,
      innerText: async () => composed,
      evaluate: async () => true,
    }));
    firstResolved.mockResolvedValue({
      click: async () => {},
      getAttribute: async () => null,
      innerText: async () => composed,
      evaluate: async () => true,
    });
  });

  const prompt = "first line\nsecond ends in `code`\nthird line";

  it("delivers the whole prompt through paste and never types it", async () => {
    const page = fakePage("all");
    await sendPrompt(page, prompt);
    expect(composed).toContain("second ends in `code`");
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Shift+Enter");
  });

  it("falls back to typing when the paste lands nothing", async () => {
    const page = fakePage("nothing");
    await sendPrompt(page, prompt);
    // Three lines, so two Shift+Enter presses and three inserts.
    expect(page.keyboard.insertText).toHaveBeenCalledTimes(3);
    expect(composed).toContain("third line");
  });

  it("falls back to typing when the paste cannot be dispatched at all", async () => {
    const page = fakePage("throws");
    await sendPrompt(page, prompt);
    expect(page.keyboard.insertText).toHaveBeenCalledTimes(3);
    expect(composed).toContain("third line");
  });

  it("honours the escape hatch and types without attempting a paste", async () => {
    process.env.CGPRO_SKIP_COMPOSER_PASTE = "1";
    const page = fakePage("all");
    await sendPrompt(page, prompt);
    expect(page.keyboard.insertText).toHaveBeenCalledTimes(3);
  });
});
