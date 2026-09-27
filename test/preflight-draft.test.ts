import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { Page } from "patchright";
import type { Session } from "../src/browser/session.js";
import { PreflightDraftProtectedError } from "../src/errors.js";
import { joinSelectors, SELECTORS } from "../src/browser/selectors.js";

const goHome = vi.fn();
const openConversation = vi.fn();
const clearComposer = vi.fn();
const setConnector = vi.fn();
const model = vi.fn();
const probe = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({ goHome: (...a: unknown[]) => goHome(...a), isLoggedIn: async () => true }));
vi.mock("../src/api/conversation-filing.js", () => ({ requireAccount: async () => {} }));
vi.mock("../src/browser/conversation.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/browser/conversation.js")>(),
  openConversation: (...a: unknown[]) => openConversation(...a),
  clearComposer: (...a: unknown[]) => clearComposer(...a),
  setConnector: (...a: unknown[]) => setConnector(...a),
  ensureProSixMaximum: (...a: unknown[]) => model(...a),
  probePromptDelivery: (...a: unknown[]) => probe(...a),
}));
const { assertPreflightDraftSafe } = await import("../src/browser/conversation.js");
const { runInteractionPreflight } = await import("../src/core/orchestrator.js");

// Synthetic DOM surfaces execute the actual in-page admission function. Reads
// return content only inside this VM; the Page boundary returns a boolean.
function fixture(initial: Partial<State> = {}) {
  const state: State = { text: "", attachment: false, file: false, mention: "", unknown: false,
    readable: true, count: 1, form: true, unknownButton: false, unknownTestId: "", controls: [],
    url: "https://chatgpt.com/", ...initial };
  // Records every bounded composer-hydration wait the preflight issues, with the
  // composer count it saw when the wait began, so a test can prove the home
  // guard ran after hydration and not before it.
  const composerWaits: Array<{ selector: string; options: { state?: string; timeout?: number }; countAtStart: number }> = [];
  const page = {
    url: () => state.url,
    keyboard: { press: vi.fn(async () => {}) },
    // P-035 2026-09-27 r11. Models the bounded composer visibility wait. The
    // default (composer already present) resolves immediately; hydrationMs
    // makes the composer appear only during the wait; composerNeverHydrates
    // rejects the way Playwright's own waitFor timeout does.
    locator: (selector: string) => ({
      first: () => ({
        waitFor: async (options: { state?: string; timeout?: number }) => {
          composerWaits.push({ selector, options, countAtStart: state.count });
          if (state.composerNeverHydrates) {
            await new Promise(resolve => setTimeout(resolve, 5));
            throw Object.assign(
              new Error(`locator.waitFor: Timeout ${options.timeout}ms exceeded`), { name: "TimeoutError" });
          }
          if (state.composerHydrationMs !== undefined) {
            await new Promise(resolve => setTimeout(resolve, state.composerHydrationMs));
            state.count = 1;
          }
        },
      }),
    }),
    evaluate: vi.fn(async (fn: Function, arg: unknown) => {
      if (!state.readable) throw new Error("synthetic evaluation failure with private content");
      const tokenTexts = state.mentions ?? (state.mention ? [state.mention] : []);
      const tokens = tokenTexts.map(textContent => ({ tagName: "A", textContent, remove() {} }));
      // Synthetic rich nodes carry the real shape the guard reads: tagName,
      // an attributes list, own textContent, and element children.
      const materialize = (node: RichNode): object => ({
        tagName: node.tagName,
        attributes: (node.attributes ?? []).map(attribute => ({ name: attribute.name, value: attribute.value ?? "" })),
        textContent: node.textContent ?? "",
        children: (node.children ?? []).map(materialize),
      });
      const richNodes = state.rich ?? (state.unknown ? [{ tagName: "CUSTOM-TOKEN", attributes: [] }] : []);
      const copy = { textContent: state.text, querySelectorAll: (selector: string) => selector === "*"
        ? richNodes.map(materialize) : tokens };
      // Form controls answer `matches` the way CSS attribute selectors would, so
      // the guard's real allowlist string decides admission, not the fixture.
      const controls = state.controls.length > 0
        ? state.controls
        : state.unknownButton ? [{ testid: state.unknownTestId }] : [];
      const form = {
        querySelector: () => state.attachment ? {} : null,
        querySelectorAll: () => controls.map(control => ({
          closest: () => null,
          matches: (selector: string) => (control.tagName ?? "BUTTON") !== "BUTTON" ? false
            : (!!control.testid && selector.includes(`data-testid="${control.testid}"`))
              || (!!control.ariaLabel && selector.includes(`aria-label="${control.ariaLabel}"`)),
          getAttribute: (name: string) => name === "data-testid" ? (control.testid ?? "")
            : name === "aria-label" ? (control.ariaLabel ?? null) : null,
          tagName: control.tagName ?? "BUTTON",
        })),
      };
      const composer = { isConnected: true, getClientRects: () => [{}], innerText: tokenTexts.join("") + state.text, cloneNode: () => copy,
        closest: () => state.form ? form : null, contains: () => false };
      const document = {
        body: { childNodes: state.count ? [composer] : [] },
        querySelectorAll: (selector: string) => selector === 'input[type="file"]'
          ? [{ files: state.file ? [{}] : [] }] : Array.from({ length: state.count }, () => composer),
        createTreeWalker: () => ({ nextNode: () => false }),
      };
      return runInNewContext(`(${fn.toString()})(arg)`, {
        arg, document, location: new URL(state.url), HTMLTextAreaElement: class {}, NodeFilter: { SHOW_TEXT: 4 },
      });
    }),
  } as unknown as Page;
  return { state, page, session: { page } as Session, composerWaits };
}
interface RichNode {
  tagName: string;
  attributes?: Array<{ name: string; value?: string }>;
  textContent?: string;
  children?: RichNode[];
}
interface State {
  text: string; attachment: boolean; file: boolean; mention: string; mentions?: string[]; unknown: boolean;
  readable: boolean; count: number; form: boolean; unknownButton: boolean; unknownTestId: string;
  controls: Array<{ testid?: string; ariaLabel?: string; tagName?: string }>; url: string; rich?: RichNode[];
  /** Delays the composer's appearance until this many ms into the hydration wait. */
  composerHydrationMs?: number;
  /** Makes the bounded composer wait itself time out, as a never-hydrating page does. */
  composerNeverHydrates?: boolean;
}
const options = { model: "gpt-6-pro" as const, connector: "fixture", gizmoId: "project", expectedAccountEmail: "fixture@example.com" };

beforeEach(() => {
  vi.resetAllMocks();
  goHome.mockResolvedValue(undefined);
  openConversation.mockResolvedValue(undefined);
  clearComposer.mockImplementation(async (_page, guard) => { await guard?.(); });
  setConnector.mockResolvedValue(undefined);
  model.mockResolvedValue({ power: 4 });
});

describe("draft-safe interaction preflight", () => {
  it.each([
    { text: "private draft" }, { text: "   " }, { attachment: true }, { file: true }, { mention: "private mention" },
    { unknown: true }, { readable: false }, { count: 0 }, { count: 2 }, { form: false }, { unknownButton: true },
  ])("refuses initial protected/unknown state without navigation, clear, or Escape: %j", async initial => {
    const { state, page, session } = fixture(initial);
    const before = { ...state };
    await expect(runInteractionPreflight(options, session)).rejects.toBeInstanceOf(PreflightDraftProtectedError);
    expect(state).toEqual(before);
    expect(goHome).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
    expect(setConnector).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it.each(["home", "project", "model", "cleanup"])("preserves rich drafts appearing at %s", async stage => {
    const { state, session } = fixture();
    const introduce = () => { state.attachment = true; state.text = "private arriving draft"; };
    if (stage === "home") goHome.mockImplementationOnce(introduce);
    if (stage === "project") openConversation.mockImplementationOnce(introduce);
    if (stage === "model") model.mockImplementationOnce(() => { introduce(); return { power: 4 }; });
    if (stage === "cleanup") goHome.mockResolvedValueOnce(undefined).mockImplementationOnce(introduce);
    await expect(runInteractionPreflight(options, session)).rejects.toBeInstanceOf(PreflightDraftProtectedError);
    expect(state.text).toBe("private arriving draft");
    expect(state.attachment).toBe(true);
    expect(goHome).toHaveBeenCalledTimes(stage === "cleanup" ? 2 : 1);
    expect(clearComposer).toHaveBeenCalledTimes(stage === "model" || stage === "cleanup" ? 1 : stage === "project" ? 1 : 0);
  });

  it("preserves a draft arriving alongside another verification error", async () => {
    const { state, session } = fixture();
    const original = new Error("model verification failed");
    model.mockImplementationOnce(() => { state.mention = "new user token"; throw original; });
    await expect(runInteractionPreflight(options, session)).rejects.toBe(original);
    expect(state.mention).toBe("new user token");
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it("admits pristine about:blank and completes an empty preflight with its owned connector", async () => {
    const { state, session } = fixture({ url: "about:blank", count: 0 });
    goHome.mockImplementation(() => { state.url = "https://chatgpt.com/"; state.count = 1; state.mention = ""; });
    setConnector.mockImplementation(() => { state.mention = "fixture"; });
    await expect(runInteractionPreflight(options, session)).resolves.toMatchObject({ connectorVerified: true, power: 4 });
    expect(openConversation).toHaveBeenCalledWith(session.page, expect.any(Object), expect.any(Function), true);
    expect(setConnector).toHaveBeenCalledWith(session.page, "fixture", true);
    expect(goHome).toHaveBeenCalledTimes(2);
  });

  it("only admits exact owned text or token, never extra text or attachments", async () => {
    const { state, page } = fixture({ text: "owned probe" });
    await expect(assertPreflightDraftSafe(page, { text: "owned probe" })).resolves.toBeUndefined();
    state.text += " ";
    await expect(assertPreflightDraftSafe(page, { text: "owned probe" })).rejects.toThrow("safe draft ownership");
    state.text += " plus private user draft";
    await expect(assertPreflightDraftSafe(page, { text: "owned probe" })).rejects.toThrow("safe draft ownership");
    state.text = ""; state.mention = "fixture";
    await expect(assertPreflightDraftSafe(page, { connector: "fixture" })).resolves.toBeUndefined();
    state.file = true;
    await expect(assertPreflightDraftSafe(page, { connector: "fixture" })).rejects.toBeInstanceOf(PreflightDraftProtectedError);
  });

  // P-035 2026-09-27. A connector turn places the owned connector token AND
  // this call's prompt in one composer. The combined spec admits exactly that
  // shape and refuses a wrong token, a wrong prompt, an extra draft beside
  // them, or a second token.
  it("admits only the owned connector token followed by the owned text", async () => {
    const { page } = fixture({ mention: "fixture", text: "owned probe" });
    await expect(assertPreflightDraftSafe(page, { connector: "fixture", text: "owned probe" }))
      .resolves.toBeUndefined();
    // Leading/trailing whitespace around the remainder is trimmed, nothing else.
    const spaced = fixture({ mention: "fixture", text: "  owned probe  " });
    await expect(assertPreflightDraftSafe(spaced.page, { connector: "fixture", text: "owned probe" }))
      .resolves.toBeUndefined();
  });

  it("refuses a combined connector turn on a wrong token, wrong text, extra text, or two tokens", async () => {
    const wrongToken = await assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: "owned probe" }).page, { connector: "other", text: "owned probe" },
    ).catch(error => error);
    expect(wrongToken).toBeInstanceOf(PreflightDraftProtectedError);
    expect(wrongToken.reason).toBe("connector_token_mismatch");

    const wrongText = await assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: "owned probe" }).page, { connector: "fixture", text: "different probe" },
    ).catch(error => error);
    expect(wrongText.reason).toBe("owned_text_mismatch");

    const extraText = await assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: "owned probe plus private draft" }).page,
      { connector: "fixture", text: "owned probe" },
    ).catch(error => error);
    expect(extraText.reason).toBe("owned_text_mismatch");

    const twoTokens = await assertPreflightDraftSafe(
      fixture({ mentions: ["fixture", "fixture"], text: "owned probe" }).page,
      { connector: "fixture", text: "owned probe" },
    ).catch(error => error);
    expect(twoTokens.reason).toBe("connector_token_mismatch");
  });

  it("does not expose refused content in its typed error", async () => {
    const { page } = fixture({ text: "sensitive fixture" });
    const error = await assertPreflightDraftSafe(page).catch(error => error);
    expect(error).toMatchObject({ code: "preflight_draft_protected", promptSubmitted: false });
    expect(JSON.stringify(error)).not.toContain("sensitive");
    expect(error.message).not.toContain("sensitive");
  });

  // P-035 2026-09-27. `assertPreflightDraftSafe` answered only true/false, so a
  // live home-lane refusal named no check. The FIRST refusing branch now reports
  // a closed, content-free reason code on the error and in exactly one log line.
  it("names an unlisted control by its own testid, content-free", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { page } = fixture({ unknownButton: true, unknownTestId: "voice-mode-btn" });
      const error = await assertPreflightDraftSafe(page).catch(error => error);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("unknown_control:voice-mode-btn");
      const refusals = spy.mock.calls.map(call => String(call[0]))
        .filter(line => line.includes("draft guard refused"));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain("reason=unknown_control:voice-mode-btn");
    } finally {
      spy.mockRestore();
    }
  });

  // P-035 2026-09-27. Live ms1980: this account's composer `+` carries
  // aria-label="Add files and more" and no composer-plus-btn testid, so an
  // empty home lane refused `unknown_control:Add files and more`.
  it("admits an empty composer holding only the Add files and more button plus allowlisted controls", async () => {
    const { page } = fixture({ controls: [
      { ariaLabel: "Add files and more" },
      { testid: "send-button" },
      { ariaLabel: "Select ChatGPT model" },
    ] });
    await expect(assertPreflightDraftSafe(page)).resolves.toBeUndefined();
  });

  // P-035 2026-09-27. The same empty home composer also shows the dictation
  // (microphone) and voice-mode buttons; with the `+` admitted the lane refused
  // `unknown_control:Dictate|Start Voice`. Both are UI chrome with no draft
  // content, admitted here by the exact identifier the refusal names.
  it("admits an empty composer holding Dictate and Start Voice alongside the allowlisted controls", async () => {
    const { page } = fixture({ controls: [
      { ariaLabel: "Add files and more" },
      { ariaLabel: "Dictate" },
      { ariaLabel: "Start Voice" },
      { testid: "send-button" },
      { ariaLabel: "Select ChatGPT model" },
    ] });
    await expect(assertPreflightDraftSafe(page)).resolves.toBeUndefined();
  });

  it("admits a Dictate or Start Voice button identified by testid as well as aria-label", async () => {
    const byTestid = fixture({ controls: [{ testid: "Dictate" }, { testid: "Start Voice" }] });
    await expect(assertPreflightDraftSafe(byTestid.page)).resolves.toBeUndefined();
  });

  // P-035 2026-09-28 r12. Live ms1980 (vendor 1684dee): once the hydration wait
  // worked, the same empty home lane refused `unknown_control:Send` -- its only
  // unknown control. On this UI variant the empty composer's send arrow has
  // identifier `Send` and neither `send-button` nor `composer-send-button`
  // testid. It is UI chrome with no draft content, admitted by that exact
  // sanitized identifier on a `button`, exactly as r8 admitted Dictate and
  // Start Voice.
  it("admits an empty composer holding Add files and more, Dictate, the Send button, the model pill and an empty placeholder paragraph", async () => {
    const { page } = fixture({
      rich: [{ tagName: "P", attributes: [{ name: "data-empty-paragraph", value: "" }] }],
      controls: [
        { ariaLabel: "Add files and more" },
        { ariaLabel: "Dictate" },
        { ariaLabel: "Send" },
        { ariaLabel: "Select ChatGPT model" },
      ],
    });
    await expect(assertPreflightDraftSafe(page)).resolves.toBeUndefined();

    // The same arrow identified by testid, beside the model pill's other
    // allowlisted shape and a placeholder paragraph carrying BR children.
    const byTestid = fixture({
      rich: [{ tagName: "P", attributes: [{ name: "data-placeholder", value: "Ask anything" }], children: [{ tagName: "BR" }] }],
      controls: [{ testid: "Send" }, { testid: "model-switcher-dropdown-button" }],
    });
    await expect(assertPreflightDraftSafe(byTestid.page)).resolves.toBeUndefined();
  });

  it("still refuses a Send control that is not a button, or is not an exact identifier match", async () => {
    const notAButton = await assertPreflightDraftSafe(
      fixture({ controls: [{ ariaLabel: "Send", tagName: "DIV" }] }).page,
    ).catch(error => error);
    expect(notAButton).toBeInstanceOf(PreflightDraftProtectedError);
    expect(notAButton.reason).toBe("unknown_control:Send");

    const sendSuffix = await assertPreflightDraftSafe(
      fixture({ controls: [{ ariaLabel: "Send now" }] }).page,
    ).catch(error => error);
    expect(sendSuffix.reason).toBe("unknown_control:Send now");
  });

  it("still refuses typed text with the Send button present", async () => {
    const { page } = fixture({ text: "private user draft", controls: [{ ariaLabel: "Send" }] });
    const error = await assertPreflightDraftSafe(page).catch(error => error);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("text_present");
    expect(JSON.stringify(error)).not.toContain("private user draft");
  });

  it("still refuses a Dictate control that is not a button, or is not an exact identifier match", async () => {
    const notAButton = await assertPreflightDraftSafe(
      fixture({ controls: [{ ariaLabel: "Dictate", tagName: "DIV" }] }).page,
    ).catch(error => error);
    expect(notAButton).toBeInstanceOf(PreflightDraftProtectedError);
    expect(notAButton.reason).toBe("unknown_control:Dictate");

    const dictationSuffix = await assertPreflightDraftSafe(
      fixture({ controls: [{ ariaLabel: "Dictate now" }] }).page,
    ).catch(error => error);
    expect(dictationSuffix.reason).toBe("unknown_control:Dictate now");

    const voiceSuffix = await assertPreflightDraftSafe(
      fixture({ controls: [{ ariaLabel: "Start Voice Recording X" }] }).page,
    ).catch(error => error);
    expect(voiceSuffix.reason).toBe("unknown_control:Start Voice Recording X");
  });

  it("still refuses typed text with the Dictate and Start Voice controls present", async () => {
    const { page } = fixture({ text: "private user draft",
      controls: [{ ariaLabel: "Dictate" }, { ariaLabel: "Start Voice" }] });
    const error = await assertPreflightDraftSafe(page).catch(error => error);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("text_present");
    expect(JSON.stringify(error)).not.toContain("private user draft");
  });

  it("names every unknown control at once, de-duplicated in DOM order", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { page } = fixture({ controls: [
        { testid: "alpha-ctl" }, { testid: "beta-ctl" }, { testid: "alpha-ctl" },
      ] });
      const error = await assertPreflightDraftSafe(page).catch(error => error);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("unknown_control:alpha-ctl|beta-ctl");
      const refusals = spy.mock.calls.map(call => String(call[0]))
        .filter(line => line.includes("draft guard refused"));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain("reason=unknown_control:alpha-ctl|beta-ctl");
    } finally {
      spy.mockRestore();
    }
  });

  it("still refuses on the control branch with typed text present, leaking no draft text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { page } = fixture({ text: "private user draft",
        controls: [{ testid: "alpha-ctl" }, { testid: "beta-ctl" }] });
      const error = await assertPreflightDraftSafe(page).catch(error => error);
      expect(error.reason).toBe("unknown_control:alpha-ctl|beta-ctl");
      const logged = spy.mock.calls.map(call => String(call[0])).join("\n");
      expect(logged).toContain("reason=unknown_control:alpha-ctl|beta-ctl");
      expect(logged).not.toContain("private user draft");
      expect(JSON.stringify(error)).not.toContain("private user draft");
      expect(error.message).not.toContain("private user draft");
    } finally {
      spy.mockRestore();
    }
  });

  it("caps the multi-control reason at five identifiers and 200 characters", async () => {
    const long = (fill: string) => fill.repeat(80);
    const { page } = fixture({ controls: [
      { testid: long("a") }, { testid: long("b") }, { testid: long("c") },
      { testid: long("d") }, { testid: long("e") }, { testid: long("f") },
    ] });
    const error = await assertPreflightDraftSafe(page).catch(error => error);
    const expected = `unknown_control:${["a", "b", "c", "d", "e"].map(fill => fill.repeat(60)).join("|")}`.slice(0, 200);
    expect(error.reason).toBe(expected);
    expect(error.reason.length).toBeLessThanOrEqual(200);
    expect(error.reason).not.toContain(`${"f".repeat(60)}`);
  });

  // P-035 2026-09-27 r10. Live ms1980 (vendor 858d698): once
  // `data-empty-paragraph` was admitted, the same empty placeholder paragraph
  // refused `rich_attr:data-placeholder`. Admitting attribute names one round
  // at a time is the wrong rule. A P with no text and only BR children cannot
  // carry draft content, whatever attributes it has, so that whole shape is
  // exempt from the attribute refusal: every attribute on it is skipped at once.
  it("admits an empty composer whose editor holds the empty placeholder paragraph", async () => {
    const bare = fixture({
      rich: [{
        tagName: "P",
        attributes: [
          { name: "data-empty-paragraph", value: "" },
          { name: "data-placeholder", value: "Ask anything" },
          { name: "class", value: "placeholder" },
        ],
      }],
      controls: [{ ariaLabel: "Add files and more" }, { testid: "send-button" }],
    });
    await expect(assertPreflightDraftSafe(bare.page)).resolves.toBeUndefined();

    const withBreak = fixture({ rich: [{
      tagName: "P",
      attributes: [
        { name: "data-empty-paragraph", value: "" },
        { name: "data-placeholder", value: "Ask anything" },
        { name: "class", value: "placeholder" },
      ],
      children: [{ tagName: "BR" }],
    }] });
    await expect(assertPreflightDraftSafe(withBreak.page)).resolves.toBeUndefined();
  });

  it("refuses a placeholder-named attribute on any node that can carry content", async () => {
    // A P with own text is not a placeholder paragraph: full attribute check.
    const withText = await assertPreflightDraftSafe(fixture({ text: "private user draft",
      rich: [{ tagName: "P", attributes: [{ name: "data-placeholder", value: "x" }], textContent: "hello" }],
    }).page).catch(error => error);
    expect(withText.reason).toBe("rich_attr:data-placeholder");
    expect(JSON.stringify(withText)).not.toContain("private user draft");

    // A P with a non-BR child element is not a placeholder paragraph either.
    const withElement = await assertPreflightDraftSafe(fixture({
      rich: [{ tagName: "P", attributes: [{ name: "data-placeholder", value: "x" }], children: [{ tagName: "SPAN" }] }],
    }).page).catch(error => error);
    expect(withElement.reason).toBe("rich_attr:data-placeholder");

    // Another tag never qualifies, whatever its text or children.
    const otherTag = await assertPreflightDraftSafe(fixture({
      rich: [{ tagName: "SPAN", attributes: [{ name: "data-placeholder", value: "x" }] }],
    }).page).catch(error => error);
    expect(otherTag.reason).toBe("rich_attr:data-placeholder");
  });

  it("still refuses data-empty-paragraph on a P with text or another tag", async () => {
    const withText = await assertPreflightDraftSafe(fixture({ text: "private user draft",
      rich: [{ tagName: "P", attributes: [{ name: "data-empty-paragraph", value: "" }], textContent: "private user draft" }],
    }).page).catch(error => error);
    expect(withText.reason).toBe("rich_attr:data-empty-paragraph");
    expect(JSON.stringify(withText)).not.toContain("private user draft");

    const otherTag = await assertPreflightDraftSafe(fixture({
      rich: [{ tagName: "SPAN", attributes: [{ name: "data-empty-paragraph", value: "" }] }],
    }).page).catch(error => error);
    expect(otherTag.reason).toBe("rich_attr:data-empty-paragraph");
  });

  // P-035 2026-09-27. The rich-node refusal names every refused attribute on
  // the first refusing node, so a further variant attribute shows up in one
  // round. r10: the probe node is a SPAN because a bare P with no text and no
  // non-BR child is now the exempt placeholder shape.
  it("names every refused attribute on the first refusing node, de-duplicated", async () => {
    const { page } = fixture({ rich: [{ tagName: "SPAN", attributes: [{ name: "data-a" }, { name: "data-b" }] }] });
    const error = await assertPreflightDraftSafe(page).catch(error => error);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("rich_attr:data-a|data-b");

    const first = fixture({ rich: [
      { tagName: "DIV", attributes: [{ name: "role" }] },
      { tagName: "P", attributes: [{ name: "data-c" }, { name: "contenteditable" }] },
    ] });
    const firstError = await assertPreflightDraftSafe(first.page).catch(error => error);
    expect(firstError.reason).toBe("rich_node:DIV");
  });

  it("names a typed-text refusal text_present without leaking the draft", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { page } = fixture({ text: "private user draft" });
      const error = await assertPreflightDraftSafe(page).catch(error => error);
      expect(error.reason).toBe("text_present");
      const logged = spy.mock.calls.map(call => String(call[0])).join("\n");
      expect(logged).toContain("reason=text_present");
      expect(logged).not.toContain("private user draft");
      expect(JSON.stringify(error)).not.toContain("private user draft");
      expect(error.message).not.toContain("private user draft");
    } finally {
      spy.mockRestore();
    }
  });

  it("names a composer-count and an origin refusal by their own codes", async () => {
    const two = await assertPreflightDraftSafe(fixture({ count: 2 }).page).catch(error => error);
    expect(two.reason).toBe("composer_count:2");
    const foreign = await assertPreflightDraftSafe(fixture({ url: "https://example.com/" }).page).catch(error => error);
    expect(foreign.reason).toBe("foreign_origin");
  });

  it("logs no refusal line and sets no reason when the draft is admissible", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { page } = fixture({ text: "owned probe" });
      await expect(assertPreflightDraftSafe(page, { text: "owned probe" })).resolves.toBeUndefined();
      expect(spy.mock.calls.map(call => String(call[0]))
        .filter(line => line.includes("draft guard refused"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// P-035 2026-09-27 r11. Live ms1980 (vendor 9af999b, two fresh daemons): the
// interaction preflight refused `composer_count:0` at phase `home` about 1.4 s
// after `goHome`, on a page whose composer had simply not hydrated yet. The
// sequence was `mark("home"); await goHome(page); await guard();` and the login
// wait that already covers hydration ran only AFTER that guard. These two cases
// pin the fix: the home guard must judge a hydrated composer, and a composer
// that never arrives must still refuse exactly as before.
describe("home composer hydration wait", () => {
  it("waits for the hydrated composer before the home guard, then proceeds past home", async () => {
    const { state, session, composerWaits } = fixture({ url: "about:blank", count: 0 });
    // goHome lands on chatgpt.com but the composer is NOT there yet, exactly as
    // the live pre-hydration shell was.
    goHome.mockImplementation(() => { state.url = "https://chatgpt.com/"; state.mention = ""; });
    setConnector.mockImplementation(() => { state.mention = "fixture"; });
    state.composerHydrationMs = 30;
    await expect(runInteractionPreflight(options, session))
      .resolves.toMatchObject({ connectorVerified: true, power: 4 });
    // One bounded wait, against the shipped composer selector, at the shipped bound.
    expect(composerWaits).toHaveLength(1);
    expect(composerWaits[0].selector).toBe(joinSelectors(SELECTORS.composer));
    expect(composerWaits[0].options).toEqual({ state: "visible", timeout: 20_000 });
    // The composer was absent when the wait began and appeared only inside it,
    // so the guard that admitted the home phase ran after the wait.
    expect(composerWaits[0].countAtStart).toBe(0);
    expect(state.count).toBe(1);
    // Past `home`: the rest of the preflight ran against the hydrated page.
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(setConnector).toHaveBeenCalledWith(session.page, "fixture", true);
    expect(goHome).toHaveBeenCalledTimes(2);
  });

  it("swallows the wait's own timeout and still refuses home exactly as today", async () => {
    const { state, session, composerWaits } = fixture({ url: "about:blank", count: 0 });
    goHome.mockImplementation(() => { state.url = "https://chatgpt.com/"; });
    state.composerNeverHydrates = true;
    const error = await runInteractionPreflight(options, session).catch(caught => caught);
    // The wait is not an error: the guard, not the wait, refused, and it refused
    // with the unchanged error, code and reason.
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.code).toBe("preflight_draft_protected");
    expect(error.reason).toBe("composer_count:0");
    expect(composerWaits).toHaveLength(1);
    expect(composerWaits[0].options).toEqual({ state: "visible", timeout: 20_000 });
    expect(composerWaits[0].countAtStart).toBe(0);
    // Nothing past the home phase ran, and the refusal happened once goHome had run.
    expect(goHome).toHaveBeenCalledTimes(1);
    expect(openConversation).not.toHaveBeenCalled();
    expect(setConnector).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
  });
});
