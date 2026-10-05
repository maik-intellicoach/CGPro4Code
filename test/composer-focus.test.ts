import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { Page } from "patchright";

// P-035 2026-10-05. ChatGPT's Plugins UI renders the connector chip in the
// composer as a link to `/plugins/<id>`. On a composer holding only that chip
// the centre IS the chip, so the old `composer.click()` followed the link and
// every ms1980 preflight landed on the "Customize" plugin page, where the next
// guard refused `composer_count:0`. These cases run the REAL in-page focus
// functions against a DOM stand-in whose centre is that chip.

const requireSelector = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: vi.fn(async () => null),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));

const { clearComposer } = await import("../src/browser/conversation.js");
const { PreSubmitInteractionError } = await import("../src/errors.js");

const PROJECT_URL = "https://chatgpt.com/g/g-p-test/project";
const PLUGIN_URL = "https://chatgpt.com/plugins/plugin_asdk_app_test";

interface Scenario {
  page: Page;
  composer: { click: ReturnType<typeof vi.fn>; evaluate: ReturnType<typeof vi.fn> };
  presses: string[];
  state: { url: string; active: unknown };
}

/**
 * A composer that holds only the chip. `focusable: false` models a host whose
 * focus() does not take; `cornerHit` says what each corner probe hits.
 */
function scenario(options: { focusable?: boolean; cornerHit?: "chip" | "host"; navigateOnFocus?: boolean } = {}): Scenario {
  const state = { url: PROJECT_URL, active: null as unknown };
  const presses: string[] = [];
  const chip = {
    tagName: "A",
    closest: (selector: string) => (selector.includes("a") ? chip : null),
  };
  const paragraph = { tagName: "P", closest: () => null, children: [chip] };
  const host = {
    tagName: "DIV",
    lastElementChild: paragraph,
    focus: () => {
      if (options.focusable !== false) state.active = host;
      if (options.navigateOnFocus) state.url = PLUGIN_URL;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 40 }),
    contains: (node: unknown) => node === chip || node === paragraph || node === host,
    closest: () => null,
  };
  const document = {
    get activeElement() { return state.active; },
    createRange: () => ({ selectNodeContents: () => {}, collapse: () => {} }),
    elementFromPoint: () => (options.cornerHit === "host" ? host : chip),
  };
  const window = { getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }) };
  const composer = {
    // The centre click: on this composer it lands on the chip and follows it.
    click: vi.fn(async (opts?: { position?: unknown }) => {
      if (!opts?.position) state.url = PLUGIN_URL;
    }),
    evaluate: vi.fn(async (fn: Function, arg: unknown) =>
      runInNewContext(`(${fn.toString()})(element, arg)`, { element: host, arg, document, window })),
  };
  const page = {
    url: () => state.url,
    keyboard: { press: vi.fn(async (key: string) => { presses.push(key); }) },
    waitForTimeout: vi.fn(async () => {}),
  } as unknown as Page;
  return { page, composer, presses, state };
}

beforeEach(() => {
  requireSelector.mockReset();
});

describe("composer focus never follows the plugin-chip link (P-035 2026-10-05)", () => {
  it("focuses a chip-only composer in-page, stays on the Project page, and still clears", async () => {
    const s = scenario();
    requireSelector.mockResolvedValue(s.composer);

    await clearComposer(s.page);

    expect(s.composer.click).not.toHaveBeenCalled();
    expect(s.state.url).toBe(PROJECT_URL);
    expect(s.presses).toEqual(["Meta+A", "Backspace"]);
  });

  it("keeps every guard in order around the focus", async () => {
    const s = scenario();
    requireSelector.mockResolvedValue(s.composer);
    const order: string[] = [];
    const guard = vi.fn(async () => { order.push(`guard@${s.state.url === PROJECT_URL ? "project" : "elsewhere"}`); });
    vi.mocked(s.page.keyboard.press).mockImplementation(async (key: string) => { order.push(key); });

    await clearComposer(s.page, guard);

    expect(order).toEqual(["guard@project", "guard@project", "Meta+A", "guard@project", "Backspace"]);
  });

  it("refuses rather than click when focus fails and every probe point is the chip", async () => {
    const s = scenario({ focusable: false, cornerHit: "chip" });
    requireSelector.mockResolvedValue(s.composer);

    const error = await clearComposer(s.page).catch((caught) => caught);

    expect(error).toBeInstanceOf(PreSubmitInteractionError);
    expect(error).toMatchObject({ code: "prompt_delivery_incomplete", phase: "prompt_delivery", promptSubmitted: false });
    expect(s.composer.click).not.toHaveBeenCalled();
    expect(s.presses).toEqual([]);
  });

  it("falls back to a click only at a probe point proven outside the chip", async () => {
    const s = scenario({ focusable: false, cornerHit: "host" });
    requireSelector.mockResolvedValue(s.composer);

    await clearComposer(s.page);

    expect(s.composer.click).toHaveBeenCalledTimes(1);
    expect(s.composer.click.mock.calls[0][0]).toMatchObject({ position: { x: 394, y: 34 } });
    expect(s.state.url).toBe(PROJECT_URL);
  });

  it("names a navigation during the focus as a typed pre-submit failure, not a missing composer", async () => {
    const s = scenario({ navigateOnFocus: true });
    requireSelector.mockResolvedValue(s.composer);
    const guard = vi.fn(async () => {});

    const error = await clearComposer(s.page, guard).catch((caught) => caught);

    expect(error).toBeInstanceOf(PreSubmitInteractionError);
    expect(error).toMatchObject({ code: "chat_surface_unconfirmed", phase: "prompt_delivery", promptSubmitted: false });
    expect(error.message).toContain("/plugins");
    // Only the guard before the focus ran; nothing was typed on the plugin page.
    expect(guard).toHaveBeenCalledTimes(1);
    expect(s.presses).toEqual([]);
  });
});
