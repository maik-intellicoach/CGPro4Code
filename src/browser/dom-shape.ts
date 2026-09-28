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
  /**
   * P-035 2026-09-28 (vendor r42). The account usage panel -- "6% usage
   * remaining · Resets every week · Next reset is on Oct 4 at 12:58 AM" --
   * read content-free: the percent, the period word and the sanitised text that
   * follows "Next reset is on". Nothing else from the element travels, so a
   * sentinel sitting beside the numbers never leaves the page.
   */
  usage_panel: {
    found: boolean;
    percent: number;
    resets: string;
    period: string;
  };
  /**
   * P-035 2026-09-28 (vendor r42). The LAST assistant message unit's own chrome:
   * the sanitised `aria-label` of every button inside it, a content-free shape
   * (length + fixed-vocabulary tokens) per alert/status/error-ish notice, and
   * whether the unit leads with a "Worked for"/"Thought for" line. Buttons are
   * labels only, notices are lengths and fixed words only, header is a boolean
   * and a duration -- no notice text, no answer text.
   */
  reply_chrome: {
    buttons: string[];
    notices: Array<{ len: number; tokens: string[] }>;
    header: { exists: boolean; duration: string };
  };
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
  let unitElements: DomShapeNode[] = [];
  try {
    unitElements = Array.from(doc.querySelectorAll("[data-content-search-unit-key]"));
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

  // P-035 2026-09-28 (vendor r42). Two new content-free reads. The probe itself
  // is unchanged: still one `page.evaluate`, still no text. `isVisible` is
  // element-local and answers `true` whenever the page cannot answer (a fake DOM
  // has no `style`/`checkVisibility`), so it can only ever narrow a set that the
  // page itself says is hidden.
  const isVisible = (el: DomShapeNode): boolean => {
    try {
      const node = el as unknown as {
        hidden?: boolean;
        style?: { display?: string; visibility?: string };
        checkVisibility?: () => boolean;
      };
      if (node.hidden === true) return false;
      if (readAttr(el, "hidden") !== null) return false;
      if (readAttr(el, "aria-hidden") === "true") return false;
      const style = node.style;
      if (style && (style.display === "none" || style.visibility === "hidden")) return false;
      if (typeof node.checkVisibility === "function") return node.checkVisibility() === true;
      return true;
    } catch {
      return true;
    }
  };

  // (1) The usage panel, anywhere in the document: the panel is a popover, so it
  // may live outside `<main>`. P-035 G3 r45 (2026-09-28): the reset sentence is a
  // SIBLING of the percent line, so the SMALLEST visible element holding BOTH
  // "NN% usage remaining" and "Next reset is on" is the panel itself -- for two
  // sibling lines that is their lowest common ancestor, the panel container --
  // and every larger match is one of its ancestors. A panel that carries the
  // percent and no reset line keeps its r42 reading (found, resets "-"), so the
  // probe never regresses. Only percent, the period word and the reset line are
  // read out.
  const USAGE_RE = /(\d{1,3})%\s*usage remaining/i;
  const USAGE_RESET_RE = /next reset is on/i;
  const usage_panel: { found: boolean; percent: number; resets: string; period: string } = {
    found: false,
    percent: 0,
    resets: "-",
    period: "-",
  };
  try {
    let smallest: { text: string } | null = null;
    let percentOnly: { text: string } | null = null;
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      const text = el.textContent ?? "";
      if (!USAGE_RE.test(text)) continue;
      if (!isVisible(el)) continue;
      if (USAGE_RESET_RE.test(text)) {
        if (smallest === null || text.length < smallest.text.length) smallest = { text };
      } else if (percentOnly === null || text.length < percentOnly.text.length) {
        percentOnly = { text };
      }
    }
    const panel = smallest ?? percentOnly;
    if (panel !== null) {
      const text = panel.text;
      const percentMatch = USAGE_RE.exec(text);
      const periodMatch = /resets every\s+(week|day|month)/i.exec(text);
      const resetMatch = /next reset is on\s*([\s\S]*)$/i.exec(text);
      let resets = "-";
      if (resetMatch && resetMatch[1]) {
        const clean = sanitise(resetMatch[1]).trim();
        if (clean.length > 0) resets = clean.slice(0, 40);
      }
      usage_panel.found = true;
      usage_panel.percent = percentMatch ? Number(percentMatch[1]) : 0;
      usage_panel.period = periodMatch ? periodMatch[1].toLowerCase() : "-";
      usage_panel.resets = resets;
    }
  } catch {
    /* an unreadable document is an unfound panel, never a thrown probe */
  }

  // (2) The last ASSISTANT unit's chrome. The unit is `data-content-search-unit-key`
  // without a user bubble inside it; `:has()` may be unanswerable in an old
  // engine, so the same filter is recomputed from the unit list as a fallback.
  const REPLY_NOTICE_RE = /something went wrong|error|try again|retry|limit|usage|network|stopped|interrupted/i;
  const NOTICE_TOKENS: ReadonlyArray<readonly [token: string, pattern: RegExp]> = [
    ["limit", /limit/i],
    ["usage", /usage/i],
    ["reached", /reached/i],
    ["upgrade", /upgrade/i],
    ["try-again", /try again/i],
    ["error", /error/i],
    ["network", /network/i],
    ["remaining", /remaining/i],
    ["reset", /reset/i],
    ["plan", /plan/i],
    ["pro", /pro/i],
    ["unable", /unable/i],
    ["rate", /rate/i],
    ["went-wrong", /went wrong/i],
    ["retry", /retry/i],
    ["stopped", /stopped/i],
    ["interrupted", /interrupted/i],
  ];
  const reply_chrome: {
    buttons: string[];
    notices: Array<{ len: number; tokens: string[] }>;
    header: { exists: boolean; duration: string };
  } = {
    buttons: [],
    notices: [],
    header: { exists: false, duration: "-" },
  };
  try {
    let replyUnit: DomShapeNode | null = null;
    try {
      const matches = Array.from(
        doc.querySelectorAll("[data-content-search-unit-key]:not(:has([data-user-message-bubble]))"),
      );
      if (matches.length > 0) replyUnit = matches[matches.length - 1] ?? null;
    } catch {
      replyUnit = null;
    }
    if (!replyUnit) {
      for (const unit of unitElements) {
        let hasBubble = false;
        try {
          hasBubble = unit.querySelectorAll("[data-user-message-bubble]").length > 0;
        } catch {
          hasBubble = false;
        }
        if (!hasBubble) replyUnit = unit;
      }
    }
    if (replyUnit) {
      const unit: DomShapeNode = replyUnit;
      // (a) Button labels, sanitised, 40 chars each, at most 20 of them.
      try {
        const labels: string[] = [];
        for (const button of Array.from(unit.querySelectorAll("button"))) {
          if (!isVisible(button)) continue;
          const label = sanitise(readAttr(button, "aria-label")).slice(0, 40);
          if (label.length > 0) labels.push(label);
          if (labels.length >= 20) break;
        }
        reply_chrome.buttons = labels;
      } catch {
        /* an unreadable button list is an empty one */
      }
      // (b) Notices: role alert/status or an error-ish text, innermost only. The
      // shape is the trimmed length plus the fixed-vocabulary tokens, never text.
      try {
        const matchesNotice = (el: DomShapeNode): boolean => {
          const role = (readAttr(el, "role") ?? "").toLowerCase();
          if (role === "alert" || role === "status") return true;
          return REPLY_NOTICE_RE.test(el.textContent ?? "");
        };
        for (const el of Array.from(unit.querySelectorAll("*"))) {
          if (!matchesNotice(el)) continue;
          if (!isVisible(el)) continue;
          let hasMatchingChild = false;
          try {
            hasMatchingChild = Array.from(el.querySelectorAll("*")).some((child) => matchesNotice(child));
          } catch {
            hasMatchingChild = false;
          }
          if (hasMatchingChild) continue;
          const trimmed = (el.textContent ?? "").trim();
          reply_chrome.notices.push({
            len: trimmed.length,
            tokens: NOTICE_TOKENS.filter(([, pattern]) => pattern.test(trimmed)).map(([token]) => token),
          });
        }
      } catch {
        /* an unreadable notice list is an empty one */
      }
      // (c) The leading "Worked for"/"Thought for" line, if the unit opens with one.
      try {
        const leading = (unit.textContent ?? "").replace(/^\s+/, "");
        const headerMatch = /^(worked|thought) for\s+((?:\d+\s*[hms]\s*){1,3})/i.exec(leading);
        if (headerMatch) {
          const duration = sanitise(headerMatch[2]).trim().slice(0, 20);
          reply_chrome.header = { exists: true, duration: duration.length > 0 ? duration : "-" };
        }
      } catch {
        /* a unit whose text cannot be read has no header */
      }
    }
  } catch {
    /* an unreadable document leaves the reply chrome empty, never a thrown probe */
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
    usage_panel,
    reply_chrome,
  };
}
