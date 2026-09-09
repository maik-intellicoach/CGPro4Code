/**
 * Pull the user's chatgpt.com conversation history.
 *
 * Two paths, tried in order. Both run inside the page so the React
 * app's Authorization Bearer is attached:
 *
 *   1. /backend-api/conversations — the canonical paginated endpoint.
 *      Schema can drift; we accept several URL variants and a few
 *      response shapes.
 *   2. DOM sidebar scrape — last-resort fallback that reads `<a href="/c/...">`
 *      links out of the conversation history nav. Works even when the
 *      API endpoint changes name, but only returns what's currently
 *      mounted in the DOM (typically the most recent ~50).
 */

import type { Page } from "patchright";
import { SELECTORS } from "../browser/selectors.js";
import { backendApiFetch } from "../browser/chatgpt.js";

export interface RemoteConversation {
  id: string;
  title: string;
  /** ISO timestamp if the API gave us one. */
  updatedAt?: string;
  isArchived?: boolean;
  /** Tells the caller which path produced this row (for debugging). */
  source: "api" | "dom";
}

export interface FetchOptions {
  /** Cap the number of rows returned. Default 100. */
  limit?: number;
  /** Verbose logging to stderr. */
  debug?: boolean;
}

export interface ConnectorToolCall {
  id: string;
  name: string;
}

export interface LatestTurnConnectorState {
  calls: ConnectorToolCall[];
  currentRole: string | null;
  currentStatus: string | null;
  currentEndTurn: boolean | null;
  currentContentType: string | null;
  currentIsThinkingPreamble: boolean;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function invokedResourceToolName(message: JsonObject, expectedAppName?: string): string | null {
  const metadata = asObject(message.metadata);
  const invokedResource = asObject(metadata?.invoked_resource);
  if (expectedAppName !== undefined && invokedResource?.app_name !== expectedAppName) return null;
  const resourceUri = invokedResource?.resource_uri;
  if (typeof resourceUri !== "string") return null;
  return resourceUri.split("/").filter(Boolean).at(-1) ?? null;
}

/**
 * Extract connector tools from only the latest user turn on the current
 * conversation branch. Older turns and abandoned branches are excluded.
 */
export function extractLatestTurnToolCalls(body: unknown, expectedAppName?: string): ConnectorToolCall[] {
  const root = asObject(body);
  const mapping = asObject(root?.mapping);
  let nodeId = typeof root?.current_node === "string" ? root.current_node : null;
  if (!mapping || !nodeId) return [];

  const reverseChronological: ConnectorToolCall[] = [];
  const seenNodes = new Set<string>();
  while (nodeId && !seenNodes.has(nodeId)) {
    seenNodes.add(nodeId);
    const node = asObject(mapping[nodeId]);
    if (!node) break;
    const message = asObject(node.message);
    const author = asObject(message?.author);
    if (author?.role === "user") break;
    if (message && author?.role === "tool") {
      const name = invokedResourceToolName(message, expectedAppName);
      if (name) {
        const messageId = typeof message.id === "string" ? message.id : nodeId;
        reverseChronological.push({ id: messageId, name });
      }
    }
    nodeId = typeof node.parent === "string" ? node.parent : null;
  }
  return reverseChronological.reverse();
}

export function extractLatestTurnConnectorState(
  body: unknown,
  expectedAppName?: string,
): LatestTurnConnectorState {
  const root = asObject(body);
  const mapping = asObject(root?.mapping);
  const currentNodeId = typeof root?.current_node === "string" ? root.current_node : null;
  const currentNode = currentNodeId && mapping ? asObject(mapping[currentNodeId]) : null;
  const currentMessage = asObject(currentNode?.message);
  const currentAuthor = asObject(currentMessage?.author);
  const currentContent = asObject(currentMessage?.content);
  const currentMetadata = asObject(currentMessage?.metadata);
  return {
    calls: extractLatestTurnToolCalls(body, expectedAppName),
    currentRole: typeof currentAuthor?.role === "string" ? currentAuthor.role : null,
    currentStatus: typeof currentMessage?.status === "string" ? currentMessage.status : null,
    currentEndTurn: typeof currentMessage?.end_turn === "boolean" ? currentMessage.end_turn : null,
    currentContentType: typeof currentContent?.content_type === "string" ? currentContent.content_type : null,
    currentIsThinkingPreamble: currentMetadata?.is_thinking_preamble_message === true,
  };
}

export function extractLatestTurnToolNames(body: unknown, expectedAppName?: string): string[] {
  return extractLatestTurnToolCalls(body, expectedAppName).map((call) => call.name);
}

export interface NativeResearchReport {
  text: string;
  model: string | null;
  userNodeId: string;
}

/** Native research reports live in the app widget, not an assistant bubble. */
export function extractLatestNativeResearchReport(body: unknown): NativeResearchReport | null {
  const root = asObject(body);
  const mapping = asObject(root?.mapping);
  let nodeId = typeof root?.current_node === "string" ? root.current_node : null;
  const seen = new Set<string>();
  let recovered: Omit<NativeResearchReport, "userNodeId"> | null = null;
  while (mapping && nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = asObject(mapping[nodeId]);
    if (!node) break;
    const message = asObject(node.message);
    const role = asObject(message?.author)?.role;
    if (role === "user") return recovered ? { ...recovered, userNodeId: nodeId } : null;
    const metadata = asObject(message?.metadata);
    const resource = asObject(metadata?.invoked_resource);
    if (!recovered && role === "tool" && resource?.resource_uri === "/connector_openai_deep_research/start") {
      const raw = asObject(metadata?.chatgpt_sdk)?.widget_state;
      let state: JsonObject | null;
      try { state = asObject(typeof raw === "string" ? JSON.parse(raw) : raw); }
      catch { return null; }
      const report = asObject(state?.report_message);
      const content = asObject(report?.content);
      // An earlier report must not satisfy a newer/incomplete app invocation.
      if (state?.status !== "completed" || asObject(report?.author)?.role !== "assistant" ||
          report?.status !== "finished_successfully" || report?.end_turn !== true ||
          content?.content_type !== "text" || !Array.isArray(content.parts)) return null;
      let text = content.parts.filter((part): part is string => typeof part === "string").join("\n").trim();
      if (!text) return null;
      const reportMetadata = asObject(report.metadata);
      const references = reportMetadata?.content_references;
      if (Array.isArray(references)) {
        for (const value of references) {
          const ref = asObject(value);
          // sources_footnote can use a single space as its placeholder.
          // Replacing that globally would concatenate every word in a report.
          if (typeof ref?.matched_text === "string" && ref.matched_text.startsWith("\uE200") && typeof ref.alt === "string") {
            text = text.split(ref.matched_text).join(ref.alt);
          }
        }
      }
      recovered = { text, model: typeof reportMetadata?.resolved_model_slug === "string" ? reportMetadata.resolved_model_slug : null };
    }
    nodeId = typeof node.parent === "string" ? node.parent : null;
  }
  return null;
}

/** Snapshot all existing turns before Send, including abandoned branches. */
export async function fetchNativeResearchUserNodes(page: Page, conversationId: string): Promise<Set<string>> {
  const result = await fetchConversationForCorroboration(page, conversationId, 12_000, true);
  const mapping = asObject(asObject(result.body)?.mapping);
  if (!result.ok || !mapping || Object.keys(mapping).length === 0) {
    throw new Error(`Cannot establish native research turn boundary (HTTP ${result.status})`);
  }
  return new Set(Object.entries(mapping)
    .filter(([, node]) => asObject(asObject(asObject(node)?.message)?.author)?.role === "user")
    .map(([id]) => id));
}

export async function fetchLatestNativeResearchReport(page: Page, conversationId: string): Promise<NativeResearchReport | null> {
  const result = await fetchConversationForCorroboration(page, conversationId, 12_000, true);
  if (!result.ok) throw new Error(`Native research report read failed with HTTP ${result.status}`);
  return extractLatestNativeResearchReport(result.body);
}

/**
 * Corroboration read retry (P-035 audit 2026-09-02, P1-1).
 *
 * chatgpt.com answers these conversation GETs with HTTP 429 under load.
 * Throwing on the first non-200 discards an already-finished 14-60 minute
 * turn, so the read is retried with bounded jittered backoff. This is safe
 * ONLY because the endpoint is an idempotent GET — never route a
 * prompt-submitting POST through it.
 */
const CORROBORATION_MAX_ATTEMPTS = 4;
const CORROBORATION_BASE_DELAY_MS = 1_000;
const CORROBORATION_MAX_DELAY_MS = 8_000;
const CORROBORATION_JITTER_MS = 250;

function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function corroborationRetryDelayMs(attempt: number, retryAfter: string | null | undefined): number {
  const advertised = parseRetryAfterMs(retryAfter);
  if (advertised !== null) return Math.min(advertised, CORROBORATION_MAX_DELAY_MS);
  const backoff = Math.min(CORROBORATION_BASE_DELAY_MS * 2 ** (attempt - 1), CORROBORATION_MAX_DELAY_MS);
  return backoff + Math.random() * CORROBORATION_JITTER_MS;
}

/**
 * Single place both corroboration fetches route through. Retries HTTP 429
 * and 5xx up to `CORROBORATION_MAX_ATTEMPTS`; every other status (including
 * the 401 that means "no access token") is returned on the first response.
 */
async function fetchConversationForCorroboration(
  page: Page,
  conversationId: string,
  timeoutMs: number,
  retryTransient: boolean,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = `/backend-api/conversation/${conversationId}`;
  let result = await backendApiFetch(page, url, { timeoutMs });
  const attempts = retryTransient ? CORROBORATION_MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt < attempts; attempt++) {
    if (result.ok || (result.status !== 429 && result.status < 500)) break;
    const delayMs = corroborationRetryDelayMs(attempt, result.retryAfter);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    result = await backendApiFetch(page, url, { timeoutMs });
  }
  return result;
}

export async function fetchLatestTurnToolCalls(
  page: Page,
  conversationId: string,
  expectedAppName?: string,
  timeoutMs = 10_000,
  retryTransient = true,
): Promise<ConnectorToolCall[]> {
  const result = await fetchConversationForCorroboration(page, conversationId, timeoutMs, retryTransient);
  if (!result.ok) {
    throw new Error(`conversation tool evidence fetch failed with HTTP ${result.status}`);
  }
  return extractLatestTurnToolCalls(result.body, expectedAppName);
}

export async function fetchLatestTurnConnectorState(
  page: Page,
  conversationId: string,
  expectedAppName?: string,
  timeoutMs = 10_000,
  retryTransient = true,
): Promise<LatestTurnConnectorState> {
  const result = await fetchConversationForCorroboration(page, conversationId, timeoutMs, retryTransient);
  if (!result.ok) {
    throw new Error(`conversation connector state fetch failed with HTTP ${result.status}`);
  }
  return extractLatestTurnConnectorState(result.body, expectedAppName);
}

export async function fetchLatestTurnToolNames(
  page: Page,
  conversationId: string,
  expectedAppName?: string,
  timeoutMs = 10_000,
): Promise<string[]> {
  return (await fetchLatestTurnToolCalls(page, conversationId, expectedAppName, timeoutMs)).map((call) => call.name);
}

export async function fetchRemoteConversations(
  page: Page,
  opts: FetchOptions = {},
): Promise<RemoteConversation[]> {
  const limit = opts.limit ?? 100;
  const debug = opts.debug ?? process.env.CGPRO_DEBUG === "1";
  const log = (m: string): void => {
    if (debug) console.error("[cgpro:conversations]", m);
  };

  const fromApi = await fetchViaApi(page, limit, log);
  if (fromApi && fromApi.length > 0) return fromApi;

  log("API path returned no rows — falling back to DOM sidebar scrape.");
  return await fetchViaDom(page, limit, log);
}

async function fetchViaApi(
  page: Page,
  limit: number,
  log: (m: string) => void,
): Promise<RemoteConversation[] | null> {
  const urls = [
    `/backend-api/conversations?offset=0&limit=${limit}&order=updated`,
    `/backend-api/conversations?offset=0&limit=${limit}&order=updated&is_archived=false`,
    `/backend-api/me/conversations?offset=0&limit=${limit}`,
  ];

  for (const url of urls) {
    const result = await backendApiFetch(page, url);
    log(
      `${url} → ok=${result.ok} status=${result.status} bodyKeys=${
        result.body && typeof result.body === "object"
          ? Object.keys(result.body as object).join(",")
          : "(none)"
      }`,
    );
    if (!result.ok) continue;
    const rows = extractItems(result.body);
    if (rows.length > 0) {
      log(`${url} → matched ${rows.length} rows`);
      return rows.slice(0, limit);
    }
  }
  return null;
}

function extractItems(body: unknown): RemoteConversation[] {
  if (!body || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  const rawList = (Array.isArray(obj.items) ? obj.items : Array.isArray(obj.conversations) ? obj.conversations : []) as Array<Record<string, unknown>>;
  const out: RemoteConversation[] = [];
  for (const it of rawList) {
    const id = typeof it.id === "string" ? it.id : null;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) continue;
    const title = typeof it.title === "string" && it.title.trim().length > 0 ? it.title.trim() : "(untitled)";
    const updateTime = it.update_time ?? it.updated_at;
    const updatedAt = typeof updateTime === "string" ? updateTime : typeof updateTime === "number" ? new Date(updateTime * 1000).toISOString() : undefined;
    const isArchived = typeof it.is_archived === "boolean" ? it.is_archived : undefined;
    out.push({ id, title, updatedAt, isArchived, source: "api" });
  }
  return out;
}

async function fetchViaDom(
  page: Page,
  limit: number,
  log: (m: string) => void,
): Promise<RemoteConversation[]> {
  const links = await page
    .evaluate((sels) => {
      const tried: { sel: string; count: number }[] = [];
      for (const sel of sels) {
        const items = document.querySelectorAll(sel);
        tried.push({ sel, count: items.length });
        if (items.length === 0) continue;
        const out: { id: string; title: string }[] = [];
        items.forEach((el) => {
          const a = (el.tagName === "A" ? el : el.querySelector("a")) as HTMLAnchorElement | null;
          if (!a) return;
          const m = a.href.match(/\/c\/([0-9a-f-]{36})/i);
          if (!m) return;
          const text = (a.textContent ?? "").trim();
          out.push({ id: m[1], title: text.length > 0 ? text : "(untitled)" });
        });
        if (out.length > 0) return { tried, out };
      }
      return { tried, out: [] };
    }, SELECTORS.conversationItem)
    .catch((e) => {
      log(`DOM evaluate threw: ${(e as Error).message}`);
      return { tried: [] as { sel: string; count: number }[], out: [] as { id: string; title: string }[] };
    });

  for (const t of links.tried) {
    log(`dom selector "${t.sel}": ${t.count} matches`);
  }
  return links.out.slice(0, limit).map((l) => ({
    id: l.id,
    title: l.title,
    source: "dom" as const,
  }));
}
