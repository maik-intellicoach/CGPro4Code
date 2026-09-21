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

  it("does not retry a 4xx other than 429 and 404", async () => {
    backendApiFetch.mockResolvedValue(response(403));

    const calls = fetchLatestTurnToolCalls(page, CONVERSATION_ID, "connector");
    const assertion = expect(calls).rejects.toThrow(
      "conversation tool evidence fetch failed with HTTP 403",
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(backendApiFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a 404 and accepts the evidence the retried read returns", async () => {
    // P-035 2026-09-21. A connector-required planning turn retrieved connector
    // evidence (35 tool calls, counted live from the turn stream) and was then
    // discarded because this read of its OWN conversation answered 404. A 404
    // here is transient far more often than it is permanent -- an edge miss, or
    // a conversation not yet readable server-side as the read races the end of
    // the turn -- and retrying it costs seconds when it IS permanent, with an
    // identical refusal. The gate itself is unchanged: the read must still
    // succeed and must still show the required connector was used.
    backendApiFetch
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200));

    const calls = await (async () => {
      const pending = fetchLatestTurnToolCalls(page, CONVERSATION_ID, "connector");
      await vi.runAllTimersAsync();
      return pending;
    })();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("search_context");
    expect(backendApiFetch).toHaveBeenCalledTimes(2);
  });

  it("still refuses a 404 that never clears, after the same bounded budget", async () => {
    // The inverse guard. Retrying must not turn a genuinely absent conversation
    // into an accepted turn: the refusal is unchanged, only later.
    backendApiFetch.mockResolvedValue(response(404));

    const state = fetchLatestTurnConnectorState(page, CONVERSATION_ID, "connector");
    const assertion = expect(state).rejects.toThrow(
      "conversation connector state fetch failed with HTTP 404",
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(backendApiFetch).toHaveBeenCalledTimes(4);
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

  it("gives up a bounded read rather than retrying before a long Retry-After", async () => {
    backendApiFetch.mockResolvedValueOnce(response(429, "600"));
    const assertion = expect(fetchLatestTurnToolCalls(page, CONVERSATION_ID, "connector")).rejects.toThrow("HTTP 429");
    await vi.runAllTimersAsync();
    await assertion;
    expect(backendApiFetch).toHaveBeenCalledTimes(1);
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
