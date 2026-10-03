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
 * Record one read of the Deep research row's text and log its shape. The row
 * may also carry the light-version notice; then the quota is recorded as
 * exhausted too. Otherwise the exhausted fields are left as they were: a count
 * alone does not say when the full quota comes back.
 */
export function recordDeepResearchRow(rowText: string, now: Date = new Date()): DeepResearchQuota {
  const text = collapse(String(rowText ?? ""));
  const label = text.slice(0, LABEL_MAX);
  const remaining = parseDeepResearchRemaining(text);
  reading = { ...reading, remaining, label, observedAt: now.toISOString() };
  console.error(
    `[cgpro:deep-research] tools row: remaining=${remaining === null ? "none" : remaining} label="${label}"`,
  );
  const exhausted = parseDeepResearchExhausted(text, now);
  if (exhausted) recordDeepResearchExhausted(exhausted.resetsAt, now);
  return deepResearchQuota();
}

/**
 * P-035 2026-10-03 G4-C. Record one read of the Deep research row's hover
 * tooltip; null means no tooltip appeared. A count in the tooltip becomes the
 * reading, with the tooltip text as its label; without one the row's reading
 * stands. The tooltip may also carry the light-version notice.
 */
export function recordDeepResearchTooltip(tooltipText: string | null, now: Date = new Date()): DeepResearchQuota {
  if (typeof tooltipText !== "string") {
    console.error("[cgpro:deep-research] tooltip: none");
    return deepResearchQuota();
  }
  const text = collapse(tooltipText);
  const label = text.slice(0, LABEL_MAX);
  const remaining = parseDeepResearchRemaining(text);
  if (remaining !== null) reading = { ...reading, remaining, label, observedAt: now.toISOString() };
  console.error(
    `[cgpro:deep-research] tooltip: remaining=${remaining === null ? "none" : remaining} label="${label}"`,
  );
  const exhausted = parseDeepResearchExhausted(text, now);
  if (exhausted) recordDeepResearchExhausted(exhausted.resetsAt, now);
  return deepResearchQuota();
}

/**
 * P-035 2026-10-03 G4-A. When the full quota is spent ChatGPT says "Your
 * remaining queries are powered by a lighter version of deep research. Your
 * full access resets on April 17." and still runs the turn, on the lighter
 * model. That is a quota fact, never a failed turn.
 */
const LIGHT_NOTICE_RE = /lighter version of deep research/i;
const LIGHT_RESET_RE = /full access resets on ([A-Z][a-z]+ \d{1,2})/;
/** No named reset: hold the account back for 6 h, the facade's `pro-limits` default. */
const EXHAUSTED_FALLBACK_MS = 6 * 60 * 60 * 1_000;

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** ISO 8601 for a local instant with its UTC offset, as `parseProAvailableAfter` spells it. */
function formatLocalIso(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:00` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/**
 * `Month D` -> the start of that local day at its next occurrence on or after
 * `now`'s local day, or null when it names no real date.
 */
function nextLocalDay(monthDay: string, now: Date): string | null {
  const [name, dayText] = monthDay.split(" ");
  const month = MONTHS[name.toLowerCase()];
  const day = Number(dayText);
  if (month === undefined || !Number.isInteger(day)) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Feb 29 can be up to eight years away; any other real date is within one.
  for (let year = now.getFullYear(); year <= now.getFullYear() + 8; year += 1) {
    const date = new Date(year, month, day);
    if (date.getMonth() !== month || date.getDate() !== day) continue;
    if (date.getTime() >= today) return formatLocalIso(date);
  }
  return null;
}

/**
 * The light-version notice -> `{exhausted, resetsAt}`, or null when the text
 * carries no such notice. `resetsAt` is null when the reset date does not
 * parse. Never throws.
 */
export function parseDeepResearchExhausted(
  text: string,
  now: Date,
): { exhausted: true; resetsAt: string | null } | null {
  try {
    if (typeof text !== "string" || !LIGHT_NOTICE_RE.test(text)) return null;
    const match = LIGHT_RESET_RE.exec(collapse(text));
    return { exhausted: true, resetsAt: match ? nextLocalDay(match[1], now) : null };
  } catch {
    return null;
  }
}

/** Record the quota as exhausted until `resetsAt` (or now + 6 h) and log it. */
export function recordDeepResearchExhausted(resetsAt: string | null, now: Date = new Date()): DeepResearchQuota {
  reading = {
    ...reading,
    exhaustedUntil: resetsAt ?? new Date(now.getTime() + EXHAUSTED_FALLBACK_MS).toISOString(),
    exhaustedObservedAt: now.toISOString(),
  };
  console.error(`[cgpro:deep-research] light-version notice: resets_at=${resetsAt ?? "none"}`);
  return deepResearchQuota();
}
