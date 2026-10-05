import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { Page } from "patchright";

// sendPrompt resolves the composer and the send button through chatgpt.js; the
// composer locator is the only one these cases use, so the mock owns it.
const requireSelector = vi.fn();
const firstResolved = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  requireSelector: (...a: unknown[]) => requireSelector(...a),
  requireSelectorPatient: vi.fn(async () => ({})),
  firstResolved: (...a: unknown[]) => firstResolved(...a),
  goHome: vi.fn(async () => {}),
}));

// Typed delivery only: the paste path is covered elsewhere and its extra reads
// are not what this file is about. One send attempt keeps the fake small.
process.env.CGPRO_SKIP_COMPOSER_PASTE = "1";
process.env.CGPRO_SEND_CLICK_ATTEMPTS = "1";

const { sendPrompt } = await import("../src/browser/conversation.js");
const { PreSubmitInteractionError } = await import("../src/errors.js");

/**
 * The synthetic composer state the fake page reads back.
 *
 * `text` is what the composer holds. The admission guard runs for real inside
 * the VM (see `page.evaluate`), so ownership has to be provable from this state
 * the same way it is from a live composer: exact text, no extra node, no token.
 */
interface ComposerState {
  text: string;
  /** The connector chip an inline `@` selection leaves in the composer, if any. */
  mention?: string;
  unknown: boolean;
  readable: boolean;
  url: string;
}

let selectedAll = false;
let caretInComposer = true;

function fakeLocator(state: ComposerState) {
  return {
    click: async () => { caretInComposer = true; },
    getAttribute: async () => null,
    innerText: async () => state.text,
    // focusComposerEnd seats the caret in the contenteditable host.
    evaluate: async () => { caretInComposer = true; return true; },
  };
}

/**
 * A page whose `keyboard` mutates the composer and whose `evaluate` executes
 * the guard's real in-page function against a synthetic DOM, exactly as
 * test/preflight-draft.test.ts does. Reads stay inside the VM; the Page
 * boundary returns a boolean or a reason string.
 */
function fakePage(state: ComposerState, options: { ignoreClear?: boolean } = {}): Page {
  return {
    locator: vi.fn(() => ({ count: async () => 0 })),
    keyboard: {
      press: vi.fn(async (key: string) => {
        if (options.ignoreClear) return; // the composer ignores select-all and Delete
        if (key === "Shift+Enter") state.text += "\n";
        if (key === "Meta+A") selectedAll = true;
        if (key === "Backspace" || key === "Delete") {
          state.text = selectedAll ? "" : state.text.slice(0, -1);
          selectedAll = false;
        }
      }),
      insertText: vi.fn(async (text: string) => { if (caretInComposer) state.text += text; }),
      type: vi.fn(async (text: string) => { state.text += text; }),
    },
    waitForTimeout: vi.fn(async () => {}),
    url: () => "https://chatgpt.com/g/g-p-test/project",
    evaluate: vi.fn(async (fn: Function, arg: unknown) => {
      if (!state.readable) throw new Error("synthetic evaluation failure with private content");
      const mention = state.mention ?? "";
      const tokens = mention ? [{ tagName: "A", textContent: mention, remove() {} }] : [];
      const copy = {
        textContent: state.text,
        querySelectorAll: (selector: string) => {
          if (selector === "*") return state.unknown ? [{ tagName: "CUSTOM-TOKEN", attributes: [] }] : [];
          return tokens; // the inline connector chip, when this turn placed one
        },
      };
      const composer = {
        isConnected: true,
        getClientRects: () => [{}],
        innerText: mention + state.text,
        cloneNode: () => copy,
        closest: () => form,
        contains: () => false,
        tagName: "DIV",
      };
      const form = {
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      const document = {
        body: { childNodes: [composer] },
        querySelectorAll: (selector: string) =>
          selector === 'input[type="file"]' ? [{ files: [] }] : [composer],
        createTreeWalker: () => ({ nextNode: () => false }),
      };
      return runInNewContext(`(${fn.toString()})(arg)`, {
        arg,
        document,
        location: new URL(state.url),
        HTMLTextAreaElement: class {},
        NodeFilter: { SHOW_TEXT: 4 },
      });
    }),
  } as unknown as Page;
}

/** The refusal this change exists for: thrown from verifySubmission, after the insert. */
function proLimitRefusal(): PreSubmitInteractionError {
  return new PreSubmitInteractionError(
    "pro_usage_limit_reached",
    "model_verification",
    "ChatGPT Pro usage limit reached before submission: Limit reached. Try again after Sep 30, 2026.",
    { availableAfter: "Sep 30, 2026", limitText: "Limit reached. Try again after Sep 30, 2026." },
  );
}

function presubmitLines(log: ReturnType<typeof vi.spyOn>): string[] {
  return log.mock.calls
    .map(args => String(args[0]))
    .filter(line => line.startsWith("[cgpro:presubmit]"));
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  selectedAll = false;
  caretInComposer = true;
  requireSelector.mockReset();
  firstResolved.mockReset();
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
});

describe("sendPrompt removes the draft it inserted when a pre-submit check refuses", () => {
  it("clears the owned prompt and re-throws the original pro-limit error unchanged", async () => {
    const state: ComposerState = { text: "", unknown: false, readable: true, url: "https://chatgpt.com/" };
    requireSelector.mockImplementation(async () => fakeLocator(state));
    firstResolved.mockResolvedValue(fakeLocator(state));
    const error = proLimitRefusal();

    const page = fakePage(state);
    const rejected = sendPrompt(page, "hello world", false, undefined, async () => { throw error; });
    await expect(rejected).rejects.toBe(error); // same object: code, phase and message intact

    expect(error.code).toBe("pro_usage_limit_reached");
    expect(error.phase).toBe("model_verification");
    expect(error.availableAfter).toBe("Sep 30, 2026");
    expect(error.limitText).toBe("Limit reached. Try again after Sep 30, 2026.");
    expect(state.text).toBe(""); // the draft this call typed is gone
    expect(presubmitLines(log)).toEqual(["[cgpro:presubmit] owned draft cleared=yes reason=owned"]);
  });

  it("leaves a composer whose text is not exactly this call's owned prompt untouched", async () => {
    const state: ComposerState = { text: "", unknown: false, readable: true, url: "https://chatgpt.com/" };
    requireSelector.mockImplementation(async () => fakeLocator(state));
    firstResolved.mockResolvedValue(fakeLocator(state));

    const page = fakePage(state);
    const rejected = sendPrompt(page, "hello world", false, undefined, async () => {
      state.text = "hello world plus someone else's draft"; // a draft arrived during the check
      throw proLimitRefusal();
    });
    await expect(rejected).rejects.toBeInstanceOf(PreSubmitInteractionError);

    expect(state.text).toBe("hello world plus someone else's draft"); // NOT cleared
    expect(presubmitLines(log)).toEqual(["[cgpro:presubmit] owned draft cleared=no reason=not_owned"]);
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Delete");
  });

  it("does not touch the composer on a preserveExisting turn", async () => {
    const state: ComposerState = { text: "", unknown: false, readable: true, url: "https://chatgpt.com/" };
    requireSelector.mockImplementation(async () => fakeLocator(state));
    firstResolved.mockResolvedValue(fakeLocator(state));

    const page = fakePage(state);
    const rejected = sendPrompt(page, "hello world", true, undefined, async () => { throw proLimitRefusal(); });
    await expect(rejected).rejects.toBeInstanceOf(PreSubmitInteractionError);

    expect(state.text).toBe("hello world"); // the connector/mention turn is never cleared
    expect(presubmitLines(log)).toEqual(["[cgpro:presubmit] owned draft cleared=no reason=preserve_existing"]);
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Delete");
  });

  // P-035 2026-09-27. On a connector turn preserveExisting is true because the
  // connector chip this same invocation placed lives inside the composer. When
  // the caller names that connector, ownership is provable as the COMBINED
  // token-plus-prompt shape, and only then is the composer cleared.
  it("clears its own connector-turn draft (owned token plus prompt) and re-throws unchanged", async () => {
    const connector = "p035-low-risk-workstation-intelli";
    const state: ComposerState = { text: "", mention: connector, unknown: false, readable: true, url: "https://chatgpt.com/" };
    requireSelector.mockImplementation(async () => fakeLocator(state));
    firstResolved.mockResolvedValue(fakeLocator(state));
    const error = proLimitRefusal();

    const page = fakePage(state);
    const rejected = sendPrompt(page, "hello world", true, undefined, async () => { throw error; }, connector);
    await expect(rejected).rejects.toBe(error); // same object: code, phase and message intact

    expect(error.code).toBe("pro_usage_limit_reached");
    expect(state.text).toBe(""); // the prompt this call typed is gone
    expect(presubmitLines(log)).toEqual(["[cgpro:presubmit] owned draft cleared=yes reason=owned"]);
  });

  it("leaves a connector turn untouched when the token is not the owned connector", async () => {
    const state: ComposerState = { text: "", mention: "some-other-connector", unknown: false, readable: true, url: "https://chatgpt.com/" };
    requireSelector.mockImplementation(async () => fakeLocator(state));
    firstResolved.mockResolvedValue(fakeLocator(state));

    const page = fakePage(state);
    await expect(sendPrompt(
      page, "hello world", true, undefined, async () => { throw proLimitRefusal(); }, "p035-low-risk-workstation-intelli",
    )).rejects.toBeInstanceOf(PreSubmitInteractionError);

    expect(state.text).toBe("hello world"); // NOT cleared
    expect(presubmitLines(log)).toEqual(["[cgpro:presubmit] owned draft cleared=no reason=not_owned"]);
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Delete");
  });

  it("leaves a connector turn untouched when other user text sits beside the token and prompt", async () => {
    const connector = "p035-low-risk-workstation-intelli";
    const state: ComposerState = { text: "", mention: connector, unknown: false, readable: true, url: "https://chatgpt.com/" };
    requireSelector.mockImplementation(async () => fakeLocator(state));
    firstResolved.mockResolvedValue(fakeLocator(state));

    const page = fakePage(state);
    await expect(sendPrompt(page, "hello world", true, undefined, async () => {
      state.text += " plus someone else's draft"; // extra text arrives during the check
      throw proLimitRefusal();
    }, connector)).rejects.toBeInstanceOf(PreSubmitInteractionError);

    expect(state.text).toBe("hello world plus someone else's draft"); // NOT cleared
    expect(presubmitLines(log)).toEqual(["[cgpro:presubmit] owned draft cleared=no reason=not_owned"]);
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Delete");
  });

  it("attempts no clearing when the failure is not a PreSubmitInteractionError", async () => {
    const state: ComposerState = { text: "", unknown: false, readable: true, url: "https://chatgpt.com/" };
    requireSelector.mockImplementation(async () => fakeLocator(state));
    firstResolved.mockResolvedValue(fakeLocator(state));
    const error = new Error("native mode missing");

    const page = fakePage(state);
    await expect(sendPrompt(page, "hello world", false, undefined, async () => { throw error; }))
      .rejects.toBe(error);

    expect(state.text).toBe("hello world"); // untouched, exactly as before this change
    expect(presubmitLines(log)).toEqual([]);
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Delete");
  });

  it("reports clear_failed and re-throws when the owned prompt survives the clear", async () => {
    const state: ComposerState = { text: "", unknown: false, readable: true, url: "https://chatgpt.com/" };
    requireSelector.mockImplementation(async () => fakeLocator(state));
    firstResolved.mockResolvedValue(fakeLocator(state));

    const page = fakePage(state, { ignoreClear: true });
    const error = proLimitRefusal();
    await expect(sendPrompt(page, "hello world", false, undefined, async () => { throw error; }))
      .rejects.toBe(error);

    expect(state.text).toBe("hello world");
    expect(presubmitLines(log)).toEqual(["[cgpro:presubmit] owned draft cleared=no reason=clear_failed"]);
  });

  it("treats an unprovable ownership read as not owned, never as a reason to clear", async () => {
    const state: ComposerState = { text: "", unknown: false, readable: false, url: "https://chatgpt.com/" };
    requireSelector.mockImplementation(async () => fakeLocator(state));
    firstResolved.mockResolvedValue(fakeLocator(state));

    const page = fakePage(state);
    await expect(sendPrompt(page, "hello world", false, undefined, async () => { throw proLimitRefusal(); }))
      .rejects.toBeInstanceOf(PreSubmitInteractionError);

    expect(state.text).toBe("hello world"); // the insert landed; the read could not prove it
    expect(presubmitLines(log)).toEqual(["[cgpro:presubmit] owned draft cleared=no reason=not_owned"]);
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Delete");
  });
});
