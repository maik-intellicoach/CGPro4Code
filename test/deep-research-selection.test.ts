import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";

const firstResolved = vi.fn();
const requireSelector = vi.fn();

vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));

const { setDeepResearch } = await import("../src/browser/conversation.js");

function scenario(options: {
  exposed?: boolean;
  clickSticks?: boolean;
  effortExposed?: boolean;
  initiallySelected?: boolean;
  chipExposed?: boolean;
  effortLabel?: "High" | "6Pro";
  normalClickThrows?: boolean;
} = {}) {
  let popoverOpen = false;
  let selected = options.initiallySelected ?? false;
  const exposed = options.exposed ?? true;
  const clickSticks = options.clickSticks ?? true;
  const effortExposed = options.effortExposed ?? true;

  const plus = {
    getAttribute: vi.fn(async (name: string) =>
      name === "aria-expanded" && popoverOpen ? "true" : null),
    click: vi.fn(async () => { popoverOpen = true; }),
  };
  const toggle = {
    getAttribute: vi.fn(async (name: string) =>
      name === "aria-checked" && selected ? "true" : null),
    click: vi.fn(async () => {
      if (options.normalClickThrows) throw new Error("intercepted");
      if (clickSticks) selected = true;
      popoverOpen = false;
    }),
    evaluate: vi.fn(async (callback: (element: HTMLElement) => boolean) => {
      const element = {
        closest: () => null,
        click: () => { if (clickSticks) selected = true; popoverOpen = false; },
      } as unknown as HTMLElement;
      return callback(element);
    }),
  };
  const effort = {
    textContent: vi.fn(async () => options.effortLabel ?? "6Pro"),
    getAttribute: vi.fn(async () => null),
  };
  const page = {
    keyboard: { press: vi.fn(async () => { popoverOpen = false; }) },
    waitForTimeout: vi.fn(async () => {}),
  } as unknown as Page;
  let power = "2";
  requireSelector.mockImplementation(async (_page: Page, _selectors: string[], name: string) => {
    if (name === "native Deep Research") {
      if (popoverOpen && exposed) return toggle;
      throw new Error("native mode unavailable");
    }
    if (name === "selected native Deep Research") {
      if (selected && options.chipExposed !== false) return toggle;
      throw new Error("native mode not selected");
    }
    if (!effortExposed) throw new Error("thinking control unavailable");
    if (name === "thinking control") return { click: vi.fn(async () => {}) };
    if (name === "selected thinking model") return effort;
    if (name === "thinking power") return {
      getAttribute: async (attr: string) => attr === "aria-valuemin" ? "0" : attr === "aria-valuemax" ? "4" : power,
      press: async () => { power = "4"; },
    };
    throw new Error(`Unexpected selector: ${name}`);
  });

  firstResolved.mockImplementation(async (_page: Page, selectors?: string[]) => {
    if (selectors?.some((selector) => selector.includes("composer-plus-btn"))) return plus;
    if (selectors?.some((selector) => selector.includes("form") && selector.includes("Deep research"))) {
      return selected && options.chipExposed !== false && !popoverOpen ? toggle : null;
    }
    if (!selectors || selectors.some((selector) => selector.includes("Deep research"))) {
      return popoverOpen && exposed ? toggle : null;
    }
    return null;
  });

  return { page, plus, toggle, effort };
}

beforeEach(() => { firstResolved.mockReset(); requireSelector.mockReset(); });

describe("native Deep Research selection", () => {
  it("verifies selection from the composer chip after clicking the picker row", async () => {
    const test = scenario();

    await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

    expect(test.toggle.click).toHaveBeenCalledTimes(1);
    expect(test.plus.click).toHaveBeenCalledTimes(1);
    expect(test.page.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("recognizes an already-selected native mode without reopening the picker", async () => {
    const test = scenario({ initiallySelected: true, effortLabel: "6Pro" });

    await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

    expect(test.plus.click).not.toHaveBeenCalled();
    expect(test.toggle.click).not.toHaveBeenCalled();
  });

  it("uses the interactive-row DOM fallback when the normal click is intercepted", async () => {
    const test = scenario({ normalClickThrows: true });

    await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

    expect(test.toggle.click).toHaveBeenCalledTimes(1);
    expect(test.toggle.evaluate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the native Deep Research row is missing", async () => {
    const test = scenario({ exposed: false });

    await expect(setDeepResearch(test.page, true)).rejects.toThrow(
      "native Deep Research is not exposed",
    );
    expect(test.toggle.click).not.toHaveBeenCalled();
  });

  it("fails closed when a click does not activate the native mode", async () => {
    const test = scenario({ clickSticks: false });

    await expect(setDeepResearch(test.page, true)).rejects.toThrow(
      "selection did not become active",
    );
  });

  it("fails closed when maximum native Deep Research capability cannot be verified", async () => {
    const test = scenario({ effortExposed: false });

    await expect(setDeepResearch(test.page, true)).rejects.toThrow(
      "thinking control unavailable",
    );
  });

  it("rejects High even when the native chip is selected and the slider reports maximum", async () => {
    const test = scenario({ initiallySelected: true, effortLabel: "High" });
    await expect(setDeepResearch(test.page, true)).rejects.toThrow("6 Pro is not selected");
  });

  it("also verifies 6 Pro when only the picker reports native mode already selected", async () => {
    const test = scenario({ initiallySelected: true, chipExposed: false, effortLabel: "High" });
    await expect(setDeepResearch(test.page, true)).rejects.toThrow("6 Pro is not selected");
    expect(test.toggle.click).not.toHaveBeenCalled();
  });
});
