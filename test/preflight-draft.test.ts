import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { Page } from "patchright";
import type { Session } from "../src/browser/session.js";
import { PreflightDraftProtectedError } from "../src/errors.js";
import { joinSelectors, PREFLIGHT_CHROME, SELECTORS } from "../src/browser/selectors.js";

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
const { assertPreflightDraftSafe, COMPOSER_HYDRATION_TIMEOUT_MS } = await import("../src/browser/conversation.js");
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
  // G3: `evaluationsAtStart` counts guard evaluations already run, so a test
  // can prove a wait came BEFORE the first guard.
  const composerWaits: Array<{
    selector: string; options: { state?: string; timeout?: number }; countAtStart: number; evaluationsAtStart: number;
  }> = [];
  // Every outermost token the guard removed from its clone this evaluation.
  const removedTokens: FixtureToken[] = [];
  const page = {
    url: () => state.url,
    keyboard: {
      press: vi.fn(async () => {}),
      // P-035 2026-09-28 r36. The ordinary preflight must never type into the
      // live composer, so the fixture records keystrokes: a test can prove the
      // run issued no `type("@")` (the one `setConnector` types before its
      // picker click). Nothing else in the mocked preflight types.
      type: vi.fn(async () => {}),
    },
    // P-035 2026-09-27 r11. Models the bounded composer visibility wait. The
    // default (composer already present) resolves immediately; hydrationMs
    // makes the composer appear only during the wait; composerNeverHydrates
    // rejects the way Playwright's own waitFor timeout does.
    locator: (selector: string) => ({
      first: () => ({
        waitFor: async (options: { state?: string; timeout?: number }) => {
          composerWaits.push({ selector, options, countAtStart: state.count,
            evaluationsAtStart: (page.evaluate as unknown as { mock: { calls: unknown[] } }).mock.calls.length });
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
      // P-035 2026-10-03 G3-B. Media the guard can find in the form: a chip's
      // own icon (`icon` on a token or a chip button) and, with `attachment`,
      // one foreign media node outside every chip.
      const chipIcons: object[] = [];
      // `contains` follows real `parentElement` links, the node itself included.
      const containsVia = (self: unknown) => (node: unknown): boolean => {
        for (let current = node as { parentElement?: unknown } | null; current;
          current = (current.parentElement ?? null) as { parentElement?: unknown } | null) {
          if (current === self) return true;
        }
        return false;
      };
      // Tokens the guard removed from its clone during THIS evaluation; the
      // clone stops returning them (and their descendants) afterwards.
      const removedNow = new Set<FixtureToken>();
      // G3-B (fifth run): `pill` answers the Deep Research pill selector, and
      // `selectionPill` (or `pill`) the bare `[data-inline-selection-pill]` one.
      // G3-B (sixth run): a node carrying `app-mention-name` answers the Deep
      // Research mention selector (`[contenteditable="false"][app-mention-name]`).
      const answers = (
        entry: { pill?: boolean; selectionPill?: boolean; attributes?: Array<{ name: string }> }, selector: string,
      ): boolean =>
        (!!entry.pill && selector === PREFLIGHT_CHROME.deepResearchChipPill)
        || ((!!entry.pill || !!entry.selectionPill) && selector === "[data-inline-selection-pill]")
        || (selector === PREFLIGHT_CHROME.deepResearchMention
          && (entry.attributes ?? []).some(attribute => attribute.name === "app-mention-name"));
      const attributesOf = (entry: { attributes?: Array<{ name: string; value?: string }> }) => ({
        attributes: (entry.attributes ?? []).map(attribute => ({ name: attribute.name, value: attribute.value ?? "" })),
        getAttribute: (name: string) => (entry.attributes ?? []).find(attribute => attribute.name === name)?.value ?? null,
      });
      // G3-B (fifth run): non-token wrappers around a root token, nearest first.
      // They are inside the composer unless `outside`, are never
      // `[contenteditable="false"]`, and walk `closest` up real parent links.
      const wrapperElements: unknown[] = [];
      const buildWrappers = (wrappers: TokenWrapper[]): unknown => {
        let parent: unknown = null;
        for (const wrapper of [...wrappers].reverse()) {
          const element: Record<string, unknown> = {
            tagName: wrapper.tagName,
            parentElement: parent,
            ...attributesOf(wrapper),
            matches: (selector: string) => answers(wrapper, selector),
            closest: (selector: string): unknown => answers(wrapper, selector) ? element
              : (element.parentElement as { closest?: (s: string) => unknown } | null)?.closest?.(selector) ?? null,
            contains: (node: unknown) => containsVia(element)(node),
          };
          if (!wrapper.outside) wrapperElements.push(element);
          parent = element;
        }
        return parent;
      };
      const buildToken = (node: TokenNode, parent: unknown): FixtureToken => {
        const element: FixtureToken = {
          tagName: node.tagName,
          textContent: node.textContent ?? "",
          parentElement: parent,
          ...attributesOf(node),
          // Every token is `[contenteditable="false"]`; any other selector walks
          // up real parent links, the node itself included.
          closest: (selector: string) => selector === '[contenteditable="false"]' || element.matches(selector) ? element
            : (element.parentElement as { closest?: (s: string) => unknown } | null)?.closest?.(selector) ?? null,
          contains: node => containsVia(element)(node),
          remove: () => { removedTokens.push(element); removedNow.add(element); },
          // G3-B (fourth run): `pill` makes this node answer the pill selector,
          // and `querySelector` finds such a node below it.
          matches: selector => answers(node, selector),
          querySelector: selector => tokens.find(token => token !== element && element.contains(token)
            && token.matches(selector)) ?? null,
          get children() { return tokens.filter(token => token.parentElement === element); },
          get outerHTML() {
            const tag = node.tagName.toLowerCase();
            const attrs = (node.attributes ?? []).map(attribute => ` ${attribute.name}="${attribute.value ?? ""}"`).join("");
            return `<${tag}${attrs}>${node.textContent ?? ""}</${tag}>`;
          },
        };
        tokens.push(element);
        if (node.icon) chipIcons.push({ tagName: "IMG", parentElement: element });
        for (const child of node.children ?? []) buildToken(child, element);
        return element;
      };
      for (const root of tokenRoots) buildToken(root, root.wrappers ? buildWrappers(root.wrappers) : null);
      const inComposer = (node: unknown): boolean =>
        tokens.includes(node as FixtureToken) || wrapperElements.includes(node);
      const tokenTopTexts = tokenRoots.map(node => node.textContent ?? "");
      // Synthetic rich nodes carry the real shape the guard reads: tagName,
      // an attributes list, own textContent, and element children. r31 adds a
      // real `parentElement` chain (rooted at the given parent) and a
      // `getAttribute`, so the content-free rich-attr shape can read the
      // sanitised `contenteditable` value and the node's depth below the
      // composer without any test-only branch in the guard.
      const materialize = (node: RichNode, parent: unknown = null): object => {
        const element: {
          tagName: string; attributes: Array<{ name: string; value: string }>; textContent: string;
          children: object[]; parentElement: unknown; getAttribute: (name: string) => string | null;
        } = {
          tagName: node.tagName,
          attributes: (node.attributes ?? []).map(attribute => ({ name: attribute.name, value: attribute.value ?? "" })),
          textContent: node.textContent ?? "",
          children: [],
          parentElement: parent,
          getAttribute: (name: string) => (node.attributes ?? [])
            .find(attribute => attribute.name === name)?.value ?? null,
        };
        element.children = (node.children ?? []).map(child => materialize(child, element));
        return element;
      };
      const richNodes = state.rich ?? (state.unknown ? [{ tagName: "CUSTOM-TOKEN", attributes: [] }] : []);
      const copy = { textContent: state.text, contains: inComposer, querySelectorAll: (selector: string) => selector === "*"
        ? richNodes.map(node => materialize(node, copy))
        : tokens.filter(token => ![...removedNow].some(removed => removed.contains(token))) };
      // Form controls answer `matches` the way CSS attribute selectors would, so
      // the guard's real allowlist string decides admission, not the fixture.
      const controls = state.controls.length > 0
        ? state.controls
        : state.unknownButton ? [{ testid: state.unknownTestId }] : [];
      // P-035 2026-10-03 G3. A control may sit in a synthetic banner card whose
      // parent is the form. G3-B: `nested` puts the X one wrapper deeper inside
      // the card, and `contains` follows real `parentElement` links, so the
      // guard's outermost-ancestor walk is exercised. `holdsComposer` makes the
      // card contain the composer as well.
      interface SyntheticElement {
        tagName: string; parentElement: unknown; contains: (node: unknown) => boolean;
        closest: () => null; getAttribute: () => null; hasAttribute: () => boolean; getClientRects: () => object[];
      }
      // The parent is resolved lazily: the form is built after the controls.
      const syntheticElement = (tagName: string, parent: () => unknown, holdsComposer: boolean): SyntheticElement => {
        const element: SyntheticElement = {
          tagName, get parentElement() { return parent(); }, closest: () => null, getAttribute: () => null,
          hasAttribute: () => false, getClientRects: () => [{}],
          contains: (node: unknown) => {
            if (node === composer) return holdsComposer;
            for (let current = node as { parentElement?: unknown } | null; current;
              current = (current.parentElement ?? null) as { parentElement?: unknown } | null) {
              if (current === element) return true;
            }
            return false;
          },
        };
        return element;
      };
      const banners = new Map<string, { card: SyntheticElement; inner: SyntheticElement }>();
      const bannerFor = (id: string): { card: SyntheticElement; inner: SyntheticElement } => {
        let banner = banners.get(id);
        if (!banner) {
          const card = syntheticElement("DIV", () => form, !!state.banners?.[id]?.holdsComposer);
          banner = { card, inner: syntheticElement("DIV", () => card, false) };
          banners.set(id, banner);
        }
        return banner;
      };
      const controlElements = controls.map(control => ({
        closest: () => null,
        matches: (selector: string) => (control.tagName ?? "BUTTON") !== "BUTTON" ? false
          : (!!control.testid && selector.includes(`data-testid="${control.testid}"`))
            || (!!control.ariaLabel && selector.includes(`aria-label="${control.ariaLabel}"`)),
        getAttribute: (name: string) => name === "data-testid" ? (control.testid ?? "")
          : name === "aria-label" ? (control.ariaLabel ?? null) : null,
        tagName: control.tagName ?? "BUTTON",
        parentElement: control.banner === undefined ? null
          : control.ariaLabel === "Dismiss ChatGPT beacon banner" && state.banners?.[control.banner]?.nested
            ? bannerFor(control.banner).inner : bannerFor(control.banner).card,
      }));
      // G3-B: native Deep Research chip buttons in the form, outside the composer.
      const chipButtons = (state.drButtons ?? []).map(entry => {
        const button = {
          tagName: "BUTTON", textContent: entry.text, parentElement: null,
          closest: () => null, getAttribute: () => null,
          matches: (selector: string) => !!entry.pill && selector === PREFLIGHT_CHROME.deepResearchChipPill,
          contains: (node: unknown) => containsVia(button)(node),
        };
        if (entry.icon) chipIcons.push({ tagName: "IMG", parentElement: button });
        return button;
      });
      const foreignMedia = { tagName: "IMG", parentElement: null };
      const mediaFor = (selector: string): object[] =>
        [...(state.attachment ? [foreignMedia] : []), ...(selector === "img" ? chipIcons : [])];
      const form = {
        tagName: "FORM",
        getAttribute: () => null,
        hasAttribute: () => false,
        querySelector: (selector: string) => mediaFor(selector)[0] ?? null,
        // The shape line bounds its ancestor scan to the form, so the walk must
        // see every synthetic foreign ancestor as inside it.
        contains: () => true,
        // The banner's X answers its own selector the way CSS would; every other
        // query still sees every control, exactly as before.
        // G3-B: the chip-button selector sees the chip buttons, the control scan
        // sees every control and chip button, and any other query is a media one.
        querySelectorAll: (selector: string) => selector === PREFLIGHT_CHROME.beaconBannerDismiss
          ? controlElements.filter(element => element.tagName === "BUTTON"
            && element.getAttribute("aria-label") === "Dismiss ChatGPT beacon banner")
          : selector === PREFLIGHT_CHROME.deepResearchChipButton ? [...controlElements, ...chipButtons]
            : selector === 'button, [role="button"]' ? [...controlElements, ...chipButtons]
              : mediaFor(selector),
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
        closest: () => state.form ? form : null,
        // G3-B: the composer contains its own tokens, as a real DOM would.
        contains: inComposer,
        // r18: the placeholder scan reads attributes on the composer itself and
        // on its descendants, and only ever compares their trimmed values.
        getAttribute: (name: string) => (state.composerAttributes ?? [])
          .find(attribute => attribute.name === name)?.value ?? null,
        // r31: the ORIGINAL composer answers the two selectors the rich-attr
        // shape reads -- its outermost tokens and its inline-atom descendants --
        // while `*` still carries the r18 placeholder descendants the foreign
        // shape scans. The rich nodes double as the composer's own contents, so
        // an inline atom the clone holds is present in the original too.
        querySelectorAll: (selector: string) => {
          if (selector === '[contenteditable="false"]') return tokens;
          return [
            ...richNodes.map(node => materialize(node, composer)),
            ...(state.composerDescendants ?? []).map(attribute => ({
              getAttribute: (name: string) => name === attribute.name ? attribute.value : null,
            })),
          ];
        } };
      const document = {
        body: { childNodes: state.count ? [composer] : [] },
        querySelectorAll: (selector: string) => selector === 'input[type="file"]'
          ? [{ files: state.file ? [{}] : [] }] : Array.from({ length: state.count }, () => composer),
        // P-035 2026-09-28 r16. Models ONE text node outside the composer so a
        // test can prove the foreign-text walk still runs after admission. r17
        // gives it a real parent chain, so the refusal's shape line is proved.
        //
        // P-035 2026-10-03 G3-B. Banner text nodes (`state.bannerTexts`), each
        // inside its synthetic card, come first; the one foreign node after them.
        createTreeWalker: () => {
          const nodes: Array<{ textContent: string; parentElement: unknown }> = [
            ...(state.bannerTexts ?? []).map(entry => ({ textContent: entry.text, parentElement: bannerFor(entry.banner).card })),
            ...(state.foreignText ? [{ textContent: state.foreignText, parentElement: foreignParent }] : []),
          ];
          let index = -1;
          return {
            nextNode: () => { index += 1; return index < nodes.length; },
            get currentNode() { return nodes[index]; },
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
  /** G3-B: the token carries its own media icon (an `img` child). */
  icon?: boolean;
  /** G3-B (fourth run): the node carries the Deep Research pill data-id. */
  pill?: boolean;
  /** G3-B (fifth run): the node carries a bare `data-inline-selection-pill`. */
  selectionPill?: boolean;
  /** G3-B (fifth run): attributes the token shape reads (names, and five values). */
  attributes?: Array<{ name: string; value?: string }>;
  /** G3-B (fifth run): non-token wrappers around a ROOT token, nearest first. */
  wrappers?: TokenWrapper[];
}
/** G3-B (fifth run): one non-`[contenteditable="false"]` ancestor of a root token. */
interface TokenWrapper {
  tagName: string;
  attributes?: Array<{ name: string; value?: string }>;
  pill?: boolean;
  selectionPill?: boolean;
  /** Not inside the composer (the composer and its clone do not contain it). */
  outside?: boolean;
}
/** The token shape the guard reads: tag, text, parentElement and closest/remove. */
interface FixtureToken {
  tagName: string;
  textContent: string;
  parentElement: unknown;
  attributes: Array<{ name: string; value: string }>;
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => unknown;
  contains: (node: unknown) => boolean;
  remove: () => void;
  matches: (selector: string) => boolean;
  querySelector: (selector: string) => FixtureToken | null;
  /** Element children (the token nodes built below this one). */
  readonly children: FixtureToken[];
  readonly outerHTML: string;
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
  controls: Array<{ testid?: string; ariaLabel?: string; tagName?: string; banner?: string }>; url: string;
  rich?: RichNode[];
  /**
   * G3: synthetic banner cards by id; a control names its banner with `banner`.
   * G3-B: `nested` puts the dismiss X in a wrapper one level inside the card.
   */
  banners?: Record<string, { holdsComposer?: boolean; nested?: boolean }>;
  /** G3-B: native Deep Research chip buttons in the form, outside the composer. */
  drButtons?: Array<{ text: string; icon?: boolean; pill?: boolean }>;
  /** G3-B: text nodes directly inside a banner card, walked before `foreignText`. */
  bannerTexts?: Array<{ banner: string; text: string }>;
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

  it("admits pristine about:blank and completes an empty ordinary preflight without attaching the connector", async () => {
    const { page, state, session } = fixture({ url: "about:blank", count: 0 });
    goHome.mockImplementation(() => { state.url = "https://chatgpt.com/"; state.count = 1; state.mention = ""; });
    // r36: the ordinary preflight no longer attaches the connector, so the
    // owned-connector chip this case used to simulate never appears and the
    // result reports `connectorVerified: false`.
    await expect(runInteractionPreflight(options, session)).resolves.toMatchObject({ connectorVerified: false, power: 4 });
    // P-035 2026-09-28 r20. The protected navigation now also receives the
    // lane's configured connector, so its own home/surface guards admit the
    // lane's chip-only residue instead of refusing `connector_unowned`.
    expect(openConversation).toHaveBeenCalledWith(session.page, expect.any(Object), expect.any(Function), true, "fixture");
    expect(setConnector).not.toHaveBeenCalled();
    expect(page.keyboard.type).not.toHaveBeenCalled();
    expect(goHome).toHaveBeenCalledTimes(2);
  });

  it("only admits exact owned text or token, never extra text or attachments", async () => {
    const { state, page } = fixture({ text: "owned probe" });
    await expect(assertPreflightDraftSafe(page, { text: "owned probe" })).resolves.toBeUndefined();
    // P-035 2026-09-28 r25. This assertion used to require a refusal: the
    // comparison was whitespace-strict, so a single trailing space failed it.
    // Whitespace is now normalised on both sides, so trailing space is admitted;
    // any extra NON-whitespace character still refuses (the next assertion).
    state.text += " ";
    await expect(assertPreflightDraftSafe(page, { text: "owned probe" })).resolves.toBeUndefined();
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

  // P-035 2026-09-28 r31. Live evidence 05:54 (vendor e15e417, Intelli pid
  // 50146): provenance mode admitted the owned draft, then the final empty
  // check refused `rich_attr:data-composer-inline-atom-selected` ->
  // `draft_persisted`. The token branch ran BEFORE the rich-node loop and found
  // no token, so the refusing node is an inline atom, not an outermost
  // `[contenteditable="false"]` token. The reason string and admission are
  // unchanged; the refusal now carries one content-free shape line naming the
  // node and the composer it sat in, so the next live round says what survived
  // the clear without ever printing page text.
  it("names a rich-attribute refusal with a content-free shape of the node and composer", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { page } = fixture({ rich: [{
        tagName: "SPAN", attributes: [{ name: "data-composer-inline-atom-selected", value: "" }],
        textContent: "x",
      }] });
      const error = await assertPreflightDraftSafe(page).catch(error => error);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("rich_attr:data-composer-inline-atom-selected");
      const line = spy.mock.calls.map(call => String(call[0]))
        .find(candidate => candidate.includes("rich attr shape"));
      expect(line).toBe(
        "[cgpro:preflight] rich attr shape: tag=SPAN ce=- text_len=1 children=0 child_tags=- "
        + "composer_len=0 composer_words=0 tokens=0 atoms=1 equals_connector=n/a depth=1",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("reports the rich-attribute shape against the owned connector", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { page } = fixture({ rich: [{
        tagName: "SPAN", attributes: [{ name: "data-composer-inline-atom-selected", value: "" }],
        textContent: "x",
      }] });
      // The owned connector equals the refusing node's own trimmed text.
      const error = await assertPreflightDraftSafe(page, { connector: "x" }).catch(error => error);
      expect(error.reason).toBe("rich_attr:data-composer-inline-atom-selected");
      const line = spy.mock.calls.map(call => String(call[0]))
        .find(candidate => candidate.includes("rich attr shape"));
      expect(line).toContain("equals_connector=yes");

      // Without a connector the same node reads `n/a`.
      spy.mockClear();
      const bare = await assertPreflightDraftSafe(page).catch(error => error);
      expect(bare.reason).toBe("rich_attr:data-composer-inline-atom-selected");
      const bareLine = spy.mock.calls.map(call => String(call[0]))
        .find(candidate => candidate.includes("rich attr shape"));
      expect(bareLine).toContain("equals_connector=n/a");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports an empty inline atom as text_len=0 and composer_len=0", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { page } = fixture({ rich: [{
        tagName: "SPAN", attributes: [{ name: "data-composer-inline-atom-selected", value: "" }],
      }] });
      const error = await assertPreflightDraftSafe(page).catch(error => error);
      expect(error.reason).toBe("rich_attr:data-composer-inline-atom-selected");
      const line = spy.mock.calls.map(call => String(call[0]))
        .find(candidate => candidate.includes("rich attr shape"));
      expect(line).toContain("text_len=0");
      expect(line).toContain("composer_len=0");
    } finally {
      spy.mockRestore();
    }
  });

  it("never puts page text into the rich-attribute shape line", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { page } = fixture({
        text: "zorblequux",
        rich: [{
          tagName: "SPAN", attributes: [{ name: "data-composer-inline-atom-selected", value: "zorblequux" }],
          textContent: "zorblequux",
        }],
      });
      const error = await assertPreflightDraftSafe(page).catch(error => error);
      expect(error.reason).toBe("rich_attr:data-composer-inline-atom-selected");
      const line = spy.mock.calls.map(call => String(call[0]))
        .find(candidate => candidate.includes("rich attr shape"));
      expect(line).toContain("rich attr shape:");
      // The unique word appears in the node text and in the composer, so the
      // shape must name only counts: not the word, not any fragment of it.
      expect(line).not.toContain("zorblequux");
      expect(line).not.toContain("zorb");
      expect(error.message).not.toContain("zorblequux");
    } finally {
      spy.mockRestore();
    }
  });

  // P-035 2026-09-28 r24. ChatGPT tags each paragraph our automation pasted
  // with `data-prompt-literal-paste`, so an exact paste this call itself made
  // refused `rich_attr:data-prompt-literal-paste` before the text comparison
  // ran. That one attribute name is skipped ONLY under a combined exact-text
  // proof; the text comparison still decides admission, and every other
  // attribute -- and this attribute without owned text -- refuse unchanged.
  it("admits an exact owned paste carrying the paste marker, only while the owned text is in force", async () => {
    const pasted = (text: string) => fixture({
      mention: "fixture", text,
      rich: [{
        tagName: "P", attributes: [{ name: "data-prompt-literal-paste", value: "" }], textContent: text,
      }],
    });
    await expect(assertPreflightDraftSafe(pasted("owned probe").page, { connector: "fixture", text: "owned probe" }))
      .resolves.toBeUndefined();

    // One changed character in the owned text still refuses by the text check.
    const changed = await assertPreflightDraftSafe(
      pasted("owned probf").page, { connector: "fixture", text: "owned probe" },
    ).catch(error => error);
    expect(changed.reason).toBe("owned_text_mismatch");

    // Without an owned text the same DOM refuses the marker exactly as before.
    const unowned = await assertPreflightDraftSafe(
      pasted("owned probe").page, { connector: "fixture" }).catch(error => error);
    expect(unowned).toBeInstanceOf(PreflightDraftProtectedError);
    expect(unowned.reason).toBe("rich_attr:data-prompt-literal-paste");

    // A second attribute on the same marked node is still refused.
    const extra = await assertPreflightDraftSafe(fixture({
      mention: "fixture", text: "owned probe",
      rich: [{
        tagName: "P", attributes: [
          { name: "data-prompt-literal-paste", value: "" }, { name: "data-other", value: "" },
        ], textContent: "owned probe",
      }],
    }).page, { connector: "fixture", text: "owned probe" }).catch(error => error);
    expect(extra.reason).toBe("rich_attr:data-other");
  });

  // P-035 2026-09-28 r32. `clearComposer` presses `Meta+A` before `Backspace`,
  // and our own Select-All makes the editor mark every selected node with
  // `data-composer-inline-atom-selected`. Live ms (pid 43491, vendor 5b42230)
  // admitted the owned draft and then refused
  // `rich_attr:data-composer-inline-atom-selected` on a `tag=BR` node before
  // Backspace could run. That attribute is transient selection state our own
  // keystroke created, so it is skipped on exactly the r24 terms: only while a
  // combined text-or-provenance proof is in force, and never carrying a
  // neighbouring attribute past the check.
  it("admits our own Select-All marker on every node it covers, only while a combined proof is in force", async () => {
    const SELECTED = "data-composer-inline-atom-selected";
    // The live shape: a P holding the draft and a BR beside it, each carrying
    // the marker our Select-All added.
    const marked = (text: string) => fixture({
      mention: "fixture", text,
      rich: [
        { tagName: "P", attributes: [{ name: SELECTED, value: "" }], textContent: text },
        { tagName: "BR", attributes: [{ name: SELECTED, value: "" }] },
      ],
    });
    const HEADER = "planning system header v1\nlane=intelli facade=planning";
    const MARKER = "[cgpro:composed-invocation]";
    const proved = `${HEADER}\nUSER: the different planning request\n${MARKER}\ninvocation_id="0f8fad5b-d9cb-469f-a165-70867728950e"`;

    // Provenance proof: admitted, marker and all.
    await expect(assertPreflightDraftSafe(
      marked(proved).page, { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();

    // Owned exact-text proof: admitted too, and the text check still decides.
    await expect(assertPreflightDraftSafe(
      marked("owned probe").page, { connector: "fixture", text: "owned probe" },
    )).resolves.toBeUndefined();

    // With no owned proof at all the same node still refuses unchanged.
    const nobody = await assertPreflightDraftSafe(
      fixture({
        text: "owned probe",
        rich: [
          { tagName: "P", attributes: [{ name: SELECTED, value: "" }], textContent: "owned probe" },
          { tagName: "BR", attributes: [{ name: SELECTED, value: "" }] },
        ],
      }).page,
    ).catch(error => error);
    expect(nobody).toBeInstanceOf(PreflightDraftProtectedError);
    expect(nobody.reason).toBe(`rich_attr:${SELECTED}`);

    // With only the connector -- a chip but no proof of the draft -- the same
    // attribute refuses exactly as before.
    const chipOnly = await assertPreflightDraftSafe(
      marked("owned probe").page, { connector: "fixture" },
    ).catch(error => error);
    expect(chipOnly).toBeInstanceOf(PreflightDraftProtectedError);
    expect(chipOnly.reason).toBe(`rich_attr:${SELECTED}`);

    // A second attribute on the same marked node is still refused, and named.
    const extra = await assertPreflightDraftSafe(fixture({
      mention: "fixture", text: proved,
      rich: [{
        tagName: "P",
        attributes: [{ name: SELECTED, value: "" }, { name: "data-foo", value: "" }],
        textContent: proved,
      }],
    }).page, { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } }).catch(error => error);
    expect(extra).toBeInstanceOf(PreflightDraftProtectedError);
    expect(extra.reason).toBe("rich_attr:data-foo");
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

// P-035 2026-09-28 r36. Maik's decision 2026-09-28 09:32 SGT ("f"): the ordinary
// watchdog preflight stops at the model check and never attaches the connector.
// On 2026-09-28 the preflight's `setConnector(page, opts.connector, true)` typed
// `@` into ChatGPT's live composer, and a failed picker click left that `@`
// behind twice, blocking Intelli's health checks for over an hour (fixed as
// r33/r34). A real turn attaches the connector itself before submission
// (`runAsk`), so a broken picker still fails before anything is sent. The probe
// path keeps the connector phase unchanged: it exists to exercise exactly the
// controls a real turn would use. The lane-chip case below (criterion 1's last
// clause) is the r15 case further down, updated for the skipped phase.
describe("ordinary preflight stops before the connector (r36)", () => {
  it("never attaches the connector, never types @, still runs the model phase, and reports connectorVerified: false", async () => {
    const { page, state, session } = fixture({ url: "about:blank", count: 0 });
    goHome.mockImplementation(() => { state.url = "https://chatgpt.com/"; state.count = 1; state.mention = ""; });
    const phases: string[] = [];
    const result = await runInteractionPreflight(options, session, phase => phases.push(phase));
    expect(result).toMatchObject({ connectorVerified: false, power: 4 });
    // No connector phase, no attach, and no `@` typed into the live composer.
    expect(phases).not.toContain("connector");
    expect(setConnector).not.toHaveBeenCalled();
    expect(page.keyboard.type).not.toHaveBeenCalled();
    // The model phase still ran, after the composer step, so the run stopped at
    // the model check rather than short-circuiting.
    expect(phases).toContain("composer");
    expect(phases).toContain("model");
    expect(model).toHaveBeenCalledTimes(1);
    expect(clearComposer).toHaveBeenCalled();
  });

  it("still attaches the connector before the model phase on a probe preflight and reports connectorVerified: true", async () => {
    const { state, session } = fixture({ mention: "fixture" });
    setConnector.mockImplementation(() => { state.mention = "fixture"; });
    probe.mockResolvedValue({ requestedChars: 5, arrivedChars: 5, complete: true, deliveredBy: "paste" });
    const phases: string[] = [];
    const result = await runInteractionPreflight(
      { ...options, probePrompt: "probe" }, session, phase => phases.push(phase));
    expect(result).toMatchObject({ connectorVerified: true, power: 4 });
    // The connector phase ran, and the attach preceded the model phase.
    expect(phases).toContain("connector");
    expect(phases.indexOf("connector")).toBeLessThan(phases.indexOf("model"));
    expect(setConnector).toHaveBeenCalledWith(session.page, "fixture", true);
    expect(setConnector.mock.invocationCallOrder[0]).toBeLessThan(model.mock.invocationCallOrder[0]);
    expect(probe).toHaveBeenCalledTimes(1);
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
  // P-035 2026-10-03 G3. Raised from 20 s; five waits x 28 s fit the daemon's
  // 140 s preflight deadline.
  it("bounds each wait at 28 seconds", () => {
    expect(COMPOSER_HYDRATION_TIMEOUT_MS).toBe(28_000);
  });

  // P-035 2026-10-03 G3. Live ms1980 `timeline=slot-page:0+982,home:982+0`:
  // the FIRST guard judged a still-loading chatgpt.com page with no wait.
  it("waits for hydration before the first guard on a chatgpt.com page", async () => {
    const { state, session, composerWaits } = fixture({ count: 0 });
    state.composerHydrationMs = 30;
    await expect(runInteractionPreflight(options, session))
      .resolves.toMatchObject({ connectorVerified: false, power: 4 });
    // First guard, home and cleanup-home: three waits; the first ran before any
    // guard evaluation and saw no composer yet.
    expect(composerWaits).toHaveLength(3);
    expect(composerWaits[0].evaluationsAtStart).toBe(0);
    expect(composerWaits[0].countAtStart).toBe(0);
    expect(composerWaits[0].options).toEqual({ state: "visible", timeout: COMPOSER_HYDRATION_TIMEOUT_MS });
    expect(goHome).toHaveBeenCalledTimes(2);
  });

  it("still refuses the first guard after a never-hydrating chatgpt.com wait", async () => {
    const { state, session, composerWaits } = fixture({ count: 0 });
    state.composerNeverHydrates = true;
    const error = await runInteractionPreflight(options, session).catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("composer_count:0");
    expect(composerWaits).toHaveLength(1);
    expect(composerWaits[0].evaluationsAtStart).toBe(0);
    expect(goHome).not.toHaveBeenCalled();
  });

  it("does not wait before the first guard on about:blank", async () => {
    const { state, session, composerWaits } = fixture({ url: "about:blank", count: 0 });
    goHome.mockImplementation(() => { state.url = "https://chatgpt.com/"; state.count = 1; });
    await expect(runInteractionPreflight(options, session)).resolves.toMatchObject({ power: 4 });
    // Only the home and cleanup-home waits, both after the first guard ran.
    expect(composerWaits).toHaveLength(2);
    expect(composerWaits[0].evaluationsAtStart).toBeGreaterThan(0);
  });

  it("waits for the hydrated composer before the home guard, then proceeds past home", async () => {
    const { state, session, composerWaits } = fixture({ url: "about:blank", count: 0 });
    // goHome lands on chatgpt.com but the composer is NOT there yet, exactly as
    // the live pre-hydration shell was.
    goHome.mockImplementation(() => { state.url = "https://chatgpt.com/"; state.mention = ""; });
    state.composerHydrationMs = 30;
    await expect(runInteractionPreflight(options, session))
      .resolves.toMatchObject({ connectorVerified: false, power: 4 });
    // One bounded wait for the home navigation, against the shipped composer
    // selector, at the shipped bound. (r21 adds the same wait to the CLEANUP
    // navigation, so this successful preflight issues two in total; index 0 is
    // the home wait this case exists to pin.)
    expect(composerWaits).toHaveLength(2);
    expect(composerWaits[0].selector).toBe(joinSelectors(SELECTORS.composer));
    expect(composerWaits[0].options).toEqual({ state: "visible", timeout: COMPOSER_HYDRATION_TIMEOUT_MS });
    // The composer was absent when the wait began and appeared only inside it,
    // so the guard that admitted the home phase ran after the wait.
    expect(composerWaits[0].countAtStart).toBe(0);
    expect(state.count).toBe(1);
    // Past `home`: the rest of the preflight ran against the hydrated page.
    expect(openConversation).toHaveBeenCalledTimes(1);
    // r36: the ordinary preflight stops at the model check, so no connector
    // attach happens; the model phase still ran.
    expect(setConnector).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledTimes(1);
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
    expect(composerWaits[0].options).toEqual({ state: "visible", timeout: COMPOSER_HYDRATION_TIMEOUT_MS });
    expect(composerWaits[0].countAtStart).toBe(0);
    // Nothing past the home phase ran, and the refusal happened once goHome had run.
    expect(goHome).toHaveBeenCalledTimes(1);
    expect(openConversation).not.toHaveBeenCalled();
    expect(setConnector).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
  });
});

// P-035 2026-09-28 r25. Live vendor 740db47 (Intelli daemon pid 40642): the one
// approved POST /discard-owned-draft call passed token identity and attributes,
// then refused `owned_text_mismatch` on the exact 908-char multi-line prompt it
// had itself pasted, because the comparison was whitespace-strict and Chrome's
// `innerText` renders paragraph breaks differently from the source newlines. The
// owned-text comparison now normalises whitespace on BOTH sides -- every
// non-whitespace character still decides -- and the refusal carries one
// content-free shape line. These cases pin the new proof and the shape.
describe("whitespace-insensitive owned-text proof (r25)", () => {
  const shapeLineOf = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls
    .map(call => String(call[0])).find(line => line.includes("owned text shape"));

  it("admits owned text whose rendered breaks or line-trailing spaces differ from the source", async () => {
    // One source newline between paragraphs, rendered by `innerText` as two.
    const doubled = "line one\n\nline two\n\nline three";
    await expect(assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: doubled }).page,
      { connector: "fixture", text: "line one\nline two\nline three" },
    )).resolves.toBeUndefined();

    // The same source lines, each rendered with a trailing space.
    const spaced = "line one \nline two \nline three ";
    await expect(assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: spaced }).page,
      { connector: "fixture", text: "line one\nline two\nline three" },
    )).resolves.toBeUndefined();

    // The no-token branch normalises the same way.
    await expect(assertPreflightDraftSafe(
      fixture({ text: "multi\n\nline text" }).page,
      { text: "multi\nline text" },
    )).resolves.toBeUndefined();
  });

  it("still refuses one extra non-whitespace character and logs the shape line", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({ mention: "fixture", text: "owned probf" }).page,
        { connector: "fixture", text: "owned probe" },
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("owned_text_mismatch");
      // Both sides normalise to eleven characters that agree up to the tenth.
      expect(shapeLineOf(spy)).toBe(
        "[cgpro:preflight] owned text shape: have_len=11 want_len=11 common_prefix=10",
      );
      // Exactly one shape line, and it never carries the refused text.
      expect(spy.mock.calls.map(call => String(call[0]))
        .filter(line => line.includes("owned text shape"))).toHaveLength(1);
      expect(shapeLineOf(spy)).not.toContain("owned prob");
      expect(JSON.stringify(error)).not.toContain("owned prob");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses an extra character across a rendered newline and counts the normalised prefix", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The rendered remainder equals the owned text except for one extra `X`
      // after the second paragraph. Normalising whitespace makes both single
      // spaced, and the common prefix is the ten characters before `X`.
      const error = await assertPreflightDraftSafe(
        fixture({ mention: "fixture", text: "alpha\n\nbetaX" }).page,
        { connector: "fixture", text: "alpha\nbeta" },
      ).catch(caught => caught);
      expect(error.reason).toBe("owned_text_mismatch");
      expect(shapeLineOf(spy)).toBe(
        "[cgpro:preflight] owned text shape: have_len=11 want_len=10 common_prefix=10",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("names a wholly different remainder with a zero-length common prefix", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({ mention: "fixture", text: "zzz" }).page,
        { connector: "fixture", text: "owned probe" },
      ).catch(caught => caught);
      expect(error.reason).toBe("owned_text_mismatch");
      expect(shapeLineOf(spy)).toBe(
        "[cgpro:preflight] owned text shape: have_len=3 want_len=11 common_prefix=0",
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// P-035 2026-09-28 r21. Live ms1980 (vendor 57d8588, lane ms1980, pid 90325):
// the preflight passed account, Project, composer, connector and model, then
// refused `reason=composer_count:0` at `failedPhase=cleanup-home` on the
// pre-hydration home shell its own cleanup `goHome` had just landed on. The r11
// race, one navigation later: the cleanup guard judges a just-navigated surface
// exactly as the home guard does, so it needs the same bounded wait first.
describe("cleanup-home composer hydration wait", () => {
  it("waits for the cleanup home composer to hydrate before the cleanup guard, then resolves", async () => {
    const { state, session, composerWaits } = fixture({ url: "about:blank", count: 0 });
    // The home navigation lands hydrated; the CLEANUP navigation lands on the
    // pre-hydration shell and the composer appears only inside the wait.
    goHome
      .mockImplementationOnce(() => { state.url = "https://chatgpt.com/"; state.mention = ""; state.count = 1; })
      .mockImplementationOnce(() => {
        state.url = "https://chatgpt.com/"; state.mention = ""; state.count = 0; state.composerHydrationMs = 30;
      });
    // Without the cleanup wait the cleanup guard would read `count:0` and refuse,
    // so resolving successfully is itself the proof the guard ran after hydration.
    // r36: the ordinary preflight skips the connector phase, so no attach sets a
    // chip here; it reports `connectorVerified: false`.
    await expect(runInteractionPreflight(options, session))
      .resolves.toMatchObject({ connectorVerified: false, power: 4 });
    expect(goHome).toHaveBeenCalledTimes(2);
    // A second bounded wait, against the shipped composer selector, at the shipped bound.
    expect(composerWaits).toHaveLength(2);
    expect(composerWaits[1].selector).toBe(joinSelectors(SELECTORS.composer));
    expect(composerWaits[1].options).toEqual({ state: "visible", timeout: COMPOSER_HYDRATION_TIMEOUT_MS });
    // It began on the pre-hydration shell and the composer arrived inside it.
    expect(composerWaits[1].countAtStart).toBe(0);
    expect(state.count).toBe(1);
  });

  it("swallows the cleanup wait's own timeout and refuses composer_count:0 exactly as today", async () => {
    const { state, session, composerWaits } = fixture({ url: "about:blank", count: 0 });
    goHome
      .mockImplementationOnce(() => { state.url = "https://chatgpt.com/"; state.mention = ""; state.count = 1; })
      .mockImplementationOnce(() => {
        state.url = "https://chatgpt.com/"; state.mention = ""; state.count = 0; state.composerNeverHydrates = true;
      });
    setConnector.mockImplementation(() => { state.mention = "fixture"; });
    const phases: string[] = [];
    const error = await runInteractionPreflight(options, session, phase => phases.push(phase)).catch(caught => caught);
    // The wait is not an error: the guard, not the wait, refused, with the
    // unchanged error, code and reason, at the unchanged phase.
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.code).toBe("preflight_draft_protected");
    expect(error.reason).toBe("composer_count:0");
    expect(phases.at(-1)).toBe("cleanup-home");
    expect(composerWaits).toHaveLength(2);
    expect(composerWaits[1].selector).toBe(joinSelectors(SELECTORS.composer));
    expect(composerWaits[1].options).toEqual({ state: "visible", timeout: COMPOSER_HYDRATION_TIMEOUT_MS });
    expect(composerWaits[1].countAtStart).toBe(0);
    // Both navigations happened (the cleanup one refused), and the phase that
    // follows cleanup-home -- its own clearComposer -- never ran. The one main-flow
    // clearComposer call is unchanged.
    expect(goHome).toHaveBeenCalledTimes(2);
    expect(clearComposer).toHaveBeenCalledTimes(1);
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

  it("still admits and clears the composer's lone lane-owned chip through the composer step", async () => {
    const { state, session } = fixture({ mention: "lane-x" });
    // The chip is present on the home composer from the first read -- exactly
    // the residue the live lane held. r36: the ordinary preflight no longer
    // attaches the connector, so the chip is not replaced by `setConnector`;
    // it stays admitted (configured, not owned) through every guard, and the
    // composer step's Meta+A + Backspace (mocked by `clearComposer`) is what
    // clears it.
    expect(state.mention).toBe("lane-x");
    const phases: string[] = [];
    await expect(runInteractionPreflight(laneOptions, session, phase => phases.push(phase)))
      .resolves.toMatchObject({ connectorVerified: false, power: 4 });
    // Both pre-attach guards admitted it: the preflight recorded `home` and then
    // crossed into `login`, so it proceeded past the phase that used to refuse.
    expect(phases[0]).toBe("home");
    expect(phases).toContain("login");
    // It crossed the composer phase, where the composer step's clear ran.
    expect(phases).toContain("composer");
    expect(clearComposer).toHaveBeenCalled();
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(setConnector).not.toHaveBeenCalled();
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
      // The refused text itself never appears. r29 appends the six header
      // fields; with no provenance proof in force every one of them is `n/a`.
      expect(shapeLineOf(spy)).toBe(
        "[cgpro:preflight] foreign text shape: tag=DIV role=- testid=- hidden=no len=1 "
        + "equals_connector=no contains_connector=no equals_placeholder=none "
        + "equals_composer_text=no words=1 path=DIV labels=0 "
        + "contains_prefix=n/a contains_marker=n/a contains_text=n/a "
        + "header_at=n/a header_run=n/a have_char=n/a want_char=n/a "
        + "alnum_contains=n/a alnum_header_at=n/a",
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

// P-035 2026-09-28 r26. Maik approved (option f) clearing the Intelli lane's
// stranded draft ONCE when it is proven to be text our planning facade composed:
// the lane's own connector chip, the facade's full planning system header, and
// the hidden invocation marker plus one `invocation_id="<uuid>"`. The live
// refusal `have_len=2982 want_len=906 common_prefix=354` showed the draft is
// exactly that header followed by a DIFFERENT planning request, so the text can
// never match: provenance mode proves the composed shape without naming the
// text. These cases pin the new admission and every neighbouring refusal.
describe("composed-draft provenance proof (r26)", () => {
  const HEADER = "planning system header v1\nlane=intelli facade=planning";
  const MARKER = "[cgpro:composed-invocation]";
  const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const composed = (request = "the different planning request"): string =>
    `${HEADER}\nUSER: ${request}\n${MARKER}\ninvocation_id="${UUID}"`;

  it("admits the owned chip plus the full planning header, an arbitrary request, the marker and an invocation id", async () => {
    await expect(assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: composed() }).page,
      { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();

    // The request after the header is NOT this call's text and is never named:
    // any request admits, which is exactly what exact-text mode cannot do.
    await expect(assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: composed("a completely different ask") }).page,
      { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();

    // The header comparison normalises whitespace on both sides, like r25.
    await expect(assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: `planning system header v1\n\nlane=intelli   facade=planning\nUSER: x\n${MARKER} invocation_id="${UUID}"` }).page,
      { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();
  });

  it("refuses a missing marker as provenance_mismatch and names the failing condition", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = `${HEADER}\nUSER: the different planning request\ninvocation_id="${UUID}"`;
      const error = await assertPreflightDraftSafe(
        fixture({ mention: "fixture", text: body }).page,
        { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("provenance_mismatch");
      const shape = spy.mock.calls.map(call => String(call[0]))
        .find(line => line.includes("provenance shape"));
      expect(shape).toContain("provenance shape: prefix=yes marker=no invocation=yes len=");
      // Exactly one shape line, and it never carries any character of the draft.
      expect(spy.mock.calls.map(call => String(call[0]))
        .filter(line => line.includes("provenance shape"))).toHaveLength(1);
      expect(shape).not.toContain("the different planning request");
      expect(JSON.stringify(error)).not.toContain("planning");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a header with one changed word as prefix=no", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const changed = `${HEADER.replace("v1", "v2")}\nUSER: x\n${MARKER}\ninvocation_id="${UUID}"`;
      const error = await assertPreflightDraftSafe(
        fixture({ mention: "fixture", text: changed }).page,
        { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error.reason).toBe("provenance_mismatch");
      const shape = spy.mock.calls.map(call => String(call[0]))
        .find(line => line.includes("provenance shape"));
      expect(shape).toContain("prefix=no");
      expect(shape).toContain("marker=yes");
      expect(shape).toContain("invocation=yes");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a draft with no invocation id as invocation=no", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const noId = `${HEADER}\nUSER: x\n${MARKER}`;
      const error = await assertPreflightDraftSafe(
        fixture({ mention: "fixture", text: noId }).page,
        { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error.reason).toBe("provenance_mismatch");
      const shape = spy.mock.calls.map(call => String(call[0]))
        .find(line => line.includes("provenance shape"));
      expect(shape).toContain("prefix=yes");
      expect(shape).toContain("marker=yes");
      expect(shape).toContain("invocation=no");

      spy.mockClear();
      // A malformed invocation id (not a 36-character uuid) is the same refusal.
      const shortId = `${HEADER}\nUSER: x\n${MARKER}\ninvocation_id="not-a-uuid"`;
      const second = await assertPreflightDraftSafe(
        fixture({ mention: "fixture", text: shortId }).page,
        { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(second.reason).toBe("provenance_mismatch");
      expect(spy.mock.calls.map(call => String(call[0]))
        .find(line => line.includes("provenance shape"))).toContain("invocation=no");
    } finally {
      spy.mockRestore();
    }
  });

  // P-035 2026-10-08. Live personal and strengths: a late-landing connector
  // click plus its retry left two copies of the lane's own chip. Repeated
  // copies admit ONLY under this proof, and only when every copy is ours.
  it("admits repeated copies of the owned chip under the provenance proof and removes them all", async () => {
    const twice = fixture({ mentions: ["fixture", "fixture"], text: composed() });
    await expect(assertPreflightDraftSafe(
      twice.page, { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();
    expect(twice.removedTokens).toHaveLength(2);
  });

  it("refuses repeated owned chips when the marker is missing, or when one copy is another chip", async () => {
    const noMarker = await assertPreflightDraftSafe(
      fixture({ mentions: ["fixture", "fixture"], text: composed().replace(MARKER, "") }).page,
      { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
    ).catch(caught => caught);
    expect(noMarker).toBeInstanceOf(PreflightDraftProtectedError);
    expect(noMarker.reason).toBe("provenance_mismatch");

    const mixed = await assertPreflightDraftSafe(
      fixture({ mentions: ["fixture", "some-other-connector"], text: composed() }).page,
      { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
    ).catch(caught => caught);
    expect(mixed).toBeInstanceOf(PreflightDraftProtectedError);
    expect(mixed.reason).toBe("connector_token_text");
  });

  // P-035 2026-10-08. Live personal and strengths: the restored draft held an
  // empty `<div contenteditable="false">` beside the lane's own chip. Under the
  // provenance proof only, exactly that inert node is ignored and reported.
  describe("an inert empty contenteditable=false node (P-035 2026-10-08)", () => {
    const CE = { name: "contenteditable", value: "false" };
    const chip: TokenNode = { tagName: "SPAN", textContent: "fixture" };
    const proof = { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } };

    it("is ignored beside the owned chip under the provenance proof, and its outerHTML returned", async () => {
      const test = fixture({ tokenTree: [chip, { tagName: "DIV", attributes: [CE] }], text: composed() });
      await expect(assertPreflightDraftSafe(test.page, proof))
        .resolves.toEqual({ inertTokenHtml: '<div contenteditable="false"></div>' });
      expect(test.removedTokens.map(token => token.tagName)).toEqual(["DIV", "SPAN"]);
    });

    it("still refuses when the node carries text", async () => {
      const error = await assertPreflightDraftSafe(
        fixture({ tokenTree: [chip, { tagName: "DIV", attributes: [CE], textContent: "x" }], text: composed() }).page,
        proof,
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("connector_token_text");
    });

    it("still refuses when the node carries another attribute or a child element", async () => {
      const extraAttribute = await assertPreflightDraftSafe(
        fixture({ tokenTree: [chip, { tagName: "DIV", attributes: [CE, { name: "class", value: "c" }] }], text: composed() }).page,
        proof,
      ).catch(caught => caught);
      expect(extraAttribute.reason).toBe("connector_token_text");

      const withChild = await assertPreflightDraftSafe(
        fixture({ tokenTree: [chip, { tagName: "DIV", attributes: [CE], children: [{ tagName: "SPAN" }] }], text: composed() }).page,
        proof,
      ).catch(caught => caught);
      expect(withChild.reason).toBe("connector_token_text");
    });

    it("is never ignored without the provenance proof", async () => {
      const error = await assertPreflightDraftSafe(
        fixture({ tokenTree: [chip, { tagName: "DIV", attributes: [CE] }] }).page, { connector: "fixture" },
      ).catch(caught => caught);
      expect(error.reason).toBe("connector_token_count:2");
    });
  });

  it("still refuses a differently named chip as connector_token_text", async () => {
    const error = await assertPreflightDraftSafe(
      fixture({ mention: "some-other-connector", text: composed() }).page,
      { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
    ).catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("connector_token_text");
  });

  it("never admits text without an owned token, and refuses it as text_present", async () => {
    // No chip at all: provenance names a shape, not a licence to clear text.
    const error = await assertPreflightDraftSafe(
      fixture({ text: composed() }).page,
      { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } },
    ).catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("text_present");
    expect(JSON.stringify(error)).not.toContain("planning request");
  });

  it("applies the Expand and paste-marker exemptions under the provenance proof", async () => {
    // The provenance proof is a combined proof like the owned text, so the
    // long-draft expander and the paste marker are chrome over content this
    // call introduced.
    const { page } = fixture({
      mention: "fixture", text: composed(),
      controls: [{ ariaLabel: "Expand" }],
      rich: [{
        tagName: "P", attributes: [{ name: "data-prompt-literal-paste", value: "" }], textContent: composed(),
      }],
    });
    await expect(assertPreflightDraftSafe(page, { connector: "fixture", provenance: { prefix: HEADER, marker: MARKER } }))
      .resolves.toBeUndefined();

    // Without the provenance proof both still refuse exactly as before.
    const noProof = await assertPreflightDraftSafe(
      fixture({ mention: "fixture", text: composed(), controls: [{ ariaLabel: "Expand" }] }).page,
      { connector: "fixture" },
    ).catch(caught => caught);
    expect(noProof.reason).toBe("unknown_control:Expand");
  });
});

// P-035 2026-09-28 r27. The live refusal at vendor bad524b: chip identity and the
// provenance proof both passed, then the foreign-text walk refused `foreign_text`
// on a hidden SPAN holding the WHOLE serialised draft (connector + header +
// request + marker, 3141 chars, 435 words). r19 admits only a whitespace-free
// single token, which is what that mirror is for a chip-only composer; with a
// text draft it mirrors the proven draft instead. These cases prove the node is
// admitted exactly while it provably mirrors the proof already in force, and
// that every neighbouring shape still refuses `foreign_text`.
describe("hidden mirror of the proven draft (r27)", () => {
  const CONNECTOR = "fixture";
  const TEXT = "the planning prompt this lane typed";
  const HEADER = "planning system header v1\nlane=intelli facade=planning";
  const MARKER = "[cgpro:composed-invocation]";
  const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const composed = (request = "the different planning request"): string =>
    `${HEADER}\nUSER: ${request}\n${MARKER}\ninvocation_id="${UUID}"`;
  const mirrorOf = (body: string) => ({ foreignText: body, foreignParent: { tagName: "SPAN", ariaHidden: true } });
  const reasonOf = async (page: Page, owned: { text?: string; connector?: string;
    provenance?: { prefix: string; marker: string } }) =>
    (await assertPreflightDraftSafe(page, owned).then(() => undefined).catch(caught => caught))?.reason;

  it("admits a hidden span holding the whole serialised composed draft", async () => {
    // The composer holds this call's own chip followed by the composed draft;
    // the hidden span mirrors that whole serialisation, connector included.
    await expect(assertPreflightDraftSafe(
      fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(`${CONNECTOR} ${composed()}`) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();

    // The aria-hidden ancestor need not be the direct parent.
    await expect(assertPreflightDraftSafe(
      fixture({
        mention: CONNECTOR, text: composed(),
        foreignText: `${CONNECTOR} ${composed()}`,
        foreignParent: { tagName: "SPAN" },
        foreignAncestors: [{ tagName: "DIV", ariaHidden: true }],
      }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();
  });

  it("refuses the same hidden serialised mirror when the marker is missing", async () => {
    const withoutMarker = `${HEADER}\nUSER: the different planning request\ninvocation_id="${UUID}"`;
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(`${CONNECTOR} ${withoutMarker}`) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).toBe("foreign_text");
  });

  it("refuses a visible serialised copy and one hidden without the owned connector", async () => {
    // Visible (not aria-hidden): the mirror rule needs the aria-hidden ancestor.
    expect(await reasonOf(
      fixture({
        mention: CONNECTOR, text: composed(),
        foreignText: `${CONNECTOR} ${composed()}`,
        foreignParent: { tagName: "SPAN", rects: 1 },
      }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).toBe("foreign_text");

    // Hidden, but the serialisation does not carry this call's connector.
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(`other ${composed()}`) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).toBe("foreign_text");
  });

  it("refuses the hidden serialised mirror when no owned proof is in force", async () => {
    // Chip-only composer and the mirror present, but this call named neither an
    // owned text nor a provenance triple: the r19 rule needs a whitespace-free
    // token and the new rule needs an owned proof, so nothing admits it.
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, ...mirrorOf(`${CONNECTOR} ${composed()}`) }).page,
      { connector: CONNECTOR },
    )).toBe("foreign_text");
  });

  it("admits a hidden mirror carrying the connector and the full owned text", async () => {
    await expect(assertPreflightDraftSafe(
      fixture({ mention: CONNECTOR, text: TEXT, ...mirrorOf(`${CONNECTOR} ${TEXT}`) }).page,
      { connector: CONNECTOR, text: TEXT },
    )).resolves.toBeUndefined();
  });

  it("admits a mirror with extra non-whitespace content only because it includes the FULL owned text", async () => {
    // Substring inclusion decides: extra content beside the owned text is
    // forgiven when every character of the owned text is still present, in
    // order, in the mirror.
    await expect(assertPreflightDraftSafe(
      fixture({ mention: CONNECTOR, text: TEXT, ...mirrorOf(`${CONNECTOR} ${TEXT} and a stranger's aside`) }).page,
      { connector: CONNECTOR, text: TEXT },
    )).resolves.toBeUndefined();
  });

  it("refuses a mirror that is missing part of the owned text", async () => {
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, text: TEXT, ...mirrorOf(`${CONNECTOR} the planning prompt this lane`) }).page,
      { connector: CONNECTOR, text: TEXT },
    )).toBe("foreign_text");
  });
});

// P-035 2026-09-28 r28. The live refusal at vendor 26cb6e0: chip identity and
// the provenance proof both passed, then the foreign-text walk refused
// `foreign_text` on a hidden span holding a Markdown/HTML SERIALISATION of the
// whole draft (3141 chars, 435 words). A serialisation escapes the characters
// the composer renders literally -- backslash escapes (`\-`, `\*`, `\_`) and
// HTML entities (`&lt;`, `&gt;`, `&amp;`, ...) -- so the r27 substring
// comparison saw a different string. These cases prove the mirror is unescaped
// before it is judged, that the shape line now names which part of the proof
// failed, and that unescaping admits nothing the proof did not already name.
describe("Markdown-escaped hidden mirror of the proven draft (r28)", () => {
  const CONNECTOR = "fixture";
  const OWNED = "the planning prompt with * emphasis and _underscore_";
  const HEADER = "planning system header v1\nlane=intelli facade=planning";
  const MARKER = "<!-- CGPRO-PLANNING-INVOCATION-V1 -->";
  const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const composed = (request = "the different planning request"): string =>
    `${HEADER}\nUSER: ${request}\n${MARKER}\ninvocation_id="${UUID}"`;
  // A hand-written Markdown/HTML serialisation of the composed draft: the
  // header's `=` and the marker's characters arrive escaped, exactly the motifs
  // the r28 vendor live refusal carried.
  const escapedComposed = (request = "the different planning request"): string =>
    `${CONNECTOR} planning system header v1\n`
    + `lane\\=intelli facade\\=planning\n`
    + `USER: ${request}\n`
    + `&lt;\\!-- CGPRO-PLANNING-INVOCATION-V1 --&gt;\n`
    + `invocation_id\\="${UUID}"`;
  const escapedOwned = (): string => OWNED.replace(/([*_])/g, "\\$1");
  const mirrorOf = (body: string, ariaHidden = true) =>
    ({ foreignText: body, foreignParent: { tagName: "SPAN", ariaHidden } });
  const shapeLineOf = (spy: { mock: { calls: unknown[][] } }): string =>
    spy.mock.calls.map(call => String(call[0])).find(line => line.includes("foreign text shape")) ?? "";
  const reasonOf = async (page: Page, owned: { text?: string; connector?: string;
    provenance?: { prefix: string; marker: string } }) =>
    (await assertPreflightDraftSafe(page, owned).then(() => undefined).catch(caught => caught))?.reason;

  it("admits a hidden span holding the Markdown-escaped whole serialised draft", async () => {
    await expect(assertPreflightDraftSafe(
      fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(escapedComposed()) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();

    // The aria-hidden ancestor need not be the direct parent.
    await expect(assertPreflightDraftSafe(
      fixture({
        mention: CONNECTOR, text: composed(),
        foreignText: escapedComposed(),
        foreignParent: { tagName: "SPAN" },
        foreignAncestors: [{ tagName: "DIV", ariaHidden: true }],
      }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();
  });

  it("admits an escaped mirror of the owned text, and needs every proven part", async () => {
    // The whole owned text is present (escaped), so the extra non-escaped word
    // beside it does not matter: every proven part is still required, and all of
    // them are there.
    await expect(assertPreflightDraftSafe(
      fixture({ mention: CONNECTOR, text: OWNED,
        ...mirrorOf(`${CONNECTOR} ${escapedOwned()} and a stranger\\'s aside`) }).page,
      { connector: CONNECTOR, text: OWNED },
    )).resolves.toBeUndefined();

    // One proven part missing: the escaped mirror refuses.
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, text: OWNED,
        ...mirrorOf(`${CONNECTOR} the planning prompt with \\* emphasis`) }).page,
      { connector: CONNECTOR, text: OWNED },
    )).toBe("foreign_text");
  });

  it("refuses an escaped mirror that differs by a real word as contains_prefix=no", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const changed = escapedComposed().replace("planning system header v1", "planning system header changed");
      const error = await assertPreflightDraftSafe(
        fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(changed) }).page,
        { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("foreign_text");
      const line = shapeLineOf(spy);
      expect(line).toContain("contains_prefix=no");
      expect(line).toContain("contains_marker=yes");
      expect(line).toContain("contains_text=n/a");
      // Content-free: neither the refused mirror nor the proof text appears.
      expect(line).not.toContain("planning system header changed");
      expect(line).not.toContain(MARKER);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses an escaped mirror without the marker as contains_marker=no", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const noMarker = `${CONNECTOR} planning system header v1\nlane\\=intelli facade\\=planning\n`
        + `USER: the different planning request\ninvocation_id\\="${UUID}"`;
      const error = await assertPreflightDraftSafe(
        fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(noMarker) }).page,
        { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error.reason).toBe("foreign_text");
      const line = shapeLineOf(spy);
      expect(line).toContain("contains_prefix=yes");
      expect(line).toContain("contains_marker=no");
      expect(line).toContain("contains_text=n/a");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not decode an entity twice, and names contains_text for the text proof", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // `&amp;lt;` is a single-escaped ampersand, so it decodes to `&lt;`, never
      // to `<`: the marker does not appear and the mirror refuses.
      const doubleEscaped = `${CONNECTOR} planning system header v1\nlane\\=intelli facade\\=planning\n`
        + `USER: the different planning request\n&amp;lt;\!\\-\\- CGPRO-PLANNING-INVOCATION-V1 \\-\\-&amp;gt;\n`
        + `invocation_id\\="${UUID}"`;
      const error = await assertPreflightDraftSafe(
        fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(doubleEscaped) }).page,
        { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error.reason).toBe("foreign_text");
      const line = shapeLineOf(spy);
      expect(line).toContain("contains_prefix=yes");
      expect(line).toContain("contains_marker=no");

      spy.mockClear();
      // Text mode: a refused escaped mirror names the exact-text comparison.
      await assertPreflightDraftSafe(
        fixture({ mention: CONNECTOR, text: OWNED, ...mirrorOf(`${CONNECTOR} a wholly different draft`) }).page,
        { connector: CONNECTOR, text: OWNED },
      ).catch(caught => caught);
      const textLine = shapeLineOf(spy);
      expect(textLine).toContain("contains_text=no");
      expect(textLine).toContain("contains_prefix=n/a");
      expect(textLine).toContain("contains_marker=n/a");
    } finally {
      spy.mockRestore();
    }
  });

  it("still refuses a visible escaped copy and one with no owned proof", async () => {
    // Visible (not aria-hidden): the mirror rule needs the aria-hidden ancestor.
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(escapedComposed(), false) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).toBe("foreign_text");

    // Hidden, but this call named neither an owned text nor a provenance triple.
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, ...mirrorOf(escapedComposed()) }).page,
      { connector: CONNECTOR },
    )).toBe("foreign_text");
  });
});

// P-035 2026-09-28 r29. Live evidence 05:26 (vendor b95141e, Intelli pid 74466):
// the single provenance discard passed the full proof on the VISIBLE composer,
// yet the hidden mirror (`tag=SPAN hidden=aria len=3141 path=SPAN<FORM`) still
// reported `contains_connector=yes contains_marker=yes contains_prefix=no` even
// after r28 unescaped it. The header is present in words but not as a literal
// substring, so the planner needs to know exactly how it differs inside the
// mirror without a character of it: where the header sits, how far it agrees,
// the CLASS of the first divergence, and the same question with every
// non-letter and non-digit removed. These cases prove each new field.
//
// r30 note: the two cases below whose mirror carries a punctuation-only header
// divergence AND the whole proof (marker included) are now ADMITTED by the
// r30 mirror rule, so they can no longer reach the shape line. They are kept
// here as refusing cases by dropping exactly one proven part (the marker, then
// a header word), which still exercises every r29 field.
describe("hidden-mirror header divergence shape (r29)", () => {
  const CONNECTOR = "fixture";
  const MARKER = "<!-- CGPRO-PLANNING-INVOCATION-V1 -->";
  const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  // A header whose Markdown list item sits beyond character 40, so the first-40
  // anchor is present inside a starred mirror even though the full header is not.
  const HEADER = "planning system header v1 lane=intelli facade=planning - item one";
  const composed = (header = HEADER, request = "the different planning request"): string =>
    `${header}\nUSER: ${request}\n${MARKER}\ninvocation_id="${UUID}"`;
  const mirrorOf = (body: string) =>
    ({ foreignText: body, foreignParent: { tagName: "SPAN", ariaHidden: true } });
  const shapeLineOf = (spy: { mock: { calls: unknown[][] } }): string =>
    spy.mock.calls.map(call => String(call[0])).find(line => line.includes("foreign text shape")) ?? "";
  const headerAtOf = (line: string): number => Number(/header_at=(-?\d+)/.exec(line)?.[1]);

  it("names a Markdown list star rendered for the header's hyphen as have_char=P:2a want_char=P:2d", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The composer holds the header with a Markdown hyphen; the hidden mirror
      // serialises that same list item with a star, so the header is present in
      // words but not as a literal substring. r30 admits that shape while the
      // whole proof holds, so this mirror omits the marker and still refuses --
      // which is what keeps the r29 shape line reporting the divergence.
      const starredNoMarker = `${HEADER.replace(" - item one", " * item one")}\n`
        + `USER: the different planning request\ninvocation_id="${UUID}"`;
      const error = await assertPreflightDraftSafe(
        fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(`${CONNECTOR} ${starredNoMarker}`) }).page,
        { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("foreign_text");
      const line = shapeLineOf(spy);
      expect(line).toContain("contains_prefix=no");
      expect(line).toContain("contains_marker=no");
      expect(line).toContain("alnum_contains=yes");
      expect(line).toContain("have_char=P:2a");
      expect(line).toContain("want_char=P:2d");
      expect(headerAtOf(line)).toBeGreaterThan(0);
      expect(line).toContain("header_run=55");
      // Content-free: neither the header word nor a character of the page text.
      expect(line).not.toContain("item");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports alnum_contains=no when the mirror's header changes a word", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const changed = composed(HEADER.replace("planning system header v1", "planning system header changed"));
      const error = await assertPreflightDraftSafe(
        fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(`${CONNECTOR} ${changed}`) }).page,
        { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error.reason).toBe("foreign_text");
      const line = shapeLineOf(spy);
      expect(line).toContain("contains_prefix=no");
      expect(line).toContain("alnum_contains=no");
      expect(line).toContain("contains_marker=yes");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports header_at>0 when the mirror starts with extra wrapper text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The header's first 40 characters sit AFTER the wrapper, so the anchor is
      // found at a positive index. The header changes a word BEYOND that anchor,
      // so it matches neither literally nor by letters and digits and refuses.
      const changedTail = composed(HEADER.replace("item one", "item changed"));
      const error = await assertPreflightDraftSafe(
        fixture({
          mention: CONNECTOR, text: composed(),
          ...mirrorOf(`extra wrapper text ${CONNECTOR} ${changedTail}`),
        }).page,
        { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error.reason).toBe("foreign_text");
      const line = shapeLineOf(spy);
      expect(headerAtOf(line)).toBeGreaterThan(0);
      expect(line).toContain("alnum_contains=no");
      expect(line).toContain("alnum_header_at=");
    } finally {
      spy.mockRestore();
    }
  });

  it("prints n/a for every new field without a provenance proof", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A chip-only composer, so admission reaches the foreign-text walk; the
      // call names only its connector, so no provenance proof is in force and
      // every header field is `n/a`.
      const error = await assertPreflightDraftSafe(
        fixture({ mention: CONNECTOR, ...mirrorOf("fixture outside draft") }).page,
        { connector: CONNECTOR },
      ).catch(caught => caught);
      expect(error.reason).toBe("foreign_text");
      const line = shapeLineOf(spy);
      expect(line).toContain("contains_prefix=n/a");
      expect(line).toContain("header_at=n/a");
      expect(line).toContain("header_run=n/a");
      expect(line).toContain("have_char=n/a");
      expect(line).toContain("want_char=n/a");
      expect(line).toContain("alnum_contains=n/a");
      expect(line).toContain("alnum_header_at=n/a");
    } finally {
      spy.mockRestore();
    }
  });

  it("never logs a letter or digit from the page text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A fixture whose page text carries a unique word and a unique digit-bearing
      // token; if any new field printed a character of the page, one would appear.
      const uniqueWord = "zqxwvuk";
      const uniqueToken = "q7z9";
      const changed = composed(HEADER.replace("planning system header v1", "planning system header changed"));
      const error = await assertPreflightDraftSafe(
        fixture({
          mention: CONNECTOR, text: composed(),
          ...mirrorOf(`${CONNECTOR} ${uniqueWord} ${uniqueToken} ${changed}`),
        }).page,
        { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("foreign_text");
      const line = shapeLineOf(spy);
      expect(line).toContain("foreign text shape:");
      expect(line).not.toContain(uniqueWord);
      expect(line).not.toContain(uniqueToken);
      // Every new field prints only a fixed class/number vocabulary.
      expect(line).toMatch(/header_at=(-?\d+|n\/a) header_run=(\d+|n\/a) /);
      expect(line).toMatch(/have_char=(ws|P:[0-9a-f]+|L|N|O:[A-Za-z]{2}|end|n\/a) /);
      expect(line).toMatch(/want_char=(ws|P:[0-9a-f]+|L|N|O:[A-Za-z]{2}|end|n\/a) /);
      expect(line).toMatch(/alnum_contains=(yes|no|n\/a) alnum_header_at=(-?\d+|n\/a)$/);
    } finally {
      spy.mockRestore();
    }
  });
});

// P-035 2026-09-28 r30. Live evidence 05:45 SGT (vendor 9b08542, Intelli pid
// 86290): the visible composer passed the whole provenance proof, yet the hidden
// mirror (`tag=SPAN hidden=aria path=SPAN<FORM len=3141`) still refused
// `foreign_text` with `contains_prefix=no alnum_contains=yes alnum_header_at=71`
// -- the planning header is all there in letters and digits, contiguous and in
// order, only its punctuation and whitespace differ (the Markdown list `-`
// serialised as a `*`, line breaks collapsed or dropped). These cases prove the
// header condition now accepts that letters-and-digits match under a provenance
// proof, and that nothing else about the mirror rule loosens: the verbatim
// marker, the owned connector, the aria-hidden ancestor and the 40-character
// floor all still decide.
describe("letters-and-digits header match in the hidden mirror (r30)", () => {
  const CONNECTOR = "fixture";
  const MARKER = "<!-- CGPRO-PLANNING-INVOCATION-V1 -->";
  const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const HEADER = "planning system header v1\nlane=intelli facade=planning - item one";
  const composed = (header = HEADER, request = "the different planning request"): string =>
    `${header}\nUSER: ${request}\n${MARKER}\ninvocation_id="${UUID}"`;
  // The mirror's own rendering of the composed draft: the list hyphen becomes a
  // Markdown star and the header's line break is dropped, so the header arrives
  // with the very same letters and digits in the same order but is not a literal
  // substring. `header` may be swapped to break the letters-and-digits match.
  const reformatted = (header = HEADER): string =>
    `${CONNECTOR} ${header.replace(/\n/g, "").replace(" - ", " * ")} `
    + `USER: the different planning request ${MARKER} invocation_id="${UUID}"`;
  const mirrorOf = (body: string, ariaHidden = true) =>
    ({ foreignText: body, foreignParent: { tagName: "SPAN", ariaHidden } });
  const reasonOf = async (page: Page, owned: { text?: string; connector?: string;
    provenance?: { prefix: string; marker: string } }) =>
    (await assertPreflightDraftSafe(page, owned).then(() => undefined).catch(caught => caught))?.reason;

  it("admits the hidden mirror whose header matches by letters and digits", async () => {
    // The composer holds this call's own chip and the composed draft; the hidden
    // span mirrors the whole serialisation, its header rendered with different
    // punctuation and no line break, yet the same letters and digits in order.
    await expect(assertPreflightDraftSafe(
      fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(reformatted()) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).resolves.toBeUndefined();
  });

  it("refuses the same mirror when one header word changes", async () => {
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, text: composed(),
        ...mirrorOf(reformatted(HEADER.replace("item one", "item changed"))) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).toBe("foreign_text");
  });

  it("refuses the same mirror without the verbatim marker", async () => {
    const withoutMarker = `${CONNECTOR} ${HEADER.replace(/\n/g, "").replace(" - ", " * ")} `
      + `USER: the different planning request invocation_id="${UUID}"`;
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(withoutMarker) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).toBe("foreign_text");
  });

  it("refuses the same mirror without the owned connector", async () => {
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, text: composed(),
        ...mirrorOf(reformatted().replace(CONNECTOR, "other")) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).toBe("foreign_text");
  });

  it("refuses the same content in a visible node", async () => {
    // The letters-and-digits match needs the aria-hidden ancestor exactly as the
    // literal match does; a visible copy refuses unchanged.
    expect(await reasonOf(
      fixture({ mention: CONNECTOR, text: composed(), ...mirrorOf(reformatted(), false) }).page,
      { connector: CONNECTOR, provenance: { prefix: HEADER, marker: MARKER } },
    )).toBe("foreign_text");
  });

  it("refuses a header with fewer than 40 letters and digits that matches only by alnum", async () => {
    // A short header is not proof that a full header mirrored: with fewer than 40
    // letters and digits the relaxed match is unavailable, so a mirror that
    // diverges only in punctuation refuses as the literal match fails.
    const SHORT = "planning header - item one";
    expect(await reasonOf(
      fixture({
        mention: CONNECTOR, text: composed(SHORT),
        ...mirrorOf(`${CONNECTOR} planning header * item one `
          + `USER: the different planning request ${MARKER} invocation_id="${UUID}"`),
      }).page,
      { connector: CONNECTOR, provenance: { prefix: SHORT, marker: MARKER } },
    )).toBe("foreign_text");
  });
});

// P-035 2026-09-28 r33. Live intelli 06:21: `setConnector` found the connector
// row, its click threw (first-click-threw, attempt=1 and attempt=2) and the `@`
// our code had typed stayed in the composer. Every later preflight then refused
// `text_present` at `failedPhase=home`, so the lane restarted every tick. The
// picker-missing branch already clears its failed `@`; `setConnector` now clears
// this one too, and the guard admits a LONE `@` as owned residue while a lane
// connector identity is in force. A lone `@` carries no user content; any other
// text, and any `@` without that identity, refuse exactly as before. These
// cases pin the admission, the neighbouring refusals and the new content-free
// no-token shape line.
describe("lone @ residue from a failed connector click (r33)", () => {
  it("admits a composer holding only @ while a lane connector identity is in force", async () => {
    await expect(assertPreflightDraftSafe(fixture({ text: "@" }).page, { connector: "lane-x" }))
      .resolves.toBeUndefined();
    // Whitespace and format characters carry no content, so the same `@` ringed
    // by them is still just the lone `@`.
    await expect(assertPreflightDraftSafe(fixture({ text: " \u200B@\uFEFF\n" }).page, { connector: "lane-x" }))
      .resolves.toBeUndefined();
  });

  it("admits the owned chip plus a lone @", async () => {
    await expect(assertPreflightDraftSafe(
      fixture({ mention: "lane-x", text: "@" }).page, { connector: "lane-x" },
    )).resolves.toBeUndefined();
  });

  it("refuses @ with no owned connector", async () => {
    const error = await assertPreflightDraftSafe(fixture({ text: "@" }).page).catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("text_present");
  });

  it("refuses @ beside a differently named chip as connector_token_text", async () => {
    const error = await assertPreflightDraftSafe(
      fixture({ mention: "other-y", text: "@" }).page, { connector: "lane-x" },
    ).catch(caught => caught);
    expect(error).toBeInstanceOf(PreflightDraftProtectedError);
    expect(error.reason).toBe("connector_token_text");
  });

  it("refuses @x and names the count-only no-token shape", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({ text: "@x" }).page, { connector: "lane-x" },
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("text_present");
      const line = spy.mock.calls.map(call => String(call[0]))
        .find(candidate => candidate.includes("no-token text shape"));
      // One `@`, one other character, no whitespace or format characters.
      expect(line).toBe("[cgpro:preflight] no-token text shape: len=2 ws=0 cf=0 at=1 other=1");
      expect(spy.mock.calls.map(call => String(call[0]))
        .filter(candidate => candidate.includes("no-token text shape"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses @x beside the owned chip with the chip remainder shape", async () => {
    // The token-else branch keeps its own content-free line; the new `at` field
    // is only on the no-token line.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({ mention: "lane-x", text: "@x" }).page, { connector: "lane-x" },
      ).catch(caught => caught);
      expect(error).toBeInstanceOf(PreflightDraftProtectedError);
      expect(error.reason).toBe("text_present");
      expect(spy.mock.calls.map(call => String(call[0])).join("\n"))
        .toContain("chip remainder shape: len=2 ws=0 cf=0 other=2");
    } finally {
      spy.mockRestore();
    }
  });

  it("never puts the refused text in the no-token shape line", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(
        fixture({ text: "@zorblequux" }).page, { connector: "lane-x" },
      ).catch(caught => caught);
      expect(error.reason).toBe("text_present");
      const line = spy.mock.calls.map(call => String(call[0]))
        .find(candidate => candidate.includes("no-token text shape"));
      expect(line).toBe("[cgpro:preflight] no-token text shape: len=11 ws=0 cf=0 at=1 other=10");
      expect(line).not.toContain("zorblequux");
      expect(line).not.toContain("zor");
      expect(JSON.stringify(error)).not.toContain("zorblequux");
      expect(error.message).not.toContain("zorblequux");
    } finally {
      spy.mockRestore();
    }
  });
});

// P-035 2026-09-28 r34. Live 06:59 (vendor 90f7c9d): r33 admitted the composer's
// lone `@`, then the foreign-text walk refused `foreign_text` on the editor's
// own hidden mirror of that same `@` (shape: `tag=SPAN hidden=aria len=1
// equals_connector=no contains_connector=no equals_composer_text=yes words=1
// path=SPAN<FORM`). The r19/r27 mirror rules both need an admitted owned token,
// which a lone `@` does not have. These cases pin the new admission, the
// chip+`@` variant, and every neighbouring refusal.
describe("hidden mirror of the admitted lone @ (r34)", () => {
  const reasonOf = async (page: Page, owned: { text?: string; connector?: string }) =>
    (await assertPreflightDraftSafe(page, owned).then(() => undefined).catch(caught => caught))?.reason;
  const hiddenMirror = (body: string) =>
    ({ foreignText: body, foreignParent: { tagName: "SPAN", ariaHidden: true } });

  it("admits a hidden aria mirror of the admitted lone @", async () => {
    // Composer holds only the lone `@`; the span mirrors it as UI chrome.
    await expect(assertPreflightDraftSafe(
      fixture({ text: "@", ...hiddenMirror("@") }).page,
      { connector: "lane-x" },
    )).resolves.toBeUndefined();

    // Whitespace and format characters carry no content, so the same mirror
    // ringed by them is still just the lone `@`.
    await expect(assertPreflightDraftSafe(
      fixture({ text: "@", ...hiddenMirror(" \u200B@\uFEFF\n") }).page,
      { connector: "lane-x" },
    )).resolves.toBeUndefined();

    // The aria-hidden ancestor need not be the direct parent.
    await expect(assertPreflightDraftSafe(
      fixture({ text: "@", foreignText: "@", foreignParent: { tagName: "SPAN" },
        foreignAncestors: [{ tagName: "DIV", ariaHidden: true }] }).page,
      { connector: "lane-x" },
    )).resolves.toBeUndefined();
  });

  it("admits the hidden mirror of the owned chip plus the lone @", async () => {
    // The chip was admitted, so the mirror may carry the connector with the `@`.
    await expect(assertPreflightDraftSafe(
      fixture({ mention: "lane-x", text: "@", ...hiddenMirror("lane-x @") }).page,
      { connector: "lane-x" },
    )).resolves.toBeUndefined();

    // The `@` may precede the whitespace-separated connector too.
    await expect(assertPreflightDraftSafe(
      fixture({ mention: "lane-x", text: "@", ...hiddenMirror("@ lane-x") }).page,
      { connector: "lane-x" },
    )).resolves.toBeUndefined();
  });

  it("refuses a VISIBLE @ node outside the composer", async () => {
    expect(await reasonOf(
      fixture({ text: "@", foreignText: "@", foreignParent: { tagName: "SPAN", rects: 1 } }).page,
      { connector: "lane-x" },
    )).toBe("foreign_text");
  });

  it("refuses a hidden aria mirror that is not exactly the lone or chip+@ shape", async () => {
    // `@x` is not a lone `@`.
    expect(await reasonOf(
      fixture({ text: "@", ...hiddenMirror("@x") }).page,
      { connector: "lane-x" },
    )).toBe("foreign_text");

    // A different connector's chip-plus-@ mirror, with no owned token admitted.
    expect(await reasonOf(
      fixture({ text: "@", ...hiddenMirror("other-y @") }).page,
      { connector: "lane-x" },
    )).toBe("foreign_text");

    // Hidden mirror `@` while the composer holds only the owned chip, so no
    // lone `@` was admitted this call: unchanged refusal.
    expect(await reasonOf(
      fixture({ mention: "lane-x", ...hiddenMirror("@") }).page,
      { connector: "lane-x" },
    )).toBe("foreign_text");
  });

  it("refuses a composer holding @ without an owned connector, as today", async () => {
    expect(await reasonOf(
      fixture({ text: "@", ...hiddenMirror("@") }).page,
      {},
    )).toBe("text_present");
  });

  it("refuses the hidden mirror @ when the composer holds real text, as today", async () => {
    expect(await reasonOf(
      fixture({ text: "real user draft", ...hiddenMirror("@") }).page,
      { connector: "lane-x", text: "real user draft" },
    )).toBe("foreign_text");
  });
});

// P-035 2026-10-03 G3. Live ms1980: after a successful Deep Research turn the
// "Take this further in ChatGPT Work" banner sat above the composer with an
// unnamed "Try Work" button and its X, and the watchdog preflight refused
// `unknown_control:BUTTON|Dismiss ChatGPT beacon banner`.
describe("ChatGPT Work beacon banner", () => {
  const reasonOf = async (page: Page) =>
    (await assertPreflightDraftSafe(page).then(() => undefined).catch(caught => caught))?.reason;
  const dismiss = "Dismiss ChatGPT beacon banner";

  it("admits the banner's Try Work button and X on an otherwise empty home composer", async () => {
    const { page } = fixture({
      banners: { work: {} },
      controls: [
        { banner: "work" },
        { ariaLabel: dismiss, banner: "work" },
        { ariaLabel: "Add files and more" },
        { ariaLabel: "Dictate" },
        { ariaLabel: "Send" },
        { ariaLabel: "Select ChatGPT model" },
      ],
    });
    await expect(assertPreflightDraftSafe(page)).resolves.toBeUndefined();
  });

  it("still refuses an unnamed button outside any banner", async () => {
    expect(await reasonOf(fixture({ controls: [{ ariaLabel: "Add files and more" }, {}] }).page))
      .toBe("unknown_control:BUTTON");

    // The banner is present, but the unnamed button is not inside it.
    expect(await reasonOf(fixture({
      banners: { work: {} },
      controls: [{ ariaLabel: dismiss, banner: "work" }, {}],
    }).page)).toBe("unknown_control:BUTTON");
  });

  it("does not admit a dismiss button whose banner container also holds the composer", async () => {
    expect(await reasonOf(fixture({
      banners: { work: { holdsComposer: true } },
      controls: [{ banner: "work" }, { ariaLabel: dismiss, banner: "work" }],
    }).page)).toBe(`unknown_control:BUTTON|${dismiss}`);
  });

  // P-035 2026-10-03 G3-B. The live card: the X sits in a nested wrapper, and
  // "Try Work", the heading and the line are elsewhere in the same card.
  const heading = "Take this further in ChatGPT Work";
  const line = "Turn your work into a polished document, deck, spreadsheet, report, or website.";
  const liveCard = {
    banners: { work: { nested: true } },
    bannerTexts: [{ banner: "work", text: heading }, { banner: "work", text: line }],
    controls: [
      { banner: "work" },
      { ariaLabel: dismiss, banner: "work" },
      { ariaLabel: "Add files and more" },
      { ariaLabel: "Send" },
    ],
  };

  it("admits the whole card when the X sits in a nested child of it", async () => {
    await expect(assertPreflightDraftSafe(fixture(liveCard).page)).resolves.toBeUndefined();
  });

  it("still refuses the banner text when no dismiss button is present", async () => {
    expect(await reasonOf(fixture({
      ...liveCard,
      controls: [{ ariaLabel: "Add files and more" }],
    }).page)).toBe("foreign_text");
  });

  it("does not admit a card that contains the composer", async () => {
    // X directly in a card that holds the composer: no banner at all.
    expect(await reasonOf(fixture({
      ...liveCard,
      banners: { work: { holdsComposer: true } },
    }).page)).toBe(`unknown_control:BUTTON|${dismiss}`);
    // X nested: the walk stops below the card, so "Try Work" and the text
    // beside the X's own wrapper are not admitted.
    expect(await reasonOf(fixture({
      ...liveCard,
      banners: { work: { holdsComposer: true, nested: true } },
    }).page)).toBe("unknown_control:BUTTON");
    expect(await reasonOf(fixture({
      ...liveCard,
      banners: { work: { holdsComposer: true, nested: true } },
      controls: [{ ariaLabel: dismiss, banner: "work" }],
    }).page)).toBe("foreign_text");
  });

  it("still refuses foreign text outside the admitted card", async () => {
    expect(await reasonOf(fixture({ ...liveCard, foreignText: "private draft chip" }).page))
      .toBe("foreign_text");
  });

  it("does not admit a role=button control inside the banner", async () => {
    expect(await reasonOf(fixture({
      banners: { work: {} },
      controls: [{ ariaLabel: dismiss, banner: "work" }, { ariaLabel: "Try Work", tagName: "DIV", banner: "work" }],
    }).page)).toBe("unknown_control:Try Work");
  });
});

// P-035 2026-10-03 G3-B. Live intelli: a failed Deep Research turn left the
// native chip in the home composer and every preflight refused
// `form_media:img` on the chip's own icon.
describe("own native Deep Research chip", () => {
  const reasonOf = async (page: Page, owned: Parameters<typeof assertPreflightDraftSafe>[1] = {}) =>
    (await assertPreflightDraftSafe(page, owned).then(() => undefined).catch(caught => caught))?.reason;
  const chip = (textContent = "Deep research") => ({ tagName: "SPAN", textContent, icon: true });
  const homeControls = [{ ariaLabel: "Add files and more" }, { ariaLabel: "Send" }];

  it("admits the lone chip with its icon as an atom in the composer", async () => {
    const test = fixture({ tokenTree: [chip()], controls: homeControls });
    await expect(assertPreflightDraftSafe(test.page)).resolves.toBeUndefined();
    // The atom was dropped from the clone before tokens were counted.
    expect(test.removedTokens.map(token => token.textContent)).toEqual(["Deep research"]);
  });

  it("admits the French label and whitespace-collapsed text, nothing looser", async () => {
    await expect(assertPreflightDraftSafe(fixture({
      tokenTree: [chip("Recherche approfondie")], composerInnerText: "Recherche approfondie",
    }).page)).resolves.toBeUndefined();
    await expect(assertPreflightDraftSafe(fixture({
      tokenTree: [chip("  Deep \n research ")], composerInnerText: "Deep research",
    }).page)).resolves.toBeUndefined();
    expect(await reasonOf(fixture({ tokenTree: [chip("Deep research x")] }).page)).toBe("form_media:img");
    expect(await reasonOf(fixture({ tokenTree: [chip("deep research")] }).page)).toBe("form_media:img");
  });

  it("admits the lone chip as a form button with its icon", async () => {
    await expect(assertPreflightDraftSafe(fixture({
      drButtons: [{ text: "Deep research", icon: true }], controls: homeControls,
    }).page)).resolves.toBeUndefined();
    // Any other button with an icon still refuses on its media.
    expect(await reasonOf(fixture({ drButtons: [{ text: "Try Work", icon: true }] }).page))
      .toBe("form_media:img");
  });

  it("still refuses the chip plus typed text", async () => {
    expect(await reasonOf(fixture({ tokenTree: [chip()], text: "private draft" }).page))
      .toBe("text_present");
    // Typed text that the clone does not carry still shows in the rendered text.
    expect(await reasonOf(fixture({
      tokenTree: [chip()], composerInnerText: "Deep research private draft",
    }).page)).toBe("text_present");
  });

  // P-035 2026-10-03 G3-B. Live intelli (built ca3fb0f) refused the lone chip:
  //   [cgpro:preflight] no-token text shape: len=1 ws=1 cf=0 at=0 other=0
  // The clone keeps the one whitespace the editor leaves beside the removed atom.
  it("admits the whitespace or format character a removed chip atom leaves behind", async () => {
    await expect(assertPreflightDraftSafe(fixture({ tokenTree: [chip()], text: " " }).page)).resolves.toBeUndefined();
    await expect(assertPreflightDraftSafe(fixture({ tokenTree: [chip()], text: "\u00a0" }).page)).resolves.toBeUndefined();
    // U+200B survives `trim()`, so the rendered text here is the label alone and
    // only the clone carries it; a U+200B in the rendered text still refuses.
    await expect(assertPreflightDraftSafe(fixture({
      tokenTree: [chip()], text: "\u200b", composerInnerText: "Deep research",
    }).page)).resolves.toBeUndefined();
    expect(await reasonOf(fixture({ tokenTree: [chip()], text: "\u200b" }).page)).toBe("text_present");
  });

  it("still refuses the chip plus any non-whitespace remainder, and whitespace with no chip", async () => {
    expect(await reasonOf(fixture({ tokenTree: [chip()], text: "x" }).page)).toBe("text_present");
    expect(await reasonOf(fixture({ tokenTree: [chip()], text: "@" }).page)).toBe("text_present");
    expect(await reasonOf(fixture({ text: " " }).page)).toBe("text_present");
    expect(await reasonOf(fixture({ text: " ", composerInnerText: "" }).page)).toBe("text_present");
    // A chip button outside the composer removes no atom from the clone.
    expect(await reasonOf(fixture({
      drButtons: [{ text: "Deep research", icon: true }], text: " ", composerInnerText: "",
    }).page)).toBe("text_present");
  });

  it("still refuses the chip plus a foreign img", async () => {
    expect(await reasonOf(fixture({ tokenTree: [chip()], attachment: true }).page)).toBe("form_media:img");
    expect(await reasonOf(fixture({ drButtons: [{ text: "Deep research", icon: true }], attachment: true }).page))
      .toBe("form_media:img");
  });

  it("still refuses an unknown control beside the chip", async () => {
    expect(await reasonOf(fixture({ tokenTree: [chip()], controls: [{ testid: "voice-mode-btn" }] }).page))
      .toBe("unknown_control:voice-mode-btn");
  });

  it("keeps the owned connector token rule beside the chip", async () => {
    const both = fixture({ tokenTree: [chip(), { tagName: "SPAN", textContent: "fixture" }] });
    await expect(assertPreflightDraftSafe(both.page, { connector: "fixture" })).resolves.toBeUndefined();
    expect(await reasonOf(
      fixture({ tokenTree: [chip(), { tagName: "SPAN", textContent: "fixture" }] }).page,
    )).toBe("connector_unowned");
  });
});

// P-035 2026-10-03 G3-B (fourth run). Live intelli passed `home`, then refused
// `connector_token_text` at `project-chat-surface`: the composer held only the
// same Deep Research mode in its pill form, text `deep-research`.
describe("own native Deep Research chip, pill form", () => {
  const reasonOf = async (page: Page, owned: Parameters<typeof assertPreflightDraftSafe>[1] = {}) =>
    (await assertPreflightDraftSafe(page, owned).then(() => undefined).catch(caught => caught))?.reason;
  const pill = (textContent = "deep-research"): TokenNode => ({ tagName: "SPAN", textContent, icon: true, pill: true });
  const homeControls = [{ ariaLabel: "Add files and more" }, { ariaLabel: "Send" }];

  it("uses the selector SELECTORS.deepResearchSelected already names", () => {
    expect(SELECTORS.deepResearchSelected).toContain(`form ${PREFLIGHT_CHROME.deepResearchChipPill}`);
  });

  it("admits the lone pill with its icon, without and with an owned connector", async () => {
    const test = fixture({ tokenTree: [pill()], controls: homeControls });
    await expect(assertPreflightDraftSafe(test.page)).resolves.toBeUndefined();
    // Removed from the clone before tokens were counted.
    expect(test.removedTokens.map(token => token.textContent)).toEqual(["deep-research"]);
    await expect(assertPreflightDraftSafe(fixture({ tokenTree: [pill()], controls: homeControls }).page,
      { connector: "fixture" })).resolves.toBeUndefined();
    // The whitespace a removed atom leaves behind follows the same rule.
    await expect(assertPreflightDraftSafe(fixture({ tokenTree: [pill()], text: " " }).page,
      { connector: "fixture" })).resolves.toBeUndefined();
  });

  it("admits an atom that contains the pill, and a form button that is one", async () => {
    await expect(assertPreflightDraftSafe(fixture({
      tokenTree: [{ tagName: "SPAN", textContent: "deep-research", children: [{ tagName: "SPAN", pill: true, icon: true }] }],
    }).page, { connector: "fixture" })).resolves.toBeUndefined();
    await expect(assertPreflightDraftSafe(fixture({
      drButtons: [{ text: "deep-research", icon: true, pill: true }], controls: homeControls,
    }).page)).resolves.toBeUndefined();
    expect(await reasonOf(fixture({ drButtons: [{ text: "deep-research", icon: true }] }).page))
      .toBe("form_media:img");
  });

  it("refuses the pill plus typed text as text_present", async () => {
    expect(await reasonOf(fixture({ tokenTree: [pill()], text: "private draft" }).page)).toBe("text_present");
    expect(await reasonOf(fixture({
      tokenTree: [pill()], composerInnerText: "deep-research private draft",
    }).page, { connector: "fixture" })).toBe("text_present");
  });

  it("admits the pill plus the owned connector token exactly as the token alone", async () => {
    const token = { tagName: "SPAN", textContent: "fixture" };
    await expect(assertPreflightDraftSafe(fixture({ tokenTree: [token] }).page, { connector: "fixture" }))
      .resolves.toBeUndefined();
    await expect(assertPreflightDraftSafe(fixture({ tokenTree: [pill(), token] }).page, { connector: "fixture" }))
      .resolves.toBeUndefined();
    expect(await reasonOf(fixture({ tokenTree: [token] }).page)).toBe("connector_unowned");
    expect(await reasonOf(fixture({ tokenTree: [pill(), token] }).page)).toBe("connector_unowned");
  });

  it("still refuses a foreign token reading deep-research without the pill data-id", async () => {
    const foreign = { tagName: "SPAN", textContent: "deep-research" };
    expect(await reasonOf(fixture({ tokenTree: [foreign] }).page, { connector: "fixture" }))
      .toBe("connector_token_text");
    expect(await reasonOf(fixture({ tokenTree: [foreign] }).page)).toBe("connector_unowned");
    expect(await reasonOf(fixture({ tokenTree: [{ ...foreign, icon: true }] }).page, { connector: "fixture" }))
      .toBe("form_media:img");
  });
});

// P-035 2026-10-03 G3-B (fifth run). Live intelli refused `connector_token_text`
// at `home` on a composer showing only a `deep-research` token: the pill
// selector matched neither the outermost atom nor anything inside it.
describe("own Deep Research pill on an ancestor, and the token shape line", () => {
  const reasonOf = async (page: Page, owned: Parameters<typeof assertPreflightDraftSafe>[1] = {}) =>
    (await assertPreflightDraftSafe(page, owned).then(() => undefined).catch(caught => caught))?.reason;
  const linesOf = async (page: Page, owned: Parameters<typeof assertPreflightDraftSafe>[1] = {}) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await assertPreflightDraftSafe(page, owned).catch(caught => caught);
      return { error, lines: spy.mock.calls.map(call => String(call[0])) };
    } finally {
      spy.mockRestore();
    }
  };
  const wrapped = (wrapper: TokenWrapper): TokenNode =>
    ({ tagName: "SPAN", textContent: "deep-research", icon: true, wrappers: [wrapper] });

  it("admits an atom whose wrapper carries the pill attributes as an own chip", async () => {
    const test = fixture({ tokenTree: [wrapped({ tagName: "SPAN", pill: true })] });
    await expect(assertPreflightDraftSafe(test.page)).resolves.toBeUndefined();
    expect(test.removedTokens.map(token => token.textContent)).toEqual(["deep-research"]);
    await expect(assertPreflightDraftSafe(fixture({
      tokenTree: [{ ...wrapped({ tagName: "SPAN", pill: true }), wrappers: [{ tagName: "SPAN", pill: true }, { tagName: "P" }] }],
    }).page, { connector: "fixture" })).resolves.toBeUndefined();
    // Two levels up is still the nearest pill ancestor inside the composer.
    await expect(assertPreflightDraftSafe(fixture({
      tokenTree: [{ ...wrapped({ tagName: "SPAN" }), wrappers: [{ tagName: "SPAN" }, { tagName: "SPAN", pill: true }] }],
    }).page, { connector: "fixture" })).resolves.toBeUndefined();
  });

  it("still refuses when the pill ancestor is outside the composer or absent", async () => {
    expect(await reasonOf(fixture({ tokenTree: [wrapped({ tagName: "DIV", pill: true, outside: true })] }).page,
      { connector: "fixture" })).toBe("form_media:img");
    const plain: TokenNode = { tagName: "SPAN", textContent: "deep-research", wrappers: [{ tagName: "SPAN" }] };
    expect(await reasonOf(fixture({ tokenTree: [plain] }).page, { connector: "fixture" })).toBe("connector_token_text");
    expect(await reasonOf(fixture({
      tokenTree: [{ ...plain, wrappers: [{ tagName: "DIV", pill: true, outside: true }] }],
    }).page, { connector: "fixture" })).toBe("connector_token_text");
    // A bare selection pill without the Deep Research data-id is not ours.
    expect(await reasonOf(fixture({
      tokenTree: [{ ...plain, wrappers: [{ tagName: "SPAN", selectionPill: true }] }],
    }).page, { connector: "fixture" })).toBe("connector_token_text");
  });

  it("logs every token shape field on connector_token_text, without the token text", async () => {
    const { error, lines } = await linesOf(fixture({
      tokenTree: [{
        tagName: "SPAN",
        textContent: " zorble quux secret ",
        attributes: [
          { name: "contenteditable", value: "false" }, { name: "class", value: "chip x" },
          { name: "data-id", value: "plugin:other" }, { name: "data-private", value: "zorblequux" },
          { name: "aria-label", value: "a".repeat(100) },
        ],
        wrappers: [
          { tagName: "SPAN", selectionPill: true, attributes: [{ name: "data-inline-selection-pill", value: "" },
            { name: "data-type", value: "mention" }, { name: "role", value: "button" }] },
          { tagName: "P", attributes: [{ name: "data-empty", value: "zorblequux" }] },
          { tagName: "DIV", attributes: [{ name: "data-id", value: "beyond-grandparent" }] },
        ],
      }],
    }).page, { connector: "fixture" });
    expect(error.reason).toBe("connector_token_text");
    const shape = lines.filter(line => line.startsWith("[cgpro:preflight] token shape: "));
    expect(shape).toEqual([
      "[cgpro:preflight] token shape: tag=SPAN attrs=contenteditable,class,data-id,data-private,aria-label "
      + `data-id="plugin:other" data-type=- role=- aria-label="${"a".repeat(80)}" class="chip x" app-mention-name=- app-mention-path=- data-prompt-link-label=- `
      + "text_len=20 slug=no "
      + "parent=[tag=SPAN attrs=data-inline-selection-pill,data-type,role data-id=- data-type=\"mention\" "
      + "role=\"button\" aria-label=- class=- app-mention-name=- app-mention-path=- data-prompt-link-label=-] "
      + "grandparent=[tag=P attrs=data-empty data-id=- data-type=- role=- aria-label=- class=- app-mention-name=- app-mention-path=- data-prompt-link-label=-] pill_ancestor=yes",
    ]);
    for (const line of lines) {
      expect(line).not.toContain("zorble");
      expect(line).not.toContain("secret");
      expect(line).not.toContain("beyond-grandparent");
    }
    expect(lines).toContain("[cgpro:preflight] draft guard refused: reason=connector_token_text");
  });

  it("names the slug bit and stops at the composer", async () => {
    const { error, lines } = await linesOf(fixture({ tokenTree: [{ tagName: "SPAN", textContent: " deep-research " }] }).page,
      { connector: "fixture" });
    expect(error.reason).toBe("connector_token_text");
    expect(lines.filter(line => line.includes("token shape"))).toEqual([
      "[cgpro:preflight] token shape: tag=SPAN attrs=- data-id=- data-type=- role=- aria-label=- class=- app-mention-name=- app-mention-path=- data-prompt-link-label=- "
      + "text_len=15 slug=yes parent=[-] grandparent=[-] pill_ancestor=no",
    ]);
  });

  it("logs the first outermost token's shape on connector_unowned and connector_token_count", async () => {
    const unowned = await linesOf(fixture({ tokenTree: [{ tagName: "A", textContent: "lane-x" }] }).page);
    expect(unowned.error.reason).toBe("connector_unowned");
    expect(unowned.lines.filter(line => line.includes("token shape"))).toEqual([
      "[cgpro:preflight] token shape: tag=A attrs=- data-id=- data-type=- role=- aria-label=- class=- app-mention-name=- app-mention-path=- data-prompt-link-label=- "
      + "text_len=6 slug=yes parent=[-] grandparent=[-] pill_ancestor=no",
    ]);
    const count = await linesOf(fixture({
      tokenTree: [{ tagName: "B", textContent: "Private Name" }, { tagName: "A", textContent: "lane-x" }],
    }).page, { connector: "lane-x" });
    expect(count.error.reason).toBe("connector_token_count:2");
    expect(count.lines.filter(line => line.includes("token shape"))).toEqual([
      "[cgpro:preflight] token shape: tag=B attrs=- data-id=- data-type=- role=- aria-label=- class=- app-mention-name=- app-mention-path=- data-prompt-link-label=- "
      + "text_len=12 slug=no parent=[-] grandparent=[-] pill_ancestor=no",
    ]);
    expect(count.lines.join("\n")).not.toContain("Private");
  });

  it("logs no token shape on an admitted or a non-token refusal", async () => {
    const admitted = await linesOf(fixture({ mention: "lane-x" }).page, { connector: "lane-x" });
    expect(admitted.error).toBeUndefined();
    expect(admitted.lines.some(line => line.includes("token shape"))).toBe(false);
    const text = await linesOf(fixture({ text: "private draft" }).page);
    expect(text.error.reason).toBe("text_present");
    expect(text.lines.some(line => line.includes("token shape"))).toBe(false);
  });
});

// P-035 2026-10-03 G3-B (sixth run). Live intelli (built 2134f76) refused
// `connector_token_text` at `home` on a composer holding one SPAN carrying
// `app-mention-name`, `app-mention-path`, `data-prompt-link-label`, ...: the
// persisted Deep Research mode as an app mention, text `deep-research`.
describe("own native Deep Research chip, app mention form", () => {
  const reasonOf = async (page: Page, owned: Parameters<typeof assertPreflightDraftSafe>[1] = {}) =>
    (await assertPreflightDraftSafe(page, owned).then(() => undefined).catch(caught => caught))?.reason;
  const homeControls = [{ ariaLabel: "Add files and more" }, { ariaLabel: "Send" }];
  // The evidence-2 attribute names; the values are illustrative.
  const mentionAttributes = (values: { name?: string; path?: string; label?: string } = {}) => [
    { name: "app-mention-name", value: values.name ?? "Deep research" },
    { name: "app-mention-display-name", value: "Deep research" },
    { name: "app-mention-path", value: values.path ?? "deep-research" },
    { name: "app-mention-icon", value: "" },
    { name: "app-mention-brand-color", value: "" },
    { name: "data-prompt-link-href", value: "" },
    { name: "data-prompt-link-label", value: values.label ?? "Deep research" },
    { name: "class", value: "Mention-hIgCkC" },
    { name: "data-appearance", value: "" }, { name: "data-layout", value: "" },
    { name: "data-font-weight", value: "" }, { name: "data-tone", value: "" },
    { name: "data-interactive", value: "" }, { name: "data-underline-on-hover", value: "" },
    { name: "contenteditable", value: "false" },
  ];
  const mention = (textContent = "deep-research", values: Parameters<typeof mentionAttributes>[0] = {}): TokenNode =>
    ({ tagName: "SPAN", textContent, icon: true, attributes: mentionAttributes(values), wrappers: [{ tagName: "P" }] });

  it("admits the evidence-2 mention alone, without and with an owned connector", async () => {
    const test = fixture({ tokenTree: [mention()], controls: homeControls });
    await expect(assertPreflightDraftSafe(test.page)).resolves.toBeUndefined();
    // Removed from the clone before tokens were counted.
    expect(test.removedTokens.map(token => token.textContent)).toEqual(["deep-research"]);
    await expect(assertPreflightDraftSafe(fixture({ tokenTree: [mention()], controls: homeControls }).page,
      { connector: "fixture" })).resolves.toBeUndefined();
    // Case-insensitive text, and the whitespace a removed atom leaves behind.
    await expect(assertPreflightDraftSafe(fixture({
      tokenTree: [mention(" Deep-Research ")], composerInnerText: "Deep-Research", text: " ",
    }).page)).resolves.toBeUndefined();
    // One matching attribute is enough.
    await expect(assertPreflightDraftSafe(fixture({
      tokenTree: [mention("deep-research", { name: "x", path: "y", label: "Deep_Research" })],
    }).page)).resolves.toBeUndefined();
  });

  it("refuses the mention plus typed text", async () => {
    expect(await reasonOf(fixture({ tokenTree: [mention()], text: "private draft" }).page)).toBe("text_present");
    expect(await reasonOf(fixture({
      tokenTree: [mention()], composerInnerText: "deep-research private draft",
    }).page, { connector: "fixture" })).toBe("text_present");
  });

  it("refuses a deep-research mention whose attribute values do not match", async () => {
    const values = { name: "canva", path: "canva", label: "Canva" };
    expect(await reasonOf(fixture({ tokenTree: [{ ...mention("deep-research", values), icon: false }] }).page,
      { connector: "fixture" })).toBe("connector_token_text");
    expect(await reasonOf(fixture({ tokenTree: [mention("deep-research", values)] }).page)).toBe("form_media:img");
  });

  it("refuses another app mention", async () => {
    const canva = { ...mention("canva", { name: "Canva", path: "canva", label: "Canva" }), icon: false };
    expect(await reasonOf(fixture({ tokenTree: [canva] }).page, { connector: "fixture" })).toBe("connector_token_text");
    expect(await reasonOf(fixture({ tokenTree: [canva] }).page)).toBe("connector_unowned");
    // A Deep Research attribute does not make other text ours.
    expect(await reasonOf(fixture({ tokenTree: [{ ...mention("canva"), icon: false }] }).page,
      { connector: "fixture" })).toBe("connector_token_text");
  });

  it("shows the three app-mention values in the token shape of a refused mention", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await assertPreflightDraftSafe(fixture({
        tokenTree: [{ ...mention("canva", { name: "Canva", path: `canva/${"p".repeat(100)}`, label: "Canva" }), icon: false }],
      }).page, { connector: "fixture" }).catch(() => undefined);
      const shape = spy.mock.calls.map(call => String(call[0])).find(line => line.includes("token shape"));
      expect(shape).toContain(`class="Mention-hIgCkC" app-mention-name="Canva" app-mention-path="canva/${"p".repeat(74)}" `
        + 'data-prompt-link-label="Canva" text_len=5');
    } finally {
      spy.mockRestore();
    }
  });
});
