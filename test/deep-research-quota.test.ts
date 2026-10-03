import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deepResearchQuota,
  parseDeepResearchRemaining,
  recordDeepResearchRow,
  resetDeepResearchQuota,
} from "../src/browser/deep-research-quota.js";

/**
 * P-035 2026-10-03 G4-A. ChatGPT's own Deep Research counter is the router's
 * ground truth. The live wording is not captured yet, so these pin the
 * tolerant forms the parser must accept and the forms it must refuse.
 */

afterEach(() => {
  resetDeepResearchQuota();
  vi.restoreAllMocks();
});

describe("parseDeepResearchRemaining", () => {
  it.each([
    ["Deep research 5 left", 5],
    ["Deep research\n12 remaining", 12],
    ["3 of 25 left", 3],
    ["Recherche approfondie 4 restantes", 4],
    ["Deep research 7/25", 7],
  ])("reads %j as %i", (text, expected) => {
    expect(parseDeepResearchRemaining(text)).toBe(expected);
  });

  it("gives null when the row names no number", () => {
    expect(parseDeepResearchRemaining("Deep research")).toBeNull();
    expect(parseDeepResearchRemaining("")).toBeNull();
  });

  it("gives null for a number without the keyword", () => {
    expect(parseDeepResearchRemaining("Deep research 5")).toBeNull();
  });

  it("never throws on a non-string", () => {
    expect(parseDeepResearchRemaining(undefined as unknown as string)).toBeNull();
  });
});

describe("the reading record", () => {
  it("is all nulls by default", () => {
    expect(deepResearchQuota()).toEqual({
      remaining: null,
      label: null,
      observedAt: null,
      exhaustedUntil: null,
      exhaustedObservedAt: null,
    });
  });

  it("records the collapsed, capped label and logs one shape line", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const now = new Date("2026-10-03T02:20:00.000Z");
    recordDeepResearchRow(`  Deep research\n  5 left ${"x".repeat(100)}`, now);

    const reading = deepResearchQuota();
    expect(reading.remaining).toBe(5);
    expect(reading.label).toHaveLength(80);
    expect(reading.label?.startsWith("Deep research 5 left x")).toBe(true);
    expect(reading.observedAt).toBe("2026-10-03T02:20:00.000Z");
    expect(lines).toEqual([
      `[cgpro:deep-research] tools row: remaining=5 label="${reading.label}"`,
    ]);
  });

  it("logs remaining=none when the row names no count", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
    recordDeepResearchRow("Deep research");
    expect(lines).toEqual(['[cgpro:deep-research] tools row: remaining=none label="Deep research"']);
  });
});
