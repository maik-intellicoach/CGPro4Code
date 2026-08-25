import { describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { firstResolved } from "../src/browser/chatgpt.js";

describe("firstResolved visibility contract", () => {
  it("skips mounted but hidden selector candidates", async () => {
    const hidden = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => false) };
    const visible = { count: vi.fn(async () => 1), isVisible: vi.fn(async () => true) };
    const page = {
      locator: vi.fn((selector: string) => ({
        first: () => selector === "hidden" ? hidden : visible,
      })),
    } as unknown as Page;

    await expect(firstResolved(page, ["hidden", "visible"])).resolves.toBe(visible);
    expect(hidden.isVisible).toHaveBeenCalledTimes(1);
    expect(visible.isVisible).toHaveBeenCalledTimes(1);
  });
});
