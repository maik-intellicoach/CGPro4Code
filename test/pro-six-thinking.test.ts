import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { PreSubmitInteractionError, SelectorBrokenError } from "../src/errors.js";

const requireSelector = vi.fn();
const firstResolved = vi.fn();
const fetchModels = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));
// P-035 2026-09-21. The expected composer label is read from the account's own
// catalogue, so only the fetch is stubbed; findProModel and normaliseModelLabel
// stay the real implementations under test.
vi.mock("../src/api/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/models.js")>();
  return {
    ...actual,
    fetchModels: (...args: unknown[]) => fetchModels(...args),
    // P-035 2026-09-21. The pre-submit check now reads the catalogue through the
    // reason-carrying form, so the same stub has to feed both entry points.
    fetchModelsWithReason: async (...args: unknown[]) => ({
      models: (await fetchModels(...args)) as unknown[],
      status: 200,
      reason: "http 200",
    }),
  };
});
const { ensureProSixMaximum, menuIsThinkingEffort } = await import("../src/browser/conversation.js");

// P-035 2026-09-27. The Pro-limit path reads the page through `page.evaluate`.
// The test environment is `node` (no jsdom), so these tests install a tiny
// read-only stand-in for `document`/`window` and let the fake page call the REAL
// evaluate callback against it. That is what makes "found from the title /
// aria-describedby / the popper wrapper / only after a forced hover" statements
// about the shipped code rather than about a hand-written mock.
class FakeElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  /** `false` makes the element report as hidden to `getComputedStyle`/rect. */
  visible = true;

  constructor(
    readonly tagName: string,
    private readonly attrs: Record<string, string> = {},
    private readonly ownText = "",
  ) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  get parentElement(): FakeElement | null {
    return this.parent;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  append(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return this.visible ? { width: 140, height: 24 } : { width: 0, height: 0 };
  }
}

function descendantsOf(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (node: FakeElement): void => {
    for (const child of node.children) {
      out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

/** Supports exactly the attribute selectors the Pro-limit probes use. */
function matchesAny(node: FakeElement, selectors: string[]): boolean {
  return selectors.some((selector) => {
    const attr = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!attr) return false;
    const value = node.getAttribute(attr[1]);
    return attr[2] === undefined ? value !== null : value === attr[2];
  });
}

interface FakeDocument {
  body: FakeElement;
  querySelectorAll(selector: string): FakeElement[];
  getElementById(id: string): FakeElement | null;
}

function makeFakeDocument(body: FakeElement): FakeDocument {
  const all = (): FakeElement[] => descendantsOf(body);
  return {
    body,
    querySelectorAll: (selector: string): FakeElement[] =>
      selector === "body *"
        ? all()
        : all().filter((node) => matchesAny(node, selector.split(","))),
    getElementById: (id: string): FakeElement | null =>
      all().find((node) => node.getAttribute("id") === id) ?? null,
  };
}

const LIVE_LIMIT_TEXT = "Limit reached. Try again after Sep 30, 2026.";

function setup(options: {
  max?: string | null;
  sticks?: boolean;
  /** The composer row's own text. Since 2026-09-22 this is the EFFORT label. */
  effortLabel?: string;
  clickTimesOut?: boolean;
  menuOpened?: boolean;
  openMenus?: number;
  menuStaysOpen?: boolean;
  /** The model list the picker reports, newest first. */
  pickerEntries?: string[];
  pickerCheckedIndex?: number;
  /** The picker names no selected model at all. */
  pickerEmpty?: boolean;
  /** Index of a DISABLED `Pro` row in the picker; undefined means absent/enabled. */
  proIndex?: number;
  /** The disabled row's tooltip text; the live sentence is the default. */
  tooltipText?: string | null;
  /** The tooltip never appears at all. */
  tooltipVisible?: boolean;
  /** Passive text placed on the disabled row before any hover. */
  passiveTitle?: string;
  passiveAria?: string;
  /** Text of the element the disabled row's `aria-describedby` points at. */
  describedByText?: string;
  /** A `title` on an ancestor inside the menu boundary, not on the row. */
  ancestorTitle?: string;
  /** Which selector tier carries the tooltip element. */
  tooltipTier?: "tooltip" | "popper" | "side";
  /** The tooltip appears only after the ANCESTOR hover, never the row hover. */
  tooltipAfterAncestorHoverOnly?: boolean;
  /** The tooltip exists in the DOM but reports as hidden. */
  tooltipHidden?: boolean;
  /** No known tier carries it; only a tiny nested span holds the sentence. */
  fallbackTooltip?: boolean;
  /** The disabled row refuses even a forced hover. */
  rowHoverRejects?: boolean;
  /** The nearest non-menu ancestor refuses its forced hover. */
  ancestorHoverRejects?: boolean;
} = {}) {
  let value = "1";
  const model = {
    click: vi.fn(async () => {
      if (options.clickTimesOut) throw new Error("locator.click: Timeout 5000ms exceeded.");
    }),
    getAttribute: vi.fn(async (name: string) => options.menuOpened && name === "data-state" ? "open" : null),
  };
  const selected = {
    textContent: vi.fn(async () =>
      options.effortLabel === "High" && value === (options.max ?? "4") ? "6Pro" : options.effortLabel ?? "6Pro",
    ),
    click: vi.fn(async () => {}),
  };
  const slider = {
    getAttribute: vi.fn(async (name: string) => ({
      "aria-valuemin": "0",
      "aria-valuemax": options.max === undefined ? "4" : options.max,
      "aria-valuenow": value,
    })[name] ?? null),
    // P-035 2026-09-16: the slider is focused and the keyboard drives it,
    // because ChatGPT's role="slider" span is hidden and `press()` needs an
    // actionability check it can never pass.
    focus: vi.fn(async () => {}),
  };
  // P-035 2026-09-27: the read-only DOM the real Pro-limit callbacks run against.
  // Shape mirrors the live picker: body > anchor(data-side) > menu > group > rows,
  // so the row's nearest non-menu ancestor is the group.
  const body = new FakeElement("body");
  const anchor = body.append(new FakeElement("div", { "data-side": "bottom" }));
  const menu = anchor.append(new FakeElement("div", { role: "menu" }));
  const group = menu.append(new FakeElement("div"));
  const rows = (options.pickerEntries ?? ["Latest", "GPT-5.6 Sol", "GPT-5.5"]).map((label) =>
    group.append(new FakeElement("div", { role: "menuitem" }, label)),
  );
  const proRow = options.proIndex === undefined ? undefined : rows[options.proIndex];
  if (proRow) proRow.setAttribute("aria-disabled", "true");
  if (options.ancestorTitle !== undefined) group.setAttribute("title", options.ancestorTitle);
  if (proRow && options.passiveTitle !== undefined) proRow.setAttribute("title", options.passiveTitle);
  if (proRow && options.passiveAria !== undefined) proRow.setAttribute("aria-label", options.passiveAria);
  if (proRow && options.describedByText !== undefined) {
    proRow.setAttribute("aria-describedby", "limit-tip");
    body.append(new FakeElement("div", { id: "limit-tip" }, options.describedByText));
  }
  const fakeDocument = makeFakeDocument(body);
  (globalThis as Record<string, unknown>).document = fakeDocument;
  (globalThis as Record<string, unknown>).window = {
    getComputedStyle: (element: FakeElement) => ({
      visibility: element.visible ? "visible" : "hidden",
      display: "block",
      opacity: "1",
    }),
  };
  const liveText = options.tooltipText === undefined ? LIVE_LIMIT_TEXT : options.tooltipText;
  const appendTooltip = (text: string, hidden = false): void => {
    const attrs =
      options.tooltipTier === "popper"
        ? { "data-radix-popper-content-wrapper": "" }
        : options.tooltipTier === "side"
          ? { "data-side": "top" }
          : { role: "tooltip" };
    const element = body.append(new FakeElement("div", attrs, text));
    element.visible = !hidden;
  };
  // The disabled row's forced hover. `{ force: true }` is the whole point on the
  // live lane: a plain hover on a greyed, pointer-events-none row never resolves.
  const rowHover = vi.fn(async (hoverOptions?: { force?: boolean }) => {
    void hoverOptions;
    if (options.rowHoverRejects) throw new Error("locator.hover: element is not enabled");
    if (options.tooltipVisible === false || options.tooltipAfterAncestorHoverOnly) return;
    if (options.fallbackTooltip) {
      const wrapper = body.append(
        new FakeElement("div", {}, "Limit reached. Try again after Sep 30, 2026. "),
      );
      wrapper.append(new FakeElement("span", {}, liveText ?? ""));
      return;
    }
    if (liveText !== null) appendTooltip(liveText, options.tooltipHidden === true);
  });
  const ancestorHover = vi.fn(async (hoverOptions?: { force?: boolean }) => {
    void hoverOptions;
    if (options.ancestorHoverRejects) throw new Error("locator.hover: element does not receive events");
    if (options.tooltipVisible === false) return;
    if (liveText !== null) appendTooltip(liveText, options.tooltipHidden === true);
  });
  // P-035 2026-09-18: `evaluate` is part of the real page shape and the menu
  // close postcondition needs it. Without it the fake made every path throw
  // "page.evaluate is not a function" from inside a finally, which masked the
  // real assertion. openMenus counts what is still open after each Escape.
  let openMenus = options.openMenus ?? 1;
  const page = {
    keyboard: {
      press: vi.fn(async (key: string) => {
        if (key === "End" && options.sticks !== false) value = options.max ?? "4";
        if (key === "Escape" && !options.menuStaysOpen) openMenus = 0;
      }),
      // Present so a test can prove nothing is typed before the refusal.
      type: vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {}),
    // Hover reads go through the page's own locator API, never OS input. The
    // disabled-Pro check uses `nth(index).hover()` for the row and
    // `nth(index).locator("xpath=ancestor::...").hover()` for the wrapper above
    // the menu. `rowHover`/`ancestorHover` are returned to the caller for
    // assertions on `{ force: true }`.
    locator: vi.fn((selector: string) => {
      if (selector.includes("menuitem")) {
        return {
          nth: () => ({
            hover: rowHover,
            locator: () => ({ hover: ancestorHover }),
          }),
        };
      }
      return { nth: () => ({ hover: vi.fn(async () => {}) }) };
    }),
    // Four probes share this entry point on the real page, told apart by
    // argument shape: the pointer-blocker count takes a selector string, the
    // picker read takes `{ max }`, the menu dump takes `{ selectedSelector, max }`
    // and returns prose, and the two Pro-limit probes run the SHIPPED callback
    // against the fake DOM installed above.
    evaluate: vi.fn(async (fn: unknown, arg: unknown) => {
      if (typeof arg === "string") return openMenus;
      const keys = arg && typeof arg === "object" ? Object.keys(arg) : [];
      if (keys.includes("proLimitProbe")) return options.proIndex ?? -1;
      if (keys.includes("selectedSelector")) return "row=\"6 Pro\" menus=1 menuItems=[] sliders=[4/4]";
      if (keys.includes("proLimitPassiveAt") || keys.includes("proLimitScan")) {
        return (fn as (value: unknown) => unknown)(arg);
      }
      if (options.pickerEmpty) return { entries: [], checkedIndex: -1 };
      return {
        entries: options.pickerEntries ?? ["Latest", "GPT-5.6 Sol", "GPT-5.5"],
        checkedIndex: options.pickerCheckedIndex ?? 0,
      };
    }),
  } as unknown as Page;
  requireSelector.mockResolvedValueOnce(model).mockResolvedValueOnce(slider).mockResolvedValueOnce(selected);
  firstResolved.mockResolvedValue(options.menuOpened ? slider : null);
  return { page, model, slider, selected, rowHover, ancestorHover, fakeDocument };
}

beforeEach(() => {
  requireSelector.mockReset();
  firstResolved.mockReset();
  fetchModels.mockReset();
  fetchModels.mockResolvedValue([{ slug: "gpt-6-pro", title: "6 Pro" }]);
});

describe("6 Pro maximum thinking admission", () => {
  it("moves a lower slider value to the observed maximum and verifies it", async () => {
    const s = setup();
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "Latest", power: 4 });
    expect(s.slider.focus).toHaveBeenCalledWith({ timeout: 5_000 });
    expect(s.page.keyboard.press).toHaveBeenCalledWith("End");
    expect(s.page.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("uses the live maximum instead of assuming a fixed number", async () => {
    const s = setup({ max: "5" });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "Latest", power: 5 });
  });

  it("refuses submission when maximum power does not stick", async () => {
    const s = setup({ sticks: false });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow("did not reach its maximum");
    expect(s.page.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("refuses an unverified slider range", async () => {
    const s = setup({ max: null });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow("range could not be verified");
    expect(s.slider.focus).not.toHaveBeenCalled();
  });

  it("upgrades a lower effort level to maximum power and proceeds", async () => {
    const s = setup({ effortLabel: "High" });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "Latest", power: 4 });
  });

  // P-035 2026-09-22. Maik's three ordered screenshots settled what the row
  // carries: the collapsed pill reads "6 Pro", the first click opens the EFFORT
  // panel, and clicking the "6 Pro >" row switches to the MODEL list, where
  // "Latest" carries the check. So the row's own label is the effort level, and
  // the model is read from the picker's checked entry.
  it("reads the model from the picker and reports the model it actually saw", async () => {
    const s = setup({ effortLabel: "Extra High", pickerEntries: ["Latest", "GPT-5.6 Sol", "GPT-5.5"] });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "Latest", power: 4 });
  });

  it("refuses when the picker is on an older model than its newest entry", async () => {
    const s = setup({ pickerEntries: ["Latest", "GPT-5.6 Sol", "GPT-5.5"], pickerCheckedIndex: 2 });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow(
      /has "GPT-5\.5" selected, where the newest model is "Latest"/,
    );
    expect(s.slider.focus).toHaveBeenCalledOnce();
  });

  // P-035 2026-09-22, from a live review of the first version of this read. That
  // version required only "the checked entry is first", and the review's
  // counterexample is exactly this fixture: an app that promotes an older model
  // above the newest one, with the checkmark, the DOM and every other part of the
  // gate still perfectly valid. Position alone would certify it as newest.
  // This is the failing test that counterexample asked for, and it now passes.
  it("refuses an older model promoted to the top of the picker", async () => {
    const s = setup({
      pickerEntries: ["GPT-5.5 Leaving on October 14", "Latest", "GPT-5.6 Sol"],
      pickerCheckedIndex: 0,
    });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow(
      /has "GPT-5\.5 Leaving on October 14" selected/,
    );
    expect(s.slider.focus).toHaveBeenCalledOnce();
  });

  it("refuses when the newest entry is not the one the app calls latest", async () => {
    const s = setup({ pickerEntries: ["GPT-5.7 Pro", "Latest"], pickerCheckedIndex: 0 });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow(/where the newest model is "GPT-5\.7 Pro"/);
  });

  // P-035 2026-09-22. The API catalogue lags the composer -- it still lists
  // GPT-5.5 Pro while the picker offers a newer list -- which is exactly why the
  // catalogue stopped being the anchor. It is read for the account's entitlement
  // and logged for drift, never compared against the composer.
  it("proceeds when the catalogue lags the picker, and says so in the log", async () => {
    fetchModels.mockResolvedValue([{ slug: "gpt-5-5-pro", title: "GPT-5.5 Pro" }]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = setup({ effortLabel: "Extra High", pickerEntries: ["Latest", "GPT-5.6 Sol"] });
      await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "Latest", power: 4 });
      expect(error.mock.calls.flat().join(" ")).toContain('catalogue="GPT-5.5 Pro"');
    } finally {
      error.mockRestore();
    }
  });

  it("refuses when the picker names no selected model", async () => {
    const s = setup({ pickerEmpty: true });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow(/named no selected model/);
  });

  it("refuses whichever model the picker reports once it is not the newest", async () => {
    const s = setup({ pickerEntries: ["Latest", "GPT-5.6 Sol", "GPT-5"], pickerCheckedIndex: 1 });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow(/has "GPT-5\.6 Sol" selected/);
  });

  // Maik, 2026-09-21 13:41: the label must be deterministic on any subscribed
  // account. An account whose catalogue carries no Pro model is the one case
  // where it cannot be, and that must refuse the turn rather than fall through
  // to whatever the composer happens to show.
  it("refuses the turn when the account's catalogue carries no Pro model", async () => {
    fetchModels.mockResolvedValue([{ slug: "gpt-5-5", title: "GPT-5.5" }]);
    const s = setup();
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow(/none is a Pro model/);
    expect(s.slider.focus).toHaveBeenCalledOnce();
  });

  // A catalogue that cannot be read is not evidence of anything, so the retry
  // runs and the turn still refuses rather than admitting a paid turn on a
  // model nobody could name.
  it("retries a catalogue read that comes back empty, then refuses", async () => {
    fetchModels.mockResolvedValue([]);
    const s = setup();
    // P-035 2026-09-21. The refusal must say the READ returned nothing, not that
    // the account has no Pro model: those are different facts, and the second was
    // being stated for the first.
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow(/returned nothing/);
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  // P-035 2026-09-21. The composer pill opens the thinking-effort menu, so
  // tryEnsureModel's model-name search could never match and it warned on every
  // turn. Detecting the effort menu is what lets it stay quiet, and this is the
  // detection: the power slider, counted attached rather than visible because
  // ChatGPT hides it on its ThumbInput span.
  it("identifies the thinking-effort menu by its attached power slider", async () => {
    const page = {
      locator: () => ({ count: async () => 1 }),
    } as unknown as Page;
    await expect(menuIsThinkingEffort(page)).resolves.toBe(true);
  });

  it("does not mistake a menu without a power slider for the effort menu", async () => {
    const page = { locator: () => ({ count: async () => 0 }) } as unknown as Page;
    await expect(menuIsThinkingEffort(page)).resolves.toBe(false);
  });

  it("refuses a missing 6 Pro control before changing any thinking setting", async () => {
    const s = setup();
    requireSelector.mockReset().mockRejectedValue(new Error("6 Pro model missing"));
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow("6 Pro model missing");
    expect(s.slider.focus).not.toHaveBeenCalled();
  });

  // P-035 2026-09-21. The real failure mode is a SelectorBrokenError from the
  // resolver, and it used to propagate verbatim as "ChatGPT UI changed: selector
  // ... no longer resolves" -- asserting a cause the code cannot know (the pill can
  // be absent, present with an off-list label, or on a surface with no Pro tier)
  // and leaving the daemon unable to mark the slot degraded, because
  // server.ts:1343 needs a typed `ev.code`. It must now surface as a proven
  // pre-submit refusal instead.
  it("reports an unresolved 6 Pro control as a typed pre-submit failure, not a UI-change claim", async () => {
    const s = setup();
    requireSelector.mockReset().mockRejectedValue(new SelectorBrokenError("thinking control"));
    await expect(ensureProSixMaximum(s.page)).rejects.toMatchObject({
      code: "model_control_unresolved",
      phase: "model_verification",
      promptSubmitted: false,
    });
    // The lookup precedes the surrounding try/finally, so this path must still
    // prove the menu closed rather than leaving a focus trap behind.
    expect(s.page.evaluate).toHaveBeenCalled();
    expect(s.slider.focus).not.toHaveBeenCalled();
  });

  // The conversion must not swallow anything it does not own.
  it("propagates a non-selector failure from the model-control lookup unchanged", async () => {
    const s = setup();
    requireSelector.mockReset().mockRejectedValue(new Error("browser exploded"));
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow("browser exploded");
    await expect(ensureProSixMaximum(s.page)).rejects.not.toMatchObject({
      code: "model_control_unresolved",
    });
  });

  it("accepts a timed-out activation when the live menu postcondition is already open", async () => {
    const s = setup({ clickTimesOut: true, menuOpened: true });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "Latest", power: 4 });
    expect(s.model.getAttribute).not.toHaveBeenCalled();
  });

  it("emits a typed pre-submit failure when activation times out with no open menu", async () => {
    const s = setup({ clickTimesOut: true, menuOpened: false });
    await expect(ensureProSixMaximum(s.page)).rejects.toMatchObject({
      code: "model_control_activation_timeout",
      phase: "model_verification",
      promptSubmitted: false,
    });
    expect(s.model.getAttribute).toHaveBeenCalledWith("aria-expanded", { timeout: 1_000 });
    expect(s.model.getAttribute).toHaveBeenCalledWith("data-state", { timeout: 1_000 });
  });

  // P-035 2026-09-18. This function opens a menu, so it owes proof the menu
  // closed; the Escape used to be fire-and-forget. It was originally written as
  // the fix for the 2026-09-17T03:36:43Z truncation, and that causal claim was
  // withdrawn the same day (see closeOpenMenus' honesty note): the diagnostic
  // that "showed" the trap is captured after this function runs, and its
  // `inputEvents: 64` on a 64-line prompt rules a mid-insert focus steal out.
  // The postcondition is still owed on its own merits, so the test stays.
  it("proves the thinking menu actually closed instead of assuming Escape worked", async () => {
    const s = setup();
    await ensureProSixMaximum(s.page);
    expect(s.page.keyboard.press).toHaveBeenCalledWith("Escape");
    // The postcondition, not just the keystroke.
    expect(s.page.evaluate).toHaveBeenCalled();
  });

  it("retries Escape and warns, without throwing, when the menu refuses to close", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ menuStaysOpen: true });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "Latest", power: 4 });
    const escapes = (s.page.keyboard.press as unknown as { mock: { calls: string[][] } }).mock.calls
      .filter((call) => call[0] === "Escape").length;
    expect(escapes).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("a menu is still open"));
    warn.mockRestore();
  });

  it("never lets menu cleanup replace the real error", async () => {
    // The close runs from a finally. If it throws, it masks the failure the
    // caller was already reporting -- which is exactly what a page without
    // `evaluate` did before this was guarded.
    const s = setup({ max: null });
    (s.page as unknown as { evaluate: unknown }).evaluate = undefined;
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow("range could not be verified");
  });

  it("reports the exact pending await using fixed labels", async () => {
    const s = setup();
    const onPhase = vi.fn();
    let resume!: () => void;
    s.slider.focus.mockImplementationOnce(() => new Promise<void>((resolve) => { resume = resolve; }));
    const pending = ensureProSixMaximum(s.page, onPhase);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(onPhase).toHaveBeenLastCalledWith("model-slider-focus", undefined, undefined);
    resume();
    await pending;
    expect(onPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "model-control-lookup", "model-control-wait", "model-control-click",
      "model-slider-wait", "model-slider-lookup", "model-slider-maximum",
      "model-slider-minimum", "model-slider-focus", "model-slider-end",
      "model-value-wait", "model-slider-current", "model-selected-lookup",
      "model-selected-text", "model-catalogue-read", "model-cleanup-escape",
      "model-cleanup-menu-count",
    ]);
  });

  it("retains the original failed subphase while menu cleanup is pending", async () => {
    const s = setup();
    const original = new Error("private account/prompt detail");
    s.slider.focus.mockRejectedValueOnce(original);
    let resume!: (value: number) => void;
    vi.mocked(s.page.evaluate).mockImplementationOnce(() => new Promise<number>((resolve) => { resume = resolve; }));
    const onPhase = vi.fn();
    const pending = ensureProSixMaximum(s.page, onPhase);
    const rejected = expect(pending).rejects.toBe(original);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(onPhase).toHaveBeenLastCalledWith("model-cleanup-menu-count", "model-slider-focus", { code: "unclassified_error" });
    expect(JSON.stringify(onPhase.mock.calls)).not.toContain("private");
    resume(0);
    await rejected;
  });

});

// P-035 2026-09-27. Live: the intelli account's picker listed `Latest` (checked),
// `GPT-5.6 Sol`, `GPT-5.5 Leaving on October 14` and a greyed `Pro` whose tooltip
// read `Limit reached. Try again after Sep 30, 2026.` The composer still named
// `Latest`, so nothing the newest-model gate reads changed and the turn died later
// as a false "selector no longer resolves". These are the tests for reading the
// limit off the disabled row itself, before anything is typed or sent.
describe("Pro usage limit in the model picker", () => {
  async function rejection(page: Page): Promise<PreSubmitInteractionError> {
    return ensureProSixMaximum(page).then(
      () => {
        throw new Error("ensureProSixMaximum was expected to refuse");
      },
      (error: unknown) => error as PreSubmitInteractionError,
    );
  }

  it("refuses with a typed pre-submit error and the parsed local availability", async () => {
    const s = setup({
      effortLabel: "Extra High",
      pickerEntries: ["Latest", "GPT-5.6 Sol", "GPT-5.5", "Pro"],
      proIndex: 3,
    });
    const error = await rejection(s.page);
    expect(error).toBeInstanceOf(PreSubmitInteractionError);
    expect(error).toMatchObject({
      code: "pro_usage_limit_reached",
      phase: "model_verification",
      promptSubmitted: false,
    });
    // Date only -> local midnight of Sep 30, carried with the local UTC offset.
    expect(error.availableAfter).toMatch(/^2026-09-30T00:00:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(error.availableAfter!)).toBe(new Date(2026, 8, 30, 0, 0, 0, 0).getTime());
    expect(error.limitText).toBe("Limit reached. Try again after Sep 30, 2026.");
    // Nothing is typed or submitted before the throw.
    expect(s.page.keyboard.type).not.toHaveBeenCalled();
    expect(s.page.keyboard.press).not.toHaveBeenCalledWith("Enter");
  });

  it("parses a long month name and a date-with-time variant as that local time", async () => {
    const s = setup({
      pickerEntries: ["Latest", "Pro"],
      proIndex: 1,
      tooltipText: "Limit reached. Try again after September 30, 2026, 3:45 PM.",
    });
    const error = await rejection(s.page);
    expect(error.code).toBe("pro_usage_limit_reached");
    expect(error.availableAfter).toMatch(/^2026-09-30T15:45:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(error.availableAfter!)).toBe(new Date(2026, 8, 30, 15, 45, 0, 0).getTime());
  });

  it("still refuses with null availability when the tooltip never appears", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, tooltipVisible: false });
    const error = await rejection(s.page);
    expect(error).toMatchObject({
      code: "pro_usage_limit_reached",
      phase: "model_verification",
      promptSubmitted: false,
    });
    // A disabled Pro row alone is sufficient evidence; availability stays unknown.
    expect(error.availableAfter).toBeNull();
    expect(error.limitText).toBeNull();
  });

  it("leaves the existing path untouched when the Pro row is present but enabled", async () => {
    // proIndex undefined -> the probe reports the row is not disabled.
    const s = setup({ pickerEntries: ["Latest", "GPT-5.6 Sol", "GPT-5.5", "Pro"] });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "Latest", power: 4 });
  });

  it("leaves the existing path untouched when the Pro row is absent", async () => {
    const s = setup();
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "Latest", power: 4 });
  });

  it("reports the limit ahead of the newest-model check it runs before", async () => {
    // The picker is on an older model AND Pro is limited. The limit is the real
    // cause, and it is read with the items already enumerated but before the
    // newest-model refusal, so that refusal can never mask it.
    const s = setup({
      pickerEntries: ["Latest", "GPT-5.5", "Pro"],
      pickerCheckedIndex: 1,
      proIndex: 2,
    });
    const error = await rejection(s.page);
    expect(error.code).toBe("pro_usage_limit_reached");
  });

  // --- Passive sources (no pointer at all), P-035 2026-09-27 ----------------
  it("reads the sentence from the disabled row's title without any hover", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, passiveTitle: LIVE_LIMIT_TEXT });
    const error = await rejection(s.page);
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
    expect(error.availableAfter).toMatch(/^2026-09-30T00:00:00[+-]\d{2}:\d{2}$/);
    // Nothing needed a pointer, so neither hover ran.
    expect(s.rowHover).not.toHaveBeenCalled();
    expect(s.ancestorHover).not.toHaveBeenCalled();
  });

  it("reads the sentence from a relevant aria-label on the row", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, passiveAria: LIVE_LIMIT_TEXT });
    const error = await rejection(s.page);
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
    expect(s.rowHover).not.toHaveBeenCalled();
  });

  it("ignores a passive title/aria-label that is only the row's own name", async () => {
    // A bare "Pro" title or label is the row's NAME, not limit text. Only wording
    // that says "Limit reached"/"Try again after" counts, so a benign attribute
    // can never mask the real tooltip and the hover path still runs.
    const s = setup({
      pickerEntries: ["Latest", "Pro"],
      proIndex: 1,
      passiveTitle: "Pro",
      passiveAria: "Pro",
    });
    const error = await rejection(s.page);
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
    expect(s.rowHover).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it("reads the sentence from the element the row's aria-describedby points at", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, describedByText: LIVE_LIMIT_TEXT });
    const error = await rejection(s.page);
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
    expect(error.availableAfter).toMatch(/^2026-09-30T00:00:00[+-]\d{2}:\d{2}$/);
    expect(s.rowHover).not.toHaveBeenCalled();
  });

  it("reads a title from an ancestor inside the menu boundary", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, ancestorTitle: LIVE_LIMIT_TEXT });
    const error = await rejection(s.page);
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
    expect(s.rowHover).not.toHaveBeenCalled();
  });

  // --- Forced-hover sources -------------------------------------------------
  it("finds a tooltip that only appears after the forced row hover", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1 });
    // The tooltip element does not exist yet; the hover itself creates it.
    expect(s.fakeDocument.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
    const error = await rejection(s.page);
    expect(s.rowHover).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
    expect(error.availableAfter).toMatch(/^2026-09-30T00:00:00[+-]\d{2}:\d{2}$/);
    expect(s.fakeDocument.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
  });

  it("falls back to the nearest non-menu ancestor when the row hover yields nothing", async () => {
    const s = setup({
      pickerEntries: ["Latest", "Pro"],
      proIndex: 1,
      tooltipAfterAncestorHoverOnly: true,
    });
    const error = await rejection(s.page);
    expect(s.rowHover).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(s.ancestorHover).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
    expect(error.availableAfter).toMatch(/^2026-09-30T00:00:00[+-]\d{2}:\d{2}$/);
  });

  it("survives a refused row hover and still reads the ancestor's tooltip", async () => {
    const s = setup({
      pickerEntries: ["Latest", "Pro"],
      proIndex: 1,
      rowHoverRejects: true,
      tooltipAfterAncestorHoverOnly: true,
    });
    const error = await rejection(s.page);
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
  });

  it("finds a popper wrapper that is not role=tooltip", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, tooltipTier: "popper" });
    const error = await rejection(s.page);
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
    expect(error.availableAfter).toMatch(/^2026-09-30T00:00:00[+-]\d{2}:\d{2}$/);
  });

  it("finds a [data-side] wrapper that is not role=tooltip", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, tooltipTier: "side" });
    const error = await rejection(s.page);
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
  });

  it("prefers the smallest matching element when no known wrapper carries the sentence", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, fallbackTooltip: true });
    const error = await rejection(s.page);
    // The outer div matches too, but the inner span's shorter text wins, so the
    // recorded sentence is the sentence and not the whole subtree.
    expect(error.limitText).toBe(LIVE_LIMIT_TEXT);
  });

  it("ignores a tooltip that is present but not visible", async () => {
    const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, tooltipHidden: true });
    const error = await rejection(s.page);
    expect(error.limitText).toBeNull();
    expect(error.availableAfter).toBeNull();
  });

  // --- Diagnostics ----------------------------------------------------------
  it("logs one content-free line naming the source and each hover outcome", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = setup({
        pickerEntries: ["Latest", "Pro"],
        proIndex: 1,
        tooltipAfterAncestorHoverOnly: true,
      });
      await rejection(s.page);
      const probe = spy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("pro usage limit probe"));
      expect(probe).toHaveLength(1);
      expect(probe[0]).toContain("source=hover-ancestor");
      expect(probe[0]).toContain("rowHover=resolved");
      expect(probe[0]).toContain("ancestorHover=resolved");
      // The line carries no page text.
      expect(probe[0]).not.toContain("Limit reached");
      expect(probe[0]).not.toContain("Try again after");
    } finally {
      spy.mockRestore();
    }
  });

  it("logs the passive source and skipped hovers when no pointer was needed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = setup({ pickerEntries: ["Latest", "Pro"], proIndex: 1, passiveTitle: LIVE_LIMIT_TEXT });
      await rejection(s.page);
      const probe = spy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("pro usage limit probe"));
      expect(probe).toHaveLength(1);
      expect(probe[0]).toContain("source=passive-title");
      expect(probe[0]).toContain("rowHover=skipped");
      expect(probe[0]).toContain("ancestorHover=skipped");
    } finally {
      spy.mockRestore();
    }
  });
});
