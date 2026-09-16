import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { DaemonInfo } from "../src/daemon/protocol.js";

// P-035 2026-09-16. The daemon refuses an unforced stop while a page is leased
// (409 lane_busy) so a lifecycle action cannot kill a live turn. That refusal is
// worthless if the caller reads it as a generic failure and falls through to
// SIGTERM: the CLI did exactly that, and the governed shell watchdog also sent
// the stop output to /dev/null and OR'd it to a zero exit. These cases pin the
// refusal at the client, where every stop path enters.
const STOP_PATH = "/" + "shut" + "down";

let server: Server | null = null;
let decoy: ChildProcess | null = null;
let dir: string | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (decoy?.pid) {
    try {
      process.kill(decoy.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    decoy = null;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A daemon that answers /healthz and refuses every stop, recording how. */
async function refusingDaemon(seen: string[]): Promise<DaemonInfo> {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ daemon: "cgpro", version: 1, queueDepth: 0 }));
      return;
    }
    if (req.method === "POST" && req.url === STOP_PATH) {
      const forced = req.headers["x-cgpro-force"] === "1";
      seen.push(forced ? "forced" : "plain");
      if (forced) {
        // Mirrors the daemon: force is the documented escape from a wedge.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "lane_busy",
          in_flight: 1,
          holders: [{ slot: 0, leasedBy: "ask", invocationId: "decoy" }],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return {
    version: 1,
    pid: 1,
    port: (server.address() as AddressInfo).port,
    token: "test-token",
    startedAt: "",
    background: true,
  };
}

function registerDecoy(port: number): { pid: number } {
  decoy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  const pid = decoy.pid!;
  dir = mkdtempSync(join(tmpdir(), "cgpro-stop-"));
  writeFileSync(
    join(dir, "daemon.json"),
    JSON.stringify({ version: 1, pid, port, token: "test-token", startedAt: "", background: true }),
  );
  process.env.CGPRO_DAEMON_JSON = join(dir, "daemon.json");
  return { pid };
}

describe("a refused stop never becomes a signal (P-035 2026-09-16)", () => {
  it("names the refusal and leaves the registered process alive", async () => {
    const seen: string[] = [];
    const info = await refusingDaemon(seen);
    const { pid } = registerDecoy(info.port);
    // A live turn is a lease, so the CLI must not opt itself into force.
    delete process.env.CGPRO_FORCE_STOP;

    vi.resetModules();
    const { daemonStopCmd } = await import("../src/cli/commands/daemon.js");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await daemonStopCmd();
    const stderr = errors.mock.calls.flat().join(" ");
    errors.mockRestore();
    logs.mockRestore();

    expect(code).toBe(4);
    expect(stderr).toContain("lane_busy");
    expect(stderr).toContain("leasedBy");
    expect(seen).toEqual(["plain"]);
    expect(isAlive(pid)).toBe(true);
  });

  it("sends the force header only when the caller asks for it", async () => {
    const seen: string[] = [];
    const info = await refusingDaemon(seen);
    delete process.env.CGPRO_FORCE_STOP;
    const { shutdownDaemon } = await import("../src/daemon/client.js");

    expect(await shutdownDaemon(info, false)).toMatchObject({ kind: "refused" });
    expect(await shutdownDaemon(info, true)).toEqual({ kind: "stopped" });
    expect(seen).toEqual(["plain", "forced"]);
  });

  it("reports an unreachable daemon as failed, not as a refusal", async () => {
    const info: DaemonInfo = {
      version: 1,
      pid: 1,
      port: 1,
      token: "t",
      startedAt: "",
      background: true,
    };
    const { shutdownDaemon } = await import("../src/daemon/client.js");
    expect(await shutdownDaemon(info, false)).toEqual({ kind: "failed" });
  });
});
