import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { TurnTimeoutError } from "../src/errors.js";

const prompts = vi.fn();
const spinner = {
  start: vi.fn(),
  stop: vi.fn(),
  fail: vi.fn(),
};
spinner.start.mockReturnValue(spinner);
const openSession = vi.fn();
const goHome = vi.fn();
const isLoggedIn = vi.fn();
const fetchAuthSession = vi.fn();
const openConversation = vi.fn();
const setWebSearch = vi.fn();
const sendPrompt = vi.fn();
const waitTurnComplete = vi.fn();
const fetchModels = vi.fn();
const findProSlug = vi.fn();
const assertNoDaemon = vi.fn();

vi.mock("prompts", () => ({ default: (...args: unknown[]) => prompts(...args) }));
vi.mock("ora", () => ({ default: () => spinner }));
vi.mock("../src/browser/session.js", () => ({ openSession: (...args: unknown[]) => openSession(...args) }));
vi.mock("../src/browser/chatgpt.js", () => ({
  fetchAuthSession: (...args: unknown[]) => fetchAuthSession(...args),
  goHome: (...args: unknown[]) => goHome(...args),
  isLoggedIn: (...args: unknown[]) => isLoggedIn(...args),
}));
vi.mock("../src/browser/conversation.js", () => ({
  currentConversationId: vi.fn(),
  openConversation: (...args: unknown[]) => openConversation(...args),
  readLatestAssistantText: vi.fn(),
  sendPrompt: (...args: unknown[]) => sendPrompt(...args),
  setWebSearch: (...args: unknown[]) => setWebSearch(...args),
  waitTurnComplete: (...args: unknown[]) => waitTurnComplete(...args),
}));
vi.mock("../src/api/models.js", () => ({
  fetchModels: (...args: unknown[]) => fetchModels(...args),
  findProSlug: (...args: unknown[]) => findProSlug(...args),
}));
vi.mock("../src/store/config.js", () => ({
  loadConfig: () => ({ defaultModel: "gpt-5-5-pro", defaultWeb: true, defaultHeadless: false, timeoutSec: 1_200 }),
}));
vi.mock("../src/store/threads.js", () => ({ findThread: vi.fn(), saveThread: vi.fn() }));
vi.mock("../src/daemon/client.js", () => ({ assertNoDaemon: (...args: unknown[]) => assertNoDaemon(...args) }));

const { chatCommand } = await import("../src/cli/commands/chat.js");

beforeEach(() => {
  vi.clearAllMocks();
  prompts.mockReset();
  spinner.start.mockReturnValue(spinner);
  const session = {
    context: {},
    page: { url: () => "https://chatgpt.com/" } as unknown as Page,
    close: vi.fn(async () => {}),
  };
  openSession.mockResolvedValue(session);
  assertNoDaemon.mockResolvedValue(undefined);
  goHome.mockResolvedValue(undefined);
  isLoggedIn.mockResolvedValue(true);
  fetchAuthSession.mockResolvedValue({ accessToken: "token" });
  fetchModels.mockResolvedValue([]);
  findProSlug.mockReturnValue("gpt-5-5-pro");
  openConversation.mockResolvedValue(undefined);
  setWebSearch.mockResolvedValue(true);
  sendPrompt.mockResolvedValue(0);
  prompts.mockResolvedValueOnce({ value: "test" }).mockResolvedValueOnce({ value: undefined });
});

describe("chat wait failure classification", () => {
  it("preserves a browser closure instead of relabelling it as the configured timeout", async () => {
    const closed = new Error("Target page, context or browser has been closed");
    waitTurnComplete.mockRejectedValueOnce(closed);

    await expect(chatCommand({ timeout: 1_200 })).rejects.toBe(closed);
    expect(spinner.fail).toHaveBeenCalledWith(closed.message);
    expect(waitTurnComplete).toHaveBeenCalledWith(expect.anything(), 1_200_000);
  });

  it("keeps a genuine deadline as the typed timeout path", async () => {
    waitTurnComplete.mockRejectedValueOnce(new TurnTimeoutError(1_200));

    await expect(chatCommand({ timeout: 1_200 })).resolves.toBe(0);
    expect(spinner.fail).toHaveBeenCalledWith("Turn timed out after 1200s.");
  });
});
