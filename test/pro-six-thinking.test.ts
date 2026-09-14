import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";

const requireSelector = vi.fn();
const firstResolved = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));
const { ensureProSixMaximum } = await import("../src/browser/conversation.js");

function setup(options: {
  max?: string | null;
  sticks?: boolean;
  modelLabel?: string;
  clickTimesOut?: boolean;
  menuOpened?: boolean;
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
    press: vi.fn(async () => { if (options.sticks !== false) value = options.max ?? "4"; }),
  };
  const page = {
    keyboard: { press: vi.fn(async () => {}) },
    waitForTimeout: vi.fn(async () => {}),
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
    expect(s.slider.press).toHaveBeenCalledWith("End", { timeout: 5_000 });
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
    expect(s.slider.press).not.toHaveBeenCalled();
  });

  it("upgrades High to maximum power and verifies the resulting 6 Pro model", async () => {
    const s = setup({ modelLabel: "High" });
    await expect(ensureProSixMaximum(s.page)).resolves.toEqual({ model: "gpt-6-pro", power: 4 });
  });

  it("refuses an older Pro model even when its power is at maximum", async () => {
    const s = setup({ modelLabel: "5.6Pro" });
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow("6 Pro is not selected");
    expect(s.slider.press).toHaveBeenCalledOnce();
  });

  it("refuses a missing 6 Pro control before changing any thinking setting", async () => {
    const s = setup();
    requireSelector.mockReset().mockRejectedValue(new Error("6 Pro model missing"));
    await expect(ensureProSixMaximum(s.page)).rejects.toThrow("6 Pro model missing");
    expect(s.slider.press).not.toHaveBeenCalled();
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
});
