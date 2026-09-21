import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { SelectorBrokenError } from "../src/errors.js";

const requireSelector = vi.fn();
const firstResolved = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));
const { ensureProSixMaximum, menuIsThinkingEffort } = await import("../src/browser/conversation.js");

function setup(options: {
  max?: string | null;
  sticks?: boolean;
  modelLabel?: string;
  clickTimesOut?: boolean;
  menuOpened?: boolean;
  openMenus?: number;
  menuStaysOpen?: boolean;
} = {}) {
  let value = "1";
  const model = {
    click: vi.fn(async () => {
      if (options.clickTimesOut) throw new Error("locator.click: Timeout 5000ms exceeded.");
    }),
    getAttribute: vi.fn(async (name: string) => options.menuOpened && name === "data-state" ? "open" : null),
  };
  const selected = { textContent: vi.fn(async () => options.modelLabel === "High" && value === (options.max ?? "4") ? "6Pro" : options.modelLabel ?? "6Pro") };
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
    evaluate: vi.fn(async () => openMenus),
  } as unknown as Page;
  requireSelector.mockResolvedValueOnce(model).mockResolvedValueOnce(slider).mockResolvedValueOnce(selected);
  firstResolved.mockResolvedValue(options.menuOpened ? slider : null);
  return { page, model, slider };
}

beforeEach(() => { requireSelector.mockReset(); firstResolved.mockReset(); });

describe("6 Pro maximum thinking admission", () => {
  it("moves a lower slider value to the observed maximum and verifies it", async () => {
    const s = setup();
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "gpt-6-pro", power: 4 });
    expect(s.slider.focus).toHaveBeenCalledWith({ timeout: 5_000 });
    expect(s.page.keyboard.press).toHaveBeenCalledWith("End");
    expect(s.page.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("uses the live maximum instead of assuming a fixed number", async () => {
    const s = setup({ max: "5" });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "gpt-6-pro", power: 5 });
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

  it("upgrades High to maximum power and verifies the resulting 6 Pro model", async () => {
    const s = setup({ modelLabel: "High" });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "gpt-6-pro", power: 4 });
  });

  it("refuses an older Pro model even when its power is at maximum", async () => {
    const s = setup({ modelLabel: "5.6Pro" });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow("maximum power state is not selected");
    expect(s.slider.focus).toHaveBeenCalledOnce();
  });

  // P-035 2026-09-21. This is the label a live intelli preflight read off the
  // row while the slider sat at 3/3, and the lane failed every turn on it. The
  // top power state's label moved from `6 Pro` to `Extra High`; the menu no
  // longer renders a model name at all.
  it("accepts the label the current UI gives the top power state", async () => {
    const s = setup({ modelLabel: "Extra High" });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "gpt-6-pro", power: 4 });
  });

  // The accepted set is closed, not a prefix match: a label that merely starts
  // like a known top state must not admit a paid turn below maximum power.
  it("refuses a label that is only a prefix of a known top state", async () => {
    const s = setup({ modelLabel: "Extra" });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow("maximum power state is not selected");
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
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "gpt-6-pro", power: 4 });
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
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "gpt-6-pro", power: 4 });
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
      "model-selected-text", "model-cleanup-escape", "model-cleanup-menu-count",
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
