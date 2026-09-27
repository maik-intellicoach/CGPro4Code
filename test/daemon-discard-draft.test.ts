import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Page } from "patchright";
import type { Session } from "../src/browser/session.js";
import { PreflightDraftProtectedError } from "../src/errors.js";

const goHome = vi.fn();
const requireSelector = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  goHome: (...a: unknown[]) => goHome(...a),
  isLoggedIn: async () => true,
  fetchAuthSessionInPage: async () => ({}),
  requireSelector: (...a: unknown[]) => requireSelector(...a),
  requireSelectorPatient: async () => ({}),
  firstResolved: async () => null,
}));
import { AskQueue, PreAdmissionReaderBudget, handleRequest, type ServerState } from "../src/daemon/server.js";
// The real guard and the real clear, exercised through a synthetic page: the
// point of this endpoint is the ownership proof, so mocking it proves nothing.
const { assertPreflightDraftSafe } = await import("../src/browser/conversation.js");

const CONNECTOR = "p035-low-risk-workstation-intelli";
const TEXT = "the planning prompt this lane typed";

/**
 * A synthetic ChatGPT home surface: one composer inside one form, carrying this
 * call's connector chip (when named), the text beside it, and at most one
 * `Expand` button. `evaluate` runs the guard's REAL in-page function in a VM
 * over this DOM, so admission is decided by the guard's own code. `Backspace`
 * clears the surface, like the real composer.
 */
function fixture(initial: Partial<Surface> = {}) {
  const state: Surface = { chip: CONNECTOR, text: TEXT, expand: true, url: "https://chatgpt.com/", ...initial };
  const presses: string[] = [];
  const chip = state.chip === null ? null : {
    tagName: "A", textContent: state.chip, parentElement: null, closest: () => null, remove: vi.fn(),
  };
  // Rich nodes carry the real shape the guard reads: tagName, an attributes
  // list and own textContent, plus an empty child list (so a P with text is
  // never mistaken for the exempt placeholder paragraph).
  const materialize = (node: RichNode): object => ({
    tagName: node.tagName,
    attributes: (node.attributes ?? []).map(attribute => ({ name: attribute.name, value: attribute.value ?? "" })),
    textContent: node.textContent ?? "",
    children: [],
  });
  const copy = {
    get textContent() { return state.text; },
    querySelectorAll: (selector: string) => (selector === '[contenteditable="false"]'
      ? (state.chip === null ? [] : [chip]) : selector === "*" ? (state.rich ?? []).map(materialize) : []),
  };
  const control = {
    tagName: state.controlTag ?? "BUTTON",
    closest: () => null,
    matches: () => false,
    getAttribute: (name: string) => (name === "aria-label" ? "Expand" : null),
  };
  const form = {
    querySelector: () => null,
    contains: () => true,
    querySelectorAll: () => (state.expand ? [control] : []),
  };
  const click = vi.fn(async () => {});
  const composer = {
    isConnected: true,
    getClientRects: () => [{}],
    // Live reads: `Backspace` mutates the surface, and the guard must see the
    // surface as it is when it is judged.
    get innerText() { return (state.chip ?? "") + state.text; },
    value: "",
    cloneNode: () => copy,
    closest: (selector: string) => (selector === "form" ? form : null),
    contains: () => false,
    getAttribute: () => null,
    querySelectorAll: () => [],
    click,
  };
  const document = {
    body: { childNodes: [composer] },
    querySelectorAll: (selector: string) => (selector === 'input[type="file"]' ? [] : [composer]),
    // No text node outside the composer: the walk finds nothing to refuse.
    createTreeWalker: () => ({ nextNode: () => false, get currentNode() { return null; } }),
  };
  const page = {
    isClosed: () => false,
    composer,
    url: () => state.url,
    waitForTimeout: async () => {},
    keyboard: {
      press: vi.fn(async (key: string) => {
        presses.push(key);
        // Backspace clears the surface. The long-draft expander belongs to the
        // long draft, so it goes with it -- and that is exactly why the empty
        // re-proof can admit: an `Expand` left on an empty composer would be
        // chrome with no owned text to justify it.
        if (key === "Backspace" && !state.persist) {
          state.chip = null; state.text = ""; state.expand = false; state.rich = [];
        }
      }),
    },
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    evaluate: vi.fn(async (fn: Function, arg: unknown) => runInNewContext(`(${fn.toString()})(arg)`, {
      arg,
      document,
      location: new URL(state.url),
      HTMLTextAreaElement: class {},
      NodeFilter: { SHOW_TEXT: 4 },
    })),
  } as unknown as Page;
  return { state, page, composer, click, presses };
}
interface Surface {
  chip: string | null;
  text: string;
  expand: boolean;
  url: string;
  /** Leaves the draft on the page after `Backspace`, modelling a failed clear. */
  persist?: boolean;
  /** The tag the `Expand` control uses; only `BUTTON` is admissible. */
  controlTag?: string;
  /** Rich nodes inside the composer copy, cleared with the draft by `Backspace`. */
  rich?: RichNode[];
}
/** One rich node in the composer copy, with the fields the guard reads. */
interface RichNode {
  tagName: string;
  attributes?: Array<{ name: string; value?: string }>;
  textContent?: string;
}

function stateFor(page: Page): ServerState {
  return {
    session: { page } as Session,
    token: "fixture",
    startedAt: new Date(),
    background: true,
    queue: new AskQueue(8, 60_000),
    readerBudget: new PreAdmissionReaderBudget(8),
    askInFlight: false,
    currentInvocation: null,
    currentRunner: null,
    currentConversation: null,
    lastConversation: null,
    reloadConversation: null,
    interaction: { state: "unknown" },
  };
}

async function discard(
  s: ServerState,
  body: unknown = { connector: CONNECTOR, text: TEXT },
  token = "fixture",
) {
  const req = Object.assign(new EventEmitter(), {
    method: "POST", url: "/discard-owned-draft",
    headers: { authorization: `Bearer ${token}` }, setEncoding() {},
  });
  const result = { status: 0, body: "" };
  const res = Object.assign(new EventEmitter(), {
    writeHead(code: number) { result.status = code; },
    end(text: string) { result.body = text; },
  });
  const done = handleRequest(req as IncomingMessage, res as ServerResponse, s);
  req.emit("data", JSON.stringify(body));
  req.emit("end");
  await done;
  return result;
}

beforeEach(() => {
  vi.resetAllMocks();
  goHome.mockResolvedValue(undefined);
  requireSelector.mockImplementation(async (page: Page) => (page as unknown as { composer: unknown }).composer);
});

describe("POST /discard-owned-draft", () => {
  it("clears exactly the owned chip plus owned text and re-proves the lane empty", async () => {
    const { page } = fixture();
    const s = stateFor(page);
    const result = await discard(s, { connector: CONNECTOR, text: TEXT });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ cleared: true });
    // Home is judged before and after the clear; the queue is free again.
    expect(goHome).toHaveBeenCalledTimes(2);
    expect(s.queue.tryAcquire()).toBe(true);
    s.queue.release();
  });

  it("issues the clear only after the ownership proof, and only once", async () => {
    const { page, presses, click } = fixture();
    const result = await discard(stateFor(page), { connector: CONNECTOR, text: TEXT });
    expect(result.status).toBe(200);
    expect(presses).toEqual(["Meta+A", "Backspace"]);
    expect(click).toHaveBeenCalledTimes(1);
  });

  // P-035 2026-09-28 r24. ChatGPT marks each paragraph our automation pasted
  // with `data-prompt-literal-paste`, so the one approved discard call refused
  // `draft_not_owned reason=rich_attr:data-prompt-literal-paste` on a draft it
  // had itself introduced. Under the owned-text proof that one attribute name
  // is now skipped and the exact text still decides, so this exact paste clears.
  it("clears an exact pasted draft that carries the paste marker", async () => {
    const { page, presses } = fixture({ rich: [{
      tagName: "P", attributes: [{ name: "data-prompt-literal-paste", value: "" }], textContent: TEXT,
    }] });
    const result = await discard(stateFor(page), { connector: CONNECTOR, text: TEXT });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ cleared: true });
    expect(presses).toEqual(["Meta+A", "Backspace"]);
  });

  // P-035 2026-09-28 r25. The live refusal at vendor 740db47: this approved
  // call's own multi-line prompt was pasted, and `innerText` rendered its
  // paragraph breaks differently from the source newlines, so the
  // whitespace-strict comparison refused `owned_text_mismatch`. Normalising
  // whitespace on both sides admits exactly that paste and clears it.
  it("clears an exact multi-line pasted prompt whose rendered breaks differ", async () => {
    const source = "line one\nline two\nline three";
    const rendered = "line one\n\nline two\n\nline three";
    const { page, presses, click } = fixture({ text: rendered, rich: [{
      tagName: "P", attributes: [{ name: "data-prompt-literal-paste", value: "" }], textContent: rendered,
    }] });
    const result = await discard(stateFor(page), { connector: CONNECTOR, text: source });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ cleared: true });
    expect(presses).toEqual(["Meta+A", "Backspace"]);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("refuses one extra character in the draft and touches nothing", async () => {
    const { page, click, presses } = fixture({ text: `${TEXT}x` });
    const result = await discard(stateFor(page), { connector: CONNECTOR, text: TEXT });
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ error: "draft_not_owned", reason: "owned_text_mismatch" });
    expect(presses).toEqual([]);
    expect(click).not.toHaveBeenCalled();
  });

  it("refuses a draft whose chip is not the named connector", async () => {
    const { page, presses } = fixture({ chip: "some-other-connector" });
    const result = await discard(stateFor(page), { connector: CONNECTOR, text: TEXT });
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ error: "draft_not_owned", reason: "connector_token_text" });
    expect(presses).toEqual([]);
  });

  it("reports a clear that did not take as persisted, never as cleared", async () => {
    const { page } = fixture({ persist: true });
    const result = await discard(stateFor(page), { connector: CONNECTOR, text: TEXT });
    expect(result.status).toBe(409);
    // The re-proof names the first branch that refused on the surviving draft:
    // its expander is unknown again once no owned text is in force.
    expect(JSON.parse(result.body)).toEqual({ error: "draft_persisted", reason: "unknown_control:Expand" });
  });

  it("never displaces a busy lane and leaves the queue untouched", async () => {
    const { page } = fixture();
    const s = stateFor(page);
    s.queue.tryAcquire();
    const result = await discard(s);
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ error: "lane_busy" });
    expect(goHome).not.toHaveBeenCalled();
    s.queue.release();
  });

  it.each([
    { connector: "", text: TEXT },
    { connector: CONNECTOR },
    { text: TEXT },
    { connector: CONNECTOR, text: "" },
    { connector: 5, text: TEXT },
    { connector: CONNECTOR, text: 5 },
    { connector: "c".repeat(121), text: TEXT },
    { connector: CONNECTOR, text: "t".repeat(20_001) },
  ])("rejects a body outside the owned proof: %j", async body => {
    const { page } = fixture();
    const s = stateFor(page);
    const result = await discard(s, body);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "invalid_request" });
    expect(goHome).not.toHaveBeenCalled();
    expect(s.queue.tryAcquire()).toBe(true);
    s.queue.release();
  });

  it("keeps the lane's own draft behind the existing daemon token", async () => {
    const { page } = fixture();
    const result = await discard(stateFor(page), { connector: CONNECTOR, text: TEXT }, "wrong");
    expect(result.status).toBe(401);
    expect(goHome).not.toHaveBeenCalled();
  });
});

describe("the long-draft Expand control", () => {
  it("still refuses unknown_control:Expand when no owned text is in force", async () => {
    const { page } = fixture();
    const refused = await assertPreflightDraftSafe(page, { connector: CONNECTOR }).catch(error => error);
    expect(refused).toBeInstanceOf(PreflightDraftProtectedError);
    expect(refused.reason).toBe("unknown_control:Expand");
  });

  it("admits an exact owned chip plus text that carries the Expand button", async () => {
    const { page } = fixture();
    await expect(assertPreflightDraftSafe(page, { connector: CONNECTOR, text: TEXT })).resolves.toBeUndefined();
  });

  it("refuses an Expand on another tag even with the owned text in force", async () => {
    const { page } = fixture({ controlTag: "DIV" });
    const refused = await assertPreflightDraftSafe(page, { connector: CONNECTOR, text: TEXT }).catch(error => error);
    expect(refused).toBeInstanceOf(PreflightDraftProtectedError);
    expect(refused.reason).toBe("unknown_control:Expand");
  });

  it("keeps refusing a draft that carries both the owned turn and a stranger's text", async () => {
    const { page } = fixture({ text: `${TEXT} and a private draft` });
    const refused = await assertPreflightDraftSafe(page, { connector: CONNECTOR, text: TEXT }).catch(error => error);
    expect(refused).toBeInstanceOf(PreflightDraftProtectedError);
    expect(refused.reason).toBe("owned_text_mismatch");
  });
});
