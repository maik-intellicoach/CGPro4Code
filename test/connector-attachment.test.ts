import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { Locator, Page } from "patchright";

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
  /** Nearest enclosing row, resolved via `locator("..")` (acceptance DOM shape). */
  parent?: FakeRow;
  /** Invoked when the picker row is clicked (e.g. "the picker closes"). */
  onSelected?: () => void;
  /** Exact-label pill mounted in the same form as the prompt textarea. */
  inComposer?: boolean;
  /** P-035 2026-10-05. Entry in the left rail (Customize > Plugins). */
  inNav?: boolean;
  /** P-035 2026-10-05. Href of the nearest enclosing anchor, if any. */
  href?: string;
  /** Distinguishes same-label rows in `clickedLabels`. */
  id?: string;
}

/** DOM `closest` over a fake row, for the selectors the lookups use. */
function fakeClosest(row: FakeRow, selector: string): unknown {
  if (selector === "form") return row.inComposer ? { querySelector: () => ({}) } : null;
  if (selector.includes("nav")) return row.inNav ? {} : null;
  if (selector.includes("/plugins/")) return row.href?.includes("/plugins/") ? {} : null;
  return null;
}

const firstResolved = vi.fn();
const plus = {
  getAttribute: vi.fn(async () => null),
  click: vi.fn(async () => {}),
};

vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  // P-035 2026-10-05. The composer is focused in-page, never clicked.
  requireSelector: vi.fn(async () => ({ click: vi.fn(async () => {}), evaluate: vi.fn(async () => true) })),
}));

const { attachedState, setConnector } = await import("../src/browser/conversation.js");

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
  const innerTextReads: string[] = [];
  let roundTrips = 0;

  const page = {
    keyboard: {
      press: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {}),
    url: () => "https://chatgpt.com/g/g-p-test/project",
    clickedLabels: [] as string[],
    locator: () => makeCandidates(),
  } as unknown as Page & { keyboard: { press: ReturnType<typeof vi.fn> } };

  const rowLoc = (row: FakeRow | undefined) => ({
    count: async () => (row ? 1 : 0),
    isVisible: async () => {
      roundTrips++;
      return row?.visible ?? false;
    },
    innerText: async () => {
      roundTrips++;
      if (row) innerTextReads.push(row.label);
      return row?.label ?? "";
    },
    getAttribute: async (attr: string) => {
      roundTrips++;
      return row?.attrs?.[attr] ?? null;
    },
    // One in-page pass over a DOM-like stand-in, mirroring Playwright's evaluate.
    evaluate: async <R, A>(fn: (element: unknown, arg: A) => R, arg: A): Promise<R> => {
      roundTrips++;
      if (!row) throw new Error("locator.evaluate: Timeout exceeded");
      return fn(domRow(row), arg);
    },
    locator: () => rowLoc(row?.parent),
    click: async () => {
      if (row) {
        page.clickedLabels.push(row.id ?? row.label);
        await row.onSelected?.();
      }
    },
  });

  const domRow = (row: FakeRow): unknown => ({
    getAttribute: (attr: string) => row.attrs?.[attr] ?? null,
    get parentElement() {
      return row.parent ? domRow(row.parent) : null;
    },
    closest: (selector: string) => fakeClosest(row, selector),
  });

  const devLoc = () => ({
    count: async () => (devMode ? 1 : 0),
    isVisible: async () => devMode,
    click: async () => {
      await devSelect?.();
    },
  });

  const makeCandidates = (sourceRows = rows) => ({
    count: async () => sourceRows.length,
    // Failure diagnostics now read picker labels even without CGPRO_DEBUG.
    allInnerTexts: async () => sourceRows.filter((row) => row.visible).map((row) => row.label),
    nth: (i: number) => rowLoc(sourceRows[i]),
    // One in-page pass over DOM-like stand-ins, mirroring Playwright's evaluateAll.
    evaluateAll: async <R, A>(fn: (elements: unknown[], arg: A) => R, arg: A): Promise<R> => {
      roundTrips++;
      return fn(sourceRows.map((row) => ({
        getBoundingClientRect: () => (row.visible ? { width: 10, height: 10 } : { width: 0, height: 0 }),
        checkVisibility: () => row.visible,
        closest: (selector: string) => fakeClosest(row, selector),
        get innerText() {
          innerTextReads.push(row.label);
          return row.label;
        },
      })), arg);
    },
    filter: (options?: { hasText?: string | RegExp }) => {
      if (typeof options?.hasText === "string") {
        const expected = options.hasText.toLocaleLowerCase();
        return makeCandidates(sourceRows.filter((row) => row.label.toLocaleLowerCase().includes(expected)));
      }
      return { first: () => devLoc() };
    },
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
    innerTextReads,
    get roundTrips(): number {
      return roundTrips;
    },
  };
}

describe("connector selection honest attachment (P-035)", () => {
  it("prefilters unrelated DOM rows before reading their text", async () => {
    const scenario = makePage();
    scenario.setRows([
      ...Array.from({ length: 1_000 }, (_, i) => ({ label: `Unrelated row ${i}`, visible: true })),
      { label: "p035-low-risk-workstation", visible: true, attrs: { "aria-checked": "true" } },
    ]);

    await expect(setConnector(scenario.page, "p035-low-risk-workstation")).resolves.toBeUndefined();

    expect(scenario.innerTextReads).toEqual(["p035-low-risk-workstation"]);
  });

  it("finds the row in bounded round trips when chat previews also contain the name", async () => {
    const scenario = makePage();
    scenario.setRows([
      ...Array.from({ length: 500 }, (_, i) => ({
        label: `@p035-low-risk-workstation SYSTEM: earlier Project chat ${i}`,
        visible: true,
      })),
      { label: "p035-low-risk-workstation", visible: true, attrs: { "aria-checked": "true" } },
    ]);

    await expect(setConnector(scenario.page, "p035-low-risk-workstation")).resolves.toBeUndefined();

    expect(scenario.roundTrips).toBeLessThan(20);
  });

  it("reads a row's attached state in one round trip, not one per attribute and ancestor", async () => {
    const scenario = makePage();
    const row = {
      label: "p035-low-risk-workstation",
      visible: true,
      parent: { label: "", visible: true, parent: { label: "", visible: true, parent: {
        label: "", visible: true, attrs: { "aria-checked": "true" },
      } } },
    };
    scenario.setRows([row]);
    const before = scenario.roundTrips;

    await expect(attachedState(scenario.page.locator("span").nth(0) as unknown as Locator)).resolves.toBe("true");

    expect(scenario.roundTrips - before).toBe(1);
  });

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

  it("accepts the exact connector pill mounted in the composer after the picker closes", async () => {
    const scenario = makePage();
    scenario.setRows([
      {
        label: "p035-low-risk-workstation",
        visible: true,
        attrs: {},
        onSelected: () => scenario.setRows([
          {
            label: "p035-low-risk-workstation",
            visible: true,
            attrs: {},
            inComposer: true,
          },
        ]),
      },
    ]);
    const { page } = scenario;

    await expect(setConnector(page, "p035-low-risk-workstation")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual(["p035-low-risk-workstation"]);
    expect(firstResolved).not.toHaveBeenCalled();
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

  it("accepts a directly attached row before entering Developer mode (F1)", async () => {
    const scenario = makePage();
    scenario.setRows([
      {
        label: "IntelliCoach Context",
        visible: true,
        attrs: {},
        onSelected: () => scenario.setRows([]), // successful click dismisses the picker
      },
    ]);
    let devEntered = false;
    plus.click.mockImplementation(async () => {
      // The reopened popover contains BOTH the exact checked row and a
      // visible Developer-mode entry whose click would clear the rows.
      scenario.setRows([{ label: "IntelliCoach Context", visible: true, attrs: { "aria-checked": "true" } }]);
    });
    scenario.setDevMode(true, () => {
      devEntered = true;
      scenario.setRows([]); // Developer mode clears the direct row (F1 false-negative shape)
    });
    const { page } = scenario;

    await expect(setConnector(page, "IntelliCoach Context")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual(["IntelliCoach Context"]);
    expect(devEntered).toBe(false); // Developer mode was never entered
    expect(plus.click).toHaveBeenCalledTimes(1);
    expect(page.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("accepts an exact label whose enclosing row reports the attached state (acceptance DOM shape)", async () => {
    const scenario = makePage();
    scenario.setRows([
      {
        label: "p035-low-risk-workstation",
        visible: true,
        attrs: {}, // plain label span: no state attributes of its own
        onSelected: () => scenario.setRows([]), // successful click dismisses the picker
      },
    ]);
    plus.click.mockImplementation(async () => {
      // The reopened popover renders the exact label as a plain span while
      // its enclosing interactive row carries the attached state (the live
      // lane-1 acceptance shape that previously failed).
      scenario.setRows([
        {
          label: "p035-low-risk-workstation",
          visible: true,
          attrs: {},
          parent: {
            label: "p035-low-risk-workstation row",
            visible: true,
            attrs: { "aria-checked": "true" },
          },
        },
      ]);
    });
    const { page } = scenario;

    await expect(setConnector(page, "p035-low-risk-workstation")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual(["p035-low-risk-workstation"]);
    expect(plus.click).toHaveBeenCalledTimes(1); // popover reopened once
    expect(page.keyboard.press).toHaveBeenCalledWith("Escape"); // accepted via the enclosing row state
  });

  it("rejects when the nearest state-bearing ancestor is unchecked even if a farther ancestor is checked", async () => {
    const scenario = makePage();
    scenario.setRows([
      {
        label: "p035-low-risk-workstation",
        visible: true,
        attrs: {},
        onSelected: () => scenario.setRows([]), // successful click dismisses the picker
      },
    ]);
    plus.click.mockImplementation(async () => {
      // The reopened popover: the exact label span has no state; its parent
      // row reports aria-checked=false; its grandparent reports true. The
      // nearest state-bearing ancestor wins: unchecked => reject, never
      // overridden by the farther checked ancestor.
      scenario.setRows([
        {
          label: "p035-low-risk-workstation",
          visible: true,
          attrs: {},
          parent: {
            label: "p035-low-risk-workstation row",
            visible: true,
            attrs: { "aria-checked": "false" },
            parent: {
              label: "p035-low-risk-workstation container",
              visible: true,
              attrs: { "aria-checked": "true" },
            },
          },
        },
      ]);
    });
    const { page } = scenario;

    await expect(setConnector(page, "p035-low-risk-workstation")).rejects.toThrow(
      /never became attached to the composer/,
    );

    expect(page.clickedLabels).toEqual(["p035-low-risk-workstation"]);
    expect(plus.click).toHaveBeenCalledTimes(1); // popover reopened once
  });
});

it("re-resolves a replaced picker row without replaying the stale locator", async () => {
  const { page, setRows } = makePage();
  const attached: FakeRow = { label: "connector", visible: true, attrs: { "aria-checked": "true" } };
  const replacement: FakeRow = { label: "connector", visible: true, onSelected: () => setRows([attached]) };
  setRows([{ label: "connector", visible: true, onSelected: () => {
    setRows([replacement]);
    throw new Error("locator.click: Timeout 5000ms exceeded.");
  } }]);
  await expect(setConnector(page, "connector")).resolves.toBeUndefined();
  expect(page.clickedLabels).toEqual(["connector", "connector"]);
});

it("does not toggle off an attachment that mounted during a timed-out click", async () => {
  const { page, setRows } = makePage();
  setRows([{ label: "connector", visible: true, onSelected: () => {
    setRows([{ label: "connector", visible: true, attrs: { "aria-checked": "true" } }]);
    throw new Error("locator.click: Timeout 5000ms exceeded.");
  } }]);
  await expect(setConnector(page, "connector")).resolves.toBeUndefined();
  expect(page.clickedLabels).toEqual(["connector"]);
});

it("recognizes an unmarked composer pill after a timed-out click", async () => {
  const { page, setRows } = makePage();
  setRows([{ label: "connector", visible: true, onSelected: () => {
    setRows([{ label: "connector", visible: true, inComposer: true,
      onSelected: () => { throw new Error("mounted pill must not be clicked"); } }]);
    throw new Error("locator.click: Timeout 5000ms exceeded.");
  } }]);
  await expect(setConnector(page, "connector")).resolves.toBeUndefined();
  expect(page.clickedLabels).toEqual(["connector"]);
});

it("names why a timed-out connector click stalled, from the call log's last lines", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { page, setRows } = makePage();
  setRows([{ label: "connector", visible: true, onSelected: () => {
    setRows([{ label: "connector", visible: true, inComposer: true }]);
    throw new Error("locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator\n"
      + "  - attempting click action\n  - element is not stable");
  } }]);
  await expect(setConnector(page, "connector")).resolves.toBeUndefined();
  expect(stderr).toHaveBeenCalledWith(
    "[cgpro:connector] click-timeout attempt=1 reason=- attempting click action | - element is not stable");
  stderr.mockRestore();
});

it("emits a typed pre-submit failure after two timed-out clicks with no attachment", async () => {
  const { page, setRows } = makePage();
  const replacement: FakeRow = {
    label: "connector",
    visible: true,
    onSelected: () => { throw new Error("locator.click: Timeout 5000ms exceeded."); },
  };
  setRows([{
    label: "connector",
    visible: true,
    onSelected: () => {
      setRows([replacement]);
      throw new Error("locator.click: Timeout 5000ms exceeded.");
    },
  }]);
  await expect(setConnector(page, "connector")).rejects.toMatchObject({
    code: "connector_control_activation_timeout",
    phase: "connector_selection",
    promptSubmitted: false,
  });
  expect(page.clickedLabels).toEqual(["connector", "connector"]);
});

describe("picker reads are bounded (P-035 2026-09-23)", () => {
  // Playwright waits for a locator that does not resolve until its timeout,
  // 30 s by default, and a picker row the app closed or re-rendered never
  // resolves on its own. The fake keeps exactly that contract: the read
  // settles only when the caller's timeout (default 30 s) runs out.
  function staleRow(): { row: Locator; reads: Array<number | undefined> } {
    const reads: Array<number | undefined> = [];
    const row = {
      evaluate: (_fn: unknown, _arg: unknown, options?: { timeout?: number }) => {
        reads.push(options?.timeout);
        return new Promise<string | null>((_, reject) => {
          setTimeout(() => reject(new Error("locator.evaluate: Timeout exceeded")), options?.timeout ?? 30_000);
        });
      },
      locator: () => row,
    };
    return { row: row as unknown as Locator, reads };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("attachedState gives up on a row that never resolves within about 1 s, in one read", async () => {
    vi.useFakeTimers();
    const { row, reads } = staleRow();
    let result: string | null | "pending" = "pending";
    void attachedState(row).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(result).toBeNull();
    expect(reads).toEqual([1_000]);
  });
});


it("preflight connector selection refuses before its first destructive input", async () => {
  const { page } = makePage();
  page.evaluate = vi.fn(async () => false) as typeof page.evaluate;
  await expect(setConnector(page, "connector", true)).rejects.toMatchObject({ code: "preflight_draft_protected" });
  expect(page.keyboard.press).not.toHaveBeenCalled();
  expect(page.keyboard.type).not.toHaveBeenCalled();
});

it("preflight connector fallback preserves a draft arriving during the picker wait", async () => {
  const { page } = makePage();
  let readableEmpty = true;
  page.evaluate = vi.fn(async () => readableEmpty) as typeof page.evaluate;
  vi.mocked(page.waitForTimeout).mockImplementation(async () => { readableEmpty = false; });
  await expect(setConnector(page, "connector", true)).rejects.toMatchObject({ code: "preflight_draft_protected" });
  expect(vi.mocked(page.keyboard.press).mock.calls.filter(([key]) => key === "Backspace")).toHaveLength(1);
});

// P-035 2026-09-28 r20. The three pre-attach guards in `setConnector` judged the
// surface with no connector identity, so the lane's own persisted chip refused
// `connector_unowned` before the steps that clear it. They now carry the trimmed
// connector argument. The synthetic DOM below runs the real admission closure
// against exactly that surface.
function installChipGuardDom(page: Page, chip: string, typed = ""): void {
  page.evaluate = vi.fn(async (fn: Function, arg: { selector?: string }) => {
    if (typeof arg === "string" || !arg?.selector) return false;
    let chipMounted = true;
    const clone = () => {
      const token = {
        tagName: "SPAN",
        textContent: chip,
        parentElement: null,
        closest: () => token,
        remove: () => { chipMounted = false; },
      };
      return {
        get textContent() { return (chipMounted ? chip : "") + typed; },
        querySelectorAll: (selector: string) =>
          selector === "*" ? [] : chipMounted ? [token] : [],
      };
    };
    const form = { querySelector: () => null, querySelectorAll: () => [] };
    const composer = {
      isConnected: true, getClientRects: () => [{}],
      get innerText() { return (chipMounted ? chip : "") + typed; },
      closest: () => form, contains: () => false,
      cloneNode: () => clone(),
    };
    const document = {
      querySelectorAll: (selector: string) => selector === 'input[type="file"]' ? [] : [composer],
      createTreeWalker: () => ({ nextNode: () => false }),
    };
    return runInNewContext(`(${fn.toString()})(arg)`, {
      arg, document, location: new URL("https://chatgpt.com/"), HTMLTextAreaElement: class {}, NodeFilter: { SHOW_TEXT: 4 },
    });
  }) as typeof page.evaluate;
}

it("preflight connector selection clears its own chip-only composer", async () => {
  const scenario = makePage();
  installChipGuardDom(scenario.page, "lane-x");
  // The already-attached branch stops right after the picker resolves, so the
  // presses recorded are exactly the pre-attach clear plus its dismiss.
  scenario.setRows([{ label: "lane-x", visible: true, attrs: { "aria-checked": "true" } }]);
  await expect(setConnector(scenario.page, "lane-x", true)).resolves.toBeUndefined();
  expect(vi.mocked(scenario.page.keyboard.press).mock.calls.map(([key]) => key))
    .toEqual(["Meta+A", "Backspace", "Escape"]);
  expect(vi.mocked(scenario.page.keyboard.type).mock.calls.map(([text]) => text)).toEqual(["@"]);
});

it("preflight connector selection refuses a chip plus typed text before Meta+A", async () => {
  const scenario = makePage();
  installChipGuardDom(scenario.page, "lane-x", "private draft beside the chip");
  const error = await setConnector(scenario.page, "lane-x", true).catch(caught => caught);
  expect(error).toMatchObject({ code: "preflight_draft_protected", reason: "text_present" });
  expect(scenario.page.keyboard.press).not.toHaveBeenCalled();
  expect(scenario.page.keyboard.type).not.toHaveBeenCalled();
});

// P-035 2026-09-28 r33. Live intelli 06:21: the found-connector branch ran
// `clickConnector` (first-click-threw, then attempt=1 and attempt=2) and threw,
// and the `@` our code had typed stayed in the composer. Every later preflight
// then refused `text_present` at `failedPhase=home`, so the lane restarted every
// tick. The picker-missing branch already clears its failed `@`; the
// found-but-click-failed branch must run the same guarded clear and then rethrow
// the ORIGINAL error, never a cleanup error.
describe("failed connector click clears its typed @ (r33)", () => {
  /** A found row whose click throws a non-timeout error the way the live lane did. */
  const failingClick = () => {
    const original = new Error("locator.click: Error: element is not stable");
    const scenario = makePage();
    scenario.setRows([{ label: "connector", visible: true, onSelected: () => { throw original; } }]);
    return { scenario, original };
  };

  it("clears the query and rethrows the original error", async () => {
    const { scenario, original } = failingClick();
    const { page } = scenario;
    const error = await setConnector(page, "connector").catch(caught => caught);
    // The ORIGINAL click error reaches the caller, unwrapped.
    expect(error).toBe(original);
    // setConnector's own pre-attach clear is the first two presses (Meta+A then
    // Backspace, before the click). Everything AFTER those is the cleanup the
    // failed click now triggers: Escape, then Meta+A, then Backspace.
    const presses = vi.mocked(page.keyboard.press).mock.calls.map(([key]) => key);
    expect(presses.slice(0, 2)).toEqual(["Meta+A", "Backspace"]);
    expect(presses.slice(2)).toEqual(["Escape", "Meta+A", "Backspace"]);
  });

  it("rethrows the original error even when a cleanup guard itself refuses", async () => {
    const { scenario, original } = failingClick();
    const { page } = scenario;
    // The three pre-attach guards admit; the cleanup's first guard then refuses
    // (the composer changed under the clear). A cleanup error must never replace
    // the original click error.
    let guardCalls = 0;
    page.evaluate = vi.fn(async () => (guardCalls += 1) <= 3) as typeof page.evaluate;
    const error = await setConnector(page, "connector", true).catch(caught => caught);
    expect(error).toBe(original);
  });

  it("runs the guarded clear under protectDraft, each step behind its { text: '@' } guard", async () => {
    const { scenario, original } = failingClick();
    const { page } = scenario;
    page.evaluate = vi.fn(async () => true) as typeof page.evaluate;
    const error = await setConnector(page, "connector", true).catch(caught => caught);
    expect(error).toBe(original);
    const presses = vi.mocked(page.keyboard.press).mock.calls.map(([key]) => key);
    expect(presses.slice(2)).toEqual(["Escape", "Meta+A", "Backspace"]);
    // Three pre-attach guards plus the three the cleanup runs: the cleanup is
    // guarded exactly like the picker-missing branch, not only its presses.
    expect(vi.mocked(page.evaluate).mock.calls).toHaveLength(6);
  });
});

// P-035 2026-10-08. Live personal and strengths under heavy host load: the first
// click timed out but landed late, the refreshed lookup returned the still-open
// picker row, and the retry click added a second chip that no ownership proof
// admits. The composer is asked before any retry click.
describe("a late-landing connector click is never clicked twice (P-035 2026-10-08)", () => {
  it("returns without a retry click when the composer already holds the chip", async () => {
    const scenario = makePage();
    const chip = { label: "connector", visible: true, attrs: {}, inComposer: true, id: "chip" };
    const picker: FakeRow = {
      label: "connector",
      visible: true,
      attrs: {},
      id: "picker",
      onSelected: () => {
        scenario.setRows([picker, chip]); // the chip mounts, the picker is still open
        throw new Error("locator.click: Timeout 5000ms exceeded.");
      },
    };
    scenario.setRows([picker]);
    const { page } = scenario;
    // The composer read: the chip is there; the picker then closes.
    page.evaluate = vi.fn(async () => {
      scenario.setRows([chip]);
      return true;
    }) as typeof page.evaluate;

    await expect(setConnector(page, "connector")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual(["picker"]);
  });
});

// P-035 2026-10-05. In ChatGPT's Plugins UI the connector chip in the composer
// and the left rail's Customize > Plugins entry are links to `/plugins/<id>`:
// clicking either navigates away from the Project (ms1980 `visible picker
// entries=[]` after `first-click-done`; intelli's click-timeout on
// `span ... .nth(2)`). Only the @-picker row may be clicked.
describe("connector clicks only ever target the @-picker row (P-035 2026-10-05)", () => {
  it("treats the lane's own composer-mounted chip as attached and never clicks it", async () => {
    const scenario = makePage();
    scenario.setRows([
      { label: "connector", visible: true, attrs: {}, inComposer: true, href: "/plugins/plugin_asdk_app_x", id: "chip" },
    ]);
    const { page } = scenario;

    await expect(setConnector(page, "connector")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual([]);
    expect(page.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("skips sidebar entries and /plugins/ links outside the composer and clicks the picker row", async () => {
    const scenario = makePage();
    scenario.setRows([
      { label: "connector", visible: true, attrs: {}, inNav: true, href: "/plugins/plugin_asdk_app_x", id: "sidebar" },
      { label: "connector", visible: true, attrs: {}, href: "/plugins/plugin_asdk_app_x", id: "plugin-link" },
      {
        label: "connector",
        visible: true,
        attrs: {},
        id: "picker",
        onSelected: () => scenario.setRows([
          { label: "connector", visible: true, attrs: {}, inComposer: true, href: "/plugins/plugin_asdk_app_x", id: "chip" },
        ]),
      },
    ]);
    const { page } = scenario;

    await expect(setConnector(page, "connector")).resolves.toBeUndefined();

    expect(page.clickedLabels).toEqual(["picker"]);
  });
});
