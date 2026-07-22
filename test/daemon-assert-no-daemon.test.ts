import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";

// Sandbox CGPRO_HOME so daemon.json goes to a tmp dir, same pattern as
// daemon-protocol.test.ts (C-092 P-026 xfam r1 H6).
const tmpRoot = mkdtempSync(join(tmpdir(), "cgpro-assert-no-daemon-test-"));
mkdirSync(join(tmpRoot, "logs"), { recursive: true });

vi.mock("../src/store/paths.js", () => ({
  CGPRO_HOME: tmpRoot,
  PROFILE_DIR: join(tmpRoot, "profile"),
  THREADS_FILE: join(tmpRoot, "threads.json"),
  CONFIG_FILE: join(tmpRoot, "config.json"),
  LOG_DIR: join(tmpRoot, "logs"),
  ensureDirs: () => {
    /* no-op */
  },
  profileDir: (override?: string) => override ?? join(tmpRoot, "profile"),
}));

const { assertNoDaemon } = await import("../src/daemon/client.js");
const { writeDaemonInfo, clearDaemonInfo } = await import("../src/daemon/protocol.js");

let server: Server | null = null;

afterEach(async () => {
  clearDaemonInfo();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function registerLiveDaemon(profile: string | undefined): Promise<void> {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ daemon: "cgpro" }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  writeDaemonInfo({
    version: 1,
    pid: process.pid, // a genuinely alive pid, per pidIsAlive()
    port,
    token: "t",
    startedAt: new Date().toISOString(),
    profile,
    background: true,
  });
}

describe("assertNoDaemon profile scoping (C-092 H6)", () => {
  it("allows a login/status/etc. targeting a DIFFERENT profile than the live daemon", async () => {
    await registerLiveDaemon("/profiles/A");
    await expect(assertNoDaemon("login", "/profiles/B")).resolves.toBeUndefined();
  });

  it("refuses when the live daemon's profile matches the command's target profile", async () => {
    await registerLiveDaemon("/profiles/A");
    await expect(assertNoDaemon("login", "/profiles/A")).rejects.toThrow(
      /cannot run while the daemon owns the profile/,
    );
  });

  it("preserves current behavior when no --profile is given on either side (default profile)", async () => {
    await registerLiveDaemon(undefined);
    await expect(assertNoDaemon("status", undefined)).rejects.toThrow(
      /cannot run while the daemon owns the profile/,
    );
  });

  it("does not throw when there is no live daemon at all", async () => {
    await expect(assertNoDaemon("doctor", "/profiles/A")).resolves.toBeUndefined();
  });
});
