import { describe, it, expect } from "vitest";
import { SELECTORS, joinSelectors } from "../src/browser/selectors.js";

describe("selectors", () => {
  it("provides at least one candidate for every key", () => {
    for (const [key, list] of Object.entries(SELECTORS)) {
      expect(list.length, `${key} has zero candidates`).toBeGreaterThan(0);
      for (const sel of list) {
        expect(typeof sel).toBe("string");
        expect(sel.length).toBeGreaterThan(0);
      }
    }
  });

  it("joins selectors into a comma-separated CSS list", () => {
    expect(joinSelectors(["a", "b", "c"])).toBe("a, b, c");
  });

  it("composer and sendButton are listed first in the most stable form", () => {
    expect(SELECTORS.composer[0]).toBe("#prompt-textarea");
    expect(SELECTORS.sendButton[0]).toContain('data-testid="send-button"');
  });

  it("recognizes the square native Deep Research stop control", () => {
    expect(SELECTORS.stopButton.some((selector) => selector.includes("svg rect"))).toBe(true);
  });

  it("modelSwitcher targets the composer-inline pill first (C-092 Work-area drift)", () => {
    expect(SELECTORS.modelSwitcher[0]).toBe('button.__composer-pill[aria-haspopup="menu"]');
  });

  it("chatTabRadio targets the Chat/Work surface toggle (C-092 Work-area drift)", () => {
    expect(SELECTORS.chatTabRadio.length).toBeGreaterThan(0);
    for (const sel of SELECTORS.chatTabRadio) {
      expect(sel).toContain("Chat");
    }
  });

  it("exposes a native Deep Research composer selector", () => {
    expect(SELECTORS.deepResearchToggle.some((selector) => selector.includes("Deep research"))).toBe(true);
    expect(SELECTORS.deepResearchToggle[0]).toContain('__menu-item[tabindex="0"]');
    expect(SELECTORS.deepResearchSelected.some((selector) => selector.includes("Deep research"))).toBe(true);
    expect(SELECTORS.deepResearchEffort.some((selector) => selector.includes("High"))).toBe(true);
    expect(SELECTORS.deepResearchEffort.some((selector) => selector.includes("Pro"))).toBe(true);
  });
});
