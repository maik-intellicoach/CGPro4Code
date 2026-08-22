import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import type { Session } from "../src/browser/session.js";
import type { StreamEvent } from "../src/core/stream.js";

const goHome = vi.fn();
const isLoggedIn = vi.fn();
const currentConversationId = vi.fn();
const latestAssistantModelSlug = vi.fn();
const openConversation = vi.fn();
const readLatestAssistantText = vi.fn();
const sendPrompt = vi.fn();
const setConnector = vi.fn();
const setWebSearch = vi.fn();
const stopCurrentTurn = vi.fn();
const waitTurnComplete = vi.fn();
const fetchLatestTurnToolCalls = vi.fn();

vi.mock("../src/browser/chatgpt.js", () => ({
  goHome: (...args: unknown[]) => goHome(...args),
  isLoggedIn: (...args: unknown[]) => isLoggedIn(...args),
}));
vi.mock("../src/browser/conversation.js", () => ({
  currentConversationId: (...args: unknown[]) => currentConversationId(...args),
  latestAssistantModelSlug: (...args: unknown[]) => latestAssistantModelSlug(...args),
  openConversation: (...args: unknown[]) => openConversation(...args),
  readLatestAssistantText: (...args: unknown[]) => readLatestAssistantText(...args),
  sendPrompt: (...args: unknown[]) => sendPrompt(...args),
  setConnector: (...args: unknown[]) => setConnector(...args),
  setWebSearch: (...args: unknown[]) => setWebSearch(...args),
  stopCurrentTurn: (...args: unknown[]) => stopCurrentTurn(...args),
  waitTurnComplete: (...args: unknown[]) => waitTurnComplete(...args),
}));
vi.mock("../src/api/conversations.js", () => ({
  fetchLatestTurnToolCalls: (...args: unknown[]) => fetchLatestTurnToolCalls(...args),
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
    page: { url: () => "https://chatgpt.com/" } as unknown as Page,
    close: vi.fn(async () => {}),
  } as unknown as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  goHome.mockResolvedValue(undefined);
  isLoggedIn.mockResolvedValue(true);
  openConversation.mockResolvedValue(undefined);
  sendPrompt.mockResolvedValue(0);
  setWebSearch.mockResolvedValue(true);
  setConnector.mockResolvedValue(undefined);
  stopCurrentTurn.mockResolvedValue("");
  currentConversationId.mockReturnValue(null);
  latestAssistantModelSlug.mockResolvedValue(null);
  readLatestAssistantText.mockResolvedValue("");
  fetchLatestTurnToolCalls.mockResolvedValue([]);
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
    fetchLatestTurnToolCalls.mockResolvedValueOnce([
      { id: "call-1", name: "search_context" },
      { id: "call-2", name: "search_context" },
      { id: "call-3", name: "fetch_excerpt" },
    ]);
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
    expect(fetchLatestTurnToolCalls).toHaveBeenCalledWith(
      activeSession.page,
      "11111111-1111-1111-1111-111111111111",
      "p035-low-risk-workstation",
      10_000,
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

  it("polls connector call evidence while the turn is still active", async () => {
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    fetchLatestTurnToolCalls.mockResolvedValueOnce([
      { id: "active-call-1", name: "search_context" },
    ]).mockResolvedValueOnce([
      { id: "active-call-1", name: "search_context" },
    ]);
    waitTurnComplete.mockImplementationOnce(
      async (_page, _timeout, _prior, _stable, control: { pollEvidence?: () => Promise<void> }) => {
        await control.pollEvidence?.();
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
    expect(fetchLatestTurnToolCalls).toHaveBeenCalledTimes(2);
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
  it("cancels promptly while an active connector evidence poll is stalled", async () => {
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    fetchLatestTurnToolCalls.mockReturnValueOnce(new Promise(() => {}));
    waitTurnComplete.mockImplementationOnce(
      async (_page, _timeout, _prior, _stable, control: {
        cancelled?: () => boolean;
        pollEvidence?: () => Promise<void>;
      }) => {
        await control.pollEvidence?.();
        while (!control.cancelled?.()) await new Promise((resolve) => setTimeout(resolve, 0));
      },
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

    await vi.waitFor(() => expect(fetchLatestTurnToolCalls).toHaveBeenCalledTimes(1));
    await runner.cancel();
    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    expect(await collect(runner.events)).toContainEqual({ type: "done", finalText: "" });
  });

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
