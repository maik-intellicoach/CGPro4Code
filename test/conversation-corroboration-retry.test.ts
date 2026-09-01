import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";

// P-035 audit 2026-09-02, P1-1: chatgpt.com answers the two conversation
// corroboration GETs with HTTP 429 under load. Throwing on the first
// non-200 discarded a finished 14-60 minute turn, so both reads retry
// transient statuses with bounded jittered backoff. These tests drive the
// retry through a mocked backendApiFetch (same module-mock pattern as
// connector-attachment.test.ts) on fake timers.

const backendApiFetch = vi.fn();

vi.mock("../src/browser/chatgpt.js", () => ({
  backendApiFetch: (...args: unknown[]) => backendApiFetch(...args),
}));

const { fetchLatestTurnToolCalls, fetchLatestTurnConnectorState } = await import(
  "../src/api/conversations.js"
);

const page = {} as Page;
const CONVERSATION_ID = "11111111-1111-1111-1111-111111111111";

const response = (status: number, retryAfter: string | null = null) => ({
  ok: status >= 200 && status < 300,
  status,
  body: status === 200
    ? {
        current_node: "tool",
        mapping: {
          tool: {
            parent: "user",
            message: {
              id: "call-1",
              author: { role: "tool" },
              metadata: {
                invoked_resource: { resource_uri: "/app/link/search_context", app_name: "connector" },
              },
            },
          },
          user: { parent: null, message: { author: { role: "user" } } },
        },
      }
    : null,
  retryAfter,
});

beforeEach(() => {
  backendApiFetch.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("conversation corroboration retry", () => {
  it("retries a 429 and returns the evidence from the retried response", async () => {
    backendApiFetch
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200));

    const calls = fetchLatestTurnToolCalls(page, CONVERSATION_ID, "connector");
    await vi.runAllTimersAsync();

    await expect(calls).resolves.toEqual([{ id: "call-1", name: "search_context" }]);
    expect(backendApiFetch).toHaveBeenCalledTimes(2);
    expect(backendApiFetch).toHaveBeenCalledWith(
      page,
      `/backend-api/conversation/${CONVERSATION_ID}`,
      { timeoutMs: 10_000 },
    );
  });

  it("retries a 5xx as well", async () => {
    backendApiFetch
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));

    const state = fetchLatestTurnConnectorState(page, CONVERSATION_ID, "connector");
    await vi.runAllTimersAsync();

    await expect(state).resolves.toMatchObject({ calls: [{ id: "call-1", name: "search_context" }] });
    expect(backendApiFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after four attempts and throws with the original status", async () => {
    backendApiFetch.mockResolvedValue(response(429));

    const calls = fetchLatestTurnToolCalls(page, CONVERSATION_ID, "connector");
    const assertion = expect(calls).rejects.toThrow(
      "conversation tool evidence fetch failed with HTTP 429",
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(backendApiFetch).toHaveBeenCalledTimes(4);
  });

  it("keeps the whole retry budget under 15 seconds", async () => {
    backendApiFetch.mockResolvedValue(response(429));

    const started = Date.now();
    const calls = fetchLatestTurnConnectorState(page, CONVERSATION_ID, "connector");
    const assertion = expect(calls).rejects.toThrow("HTTP 429");
    await vi.runAllTimersAsync();
    await assertion;

    // 1s + 2s + 4s of backoff plus jitter, and nothing near a minute.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(7_000);
    expect(elapsed).toBeLessThan(15_000);
  });

  it("does not retry a 4xx other than 429", async () => {
    backendApiFetch.mockResolvedValue(response(403));

    const calls = fetchLatestTurnToolCalls(page, CONVERSATION_ID, "connector");
    const assertion = expect(calls).rejects.toThrow(
      "conversation tool evidence fetch failed with HTTP 403",
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(backendApiFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry the 401 that means no access token", async () => {
    backendApiFetch.mockResolvedValue(response(401));

    const state = fetchLatestTurnConnectorState(page, CONVERSATION_ID, "connector");
    const assertion = expect(state).rejects.toThrow(
      "conversation connector state fetch failed with HTTP 401",
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(backendApiFetch).toHaveBeenCalledTimes(1);
  });

  it("waits for the advertised Retry-After instead of the default backoff", async () => {
    backendApiFetch
      .mockResolvedValueOnce(response(429, "5"))
      .mockResolvedValueOnce(response(200));

    const calls = fetchLatestTurnToolCalls(page, CONVERSATION_ID, "connector");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(backendApiFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(backendApiFetch).toHaveBeenCalledTimes(2);
    await expect(calls).resolves.toEqual([{ id: "call-1", name: "search_context" }]);
  });

  it("caps an absurd Retry-After at the maximum delay", async () => {
    backendApiFetch
      .mockResolvedValueOnce(response(429, "600"))
      .mockResolvedValueOnce(response(200));

    const calls = fetchLatestTurnToolCalls(page, CONVERSATION_ID, "connector");

    await vi.advanceTimersByTimeAsync(8_000);
    expect(backendApiFetch).toHaveBeenCalledTimes(2);
    await expect(calls).resolves.toHaveLength(1);
  });

  it("does not retry when the caller opts out", async () => {
    backendApiFetch.mockResolvedValue(response(429));

    const calls = fetchLatestTurnToolCalls(page, CONVERSATION_ID, "connector", 1_000, false);
    const assertion = expect(calls).rejects.toThrow("HTTP 429");
    await vi.runAllTimersAsync();
    await assertion;

    expect(backendApiFetch).toHaveBeenCalledTimes(1);
  });
});
