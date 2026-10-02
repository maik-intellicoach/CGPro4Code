import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { SELECTORS, joinSelectors } from "../src/browser/selectors.js";

const firstResolved = vi.fn();
const requireSelector = vi.fn();
const fetchModels = vi.fn();

vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));

// P-035 2026-09-21. Deep Research selection reaches the 6 Pro power gate, whose
// expected composer label now comes from the account's catalogue. Only the
// fetch is stubbed; the matching helpers stay real.
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

const { setDeepResearch } = await import("../src/browser/conversation.js");

function scenario(options: {
  exposed?: boolean;
  clickSticks?: boolean;
  effortExposed?: boolean;
  initiallySelected?: boolean;
  chipExposed?: boolean;
  effortLabel?: "High" | "6Pro";
  normalClickThrows?: boolean;
  flatListOnly?: boolean;
  pickerLabels?: string[];
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
    // P-035 2026-09-22. The row labelled "Select model" is clicked once to open
    // the model list when the effort panel is showing.
    click: vi.fn(async () => {}),
  };
  const page = {
    keyboard: {
      // "End" now drives the thinking-power slider (it is focused first);
      // Escape is what closes the popover.
      press: vi.fn(async (key: string) => { if (key === "End") power = "4"; else popoverOpen = false; }),
    },
    waitForTimeout: vi.fn(async () => {}),
    locator: vi.fn((selector: string) => {
      if (selector !== joinSelectors(SELECTORS.connectorDiagnosticLabels)) {
        throw new Error(`Unexpected diagnostic selector: ${selector}`);
      }
      return { allInnerTexts: vi.fn(async () => options.pickerLabels ?? []) };
    }),
    screenshot: vi.fn(async () => {}),
    // The picker's own checked entry is where the model is read from since
    // 2026-09-22; a selector-string argument is the pointer-blocker count.
    evaluate: vi.fn(async (_fn: unknown, arg: unknown) => {
      if (typeof arg === "string") return 0;
      const keys = arg && typeof arg === "object" ? Object.keys(arg) : [];
      if (keys.includes("selectedSelector")) return "row=\"6Pro\" menus=1 menuItems=[] sliders=[4/4]";
      return { entries: options.pickerEntries ?? ["Latest", "GPT-5.6 Sol"], checkedIndex: 0 };
    }),
  } as unknown as Page;
  let power = "2";
  requireSelector.mockImplementation(async (_page: Page, selectors: string[], name: string) => {
    if (name === "native Deep Research") {
      const rowFound = !options.flatListOnly || selectors.some((selector) =>
        selector === 'button[data-list-navigation-item]:has-text("Deep research")');
      if (popoverOpen && exposed && rowFound) return toggle;
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
      // Focused, then driven by the keyboard: ChatGPT's role="slider" span is
      // hidden, so `press()` would wait on an actionability check it can never
      // pass (P-035 2026-09-16).
      focus: async () => {},
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

beforeEach(() => {
  firstResolved.mockReset();
  requireSelector.mockReset();
  fetchModels.mockReset();
  fetchModels.mockResolvedValue([{ slug: "gpt-6-pro", title: "6 Pro" }]);
});

describe("native Deep Research selection", () => {
  it("finds and selects a flat-list button row and verifies its composer chip", async () => {
    const test = scenario({ flatListOnly: true });

    await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

    expect(test.toggle.click).toHaveBeenCalledTimes(1);
    expect(requireSelector).toHaveBeenCalledWith(
      test.page, SELECTORS.deepResearchSelected, "selected native Deep Research", 8_000,
    );
  });

  it("includes bounded visible labels in the not-exposed error with debug unset", async () => {
    vi.stubEnv("CGPRO_DEBUG", undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const test = scenario({
        exposed: false,
        pickerLabels: ["  Web\n search  ", " ", "x".repeat(140), ...Array(35).fill("Apps")],
      });
      const labels = ["Web search", "x".repeat(120), ...Array(28).fill("Apps")];

      await expect(setDeepResearch(test.page, true)).rejects.toThrow(
        `not exposed in the composer tool picker; visible entries=${JSON.stringify(labels)}`,
      );
      expect(test.page.locator).toHaveBeenCalledTimes(1);
      expect(test.page.screenshot).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join(" ")).not.toContain("deep-research-nodes");
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });

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

  // P-035 2026-10-03: r3 found and clicked the row, then missed the chip. The
  // miss must name what the composer showed, as the not-exposed path does.
  it("names the visible composer entries when the chip check misses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const test = scenario({ clickSticks: false, pickerLabels: ["Deep research", "Pro"] });

      await expect(setDeepResearch(test.page, true)).rejects.toThrow(
        'selection did not become active; visible entries=["Deep research","Pro"]',
      );
    } finally {
      log.mockRestore();
    }
  });

  it("fails closed when maximum native Deep Research capability cannot be verified", async () => {
    const test = scenario({ effortExposed: false });

    await expect(setDeepResearch(test.page, true)).rejects.toThrow(
      "thinking control unavailable",
    );
  });

  it("rejects High even when the native chip is selected and the slider reports maximum", async () => {
    const test = scenario({ initiallySelected: true, effortLabel: "High" });
    await expect(setDeepResearch(test.page, true)).rejects.toThrow(/composer shows "High"/);
  });

  it("also verifies 6 Pro when only the picker reports native mode already selected", async () => {
    const test = scenario({ initiallySelected: true, chipExposed: false, effortLabel: "High" });
    await expect(setDeepResearch(test.page, true)).rejects.toThrow(/composer shows "High"/);
    expect(test.toggle.click).not.toHaveBeenCalled();
  });
});
