import { describe, it, expect, afterEach } from "vitest";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";

// Small bounds so the slow-header test doesn't need to wait out the real
// production default (C-092 P-026 xfam r2 B1), matching the pattern already
// used for CGPRO_DAEMON_BODY_TIMEOUT_MS in daemon-http.test.ts.
process.env.CGPRO_DAEMON_HEADERS_TIMEOUT_MS = "150";
process.env.CGPRO_DAEMON_REQUEST_TIMEOUT_MS = "300";

const { applyServerTimeouts } = await import("../src/daemon/server.js");

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("daemon server header/request timeouts (C-092 P-026 xfam r2 B1)", () => {
  it("destroys a socket whose headers never complete, without needing the app to intervene", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("should never be reached");
    });
    applyServerTimeouts(server);
    const port = await listen(server);

    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      const failTimer = setTimeout(() => reject(new Error("socket was not closed within the expected window")), 2_000);
      socket.on("connect", () => {
        // Incomplete headers — no terminating blank line ever sent.
        socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      });
      socket.on("close", () => {
        clearTimeout(failTimer);
        resolve();
      });
    });
    expect(socket.destroyed).toBe(true);
  });

  it("serves a healthy, complete request normally", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    applyServerTimeouts(server);
    const port = await listen(server);

    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ port, host: "127.0.0.1", path: "/" }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("ok");
  });
});
