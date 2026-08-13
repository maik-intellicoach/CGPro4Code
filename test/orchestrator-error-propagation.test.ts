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
const setWebSearch = vi.fn();
const waitTurnComplete = vi.fn();

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
  setWebSearch: (...args: unknown[]) => setWebSearch(...args),
  waitTurnComplete: (...args: unknown[]) => waitTurnComplete(...args),
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
  currentConversationId.mockReturnValue(null);
  latestAssistantModelSlug.mockResolvedValue(null);
  readLatestAssistantText.mockResolvedValue("");
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
    rejectWait(closed);

    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    expect(await collect(runner.events)).toEqual([{ type: "done", finalText: "" }]);
  });
});
