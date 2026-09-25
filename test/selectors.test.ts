import { describe, it, expect } from "vitest";
import { SELECTORS, TURN_CRITICAL_SELECTORS, joinSelectors } from "../src/browser/selectors.js";

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
    // P-035 2026-09-26: the live composer lost #prompt-textarea; it stays as a fallback.
    expect(SELECTORS.composer[0]).toBe('div[contenteditable="true"][data-composer-markdown]');
    expect(SELECTORS.composer).toContain("#prompt-textarea");
    expect(SELECTORS.composer.at(-1)).toBe('div[contenteditable="true"]');
    expect(SELECTORS.sendButton[0]).toContain('data-testid="send-button"');
  });

  it("recognizes the square native Deep Research stop control", () => {
    expect(SELECTORS.stopButton.some((selector) => selector.includes("svg rect"))).toBe(true);
  });

  it("modelSwitcher targets the labelled composer model button first (P-035 2026-09-26 drift)", () => {
    expect(SELECTORS.modelSwitcher[0]).toBe('form button[aria-label="Select ChatGPT model"]');
    expect(SELECTORS.modelSwitcher).toContain('button.__composer-pill[aria-haspopup="menu"]');
  });

  // The unscoped fallback resolved to the profile menu on 2026-09-26, so the
  // model switch opened the wrong menu. Every generic fallback stays in the form.
  it("never lets a generic modelSwitcher fallback escape the composer form", () => {
    expect(SELECTORS.modelSwitcher).not.toContain('button[aria-haspopup="menu"]:has(svg)');
  });

  it("chatTabRadio targets the Chat/Work surface toggle (C-092 Work-area drift)", () => {
    expect(SELECTORS.chatTabRadio.length).toBeGreaterThan(0);
    for (const sel of SELECTORS.chatTabRadio) {
      expect(sel).toContain("Chat");
    }
  });

  // P-035 2026-09-21. The Pro-6 gate failed on a lane where this key's three
  // label candidates all matched zero elements while the structural pill was
  // attached and visible. Structure must therefore lead, and the label
  // candidates must survive as fallbacks -- losing either half reintroduces the
  // incident in a different shape.
  it("thinkingPowerButton leads with the composer model button, keeping the pill and label fallbacks", () => {
    expect(SELECTORS.thinkingPowerButton[0]).toBe('form button[aria-label="Select ChatGPT model"]');
    expect(SELECTORS.thinkingPowerButton[1]).toBe('button.__composer-pill[aria-haspopup="menu"]');
    expect(SELECTORS.thinkingPowerButton).toContain('button:has-text("Thinking effort")');
    expect(SELECTORS.thinkingPowerButton.length).toBeGreaterThanOrEqual(4);
  });

  it("treats the Pro-6 control as turn-critical, and the slider as not", () => {
    expect(TURN_CRITICAL_SELECTORS).toContain("thinkingPowerButton");
    expect(TURN_CRITICAL_SELECTORS).not.toContain("thinkingPowerSlider");
  });

  // P-035 2026-09-26: the sidebar has no /projects link any more, so its absence
  // is the healthy state and must not mark a lane as drifted.
  it("does not treat the Projects sidebar link as turn-critical", () => {
    expect(TURN_CRITICAL_SELECTORS).not.toContain("projectsNavigation");
  });

  it("finds web search in the flat popover list ahead of the popover-only role variants", () => {
    expect(SELECTORS.webSearchToggle[0]).toBe('button[data-list-navigation-item]:has-text("Web search")');
    // setWebSearch skips the first four (popover-only) entries for its inline probe.
    expect(SELECTORS.webSearchToggle.slice(4).every((s) => !s.includes("menuitemradio"))).toBe(true);
  });

  it("exposes a native Deep Research composer selector", () => {
    expect(SELECTORS.deepResearchToggle.some((selector) => selector.includes("Deep research"))).toBe(true);
    expect(SELECTORS.deepResearchToggle[0]).toContain('__menu-item[tabindex="0"]');
    expect(SELECTORS.deepResearchSelected.some((selector) => selector.includes("Deep research"))).toBe(true);
    expect(SELECTORS.thinkingPowerSlider.some((selector) => selector.includes("aria-valuemax"))).toBe(true);
  });
});
