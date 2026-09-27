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
  // Every outermost token the guard removed from its clone this evaluation.
  const removedTokens: FixtureToken[] = [];
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
      // P-035 2026-09-28 r14. A chip's icon is itself a
      // `[contenteditable="false"]` node, so the fixture builds real
      // `parentElement` links and a real `closest`: the guard keeps only the
      // OUTERMOST tokens. `state.mentions`/`state.mention` stay the flat `A`
      // shape every earlier case used; `state.tokenTree` names tag and nesting.
      const tokenRoots: TokenNode[] = state.tokenTree
        ?? tokenTexts.map(textContent => ({ tagName: "A", textContent }));
      const tokens: FixtureToken[] = [];
      const buildToken = (node: TokenNode, parent: unknown): FixtureToken => {
        const element: FixtureToken = {
          tagName: node.tagName,
          textContent: node.textContent ?? "",
          parentElement: parent,
          closest: () => element,
          remove: () => { removedTokens.push(element); },
        };
        tokens.push(element);
        for (const child of node.children ?? []) buildToken(child, element);
        return element;
      };
      for (const root of tokenRoots) buildToken(root, null);
      const tokenTopTexts = tokenRoots.map(node => node.textContent ?? "");
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
        // The shape line bounds its ancestor scan to the form, so the walk must
        // see every synthetic foreign ancestor as inside it.
        contains: () => true,
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
      // P-035 2026-09-28 r17. The foreign text node's parent chain, so the
      // content-free shape line can be proved: tag, role, nearest testid,
      // hidden class and client rects all come from these synthetic ancestors.
      const buildForeignAncestor = (node: ForeignAncestor, parent: unknown): unknown => ({
        tagName: node.tagName ?? "DIV",
        parentElement: parent,
        contains: () => false,
        // Not a button/menu/listbox ancestor: the walk stops here, as it would
        // on a plain wrapper around a bare text node.
        closest: () => null,
        getAttribute: (name: string) => name === "role" ? (node.role ?? null)
          : name === "data-testid" ? (node.testid ?? null)
            : name === "aria-hidden" ? (node.ariaHidden ? "true" : null)
              // r18: the label COUNT comes from these; the value never leaves
              // the shape, which reports a count only.
              : name === "aria-label" ? (node.ariaLabel ?? null) : null,
        hasAttribute: (name: string) => name === "hidden" ? !!node.hiddenAttr : false,
        getClientRects: () => Array.from({ length: node.rects ?? 1 }, () => ({})),
      });
      let foreignParent: unknown = null;
      for (const node of [state.foreignParent, ...(state.foreignAncestors ?? [])]
        .filter((node): node is ForeignAncestor => !!node).reverse()) {
        foreignParent = buildForeignAncestor(node, foreignParent);
      }
      const composer = { isConnected: true, getClientRects: () => [{}],
        innerText: state.composerInnerText ?? (tokenTopTexts.join("") + state.text), cloneNode: () => copy,
        closest: () => state.form ? form : null, contains: () => false,
        // r18: the placeholder scan reads attributes on the composer itself and
        // on its descendants, and only ever compares their trimmed values.
        getAttribute: (name: string) => (state.composerAttributes ?? [])
          .find(attribute => attribute.name === name)?.value ?? null,
        querySelectorAll: () => (state.composerDescendants ?? []).map(attribute => ({
          getAttribute: (name: string) => name === attribute.name ? attribute.value : null,
        })) };
      const document = {
        body: { childNodes: state.count ? [composer] : [] },
        querySelectorAll: (selector: string) => selector === 'input[type="file"]'
          ? [{ files: state.file ? [{}] : [] }] : Array.from({ length: state.count }, () => composer),
        // P-035 2026-09-28 r16. Models ONE text node outside the composer so a
        // test can prove the foreign-text walk still runs after admission. r17
        // gives it a real parent chain, so the refusal's shape line is proved.
        createTreeWalker: () => {
          let served = false;
          return {
            nextNode: () => { if (served || !state.foreignText) return false; served = true; return true; },
            get currentNode() {
              return { textContent: state.foreignText ?? "", parentElement: foreignParent };
            },
          };
        },
      };
      return runInNewContext(`(${fn.toString()})(arg)`, {
        arg, document, location: new URL(state.url), HTMLTextAreaElement: class {}, NodeFilter: { SHOW_TEXT: 4 },
      });
    }),
  } as unknown as Page;
  return { state, page, session: { page } as Session, composerWaits, removedTokens };
}
interface RichNode {
  tagName: string;
  attributes?: Array<{ name: string; value?: string }>;
  textContent?: string;
  children?: RichNode[];
}
/** One connector chip in the composer, with the nesting a real chip has. */
interface TokenNode {
  tagName: string;
  textContent?: string;
  children?: TokenNode[];
}
/** The token shape the guard reads: tag, text, parentElement and closest/remove. */
interface FixtureToken {
  tagName: string;
  textContent: string;
  parentElement: unknown;
  closest: () => FixtureToken;
  remove: () => void;
}
/** One synthetic ancestor of the foreign text node, nearest first. */
interface ForeignAncestor {
  tagName?: string;
  role?: string;
  testid?: string;
  /** r18: an `aria-label` this ancestor carries; only its presence is counted. */
  ariaLabel?: string;
  ariaHidden?: boolean;
  hiddenAttr?: boolean;
  /** Client rect count; `0` models a laid-out-hidden node. */
  rects?: number;
}
interface State {
  text: string; attachment: boolean; file: boolean; mention: string; mentions?: string[]; unknown: boolean;
  readable: boolean; count: number; form: boolean; unknownButton: boolean; unknownTestId: string;
  controls: Array<{ testid?: string; ariaLabel?: string; tagName?: string }>; url: string; rich?: RichNode[];
  /** Connector chips by tag and nesting; overrides the flat `mention(s)` shape. */
  tokenTree?: TokenNode[];
  /** Delays the composer's appearance until this many ms into the hydration wait. */
  composerHydrationMs?: number;
  /** Makes the bounded composer wait itself time out, as a never-hydrating page does. */
  composerNeverHydrates?: boolean;
  /** Overrides the composer's rendered innerText, to model text the detached copy lacks. */
  composerInnerText?: string;
  /** One text node outside the composer, which the foreign-text walk must still reach. */
  foreignText?: string;
  /** The foreign text node's parent, whose shape the refusal line reports. */
  foreignParent?: ForeignAncestor;
  /** Ancestors ABOVE that parent, nearest first, for the hidden/testid scan. */
  foreignAncestors?: ForeignAncestor[];
  /** r18: placeholder-bearing attributes on the composer itself. */
  composerAttributes?: Array<{ name: string; value: string }>;
  /** r18: one placeholder-bearing synthetic descendant per entry. */
  composerDescendants?: Array<{ name: string; value: string }>;
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
    // P-035 2026-09-28 r20. The protected navigation now also receives the
    // lane's configured connector, so its own home/surface guards admit the
    // lane's chip-only residue instead of refusing `connector_unowned`.
    expect(openConversation).toHaveBeenCalledWith(session.page, expect.any(Object), expect.any(Function), true, "fixture");
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
    // r14: the old conflated `connector_token_mismatch` now names the text check.
    expect(wrongToken.reason).toBe("connector_token_text");

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
    // r14: the two-token shape now names its own count sub-reason.
    expect(twoTokens.reason).toBe("connector_token_count:2");
  });

  // P-035 2026-09-28 r14. Live ms1980: the composer held exactly one connector
  // chip and the guard still refused `connector_token_mismatch`. Ownership must
  // be proven by the chip's TEXT, not its tag -- intelli's chip is an `a`,
  // ms1980's is not -- and a nested `[contenteditable="false"]` icon inside a
  // chip is part of that chip, not a second token.
  it("identifies the owned chip by its text, whatever its tag, counting only outermost tokens", async () => {
    // The live ms1980 shape: one chip that is not an `A`, carrying the name.
    const spanChip = fixture({ tokenTree: [{ tagName: "SPAN", textContent: "fixture" }] });
    await expect(assertPreflightDraftSafe(spanChip.page, { connector: "fixture" }))
      .resolves.toBeUndefined();

    // An `A` chip whose icon is itself `[contenteditable="false"]` is ONE
    // outermost token: the nested node must not read as a second chip.
    const nestedIcon = fixture({ tokenTree: [{
      tagName: "A", textContent: "fixture", children: [{ tagName: "SPAN", textContent: "" }],
    }] });
    await expect(assertPreflightDraftSafe(nestedIcon.page, { connector: "fixture" }))
      .resolves.toBeUndefined();
    // Exactly the outermost element was removed, with its nested content.
    expect(nestedIcon.removedTokens).toHaveLength(1);
    expect(nestedIcon.removedTokens[0].tagName).toBe("A");
  });

  it("names each connector-token refusal by its own sub-reason, content-free", async () => {
    const twoSiblings = await assertPreflightDraftSafe(
      fixture({ tokenTree: [
        { tagName: "A", textContent: "fixture" }, { tagName: "SPAN", textContent: "fixture" },
      ] }).page, { connector: "fixture" },
    ).catch(error => error);
    expect(twoSiblings.reason).toBe("connector_token_count:2");

    const wrongName = await assertPreflightDraftSafe(
      fixture({ tokenTree: [{ tagName: "SPAN", textContent: "some other chip" }] }).page,
      { connector: "fixture" },
    ).catch(error => error);
    expect(wrongName.reason).toBe("connector_token_text");
    expect(JSON.stringify(wrongName)).not.toContain("some other chip");

    const unowned = await assertPreflightDraftSafe(
      fixture({ tokenTree: [{ tagName: "SPAN", textContent: "fixture" }] }).page,
    ).catch(error => error);
    expect(unowned).toBeInstanceOf(PreflightDraftProtectedError);
    expect(unowned.reason).toBe("connector_unowned");

    // Typed text beside the chip, with no owned text named, still refuses.
    const typedBeside = await assertPreflightDraftSafe(
      fixture({ tokenTree: [{ tagName: "SPAN", textContent: "fixture" }], text: " plus private draft" }).page,
      { connector: "fixture" },
    ).catch(error => error);
    expect(typedBeside).toBeInstanceOf(PreflightDraftProtectedError);
    expect(typedBeside.reason).toBe("text_present");
    expect(JSON.stringify(typedBeside)).not.toContain("private draft");
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

// P-035 2026-09-28 r15. Live ms1980 (vendor 96e567d, lane ms1980, pid 35868):
// an earlier preflight attached this lane's connector chip, a later guard
// refused for an unrelated reason, `protectedDraft` deliberately skipped
// cleanup, and ChatGPT persisted the chip. Every guard before `setConnector`,
// and every cleanup guard after `goHome` reset `ownedConnector`, then saw an
// unowned chip and refused `connector_unowned`, so the lane could never clear
// its own residue and stayed wedged. The lane's configured connector name is
// lane-specific automation state; a composer holding ONLY that chip carries no
// user content. These cases pin the r15 admission at the preflight's own guard
// and every neighbouring refusal that must not change.
describe("lane-owned connector chip residue", () => {
  const laneOptions = { ...options, connector: "lane-x" };

  it("admits the composer's lone lane-owned chip at the pre-attach guards and proceeds past home", async () => {
    const { state, session } = fixture({ mention: "lane-x" });
    // The chip is present on the home composer from the first read -- exactly
    // the residue the live lane held -- and it is still there when
    // `setConnector` leaves it (the mock does not touch the DOM).
    expect(state.mention).toBe("lane-x");
    const phases: string[] = [];
    await expect(runInteractionPreflight(laneOptions, session, phase => phases.push(phase)))
      .resolves.toMatchObject({ connectorVerified: true, power: 4 });
    // Both pre-attach guards admitted it: the preflight recorded `home` and then
    // crossed into `login`, so it proceeded past the phase that used to refuse.
    expect(phases[0]).toBe("home");
    expect(phases).toContain("login");
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(setConnector).toHaveBeenCalledWith(session.page, "lane-x", true);
    expect(goHome).toHaveBeenCalledTimes(2);
  });

  it("refuses a lane-owned chip followed by typed text as text_present", async () => {
    const { session } = fixture({ mention: "lane-x", text: "private user draft" });
    const error = await runInteractionPreflight(laneOptions, session).catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("text_present");
    expect(goHome).not.toHaveBeenCalled();
  });

  it("refuses a differently named chip as connector_token_text", async () => {
    const { session } = fixture({ mention: "other-y" });
    const error = await runInteractionPreflight(laneOptions, session).catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("connector_token_text");
    expect(goHome).not.toHaveBeenCalled();
  });

  it("still refuses a chip with no configured connector as connector_unowned", async () => {
    const { session } = fixture({ mention: "lane-x" });
    const unowned = { ...options, connector: undefined as unknown as string };
    const error = await runInteractionPreflight(unowned, session).catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("connector_unowned");
    expect(goHome).not.toHaveBeenCalled();
  });
});

// P-035 2026-09-28 r16. Live ms1980 (vendor f74220e, lane ms1980, pid 60447):
// an earlier preflight attached this lane's connector chip and it persisted, and
// the very next guard refused `text_present` on a composer holding ONLY that
// chip. The old rule compared the composer's RENDERED innerText to the connector
// string; the chip's own textContent already equals the connector, so anything
// the editor rendered beyond it -- an invisible character such as U+200B, or
// rendered-only chip chrome the clone does not carry -- failed a chip-only
// composer. The branch now judges the detached copy after the owned token was
// removed, exactly as an empty composer is judged. These cases pin that rule and
// every neighbouring refusal that must not change.
describe("chip-only composer remainder", () => {
  it("admits a lone owned chip whose remainder is only format characters", async () => {
    // U+200B (zero width space) around the chip: the rendered innerText is not
    // the connector, but what is left after the owned token was removed is a
    // single `\p{Cf}` code point.
    const zeroWidth = fixture({ mention: "fixture", text: "\u200B" });
    await expect(assertPreflightDraftSafe(zeroWidth.page, { connector: "fixture" }))
      .resolves.toBeUndefined();

    // U+FEFF (byte order mark / zero width no-break space) is the same class.
    const bom = fixture({ mention: "fixture", text: "\uFEFF" });
    await expect(assertPreflightDraftSafe(bom.page, { connector: "fixture" }))
      .resolves.toBeUndefined();

    // A mixture of whitespace and format characters is still no draft.
    const mixed = fixture({ mention: "fixture", text: " \u200B\n\u2060 " });
    await expect(assertPreflightDraftSafe(mixed.page, { connector: "fixture" }))
      .resolves.toBeUndefined();
  });

  it("admits a lone owned chip whose rendered innerText carries text the detached copy does not", async () => {
    // The whole composer is the chip, so the copy left after the owned token was
    // removed is empty even though the rendered innerText is not the connector.
    // This is the copy rule, and the fake DOM can simulate the divergence.
    const renderedOnly = fixture({ mention: "fixture", text: "", composerInnerText: "fixture\u200B\u2060" });
    await expect(assertPreflightDraftSafe(renderedOnly.page, { connector: "fixture" }))
      .resolves.toBeUndefined();
  });

  it("refuses typed text beside the owned chip and names the content-free remainder shape", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const typed = fixture({ mention: "fixture", text: "hello" });
      const error = await assertPreflightDraftSafe(typed.page, { connector: "fixture" }).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("text_present");
      const logged = spy.mock.calls.map(call => String(call[0])).join("\n");
      expect(logged).toContain("chip remainder shape: len=5 ws=0 cf=0 other=5");
      // Counts only: neither the characters nor the draft text are named.
      expect(logged).not.toContain("hello");
      expect(JSON.stringify(error)).not.toContain("hello");
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies a whitespace and format-character remainder without admitting it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A format character plus a real character: the remainder is not empty, so
      // it refuses, and the shape names the classes rather than the text.
      const error = await assertPreflightDraftSafe(
        fixture({ mention: "fixture", text: "\u200Bx" }).page, { connector: "fixture" },
      ).catch(caught => caught);
      expect(error.reason).toBe("text_present");
      const shapeLine = spy.mock.calls.map(call => String(call[0]))
        .find(line => line.includes("chip remainder shape"));
      expect(shapeLine).toContain("chip remainder shape: len=2 ws=0 cf=1 other=1");
      // Counts only: the shape line names no character.
      expect(shapeLine).not.toContain("x");
      expect(JSON.stringify(error)).not.toContain("\u200Bx");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a second paragraph beside the owned chip", async () => {
    const secondParagraph = fixture({
      mention: "fixture", text: "x", rich: [{ tagName: "P", textContent: "x" }],
    });
    const error = await assertPreflightDraftSafe(secondParagraph.page, { connector: "fixture" })
      .catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("text_present");
  });

  it("still runs the foreign-text walk after admitting a chip-only composer", async () => {
    // The remainder is only a format character, so the new rule admits the chip,
    // and the later walk must still see the text node outside the composer.
    const error = await assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: "\u200B", foreignText: "outside draft" }).page,
      { connector: "fixture" },
    ).catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("foreign_text");
    expect(JSON.stringify(error)).not.toContain("outside draft");
  });

  it("keeps the combined connector+text branch results unchanged", async () => {
    await expect(assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: "owned probe" }).page,
      { connector: "fixture", text: "owned probe" },
    )).resolves.toBeUndefined();

    const mismatch = await assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: "owned probe plus private draft" }).page,
      { connector: "fixture", text: "owned probe" },
    ).catch(caught => caught);
    expect(mismatch).toBeInstanceOf(PreflightDraftProtectedError);
    expect(mismatch.reason).toBe("owned_text_mismatch");
  });
});

// P-035 2026-09-28 r17. `foreign_text` was the one preflight refusal that named
// no node: live ms1980 refused it on a composer whose only visible content was
// the call's own chip, so the refusing text node is probably UI chrome rather
// than a draft. The refusal now carries a content-free shape of that node; these
// cases prove the shape and that admission is unchanged.
describe("foreign text refusal shape", () => {
  const shapeLineOf = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls
    .map(call => String(call[0])).find(line => line.includes("foreign text shape"));

  it("names the hidden ancestor and the connector match for an aria-hidden span", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({
          // A clean composer: the only text node outside it is the hidden span,
          // which repeats the owned connector's text as UI chrome mirror does.
          foreignText: "fixture",
          foreignParent: { tagName: "SPAN", ariaHidden: true },
        }).page,
        { connector: "fixture" },
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("foreign_text");
      const shapeLine = shapeLineOf(spy);
      expect(shapeLine).toContain("foreign text shape:");
      expect(shapeLine).toContain("tag=SPAN");
      expect(shapeLine).toContain("role=-");
      expect(shapeLine).toContain("testid=-");
      expect(shapeLine).toContain("hidden=aria");
      expect(shapeLine).toContain("len=7");
      expect(shapeLine).toContain("equals_connector=yes");
      // Exactly one shape line, and it never carries the refused text.
      expect(spy.mock.calls.map(call => String(call[0]))
        .filter(line => line.includes("foreign text shape"))).toHaveLength(1);
      expect(shapeLine).not.toContain("fixture");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a visible foreign div and its connector comparison", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({ foreignText: "x", foreignParent: { tagName: "DIV" } }).page,
        { connector: "fixture" },
      ).catch(caught => caught);
      expect(error.reason).toBe("foreign_text");
      // The whole line, so the shape is proved to carry nothing else: a visible
      // div, no role or testid, not hidden, the trimmed length, no connector
      // match, and -- r18 -- the six appended features for the same one word.
      // The refused text itself never appears.
      expect(shapeLineOf(spy)).toBe(
        "[cgpro:preflight] foreign text shape: tag=DIV role=- testid=- hidden=no len=1 "
        + "equals_connector=no contains_connector=no equals_placeholder=none "
        + "equals_composer_text=no words=1 path=DIV labels=0",
      );

      spy.mockClear();
      // Without an owned connector the comparison is not made: `n/a`.
      const unowned = await assertPreflightDraftSafe(
        fixture({ foreignText: "x", foreignParent: { tagName: "DIV" } }).page,
      ).catch(caught => caught);
      expect(unowned.reason).toBe("foreign_text");
      expect(shapeLineOf(spy)).toContain("equals_connector=n/a");
      // r18: the same `n/a` carries to the substring comparison.
      expect(shapeLineOf(spy)).toContain("contains_connector=n/a");
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies the hidden attribute and layout-hidden ancestors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await assertPreflightDraftSafe(fixture({
        foreignText: "x", foreignParent: { tagName: "DIV", hiddenAttr: true },
      }).page).catch(caught => caught);
      expect(shapeLineOf(spy)).toContain("hidden=attr");

      spy.mockClear();
      // A parent that is invisible but neither aria-hidden nor `hidden`: the
      // nearest testid still comes from the ancestor that has one.
      await assertPreflightDraftSafe(fixture({
        foreignText: "x",
        foreignParent: { tagName: "SPAN", rects: 0 },
        foreignAncestors: [{ tagName: "DIV", testid: "mirror-node", ariaHidden: true }],
      }).page).catch(caught => caught);
      const shapeLine = shapeLineOf(spy);
      expect(shapeLine).toContain("tag=SPAN");
      expect(shapeLine).toContain("testid=mirror-node");
      expect(shapeLine).toContain("hidden=aria");

      spy.mockClear();
      await assertPreflightDraftSafe(fixture({
        foreignText: "x", foreignParent: { tagName: "DIV", rects: 0 },
      }).page).catch(caught => caught);
      expect(shapeLineOf(spy)).toContain("hidden=layout");
    } finally {
      spy.mockRestore();
    }
  });

  it("still refuses foreign text the way the preflight always did", async () => {
    // The shape is diagnostic only: the reason string and the single refusal
    // line are unchanged.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({ foreignText: "outside draft" }).page,
        { connector: "fixture" },
      ).catch(caught => caught);
      expect(error.reason).toBe("foreign_text");
      const refusals = spy.mock.calls.map(call => String(call[0]))
        .filter(line => line.includes("draft guard refused"));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain("reason=foreign_text");
    } finally {
      spy.mockRestore();
    }
  });

  // P-035 2026-09-28 r18. Live ms1980 (vendor 134f45d): the composer held only
  // the lane's own chip, yet an aria-hidden span inside the form refused
  // `foreign_text`. Before any admission rule the planner needs to know whether
  // that span is UI chrome (a placeholder/hint about the chip) or a mirror of
  // draft text, so the same single line carries six more content-free features.
  // These cases prove each feature and that admission is unchanged.
  it("marks a hidden span whose text contains the owned connector, never logs the text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({
          // Contains the connector but is not equal to it: the two comparisons
          // must disagree, so the line distinguishes a chip hint from a mirror.
          foreignText: "fixture chip",
          foreignParent: { tagName: "SPAN", ariaHidden: true },
        }).page,
        { connector: "fixture" },
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("foreign_text");
      const shapeLine = shapeLineOf(spy);
      expect(shapeLine).toContain("tag=SPAN");
      expect(shapeLine).toContain("hidden=aria");
      expect(shapeLine).toContain("contains_connector=yes");
      expect(shapeLine).toContain("equals_connector=no");
      expect(shapeLine).toContain("words=2");
      // Content-free: neither the refused text nor the connector appears.
      expect(shapeLine).not.toContain("fixture chip");
      expect(spy.mock.calls.map(call => String(call[0]))
        .filter(line => line.includes("foreign text shape"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("matches a placeholder on the composer or on one of its descendants", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The editor's own `data-placeholder`, as the vendor renders it.
      await assertPreflightDraftSafe(
        fixture({
          foreignText: "Ask anything",
          foreignParent: { tagName: "SPAN" },
          composerAttributes: [{ name: "data-placeholder", value: "Ask anything" }],
        }).page,
        { connector: "fixture" },
      ).catch(caught => caught);
      const shapeLine = shapeLineOf(spy);
      expect(shapeLine).toContain("equals_placeholder=yes");
      expect(shapeLine).toContain("words=2");
      expect(shapeLine).not.toContain("Ask anything");

      spy.mockClear();
      // A native `placeholder` attribute on a descendant counts the same way.
      await assertPreflightDraftSafe(
        fixture({
          foreignText: "Message ChatGPT",
          foreignParent: { tagName: "DIV" },
          composerDescendants: [{ name: "placeholder", value: "Message ChatGPT" }],
        }).page,
        { connector: "fixture" },
      ).catch(caught => caught);
      expect(shapeLineOf(spy)).toContain("equals_placeholder=yes");

      spy.mockClear();
      // A placeholder that exists but does not match is `no`, not `none`.
      await assertPreflightDraftSafe(
        fixture({
          foreignText: "unrelated chrome",
          foreignParent: { tagName: "DIV" },
          composerDescendants: [{ name: "placeholder", value: "Message ChatGPT" }],
        }).page,
        { connector: "fixture" },
      ).catch(caught => caught);
      const noMatch = shapeLineOf(spy);
      expect(noMatch).toContain("equals_placeholder=no");
      expect(noMatch).toContain("contains_connector=no");
    } finally {
      spy.mockRestore();
    }
  });

  it("compares the foreign text with the composer's own trimmed text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The combined connector turn, whose rendered composer text is this
      // call's own prompt; the foreign node mirrors exactly that text.
      await assertPreflightDraftSafe(
        fixture({
          mention: "fixture", text: "owned probe", composerInnerText: "owned probe",
          foreignText: "owned probe", foreignParent: { tagName: "SPAN" },
        }).page,
        { connector: "fixture", text: "owned probe" },
      ).catch(caught => caught);
      expect(shapeLineOf(spy)).toContain("equals_composer_text=yes");

      spy.mockClear();
      await assertPreflightDraftSafe(
        fixture({
          mention: "fixture", text: "owned probe", composerInnerText: "owned probe",
          foreignText: "something else", foreignParent: { tagName: "SPAN" },
        }).page,
        { connector: "fixture", text: "owned probe" },
      ).catch(caught => caught);
      expect(shapeLineOf(spy)).toContain("equals_composer_text=no");
    } finally {
      spy.mockRestore();
    }
  });

  it("names the parent-first tag path up to the form and counts its aria-labels", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await assertPreflightDraftSafe(
        fixture({
          foreignText: "x",
          foreignParent: { tagName: "SPAN" },
          // Nearest first: SPAN's parent is the labelled DIV, then the form.
          foreignAncestors: [{ tagName: "DIV", ariaLabel: "Mirror" }, { tagName: "FORM" }],
        }).page,
      ).catch(caught => caught);
      const shapeLine = shapeLineOf(spy);
      expect(shapeLine).toContain("path=SPAN<DIV<FORM");
      expect(shapeLine).toContain("labels=1");
      // Count only: the label's own value never leaves the shape.
      expect(shapeLine).not.toContain("Mirror");

      spy.mockClear();
      // The path is capped at 8 tags; a deeper chain stops at the eighth.
      await assertPreflightDraftSafe(
        fixture({
          foreignText: "x",
          foreignParent: { tagName: "SPAN" },
          foreignAncestors: Array.from({ length: 10 }, (_, index) => ({ tagName: `T${index + 1}` })),
        }).page,
      ).catch(caught => caught);
      const capped = shapeLineOf(spy);
      expect(capped).toContain("path=SPAN<T1<T2<T3<T4<T5<T6<T7");
      expect(capped).not.toContain("<T8");
      expect(capped).toContain("labels=0");
    } finally {
      spy.mockRestore();
    }
  });
});

// P-035 2026-09-28 r19. Live ms1980 refused `foreign_text` on a composer that
// already proved it held only this call's own chip. The refusing span was a
// hidden, whitespace-free serialisation that contains the owned connector -- a
// mirror of the chip, not a draft. These cases prove that exact shape is
// admitted only while this call's own token was admitted, and that every other
// node still refuses exactly as before.
describe("hidden single-token mirror of the owned chip (r19)", () => {
  const reasonOf = async (page: Page, owned: { text?: string; connector?: string }) =>
    (await assertPreflightDraftSafe(page, owned).then(() => undefined).catch(caught => caught))?.reason;

  it("admits a hidden whitespace-free span containing the owned connector", async () => {
    // The composer holds only the owned chip; the span mirrors it as UI chrome.
    await expect(assertPreflightDraftSafe(
      fixture({
        mention: "fixture",
        foreignText: "[x]{fixture}(id-123)",
        foreignParent: { tagName: "SPAN", ariaHidden: true },
      }).page,
      { connector: "fixture" },
    )).resolves.toBeUndefined();

    // The aria-hidden ancestor need not be the direct parent.
    await expect(assertPreflightDraftSafe(
      fixture({
        mention: "fixture",
        foreignText: "[x]{fixture}(id-123)",
        foreignParent: { tagName: "SPAN" },
        foreignAncestors: [{ tagName: "DIV", ariaHidden: true }],
      }).page,
      { connector: "fixture" },
    )).resolves.toBeUndefined();
  });

  it("refuses every neighbouring shape exactly as before", async () => {
    // Hidden, but the single token carries whitespace.
    expect(await reasonOf(
      fixture({
        mention: "fixture",
        foreignText: "[x]{fixture} hello",
        foreignParent: { tagName: "SPAN", ariaHidden: true },
      }).page,
      { connector: "fixture" },
    )).toBe("foreign_text");

    // Hidden single token WITHOUT the owned connector.
    expect(await reasonOf(
      fixture({
        mention: "fixture",
        foreignText: "[x]{other}(id-123)",
        foreignParent: { tagName: "SPAN", ariaHidden: true },
      }).page,
      { connector: "fixture" },
    )).toBe("foreign_text");

    // Visible (not aria-hidden) single token that does contain the connector.
    expect(await reasonOf(
      fixture({
        mention: "fixture",
        foreignText: "[x]{fixture}(id-123)",
        foreignParent: { tagName: "SPAN", rects: 1 },
      }).page,
      { connector: "fixture" },
    )).toBe("foreign_text");

    // The hidden mirror is present but no owned token was admitted this call.
    expect(await reasonOf(
      fixture({
        foreignText: "[x]{fixture}(id-123)",
        foreignParent: { tagName: "SPAN", ariaHidden: true },
      }).page,
      { connector: "fixture" },
    )).toBe("foreign_text");
  });

  it("keeps the unowned shape path as `n/a` when no connector is passed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({
          foreignText: "[x]{fixture}(id-123)",
          foreignParent: { tagName: "SPAN", ariaHidden: true },
        }).page,
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("foreign_text");
      const shapeLine = spy.mock.calls.map(call => String(call[0]))
        .find(line => line.includes("foreign text shape"));
      expect(shapeLine).toContain("contains_connector=n/a");
      expect(shapeLine).not.toContain("id-123");
    } finally {
      spy.mockRestore();
    }
  });
});
