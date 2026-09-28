import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { ProUsageLimitAfterSubmitError, TurnTimeoutError } from "../src/errors.js";

/**
 * P-035 G2 r22. The turn waiter prints at most one content-free status line per
 * minute so a silent `waitTurnComplete` (live ms1980: `connector_tool_count 0`
 * and `response_bytes 0` for 3000 s) becomes readable in the daemon log. These
 * tests drive the waiter with a scripted clock and a page double, and pin the
 * two properties that matter: the line carries counts and yes/no flags only,
 * and the heartbeat can never change the turn's result.
 */

const firstResolved = vi.fn();
const requireSelector = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...args),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
}));

const { waitTurnComplete } = await import("../src/browser/conversation.js");

const CONVERSATION_ID = "6f2b0c1e-7a4d-4c8e-9b3f-1d5a7c9e2b40";
const CONVERSATION_URL = `https://chatgpt.com/c/${CONVERSATION_ID}`;
const LIMIT_ALERT_TEXT = "You've reached your limit";
const BUBBLE_TEXT = "Hello there";

const HEALTHY_LINE =
  "[cgpro:turn] t=60 assistant=0/0 working=no stop=no bubble_len=0 " +
  "conv=yes composer=no alerts=0 error_hint=no limit_hint=no limit_exact=no";

afterEach(() => {
  firstResolved.mockReset();
  requireSelector.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type RunOptions = {
  timeoutMs: number;
  assistantCount: () => number;
  alerts?: Array<{ visible: boolean; text: string }>;
  url?: () => string;
  control?: Record<string, unknown>;
  /** Bubble text per read; defaults to one stable `BUBBLE_TEXT`. */
  bubbleText?: () => string;
  /** When true the composer's Stop control resolves, so the turn reads working. */
  stopVisible?: boolean;
  /** Capture a non-timeout throw instead of rethrowing it, for assertions. */
  captureFailure?: boolean;
};

type RunResult = {
  outcome: "resolved" | "timeout" | "error";
  completedAt: number;
  bubbleSeenAt: number | null;
  lines: string[];
  error: unknown;
};

/**
 * Drive `waitTurnComplete` on a scripted fake clock. `assistantCount` is asked
 * for the live assistant-bubble count on every poll, so a test can make the
 * bubble appear at an exact simulated second.
 */
async function runTurn(options: RunOptions): Promise<RunResult> {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
  firstResolved.mockImplementation(async (_page: unknown, selector: unknown) =>
    options.stopVisible && String(selector).includes("stop-button") ? {} : null,
  );

  const alertElements = options.alerts ?? [];
  let bubbleSeenAt: number | null = null;
  const bubble = {
    getAttribute: async () => null,
    innerText: async () => (options.bubbleText ?? (() => BUBBLE_TEXT))(),
  };
  const assistantLocator = {
    count: async (): Promise<number> => {
      const count = options.assistantCount();
      if (count > 0 && bubbleSeenAt === null) bubbleSeenAt = Date.now();
      return count;
    },
    nth: () => bubble,
    first: () => assistantLocator,
  };
  const alertLocator = {
    count: async (): Promise<number> => alertElements.length,
    nth: (index: number) => ({
      isVisible: async () => alertElements[index]?.visible ?? false,
      innerText: async () => alertElements[index]?.text ?? "",
    }),
  };
  const page = {
    locator: (selector: string) =>
      selector.includes('role="alert"') ? alertLocator : assistantLocator,
    waitForTimeout: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    url: options.url ?? (() => CONVERSATION_URL),
    goto: async () => {},
    context: () => ({}),
  } as unknown as Page;

  let outcome: RunResult["outcome"] = "resolved";
  let failure: unknown;
  try {
    await waitTurnComplete(page, options.timeoutMs, 0, 100, options.control ?? {});
  } catch (error) {
    if (error instanceof TurnTimeoutError) outcome = "timeout";
    else {
      outcome = "error";
      failure = error;
    }
  }
  const completedAt = Date.now();
  const result: RunResult = { outcome, completedAt, bubbleSeenAt, lines, error: failure };
  spy.mockRestore();
  vi.useRealTimers();
  // An unexpected throw must never read as a pass; only the tests that ask to
  // inspect one opt out.
  if (failure && !options.captureFailure) throw failure;
  return result;
}

describe("waitTurnComplete turn heartbeat", () => {
  it("emits one content-free heartbeat at 60 s and then completes exactly as today", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => (Date.now() >= 90_000 ? 1 : 0),
      url: () => CONVERSATION_URL,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toEqual([HEALTHY_LINE]);
    // The single line arrives while the bubble is still absent, and it never
    // leaks the conversation id, the URL or any page text.
    expect(result.bubbleSeenAt).toBe(90_000);
    expect(result.lines[0]).not.toContain(CONVERSATION_ID);
    expect(result.lines[0]).not.toContain("chatgpt.com");
    expect(result.lines[0]).not.toContain(BUBBLE_TEXT);
    // Completion still happens on the pre-existing stability path (bubble seen
    // at 90 s, text stable for 100 ms after the 400 ms poll).
    expect(result.completedAt).toBe(90_400);
  });

  it("reports a limit alert and still times out as today", async () => {
    const result = await runTurn({
      timeoutMs: 62_000,
      assistantCount: () => 0,
      alerts: [{ visible: true, text: LIMIT_ALERT_TEXT }],
      url: () => CONVERSATION_URL,
      control: { conversationId: () => "conv-1" },
    });

    expect(result.outcome).toBe("timeout");
    expect(result.lines).toEqual([
      "[cgpro:turn] t=60 assistant=0/0 working=no stop=no bubble_len=0 " +
        "conv=yes composer=no alerts=1 error_hint=no limit_hint=yes limit_exact=yes",
    ]);
    expect(result.lines[0]).not.toContain(LIMIT_ALERT_TEXT);
  });

  it("emits at most one line per 60 s of the loop", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      url: () => CONVERSATION_URL,
      control: { cancelled: () => Date.now() >= 130_000 },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toEqual([
      HEALTHY_LINE,
      HEALTHY_LINE.replace("t=60", "t=120"),
    ]);
  });

  it("swallows its own evaluation errors so the turn result is unchanged", async () => {
    const healthy = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => (Date.now() >= 90_000 ? 1 : 0),
      url: () => CONVERSATION_URL,
    });
    const broken = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => (Date.now() >= 90_000 ? 1 : 0),
      url: () => {
        throw new Error("evaluation failed");
      },
    });

    // The broken page cannot answer `page.url()`, so the whole heartbeat read
    // throws; the line is dropped and the turn completes identically.
    expect(broken.lines).toEqual([]);
    expect(healthy.lines).toEqual([HEALTHY_LINE]);
    expect(broken.outcome).toBe("resolved");
    expect(broken.bubbleSeenAt).toBe(healthy.bubbleSeenAt);
    expect(broken.completedAt).toBe(healthy.completedAt);
  });
});

/**
 * P-035 G3 r37. The Pro usage limit revealed only AFTER submission. The waiter
 * stops with a typed error once two consecutive heartbeats see the limit while
 * no assistant turn exists, instead of holding the full timeout; every other
 * stall keeps today's behaviour.
 */
describe("waitTurnComplete post-submit Pro usage limit", () => {
  const LIMIT_WITH_DATE = "You've reached your limit. Try again after Sep 30, 2026.";
  // `error_hint` follows the pre-existing loose regex, which "try again" trips;
  // `limit_exact` is G3's own, narrower match.
  const limitLine = (seconds: number, errorHint: "yes" | "no"): string =>
    `[cgpro:turn] t=${seconds} assistant=0/0 working=no stop=no bubble_len=0 ` +
    `conv=yes composer=no alerts=1 error_hint=${errorHint} limit_hint=yes limit_exact=yes`;
  const LIMIT_LINE_AT_60 = limitLine(60, "yes");
  const LIMIT_LINE_AT_120 = limitLine(120, "yes");

  it("stops on the second limit heartbeat with the parsed reset date", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      alerts: [{ visible: true, text: LIMIT_WITH_DATE }],
      captureFailure: true,
    });

    expect(result.outcome).toBe("error");
    expect(result.error).toBeInstanceOf(ProUsageLimitAfterSubmitError);
    const error = result.error as ProUsageLimitAfterSubmitError;
    expect(error.code).toBe("pro_usage_limit_after_submit");
    // The prompt WAS submitted; this is not a pre-submit refusal.
    expect(error.promptSubmitted).toBe(true);
    expect(error.availableAfter).toMatch(/^2026-09-30T00:00:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(error.availableAfter!)).toBe(new Date(2026, 8, 30, 0, 0, 0, 0).getTime());
    expect(error.limitText).toBe(LIMIT_WITH_DATE);
    // Two observations were needed, and it stopped there rather than at the
    // configured 20-minute deadline.
    expect(result.lines).toEqual([LIMIT_LINE_AT_60, LIMIT_LINE_AT_120]);
    expect(result.completedAt).toBe(120_000);
  });

  it("keeps waiting when the limit alert is observed only once", async () => {
    const result = await runTurn({
      timeoutMs: 62_000,
      assistantCount: () => 0,
      alerts: [{ visible: true, text: LIMIT_WITH_DATE }],
      url: () => CONVERSATION_URL,
      control: { conversationId: () => "conv-1" },
    });

    expect(result.outcome).toBe("timeout");
    expect(result.lines).toEqual([LIMIT_LINE_AT_60]);
  });

  it("keeps waiting on a usage percentage alone", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      alerts: [{ visible: true, text: "4% usage remaining" }],
      control: { cancelled: () => Date.now() >= 130_000 },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toEqual([
      "[cgpro:turn] t=60 assistant=0/0 working=no stop=no bubble_len=0 " +
        "conv=yes composer=no alerts=1 error_hint=no limit_hint=yes limit_exact=no",
      "[cgpro:turn] t=120 assistant=0/0 working=no stop=no bubble_len=0 " +
        "conv=yes composer=no alerts=1 error_hint=no limit_hint=yes limit_exact=no",
    ]);
  });

  it("never triggers while an assistant turn is present", async () => {
    // A bubble exists but never stabilises, so the turn is still in flight
    // across both heartbeats while the limit alert sits on the page.
    let tick = 0;
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 1,
      bubbleText: () => `streaming ${tick++}`,
      alerts: [{ visible: true, text: LIMIT_WITH_DATE }],
      control: { cancelled: () => Date.now() >= 130_000 },
    });

    expect(result.outcome).toBe("resolved");
    // The bubble text keeps changing, so its length is not pinned here; what
    // matters is that a turn exists at both heartbeats and nothing was thrown.
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toContain("t=60 assistant=1/0");
    expect(result.lines[0]).toContain("limit_hint=yes limit_exact=yes");
    expect(result.lines[1]).toContain("t=120 assistant=1/0");
    expect(result.lines[1]).toContain("limit_hint=yes limit_exact=yes");
  });

  it("never triggers while the turn is working", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      stopVisible: true,
      alerts: [{ visible: true, text: LIMIT_WITH_DATE }],
      control: { cancelled: () => Date.now() >= 130_000 },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toEqual([
      "[cgpro:turn] t=60 assistant=0/0 working=yes stop=yes bubble_len=0 " +
        "conv=yes composer=no alerts=1 error_hint=yes limit_hint=yes limit_exact=yes",
      "[cgpro:turn] t=120 assistant=0/0 working=yes stop=yes bubble_len=0 " +
        "conv=yes composer=no alerts=1 error_hint=yes limit_hint=yes limit_exact=yes",
    ]);
  });

  it("throws with a null reset date when the limit alert names none", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      alerts: [{ visible: true, text: "Limit reached" }],
      captureFailure: true,
    });

    expect(result.outcome).toBe("error");
    const error = result.error as ProUsageLimitAfterSubmitError;
    expect(error.code).toBe("pro_usage_limit_after_submit");
    expect(error.availableAfter).toBeNull();
    expect(error.limitText).toBe("Limit reached");
  });

  it("caps the alert text it carries, parses the date before capping, and never prints the text", async () => {
    // The reset date sits past the 200-character cap, so the carried text is
    // padding while the parsed date still comes from what the page said.
    const long = `${"x".repeat(250)} Try again after Sep 30, 2026.`;
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      alerts: [{ visible: true, text: long }],
      captureFailure: true,
    });

    const error = result.error as ProUsageLimitAfterSubmitError;
    expect(error.limitText).toBe("x".repeat(200));
    expect(Date.parse(error.availableAfter!)).toBe(new Date(2026, 8, 30, 0, 0, 0, 0).getTime());
    for (const line of result.lines) expect(line).not.toContain("x".repeat(20));
  });
});
