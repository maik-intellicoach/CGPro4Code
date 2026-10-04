import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "patchright";
import { runInNewContext } from "node:vm";
import { PreflightDraftProtectedError } from "../src/errors.js";

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
process.env.CGPRO_COMPOSER_PASTE_POLL_MS = "1";
process.env.CGPRO_COMPOSER_PASTE_SETTLE_MAX_MS = "1";

// Every test in this file is about the TYPED delivery path and its partial
// writes. Paste is now the default and is covered in composer-paste.test.ts;
// disabling it here keeps these cases exercising the path they were written
// for, which is also the fallback that still has to work (P-035 2026-09-18).
process.env.CGPRO_SKIP_COMPOSER_PASTE = "1";

const { sendPrompt, composerHoldsPrompt } = await import("../src/browser/conversation.js");

// What the fake composer currently holds. sendPrompt reads the composer back to
// confirm the whole prompt landed, so a stub that answers a constant string no
// longer models anything useful -- it would pass the completeness check for a
// composer that had never been written to.
let composed = "";

// Does the caret sit in the composer's text flow? CDP insertText writes to the
// focused EDITABLE, so while the connector's inline pill holds focus every
// insert is silently dropped. Captured on intelli 2026-09-17:
// active="a.focus-visible:focus-ring.inline-flex", activeEditable=false,
// activeInComposer=true.
let caretInComposer = true;

// Does Meta+A currently hold the whole composer selected?
let selectedAll = false;

function fakeLocator(overrides: { click?: () => Promise<void>; innerText?: string } = {}) {
  return {
    elementHandle: async () => ({ evaluate: async () => { caretInComposer = true; return true; }, dispose: async () => {} }),
    click: overrides.click ?? (async () => {}),
    getAttribute: async () => null, // disabled=null, aria-disabled!=="true" -> enabled
    innerText: async () => overrides.innerText ?? composed,
    // focusComposerEnd: focuses the contenteditable host and collapses the
    // selection past the pill. A plain click does NOT do this -- it targets the
    // element centre, which on a composer holding only a pill is the pill.
    evaluate: async () => { caretInComposer = true; return true; }, // seated
  };
}

/**
 * Accepts every write. `dropAfter` makes it accept only the first N writes (a
 * prompt that lands partially); `dropFirst` swallows the first M outright (an
 * insert that went somewhere other than the composer, because CDP insertText
 * targets whatever holds focus).
 */
function fakePage(dropAfter = Infinity, dropFirst = 0): Page {
  let writes = 0;
  const write = (text: string): void => {
    const n = ++writes;
    if (!caretInComposer) return; // focus is on the pill: insertText is dropped
    if (n <= dropFirst) return;
    if (n - dropFirst > dropAfter) return;
    composed += text;
  };
  return {
    url: () => "https://chatgpt.com/",
    locator: vi.fn(() => ({ count: async () => 0 })),
    keyboard: {
      press: vi.fn(async (key: string) => {
        if (key === "Shift+Enter") write("\n");
        if (key === "Meta+A") selectedAll = true;
        if (key === "Backspace") {
          // Meta+A then Backspace clears; a bare Backspace deletes one
          // character, which is how the input-rule guard undoes its own
          // trailing space.
          composed = selectedAll ? "" : composed.slice(0, -1);
          selectedAll = false;
        }
      }),
      type: vi.fn(async (text: string) => write(text)),
      insertText: vi.fn(async (text: string) => write(text)),
    },
    waitForTimeout: vi.fn(async () => {}),
    // The refusal path captures page state before throwing. It must never be the
    // reason a turn fails, so the real one is wrapped in .catch() and this stub
    // only has to exist.
    evaluate: vi.fn(async () => '{"stub":true}'),
  } as unknown as Page;
}

beforeEach(() => {
  composed = "";
  caretInComposer = true;
  selectedAll = false;
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

  it("never clears a preserved composer to retry: that would strip the connector", async () => {
    // preserveExisting is true on EVERY connector turn (orchestrator.ts), and the
    // connector's inline mention lives inside the composer. Clearing it to retry
    // would resubmit a connector-required prompt with no connector, which is the
    // genuine connector_required_not_used this change exists to prevent. The
    // retry a connector turn does get appends instead, and still fails honestly
    // when the append does not land either.
    requireSelector.mockResolvedValue(fakeLocator({ innerText: "   " }));
    firstResolved.mockResolvedValueOnce(fakeLocator());
    const page = fakePage();

    await expect(sendPrompt(page, "hello", true)).rejects.toThrow("composer delivery incomplete");

    expect(page.keyboard.insertText).toHaveBeenCalledWith("hello");
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Backspace"); // no clear
    expect(page.keyboard.type).not.toHaveBeenCalled(); // no slow keystroke retype
  });

  it("recovers a connector turn whose insert was swallowed, by appending", async () => {
    // Measured on intelli at 2026-09-17T23:33Z: 33 of 2982 characters landed,
    // and `p035-low-risk-workstation-intelli` is exactly 33 characters. The
    // composer held the connector mention and nothing else. The mention
    // surviving proves the insert never landed rather than being cleared after
    // the fact -- a clear would have taken the mention with it. Re-focusing and
    // appending repairs that, and leaves the mention in front of the prompt.
    const click = vi.fn(async () => {});
    firstResolved.mockResolvedValue(fakeLocator({ click }));
    const prompt = `${"planning context ".repeat(120)}\ninvocation_id="e4adf507"`;
    composed = "p035-low-risk-workstation-intelli"; // the mention, alone
    const initialLines = prompt.split("\n");
    // Swallow the WHOLE first delivery: both text writes and Shift+Enter.
    // Dropping only its first write leaves a partial prompt, which must refuse.
    const initialWrites = initialLines.filter(line => line.length > 0).length + initialLines.length - 1;
    const page = fakePage(Infinity, initialWrites);

    await sendPrompt(page, prompt, true);

    expect(click).toHaveBeenCalledTimes(1); // the turn went out
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Backspace"); // mention kept
    expect(composed).toContain("p035-low-risk-workstation-intelli");
    expect(composed).toContain('invocation_id="e4adf507"');
    expect(composed).toBe("p035-low-risk-workstation-intelli" + prompt);
    expect(page.keyboard.insertText).toHaveBeenCalledTimes(4); // two complete attempts
    expect(vi.mocked(page.keyboard.press).mock.calls.filter(call => call[0] === "Shift+Enter")).toHaveLength(2);
  });

  it("recovers when the connector pill holds focus and insertText is dropped", async () => {
    // The 2026-09-17 root cause, captured in production. The connector attaches
    // as an inline selection pill -- an anchor carrying contenteditable="false"
    // inside the ProseMirror document -- and focus lands ON it. insertText
    // writes to the focused editable, so the prompt went nowhere and the
    // composer kept only the mention: 33 of 2982 characters, five times.
    //
    // Two earlier repairs failed against exactly this. composer.click() targets
    // the element CENTRE, and a composer holding only a pill has the pill at its
    // centre, so re-clicking re-focused the anchor. Meta+End on a non-editable
    // anchor moves no ProseMirror selection at all.
    const click = vi.fn(async () => {});
    firstResolved.mockResolvedValue(fakeLocator({ click }));
    composed = "p035-low-risk-workstation-intelli"; // the pill, alone
    caretInComposer = false; // and it holds the focus
    const page = fakePage();

    await sendPrompt(page, `${"planning context ".repeat(120)}\ninvocation_id="e4adf507"`, true);

    expect(click).toHaveBeenCalledTimes(1); // the turn went out
    expect(composed).toContain("p035-low-risk-workstation-intelli"); // pill kept
    expect(composed).toContain('invocation_id="e4adf507"'); // prompt delivered
    // Two lines, two insertText calls: the caret was seated BEFORE the first
    // insert, so the delivery check never had to fall back to its retry.
    expect(vi.mocked(page.keyboard.insertText).mock.calls).toHaveLength(2);
  });

  it("refuses to append onto a partially landed prompt: that would duplicate its head", async () => {
    // An append is only safe when the prompt is wholly absent. Half a prompt
    // plus a whole one is a different corruption, not a repair, so a partial
    // landing still fails closed.
    const click = vi.fn(async () => {});
    firstResolved.mockResolvedValue(fakeLocator({ click }));
    const page = fakePage(1); // the first line lands, the rest is dropped

    await expect(
      sendPrompt(page, `${"planning context ".repeat(40)}\ninvocation_id="e4adf507"`, true),
    ).rejects.toThrow("composer delivery incomplete");

    expect(click).not.toHaveBeenCalled();
    // insertLines emits one insertText per line, so a two-line prompt is two
    // calls for ONE attempt. A retry would have made it four.
    expect(vi.mocked(page.keyboard.insertText).mock.calls).toHaveLength(2);
  });

  it("re-inserts once when nothing has to be preserved", async () => {
    // With no connector mention at risk, clearing and re-inserting is safe and
    // is worth one attempt before failing the turn.
    requireSelector.mockResolvedValue(fakeLocator({ innerText: "   " }));
    firstResolved.mockResolvedValueOnce(fakeLocator());
    const page = fakePage();

    await expect(sendPrompt(page, "hello", false)).rejects.toThrow("composer delivery incomplete");

    expect(page.keyboard.press).toHaveBeenCalledWith("Backspace"); // cleared
    expect(vi.mocked(page.keyboard.insertText).mock.calls.filter(c => c[0] === "hello")).toHaveLength(2);
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

  it("checks the composer AFTER the model verification, not right after insertion", async () => {
    // ensureProSixMaximum opens and closes the thinking-power menu between the
    // insert and the click, with three five-second waits inside it. If that
    // interaction is what loses the draft, a check placed before it passes and
    // the turn still goes out empty. Order: insert, verify, check, send.
    const order: string[] = [];
    firstResolved.mockResolvedValue(fakeLocator({ click: async () => { order.push("send"); } }));
    const page = fakePage();
    vi.mocked(page.keyboard.insertText).mockImplementation(async (text: string) => {
      order.push("insert");
      composed += text;
    });
    requireSelector.mockResolvedValue({
      ...fakeLocator(),
      innerText: async () => { order.push("read-composer"); return composed; },
    });

    await sendPrompt(page, "hello", true, undefined, async () => { order.push("verify"); });

    expect(order).toEqual(["read-composer", "insert", "verify", "read-composer", "send"]);
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
    requireSelector.mockResolvedValue({
      ...fakeLocator(),
      elementHandle: async () => ({
        evaluate: async () => { focus = "composer"; return true; },
        dispose: async () => {},
      }),
    });
    firstResolved.mockResolvedValue(fakeLocator({ click: async () => { throw new Error("detached"); } }));
    const page = fakePage();
    vi.mocked(page.keyboard.press).mockImplementation(async (key) => {
      if (key === "Enter") expect(focus).toBe("composer");
    });
    await sendPrompt(page, "hello", true, undefined, async () => { focus = "menu"; });
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
  });
});

describe("composerHoldsPrompt (P-035 2026-09-17)", () => {
  // Learned in production, not in review: chatgpt.com's composer RENDERS
  // markdown, so innerText never contains the backticks, the "# " of a heading
  // or the "1. " of an ordered list. The first version of this check compared
  // normalised text with endsWith and failed a perfectly healthy 4,060-character
  // planning prompt that came back as 4,033 -- 16 backticks + one heading mark +
  // three list markers, exactly 27 characters of markdown syntax.
  const render = (s: string) =>
    s.replace(/`/g, "").replace(/^#+ /gm, "").replace(/^\s*\d+\. /gm, "");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const prompt =
    "# Heading\n\nSome context with `code` and `more code` and `a third span`.\n\n" +
    "1. first item\n2. second item\n3. third item\n\n" +
    "Body text ".repeat(40) +
    '\n\ninvocation_id="e4adf507-daeb-4a90-be5e-a45bd9f9c40b"';

  it("accepts a composer that merely rendered the markdown away", () => {
    const want = norm(prompt);
    const landed = norm(render(prompt));
    expect(landed.length).toBeLessThan(want.length); // the composer really is shorter
    expect(composerHoldsPrompt(landed, want)).toBe(true);
  });

  it("rejects a composer that lost the invocation contract off the end", () => {
    const want = norm(prompt);
    const landed = norm(render(prompt.slice(0, prompt.indexOf("invocation_id"))));
    expect(composerHoldsPrompt(landed, want)).toBe(false);
  });

  it("rejects a composer holding only the head of the prompt", () => {
    const want = norm(prompt);
    expect(composerHoldsPrompt(norm(prompt.slice(0, 120)), want)).toBe(false);
  });

  it("accepts extra leading content, for preserveExisting", () => {
    const want = norm(prompt);
    expect(composerHoldsPrompt(norm("inline pill text " + prompt), want)).toBe(true);
  });

  it("falls back to the length floor when the prompt has no invariant token", () => {
    expect(composerHoldsPrompt("hi there", "hi there")).toBe(true);
    expect(composerHoldsPrompt("hi", "hi there ok fine yes no")).toBe(false);
  });
});


/**
 * Parent-only original/candidate comparisons use public sendPrompt, never import
 * candidate private helpers. The same fixture loads unchanged on original source.
 * All caret, identity and paste callbacks run against these DOM nodes in a VM.
 */
function textFlowFixture(options: {
  chip?: boolean;
  caret?: "false" | "throw" | "timeout" | "atom" | "focus-atom" | "expanded";
  paste?: "all" | "nothing" | "throws";
  afterPaste?: "url" | "document" | "focus";
  afterWrite?: "url" | "focus";
  loseAfterWrites?: number;
  swallowWrites?: number;
  duplicate?: boolean;
  cancelAfterWrites?: number;
  multiple?: boolean;
  hidden?: boolean;
  sendFails?: boolean;
  loseDuringSend?: boolean;
} = {}) {
  const state = {
    url: "https://chatgpt.com/c/fixture", text: "", writes: 0, settingsWrites: 0,
    cancelled: false, chip: options.chip !== false, active: null as unknown,
    document: {} as Record<string, unknown>, focusCalls: 0,
  };
  class FixtureElement {
    parentElement: FixtureElement | null = null;
    children: FixtureElement[] = [];
    atom = false;
    ownerDocument = state.document;
    isConnected = true;
    isContentEditable = true;
    __cgproCounted = false;
    get lastElementChild() { return this.children.at(-1) ?? null; }
    get innerText() { return (state.chip ? "Deep Research " : "") + state.text; }
    addEventListener() {}
    getClientRects() { return options.hidden ? [] : [{}]; }
    contains(node: unknown): boolean {
      return node === this || this.children.some(child => child.contains(node));
    }
    closest(): FixtureElement | null { return this.atom ? this : this.parentElement?.closest() ?? null; }
    focus() {
      state.focusCalls++;
      if (options.caret === "throw") throw new Error("focus rejected");
      if (options.caret === "timeout") throw new Error("Timeout 30000ms exceeded");
      state.active = options.caret === "false" ? {} : this;
    }
    dispatchEvent(event: { clipboardData: { body: string } }) {
      if (options.paste === "throws") throw new Error("paste rejected");
      if (options.paste !== "nothing") state.text += event.clipboardData.body;
      if (options.afterPaste === "url") state.url = "https://chatgpt.com/settings/plugins-settings/apps/connector_openai_deep_research";
      if (options.afterPaste === "document") state.document = {};
      if (options.afterPaste === "focus") state.active = {};
      return true;
    }
  }
  class FixtureTextarea extends FixtureElement {}
  const host = new FixtureElement();
  const paragraph = new FixtureElement();
  const chip = new FixtureElement(); chip.atom = true; chip.isContentEditable = false;
  host.children = [paragraph]; paragraph.parentElement = host;
  paragraph.children = [chip]; chip.parentElement = paragraph;
  const selection = {
    anchorNode: null as FixtureElement | null, focusNode: null as FixtureElement | null,
    rangeCount: 1, isCollapsed: true,
    removeAllRanges() {},
    addRange(range: { node: FixtureElement }) {
      this.anchorNode = options.caret === "atom" ? chip : range.node;
      this.focusNode = options.caret === "focus-atom" ? chip : this.anchorNode;
      this.isCollapsed = options.caret !== "expanded";
    },
  };
  Object.assign(state.document, {
    get activeElement() { return state.active; },
    querySelectorAll: () => options.multiple ? [host, new FixtureElement()] : [host],
    createRange: () => ({
      node: host,
      selectNodeContents(node: FixtureElement) { this.node = node; },
      collapse() {},
    }),
  });
  // Object.assign copies accessors as values; preserve a live activeElement.
  Object.defineProperty(state.document, "activeElement", { get: () => state.active });
  const window = { location: { get href() { return state.url; } }, getSelection: () => selection };
  class DataTransfer {
    body = "";
    setData(_type: string, body: string) { this.body = body; }
  }
  class ClipboardEvent {
    clipboardData: DataTransfer;
    constructor(_type: string, init: { clipboardData: DataTransfer }) { this.clipboardData = init.clipboardData; }
  }
  const evaluate = async (callback: Function, argument?: unknown) => runInNewContext(
    `(${callback.toString()})(element, argument)`, {
      element: host, argument: argument && typeof argument === "object" && "original" in argument
        ? { ...argument, original: argument.original ? host : undefined } : argument, document: state.document, window, Element: FixtureElement,
      HTMLTextAreaElement: FixtureTextarea, DataTransfer, ClipboardEvent,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    },
  );
  const original = { evaluate, dispose: vi.fn(async () => {}) };
  const composer = {
    elementHandle: async () => original,
    evaluate,
    innerText: async () => host.innerText,
    click: vi.fn(async () => {
      // Old centre-click actually activates the preserved linked native chip.
      if (state.chip) state.url = "https://chatgpt.com/settings/plugins-settings/apps/connector_openai_deep_research";
      else state.active = host;
    }),
  };
  const send = {
    getAttribute: async () => null,
    click: vi.fn(async () => {
      if (options.loseDuringSend) state.url = "https://chatgpt.com/settings";
      if (options.sendFails) throw new Error("send detached");
    }),
  };
  const write = async (text: string) => {
    state.writes++;
    if (state.url.includes("/settings") || state.active !== host || state.document !== host.ownerDocument) {
      state.settingsWrites++; return;
    }
    if (state.writes > (options.swallowWrites ?? 0)) state.text += options.duplicate ? text + text : text;
    if (state.writes === (options.loseAfterWrites ?? 1)) {
      if (options.afterWrite === "url") state.url = "https://chatgpt.com/settings";
      if (options.afterWrite === "focus") state.active = {};
    }
    if (state.writes === options.cancelAfterWrites) state.cancelled = true;
  };
  const page = {
    url: () => state.url,
    locator: () => ({ first: () => composer, count: async () => 0 }),
    waitForTimeout: async () => {},
    evaluate: async () => '{"fixture":true}',
    keyboard: {
      insertText: vi.fn(write), type: vi.fn(write),
      press: vi.fn(async (key: string) => {
        if (key === "Shift+Enter") await write("\n");
        if (key === "Meta+A") selection.isCollapsed = false;
        if (key === "Backspace" || key === "Delete") {
          state.text = ""; selection.isCollapsed = true;
        }
      }),
    },
  } as unknown as Page;
  requireSelector.mockResolvedValue(composer);
  firstResolved.mockResolvedValue(send);
  return { page, state, composer, send, original };
}

describe("invocation-local native text-flow boundary (parent comparison)", () => {
  const prompt = "Exact first line\nkeep `inline-code`\ncomplete final contract-token";
  beforeEach(() => {
    delete process.env.CGPRO_TYPE_KEYSTROKES;
    delete process.env.CGPRO_SKIP_COMPOSER_VERIFY;
    process.env.CGPRO_SKIP_COMPOSER_PASTE = "1";
  });
  const refused = async (fixture: ReturnType<typeof textFlowFixture>, body = prompt) => {
    await expect(sendPrompt(fixture.page, body, true)).rejects.toMatchObject({
      name: "PreflightDraftProtectedError", code: "preflight_draft_protected",
      reason: "prompt_target_unconfirmed", promptSubmitted: false,
    });
    expect(fixture.state.settingsWrites).toBe(0);
    expect(fixture.send.click).not.toHaveBeenCalled();
    expect(fixture.page.keyboard.press).not.toHaveBeenCalledWith("Enter");
    expect(fixture.page.keyboard.press).not.toHaveBeenCalledWith("Backspace");
    expect(fixture.composer.click).not.toHaveBeenCalled();
  };

  it("preserves the linked native chip and whole prompt without activating settings", async () => {
    const f = textFlowFixture();
    await sendPrompt(f.page, prompt, true);
    expect(f.state.url).toBe("https://chatgpt.com/c/fixture");
    expect(f.state.chip).toBe(true);
    expect(f.state.text).toBe(prompt);
    expect(f.state.settingsWrites).toBe(0);
    expect(f.composer.click).not.toHaveBeenCalled();
    expect(f.send.click).toHaveBeenCalledTimes(1);
    expect(f.original.dispose).toHaveBeenCalledTimes(1);
  });
  it("records zero settings writes on uncertain target refusal", async () => {
    const f = textFlowFixture({ caret: "false" });
    const failure = await sendPrompt(f.page, prompt, true).catch(error => error);
    // Assert the observed wrong-surface writes first: this fails behaviorally
    // on original code, rather than using an import/compilation failure.
    expect(f.state.settingsWrites).toBe(0);
    expect(failure).toBeInstanceOf(PreflightDraftProtectedError);
    expect(f.send.click).not.toHaveBeenCalled();
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Enter");
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Backspace");
  });
  it.each(["false", "throw", "timeout", "atom", "focus-atom", "expanded"] as const)(
    "refuses a %s caret without any write", async caret => {
      const f = textFlowFixture({ caret }); await refused(f);
      expect(f.state.writes).toBe(0);
    },
  );
  it.each(["url", "document", "focus"] as const)("refuses %s change during awaited paste", async afterPaste => {
    delete process.env.CGPRO_SKIP_COMPOSER_PASTE;
    const f = textFlowFixture({ afterPaste, paste: "nothing" }); await refused(f);
    expect(f.state.writes).toBe(0);
  });
  it.each(["nothing", "throws"] as const)("keeps same-surface %s paste-to-typed fallback", async paste => {
    delete process.env.CGPRO_SKIP_COMPOSER_PASTE;
    const f = textFlowFixture({ paste });
    // No inline code in this case, so a per-line failed paste cannot mask fallback.
    const body = "whole first line\nwhole second line";
    await sendPrompt(f.page, body, true);
    expect(f.state.text).toBe(body); expect(f.state.chip).toBe(true);
    expect(f.state.settingsWrites).toBe(0); expect(f.send.click).toHaveBeenCalledTimes(1);
  });
  it.each(["url", "focus"] as const)("stops immediately after mid-typed %s loss", async afterWrite => {
    const f = textFlowFixture({ afterWrite }); await refused(f);
    expect(f.state.writes).toBe(1);
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Shift+Enter");
  });
  it("guards inline-code paste after a whole-prompt paste miss", async () => {
    delete process.env.CGPRO_SKIP_COMPOSER_PASTE;
    const f = textFlowFixture({ paste: "nothing" });
    const realEvaluate = f.composer.evaluate;
    f.composer.evaluate = async (callback, arg) => {
      const result = await realEvaluate(callback, arg);
      if (arg === "keep `inline-code`" || (typeof arg === "object" && arg !== null && "text" in arg && arg.text === "keep `inline-code`")) f.state.url = "https://chatgpt.com/settings";
      return result;
    };
    await refused(f);
    expect(f.state.text).toBe("Exact first line\n");
    expect(f.page.keyboard.insertText).not.toHaveBeenCalledWith("keep `inline-code`");
  });
  it("guards compatibility typing without an environment bypass", async () => {
    process.env.CGPRO_TYPE_KEYSTROKES = "1";
    try {
      const f = textFlowFixture({ afterWrite: "url" }); await refused(f);
      expect(f.page.keyboard.type).toHaveBeenCalledTimes(1);
    } finally { delete process.env.CGPRO_TYPE_KEYSTROKES; }
  });
  it("safely appends a swallowed prompt once, retaining the native chip", async () => {
    const f = textFlowFixture({ swallowWrites: 1 });
    await sendPrompt(f.page, "complete delivery-token", true);
    expect(f.state.text).toBe("complete delivery-token"); expect(f.state.chip).toBe(true);
    expect(f.page.keyboard.insertText).toHaveBeenCalledTimes(2);
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Backspace");
  });
  it("refuses unsafe reinsertion after model verification replaces the document", async () => {
    const f = textFlowFixture({ swallowWrites: 1 });
    await expect(sendPrompt(f.page, "whole delivery-token", true, undefined, async () => {
      f.state.document = {};
    })).rejects.toBeInstanceOf(PreflightDraftProtectedError);
    expect(f.state.writes).toBe(1); expect(f.send.click).not.toHaveBeenCalled();
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Backspace");
  });
  it("restores DOM focus after model menus and for Enter fallback", async () => {
    const f = textFlowFixture({ sendFails: true });
    await sendPrompt(f.page, prompt, true, undefined, async () => { f.state.active = {}; });
    expect(f.state.text).toBe(prompt); expect(f.state.active).not.toBeNull();
    expect(f.composer.click).not.toHaveBeenCalled();
    expect(f.page.keyboard.press).toHaveBeenCalledWith("Enter");
  });
  it("refuses Enter if failed Send attempts changed the surface", async () => {
    const f = textFlowFixture({ sendFails: true, loseDuringSend: true });
    await expect(sendPrompt(f.page, prompt, true)).rejects.toBeInstanceOf(PreflightDraftProtectedError);
    expect(f.send.click).toHaveBeenCalledTimes(1);
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Enter");
  });
  it("honors cancellation before final verification and any submit", async () => {
    const f = textFlowFixture({ cancelAfterWrites: 1 }); const verify = vi.fn();
    await sendPrompt(f.page, "complete delivery-token", true, () => f.state.cancelled, verify);
    expect(verify).not.toHaveBeenCalled(); expect(f.send.click).not.toHaveBeenCalled();
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Enter");
  });
  it("keeps final native-mode disappearance terminal with no submit or deletion", async () => {
    const f = textFlowFixture();
    await expect(sendPrompt(f.page, prompt, true, undefined, async () => {
      throw new Error("native mode missing");
    })).rejects.toThrow("native mode missing");
    expect(f.state.text).toBe(prompt); expect(f.send.click).not.toHaveBeenCalled();
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Enter");
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Backspace");
  });
  it.each([{ multiple: true }, { hidden: true }])("refuses ambiguous or invisible original composer %j", async options => {
    const f = textFlowFixture(options); await refused(f); expect(f.state.writes).toBe(0);
  });
  it("rejects duplicate whole text even when the legacy length/tail check would pass", async () => {
    const f = textFlowFixture({ duplicate: true });
    await expect(sendPrompt(f.page, "complete delivery-token", true)).rejects.toMatchObject({ code: "prompt_delivery_incomplete" });
    expect(f.send.click).not.toHaveBeenCalled();
    expect(f.page.keyboard.press).not.toHaveBeenCalledWith("Enter");
  });
  it("still permits an ordinary empty editable composer", async () => {
    const f = textFlowFixture({ chip: false });
    await sendPrompt(f.page, "ordinary complete prompt", false);
    expect(f.state.text).toBe("ordinary complete prompt"); expect(f.send.click).toHaveBeenCalledTimes(1);
  });
});
