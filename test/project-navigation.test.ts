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
}));
const { openConversation } = await import("../src/browser/conversation.js");
const target = { id: "g-p-target", shortUrl: "g-p-target-work", name: "Work" };

function pageFor(destination = `/g/${target.id}/project`) {
  const rowClick = vi.fn(async () => {});
  const row = { waitFor: vi.fn(async () => {}), getByText: vi.fn(() => ({ click: rowClick })) };
  const page = {
    goto: vi.fn(), waitForTimeout: vi.fn(async () => {}), getByRole: vi.fn(),
    locator: vi.fn(() => ({ filter: vi.fn(() => row) })),
    waitForURL: vi.fn(async (predicate: (url: URL) => boolean) => {
      if (!predicate(new URL(destination, "https://chatgpt.com"))) throw new Error("Wrong Project URL");
    }),
  } as unknown as Page;
  requireSelector.mockImplementation(async (_page: Page, _selectors: string[], name: string) => {
    if (name === "composer") return {};
    return { click: vi.fn(async () => {}) };
  });
  return { page, rowClick, row };
}

beforeEach(() => { vi.clearAllMocks(); projects.mockResolvedValue([target]); });
describe("Project directory navigation", () => {
  it("opens a uniquely identified Project through its row without a cold Project navigation", async () => {
    const { page, rowClick } = pageFor();
    await openConversation(page, { gizmoId: target.id });
    expect(rowClick).toHaveBeenCalledOnce();
    expect(page.goto).not.toHaveBeenCalled();
    expect(requireSelector.mock.calls.some(c => c[2] === "composer")).toBe(true);
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
