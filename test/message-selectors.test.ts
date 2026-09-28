import { describe, it, expect } from "vitest";
import type { Page } from "patchright";
import { SELECTORS, joinSelectors } from "../src/browser/selectors.js";
import { readLatestAssistantText } from "../src/browser/conversation.js";

/**
 * P-035 2026-09-28 (vendor r40). The 2026-09 conversation markup moved the
 * messages under `data-content-search-unit-key` and lost every attribute the old
 * selectors relied on. These tests drive the NEW selector strings against a
 * purpose-built fake DOM instead of a selector -> elements map, so the assertion
 * is about what the strings actually MEAN (attribute existence, `:has`,
 * `:not`, class substring and the descendant combinator) rather than about
 * whether the fake agrees with itself.
 *
 * The fake DOM is a tiny element model plus a matcher for exactly the subset of
 * CSS that the new message selectors use: `tag`, `[attr]`, `[attr="v"]`,
 * `[attr*=|^=|$=|~=|]="v"`, `.class`, `:not(...)`, `:has(...)` and the
 * descendant combinator. Any pseudo-class the matcher cannot answer (`:has-text`,
 * `:text-matches`, ...) answers "no match" rather than throwing, which is also
 * why a Playwright-only candidate never falsely matches here.
 */

class El {
  parent: El | null = null;
  constructor(
    readonly tag: string,
    readonly attrs: Record<string, string> = {},
    readonly ownText = "",
    readonly children: El[] = [],
  ) {
    for (const child of children) child.parent = this;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  get textContent(): string {
    return this.ownText;
  }

  contains(other: El): boolean {
    return other === this || this.descendants().includes(other);
  }

  descendants(): El[] {
    const out: El[] = [];
    const walk = (node: El): void => {
      for (const child of node.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  matches(selector: string): boolean {
    return selectorMatchesList(this, selector);
  }
}

/** Split on `separator` only at bracket/paren depth 0 and outside quotes. */
function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === separator && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

/** The simple selectors inside one compound: `[...]`, `:pseudo(...)` and `.class`. */
function* simpleTokens(rest: string): Generator<string> {
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "[") {
      let depth = 0;
      let j = i;
      for (; j < rest.length; j++) {
        if (rest[j] === "[") depth++;
        else if (rest[j] === "]") {
          depth--;
          if (depth === 0) break;
        }
      }
      yield rest.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ":") {
      const m = /^:([a-zA-Z-]+)\(/.exec(rest.slice(i));
      if (!m) {
        i++;
        continue;
      }
      let depth = 0;
      let j = i + m[0].length - 1;
      for (; j < rest.length; j++) {
        if (rest[j] === "(") depth++;
        else if (rest[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      yield rest.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ".") {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest.slice(i));
      if (m) {
        yield rest.slice(i, i + m[0].length);
        i += m[0].length;
      } else i++;
    } else {
      i++;
    }
  }
}

function attrMatches(node: El, body: string): boolean {
  const m = /^([\w-]+)(?:([*^$~|]?)=\s*"?([^"\]]*)"?)?$/.exec(body.trim());
  if (!m) return false;
  const [, name, op, value] = m;
  const actual = node.getAttribute(name);
  if (actual === null) return false;
  if (value === undefined) return true; // existence only
  switch (op) {
    case "*":
      return actual.includes(value);
    case "^":
      return actual.startsWith(value);
    case "$":
      return actual.endsWith(value);
    case "~":
      return actual.split(/\s+/).includes(value);
    case "|":
      return actual === value || actual.startsWith(`${value}-`);
    default:
      return actual === value;
  }
}

function compoundMatches(node: El, compound: string): boolean {
  const trimmed = compound.trim();
  if (!trimmed) return false;
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(trimmed);
  let rest = trimmed;
  if (tagMatch) {
    if (node.tag !== tagMatch[1].toLowerCase()) return false;
    rest = trimmed.slice(tagMatch[1].length);
  }
  for (const token of simpleTokens(rest)) {
    if (token.startsWith("[")) {
      if (!attrMatches(node, token.slice(1, -1))) return false;
    } else if (token.startsWith(":not(")) {
      if (selectorMatches(node, token.slice(5, -1))) return false;
    } else if (token.startsWith(":has(")) {
      const inner = token.slice(5, -1);
      if (!node.descendants().some((descendant) => selectorMatches(descendant, inner))) return false;
    } else if (token.startsWith(":")) {
      // Unsupported pseudo-class: answer "no match", never throw.
      return false;
    } else if (token.startsWith(".")) {
      if (!(node.getAttribute("class") ?? "").split(/\s+/).includes(token.slice(1))) return false;
    } else {
      return false;
    }
  }
  return true;
}

function selectorMatches(node: El, selector: string): boolean {
  const compounds = splitTopLevel(selector.trim(), " ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (compounds.length === 0) return false;
  if (!compoundMatches(node, compounds[compounds.length - 1])) return false;
  let current = node.parent;
  for (let i = compounds.length - 2; i >= 0; i--) {
    while (current && !compoundMatches(current, compounds[i])) current = current.parent;
    if (!current) return false;
    current = current.parent;
  }
  return true;
}

function selectorMatchesList(node: El, selector: string): boolean {
  return splitTopLevel(selector, ",").some((group) => selectorMatches(node, group));
}

/** Minimal Locator/Page doubles for `readLatestAssistantText`. */
class FakeLocator {
  constructor(private readonly nodes: El[]) {}
  async count(): Promise<number> {
    return this.nodes.length;
  }
  first(): FakeLocator {
    return new FakeLocator(this.nodes.slice(0, 1));
  }
  nth(index: number): FakeLocator {
    return new FakeLocator(this.nodes[index] ? [this.nodes[index]] : []);
  }
  locator(selector: string): FakeLocator {
    const found: El[] = [];
    for (const node of this.nodes) {
      for (const descendant of node.descendants()) {
        if (selectorMatchesList(descendant, selector)) found.push(descendant);
      }
    }
    return new FakeLocator(found);
  }
  async innerText(): Promise<string> {
    return this.nodes[0]?.textContent ?? "";
  }
  async evaluateAll<T>(fn: (elements: El[]) => T): Promise<T> {
    return fn(this.nodes);
  }
  async evaluate<T>(fn: (element: El) => T): Promise<T> {
    return fn(this.nodes[0]);
  }
  async getAttribute(name: string): Promise<string | null> {
    return this.nodes[0]?.getAttribute(name) ?? null;
  }
}

class FakePage {
  constructor(private readonly root: El) {}
  locator(selector: string): FakeLocator {
    return new FakeLocator(
      this.root.descendants().filter((node) => selectorMatchesList(node, selector)),
    );
  }
}

function conversationDom(): {
  root: El;
  composer: El;
  userUnit: El;
  assistantUnit: El;
  markdownBlocks: El[];
} {
  const answerBlock1 = new El("DIV", { class: "markdown-block" }, "Worked for 9m 26s\n\nHere is the recommendation.");
  const answerBlock2 = new El("DIV", { class: "markdown-copy" }, "Second block of the answer.");
  const userBubble = new El("DIV", { "data-user-message-bubble": "" }, "What should we do?");
  const userUnit = new El("DIV", { "data-content-search-unit-key": "unit-1", "data-conversation-role": "user" }, "", [userBubble]);
  const assistantUnit = new El(
    "DIV",
    { "data-content-search-unit-key": "unit-2", "data-conversation-role": "assistant" },
    "",
    [answerBlock1, answerBlock2],
  );
  const main = new El("MAIN", {}, "", [userUnit, assistantUnit]);
  const composer = new El("DIV", { contenteditable: "true", "data-composer-markdown": "" });
  const form = new El("FORM", {}, "", [composer]);
  const root = new El("BODY", {}, "", [main, form]);
  return { root, composer, userUnit, assistantUnit, markdownBlocks: [answerBlock1, answerBlock2] };
}

describe("2026-09 message selectors on a fake conversation DOM", () => {
  const { root, composer, userUnit, assistantUnit, markdownBlocks } = conversationDom();

  it("leads every message key with the new unit selectors, keeping the old fallbacks", () => {
    expect(SELECTORS.anyMessages[0]).toBe("[data-content-search-unit-key]");
    expect(SELECTORS.anyMessages[1]).toBe("[data-chatgpt-search-unit-key]");
    expect(SELECTORS.assistantMessages[0]).toBe(
      "[data-content-search-unit-key]:not(:has([data-user-message-bubble]))",
    );
    expect(SELECTORS.assistantMessages[1]).toBe(
      "[data-chatgpt-search-unit-key]:not(:has([data-user-message-bubble]))",
    );
    expect(SELECTORS.assistantMarkdown[0]).toBe(
      '[data-content-search-unit-key]:not(:has([data-user-message-bubble])) [class*="markdown"]',
    );
    // The old candidates survive, in order, as tail fallbacks.
    expect(SELECTORS.anyMessages).toContain("main article");
    expect(SELECTORS.assistantMessages).toContain('div[data-message-author-role="assistant"]');
    expect(SELECTORS.assistantMarkdown).toContain("div.markdown");
  });

  it("anyMessages matches exactly the two message units", () => {
    const matched = root.descendants().filter((node) => node.matches(joinSelectors(SELECTORS.anyMessages)));
    expect(matched).toHaveLength(2);
    expect(matched).toEqual([userUnit, assistantUnit]);
  });

  it("assistantMessages matches exactly the assistant unit, never the user unit", () => {
    const matched = root
      .descendants()
      .filter((node) => node.matches(joinSelectors(SELECTORS.assistantMessages)));
    expect(matched).toHaveLength(1);
    expect(matched[0]).toBe(assistantUnit);
    expect(matched).not.toContain(userUnit);
  });

  it("assistantMarkdown matches only inside the assistant unit", () => {
    const matched = root
      .descendants()
      .filter((node) => node.matches(joinSelectors(SELECTORS.assistantMarkdown)));
    expect(matched).toHaveLength(2);
    expect(matched).toEqual(markdownBlocks);
    expect(matched.every((node) => assistantUnit.contains(node))).toBe(true);
    expect(matched.some((node) => userUnit.contains(node))).toBe(false);
  });

  it("never lets a new unit selector match the composer", () => {
    const newSelectors = [
      "[data-content-search-unit-key]",
      "[data-chatgpt-search-unit-key]",
      "[data-content-search-unit-key]:not(:has([data-user-message-bubble]))",
      "[data-chatgpt-search-unit-key]:not(:has([data-user-message-bubble]))",
      '[data-content-search-unit-key]:not(:has([data-user-message-bubble])) [class*="markdown"]',
    ];
    for (const selector of newSelectors) {
      expect(composer.matches(selector), `composer matched ${selector}`).toBe(false);
    }
    // The composer is still what the composer selectors are for.
    expect(composer.matches(joinSelectors(SELECTORS.composer))).toBe(true);
  });
});

describe("readLatestAssistantText on the 2026-09 markup", () => {
  it('strips a leading "Worked for 9m 26s" and joins the markdown blocks in order', async () => {
    const { root } = conversationDom();
    const page = new FakePage(root) as unknown as Page;
    const text = await readLatestAssistantText(page);
    expect(text).toBe("Here is the recommendation.\n\nSecond block of the answer.");
  });

  it('strips a bare-seconds "Worked for 45s" header too', async () => {
    const block = new El("DIV", { class: "markdown-body" }, "Worked for 45s\nFinal answer.");
    const unit = new El("DIV", { "data-content-search-unit-key": "unit-1" }, "", [block]);
    const root = new El("BODY", {}, "", [new El("MAIN", {}, "", [unit])]);
    const page = new FakePage(root) as unknown as Page;
    expect(await readLatestAssistantText(page)).toBe("Final answer.");
  });
});
