import { describe, expect, it } from "vitest";
import { parseUsagePanelText } from "../src/browser/conversation.js";

// P-035 G3 r45 (2026-09-28). The account usage panel states the real Pro reset
// ("6% usage remaining" / "Resets every week · Next reset is on Oct 4 at 12:58
// AM"), and the reset line carries NO year. These tests pin the pure text
// parser: the year-less date, the two time forms, the 24 h past-grace rollover
// and the refusals. No page is involved.
describe("parseUsagePanelText", () => {
  const NOW = new Date(2026, 8, 28, 15, 25, 0, 0); // 2026-09-28 15:25 local

  it("reads the live panel's percent, period and year-less reset instant", () => {
    const panel = parseUsagePanelText(
      "6% usage remaining · Resets every week · Next reset is on Oct 4 at 12:58 AM",
      NOW,
    );

    expect(panel).not.toBeNull();
    expect(panel!.percent).toBe(6);
    expect(panel!.period).toBe("week");
    // "12:58 AM" is 00:58 local, and the missing year is the CURRENT local year.
    expect(panel!.resetAt).toMatch(/^2026-10-04T00:58:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(panel!.resetAt!)).toBe(new Date(2026, 9, 4, 0, 58, 0, 0).getTime());
  });

  it("reads a PM time as that local time", () => {
    const panel = parseUsagePanelText(
      "6% usage remaining · Resets every day · Next reset is on Oct 4 at 12:05 PM",
      NOW,
    );

    expect(panel!.period).toBe("day");
    expect(Date.parse(panel!.resetAt!)).toBe(new Date(2026, 9, 4, 12, 5, 0, 0).getTime());
  });

  it("reads a reset line with no time as the start of that local day", () => {
    const panel = parseUsagePanelText("Next reset is on Oct 4", NOW);

    expect(panel).not.toBeNull();
    expect(panel!.resetAt).toMatch(/^2026-10-04T00:00:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(panel!.resetAt!)).toBe(new Date(2026, 9, 4, 0, 0, 0, 0).getTime());
    // No percent and no period on this page, and neither is invented.
    expect(panel!.percent).toBeNull();
    expect(panel!.period).toBeNull();
  });

  it("rolls a date more than 24 h in the past to the next year", () => {
    // The panel names the NEXT reset, so Oct 4 read on Oct 10 is next year's.
    const panel = parseUsagePanelText("Next reset is on Oct 4 at 12:58 AM", new Date(2026, 9, 10, 9, 0, 0, 0));

    expect(panel!.resetAt).toMatch(/^2027-10-04T00:58:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(panel!.resetAt!)).toBe(new Date(2027, 9, 4, 0, 58, 0, 0).getTime());
  });

  it("keeps the current year for a date only a few hours past", () => {
    // 11 hours after the reset instant, the page is just re-rendered, not stale.
    const panel = parseUsagePanelText("Next reset is on Oct 4 at 12:58 AM", new Date(2026, 9, 4, 12, 0, 0, 0));

    expect(Date.parse(panel!.resetAt!)).toBe(new Date(2026, 9, 4, 0, 58, 0, 0).getTime());
  });

  it("returns null for text it cannot prove a date from", () => {
    expect(parseUsagePanelText("no panel here", NOW)).toBeNull();
    expect(parseUsagePanelText("6% usage remaining · Resets every week", NOW)).toBeNull();
    // A named month the reader does not know, and a day that does not exist.
    expect(parseUsagePanelText("Next reset is on Soon at 12:05 PM", NOW)).toBeNull();
    expect(parseUsagePanelText("Next reset is on Feb 30 at 12:00 AM", NOW)).toBeNull();
    expect(parseUsagePanelText("Next reset is on Oct 4 at 13:05 PM", NOW)).toBeNull();
  });
});
