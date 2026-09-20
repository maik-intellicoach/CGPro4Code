import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";

const projects = vi.fn();
const goHome = vi.fn();
const requireSelector = vi.fn();
vi.mock("../src/api/projects.js", () => ({ listProjects: (...args: unknown[]) => projects(...args) }));
vi.mock("../src/browser/chatgpt.js", () => ({
  goHome: (...args: unknown[]) => goHome(...args),
  firstResolved: vi.fn(async () => null),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
  requireSelectorPatient: (...args: unknown[]) => requireSelector(...args),
}));
const { openConversation } = await import("../src/browser/conversation.js");
const target = { id: "g-p-target", shortUrl: "g-p-target-work", name: "Work" };

function pageFor(
  destination = `/g/${target.id}/project`,
  sidebar: {
    matches: number;
    visible?: (index: number) => boolean;
    failFirstAttempts?: number;
    // The attempt (1-based) on which the click actually moves the page.
    // Independent of whether that same click's promise rejects, because on the
    // real page those two came apart (P-035 2026-09-18, invocation d3518975).
    // Defaults to the first attempt that does not throw.
    navigatesOnAttempt?: number;
    startUrl?: string;
  } = { matches: 1 },
) {
  let currentUrl = sidebar.startUrl ?? "https://chatgpt.com/";
  const rowClick = vi.fn(async () => {});
  // The row's LABEL is what gets clicked, and it carries its own waitFor: the
  // row being visible never made the text node inside it clickable, which is
  // what turned this line into 21 timeouts in seven days (P-035 2026-09-18).
  const labelWait = vi.fn(async () => {});
  const label = { waitFor: labelWait, click: rowClick };
  const row = {
    waitFor: vi.fn(async () => {}),
    getByText: vi.fn(() => ({ first: () => label })),
  };
  // The sidebar link is resolved imperatively (count/nth/isVisible/click) so a
  // hidden duplicate can be skipped and a timeout can be retried, rather than
  // one 5s click deciding the turn (P-035 2026-09-16).
  let clicks = 0;
  const sidebarMatch = {
    isVisible: vi.fn(async () => (sidebar.visible ?? (() => true))(sidebarNthIndex)),
    click: vi.fn(async () => {
      clicks++;
      const navigatesOn = sidebar.navigatesOnAttempt ?? (sidebar.failFirstAttempts ?? 0) + 1;
      if (clicks === navigatesOn) currentUrl = "https://chatgpt.com/projects";
      if (clicks <= (sidebar.failFirstAttempts ?? 0)) throw new Error("locator.click: Timeout 5000ms exceeded.");
    }),
  };
  let sidebarNthIndex = 0;
  const sidebarLocator = {
    count: vi.fn(async () => sidebar.matches),
    nth: vi.fn((index: number) => {
      sidebarNthIndex = index;
      return sidebarMatch;
    }),
  };
  const page = {
    goto: vi.fn(), waitForTimeout: vi.fn(async () => {}), getByRole: vi.fn(), isClosed: vi.fn(() => false),
    url: vi.fn(() => currentUrl),
    locator: vi.fn(() => ({ ...sidebarLocator, filter: vi.fn(() => ({ first: () => row })) })),
    waitForURL: vi.fn(async (predicate: (url: URL) => boolean) => {
      if (!predicate(new URL(destination, "https://chatgpt.com"))) throw new Error("Wrong Project URL");
    }),
  } as unknown as Page;
  requireSelector.mockImplementation(async (_page: Page, _selectors: string[], name: string) => {
    if (name === "composer") return {};
    return { click: vi.fn(async () => {}) };
  });
  return { page, rowClick, row, label, labelWait, sidebarMatch };
}

beforeEach(() => { vi.clearAllMocks(); projects.mockResolvedValue([target]); });
describe("Project directory navigation", () => {
  it("opens a uniquely identified Project through its row without a cold Project navigation", async () => {
    const { page, rowClick } = pageFor();
    const onPhase = vi.fn();
    await openConversation(page, { gizmoId: target.id }, onPhase);
    expect(onPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "project-home", "project-chat-surface", "project-list-wait", "project-list",
      "project-identity", "project-navigation-lookup", "project-navigation-wait",
      "project-navigation-click", "project-row-wait", "project-label-wait",
      "project-label-click", "project-destination-wait", "project-composer", "project-chat-surface",
    ]);
    expect(JSON.stringify(onPhase.mock.calls)).not.toContain(target.id);
    expect(rowClick).toHaveBeenCalledOnce();
    expect(page.goto).not.toHaveBeenCalled();
    expect(requireSelector.mock.calls.some(c => c[2] === "composer")).toBe(true);
  });
  it("never gates the Project branch on the surface-dependent home composer", async () => {
    // FIX A (P-035 2026-09-16): the branch used to require the home composer
    // before the Chat surface was selected, so a Work-surface or simply slow
    // profile failed a check that exists to enable the switch. The directory
    // row below is the real readiness gate.
    const { page, rowClick } = pageFor();
    await openConversation(page, { gizmoId: target.id });
    expect(requireSelector.mock.calls.some(c => c[2] === "home composer")).toBe(false);
    expect(rowClick).toHaveBeenCalledOnce();
  });
  it("refuses conflicting Project id and short URL before clicking a row", async () => {
    projects.mockResolvedValue([target, { id: "g-p-other", shortUrl: "other", name: "Other" }]);
    const { page, rowClick } = pageFor();
    await expect(openConversation(page, { gizmoId: target.id, gizmoShortUrl: "other" })).rejects.toThrow("uniquely identified");
    expect(rowClick).not.toHaveBeenCalled();
  });
  it("resolves a configured short URL to the exact Project before opening its row", async () => {
    const { page, rowClick } = pageFor();
    await openConversation(page, { gizmoShortUrl: target.shortUrl });
    expect(rowClick).toHaveBeenCalledOnce();
    expect(page.goto).not.toHaveBeenCalled();
    expect(requireSelector.mock.calls.some(c => c[2] === "composer")).toBe(true);
  });
  it("refuses ambiguous visible names before clicking a row", async () => {
    projects.mockResolvedValue([target, { id: "g-p-other", name: "Work" }]);
    const { page, rowClick } = pageFor();
    await expect(openConversation(page, { gizmoId: target.id })).rejects.toThrow("uniquely identified");
    expect(rowClick).not.toHaveBeenCalled();
  });
  it("does not admit a composer after navigation reaches a different Project", async () => {
    const { page } = pageFor("/g/g-p-other/project");
    await expect(openConversation(page, { gizmoId: target.id })).rejects.toThrow("Wrong Project URL");
    expect(requireSelector.mock.calls.some(c => c[2] === "composer")).toBe(false);
  });
});

describe("Project directory sidebar click", () => {
  it("skips a hidden sidebar match and clicks the reachable one", async () => {
    // `a[href="/projects"]` can match more than one node; `.first()` alone
    // picks whichever came first in the DOM, hidden ones included.
    const { page, sidebarMatch } = pageFor(undefined, {
      matches: 2,
      visible: (index) => index === 1,
    });
    await openConversation(page, { gizmoId: target.id });
    expect(sidebarMatch.click).toHaveBeenCalledOnce();
  });
  it("retries the sidebar click instead of failing the turn on the first timeout", async () => {
    const { page, sidebarMatch } = pageFor(undefined, { matches: 1, failFirstAttempts: 1 });
    await openConversation(page, { gizmoId: target.id });
    expect(sidebarMatch.click).toHaveBeenCalledTimes(2);
  });
  // P-035 2026-09-18. The row was awaited and the LABEL inside it was not, so
  // the click's own 5s actionability budget was the only thing waiting for the
  // node we actually click: 21 timeouts in seven days across three different
  // projects. A longer blind timeout would have moved the boundary; waiting for
  // the click target removes it.
  it("waits for the row's label before clicking it, not just for the row", async () => {
    const { page, labelWait, rowClick } = pageFor();
    const order: string[] = [];
    labelWait.mockImplementation(async () => { order.push("wait"); });
    rowClick.mockImplementation(async () => { order.push("click"); });
    await openConversation(page, { gizmoId: target.id });
    expect(order).toEqual(["wait", "click"]);
    expect(labelWait).toHaveBeenCalledWith({ state: "visible", timeout: 20_000 });
  });

  it("does not click a label that never becomes visible", async () => {
    const { page, labelWait, rowClick } = pageFor();
    labelWait.mockRejectedValue(new Error("locator.waitFor: Timeout 20000ms exceeded."));
    await expect(openConversation(page, { gizmoId: target.id })).rejects.toThrow(/Timeout 20000ms/);
    expect(rowClick).not.toHaveBeenCalled();
  });

  // P-035 2026-09-18, invocation d3518975. The turn failed with "Projects
  // navigation could not be clicked after 3 attempts (matches=1, visible=1,
  // url=https://chatgpt.com/projects)" -- and that url IS the destination.
  // `goHome` navigates to chatgpt.com/ and `listProjects` is a pure API read,
  // so one of those three clicks had already arrived. The helper judged the
  // click promise instead of the outcome, retried twice against a page that
  // was already correct, hung both times in "scrolling into view if needed",
  // and failed a turn that had succeeded at this step 51 seconds earlier.
  it("treats a click that navigated as done even when its promise timed out", async () => {
    const { page, sidebarMatch } = pageFor(undefined, {
      matches: 1, failFirstAttempts: 1, navigatesOnAttempt: 1,
    });
    await openConversation(page, { gizmoId: target.id });
    expect(sidebarMatch.click).toHaveBeenCalledOnce();
  });

  it("does not click the sidebar at all when the page is already on the directory", async () => {
    const { page, sidebarMatch, rowClick } = pageFor(undefined, {
      matches: 1, startUrl: "https://chatgpt.com/projects",
    });
    await openConversation(page, { gizmoId: target.id });
    expect(sidebarMatch.click).not.toHaveBeenCalled();
    expect(rowClick).toHaveBeenCalledOnce();
  });

  it("names the match count and URL when the sidebar never becomes clickable", async () => {
    const { page } = pageFor(undefined, { matches: 2, visible: () => false });
    await expect(openConversation(page, { gizmoId: target.id })).rejects.toThrow(
      /Projects navigation could not be clicked after 3 attempts \(matches=2, visible=0/,
    );
  });

  it("identifies the actual failing Project step without exposing its error text", async () => {
    const { page, labelWait } = pageFor();
    const original = new Error("private project name and URL");
    labelWait.mockRejectedValueOnce(original);
    const onPhase = vi.fn();
    await expect(openConversation(page, { gizmoId: target.id }, onPhase)).rejects.toBe(original);
    expect(onPhase).toHaveBeenLastCalledWith("project-label-wait");
    expect(JSON.stringify(onPhase.mock.calls)).not.toContain("private");
  });

});
