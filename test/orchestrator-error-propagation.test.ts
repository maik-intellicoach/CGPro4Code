import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import type { Session } from "../src/browser/session.js";
import type { StreamEvent } from "../src/core/stream.js";

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
const readLatestAssistantText = vi.fn();
const sendPrompt = vi.fn();
const setConnector = vi.fn();
const ensureProSixMaximum = vi.fn();
const setDeepResearch = vi.fn();
const setWebSearch = vi.fn();
const stopCurrentTurn = vi.fn();
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
  currentConversationId: (...args: unknown[]) => currentConversationId(...args),
  latestAssistantModelSlug: (...args: unknown[]) => latestAssistantModelSlug(...args),
  openConversation: (...args: unknown[]) => openConversation(...args),
  readLatestAssistantText: (...args: unknown[]) => readLatestAssistantText(...args),
  sendPrompt: (...args: unknown[]) => sendPrompt(...args),
  setConnector: (...args: unknown[]) => setConnector(...args),
  setDeepResearch: (...args: unknown[]) => setDeepResearch(...args),
  setWebSearch: (...args: unknown[]) => setWebSearch(...args),
  stopCurrentTurn: (...args: unknown[]) => stopCurrentTurn(...args),
  waitTurnComplete: (...args: unknown[]) => waitTurnComplete(...args),
}));
vi.mock("../src/api/conversations.js", () => ({
  fetchNativeResearchUserNodes: (...args: unknown[]) => fetchNativeResearchUserNodes(...args),
  fetchLatestNativeResearchReport: (...args: unknown[]) => fetchLatestNativeResearchReport(...args),
  fetchLatestTurnConnectorState: (...args: unknown[]) => fetchLatestTurnConnectorState(...args),
}));

const { runAskOnSession } = await import("../src/core/orchestrator.js");

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function session(): Session {
  return {
    context: {},
    page: { url: () => "https://chatgpt.com/", locator: () => ({ count: async () => 1 }) } as unknown as Page,
    close: vi.fn(async () => {}),
  } as unknown as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAccount.mockReset().mockResolvedValue(undefined);
  verifyFiling.mockReset().mockResolvedValue({ status: "unavailable", conversationId: "id", projectId: null, accountVerified: false });
  fetchNativeResearchUserNodes.mockResolvedValue(new Set());
  fetchLatestNativeResearchReport.mockResolvedValue(null);
  goHome.mockResolvedValue(undefined);
  isLoggedIn.mockResolvedValue(true);
  openConversation.mockResolvedValue(undefined);
  ensureProSixMaximum.mockResolvedValue({ model: "gpt-6-pro", power: 4 });
  sendPrompt.mockImplementation(async (_page, _prompt, _preserve, _cancelled, guard) => { await guard?.(); return 0; });
  setWebSearch.mockResolvedValue(true);
  setConnector.mockResolvedValue(undefined);
  setDeepResearch.mockResolvedValue(true);
  stopCurrentTurn.mockResolvedValue("");
  currentConversationId.mockReturnValue(null);
  latestAssistantModelSlug.mockResolvedValue(null);
  readLatestAssistantText.mockResolvedValue("");
  fetchLatestTurnConnectorState.mockReset().mockResolvedValue({
    currentUserNodeId: "new-user",
    calls: [],
    currentRole: "assistant",
    currentStatus: "finished_successfully",
    currentEndTurn: true,
    currentContentType: "text",
    currentIsThinkingPreamble: false,
  });
});

describe("runAskOnSession native Deep Research contract", () => {
  it("accepts verified maximum UI selection while retaining the distinct native engine", async () => {
    currentConversationId.mockReturnValue("native-conversation");
    fetchLatestNativeResearchReport.mockResolvedValue({ text: "Native sourced report", model: "gpt-5-thinking", userNodeId: "new-user" });
    waitTurnComplete.mockImplementationOnce(async (_page, _timeout, _count, _stable, control) => {
      await control.pollEvidence();
      expect(control.externalComplete()).toBe(true);
    });
    const runner = runAskOnSession({ prompt: "research", deepResearch: true, model: "gpt-6-pro", timeoutSec: 1200, headless: false }, session());
    const events = await collect(runner.events);
    await expect(runner.result).resolves.toMatchObject({ finalText: "Native sourced report" });
    expect(readLatestAssistantText).not.toHaveBeenCalled();
    expect(events.some(e => e.type === "tool" && e.name === "model-mismatch")).toBe(false);
    expect(events).toContainEqual({ type: "tool", name: "model-thinking-verified", meta: { model: "gpt-6-pro", power: 4 } });
    expect(events).toContainEqual({ type: "tool", name: "native-research-report", meta: { model: "gpt-5-thinking", source: "widget_state", selectionBasis: "verified-ui-maximum", uiModel: "gpt-6-pro" } });
  });
  it("fails closed when the maximum UI verification fails", async () => {
    ensureProSixMaximum.mockRejectedValueOnce(new Error("6 Pro thinking power did not reach its maximum"));
    const runner = runAskOnSession({ prompt: "research", deepResearch: true, model: "gpt-6-pro", timeoutSec: 1200, headless: false }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("did not reach its maximum");
    expect(waitTurnComplete).not.toHaveBeenCalled();
  });
  it("retains the ordinary planning non-Pro model guard", async () => {
    latestAssistantModelSlug.mockResolvedValue("gpt-5-thinking");
    const runner = runAskOnSession({ prompt: "plan", model: "gpt-6-pro", timeoutSec: 1200, headless: false }, session());
    const events = await collect(runner.events); await runner.result;
    expect(events).toContainEqual({ type: "tool", name: "model-mismatch", meta: { wanted: "gpt-6-pro", got: "gpt-5-thinking" } });
  });
  it("rejects the old report while the new submitted turn has not persisted", async () => {
    currentConversationId.mockReturnValue("resumed-conversation");
    fetchNativeResearchUserNodes.mockResolvedValue(new Set(["old-user"]));
    fetchLatestNativeResearchReport.mockResolvedValue({ text: "Old report", model: "gpt-5-thinking", userNodeId: "old-user" });
    waitTurnComplete.mockImplementationOnce(async (_page, _timeout, _count, _stable, control) => {
      await control.pollEvidence();
      expect(control.externalComplete()).toBe(false);
      expect(await control.confirmComplete()).toBe(false);
      throw new Error("new turn not yet persisted");
    });
    const runner = runAskOnSession({ prompt: "research again", deepResearch: true, timeoutSec: 1200, headless: false }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("new turn not yet persisted");
    expect(fetchNativeResearchUserNodes.mock.invocationCallOrder[0]).toBeLessThan(sendPrompt.mock.invocationCallOrder[0]);
  });
  it("selects native Deep Research before submission and never enables Web Search", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    readLatestAssistantText.mockResolvedValueOnce("researched");
    const activeSession = session();
    const runner = runAskOnSession(
      {
        prompt: "research this",
        deepResearch: true,
        web: true,
        timeoutSec: 1_200,
        headless: false,
      },
      activeSession,
    );

    const events = await collect(runner.events);
    await expect(runner.result).resolves.toMatchObject({ finalText: "researched" });
    expect(setDeepResearch).toHaveBeenCalledWith(activeSession.page, true);
    expect(setWebSearch).not.toHaveBeenCalled();
    expect(setConnector).not.toHaveBeenCalled();
    expect(setDeepResearch.mock.invocationCallOrder[0]).toBeLessThan(sendPrompt.mock.invocationCallOrder[0]);
    expect(clearComposer.mock.invocationCallOrder[0]).toBeLessThan(setDeepResearch.mock.invocationCallOrder[0]);
    expect(sendPrompt.mock.calls[0][2]).toBe(true);
    expect(events).toContainEqual({ type: "tool", name: "deep-research-selected" });
  });

  it("rejects connector plus native Deep Research before touching the browser", async () => {
    const runner = runAskOnSession(
      {
        prompt: "invalid mixed turn",
        connector: "IntelliCoach Context",
        deepResearch: true,
        timeoutSec: 1_200,
        headless: false,
      },
      session(),
    );

    const events = await collect(runner.events);
    await expect(runner.result).rejects.toThrow("native Deep Research and connectors are mutually exclusive");
    expect(goHome).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "error", message: "native Deep Research and connectors are mutually exclusive" },
    ]);
  });
});

describe("runAskOnSession connector contract", () => {
  it("emits exact connector selection and prompt submission evidence in lifecycle order", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    readLatestAssistantText.mockResolvedValueOnce("grounded");
    const activeSession = session();
    const runner = runAskOnSession(
      {
        prompt: "test",
        connector: "IntelliCoach Context",
        web: false,
        timeoutSec: 1_200,
        headless: false,
      },
      activeSession,
    );

    const result = runner.result;
    const events = await collect(runner.events);
    await expect(result).resolves.toMatchObject({ finalText: "grounded" });
    expect(setWebSearch).toHaveBeenCalledWith(activeSession.page, false);
    expect(setConnector).toHaveBeenCalledWith(activeSession.page, "IntelliCoach Context");
    expect(setConnector.mock.invocationCallOrder[0]).toBeLessThan(sendPrompt.mock.invocationCallOrder[0]);
    expect(events).toContainEqual({
      type: "tool",
      name: "connector-selected",
      meta: { connector: "IntelliCoach Context" },
    });
    expect(events).toContainEqual({
      type: "tool",
      name: "prompt-submitted",
      meta: { connector: "IntelliCoach Context" },
    });
    const connectorLifecycle = events.filter(
      (event) => event.type === "tool" &&
        (event.name === "connector-selected" || event.name === "prompt-submitted"),
    );
    expect(connectorLifecycle).toEqual([
      { type: "tool", name: "connector-selected", meta: { connector: "IntelliCoach Context" } },
      { type: "tool", name: "prompt-submitted", meta: { connector: "IntelliCoach Context" } },
    ]);
    expect(sendPrompt.mock.invocationCallOrder[0]).toBeLessThan(waitTurnComplete.mock.invocationCallOrder[0]);
  });

  it("emits connector tool evidence from the completed conversation branch", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    readLatestAssistantText.mockResolvedValueOnce("grounded");
    fetchLatestTurnConnectorState.mockResolvedValueOnce({ currentUserNodeId: "new-user", calls: [
      { id: "call-1", name: "search_context" },
      { id: "call-2", name: "search_context" },
      { id: "call-3", name: "fetch_excerpt" },
    ] });
    const activeSession = session();
    const runner = runAskOnSession(
      {
        prompt: "test",
        connector: "p035-low-risk-workstation",
        timeoutSec: 1_200,
        headless: false,
      },
      activeSession,
    );

    const result = runner.result;
    const events = await collect(runner.events);
    await expect(result).resolves.toMatchObject({ finalText: "grounded" });
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledWith(
      activeSession.page,
      "11111111-1111-1111-1111-111111111111",
      "p035-low-risk-workstation",
      10_000,
      true,
    );
    expect(events).toContainEqual({
      type: "tool", name: "search_context",
      meta: { source: "latest-conversation-turn", connector: "p035-low-risk-workstation", callId: "call-1" },
    });
    expect(events).toContainEqual({
      type: "tool", name: "fetch_excerpt",
      meta: { source: "latest-conversation-turn", connector: "p035-low-risk-workstation", callId: "call-3" },
    });
    expect(events.filter((event) => event.type === "tool" && event.name === "search_context")).toHaveLength(2);
  });

  it("rate-limits active branch evidence and performs one final fetch", async () => {
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    fetchLatestTurnConnectorState.mockResolvedValue({ currentUserNodeId: "new-user", calls: [
      { id: "active-call-1", name: "search_context" },
    ] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    waitTurnComplete.mockImplementationOnce(
      async (_page, _timeout, _prior, _stable, control: { pollEvidence?: () => Promise<void> }) => {
        await control.pollEvidence?.();
        await vi.waitFor(() => expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        clock.mockReturnValue(1_029_999);
        await control.pollEvidence?.();
        expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(1_030_000);
        await control.pollEvidence?.();
        await vi.waitFor(() => expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(2));
        await Promise.resolve();
      },
    );
    readLatestAssistantText.mockResolvedValueOnce("grounded");
    const runner = runAskOnSession(
      {
        prompt: "test",
        connector: "p035-low-risk-workstation",
        timeoutSec: 1_200,
        headless: false,
      },
      session(),
    );

    const events = await collect(runner.events);
    await expect(runner.result).resolves.toMatchObject({ finalText: "grounded" });
    expect(events.filter((event) => event.type === "tool" && event.name === "search_context")).toHaveLength(1);
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(3);
    clock.mockRestore();
  });

  it("backs active evidence polling off for two minutes after HTTP 429", async () => {
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    fetchLatestTurnConnectorState
      .mockRejectedValueOnce(new Error("conversation connector state fetch failed with HTTP 429"))
      .mockResolvedValue({ currentUserNodeId: "new-user", calls: [] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    waitTurnComplete.mockImplementationOnce(
      async (_page, _timeout, _prior, _stable, control: { pollEvidence?: () => Promise<void> }) => {
        await control.pollEvidence?.();
        await vi.waitFor(() => expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        clock.mockReturnValue(2_060_000);
        await control.pollEvidence?.();
        expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(2_120_000);
        await control.pollEvidence?.();
        await vi.waitFor(() => expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(2));
        await Promise.resolve();
      },
    );
    const runner = runAskOnSession(
      { prompt: "test", connector: "p035-low-risk-workstation", timeoutSec: 1_200, headless: false },
      session(),
    );

    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    expect(await collect(runner.events)).toContainEqual(expect.objectContaining({ type: "done" }));
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(3);
    clock.mockRestore();
  });

  it("retains the finished answer as partial while failing terminal evidence verification", async () => {
    readLatestAssistantText.mockResolvedValue("finished answer");
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    waitTurnComplete.mockResolvedValueOnce(undefined);
    fetchLatestTurnConnectorState.mockRejectedValueOnce(
      new Error("conversation connector state fetch failed with HTTP 429"),
    );
    const runner = runAskOnSession(
      {
        prompt: "test",
        connector: "p035-low-risk-workstation",
        timeoutSec: 1_200,
        headless: false,
      },
      session(),
    );

    await expect(runner.result).rejects.toThrow("conversation connector state fetch failed with HTTP 429");
    const events = await collect(runner.events);
    expect(events).toContainEqual({ type: "delta", text: "finished answer" });
    expect(events).toContainEqual({ type: "error", message: "conversation connector state fetch failed with HTTP 429" });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  it("coalesces completion with polling and skips a redundant terminal GET", async () => {
    currentConversationId.mockReturnValue("conversation");
    waitTurnComplete.mockImplementationOnce(async (_p, _t, _n, _s, control) => {
      await Promise.all([control.pollEvidence(), control.confirmComplete()]);
      expect(await control.confirmComplete()).toBe(true);
      expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
      expect(fetchLatestTurnConnectorState.mock.calls[0].slice(-2)).toEqual([10_000, false]);
    });
    const runner = runAskOnSession({ prompt: "test", connector: "connector", timeoutSec: 1200, headless: false }, session());
    await runner.result;
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
  });

  it("completion cannot bypass Retry-After or accept a stale resumed turn", async () => {
    currentConversationId.mockReturnValue("conversation");
    fetchNativeResearchUserNodes.mockResolvedValueOnce(new Set(["new-user"]));
    fetchLatestTurnConnectorState.mockRejectedValueOnce(Object.assign(new Error("HTTP 429"), { retryAfterMs: 600_000 }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    waitTurnComplete.mockImplementationOnce(async (_p, _t, _n, _s, control) => {
      expect(await control.confirmComplete()).toBe(false);
      clock.mockReturnValue(3_120_000);
      await control.pollEvidence();
      expect(await control.confirmComplete()).toBe(false);
      expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(3_600_000);
      expect(await control.confirmComplete()).toBe(false);
      expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(2);
      throw new Error("still awaiting current turn");
    });
    const runner = runAskOnSession({ prompt: "test", connector: "connector", timeoutSec: 1200, headless: false }, session());
    await expect(runner.result).rejects.toThrow("still awaiting current turn");
    clock.mockRestore();
  });

  it("fails permanent completion verification while retaining only the new answer", async () => {
    currentConversationId.mockReturnValue("conversation");
    readLatestAssistantText.mockResolvedValue("new answer");
    fetchLatestTurnConnectorState.mockRejectedValueOnce(new Error("conversation connector state fetch failed with HTTP 403"));
    waitTurnComplete.mockImplementationOnce(async (_p, _t, _n, _s, control) => {
      await control.confirmComplete();
      throw new Error("permanent error was swallowed");
    });
    const runner = runAskOnSession({ prompt: "test", connector: "connector", timeoutSec: 1200, headless: false }, session());
    await expect(runner.result).rejects.toThrow("HTTP 403");
    const events = await collect(runner.events);
    expect(events).toContainEqual({ type: "delta", text: "new answer" });
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
  });

  it("fails before sending when the required connector cannot be selected", async () => {
    setConnector.mockRejectedValueOnce(new Error("connector unavailable"));
    const runner = runAskOnSession(
      { prompt: "test", connector: "IntelliCoach Context", timeoutSec: 1_200, headless: false },
      session(),
    );

    await expect(runner.result).rejects.toThrow("connector unavailable");
    expect(await collect(runner.events)).toEqual([{ type: "error", message: "connector unavailable" }]);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("emits no connector-selected and never submits when the picker click did not attach the connector", async () => {
    setConnector.mockRejectedValueOnce(
      new Error(
        'ChatGPT connector "IntelliCoach Context" was clicked but never became attached to the composer (the exact label row does not report an attached state after the click).',
      ),
    );
    const runner = runAskOnSession(
      { prompt: "test", connector: "IntelliCoach Context", timeoutSec: 1_200, headless: false },
      session(),
    );

    await expect(runner.result).rejects.toThrow("never became attached to the composer");
    const events = await collect(runner.events);
    expect(events).toEqual([
      expect.objectContaining({ type: "error", message: expect.stringContaining("never became attached") }),
    ]);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("does not emit prompt submission when sending fails", async () => {
    sendPrompt.mockRejectedValueOnce(new Error("send unavailable"));
    const runner = runAskOnSession(
      { prompt: "test", connector: "IntelliCoach Context", timeoutSec: 1_200, headless: false },
      session(),
    );

    await expect(runner.result).rejects.toThrow("send unavailable");
    expect(await collect(runner.events)).toEqual([
      { type: "tool", name: "connector-selected", meta: { connector: "IntelliCoach Context" } },
      { type: "error", message: "send unavailable" },
    ]);
  });

  it("does not emit prompt submission when cancellation makes sending return without submitting", async () => {
    let finishSend: (value: number) => void = () => {};
    sendPrompt.mockImplementationOnce(
      () => new Promise<number>((resolve) => { finishSend = resolve; }),
    );
    waitTurnComplete.mockResolvedValueOnce(undefined);
    const runner = runAskOnSession(
      { prompt: "test", connector: "IntelliCoach Context", timeoutSec: 1_200, headless: false },
      session(),
    );

    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    await runner.cancel();
    finishSend(0);

    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    const events = await collect(runner.events);
    expect(events).toContainEqual({
      type: "tool", name: "connector-selected", meta: { connector: "IntelliCoach Context" },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool", name: "prompt-submitted" }));
  });
});

describe("runAskOnSession wait failure propagation", () => {
  it("keeps the 588-second browser closure distinct from a configured 1200-second timeout", async () => {
    const closed = new Error("Target page, context or browser has been closed");
    waitTurnComplete.mockRejectedValueOnce(closed);
    const activeSession = session();
    const runner = runAskOnSession(
      { prompt: "test", timeoutSec: 1_200, headless: false },
      activeSession,
    );

    const result = runner.result.catch((error) => error);
    const events = await collect(runner.events);

    expect(await result).toBe(closed);
    expect(events).toEqual([{ type: "error", message: closed.message }]);
    expect(waitTurnComplete).toHaveBeenCalledWith(
      activeSession.page,
      1_200_000,
      0,
      undefined,
      expect.objectContaining({ consumeReload: undefined }),
    );
  });

  it("keeps the existing cancellation path non-terminal when a wait rejects afterwards", async () => {
    const closed = new Error("Target page, context or browser has been closed");
    let rejectWait: (error: Error) => void = () => {};
    waitTurnComplete.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectWait = reject; }),
    );
    const runner = runAskOnSession(
      { prompt: "test", timeoutSec: 1_200, headless: false },
      session(),
    );

    await vi.waitFor(() => expect(waitTurnComplete).toHaveBeenCalledTimes(1));
    await runner.cancel();
    expect(stopCurrentTurn).toHaveBeenCalledTimes(1);
    rejectWait(closed);

    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    expect(await collect(runner.events)).toEqual([{ type: "done", finalText: "" }]);
  });

  it("lets cancellation resolve the active waiter without a later browser error", async () => {
    waitTurnComplete.mockImplementationOnce(
      (_page, _timeout, _prior, _stable, control: { cancelled?: () => boolean }) =>
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (control.cancelled?.()) {
              resolve();
              return;
            }
            setTimeout(check, 0);
          };
          check();
        }),
    );
    const runner = runAskOnSession(
      { prompt: "test", timeoutSec: 1_200, headless: false },
      session(),
    );

    await vi.waitFor(() => expect(waitTurnComplete).toHaveBeenCalledTimes(1));
    await runner.cancel();

    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    expect(stopCurrentTurn).toHaveBeenCalledTimes(1);
    expect(await collect(runner.events)).toEqual([{ type: "done", finalText: "" }]);
  });
});


describe("account and Project filing contract", () => {
  const opts = { prompt: "plan", model: "gpt-6-pro", timeoutSec: 1200, headless: false, gizmoId: "g-p-fixture", expectedAccountEmail: "fixture@example.com" };
  it("refuses account mismatch before any prompt submission", async () => {
    requireAccount.mockRejectedValueOnce(new Error("account mismatch"));
    const runner = runAskOnSession(opts, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("account mismatch");
    expect(sendPrompt).not.toHaveBeenCalled();
  });
  it("refuses a resumed chat outside the expected Project before sending", async () => {
    verifyFiling.mockResolvedValue({ status: "mismatch" });
    const runner = runAskOnSession({ ...opts, conversationId: "existing" }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("Project membership not verified before submission");
    expect(sendPrompt).not.toHaveBeenCalled();
  });
  it("retains completed output when post-submit filing cannot be verified", async () => {
    currentConversationId.mockReturnValue("id");
    readLatestAssistantText.mockResolvedValue("completed answer");
    const runner = runAskOnSession(opts, session());
    await collect(runner.events);
    const result = await runner.result;
    expect(result.finalText).toBe("completed answer");
    expect(result.filing).toMatchObject({ status: "unavailable", preSubmitVerified: true });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });
});
