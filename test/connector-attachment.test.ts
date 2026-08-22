import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";

// P-035: connector selection must be an honest composer-attachment
// postcondition. A visible exact-label row (often a plain span with no ARIA
// role) can accept a click without ChatGPT attaching the connector; the
// post-click verifier inside conversation.ts must reject that false state
// before setConnector returns, so the orchestrator cannot emit
// `connector-selected` and submit a prompt with no connector.
//
// firstResolved powers the "+" popover reopen (openComposerToolsPopover);
// requireSelector returns the composer root. Both live in chatgpt.js, so the
// test mocks that module and drives setConnector with a stateful Page fake.

interface FakeRow {
  label: string;
  visible: boolean;
  /** Accessible attributes the row reports via getAttribute. */
  attrs?: Record<string, string | null>;
  /** Invoked when the picker row is clicked (e.g. "the picker closes"). */
  onSelected?: () => void;
}

const firstResolved = vi.fn();
const plus = {
  getAttribute: vi.fn(async () => null),
  click: vi.fn(async () => {}),
};

vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: vi.fn(async () => ({ click: vi.fn(async () => {}) })),
}));

const { setConnector } = await import("../src/browser/conversation.js");

beforeEach(() => {
  firstResolved.mockReset();
  plus.getAttribute.mockReset();
  plus.click.mockReset();
  plus.getAttribute.mockResolvedValue(null); // "+" popover starts closed
  plus.click.mockResolvedValue(undefined);
  firstResolved.mockImplementation(async (_page: unknown, selectors: unknown) => {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    return list.some((s) => typeof s === "string" && s.includes("composer-plus-btn"))
      ? plus
      : null;
  });
});

/**
 * Stateful fake Page: `page.locator(...)` always reflects the currently
 * mounted tool rows. The test swaps rows between phases (picker open, picker
 * dismissed, "+" popover open) exactly like the DOM would after a click or a
 * popover open, instead of inventing a selector-specific fake.
 */
function makePage() {
  let rows: FakeRow[] = [];
  let devMode = false;
  let devSelect: (() => void) | null = null;

  const page = {
    keyboard: {
      press: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {}),
    clickedLabels: [] as string[],
    locator: () => makeCandidates(),
  } as unknown as Page & { keyboard: { press: ReturnType<typeof vi.fn> } };

  const rowLoc = (row: FakeRow | undefined) => ({
    count: async () => (row ? 1 : 0),
    isVisible: async () => row?.visible ?? false,
    innerText: async () => row?.label ?? "",
    getAttribute: async (attr: string) => row?.attrs?.[attr] ?? null,
    click: async () => {
      if (row) {
        page.clickedLabels.push(row.label);
        await row.onSelected?.();
      }
    },
  });

  const devLoc = () => ({
    count: async () => (devMode ? 1 : 0),
    isVisible: async () => devMode,
    click: async () => {
      await devSelect?.();
    },
  });

  const makeCandidates = () => ({
    count: async () => rows.length,
    nth: (i: number) => rowLoc(rows[i]),
    filter: () => ({ first: () => devLoc() }),
    getAttribute: async () => null,
    isVisible: async () => false,
    innerText: async () => "",
    click: async () => {},
  });

  return {
    page,
    setRows(next: FakeRow[]): void {
      rows = next;
    },
    /** When enabled, the composer "+" popover surfaces a "Developer mode" entry. */
    setDevMode(on: boolean, onSelect: () => void): void {
      devMode = on;
      devSelect = onSelect;
    },
  };
}

describe("connector selection honest attachment (P-035)", () => {
  it("rejects when an exact-label click lands but no connector becomes attached", async () => {
    const scenario = makePage();
    // The @ picker row is visible and accepts the click, but after the click
    // the row still reports no attached state (the concrete wrong state from
    // the evidence packet).
    scenario.setRows([{ label: "IntelliCoach Context", visible: true, attrs: {} }]);
    const { page } = scenario;

    await expect(setConnector(page, "IntelliCoach Context")).rejects.toThrow(
      /never became attached to the composer/,
    );

    expect(page.clickedLabels).toEqual(["IntelliCoach Context"]); // the click DID land
    expect(firstResolved).not.toHaveBeenCalled(); // no "+" reopen: the stale row was still mounted
  });

  it("accepts the requested connector when its attached state appears after the click", async () => {
    const scenario = makePage();
    scenario.setRows([
      {
        label: "IntelliCoach Context",
        visible: true,
        attrs: {},
        onSelected: () => scenario.setRows([]), // successful click dismisses the picker
      },
    ]);
    plus.click.mockImplementation(async () => {
      // The "+" popover opens and the exact connector row reports attached.
      scenario.setRows([{ label: "IntelliCoach Context", visible: true, attrs: { "aria-checked": "true" } }]);
    });
    const { page } = scenario;

    await expect(setConnector(page, "IntelliCoach Context")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual(["IntelliCoach Context"]);
    expect(plus.click).toHaveBeenCalledTimes(1); // verifier reopened the popover once
    expect(page.keyboard.press).toHaveBeenCalledWith("Escape"); // popover closed after verify
  });

  it("accepts a connector already attached before the click without toggling it", async () => {
    const scenario = makePage();
    scenario.setRows([
      { label: "p035-low-risk-workstation", visible: true, attrs: { "aria-pressed": "true" } },
    ]);
    const { page } = scenario;

    await expect(setConnector(page, "p035-low-risk-workstation")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual([]); // attached row was never clicked
    expect(page.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("keeps exact-name matching when an attached exact row and a suffixed lookalike are both visible", async () => {
    const scenario = makePage();
    scenario.setRows([
      { label: "IntelliCoach Context backup", visible: true, attrs: {} },
      { label: "IntelliCoach Context", visible: true, attrs: { "data-state": "checked" } },
    ]);
    const { page } = scenario;

    await expect(setConnector(page, "IntelliCoach Context")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual([]); // the lookalike was never resolved, let alone clicked
    expect(page.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("verifies an MCP connector surfaced behind Developer mode in the composer popover", async () => {
    const scenario = makePage();
    scenario.setRows([
      {
        label: "p035-low-risk-workstation",
        visible: true,
        attrs: {},
        onSelected: () => scenario.setRows([]),
      },
    ]);
    plus.click.mockImplementation(async () => {
      scenario.setRows([]); // the popover only offers the Developer mode entry
    });
    scenario.setDevMode(true, () => {
      scenario.setRows([
        { label: "p035-low-risk-workstation", visible: true, attrs: { "aria-checked": "true" } },
      ]);
    });
    const { page } = scenario;

    await expect(setConnector(page, "p035-low-risk-workstation")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual(["p035-low-risk-workstation"]);
    expect(plus.click).toHaveBeenCalledTimes(1);
  });
});
