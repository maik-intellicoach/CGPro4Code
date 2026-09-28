import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "patchright";
import { ProUsageLimitAfterSubmitError, ReplyStalledError, SubmittedTurnNotRenderedError, TurnTimeoutError } from "../src/errors.js";
import { SELECTORS } from "../src/browser/selectors.js";
import { ensureInterceptorInstalled, setActiveEmitter, StreamEmitter } from "../src/core/stream.js";

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
  "[cgpro:turn] t=60 assistant=0/0 msgs=0/- working=no stop=no bubble_len=0 " +
  "conv=yes composer=no alerts=0 alert_shapes=- error_hint=no limit_hint=no limit_exact=no " +
  "stall=0/10";

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
  stopVisible?: boolean | (() => boolean);
  /** Capture a non-timeout throw instead of rethrowing it, for assertions. */
  captureFailure?: boolean;
  /** Run against the freshly built page before the wait starts. */
  onPage?: (page: Page) => Promise<void>;
  /** `SELECTORS.anyMessages` count per read; defaults to `assistantCount`. */
  anyMessages?: () => number;
  /** Pre-submit anyMessages count; omitted means unknown (rule 2 disabled). */
  priorAnyMessages?: number | null;
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
  firstResolved.mockImplementation(async (_page: unknown, selector: unknown) => {
    const working = typeof options.stopVisible === "function" ? options.stopVisible() : options.stopVisible;
    return working && String(selector).includes("stop-button") ? {} : null;
  });

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
  const anyMessagesLocator = {
    count: async (): Promise<number> => options.anyMessages?.() ?? options.assistantCount(),
  };
  const page = {
    locator: (selector: string) =>
      selector === SELECTORS.anyMessages.join(", ")
        ? anyMessagesLocator
        : selector.includes('role="alert"')
          ? alertLocator
          : assistantLocator,
    waitForTimeout: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    url: options.url ?? (() => CONVERSATION_URL),
    goto: async () => {},
    context: () => ({}),
  } as unknown as Page;

  await options.onPage?.(page);

  let outcome: RunResult["outcome"] = "resolved";
  let failure: unknown;
  try {
    await waitTurnComplete(
      page, options.timeoutMs, 0, 100, options.control ?? {}, options.priorAnyMessages ?? null,
    );
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
      "[cgpro:turn] t=60 assistant=0/0 msgs=0/- working=no stop=no bubble_len=0 " +
        "conv=yes composer=no alerts=1 alert_shapes=len:25:limit+reached " +
        "error_hint=no limit_hint=yes limit_exact=yes stall=0/10",
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
    `[cgpro:turn] t=${seconds} assistant=0/0 msgs=0/- working=no stop=no bubble_len=0 ` +
    `conv=yes composer=no alerts=1 alert_shapes=len:56:limit+reached+try-again ` +
    `error_hint=${errorHint} limit_hint=yes limit_exact=yes stall=0/10`;
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
      "[cgpro:turn] t=60 assistant=0/0 msgs=0/- working=no stop=no bubble_len=0 " +
        "conv=yes composer=no alerts=1 alert_shapes=len:18:usage+remaining " +
        "error_hint=no limit_hint=yes limit_exact=no stall=0/10",
      "[cgpro:turn] t=120 assistant=0/0 msgs=0/- working=no stop=no bubble_len=0 " +
        "conv=yes composer=no alerts=1 alert_shapes=len:18:usage+remaining " +
        "error_hint=no limit_hint=yes limit_exact=no stall=0/10",
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
      "[cgpro:turn] t=60 assistant=0/0 msgs=0/- working=yes stop=yes bubble_len=0 " +
        "conv=yes composer=no alerts=1 alert_shapes=len:56:limit+reached+try-again " +
        "error_hint=yes limit_hint=yes limit_exact=yes stall=0/10",
      "[cgpro:turn] t=120 assistant=0/0 msgs=0/- working=yes stop=yes bubble_len=0 " +
        "conv=yes composer=no alerts=1 alert_shapes=len:56:limit+reached+try-again " +
        "error_hint=yes limit_hint=yes limit_exact=yes stall=0/10",
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

/**
 * P-035 G3 r38. The submitted turn that never rendered anything -- the user's
 * own message included (live ms1980 80f0899c: `anyMessages` and
 * `assistantMessages` were both "not on this surface"). Three consecutive
 * heartbeats with no assistant turn and no growth in the anyMessages count end
 * the wait with a typed error so the daemon's failure capture runs instead of a
 * silent timeout. An unknown pre-submit count disables the rule; a proven r37
 * limit still wins.
 */
describe("waitTurnComplete submitted turn never rendered", () => {
  const notRenderedLine = (seconds: number, msgs: string): string =>
    `[cgpro:turn] t=${seconds} assistant=0/0 msgs=${msgs} working=no stop=no bubble_len=0 ` +
    "conv=yes composer=no alerts=0 alert_shapes=- error_hint=no limit_hint=no limit_exact=no " +
    "stall=0/10";

  it("stops on the third not-rendered heartbeat with a content-free error", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      priorAnyMessages: 0,
      captureFailure: true,
    });

    expect(result.outcome).toBe("error");
    expect(result.error).toBeInstanceOf(SubmittedTurnNotRenderedError);
    const error = result.error as SubmittedTurnNotRenderedError;
    expect(error.code).toBe("submitted_turn_not_rendered");
    // The prompt WAS submitted; this is not a pre-submit refusal.
    expect(error.promptSubmitted).toBe(true);
    expect(error.elapsedSeconds).toBe(180);
    expect(error.msgs).toBe(0);
    expect(error.priorMsgs).toBe(0);
    expect(error.alertCount).toBe(0);
    expect(error.alertShapes).toBe("");
    // Three observations were needed, and it stopped there rather than at the
    // configured 20-minute deadline.
    expect(result.lines).toEqual([
      notRenderedLine(60, "0/0"),
      notRenderedLine(120, "0/0"),
      notRenderedLine(180, "0/0"),
    ]);
    expect(result.completedAt).toBe(180_000);
  });

  it("keeps waiting after only two not-rendered observations", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      priorAnyMessages: 0,
      control: { cancelled: () => Date.now() >= 130_000 },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toEqual([notRenderedLine(60, "0/0"), notRenderedLine(120, "0/0")]);
  });

  it("resets the streak when the user's own message renders", async () => {
    // msgs grows only at the 120 s observation, so the streak restarts there
    // and the third observation is the first one after it.
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      anyMessages: () => (Date.now() >= 120_000 && Date.now() < 180_000 ? 1 : 0),
      priorAnyMessages: 0,
      control: { cancelled: () => Date.now() >= 200_000 },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toEqual([
      notRenderedLine(60, "0/0"),
      notRenderedLine(120, "1/0"),
      notRenderedLine(180, "0/0"),
    ]);
  });

  it("never triggers while the turn is working", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      priorAnyMessages: 0,
      stopVisible: true,
      control: { cancelled: () => Date.now() >= 200_000 },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toHaveLength(3);
    for (const line of result.lines) expect(line).toContain("working=yes");
  });

  it("never triggers when the pre-submit anyMessages count is unknown", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      // No priorAnyMessages: unknown, so the rule stays off entirely.
      control: { cancelled: () => Date.now() >= 200_000 },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toHaveLength(3);
    for (const line of result.lines) expect(line).toContain("msgs=0/-");
  });

  it("throws the r37 limit error instead when the limit also holds", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      alerts: [{ visible: true, text: "You've reached your limit" }],
      priorAnyMessages: 0,
      captureFailure: true,
    });

    expect(result.outcome).toBe("error");
    expect(result.error).toBeInstanceOf(ProUsageLimitAfterSubmitError);
    expect(result.error).not.toBeInstanceOf(SubmittedTurnNotRenderedError);
    // The limit needs two observations, the not-rendered rule three, so the
    // limit's throw is what the caller sees.
    expect(result.lines).toHaveLength(2);
    expect(result.completedAt).toBe(120_000);
  });

  it("describes each visible alert without its text and reports msgs counts", async () => {
    const alertText = "4% usage remaining";
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      alerts: [{ visible: true, text: alertText }],
      priorAnyMessages: 0,
      control: { cancelled: () => Date.now() >= 70_000 },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("msgs=0/0");
    expect(result.lines[0]).toContain("alert_shapes=len:18:usage+remaining");
    expect(result.lines[0]).not.toContain(alertText);
    expect(result.lines[0]).not.toContain("usage remaining");
  });
});

/** Drive a real in-page reader break on `page`, the way the SSE binding does. */
async function driveStreamBreak(page: Page): Promise<void> {
  const bindings: Record<string, (src: { page?: Page }, ...args: unknown[]) => void> = {};
  const context = {
    exposeBinding: async (name: string, callback: (typeof bindings)[string]) => {
      bindings[name] = callback;
    },
    addInitScript: async () => {},
  } as unknown as BrowserContext;
  await ensureInterceptorInstalled(context);
  setActiveEmitter(page, new StreamEmitter());
  bindings["__cgproStart"]({ page }, "obs-1");
  bindings["__cgproDone"]({ page }, "obs-1", { reason: "error" });
}

/**
 * P-035 G3 r43. The frozen reply. r41 restored the rule that an in-page reader
 * break does not end the turn, because ChatGPT keeps producing the answer while
 * the page stays; a reply that really never arrives has to be bounded instead.
 * Ten consecutive heartbeats of (an assistant turn for this submission, not
 * working, one unchanged trimmed length) end the wait with a typed error, and
 * any working turn, length change or failed read restarts the streak. The r37
 * limit and the r38 never-rendered turn keep their exits.
 */
describe("waitTurnComplete stalled reply", () => {
  /** A frozen reply needs the completion path to stay open, or it would return. */
  const frozenControl = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    confirmComplete: async () => false,
    ...extra,
  });
  const stalledLine = (seconds: number, streak: number, bubbleLength = 12): string =>
    `[cgpro:turn] t=${seconds} assistant=1/0 msgs=1/- working=no stop=no ` +
    `bubble_len=${bubbleLength} conv=yes composer=no alerts=0 alert_shapes=- ` +
    `error_hint=no limit_hint=no limit_exact=no stall=${streak}/10`;
  /** The `stall=N/10` streak printed on the line for a given elapsed second. */
  const streakAt = (lines: string[], seconds: number): string | undefined =>
    lines.find((line) => line.includes(`t=${seconds} `))?.match(/stall=(\d+)\/10/)?.[1];

  it("stops on the tenth frozen heartbeat with a content-free error", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 1,
      bubbleText: () => "Frozen reply",
      control: frozenControl(),
      captureFailure: true,
    });

    expect(result.outcome).toBe("error");
    expect(result.error).toBeInstanceOf(ReplyStalledError);
    const error = result.error as ReplyStalledError;
    expect(error.code).toBe("reply_stalled");
    // The prompt WAS submitted; this is not a pre-submit refusal.
    expect(error.promptSubmitted).toBe(true);
    expect(error.elapsedSeconds).toBe(600);
    expect(error.bubbleLength).toBe("Frozen reply".length);
    expect(error.streamBreaks).toBe(0);
    expect(error.alertShapes).toBe("");
    // Ten observations were needed, and it stopped there rather than at the
    // configured 20-minute deadline. The streak is on every line.
    expect(result.lines).toEqual(
      Array.from({ length: 10 }, (_, i) => stalledLine((i + 1) * 60, i + 1)),
    );
    expect(result.completedAt).toBe(600_100);
    for (const line of result.lines) expect(line).not.toContain("Frozen reply");
  });

  it("keeps waiting after only nine frozen heartbeats", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 1,
      bubbleText: () => "Frozen reply",
      control: frozenControl({ cancelled: () => Date.now() >= 560_000 }),
    });

    expect(result.outcome).toBe("resolved");
    expect(result.lines).toHaveLength(9);
    expect(result.lines[8]).toContain("stall=9/10");
    expect(result.completedAt).toBeLessThan(600_000);
  });

  it("restarts the streak when an observation shows the turn working", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 1,
      bubbleText: () => "Frozen reply",
      // Working for the 300 s observation only: the streak restarts there.
      stopVisible: () => Date.now() >= 300_000 && Date.now() < 360_000,
      control: frozenControl({ cancelled: () => Date.now() >= 780_000 }),
    });

    expect(result.outcome).toBe("resolved");
    expect(streakAt(result.lines, 240)).toBe("4");
    expect(streakAt(result.lines, 300)).toBe("0");
    expect(result.lines.find((line) => line.includes("t=300 "))).toContain("working=yes");
    expect(streakAt(result.lines, 360)).toBe("1");
    expect(result.lines.find((line) => line.includes("t=360 "))).toContain("working=no");
    // Still short of ten when the wait was cancelled, and no error was thrown.
    expect(streakAt(result.lines, 720)).toBe("7");
    expect(result.lines.at(-1)).toContain("t=720 ");
  });

  it("restarts the streak when the bubble's trimmed length changes", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 1,
      // One character longer from the 360 s observation on.
      bubbleText: () => (Date.now() >= 360_000 ? "Frozen reply!" : "Frozen reply"),
      control: frozenControl({ cancelled: () => Date.now() >= 720_000 }),
    });

    expect(result.outcome).toBe("resolved");
    expect(streakAt(result.lines, 300)).toBe("5");
    expect(result.lines.find((line) => line.includes("t=300 "))).toContain("bubble_len=12");
    // The longer text starts a fresh streak rather than extending the old one.
    expect(streakAt(result.lines, 360)).toBe("1");
    expect(result.lines.find((line) => line.includes("t=360 "))).toContain("bubble_len=13");
    expect(streakAt(result.lines, 660)).toBe("6");
    expect(result.lines.at(-1)).toContain("t=660 ");
  });

  it("lets a completion before the tenth observation return normally", async () => {
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 1,
      bubbleText: () => "Frozen reply",
      // The backend confirms the reply at 300 s, so the loop returns from the
      // completion path long before the stall rule could fire.
      control: { confirmComplete: async () => Date.now() >= 300_000 },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.error).toBeUndefined();
    expect(result.lines).toHaveLength(5);
    expect(result.completedAt).toBeGreaterThanOrEqual(300_000);
    expect(result.completedAt).toBeLessThan(600_000);
  });

  it("keeps the r37 limit and the r38 never-rendered exits ahead of it", async () => {
    // The three rules can never agree on one observation -- r37 and r38 both
    // need NO assistant turn for this submission (count <= prior) and the stall
    // rule needs one -- so what the ordering has to preserve is that each keeps
    // its own typed error while the stall rule is live in the same waiter.
    const limit = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      alerts: [{ visible: true, text: "You've reached your limit" }],
      priorAnyMessages: 0,
      captureFailure: true,
    });
    const notRendered = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 0,
      priorAnyMessages: 0,
      captureFailure: true,
    });

    expect(limit.error).toBeInstanceOf(ProUsageLimitAfterSubmitError);
    expect(limit.error).not.toBeInstanceOf(ReplyStalledError);
    expect(notRendered.error).toBeInstanceOf(SubmittedTurnNotRenderedError);
    expect(notRendered.error).not.toBeInstanceOf(ReplyStalledError);
    // Both still stopped on their own rule rather than the stalled-reply one.
    expect(limit.lines).toHaveLength(2);
    expect(notRendered.lines).toHaveLength(3);
  });

  it("carries the in-page stream-break count of the turn", async () => {
    // The r41 restore is why this exit exists at all, so the freeze after a
    // reader break has to be distinguishable from a freeze that never lost it.
    const result = await runTurn({
      timeoutMs: 1_200_000,
      assistantCount: () => 1,
      bubbleText: () => "Frozen reply",
      control: frozenControl(),
      captureFailure: true,
      onPage: driveStreamBreak,
    });

    expect(result.error).toBeInstanceOf(ReplyStalledError);
    expect((result.error as ReplyStalledError).streamBreaks).toBe(1);
  });
});
