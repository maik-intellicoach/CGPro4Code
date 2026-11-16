import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { StatusResponse } from "../src/daemon/protocol.js";

// P-035 2026-11-16. A bare `cgpro status` launched a cold bundled browser on
// the default profile while a registered daemon held the account, and so
// reported a launch failure instead of the daemon's real health. These cases
// pin the route: no --profile + registered daemon reads the daemon over HTTP
// and never opens a page; an explicit --profile keeps the cold-start route.

const openSession = vi.fn();
const spinner = { start: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
spinner.start.mockReturnValue(spinner);

vi.mock("ora", () => ({ default: () => spinner }));
vi.mock("../src/browser/session.js", () => ({ openSession: (...args: unknown[]) => openSession(...args) }));
vi.mock("../src/browser/chatgpt.js", () => ({
  fetchAuthSession: vi.fn(),
  goHome: vi.fn(),
  isLoggedIn: vi.fn(),
}));
vi.mock("../src/api/me.js", () => ({ detectPlan: vi.fn(), fetchMe: vi.fn() }));
vi.mock("../src/api/models.js", () => ({ fetchModels: vi.fn(), findProSlug: vi.fn() }));

// Synthetic sentinel only; never a real credential.
const SENTINEL_TOKEN = "SENTINEL-status-route-token-not-a-secret";
const COLD_LAUNCH = new Error("cold launch attempted (test sentinel)");

let server: Server | null = null;
let dir: string | null = null;
let priorDaemonJson: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  spinner.start.mockReturnValue(spinner);
  openSession.mockRejectedValue(COLD_LAUNCH);
  priorDaemonJson = process.env.CGPRO_DAEMON_JSON;
  dir = mkdtempSync(join(tmpdir(), "cgpro-status-route-"));
  process.env.CGPRO_DAEMON_JSON = join(dir, "daemon.json");
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("node:fs");
  if (priorDaemonJson === undefined) delete process.env.CGPRO_DAEMON_JSON;
  else process.env.CGPRO_DAEMON_JSON = priorDaemonJson;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (dir) {
    // This test owns exactly one mkdtemp dir holding at most its synthetic
    // daemon.json: remove that file, then the empty dir, never recursively.
    const owned = dir;
    dir = null;
    try {
      unlinkSync(join(owned, "daemon.json"));
    } catch (e) {
      if ((e as { code?: unknown }).code !== "ENOENT") throw e;
    }
    rmdirSync(owned);
  }
});

function baseStatus(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    pid: process.pid,
    startedAt: "2026-11-16T00:00:00.000Z",
    uptimeSec: 60,
    background: true,
    browserConnected: true,
    profile: "/profiles/lane",
    busy: false,
    account: { email: "lane@example.test", plan: "pro", proModelAvailable: true },
    interaction: { state: "ready" },
    slots: { total: 3, busy: 0, free: 3, items: [] },
    ...overrides,
  };
}

/** A daemon that passes /healthz and answers /status with `body` (null = 500). */
async function liveDaemon(body: StatusResponse | null): Promise<number> {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ daemon: "cgpro", version: 1, queueDepth: 0 }));
      return;
    }
    if (req.method === "GET" && req.url === "/status" && body) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function register(port: number, profile: string | undefined = "/profiles/lane"): void {
  writeFileSync(
    process.env.CGPRO_DAEMON_JSON!,
    JSON.stringify({
      version: 1,
      pid: process.pid, // genuinely alive, per pidIsAlive()
      port,
      token: SENTINEL_TOKEN,
      startedAt: "2026-11-16T00:00:00.000Z",
      profile,
      background: true,
    }),
  );
}

async function run(opts: { profile?: string } = {}): Promise<{ code: number | Error; out: string; err: string }> {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { statusCommand } = await import("../src/cli/commands/status.js");
    const code = await statusCommand(opts).catch((e: Error) => e);
    return { code, out: logs.mock.calls.flat().join("\n"), err: errors.mock.calls.flat().join("\n") };
  } finally {
    logs.mockRestore();
    errors.mockRestore();
  }
}

describe("cgpro status routes through a registered daemon (P-035 2026-11-16)", () => {
  it("reports a healthy daemon session without opening a browser", async () => {
    register(await liveDaemon(baseStatus()));
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(openSession).not.toHaveBeenCalled();
    expect(out).toContain("lane@example.test");
    expect(out).toContain("connected");
    expect(out).toContain("3 free of 3");
    expect(out).toContain("Session healthy.");
    expect(out).not.toContain(SENTINEL_TOKEN);
  });

  it("reports a disconnected browser as unhealthy, never as healthy", async () => {
    register(await liveDaemon(baseStatus({ browserConnected: false })));
    const { code, out, err } = await run();
    expect(code).toBe(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(out).toContain("disconnected");
    expect(out).not.toContain("Session healthy.");
    expect(err).toContain("browser disconnected");
  });

  it("fails closed when the account was never captured", async () => {
    register(await liveDaemon(baseStatus({ account: undefined })));
    const { code, out, err } = await run();
    expect(code).toBe(1);
    expect(out).not.toContain("Session healthy.");
    expect(err).toContain("account not captured");
  });

  it("reports an unknown browser state as unhealthy", async () => {
    register(await liveDaemon(baseStatus({ browserConnected: undefined })));
    const { code, out, err } = await run();
    expect(code).toBe(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(out).toContain("unknown");
    expect(out).not.toContain("Session healthy.");
    expect(err).toContain("browser state unknown");
  });

  it("reports a degraded interaction as unhealthy", async () => {
    register(await liveDaemon(baseStatus({ interaction: { state: "degraded" } })));
    const { code, out, err } = await run();
    expect(code).toBe(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(out).toContain("degraded");
    expect(out).not.toContain("Session healthy.");
    expect(err).toContain("interaction degraded");
  });

  it("fails closed, without launching a browser, when the registry exists but is malformed", async () => {
    writeFileSync(process.env.CGPRO_DAEMON_JSON!, "{ not json (synthetic test fixture)");
    const { code, out, err } = await run();
    expect(code).toBe(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(out).not.toContain("Session healthy.");
    expect(err).toContain("did not launch a browser");
    expect(err).not.toContain("synthetic test fixture");
  });

  it("fails closed, without launching a browser, when the registry cannot be checked", async () => {
    // Controlled mock instead of chmod (unreliable as root): stat of the
    // registry path fails with EACCES, so absence is unknown, not proven.
    const registry = process.env.CGPRO_DAEMON_JSON!;
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const statSync = ((path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
        if (String(path) === registry) {
          throw Object.assign(new Error("EACCES: permission denied (test sentinel)"), { code: "EACCES" });
        }
        return (actual.statSync as (...args: unknown[]) => unknown)(path, ...rest);
      }) as typeof actual.statSync;
      return { ...actual, statSync, default: { ...actual, statSync } };
    });
    const { code, err } = await run();
    expect(code).toBe(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(err).toContain("EACCES");
    expect(err).toContain("did not launch a browser");
  });

  it("fails closed when the daemon passes health but /status does not answer", async () => {
    register(await liveDaemon(null));
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(out).not.toContain("Session healthy.");
  });

  it("fails clearly, without launching a browser, when the registered daemon is unresponsive", async () => {
    const port = await liveDaemon(baseStatus());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    register(port);
    const { code, err } = await run();
    expect(code).toBe(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(err).toContain("not responding");
    expect(err).not.toContain(SENTINEL_TOKEN);
  });

  it("keeps the cold-start route when no daemon is registered", async () => {
    const { code } = await run();
    expect(code).toBe(COLD_LAUNCH);
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the cold-start route for an explicit alternate --profile", async () => {
    register(await liveDaemon(baseStatus()));
    const { code } = await run({ profile: "/profiles/other" });
    expect(code).toBe(COLD_LAUNCH);
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ profilePath: "/profiles/other" }));
  });

  it("still refuses an explicit --profile the live daemon owns", async () => {
    register(await liveDaemon(baseStatus()), "/profiles/lane");
    const { code } = await run({ profile: "/profiles/lane" });
    expect(code).toBeInstanceOf(Error);
    expect((code as Error).message).toMatch(/cannot run while the daemon owns the profile/);
    expect(openSession).not.toHaveBeenCalled();
  });
});
