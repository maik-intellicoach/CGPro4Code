import { describe, expect, it, vi } from "vitest";

vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: vi.fn(),
  requireSelector: vi.fn(),
}));
const { describeDivergence } = await import("../src/browser/conversation.js");

// P-035 2026-09-18. Written from the two live refusals that killed the
// tail-truncation theory: personal 22:39:12Z lost 1426 of 7978 characters and
// strengths 22:48:14Z lost 1416 of 7978, both holding the head AND the trailing
// invocation contract. A length plus an endpoint cannot tell those apart from a
// tail truncation; the first mismatching offset can.
describe("composer divergence", () => {
  it("locates a contiguous middle drop and measures it", () => {
    const want = `${"head ".repeat(10)}LOST BLOCK ${"tail ".repeat(10)}`;
    const landed = want.replace("LOST BLOCK ", "");
    const out = describeDivergence(landed, want);
    expect(out).toMatch(/^divergence=50\//);
    expect(out).toContain("dropped=11");
    expect(out).toContain("resumes_at=61");
  });

  it("reports a plain tail truncation as a prefix rather than a divergence", () => {
    const want = "the whole prompt including its invocation contract";
    const out = describeDivergence(want.slice(0, 20), want);
    expect(out).toContain("divergence=none");
    expect(out).toContain("landed_is_prefix");
    expect(out).toContain(`short_by=${want.length - 20}`);
  });

  it("flags text the composer holds that was never sent", () => {
    const want = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const landed = "alpha bravo ZULU NEVER SENT ANYWHERE NEAR THIS PROMPT AT ALL";
    expect(describeDivergence(landed, want)).toContain("resume=not-found");
  });

  it("shows the characters on both sides of the boundary", () => {
    const want = "0123456789".repeat(8);
    const landed = `${want.slice(0, 40)}XY${want.slice(42)}`;
    const out = describeDivergence(landed, want);
    // The window is what names the cause: whatever sits immediately before the
    // drop is the thing that swallowed it.
    expect(out).toContain("want=");
    expect(out).toContain("landed=");
    expect(out).toMatch(/divergence=40\//);
  });
});
