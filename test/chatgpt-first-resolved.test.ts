import { describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { firstResolved } from "../src/browser/chatgpt.js";

function pageWith(matches: Record<string, { node: unknown; filters: Array<Record<string, unknown>> }>) {
  return {
    locator: vi.fn((selector: string) => ({
      filter: vi.fn((options: Record<string, unknown>) => {
        matches[selector].filters.push(options);
        return { first: () => matches[selector].node };
      }),
    })),
  } as unknown as Page;
}

describe("firstResolved visibility contract", () => {
  it("skips mounted but hidden selector candidates", async () => {
    const hidden = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => false) };
    const visible = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => true) };
    const page = pageWith({
      hidden: { node: hidden, filters: [] },
      visible: { node: visible, filters: [] },
    });

    await expect(firstResolved(page, ["hidden", "visible"])).resolves.toBe(visible);
    expect(hidden.isVisible).toHaveBeenCalledTimes(1);
    expect(visible.isVisible).toHaveBeenCalledTimes(1);
  });

  it("resolves a candidate whose first match is hidden instead of skipping it", async () => {
    // FIX C (P-035 2026-09-16): the candidate loop only advanced to the NEXT
    // selector, so a hidden first node made an otherwise resolvable selector
    // look broken. The match set is filtered to visible nodes before .first().
    const visible = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => true) };
    const mixed = { node: visible, filters: [] as Array<Record<string, unknown>> };
    const later = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => true) };
    const page = pageWith({ mixed: mixed, later: { node: later, filters: [] } });

    await expect(firstResolved(page, ["mixed", "later"])).resolves.toBe(visible);
    expect(mixed.filters[0]).toEqual({ visible: true });
    expect(later.isVisible).not.toHaveBeenCalled();
  });
});
