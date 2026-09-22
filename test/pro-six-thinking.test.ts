import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { SelectorBrokenError } from "../src/errors.js";

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
  // P-035 2026-09-18: `evaluate` is part of the real page shape and the menu
  // close postcondition needs it. Without it the fake made every path throw
  // "page.evaluate is not a function" from inside a finally, which masked the
  // real assertion. openMenus counts what is still open after each Escape.
  let openMenus = options.openMenus ?? 1;
  const page = {
    keyboard: { press: vi.fn(async (key: string) => {
      if (key === "End" && options.sticks !== false) value = options.max ?? "4";
      if (key === "Escape" && !options.menuStaysOpen) openMenus = 0;
    }) },
    waitForTimeout: vi.fn(async () => {}),
    // Three probes share this entry point on the real page, told apart by
    // argument shape: the pointer-blocker count takes a selector string, the
    // picker read takes `{ max }`, and the menu dump takes
    // `{ selectedSelector, max }` and returns prose.
    evaluate: vi.fn(async (_fn: unknown, arg: unknown) => {
      if (typeof arg === "string") return openMenus;
      const keys = arg && typeof arg === "object" ? Object.keys(arg) : [];
      if (keys.includes("selectedSelector")) return "row=\"6 Pro\" menus=1 menuItems=[] sliders=[4/4]";
      if (options.pickerEmpty) return { entries: [], checkedIndex: -1 };
      return {
        entries: options.pickerEntries ?? ["Latest", "GPT-5.6 Sol", "GPT-5.5"],
        checkedIndex: options.pickerCheckedIndex ?? 0,
      };
    }),
  } as unknown as Page;
  requireSelector.mockResolvedValueOnce(model).mockResolvedValueOnce(slider).mockResolvedValueOnce(selected);
  firstResolved.mockResolvedValue(options.menuOpened ? slider : null);
  return { page, model, slider, selected };
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
