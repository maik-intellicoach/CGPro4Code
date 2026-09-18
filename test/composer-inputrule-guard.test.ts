import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "patchright";

const firstResolved = vi.fn();
const requireSelector = vi.fn(async () => fakeLocator());
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));

// This file is about the TYPED fallback, so paste stays off throughout.
process.env.CGPRO_SKIP_COMPOSER_PASTE = "1";

const { sendPrompt } = await import("../src/browser/conversation.js");

let composed = "";

function fakeLocator() {
  return {
    click: async () => {},
    getAttribute: async () => null,
    innerText: async () => composed,
    evaluate: async () => true,
  };
}

/**
 * The measured ChatGPT behaviour: ProseMirror runs its markdown input rules on
 * TYPED input, and the inline-code rule destroys the whole line when the
 * closing backtick is the LAST character of the insertion. 18 of 18 such lines
 * vanished on 2026-09-18; lines with code spans anywhere else survived.
 * Deletion never triggers an input rule, which is what the guard exploits.
 *
 * Note this is NARROWER than `CODE_SPAN_AT_LINE_END` in the source, and that is
 * the point: the source predicate DETECTS a line at risk and may be a little
 * over-broad, while this models when the rule actually FIRES. One trailing
 * space is enough to move the backtick off the end, so the guard works.
 */
const INPUT_RULE_FIRES = /`[^`]*`$/;

function fakePage(): Page {
  return {
    locator: vi.fn(() => ({ count: async () => 0 })),
    keyboard: {
      press: vi.fn(async (key: string) => {
        if (key === "Shift+Enter") composed += "\n";
        if (key === "Backspace") composed = composed.slice(0, -1);
        if (key === "Meta+A") composed = "";
      }),
      type: vi.fn(async (text: string) => { composed += text; }),
      insertText: vi.fn(async (text: string) => {
        if (INPUT_RULE_FIRES.test(text)) {
          // The rule eats the line it just completed, back to the last newline.
          composed = composed.slice(0, composed.lastIndexOf("\n") + 1);
          return;
        }
        composed += text;
      }),
    },
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => '{"stub":true}'),
  } as unknown as Page;
}

beforeEach(() => {
  composed = "";
  firstResolved.mockReset();
  firstResolved.mockImplementation(async () => fakeLocator());
  requireSelector.mockReset();
  requireSelector.mockImplementation(async () => fakeLocator());
});

describe("typed-fallback guard against the inline-code input rule", () => {
  it("delivers lines whose closing backtick is the last character", async () => {
    const prompt = [
      "Read the composer helper in `src/browser/conversation.ts`",
      "The predicate lives in `CODE_SPAN_AT_LINE_END`.",
      "plain line with no code at all",
      "a span `in the middle` of a sentence survives either way",
    ].join("\n");

    const page = fakePage();
    await sendPrompt(page, prompt);

    // Every line arrived, so sendPrompt never refused and never had to clear.
    expect(composed).toBe(prompt);
    // The guard is the trailing-space insert followed by a Backspace.
    expect(page.keyboard.insertText).toHaveBeenCalledWith(
      "Read the composer helper in `src/browser/conversation.ts` ",
    );
    expect(page.keyboard.press).toHaveBeenCalledWith("Backspace");
  });

  it("models a fake that really does destroy an unguarded line", async () => {
    // Control: without the guard the same insertion is eaten, which is what
    // makes the test above meaningful rather than vacuous.
    const page = fakePage();
    composed = "kept\n";
    await page.keyboard.insertText("lost because it ends in `code`");
    expect(composed).toBe("kept\n");
  });
});
