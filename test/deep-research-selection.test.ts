import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { runInNewContext } from "node:vm";
import { PREFLIGHT_CHROME, SELECTORS, joinSelectors } from "../src/browser/selectors.js";

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
const { deepResearchQuota, resetDeepResearchQuota } = await import("../src/browser/deep-research-quota.js");

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
  /**
   * G3-B (sixth run): the composer holds the Deep Research app mention, and
   * this many caret-placed Backspaces remove it (`Infinity`: never).
   */
  mentionRemovedAfter?: number;
  /** G4-C: the hover tooltip's text; absent or null: no tooltip appears. */
  tooltip?: string | null;
} = {}) {
  let mentionPresent = options.mentionRemovedAfter !== undefined;
  let caretPlaced = false;
  let backspaces = 0;
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
    hover: vi.fn(async () => {}),
    click: vi.fn(async () => {
      if (options.normalClickThrows) throw new Error("intercepted");
      // G3-B: the row toggles, so clicking it again turns the mode off.
      if (clickSticks) selected = !selected;
      popoverOpen = false;
    }),
    evaluate: vi.fn(async (callback: (element: HTMLElement) => boolean, arg?: unknown) => {
      // G4-C: the tooltip poll is told by its argument.
      if (arg && typeof arg === "object" && "tooltipSelectors" in arg) {
        return (options.tooltip ?? null) as unknown as boolean;
      }
      const element = {
        closest: () => null,
        click: () => { if (clickSticks) selected = !selected; popoverOpen = false; },
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
      press: vi.fn(async (key: string) => {
        if (key === "End") power = "4";
        else if (key === "Backspace") {
          if (caretPlaced) backspaces += 1;
          caretPlaced = false;
          if (backspaces >= (options.mentionRemovedAfter ?? Infinity)) mentionPresent = false;
        } else popoverOpen = false;
      }),
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
      // G3-B (sixth run): the mention check, which may also place the caret.
      if (keys.includes("mentionSelector")) {
        if (mentionPresent && (arg as { placeCaret: boolean }).placeCaret) caretPlaced = true;
        return mentionPresent;
      }
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

  return { page, plus, toggle, effort, mentionPresent: () => mentionPresent };
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

  it("G4-A: reads the row's remaining counter before the row is clicked", async () => {
    resetDeepResearchQuota();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const test = scenario();
      let clickedBeforeRead = false;
      test.toggle.evaluate.mockImplementationOnce(async () => {
        clickedBeforeRead = test.toggle.click.mock.calls.length > 0;
        return "Deep research\n 5 left" as unknown as boolean;
      });

      await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

      expect(clickedBeforeRead).toBe(false);
      expect(deepResearchQuota()).toMatchObject({ remaining: 5, label: "Deep research 5 left" });
      expect(log.mock.calls.flat()).toContain(
        '[cgpro:deep-research] tools row: remaining=5 label="Deep research 5 left"',
      );
    } finally {
      log.mockRestore();
      resetDeepResearchQuota();
    }
  });

  // P-035 2026-10-03 G4-C. Live: the row's text carries no count; the count
  // is a hover tooltip beside the row (`25 left`).
  describe("G4-C: the row's hover tooltip", () => {
    const tooltipPolls = (toggle: { evaluate: { mock: { calls: unknown[][] } } }) =>
      toggle.evaluate.mock.calls.filter(([, arg]) =>
        !!arg && typeof arg === "object" && "tooltipSelectors" in (arg as object));

    function capture() {
      const lines: string[] = [];
      const log = vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
      return { lines, log };
    }

    it("records the tooltip's count when the row names none, and logs the tooltip line", async () => {
      resetDeepResearchQuota();
      const { lines, log } = capture();
      try {
        const test = scenario({ tooltip: "25 left" });
        test.toggle.evaluate.mockImplementationOnce(async () =>
          "Deep research\nGet a detailed report" as unknown as boolean);

        await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

        expect(test.toggle.hover).toHaveBeenCalledTimes(1);
        expect(deepResearchQuota()).toMatchObject({ remaining: 25, label: "25 left" });
        expect(lines).toContain('[cgpro:deep-research] tools row: remaining=none label="Deep research Get a detailed report"');
        expect(lines).toContain('[cgpro:deep-research] tooltip: remaining=25 label="25 left"');
        expect(tooltipPolls(test.toggle)[0][1]).toMatchObject({
          tooltipSelectors: [...PREFLIGHT_CHROME.deepResearchTooltip],
        });
      } finally {
        log.mockRestore();
        resetDeepResearchQuota();
      }
    });

    it("does not hover when the row already names a count", async () => {
      resetDeepResearchQuota();
      const { lines, log } = capture();
      try {
        const test = scenario({ tooltip: "25 left" });
        test.toggle.evaluate.mockImplementationOnce(async () => "Deep research 5 left" as unknown as boolean);

        await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

        expect(test.toggle.hover).not.toHaveBeenCalled();
        expect(tooltipPolls(test.toggle)).toHaveLength(0);
        expect(deepResearchQuota().remaining).toBe(5);
        expect(lines.some(line => line.includes("tooltip:"))).toBe(false);
      } finally {
        log.mockRestore();
        resetDeepResearchQuota();
      }
    });

    it("keeps remaining null, does not throw and logs tooltip: none when no tooltip appears", async () => {
      resetDeepResearchQuota();
      const { lines, log } = capture();
      try {
        const test = scenario({ tooltip: null });
        test.toggle.evaluate.mockImplementationOnce(async () => "Deep research" as unknown as boolean);

        await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

        expect(test.toggle.hover).toHaveBeenCalledTimes(1);
        // Bounded: 1500 ms in 150 ms polls.
        expect(tooltipPolls(test.toggle).length).toBeGreaterThan(0);
        expect(tooltipPolls(test.toggle).length).toBeLessThanOrEqual(10);
        expect(deepResearchQuota()).toMatchObject({ remaining: null, label: "Deep research" });
        expect(lines).toContain("[cgpro:deep-research] tooltip: none");
      } finally {
        log.mockRestore();
        resetDeepResearchQuota();
      }
    });

    it("logs tooltip: none and still selects when the hover itself fails", async () => {
      resetDeepResearchQuota();
      const { lines, log } = capture();
      try {
        const test = scenario({ tooltip: "25 left" });
        test.toggle.hover.mockRejectedValueOnce(new Error("hover timeout"));
        test.toggle.evaluate.mockImplementationOnce(async () => "Deep research" as unknown as boolean);

        await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

        expect(tooltipPolls(test.toggle)).toHaveLength(0);
        expect(deepResearchQuota().remaining).toBeNull();
        expect(lines).toContain("[cgpro:deep-research] tooltip: none");
        expect(test.toggle.click).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
        resetDeepResearchQuota();
      }
    });

    it("records exhaustion from a tooltip carrying the lighter-version sentence", async () => {
      resetDeepResearchQuota();
      const { lines, log } = capture();
      try {
        const test = scenario({
          tooltip: "Your remaining queries are powered by a lighter version of deep research.",
        });
        test.toggle.evaluate.mockImplementationOnce(async () => "Deep research" as unknown as boolean);

        await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

        expect(deepResearchQuota().exhaustedUntil).not.toBeNull();
        expect(deepResearchQuota().remaining).toBeNull();
        expect(lines).toContain("[cgpro:deep-research] light-version notice: resets_at=none");
      } finally {
        log.mockRestore();
        resetDeepResearchQuota();
      }
    });

    it("still clicks the toggle exactly once, after the hover", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const test = scenario({ tooltip: "25 left" });
        test.toggle.evaluate.mockImplementationOnce(async () => "Deep research" as unknown as boolean);

        await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

        expect(test.toggle.click).toHaveBeenCalledTimes(1);
        expect(test.toggle.hover.mock.invocationCallOrder[0])
          .toBeLessThan(test.toggle.click.mock.invocationCallOrder[0]);
      } finally {
        log.mockRestore();
        resetDeepResearchQuota();
      }
    });

    it("reads the first visible tooltip that is neither the row's popover nor inside the row", async () => {
      const test = scenario({ tooltip: "25 left" });
      test.toggle.evaluate.mockImplementationOnce(async () => "Deep research" as unknown as boolean);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await setDeepResearch(test.page, true);
      } finally {
        log.mockRestore();
        resetDeepResearchQuota();
      }
      const [fn, arg] = tooltipPolls(test.toggle)[0] as [Function, Record<string, unknown>];
      const node = (text: string, extra: Record<string, unknown> = {}) => ({
        innerText: text, getClientRects: () => [{}], contains: () => false, ...extra,
      });
      const row = { getAttribute: (name: string) => name === "aria-describedby" ? "tip-1" : null, contains: () => false };
      const element = { closest: () => row, getAttribute: () => null };
      const popover = node("Deep research Get a detailed report", { contains: (other: unknown) => other === row });
      const hidden = node("hidden", { getClientRects: () => [] });
      const described = node("25 left");
      const byId: Record<string, unknown> = { "tip-1": described };
      const run = (ids: Record<string, unknown>, all: unknown[]) => runInNewContext(`(${fn.toString()})(element, arg)`, {
        element, arg,
        document: { getElementById: (id: string) => ids[id] ?? null, querySelectorAll: () => all },
        window: { getComputedStyle: () => ({ visibility: "visible", display: "block" }) },
      });

      expect(run(byId, [popover])).toBe("25 left");
      expect(run({}, [popover, hidden, node("12 left")])).toBe("12 left");
      expect(run({}, [popover, hidden])).toBeNull();
    });
  });

  it("G4-A: an already-selected chip takes no reading and keeps the previous one", async () => {
    resetDeepResearchQuota();
    const test = scenario({ initiallySelected: true, effortLabel: "6Pro" });

    await expect(setDeepResearch(test.page, true)).resolves.toBe(true);

    expect(test.toggle.evaluate).not.toHaveBeenCalled();
    expect(deepResearchQuota().observedAt).toBeNull();
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
    // G4-A: the first evaluate is the read-only row read, the second the
    // fallback; G4-C's tooltip polls are left out of the count.
    const nonTooltip = test.toggle.evaluate.mock.calls.filter(([, arg]) =>
      !(arg && typeof arg === "object" && "tooltipSelectors" in arg));
    expect(nonTooltip).toHaveLength(2);
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

  // P-035 2026-10-03 G3-B. Live intelli: a failed Deep Research turn left the
  // native chip in the home composer and every preflight refused on it.
  describe("turning native Deep Research off", () => {
    it("makes no click and opens no picker when no chip is present", async () => {
      const test = scenario();

      await expect(setDeepResearch(test.page, false)).resolves.toBe(false);

      expect(test.plus.click).not.toHaveBeenCalled();
      expect(test.toggle.click).not.toHaveBeenCalled();
      expect(test.toggle.evaluate).not.toHaveBeenCalled();
      expect(test.page.keyboard.press).not.toHaveBeenCalled();
    });

    it("clicks the same row to deselect an inherited chip and verifies it is gone", async () => {
      const test = scenario({ initiallySelected: true });

      await expect(setDeepResearch(test.page, false)).resolves.toBe(true);

      expect(test.plus.click).toHaveBeenCalledTimes(1);
      expect(test.toggle.click).toHaveBeenCalledTimes(1);
      expect(test.page.keyboard.press).toHaveBeenCalledWith("Escape");
      // The chip check ran again after the click and found nothing.
      expect(firstResolved).toHaveBeenLastCalledWith(test.page, SELECTORS.deepResearchSelected);
    });

    it("ignores the row's ARIA state and still clicks while the chip shows", async () => {
      // The picker row reports checked; the chip is the only authority.
      const test = scenario({ initiallySelected: true });
      await expect(setDeepResearch(test.page, false)).resolves.toBe(true);
      expect(test.toggle.click).toHaveBeenCalledTimes(1);
    });

    it("deselects through the interactive-row fallback when the click is intercepted", async () => {
      const test = scenario({ initiallySelected: true, normalClickThrows: true });

      await expect(setDeepResearch(test.page, false)).resolves.toBe(true);

      expect(test.toggle.evaluate).toHaveBeenCalledTimes(1);
    });

    it("throws when the chip is still there after the click", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const test = scenario({ initiallySelected: true, clickSticks: false, pickerLabels: ["Deep research"] });

        await expect(setDeepResearch(test.page, false)).rejects.toThrow(
          'ChatGPT native Deep Research could not be turned off; visible entries=["Deep research"]',
        );
      } finally {
        log.mockRestore();
      }
    });

    // P-035 2026-10-03 G3-B (sixth run). Live intelli: the persisted mode can
    // render as an app mention (`@deep-research`) that the chip selectors miss.
    it("removes the app mention with one caret-placed Backspace and returns true", async () => {
      const test = scenario({ mentionRemovedAfter: 1 });

      await expect(setDeepResearch(test.page, false)).resolves.toBe(true);

      expect(test.mentionPresent()).toBe(false);
      expect(test.page.keyboard.press).toHaveBeenCalledTimes(1);
      expect(test.page.keyboard.press).toHaveBeenCalledWith("Backspace");
      // The caret is placed in-page before the key, with the guard's own parts.
      const placements = vi.mocked(test.page.evaluate).mock.calls
        .map(call => call[1] as { placeCaret?: boolean; mentionSelector?: string; pattern?: string })
        .filter(arg => arg?.mentionSelector !== undefined);
      expect(placements.map(arg => arg.placeCaret)).toEqual([false, true, false]);
      expect(placements[0]).toMatchObject({
        mentionSelector: PREFLIGHT_CHROME.deepResearchMention,
        text: PREFLIGHT_CHROME.deepResearchMentionText,
        attributes: [...PREFLIGHT_CHROME.deepResearchMentionAttributes],
        pattern: PREFLIGHT_CHROME.deepResearchMentionPattern,
        composerSelector: joinSelectors(SELECTORS.composer),
      });
      // No chip: the picker was never opened.
      expect(test.plus.click).not.toHaveBeenCalled();
      expect(test.toggle.click).not.toHaveBeenCalled();
    });

    it("tries a second Backspace when the first leaves the mention", async () => {
      const test = scenario({ mentionRemovedAfter: 2 });
      await expect(setDeepResearch(test.page, false)).resolves.toBe(true);
      expect(test.page.keyboard.press).toHaveBeenCalledTimes(2);
    });

    it("throws when the mention is still there after two attempts", async () => {
      const test = scenario({ mentionRemovedAfter: Infinity });

      await expect(setDeepResearch(test.page, false)).rejects.toThrow(
        "ChatGPT native Deep Research mention could not be removed",
      );

      expect(test.page.keyboard.press).toHaveBeenCalledTimes(2);
      expect(test.plus.click).not.toHaveBeenCalled();
    });

    it("removes the mention first and then the chip, still returning true", async () => {
      const test = scenario({ mentionRemovedAfter: 1, initiallySelected: true });
      await expect(setDeepResearch(test.page, false)).resolves.toBe(true);
      expect(test.mentionPresent()).toBe(false);
      expect(test.toggle.click).toHaveBeenCalledTimes(1);
    });

    it("never checks for the mention on the Deep Research on path", async () => {
      const test = scenario({ mentionRemovedAfter: 1 });
      await expect(setDeepResearch(test.page, true)).resolves.toBe(true);
      expect(test.page.keyboard.press).not.toHaveBeenCalledWith("Backspace");
      expect(vi.mocked(test.page.evaluate).mock.calls
        .some(call => (call[1] as { mentionSelector?: string } | undefined)?.mentionSelector !== undefined)).toBe(false);
    });

    it("places the caret directly after the mention inside the focused composer", async () => {
      const test = scenario({ mentionRemovedAfter: 1 });
      await setDeepResearch(test.page, false);
      const call = vi.mocked(test.page.evaluate).mock.calls
        .find(entry => (entry[1] as { placeCaret?: boolean } | undefined)?.placeCaret === true);
      expect(call).toBeDefined();
      const [fn, arg] = call as unknown as [Function, Record<string, unknown>];
      const attributes: Record<string, string> = { "app-mention-path": "deep-research" };
      const mention = { textContent: " Deep-Research ", getAttribute: (name: string) => attributes[name] ?? null };
      const other = { textContent: "canva", getAttribute: () => "canva" };
      const focus = vi.fn();
      const composer = { focus, querySelectorAll: (selector: string) =>
        selector === PREFLIGHT_CHROME.deepResearchMention ? [other, mention] : [] };
      const range = { setStartAfter: vi.fn(), collapse: vi.fn() };
      const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
      const run = (place: boolean) => runInNewContext(`(${fn.toString()})(arg)`, {
        arg: { ...arg, placeCaret: place },
        document: { querySelectorAll: () => [composer], createRange: () => range },
        window: { getSelection: () => selection },
      });

      expect(run(true)).toBe(true);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(range.setStartAfter).toHaveBeenCalledWith(mention);
      expect(range.collapse).toHaveBeenCalledWith(true);
      expect(selection.addRange).toHaveBeenCalledWith(range);
      // Checking only never moves the caret.
      focus.mockClear();
      expect(run(false)).toBe(true);
      expect(focus).not.toHaveBeenCalled();
      // A deep-research text without a matching attribute is not the mention.
      attributes["app-mention-path"] = "canva";
      expect(run(false)).toBe(false);
    });
  });
});
