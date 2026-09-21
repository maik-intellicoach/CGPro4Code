import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Page } from "patchright";

// P-035 2026-09-21. The Pro entitlement gates routing to a paid lane and used to
// be read once, at daemon start. The refresh has two directions and they must be
// told apart:
//
//   - a read that PROVED itself (authenticated identity + a catalogue that came
//     back) is a fact, so a catalogue without a Pro slug is a real revocation
//     and must be believed;
//   - a read that failed looks identical (proModelAvailable: false) and is NOT a
//     fact, so it must leave the previous answer alone.
//
// Collapsing the two is the defect this file exists to prevent: believing a
// failed read takes a working paid lane out of routing, and disbelieving a real
// revocation keeps sending paid work to an account that lost the entitlement.
// This file mocks the three readers the refresh depends on, so both directions
// are exercised against a real `/status` request rather than a unit stub.

const fetchMe = vi.fn();
const fetchModels = vi.fn();
const fetchAuthSessionInPage = vi.fn();

vi.mock("../src/api/me.js", () => ({
  fetchMe: (...args: unknown[]) => fetchMe(...args),
  // Left as "unknown" so the plan label is derived from the capability fact,
  // which is the behaviour under test.
  detectPlan: () => "unknown",
}));

vi.mock("../src/api/models.js", async () => {
  const actual = await vi.importActual<typeof import("../src/api/models.js")>("../src/api/models.js");
  return { ...actual, fetchModels: (...args: unknown[]) => fetchModels(...args) };
});

vi.mock("../src/browser/chatgpt.js", async () => {
  const actual = await vi.importActual<typeof import("../src/browser/chatgpt.js")>(
    "../src/browser/chatgpt.js",
  );
  return { ...actual, fetchAuthSessionInPage: (...args: unknown[]) => fetchAuthSessionInPage(...args) };
});

const { handleRequest, createServerState } = await import("../src/daemon/server.js");

class FakeReq extends EventEmitter {
  headers: Record<string, string> = {};
  setEncoding = vi.fn();
}

class FakeRes extends EventEmitter {
  headersSent = false;
  statusCode = 0;
  body = "";
  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }
  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

/** A stale-but-idle lane, so `/status` is allowed to re-read. */
function staleIdleLane() {
  const page = { isClosed: () => false, url: () => "https://chatgpt.com/" } as unknown as Page;
  const state = createServerState(
    { page } as never,
    { token: "test-token" },
    { email: "account@example.test", plan: "pro", proModelAvailable: true },
  );
  state.token = "test-token";
  state.accountProbedAt = Date.now() - 60 * 60_000;
  return state;
}

async function getStatus(state: ReturnType<typeof staleIdleLane>) {
  const req = new FakeReq() as unknown as IncomingMessage;
  const res = new FakeRes() as unknown as ServerResponse;
  Object.assign(req, { method: "GET", url: "/status", headers: { authorization: "Bearer test-token" } });
  await handleRequest(req, res, state);
  return res as unknown as FakeRes;
}

beforeEach(() => {
  fetchMe.mockReset();
  fetchModels.mockReset();
  fetchAuthSessionInPage.mockReset();
});

describe("account capability refresh", () => {
  it("believes a revocation that a proved read reported", async () => {
    fetchAuthSessionInPage.mockResolvedValue({ user: { email: "account@example.test" } });
    fetchMe.mockResolvedValue({ email: "account@example.test" });
    // A catalogue that came back and holds no Pro slug: the entitlement is gone.
    fetchModels.mockResolvedValue([{ slug: "gpt-5" }]);

    const state = staleIdleLane();
    const res = await getStatus(state);

    expect(res.statusCode).toBe(200);
    expect(state.account?.proModelAvailable).toBe(false);
    expect(JSON.parse(res.body).account.proModelAvailable).toBe(false);
  });

  it("refuses to believe a read that could not prove itself", async () => {
    // No authenticated identity and no catalogue. This is what a transient
    // failure looks like, and it must not become a fact about the account.
    fetchAuthSessionInPage.mockResolvedValue(null);
    fetchMe.mockResolvedValue(null);
    fetchModels.mockResolvedValue([]);

    const state = staleIdleLane();
    const res = await getStatus(state);

    expect(res.statusCode).toBe(200);
    expect(state.account?.proModelAvailable).toBe(true);
    expect(JSON.parse(res.body).account.proModelAvailable).toBe(true);
  });

  it("does not re-read while a turn is in flight", async () => {
    fetchAuthSessionInPage.mockResolvedValue({ user: { email: "account@example.test" } });
    fetchMe.mockResolvedValue({ email: "account@example.test" });
    fetchModels.mockResolvedValue([{ slug: "gpt-5" }]);

    const state = staleIdleLane();
    state.askInFlight = true;
    await getStatus(state);

    expect(fetchModels).not.toHaveBeenCalled();
    expect(state.account?.proModelAvailable).toBe(true);
  });

  it("does not re-read a lane whose probe clock is not recorded", async () => {
    const state = staleIdleLane();
    state.accountProbedAt = undefined;
    await getStatus(state);

    expect(fetchModels).not.toHaveBeenCalled();
  });
});
