/**
 * Content-free DOM shape probe (P-035 2026-09-28, vendor r39).
 *
 * On 2026-09-28 a planning turn was answered by ChatGPT ("Worked for 9m 26s"
 * and a full recommendation below the user turn) while the r38 heartbeat read
 * `msgs=0/0`: none of `SELECTORS.anyMessages` / `SELECTORS.assistantMessages`
 * matched the current chatgpt.com conversation markup, so the answer was lost
 * before it could be read. Before any selector is rewritten the planner needs
 * the new markup's SHAPE, and nothing else: text is what must never leave the
 * page.
 *
 * So this module returns names, counts, lengths and a whitelist of small
 * enumerated attribute VALUES (`data-testid`, `role`,
 * `data-message-author-role`, `data-conversation-role`, all sanitised). It
 * deliberately does NOT read attribute values for any other attribute, and
 * never reads a text node's content -- only its length.
 *
 * `summariseDomShape` is written to run inside `page.evaluate`, so it may not
 * close over anything in module scope: patchright serialises the function with
 * `Function.prototype.toString()`, and a reference to a module-level constant
 * would be `undefined` on the far side. Everything it needs travels in
 * `input`, and everything it declares lives in its own body. That constraint is
 * also what makes it directly unit-testable: it takes the DOM root as its
 * optional second argument, so a fake DOM can be handed to it under Node.
 */

/** The subset of `Element` / `Document` the summariser touches. */
export interface DomShapeNode {
  tagName: string;
  textContent: string | null;
  attributes: ArrayLike<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<DomShapeNode>;
}

/** The subset of `Document` the summariser touches. */
export interface DomShapeRoot {
  body: DomShapeNode | null;
  querySelector(selector: string): DomShapeNode | null;
  querySelectorAll(selector: string): ArrayLike<DomShapeNode>;
}

/** Everything the in-page summariser is told; must be JSON-serialisable. */
export interface DomShapeInput {
  /** True when the page URL path contains `/c/` (computed on the Node side). */
  conversationPath: boolean;
  /** One entry per SELECTORS key worth probing, with its ordered candidates. */
  candidates: Array<{ key: string; selectors: string[] }>;
  /** Fixed tag/count probes, all resolved inside `<main>` (or `document.body`). */
  tagProbes: string[];
}

export interface DomShapeSummary {
  url_path_kind: "conversation" | "other";
  data_attr_names: Array<{ name: string; count: number }>;
  testids: Array<{ value: string; count: number }>;
  roles: Array<{ value: string; count: number }>;
  author_roles: Array<{ value: string; count: number }>;
  /** Whitelisted `data-conversation-role` values, sanitised, with counts. */
  conversation_roles: Array<{ value: string; count: number }>;
  tags: Array<{ match: string; count: number }>;
  candidates: Array<{ key: string; matches: Array<{ selector: string; count: number }> }>;
  turn_containers: Array<{
    tag: string;
    testid: string;
    dataAttrs: string[];
    classCount: number;
    textLength: number;
  }>;
  /**
   * One entry per `[data-content-search-unit-key]` element (the 2026-09 message
   * unit), in document order. Shape only: no text, and the only attribute value
   * carried is the sanitised `data-conversation-role`.
   */
  units: Array<{
    index: number;
    hasUserBubble: boolean;
    markdownCount: number;
    markdownCopyCount: number;
    textLength: number;
    conversationRole: string;
  }>;
}

/**
 * Summarise the shape of one conversation page, content-free.
 *
 * Called as `page.evaluate(summariseDomShape, input)` in the daemon (so `root`
 * is left undefined and the real `document` is used), and as
 * `summariseDomShape(input, fakeRoot)` in unit tests. Never returns text.
 */
export function summariseDomShape(input: DomShapeInput, root?: DomShapeRoot): DomShapeSummary {
  const sanitise = (value: string | null | undefined): string =>
    String(value ?? "").replace(/[^A-Za-z0-9 _.:/-]/g, "").slice(0, 60);

  const doc: DomShapeRoot | null =
    root ?? ((globalThis as unknown as { document?: DomShapeRoot }).document ?? null);
  if (!doc) throw new Error("dom-shape: no document to summarise");

  const readAttr = (el: DomShapeNode, name: string): string | null => {
    try {
      return el.getAttribute ? el.getAttribute(name) : null;
    } catch {
      return null;
    }
  };
  const attrsOf = (el: DomShapeNode): Array<{ name: string; value: string }> => {
    try {
      return el.attributes ? Array.from(el.attributes) : [];
    } catch {
      return [];
    }
  };
  const dataAttrNamesOf = (el: DomShapeNode): string[] =>
    attrsOf(el)
      .map((attr) => String(attr?.name ?? ""))
      .filter((name) => name.startsWith("data-"))
      .sort();
  const classCountOf = (el: DomShapeNode): number => {
    const raw = readAttr(el, "class") ?? "";
    return raw.split(/\s+/).filter((token) => token.length > 0).length;
  };
  const tagOf = (el: DomShapeNode): string => String(el.tagName ?? "").toLowerCase();

  const mainElement = (() => {
    try {
      return doc.querySelector("main");
    } catch {
      return null;
    }
  })();
  const scope: DomShapeNode | DomShapeRoot = mainElement ?? doc.body ?? doc;

  const countIn = (selector: string): number => {
    try {
      return scope.querySelectorAll(selector).length;
    } catch {
      // A candidate that is not valid CSS in-page (`:has-text(...)`, a
      // Playwright-only pseudo-class) is reported as -1 so an unanswerable
      // question is never mistaken for "no match".
      return -1;
    }
  };
  const countAll = (selector: string): number => {
    try {
      return doc.querySelectorAll(selector).length;
    } catch {
      return -1;
    }
  };

  let elements: DomShapeNode[] = [];
  try {
    elements = Array.from(scope.querySelectorAll("*"));
  } catch {
    elements = [];
  }

  const attrCounts = new Map<string, number>();
  const testidCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();
  for (const el of elements) {
    for (const attr of attrsOf(el)) {
      const name = String(attr?.name ?? "");
      if (name.startsWith("data-")) attrCounts.set(name, (attrCounts.get(name) ?? 0) + 1);
      if (name === "data-testid") {
        const value = sanitise(attr.value);
        testidCounts.set(value, (testidCounts.get(value) ?? 0) + 1);
      }
    }
    const role = readAttr(el, "role");
    if (role) {
      const value = sanitise(role);
      roleCounts.set(value, (roleCounts.get(value) ?? 0) + 1);
    }
  }

  const authorRoleCounts = new Map<string, number>();
  try {
    for (const el of Array.from(doc.querySelectorAll("[data-message-author-role]"))) {
      const value = sanitise(readAttr(el, "data-message-author-role"));
      if (value) authorRoleCounts.set(value, (authorRoleCounts.get(value) ?? 0) + 1);
    }
  } catch {
    /* an unreadable author-role list is an empty one, never a thrown probe */
  }

  // P-035 2026-09-28 (vendor r40). The 2026-09 message unit carries
  // `data-conversation-role`; its sanitised values are enumerated here, exactly
  // like `data-message-author-role` above.
  const conversationRoleCounts = new Map<string, number>();
  try {
    for (const el of Array.from(doc.querySelectorAll("[data-conversation-role]"))) {
      const value = sanitise(readAttr(el, "data-conversation-role"));
      if (value) conversationRoleCounts.set(value, (conversationRoleCounts.get(value) ?? 0) + 1);
    }
  } catch {
    /* an unreadable role list is an empty one, never a thrown probe */
  }

  // One entry per message unit, shape only: counts, lengths and the single
  // sanitised `data-conversation-role` value, never text. `markdownCopyCount`
  // and `markdownCount` are descendant counts; `conversationRole` prefers the
  // unit's own attribute and falls back to its nearest descendant carrying it.
  const units: Array<{
    index: number;
    hasUserBubble: boolean;
    markdownCount: number;
    markdownCopyCount: number;
    textLength: number;
    conversationRole: string;
  }> = [];
  try {
    const unitElements = Array.from(doc.querySelectorAll("[data-content-search-unit-key]"));
    unitElements.forEach((unit, index) => {
      const countDescendants = (selector: string): number => {
        try {
          return unit.querySelectorAll(selector).length;
        } catch {
          return -1;
        }
      };
      let role: string | null = readAttr(unit, "data-conversation-role");
      if (!role) {
        try {
          for (const descendant of Array.from(unit.querySelectorAll("[data-conversation-role]"))) {
            const value = readAttr(descendant, "data-conversation-role");
            if (value) {
              role = value;
              break;
            }
          }
        } catch {
          /* an unreadable descendant list falls through to "-" */
        }
      }
      const cleanRole = role ? sanitise(role) : "";
      units.push({
        index,
        hasUserBubble: countDescendants("[data-user-message-bubble]") > 0,
        markdownCount: countDescendants('[class*="markdown"]'),
        markdownCopyCount: countDescendants("[data-markdown-copy]"),
        textLength: (unit.textContent ?? "").length,
        conversationRole: cleanRole.length > 0 ? cleanRole : "-",
      });
    });
  } catch {
    /* an unreadable unit list is an empty one, never a thrown probe */
  }

  const byName = (map: Map<string, number>): Array<{ name: string; count: number }> =>
    Array.from(map.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, count]) => ({ name, count }));
  const byCount = (map: Map<string, number>, limit = Number.POSITIVE_INFINITY): Array<{ value: string; count: number }> =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, limit)
      .map(([value, count]) => ({ value, count }));

  const turnContainers = elements
    .map((el, index) => ({ el, index, textLength: (el.textContent ?? "").length }))
    .sort((a, b) => b.textLength - a.textLength || a.index - b.index)
    .slice(0, 10)
    .map(({ el, textLength }) => ({
      tag: tagOf(el),
      testid: sanitise(readAttr(el, "data-testid")),
      dataAttrs: dataAttrNamesOf(el),
      classCount: classCountOf(el),
      textLength,
    }));

  return {
    url_path_kind: input.conversationPath ? "conversation" : "other",
    data_attr_names: byName(attrCounts),
    testids: byCount(testidCounts, 40),
    roles: byCount(roleCounts),
    author_roles: byCount(authorRoleCounts),
    conversation_roles: byCount(conversationRoleCounts),
    tags: input.tagProbes.map((match) => ({ match, count: countIn(match) })),
    candidates: input.candidates.map((entry) => ({
      key: entry.key,
      matches: entry.selectors.map((selector) => ({ selector, count: countAll(selector) })),
    })),
    turn_containers: turnContainers,
    units,
  };
}
