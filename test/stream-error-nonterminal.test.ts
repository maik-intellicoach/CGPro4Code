import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "patchright";
import type { Session } from "../src/browser/session.js";
import type { StreamEvent } from "../src/core/stream.js";
import { ensureInterceptorInstalled } from "../src/core/stream.js";

// P-035 G3 r41 (2026-09-28). Live: a mid-turn interceptor stream break pushed a
// terminal `error` into the emitter, which marked the stream finished and ended
// a live turn at 118 partial bytes while ChatGPT kept working. A stream break is
// not the end of the turn. This orchestrator-level case drives the real
// `__cgproDone` binding, then lets the DOM wait report a completed assistant
// bubble, and pins that the turn still ends with one `done` carrying the DOM text.

const requireAccount = vi.fn();
const verifyFiling = vi.fn();
vi.mock("../src/api/conversation-filing.js", () => ({
  requireAccount: (...args: unknown[]) => requireAccount(...args),
  verifyFiling: (...args: unknown[]) => verifyFiling(...args),
}));

const goHome = vi.fn();
const isLoggedIn = vi.fn();
const currentConversationId = vi.fn();
const latestAssistantModelSlug = vi.fn();
const openConversation = vi.fn();
const clearComposer = vi.fn();
const assertPreflightDraftSafe = vi.fn();
const readLatestAssistantText = vi.fn();
const sendPrompt = vi.fn();
const setConnector = vi.fn();
const probePromptDelivery = vi.fn();
const ensureProSixMaximum = vi.fn();
const setDeepResearch = vi.fn();
const setWebSearch = vi.fn();
const stopCurrentTurn = vi.fn();
const waitForComposerHydrated = vi.fn();
const waitTurnComplete = vi.fn();
const fetchLatestTurnConnectorState = vi.fn();
const fetchLatestNativeResearchReport = vi.fn();
const fetchNativeResearchUserNodes = vi.fn();

vi.mock("../src/browser/chatgpt.js", () => ({
  requireSelector: vi.fn(async () => ({})),
  goHome: (...args: unknown[]) => goHome(...args),
  isLoggedIn: (...args: unknown[]) => isLoggedIn(...args),
}));
vi.mock("../src/browser/conversation.js", () => ({
  ensureProSixMaximum: (...args: unknown[]) => ensureProSixMaximum(...args),
  clearComposer: (...args: unknown[]) => clearComposer(...args),
  assertPreflightDraftSafe: (...args: unknown[]) => assertPreflightDraftSafe(...args),
  currentConversationId: (...args: unknown[]) => currentConversationId(...args),
  latestAssistantModelSlug: (...args: unknown[]) => latestAssistantModelSlug(...args),
  openConversation: (...args: unknown[]) => openConversation(...args),
  readLatestAssistantText: (...args: unknown[]) => readLatestAssistantText(...args),
  sendPrompt: (...args: unknown[]) => sendPrompt(...args),
  setConnector: (...args: unknown[]) => setConnector(...args),
  probePromptDelivery: (...args: unknown[]) => probePromptDelivery(...args),
  setDeepResearch: (...args: unknown[]) => setDeepResearch(...args),
  setWebSearch: (...args: unknown[]) => setWebSearch(...args),
  stopCurrentTurn: (...args: unknown[]) => stopCurrentTurn(...args),
  waitForComposerHydrated: (...args: unknown[]) => waitForComposerHydrated(...args),
  waitTurnComplete: (...args: unknown[]) => waitTurnComplete(...args),
}));
vi.mock("../src/api/conversations.js", () => ({
  fetchNativeResearchUserNodes: (...args: unknown[]) => fetchNativeResearchUserNodes(...args),
  fetchLatestNativeResearchReport: (...args: unknown[]) => fetchLatestNativeResearchReport(...args),
  fetchLatestTurnConnectorState: (...args: unknown[]) => fetchLatestTurnConnectorState(...args),
}));

const { runAskOnSession } = await import("../src/core/orchestrator.js");

type Binding = (src: { page?: Page }, ...args: unknown[]) => void;

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function sessionWithContext(context: BrowserContext): Session {
  return {
    context,
    page: {
      url: () => "https://chatgpt.com/",
      locator: () => ({ count: async () => 1 }),
    } as unknown as Page,
    close: vi.fn(async () => {}),
  } as unknown as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  assertPreflightDraftSafe.mockReset().mockResolvedValue(undefined);
  requireAccount.mockReset().mockResolvedValue(undefined);
  verifyFiling.mockReset().mockResolvedValue({ status: "unavailable", conversationId: "id", projectId: null, accountVerified: false });
  fetchNativeResearchUserNodes.mockResolvedValue(new Set());
  fetchLatestNativeResearchReport.mockResolvedValue(null);
  goHome.mockResolvedValue(undefined);
  isLoggedIn.mockResolvedValue(true);
  openConversation.mockResolvedValue(undefined);
  sendPrompt.mockImplementation(async (_page, _prompt, _preserve, _cancelled, guard) => { await guard?.(); return 0; });
  setWebSearch.mockResolvedValue(true);
  setConnector.mockResolvedValue(undefined);
  probePromptDelivery.mockReset().mockResolvedValue({ requestedChars: 1, arrivedChars: 1, complete: true });
  setDeepResearch.mockResolvedValue(true);
  stopCurrentTurn.mockResolvedValue("");
  currentConversationId.mockReturnValue(null);
  latestAssistantModelSlug.mockResolvedValue(null);
  readLatestAssistantText.mockResolvedValue("");
  fetchLatestTurnConnectorState.mockReset().mockResolvedValue(null);
});

it("keeps the turn alive across a mid-turn stream break and ends with the DOM answer", async () => {
  const bindings: Record<string, Binding> = {};
  const context = {
    exposeBinding: async (name: string, callback: Binding) => {
      bindings[name] = callback;
    },
    addInitScript: async () => {},
  } as unknown as BrowserContext;
  await ensureInterceptorInstalled(context);
  const session = sessionWithContext(context);
  const page = session.page;

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // Mid-turn: the in-page reader breaks and reports it through the binding,
    // then the DOM wait sees the completed assistant bubble and returns.
    waitTurnComplete.mockImplementationOnce(async () => {
      bindings["__cgproStart"]!({ page }, "obs-live");
      bindings["__cgproDone"]!({ page }, "obs-live", { reason: "error" });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toBe(
        "[cgpro:stream] interceptor stream error; DOM completion continues breaks=1",
      );
    });
    readLatestAssistantText.mockResolvedValue("DOM answer");

    const runner = runAskOnSession(
      { prompt: "plan the day", timeoutSec: 1200, headless: false },
      session,
    );
    const events = await collect(runner.events);
    const result = await runner.result;

    expect(result.finalText).toBe("DOM answer");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "done")).toEqual([
      { type: "done", finalText: "DOM answer" },
    ]);
  } finally {
    errorSpy.mockRestore();
  }
});
