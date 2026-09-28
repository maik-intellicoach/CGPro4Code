import { describe, it, expect } from "vitest";
import {
  summariseDomShape,
  type DomShapeInput,
  type DomShapeNode,
  type DomShapeRoot,
} from "../src/browser/dom-shape.js";

/**
 * P-035 2026-09-28 (vendor r39). The probe's whole reason to exist is that the
 * conversation markup moved out from under every message selector. The one
 * thing that must never move with it is the conversation's TEXT: this file
 * proves the summary is shape only.
 *
 * The fake DOM is deliberately a stub, not a real parser: `querySelectorAll`
 * answers from a selector -> elements map, which is enough to drive every
 * branch the summariser has (main fallback, attribute scan, ranked lists,
 * unanswerable candidate) without a DOM dependency.
 */

interface FakeAttr {
  name: string;
  value: string;
}

class FakeElement implements DomShapeNode {
  constructor(
    readonly tagName: string,
    private readonly attrs: FakeAttr[] = [],
    private readonly text = "",
    private readonly descendants: FakeElement[] = [],
    private readonly subtree: Map<string, FakeElement[]> = new Map(),
  ) {}

  get attributes(): FakeAttr[] {
    return this.attrs;
  }

  get textContent(): string {
    return this.text;
  }

  getAttribute(name: string): string | null {
    for (const attr of this.attrs) if (attr.name === name) return attr.value;
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === "*") return this.descendants;
    return this.subtree.get(selector) ?? [];
  }
}

class FakeRoot implements DomShapeRoot {
  constructor(
    private readonly main: FakeElement | null,
    readonly body: FakeElement | null,
    private readonly answers: Map<string, FakeElement[]>,
    private readonly invalid: Set<string> = new Set(),
  ) {}

  querySelector(selector: string): FakeElement | null {
    if (selector === "main") return this.main;
    return this.answers.get(selector)?.[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    // A Playwright-only pseudo-class (`:has-text(...)`) is not valid CSS in the
    // page; the summariser must report that as unanswerable, not as "no match".
    if (this.invalid.has(selector)) throw new Error(`invalid selector: ${selector}`);
    return this.answers.get(selector) ?? [];
  }
}

const SENTINEL = "SENTINEL-DO-NOT-LEAK";

function sentinelElements(): { turn3: FakeElement; turn4: FakeElement; stop: FakeElement } {
  const turn3 = new FakeElement(
    "ARTICLE",
    [
      { name: "class", value: "markdown prose" },
      { name: "data-message-author-role", value: "assistant" },
      { name: "data-testid", value: "conversation-turn-3" },
      { name: "role", value: "article" },
      { name: "title", value: SENTINEL },
    ],
    `${SENTINEL} a long assistant answer body`,
  );
  const turn4 = new FakeElement(
    "DIV",
    [
      { name: "class", value: `markdown ${SENTINEL}` },
      { name: "data-foo", value: SENTINEL },
      { name: "data-testid", value: "conversation-turn-4" },
      { name: "aria-label", value: SENTINEL },
    ],
    "short",
  );
  const stop = new FakeElement(
    "BUTTON",
    [
      { name: "data-testid", value: "stop-button" },
      { name: "role", value: "button" },
    ],
    "Stop",
  );
  return { turn3, turn4, stop };
}

function shapeInput(): DomShapeInput {
  return {
    conversationPath: true,
    candidates: [
      {
        key: "anyMessages",
        selectors: [
          "div[data-message-author-role]",
          "main article",
          'button:has-text("Stop generating")',
        ],
      },
      { key: "assistantMessages", selectors: ['div[data-message-author-role="assistant"]'] },
    ],
    tagProbes: ["article", "pre", "button", '[class*="markdown"]'],
  };
}

describe("summariseDomShape", () => {
  it("returns names, counts and lengths, never text or non-whitelisted values", () => {
    const { turn3, turn4, stop } = sentinelElements();
    // The tag probes resolve INSIDE main, so main answers them; the candidates
    // and the author-role scan are document-wide, so the root answers those.
    const main = new FakeElement(
      "MAIN",
      [],
      "",
      [turn3, turn4, stop],
      new Map<string, FakeElement[]>([
        ["article", [turn3]],
        ["button", [stop]],
        ['[class*="markdown"]', [turn3, turn4]],
      ]),
    );
    const user = new FakeElement("DIV", [{ name: "data-message-author-role", value: "user" }], "hi");
    const assistantA = new FakeElement("DIV", [{ name: "data-message-author-role", value: "assistant" }], "a");
    const assistantB = new FakeElement("DIV", [{ name: "data-message-author-role", value: "assistant" }], "b");
    const root = new FakeRoot(
      main,
      main,
      new Map<string, FakeElement[]>([
        ["[data-message-author-role]", [user, assistantA, assistantB]],
        ["div[data-message-author-role]", [user, assistantA, assistantB]],
        ['div[data-message-author-role="assistant"]', [assistantA, assistantB]],
        ["main article", [turn3]],
      ]),
      new Set(['button:has-text("Stop generating")']),
    );

    const result = summariseDomShape(shapeInput(), root);

    expect(result.url_path_kind).toBe("conversation");
    // Names only, and only `data-*` names: title/aria-label/class/role values
    // are never counted here.
    expect(result.data_attr_names).toEqual([
      { name: "data-foo", count: 1 },
      { name: "data-message-author-role", count: 1 },
      { name: "data-testid", count: 3 },
    ]);
    expect(result.testids).toEqual([
      { value: "conversation-turn-3", count: 1 },
      { value: "conversation-turn-4", count: 1 },
      { value: "stop-button", count: 1 },
    ]);
    expect(result.roles).toEqual([
      { value: "article", count: 1 },
      { value: "button", count: 1 },
    ]);
    expect(result.author_roles).toEqual([
      { value: "assistant", count: 2 },
      { value: "user", count: 1 },
    ]);
    expect(result.tags).toEqual([
      { match: "article", count: 1 },
      { match: "pre", count: 0 },
      { match: "button", count: 1 },
      { match: '[class*="markdown"]', count: 2 },
    ]);
    expect(result.candidates).toEqual([
      {
        key: "anyMessages",
        matches: [
          { selector: "div[data-message-author-role]", count: 3 },
          { selector: "main article", count: 1 },
          // -1, not 0: `:has-text()` cannot be asked in-page at all, and an
          // unanswerable question must not read as "this matched nothing".
          { selector: 'button:has-text("Stop generating")', count: -1 },
        ],
      },
      {
        key: "assistantMessages",
        matches: [{ selector: 'div[data-message-author-role="assistant"]', count: 2 }],
      },
    ]);

    // The ten heaviest elements inside main, longest text first.
    expect(result.turn_containers).toHaveLength(3);
    expect(result.turn_containers[0]).toEqual({
      tag: "article",
      testid: "conversation-turn-3",
      dataAttrs: ["data-message-author-role", "data-testid"],
      classCount: 2,
      textLength: `${SENTINEL} a long assistant answer body`.length,
    });
    expect(result.turn_containers[1].tag).toBe("div");
    expect(result.turn_containers[1].classCount).toBe(2);

    // The contract, in one assertion: no text node and no non-whitelisted
    // attribute value survives anywhere in the payload.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("falls back to document.body when the conversation has no main", () => {
    const { turn3 } = sentinelElements();
    const body = new FakeElement("BODY", [], "", [turn3]);
    const root = new FakeRoot(null, body, new Map([["main article", [turn3]]]));

    const result = summariseDomShape(
      { conversationPath: false, candidates: [{ key: "anyMessages", selectors: ["main article"] }], tagProbes: [] },
      root,
    );

    expect(result.url_path_kind).toBe("other");
    expect(result.data_attr_names).toEqual([
      { name: "data-message-author-role", count: 1 },
      { name: "data-testid", count: 1 },
    ]);
    expect(result.candidates).toEqual([
      { key: "anyMessages", matches: [{ selector: "main article", count: 1 }] },
    ]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
