import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeProfileExitState } from "../src/browser/session.js";

describe("dedicated Chrome profile lifecycle", () => {
  it("atomically records a clean exit after the persistent browser closes", () => {
    const root = mkdtempSync(join(tmpdir(), "cgpro-profile-lifecycle-"));
    const defaultDir = join(root, "Default");
    const preferences = join(defaultDir, "Preferences");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(preferences, JSON.stringify({ profile: { exit_type: "Crashed" }, retained: 7 }));

    expect(normalizeProfileExitState(root)).toBe(true);

    const updated = JSON.parse(readFileSync(preferences, "utf-8"));
    expect(updated).toEqual({
      profile: { exit_type: "Normal", exited_cleanly: true },
      retained: 7,
    });
  });

  it("fails without replacing malformed Preferences", () => {
    const root = mkdtempSync(join(tmpdir(), "cgpro-profile-lifecycle-"));
    const defaultDir = join(root, "Default");
    const preferences = join(defaultDir, "Preferences");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(preferences, "{not-json");

    expect(normalizeProfileExitState(root)).toBe(false);
    expect(readFileSync(preferences, "utf-8")).toBe("{not-json");
  });
});
