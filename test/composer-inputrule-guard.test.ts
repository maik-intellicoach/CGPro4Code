import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "patchright";

const firstResolved = vi.fn();
const requireSelector = vi.fn(async () => fakeLocator());
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));

process.env.CGPRO_COMPOSER_PASTE_POLL_MS = "1";
process.env.CGPRO_COMPOSER_PASTE_SETTLE_MAX_MS = "1";

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
 * The measured ChatGPT behaviour, 2026-09-18. ProseMirror runs its markdown
 * input rules on TYPED input, and the inline-code rule destroys the whole line
 * when the closing backtick is the last character of the insertion. Paste is
 * parsed by a different code path and is unaffected.
 *
 * Narrower than `CODE_SPAN_AT_LINE_END` in the source, and that is the point:
 * the source predicate DETECTS a line at risk and may be a little over-broad,
 * while this models when the rule actually FIRES.
 */
const INPUT_RULE_FIRES = /`[^`]*`$/;

/**
 * `pasteBody` decides which paste events this page honours. The real page
 * behaves this way: a 154-character paste lands, a 12,000-character one does
 * not, so a long prompt falls through to typing line by line.
 */
function fakePage(pasteBody: (body: string) => boolean, onLengthRead?: () => void): Page {
  // Every poll read inside pasteComposerText is preceded by a waitForTimeout;
  // the give-up check afterwards is not. That difference is the only
  // deterministic way for a fake to commit a paste strictly AFTER the
  // deadline -- read COUNTS are not deterministic here, because
  // waitForTimeout is a no-op and the loop spins on wall-clock milliseconds.
  let sleptSinceRead = 0;
  const composer = {
    innerText: async () => composed,
    // Two distinct callers: the paste dispatch, which carries the body, and
    // the cheap length read, which carries nothing.
    evaluate: async (_fn: unknown, body?: string) => {
      if (body === undefined) {
        if (sleptSinceRead === 0) onLengthRead?.();
        sleptSinceRead = 0;
        return composed.length;
      }
      if (pasteBody(body)) composed += body;
      return true;
    },
  };
  return {
    locator: vi.fn(() => ({ count: async () => 1, first: () => composer })),
    keyboard: {
      press: vi.fn(async (key: string) => {
        if (key === "Shift+Enter") composed += "\n";
        if (key === "Meta+A") composed = "";
        if (key === "Backspace") composed = composed.slice(0, -1);
      }),
      type: vi.fn(async (text: string) => { composed += text; }),
      insertText: vi.fn(async (text: string) => {
        if (INPUT_RULE_FIRES.test(text)) {
          composed = composed.slice(0, composed.lastIndexOf("\n") + 1);
          return;
        }
        composed += text;
      }),
    },
    waitForTimeout: vi.fn(async () => { sleptSinceRead += 1; }),
    evaluate: vi.fn(async () => '{"stub":true}'),
  } as unknown as Page;
}

const prompt = [
  "Read the composer helper in `src/browser/conversation.ts`",
  "The predicate lives in `CODE_SPAN_AT_LINE_END`.",
  "plain line with no code at all",
  "a span `in the middle` of a sentence survives either way",
].join("\n");

beforeEach(() => {
  composed = "";
  firstResolved.mockReset();
  firstResolved.mockImplementation(async () => fakeLocator());
  requireSelector.mockReset();
  requireSelector.mockImplementation(async () => fakeLocator());
});

describe("delivering lines the inline-code input rule destroys", () => {
  it("hands a rule-fatal line to paste when the whole-prompt paste failed", async () => {
    // The production case: the prompt is too large to paste in one go, so
    // delivery falls to the line loop, and the lines that typing cannot carry
    // are pasted one at a time.
    const page = fakePage((body) => !body.includes("\n"));
    await sendPrompt(page, prompt);

    expect(composed).toBe(prompt);
    // The rule-fatal line was never typed.
    expect(page.keyboard.insertText).not.toHaveBeenCalledWith(
      "Read the composer helper in `src/browser/conversation.ts`",
    );
    // The lines typing handles fine were still typed, so this is not a
    // wholesale switch to pasting every line.
    expect(page.keyboard.insertText).toHaveBeenCalledWith("plain line with no code at all");
  });

  it("prefers one whole-prompt paste and never reaches the line loop", async () => {
    const page = fakePage(() => true);
    await sendPrompt(page, prompt);

    expect(composed).toBe(prompt);
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Shift+Enter");
  });

  it("never types a line whose paste landed after the deadline", async () => {
    // Found in review 2026-09-18. `false` from the paste guard means "not
    // landed YET", not "will never land". Typing on top of a late paste puts
    // the line in twice, and composerHoldsPrompt only enforces a length FLOOR,
    // so a too-LONG composer passes the completeness check and a Pro turn is
    // spent on corrupted input -- the exact failure this guard exists to stop.
    let queued: string | null = null;
    const page = fakePage((body) => {
      if (body.includes("\n")) return false;      // the whole-prompt paste fails
      queued = body;                              // this one lands, but late
      return false;
    }, () => {
      // Only ever called on a read with no sleep before it, i.e. the check
      // that runs after pasteComposerText has already given up.
      if (queued !== null) { composed += queued; queued = null; }
    });
    await sendPrompt(page, prompt);

    expect(composed).toBe(prompt);
    expect(page.keyboard.insertText).not.toHaveBeenCalledWith(
      "Read the composer helper in `src/browser/conversation.ts`",
    );
  });

  it("refuses to submit when neither path can carry the line", async () => {
    // No paste at any size: the line loop types, the input rule eats the line,
    // and the completeness check must refuse rather than spend a Pro turn on a
    // prompt that arrived with a line missing.
    const page = fakePage(() => false);
    await expect(sendPrompt(page, prompt)).rejects.toThrow(/composer delivery incomplete/);
  });
});
