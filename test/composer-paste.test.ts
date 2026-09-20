import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";

const firstResolved = vi.fn();
const requireSelector = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));

process.env.CGPRO_SEND_CLICK_ATTEMPTS = "1";
// The real poll waits up to 10 s for a large paste to render. These fakes
// answer instantly, so the bound is collapsed to keep the suite quick.
process.env.CGPRO_COMPOSER_PASTE_POLL_MS = "1";
process.env.CGPRO_COMPOSER_PASTE_SETTLE_MAX_MS = "1";

import { PreSubmitInteractionError } from "../src/errors.js";

const { sendPrompt, probePromptDelivery } = await import("../src/browser/conversation.js");

// P-035 2026-09-18, the measured cause of the delivery losses. Typing the
// prompt line by line runs it through ProseMirror's markdown input rules, and
// the inline-code rule destroyed 18 of 18 lines whose closing backtick was the
// last character of the insertion. Pasting is parsed by a different code path,
// so these tests are about one thing: does the prompt go through paste, and
// does it still arrive when paste is the one thing that fails?
describe("composer paste delivery", () => {
  let composed = "";
  // Meta+A selects all; Backspace then deletes the selection. Without that
  // state a plain Backspace looks like a clear, and the typed path's
  // input-rule guard (insert a trailing space, delete it) would wipe the
  // composer instead of removing one character.
  let selectedAll = false;

  /** `delivers` models what the page does with the dispatched paste event. */
  function fakePage(delivers: "all" | "nothing" | "throws"): Page {
    const composer = {
      innerText: async () => composed,
      // Two distinct callers: the paste dispatch, which carries the body, and
      // the cheap length read, which carries nothing and must not be treated
      // as a paste of `undefined`.
      evaluate: async (_fn: unknown, body?: string) => {
        if (body === undefined) return composed.length;
        if (delivers === "throws") throw new Error("Illegal invocation");
        if (delivers === "all") composed += body;
        return true;
      },
    };
    return {
      locator: vi.fn(() => ({ count: async () => 1, first: () => composer })),
      keyboard: {
        press: vi.fn(async (key: string) => {
          if (key === "Shift+Enter") composed += "\n";
          if (key === "Meta+A") selectedAll = true;
          if (key === "Backspace") {
            composed = selectedAll ? "" : composed.slice(0, -1);
            selectedAll = false;
          }
        }),
        type: vi.fn(async (text: string) => { composed += text; }),
        insertText: vi.fn(async (text: string) => { composed += text; }),
      },
      waitForTimeout: vi.fn(async () => {}),
      evaluate: vi.fn(async () => '{"stub":true}'),
    } as unknown as Page;
  }

  beforeEach(() => {
    composed = "";
    selectedAll = false;
    delete process.env.CGPRO_SKIP_COMPOSER_PASTE;
    firstResolved.mockReset();
    requireSelector.mockReset();
    // The composer locator sendPrompt itself resolves: reading it must return
    // what the fake page currently holds, or the completeness check is testing
    // a constant rather than the delivery.
    requireSelector.mockImplementation(async () => ({
      click: async () => {},
      getAttribute: async () => null,
      innerText: async () => composed,
      evaluate: async () => true,
    }));
    firstResolved.mockResolvedValue({
      click: async () => {},
      getAttribute: async () => null,
      innerText: async () => composed,
      evaluate: async () => true,
    });
  });

  const prompt = "first line\nsecond ends in `code`\nthird line";

  it("delivers the whole prompt through paste and never types it", async () => {
    const page = fakePage("all");
    await sendPrompt(page, prompt);
    expect(composed).toContain("second ends in `code`");
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalledWith("Shift+Enter");
  });

  it("falls back to typing when the paste lands nothing", async () => {
    const page = fakePage("nothing");
    await sendPrompt(page, prompt);
    // Three lines, so two Shift+Enter presses and three inserts.
    expect(page.keyboard.insertText).toHaveBeenCalledTimes(3);
    expect(composed).toContain("third line");
  });

  it("falls back to typing when the paste cannot be dispatched at all", async () => {
    const page = fakePage("throws");
    await sendPrompt(page, prompt);
    expect(page.keyboard.insertText).toHaveBeenCalledTimes(3);
    expect(composed).toContain("third line");
  });

  it("honours the escape hatch and types without attempting a paste", async () => {
    process.env.CGPRO_SKIP_COMPOSER_PASTE = "1";
    const page = fakePage("all");
    await sendPrompt(page, prompt);
    expect(page.keyboard.insertText).toHaveBeenCalledTimes(3);
  });
  describe("forced delivery and probe contracts", () => {
      it("reports paste when forced paste succeeds and never types", async () => {
        const page = fakePage("all");
        const probe = await probePromptDelivery(page, prompt, "paste");
        expect(probe.deliveredBy).toBe("paste");
        expect(probe.complete).toBe(true);
        expect(probe.arrivedChars).toBe(probe.requestedChars);
        expect(page.keyboard.insertText).not.toHaveBeenCalled();
        expect(page.keyboard.press).not.toHaveBeenCalledWith("Shift+Enter");
        // Probe cleanup: composer cleared afterwards
        expect(composed).toBe("");
      });

      it("throws prompt_delivery_incomplete with zero typed fallback when forced paste lands nothing", async () => {
        const page = fakePage("nothing");
        let captured: unknown;
        try {
          await probePromptDelivery(page, prompt, "paste");
        } catch (err) {
          captured = err;
        }
        expect(captured).toBeInstanceOf(PreSubmitInteractionError);
        expect((captured as PreSubmitInteractionError).code).toBe("prompt_delivery_incomplete");
        expect((captured as PreSubmitInteractionError).phase).toBe("prompt_delivery");
        expect(page.keyboard.insertText).not.toHaveBeenCalled();
        expect(page.keyboard.press).not.toHaveBeenCalledWith("Shift+Enter");
        // Probe cleanup: composer cleared even after failure
        expect(composed).toBe("");
      });

      it("throws prompt_delivery_incomplete with zero typed fallback when forced paste cannot be dispatched", async () => {
        const page = fakePage("throws");
        let captured: unknown;
        try {
          await probePromptDelivery(page, prompt, "paste");
        } catch (err) {
          captured = err;
        }
        expect(captured).toBeInstanceOf(PreSubmitInteractionError);
        expect((captured as PreSubmitInteractionError).code).toBe("prompt_delivery_incomplete");
        expect(page.keyboard.insertText).not.toHaveBeenCalled();
        expect(page.keyboard.press).not.toHaveBeenCalledWith("Shift+Enter");
        expect(composed).toBe("");
      });

      it("forced typed never enters paste and reports typed delivery", async () => {
        const plainPrompt = "first line\nsecond plain line\nthird line";
        const page = fakePage("all");
        const probe = await probePromptDelivery(page, plainPrompt, "typed");
        expect(probe.deliveredBy).toBe("typed");
        expect(page.keyboard.insertText).toHaveBeenCalledTimes(3);
        expect(probe.complete).toBe(true);
        expect(composed).toBe("");
      });

      it("auto mode retains conservative paste success and typed fallback contracts", async () => {
        // Auto with paste success
        const pageSuccess = fakePage("all");
        const probeSuccess = await probePromptDelivery(pageSuccess, prompt);
        expect(probeSuccess.deliveredBy).toBe("paste");
        expect(pageSuccess.keyboard.insertText).not.toHaveBeenCalled();
        expect(composed).toBe("");

        // Auto with paste failure -> falls back to typing all lines
        const pageFail = fakePage("nothing");
        const probeFail = await probePromptDelivery(pageFail, prompt);
        expect(probeFail.deliveredBy).toBe("typed");
        expect(pageFail.keyboard.insertText).toHaveBeenCalledTimes(3);
        expect(composed).toBe("");
      });

      it("recognises late-arriving paste and avoids typing duplicate content", async () => {
        let settled = false;
        const composer = {
          innerText: async () => composed,
          evaluate: async (_fn: unknown, body?: string) => {
            if (body === undefined) {
              if (settled) composed = prompt;
              return composed.length;
            }
            settled = true;
            return true;
          },
        };
        const page = {
          locator: vi.fn(() => ({ count: async () => 1, first: () => composer })),
          keyboard: {
            press: vi.fn(async (key: string) => {
              if (key === "Shift+Enter") composed += "\n";
              if (key === "Meta+A") selectedAll = true;
              if (key === "Backspace") {
                composed = selectedAll ? "" : composed.slice(0, -1);
                selectedAll = false;
              }
            }),
            type: vi.fn(async (text: string) => { composed += text; }),
            insertText: vi.fn(async (text: string) => { composed += text; }),
          },
          waitForTimeout: vi.fn(async () => {}),
          evaluate: vi.fn(async () => '{"stub":true}'),
        } as unknown as Page;

        const probe = await probePromptDelivery(page, prompt, "paste");
        expect(probe.deliveredBy).toBe("paste");
        expect(page.keyboard.insertText).not.toHaveBeenCalled();
        expect(composed).toBe("");
      });

      it("reports divergence and landed text when probe detects a shortfall", async () => {
        const shortfallRaw = "first line\nsecond ends in\nthird line";
        const composer = {
          innerText: async () => composed,
          evaluate: async (_fn: unknown, body?: string) => {
            if (body === undefined) return composed.length;
            composed = shortfallRaw;
            return true;
          },
        };
        const page = {
          locator: vi.fn(() => ({ count: async () => 1, first: () => composer })),
          keyboard: {
            press: vi.fn(async (key: string) => {
              if (key === "Shift+Enter") composed += "\n";
              if (key === "Meta+A") selectedAll = true;
              if (key === "Backspace") {
                composed = selectedAll ? "" : composed.slice(0, -1);
                selectedAll = false;
              }
            }),
            type: vi.fn(async (text: string) => { composed += text; }),
            insertText: vi.fn(async (text: string) => { composed += text; }),
          },
          waitForTimeout: vi.fn(async () => {}),
          evaluate: vi.fn(async () => '{"stub":true}'),
        } as unknown as Page;

        const probe = await probePromptDelivery(page, prompt, "paste");
        expect(probe.deliveredBy).toBe("paste");
        expect(probe.arrivedChars).toBeLessThan(probe.requestedChars);
        expect(probe.divergence).toBeDefined();
        expect(probe.landed).toBe("first line second ends in third line");
        expect(composed).toBe("");
      });

      it.each(["nothing", "all"] as const)("keeps errors content-free when %s delivery and cleanup fail", async (mode) => {
        const page = fakePage(mode);
        const press = vi.mocked(page.keyboard.press);
        const original = press.getMockImplementation()!;
        let clears = 0;
        press.mockImplementation(async (key, options) => {
          if (key === "Backspace" && ++clears === 2) throw new Error("SECRET_CLEANUP_SENTINEL");
          return original(key, options);
        });
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const result = probePromptDelivery(page, prompt, "paste");
          if (mode === "nothing") {
            await expect(result).rejects.toMatchObject({
              code: "prompt_delivery_incomplete",
              phase: "prompt_delivery",
              message: "forced paste delivery failed or was unconfirmed",
            });
            expect(warning).toHaveBeenCalledWith("[cgpro:composer] probe cleanup unverified after delivery failure");
          } else {
            await expect(result).rejects.toThrow("prompt delivery probe could not clear the composer");
          }
          expect(page.keyboard.insertText).not.toHaveBeenCalled();
          expect(page.evaluate).not.toHaveBeenCalled();
          expect(JSON.stringify(warning.mock.calls)).not.toContain("SECRET_CLEANUP_SENTINEL");
        } finally {
          warning.mockRestore();
        }
      });
    });
  });
