import { describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { goHome, NAV_TIMEOUT_MS } from "../src/browser/chatgpt.js";
import { openConversation } from "../src/browser/conversation.js";

// P-035 2026-10-14, 8ebb7404: on a host at load average ~130 on 20 cores the
// first goHome of a fresh lane overran the old 60 s bound. Every top-level
// chatgpt.com navigation now waits NAV_TIMEOUT_MS.
const STOP = new Error("navigation recorded");

function recordingPage(): { page: Page; goto: ReturnType<typeof vi.fn> } {
  const goto = vi.fn(async () => {
    throw STOP;
  });
  return { page: { goto } as unknown as Page, goto };
}

describe("navigation bound on a CPU-starved host", () => {
  it("is 120 s", () => {
    expect(NAV_TIMEOUT_MS).toBe(120_000);
  });

  it("goHome passes NAV_TIMEOUT_MS", async () => {
    const { page, goto } = recordingPage();
    await expect(goHome(page)).rejects.toBe(STOP);
    expect(goto).toHaveBeenCalledWith("https://chatgpt.com/", expect.objectContaining({ timeout: NAV_TIMEOUT_MS }));
  });

  it("opening a conversation by id passes NAV_TIMEOUT_MS", async () => {
    const { page, goto } = recordingPage();
    await expect(openConversation(page, { conversationId: "conv-1" })).rejects.toBe(STOP);
    expect(goto).toHaveBeenCalledWith(
      "https://chatgpt.com/c/conv-1",
      expect.objectContaining({ timeout: NAV_TIMEOUT_MS }),
    );
  });

  it("opening a fresh chat passes NAV_TIMEOUT_MS", async () => {
    const { page, goto } = recordingPage();
    await expect(openConversation(page, {})).rejects.toBe(STOP);
    expect(goto).toHaveBeenCalledWith("https://chatgpt.com/", expect.objectContaining({ timeout: NAV_TIMEOUT_MS }));
  });
});
