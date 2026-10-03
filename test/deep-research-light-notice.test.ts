import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Page } from "patchright";
import { SELECTORS } from "../src/browser/selectors.js";
import type { Session } from "../src/browser/session.js";

/**
 * P-035 2026-10-03 G4-A. A spent Deep Research quota still runs the turn, on
 * ChatGPT's lighter model, and says so in the reply. The turn must complete
 * with its answer, and the notice must land on this daemon's `/status` as
 * `deepResearch.exhaustedUntil` -- never as a Pro usage-limit failure.
 */

const firstResolved = vi.fn(async () => null);
const requireSelector = vi.fn();
vi.mock("../src/browser/chatgpt.js", () => ({
  firstResolved: (...args: unknown[]) => firstResolved(...(args as [])),
  requireSelector: (...args: unknown[]) => requireSelector(...args),
  goHome: vi.fn(),
  isLoggedIn: vi.fn(),
  fetchAuthSessionInPage: vi.fn(),
}));
vi.mock("../src/core/orchestrator.js", () => ({
  runAskOnSession: vi.fn(),
  runInteractionPreflight: vi.fn(),
}));

const { waitTurnComplete } = await import("../src/browser/conversation.js");
const { AskQueue, PreAdmissionReaderBudget, handleRequest } = await import("../src/daemon/server.js");
const { resetDeepResearchQuota } = await import("../src/browser/deep-research-quota.js");
import type { ServerState } from "../src/daemon/server.js";

const NOTICE =
  "Your remaining queries are powered by a lighter version of deep research. Your full access resets on April 17.";
const REPLY = `${NOTICE}\n\nHere is the report.`;

afterEach(() => {
  resetDeepResearchQuota();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function turnPage(): Page {
  const bubble = { getAttribute: async () => null, innerText: async () => REPLY };
  const assistant = {
    count: async () => (Date.now() >= 30_000 ? 1 : 0),
    nth: () => bubble,
    first: () => assistant,
  };
  const none = { count: async () => 0, nth: () => ({ isVisible: async () => false, innerText: async () => "" }) };
  return {
    locator: (selector: string) =>
      selector.includes('role="alert"') ? none
        : selector === SELECTORS.anyMessages.join(", ") ? assistant
          : assistant,
    waitForTimeout: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); },
    url: () => "https://chatgpt.com/c/6f2b0c1e-7a4d-4c8e-9b3f-1d5a7c9e2b40",
    goto: async () => {},
    context: () => ({}),
  } as unknown as Page;
}

class FakeReq extends EventEmitter {
  headers: Record<string, string> = {};
  setEncoding = vi.fn();
}

function statusOf(state: ServerState): Promise<Record<string, unknown>> {
  const req = new FakeReq() as unknown as IncomingMessage;
  Object.assign(req, { method: "GET", url: "/status", headers: { authorization: "Bearer test-token" } });
  const writes: string[] = [];
  const res = {
    headersSent: false,
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn((chunk?: string) => { if (chunk) writes.push(chunk); }),
  } as unknown as ServerResponse;
  return handleRequest(req, res, state).then(() => JSON.parse(writes.join("")) as Record<string, unknown>);
}

describe("the light-version notice on a Deep Research turn", () => {
  it("completes the turn and sets exhaustedUntil on /status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 10, 20));
    const startedAt = Date.now();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });

    // The native report arrives 130 s in; the heartbeat has read the reply at
    // 60 s and 120 s by then.
    await expect(waitTurnComplete(turnPage(), 1_200_000, 0, 100, {
      deepResearch: true,
      externalComplete: () => Date.now() - startedAt >= 130_000,
      confirmComplete: async () => true,
    })).resolves.toBeUndefined();

    // Two heartbeats saw the notice; it is recorded and logged once.
    const notices = lines.filter((line) => line.includes("light-version notice"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(
      /^\[cgpro:deep-research\] light-version notice: resets_at=2027-04-17T00:00:00[+-]\d{2}:\d{2}$/,
    );

    const status = await statusOf({
      session: { page: { isClosed: () => false, url: () => "https://chatgpt.com/" } } as unknown as Session,
      token: "test-token",
      startedAt: new Date(),
      background: true,
      queue: new AskQueue(8, 60_000),
      readerBudget: new PreAdmissionReaderBudget(8),
      askInFlight: false,
      currentInvocation: null,
      currentRunner: null,
      currentConversation: null,
      lastConversation: null,
      reloadConversation: null,
      interaction: { state: "unknown" },
    } as ServerState);
    expect(status.deepResearch).toMatchObject({
      exhaustedUntil: expect.stringMatching(/^2027-04-17T00:00:00[+-]\d{2}:\d{2}$/),
      exhaustedObservedAt: expect.any(String),
    });
  });

  it("is not read on an ordinary turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 10, 20));
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });

    const startedAt = Date.now();
    await expect(waitTurnComplete(turnPage(), 1_200_000, 0, 100, {
      externalComplete: () => Date.now() - startedAt >= 130_000,
    })).resolves.toBeUndefined();

    // The heartbeat did read the same reply, twice, and recorded nothing.
    expect(lines.filter((line) => line.startsWith("[cgpro:turn]"))).toHaveLength(2);
    expect(lines.some((line) => line.includes("light-version"))).toBe(false);
  });
});
