import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { Page } from "patchright";
import type { Session } from "../src/browser/session.js";
import { PreflightDraftProtectedError } from "../src/errors.js";

const goHome = vi.fn();
const openConversation = vi.fn();
const clearComposer = vi.fn();
const setConnector = vi.fn();
const model = vi.fn();
const probe = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({ goHome: (...a: unknown[]) => goHome(...a), isLoggedIn: async () => true }));
vi.mock("../src/api/conversation-filing.js", () => ({ requireAccount: async () => {} }));
vi.mock("../src/browser/conversation.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/browser/conversation.js")>(),
  openConversation: (...a: unknown[]) => openConversation(...a),
  clearComposer: (...a: unknown[]) => clearComposer(...a),
  setConnector: (...a: unknown[]) => setConnector(...a),
  ensureProSixMaximum: (...a: unknown[]) => model(...a),
  probePromptDelivery: (...a: unknown[]) => probe(...a),
}));
const { assertPreflightDraftSafe } = await import("../src/browser/conversation.js");
const { runInteractionPreflight } = await import("../src/core/orchestrator.js");

// Synthetic DOM surfaces execute the actual in-page admission function. Reads
// return content only inside this VM; the Page boundary returns a boolean.
function fixture(initial: Partial<State> = {}) {
  const state: State = { text: "", attachment: false, file: false, mention: "", unknown: false,
    readable: true, count: 1, form: true, unknownButton: false, url: "https://chatgpt.com/", ...initial };
  const page = {
    url: () => state.url,
    keyboard: { press: vi.fn(async () => {}) },
    evaluate: vi.fn(async (fn: Function, arg: unknown) => {
      if (!state.readable) throw new Error("synthetic evaluation failure with private content");
      const tokens = state.mention ? [{ tagName: "A", textContent: state.mention, remove() {} }] : [];
      const copy = { textContent: state.text, querySelectorAll: (selector: string) => selector === "*"
        ? (state.unknown ? [{ tagName: "CUSTOM-TOKEN", attributes: [] }] : []) : tokens };
      const form = {
        querySelector: () => state.attachment ? {} : null,
        querySelectorAll: () => state.unknownButton ? [{ closest: () => null, matches: () => false }] : [],
      };
      const composer = { isConnected: true, getClientRects: () => [{}], innerText: state.text || state.mention, cloneNode: () => copy,
        closest: () => state.form ? form : null, contains: () => false };
      const document = {
        body: { childNodes: state.count ? [composer] : [] },
        querySelectorAll: (selector: string) => selector === 'input[type="file"]'
          ? [{ files: state.file ? [{}] : [] }] : Array.from({ length: state.count }, () => composer),
        createTreeWalker: () => ({ nextNode: () => false }),
      };
      return runInNewContext(`(${fn.toString()})(arg)`, {
        arg, document, location: new URL(state.url), HTMLTextAreaElement: class {}, NodeFilter: { SHOW_TEXT: 4 },
      });
    }),
  } as unknown as Page;
  return { state, page, session: { page } as Session };
}
interface State {
  text: string; attachment: boolean; file: boolean; mention: string; unknown: boolean;
  readable: boolean; count: number; form: boolean; unknownButton: boolean; url: string;
}
const options = { model: "gpt-6-pro" as const, connector: "fixture", gizmoId: "project", expectedAccountEmail: "fixture@example.com" };

beforeEach(() => {
  vi.resetAllMocks();
  goHome.mockResolvedValue(undefined);
  openConversation.mockResolvedValue(undefined);
  clearComposer.mockImplementation(async (_page, guard) => { await guard?.(); });
  setConnector.mockResolvedValue(undefined);
  model.mockResolvedValue({ power: 4 });
});

describe("draft-safe interaction preflight", () => {
  it.each([
    { text: "private draft" }, { text: "   " }, { attachment: true }, { file: true }, { mention: "private mention" },
    { unknown: true }, { readable: false }, { count: 0 }, { count: 2 }, { form: false }, { unknownButton: true },
  ])("refuses initial protected/unknown state without navigation, clear, or Escape: %j", async initial => {
    const { state, page, session } = fixture(initial);
    const before = { ...state };
    await expect(runInteractionPreflight(options, session)).rejects.toBeInstanceOf(PreflightDraftProtectedError);
    expect(state).toEqual(before);
    expect(goHome).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
    expect(setConnector).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it.each(["home", "project", "model", "cleanup"])("preserves rich drafts appearing at %s", async stage => {
    const { state, session } = fixture();
    const introduce = () => { state.attachment = true; state.text = "private arriving draft"; };
    if (stage === "home") goHome.mockImplementationOnce(introduce);
    if (stage === "project") openConversation.mockImplementationOnce(introduce);
    if (stage === "model") model.mockImplementationOnce(() => { introduce(); return { power: 4 }; });
    if (stage === "cleanup") goHome.mockResolvedValueOnce(undefined).mockImplementationOnce(introduce);
    await expect(runInteractionPreflight(options, session)).rejects.toBeInstanceOf(PreflightDraftProtectedError);
    expect(state.text).toBe("private arriving draft");
    expect(state.attachment).toBe(true);
    expect(goHome).toHaveBeenCalledTimes(stage === "cleanup" ? 2 : 1);
    expect(clearComposer).toHaveBeenCalledTimes(stage === "model" || stage === "cleanup" ? 1 : stage === "project" ? 1 : 0);
  });

  it("preserves a draft arriving alongside another verification error", async () => {
    const { state, session } = fixture();
    const original = new Error("model verification failed");
    model.mockImplementationOnce(() => { state.mention = "new user token"; throw original; });
    await expect(runInteractionPreflight(options, session)).rejects.toBe(original);
    expect(state.mention).toBe("new user token");
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it("admits pristine about:blank and completes an empty preflight with its owned connector", async () => {
    const { state, session } = fixture({ url: "about:blank", count: 0 });
    goHome.mockImplementation(() => { state.url = "https://chatgpt.com/"; state.count = 1; state.mention = ""; });
    setConnector.mockImplementation(() => { state.mention = "fixture"; });
    await expect(runInteractionPreflight(options, session)).resolves.toMatchObject({ connectorVerified: true, power: 4 });
    expect(openConversation).toHaveBeenCalledWith(session.page, expect.any(Object), expect.any(Function), true);
    expect(setConnector).toHaveBeenCalledWith(session.page, "fixture", true);
    expect(goHome).toHaveBeenCalledTimes(2);
  });

  it("only admits exact owned text or token, never extra text or attachments", async () => {
    const { state, page } = fixture({ text: "owned probe" });
    await expect(assertPreflightDraftSafe(page, { text: "owned probe" })).resolves.toBeUndefined();
    state.text += " ";
    await expect(assertPreflightDraftSafe(page, { text: "owned probe" })).rejects.toThrow("safe draft ownership");
    state.text += " plus private user draft";
    await expect(assertPreflightDraftSafe(page, { text: "owned probe" })).rejects.toThrow("safe draft ownership");
    state.text = ""; state.mention = "fixture";
    await expect(assertPreflightDraftSafe(page, { connector: "fixture" })).resolves.toBeUndefined();
    state.file = true;
    await expect(assertPreflightDraftSafe(page, { connector: "fixture" })).rejects.toBeInstanceOf(PreflightDraftProtectedError);
  });

  it("does not expose refused content in its typed error", async () => {
    const { page } = fixture({ text: "sensitive fixture" });
    const error = await assertPreflightDraftSafe(page).catch(error => error);
    expect(error).toMatchObject({ code: "preflight_draft_protected", promptSubmitted: false });
    expect(JSON.stringify(error)).not.toContain("sensitive");
    expect(error.message).not.toContain("sensitive");
  });
});
