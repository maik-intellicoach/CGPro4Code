import { describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { firstResolved } from "../src/browser/chatgpt.js";

describe("firstResolved visibility contract", () => {
  it("skips mounted but hidden selector candidates", async () => {
    const hidden = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => false) };
    const visible = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => true) };
    const page = {
      locator: vi.fn((selector: string) => ({
        first: () => (selector === "hidden" ? hidden : visible),
      })),
    } as unknown as Page;

    await expect(firstResolved(page, ["hidden", "visible"])).resolves.toBe(visible);
    expect(hidden.isVisible).toHaveBeenCalledTimes(1);
    expect(visible.isVisible).toHaveBeenCalledTimes(1);
  });

  it("returns a plain locator so later actions are not gated on visibility", async () => {
    // Regression pin (P-035 2026-09-16): firstResolved briefly returned
    // filter({visible:true}).first(), which carries that filter into every
    // later click; two live probes then died with "locator.click: Timeout ...
    // waiting for locator('...').filter({ visible: true }).first()" on a page
    // whose target flickers. The candidate loop still skips a hidden first
    // match through the isVisible() guard, which is where that belongs.
    const hidden = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => false) };
    const visible = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => true) };
    const filters: Array<Record<string, unknown>> = [];
    const page = {
      locator: vi.fn((selector: string) => ({
        first: () => (selector === "hidden" ? hidden : visible),
        filter: (options: Record<string, unknown>) => {
          filters.push(options);
          return { first: () => (selector === "hidden" ? hidden : visible) };
        },
      })),
    } as unknown as Page;

    await expect(firstResolved(page, ["hidden", "visible"])).resolves.toBe(visible);
    expect(filters).toEqual([]);
    expect(hidden.isVisible).toHaveBeenCalledTimes(1);
  });
});
