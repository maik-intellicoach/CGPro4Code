import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deepResearchQuota,
  parseDeepResearchExhausted,
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

const NOTICE =
  "Your remaining queries are powered by a lighter version of deep research. Your full access resets on April 17.";

describe("parseDeepResearchExhausted", () => {
  it("reads the light-version notice with its reset on April 17 of the right year", () => {
    // Before April 17 the reset is this year's; after it, next year's.
    expect(parseDeepResearchExhausted(NOTICE, new Date(2026, 2, 1, 9, 0))).toEqual({
      exhausted: true,
      resetsAt: expect.stringMatching(/^2026-04-17T00:00:00[+-]\d{2}:\d{2}$/),
    });
    expect(parseDeepResearchExhausted(NOTICE, new Date(2026, 9, 3, 10, 20))?.resetsAt)
      .toMatch(/^2027-04-17T00:00:00[+-]\d{2}:\d{2}$/);
    // On the reset day itself the date is still today's.
    expect(parseDeepResearchExhausted(NOTICE, new Date(2026, 3, 17, 15, 0))?.resetsAt)
      .toMatch(/^2026-04-17T00:00:00/);
  });

  it("rolls the year over: Dec 30 and \"resets on January 3\" is next year", () => {
    const text = "Powered by a lighter version of deep research. Your full access resets on January 3.";
    expect(parseDeepResearchExhausted(text, new Date(2026, 11, 30, 12, 0))?.resetsAt)
      .toMatch(/^2027-01-03T00:00:00[+-]\d{2}:\d{2}$/);
  });

  it("keeps the notice but no reset when the date does not parse", () => {
    expect(parseDeepResearchExhausted("A lighter version of deep research is in use.", new Date())).toEqual({
      exhausted: true,
      resetsAt: null,
    });
    expect(parseDeepResearchExhausted(
      "lighter version of deep research. Your full access resets on Smarch 4.", new Date(),
    )).toEqual({ exhausted: true, resetsAt: null });
  });

  it("gives null for a text without the notice", () => {
    expect(parseDeepResearchExhausted("Deep research 5 left", new Date())).toBeNull();
    expect(parseDeepResearchExhausted("You've reached your limit", new Date())).toBeNull();
  });
});

describe("the light-version notice on the tools row", () => {
  it("records the quota as exhausted, with the 6 h default when no date is named", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const now = new Date("2026-10-03T02:20:00.000Z");
    recordDeepResearchRow("Deep research Using a lighter version of deep research", now);

    expect(deepResearchQuota()).toMatchObject({
      exhaustedUntil: "2026-10-03T08:20:00.000Z",
      exhaustedObservedAt: "2026-10-03T02:20:00.000Z",
    });
    expect(lines[1]).toBe("[cgpro:deep-research] light-version notice: resets_at=none");
  });
});
