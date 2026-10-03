/**
 * P-035 2026-10-03 G4-A. ChatGPT's own per-account Deep Research counter.
 *
 * OpenAI publishes no per-tier Deep Research numbers, so the router spreads
 * Deep Research over the open accounts by what each account's own composer
 * says. The "+" tools popover shows a remaining count beside the Deep research
 * row (a 2026 guide shows `5 left`); the exact live wording is not captured
 * yet, so the parser is tolerant and every reading logs the row's label, which
 * is UI chrome and never user content, so the pattern can be tightened from
 * the first live read.
 *
 * The reading is kept per daemon process, in this module, and served on
 * `/status`. Nothing here touches a page.
 */

/** The last Deep Research quota reading of this process; every field null when unknown. */
export interface DeepResearchQuota {
  remaining: number | null;
  label: string | null;
  observedAt: string | null;
  exhaustedUntil: string | null;
  exhaustedObservedAt: string | null;
}

/** The row label is chrome; capped so a re-rendered popover cannot flood the log. */
const LABEL_MAX = 80;

const OF_FORM_RE = /(?<!\d)(\d{1,4})\s*of\s*\d{1,4}\s*(?:left|remaining|restant(?:e|s)?s?)\b/i;
const SLASH_FORM_RE = /(?<!\d)(\d{1,4})\s*\/\s*\d{1,4}(?!\d)/;
const KEYWORD_FORM_RE = /(?<!\d)(\d{1,4})\s*(?:left|remaining|restant(?:e|s)?s?)\b/i;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The remaining count a Deep research row names, or null when it names none.
 * `N left` / `N remaining` / `N restantes`, `N of M left` and `N/M` all give N;
 * a bare number with none of those forms gives null. Never throws.
 */
export function parseDeepResearchRemaining(rowText: string): number | null {
  try {
    if (typeof rowText !== "string") return null;
    const text = collapse(rowText);
    const match = OF_FORM_RE.exec(text) ?? SLASH_FORM_RE.exec(text) ?? KEYWORD_FORM_RE.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

const EMPTY: DeepResearchQuota = {
  remaining: null,
  label: null,
  observedAt: null,
  exhaustedUntil: null,
  exhaustedObservedAt: null,
};

let reading: DeepResearchQuota = { ...EMPTY };

/** A copy of this process's last reading, for `/status`. */
export function deepResearchQuota(): DeepResearchQuota {
  return { ...reading };
}

/** Test seam: forget every reading. */
export function resetDeepResearchQuota(): void {
  reading = { ...EMPTY };
}

/**
 * Record one read of the Deep research row's text and log its shape. The
 * exhausted fields are left as they were: the row's own count does not say
 * when the full quota comes back.
 */
export function recordDeepResearchRow(rowText: string, now: Date = new Date()): DeepResearchQuota {
  const text = collapse(String(rowText ?? ""));
  const label = text.slice(0, LABEL_MAX);
  const remaining = parseDeepResearchRemaining(text);
  reading = { ...reading, remaining, label, observedAt: now.toISOString() };
  console.error(
    `[cgpro:deep-research] tools row: remaining=${remaining === null ? "none" : remaining} label="${label}"`,
  );
  return deepResearchQuota();
}
