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
    // P-035 2026-09-28 (vendor r42). The two new reads are seeded too, each with
    // the sentinel in a NON-whitelisted position: beside the percent and before
    // "Next reset is on", inside a notice's text, after the worked-for line and
    // in attributes nothing reads. The last assertion in this test proves none of
    // it survives.
    const usagePanel = new FakeElement(
      "DIV",
      [{ name: "aria-label", value: SENTINEL }],
      `${SENTINEL} 6% usage remaining · Resets every week · Next reset is on Oct 4 at 12:58 AM`,
    );
    const sentinelNotice = new FakeElement(
      "DIV",
      [
        { name: "role", value: "alert" },
        { name: "title", value: SENTINEL },
      ],
      `Something went wrong ${SENTINEL}`,
    );
    const sentinelUnit = new FakeElement(
      "DIV",
      [
        { name: "data-content-search-unit-key", value: "unit-sentinel" },
        { name: "data-conversation-role", value: "assistant" },
        { name: "class", value: `markdown ${SENTINEL}` },
        { name: "title", value: SENTINEL },
      ],
      `Worked for 2m 9s ${SENTINEL}`,
      [sentinelNotice],
      new Map<string, FakeElement[]>([
        ["*", [sentinelNotice]],
        ["button", []],
        ["[data-user-message-bubble]", []],
      ]),
    );
    const root = new FakeRoot(
      main,
      main,
      new Map<string, FakeElement[]>([
        ["[data-message-author-role]", [user, assistantA, assistantB]],
        ["div[data-message-author-role]", [user, assistantA, assistantB]],
        ['div[data-message-author-role="assistant"]', [assistantA, assistantB]],
        ["main article", [turn3]],
        ["*", [usagePanel, sentinelUnit]],
        ["[data-content-search-unit-key]", [sentinelUnit]],
        ["[data-content-search-unit-key]:not(:has([data-user-message-bubble]))", [sentinelUnit]],
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

    // The r42 reads are populated (so an empty implementation cannot pass this
    // test by accident) and are still content-free.
    expect(result.usage_panel).toEqual({
      found: true,
      percent: 6,
      resets: "Oct 4 at 12:58 AM",
      period: "week",
    });
    expect(result.reply_chrome.buttons).toEqual([]);
    expect(result.reply_chrome.notices).toEqual([
      { len: `Something went wrong ${SENTINEL}`.length, tokens: ["went-wrong"] },
    ]);
    expect(result.reply_chrome.header).toEqual({ exists: true, duration: "2m 9s" });

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

  // P-035 2026-09-28 (vendor r40). The 2026-09 message unit carries
  // `data-content-search-unit-key` and `data-conversation-role`; the probe now
  // reports one `units` entry per unit plus the enumerated role values, and
  // still carries no text.
  it("reports message units and conversation roles as shape only", () => {
    const roleSpan = new FakeElement(
      "SPAN",
      [{ name: "data-conversation-role", value: "user" }],
      SENTINEL,
    );
    const bubble = new FakeElement("DIV", [{ name: "data-user-message-bubble", value: "" }], SENTINEL);
    const userUnit = new FakeElement(
      "DIV",
      [{ name: "data-content-search-unit-key", value: "unit-1" }],
      SENTINEL,
      [bubble, roleSpan],
      new Map<string, FakeElement[]>([
        ["[data-user-message-bubble]", [bubble]],
        ['[class*="markdown"]', []],
        ["[data-markdown-copy]", []],
        ["[data-conversation-role]", [roleSpan]],
      ]),
    );
    const md1 = new FakeElement("DIV", [{ name: "class", value: "markdown-block" }], SENTINEL);
    const md2 = new FakeElement("DIV", [{ name: "class", value: "markdown-body" }], SENTINEL);
    const copy = new FakeElement("DIV", [{ name: "data-markdown-copy", value: "" }], SENTINEL);
    const assistantUnit = new FakeElement(
      "DIV",
      [
        { name: "data-content-search-unit-key", value: "unit-2" },
        { name: "data-conversation-role", value: "assistant" },
      ],
      SENTINEL,
      [md1, md2, copy],
      new Map<string, FakeElement[]>([
        ["[data-user-message-bubble]", []],
        ['[class*="markdown"]', [md1, md2]],
        ["[data-markdown-copy]", [copy]],
        ["[data-conversation-role]", []],
      ]),
    );
    const main = new FakeElement(
      "MAIN",
      [],
      "",
      [userUnit, assistantUnit],
      new Map<string, FakeElement[]>([["[data-content-search-unit-key]", [userUnit, assistantUnit]]]),
    );
    const root = new FakeRoot(
      main,
      main,
      new Map<string, FakeElement[]>([
        ["[data-content-search-unit-key]", [userUnit, assistantUnit]],
        ["[data-conversation-role]", [assistantUnit, roleSpan]],
      ]),
    );

    const result = summariseDomShape({ conversationPath: true, candidates: [], tagProbes: [] }, root);

    expect(result.units).toEqual([
      {
        index: 0,
        hasUserBubble: true,
        markdownCount: 0,
        markdownCopyCount: 0,
        textLength: SENTINEL.length,
        conversationRole: "user",
      },
      {
        index: 1,
        hasUserBubble: false,
        markdownCount: 2,
        markdownCopyCount: 1,
        textLength: SENTINEL.length,
        conversationRole: "assistant",
      },
    ]);
    expect(result.conversation_roles).toEqual([
      { value: "assistant", count: 1 },
      { value: "user", count: 1 },
    ]);
    // The whole contract once more: no text node survives in the new fields.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  // P-035 2026-09-28 (vendor r42). The live question was WHY a Pro reply stopped
  // at 220 characters. Two candidates: the account's weekly allowance ran out
  // (the page shows a usage panel) or the reply carried an error notice with a
  // retry control. Both are read here as numbers and fixed words only.
  it("reports the usage panel as percent, period and reset line only", () => {
    const panelText = "6% usage remaining · Resets every week · Next reset is on Oct 4 at 12:58 AM";
    const panel = new FakeElement("DIV", [], panelText);
    // Every ancestor matches too, with the panel's text plus more. The SMALLEST
    // match is the panel itself, so the ancestor's extra words must not reach
    // `resets`.
    const outer = new FakeElement("DIV", [], `${panelText} and then a footer`);
    const body = new FakeElement("BODY", [], "", [outer, panel]);
    const root = new FakeRoot(null, body, new Map<string, FakeElement[]>([["*", [outer, panel]]]));

    const result = summariseDomShape({ conversationPath: true, candidates: [], tagProbes: [] }, root);

    expect(result.usage_panel).toEqual({
      found: true,
      percent: 6,
      resets: "Oct 4 at 12:58 AM",
      period: "week",
    });
    // The ancestor's extra text is not part of any reported field.
    expect(JSON.stringify(result)).not.toContain("footer");
  });

  // P-035 G3 r45 (2026-09-28). The r42 live probe read the percent but `resets:
  // "-"`, because the reset sentence is a SIBLING of the percent line: the old
  // "smallest element holding the percent" rule stopped at the percent line. The
  // panel is now the smallest element holding BOTH phrases -- for two sibling
  // lines that is their container -- so both fields come from one unit.
  it("reads a panel whose percent and reset lines are siblings under one container", () => {
    const percentLine = new FakeElement("DIV", [], "6% usage remaining · Resets every week");
    const resetLine = new FakeElement("DIV", [], "Next reset is on Oct 4 at 12:58 AM");
    const container = new FakeElement(
      "DIV",
      [{ name: "title", value: SENTINEL }],
      `${SENTINEL} ${percentLine.textContent} · ${resetLine.textContent}`,
      [percentLine, resetLine],
    );
    const body = new FakeElement("BODY", [], "", [container]);
    const root = new FakeRoot(
      null,
      body,
      new Map<string, FakeElement[]>([["*", [container, percentLine, resetLine]]]),
    );

    const result = summariseDomShape({ conversationPath: true, candidates: [], tagProbes: [] }, root);

    // The reset is reported as the panel's own text ("Oct 4 at 12:58 AM"), not as
    // an ISO instant, matching the r42 field contract.
    expect(result.usage_panel).toEqual({
      found: true,
      percent: 6,
      resets: "Oct 4 at 12:58 AM",
      period: "week",
    });
    // The sentinel sat beside the numbers and in a non-whitelisted attribute.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("reports an absent usage panel and an absent reply unit without inventing values", () => {
    const body = new FakeElement("BODY", [], "a conversation with no usage panel and no reply chrome");
    const root = new FakeRoot(null, body, new Map<string, FakeElement[]>([["*", [body]]]));

    const result = summariseDomShape({ conversationPath: true, candidates: [], tagProbes: [] }, root);

    expect(result.usage_panel).toEqual({ found: false, percent: 0, resets: "-", period: "-" });
    expect(result.reply_chrome).toEqual({
      buttons: [],
      notices: [],
      header: { exists: false, duration: "-" },
    });
  });

  it("reports reply buttons, notice shapes and the worked-for header as chrome only", () => {
    const copy = new FakeElement("BUTTON", [{ name: "aria-label", value: "Copy" }], "Copy");
    const retry = new FakeElement("BUTTON", [{ name: "aria-label", value: "Try again" }], "Try again");
    const innerNotice = new FakeElement("SPAN", [], "Something went wrong. Try again later");
    // The outer wrapper matches the notice predicate too, but it holds a matching
    // child, so it is a container: only the innermost notice is reported.
    const outerNotice = new FakeElement(
      "DIV",
      [{ name: "role", value: "status" }],
      "Something went wrong. Try again later",
      [innerNotice],
      new Map<string, FakeElement[]>([["*", [innerNotice]]]),
    );
    const answer = new FakeElement("DIV", [{ name: "class", value: "markdown" }], "The answer itself");
    const replyUnit = new FakeElement(
      "DIV",
      [
        { name: "data-content-search-unit-key", value: "unit-2" },
        { name: "data-conversation-role", value: "assistant" },
      ],
      "Worked for 2m 9s",
      [copy, retry, outerNotice, innerNotice, answer],
      new Map<string, FakeElement[]>([
        ["button", [copy, retry]],
        ["*", [copy, retry, outerNotice, innerNotice, answer]],
        ["[data-user-message-bubble]", []],
        ['[class*="markdown"]', [answer]],
        ["[data-markdown-copy]", []],
        ["[data-conversation-role]", []],
      ]),
    );
    const userUnit = new FakeElement(
      "DIV",
      [
        { name: "data-content-search-unit-key", value: "unit-1" },
        { name: "data-conversation-role", value: "user" },
      ],
      "the question",
      [],
      new Map<string, FakeElement[]>([
        ["[data-user-message-bubble]", [new FakeElement("DIV", [], "the question")]],
      ]),
    );
    const body = new FakeElement("BODY", [], "", [userUnit, replyUnit]);
    const root = new FakeRoot(
      null,
      body,
      new Map<string, FakeElement[]>([
        ["[data-content-search-unit-key]", [userUnit, replyUnit]],
        ["[data-content-search-unit-key]:not(:has([data-user-message-bubble]))", [replyUnit]],
      ]),
    );

    const result = summariseDomShape({ conversationPath: true, candidates: [], tagProbes: [] }, root);

    // Labels only, sanitised; the buttons' own text never travels.
    expect(result.reply_chrome.buttons).toEqual(["Copy", "Try again"]);
    // The shape of each notice, in document order: its length and the fixed
    // vocabulary words it matched -- "try again" (r38) plus "went wrong" (r42) --
    // never text. The "Try again" button is a notice candidate too, because its
    // own text matches the predicate; the outer `role="status"` wrapper is not,
    // because it holds a matching child.
    expect(result.reply_chrome.notices).toEqual([
      { len: "Try again".length, tokens: ["try-again"] },
      { len: "Something went wrong. Try again later".length, tokens: ["try-again", "went-wrong"] },
    ]);
    expect(result.reply_chrome.header).toEqual({ exists: true, duration: "2m 9s" });
    // The answer body sits inside the reply unit and must not surface anywhere.
    expect(JSON.stringify(result)).not.toContain("The answer itself");
    expect(JSON.stringify(result)).not.toContain("Something went wrong");
  });
});
