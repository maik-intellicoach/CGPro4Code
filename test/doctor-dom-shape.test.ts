import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * P-035 2026-09-28 (vendor r39). `doctor --via-daemon --dom-shape <uuid>` is the
 * only way a planner reads the probe, so its contract is checked at the CLI
 * boundary: the daemon's JSON is printed pretty and the command exits 0, and a
 * refusal exits non-zero naming the route's own error code.
 *
 * A loopback fake daemon stands in for a live lane: no external network, no
 * profile, no browser.
 */
const conversationId = "6aba1a07-ab94-83ec-b213-ebac061f4e2d";
const SUMMARY = {
  url_path_kind: "conversation",
  data_attr_names: [{ name: "data-testid", count: 3 }],
  testids: [{ value: "conversation-turn-3", count: 1 }],
  roles: [{ value: "article", count: 1 }],
  author_roles: [{ value: "assistant", count: 1 }],
  tags: [{ match: "article", count: 1 }],
  candidates: [{ key: "anyMessages", matches: [{ selector: "main article", count: 1 }] }],
  turn_containers: [],
};

// Point the daemon registration at a per-run temp file BEFORE doctor.js (and
// protocol.js under it) resolves DAEMON_FILE at module load.
const daemonFile = join(mkdtempSync(join(tmpdir(), "cgpro-doctor-probe-")), "daemon.json");
process.env.CGPRO_DAEMON_JSON = daemonFile;

const { doctorCommand } = await import("../src/cli/commands/doctor.js");

let server: Server | null = null;
const requests: Array<{ method?: string; url?: string; body: string }> = [];

async function startFakeDaemon(
  respond: (url: string, body: string) => { status: number; json: unknown },
): Promise<void> {
  requests.length = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      const out =
        req.url === "/healthz"
          ? { status: 200, json: { daemon: "cgpro", version: 1, queueDepth: 0 } }
          : respond(req.url ?? "/", body);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(
    daemonFile,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port,
      token: "test-token",
      startedAt: new Date().toISOString(),
      background: true,
    }),
  );
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe("doctor --via-daemon --dom-shape", () => {
  it("prints the daemon's summary and exits 0", async () => {
    await startFakeDaemon(() => ({ status: 200, json: SUMMARY }));
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      const code = await doctorCommand({ viaDaemon: true, domShape: conversationId });
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }

    // The probe is addressed to the one conversation asked for...
    const probe = requests.find((entry) => entry.url === "/dom-shape");
    expect(probe?.method).toBe("POST");
    expect(JSON.parse(probe?.body ?? "{}")).toEqual({ conversationId });
    // ...and the daemon's JSON is what the operator sees, pretty-printed.
    const printed = logged.join("\n");
    expect(JSON.parse(printed)).toEqual(SUMMARY);
    expect(printed.startsWith("{\n  ")).toBe(true);
  });

  it("exits non-zero with the route's error code when the daemon refuses", async () => {
    await startFakeDaemon(() => ({ status: 409, json: { error: "busy" } }));
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    let code: number;
    try {
      code = await doctorCommand({ viaDaemon: true, domShape: conversationId });
    } finally {
      spy.mockRestore();
    }

    expect(code).not.toBe(0);
    expect(errors.join("\n")).toContain("busy");
  });
});
