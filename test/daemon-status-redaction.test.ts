import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// P-035 2026-11-16. `cgpro daemon status --json` serialized the whole
// daemon.json registration, bearer token included, in both the live (`info`)
// and stale (`stale`) branches, so a diagnostic put it in a tool transcript.
// These cases pin that neither branch carries the token while the metadata
// health/ensure scripts read (running, pid, port, profile, status) stays.

// Synthetic sentinel only; never a real credential.
const SENTINEL_TOKEN = "SENTINEL-daemon-status-token-not-a-secret";
const PROFILE = "/profiles/lane";

let server: Server | null = null;
let dir: string | null = null;
let priorDaemonJson: string | undefined;

beforeEach(() => {
  priorDaemonJson = process.env.CGPRO_DAEMON_JSON;
  dir = mkdtempSync(join(tmpdir(), "cgpro-status-redaction-"));
  process.env.CGPRO_DAEMON_JSON = join(dir, "daemon.json");
  vi.resetModules();
});

afterEach(async () => {
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

async function liveDaemon(): Promise<number> {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ daemon: "cgpro", version: 1, queueDepth: 0 }));
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-11-16T00:00:00.000Z",
          uptimeSec: 60,
          background: true,
          browserConnected: true,
          profile: PROFILE,
          busy: false,
          slots: { total: 3, busy: 0, free: 3, items: [] },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function register(port: number): void {
  writeFileSync(
    process.env.CGPRO_DAEMON_JSON!,
    JSON.stringify({
      version: 1,
      pid: process.pid, // genuinely alive, per pidIsAlive()
      port,
      token: SENTINEL_TOKEN,
      startedAt: "2026-11-16T00:00:00.000Z",
      profile: PROFILE,
      background: true,
    }),
  );
}

async function statusJson(): Promise<{ code: number; raw: string; parsed: Record<string, unknown> }> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const { daemonStatusCmd } = await import("../src/cli/commands/daemon.js");
    const code = await daemonStatusCmd({ json: true });
    const raw = chunks.join("");
    return { code, raw, parsed: JSON.parse(raw) as Record<string, unknown> };
  } finally {
    write.mockRestore();
    logs.mockRestore();
  }
}

describe("daemon status --json never prints the daemon token (P-035 2026-11-16)", () => {
  it("live branch keeps running, pid, port, profile and status without the token", async () => {
    register(await liveDaemon());
    const { code, raw, parsed } = await statusJson();
    expect(code).toBe(0);
    expect(raw).not.toContain(SENTINEL_TOKEN);
    expect(raw).not.toMatch(/"token"/);
    expect(parsed.running).toBe(true);
    const info = parsed.info as Record<string, unknown>;
    expect(info).not.toHaveProperty("token");
    expect(info).toMatchObject({ pid: process.pid, profile: PROFILE, background: true });
    expect(typeof info.port).toBe("number");
    const status = parsed.status as Record<string, unknown>;
    expect(status).toMatchObject({ pid: process.pid, profile: PROFILE, browserConnected: true, busy: false });
    expect(status.slots).toMatchObject({ free: 3, total: 3 });
  });

  it("stale branch keeps running:false, pid, port and profile without the token", async () => {
    // Bind then close, so the port answers nothing: the pid is alive but the
    // registration fails health, which is the stale branch.
    const port = await liveDaemon();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    register(port);
    const { code, raw, parsed } = await statusJson();
    expect(code).toBe(0);
    expect(raw).not.toContain(SENTINEL_TOKEN);
    expect(raw).not.toMatch(/"token"/);
    expect(parsed.running).toBe(false);
    const stale = parsed.stale as Record<string, unknown>;
    expect(stale).not.toHaveProperty("token");
    expect(stale).toMatchObject({ pid: process.pid, port, profile: PROFILE });
  });

  it("absent branch stays exactly { running: false }", async () => {
    const { code, raw, parsed } = await statusJson();
    expect(code).toBe(0);
    expect(parsed).toEqual({ running: false });
    expect(raw).not.toContain(SENTINEL_TOKEN);
  });
});
