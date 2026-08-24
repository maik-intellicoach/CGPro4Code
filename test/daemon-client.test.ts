import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { askViaDaemon, requestDaemonReload, type RetryPolicy } from "../src/daemon/client.js";
import type { DaemonInfo } from "../src/daemon/protocol.js";
import type { StreamEvent } from "../src/core/stream.js";

// Near-instant retry policy so these tests don't sleep through real
// backoff delays (C-092 F5).
const FAST_RETRY: RetryPolicy = { maxAttempts: 5, totalBudgetMs: 5_000, backoffMs: () => 0 };

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function listen(handler: Parameters<typeof createServer>[0]): Promise<DaemonInfo> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { version: 1, pid: 1, port, token: "t", startedAt: "", background: true };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("askViaDaemon retry/error contract (C-092 F5)", () => {
  it("carries ChatGPT Project identity through the daemon request", async () => {
    let body: Record<string, unknown> = {};
    const info = await listen((req, res) => {
      let raw = "";
      req.setEncoding("utf-8");
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        body = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('event: summary\ndata: {"conversationId":"c1","finalText":"ok"}\n\n');
        res.end();
      });
    });

    const runner = askViaDaemon(info, {
      prompt: "hi",
      gizmoId: "g-p-project",
      gizmoShortUrl: "p35-work-team",
      timeoutSec: 30,
      headless: false,
    }, FAST_RETRY);
    await collect(runner.events);
    await runner.result;

    expect(body).toMatchObject({
      gizmoId: "g-p-project",
      gizmoShortUrl: "p35-work-team",
    });
  });

  it("retries on 429 with backoff then succeeds", async () => {
    let attempts = 0;
    const info = await listen((_req, res) => {
      attempts++;
      if (attempts < 3) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "queue_full" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: delta\ndata: {"type":"delta","text":"hi"}\n\n');
      res.write('event: summary\ndata: {"conversationId":"c1","finalText":"hi"}\n\n');
      res.end();
    });

    const runner = askViaDaemon(info, { prompt: "hi", timeoutSec: 30, headless: false }, FAST_RETRY);
    const events = await collect(runner.events);
    const result = await runner.result;

    expect(attempts).toBe(3);
    expect(result.finalText).toBe("hi");
    expect(result.conversationId).toBe("c1");
    expect(events.some((ev) => ev.type === "error")).toBe(false);
  });

  it("gives up with a typed error event after exhausting retries on a persistent 429", async () => {
    let attempts = 0;
    const info = await listen((_req, res) => {
      attempts++;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "queue_full" }));
    });

    const runner = askViaDaemon(info, { prompt: "hi", timeoutSec: 30, headless: false }, FAST_RETRY);
    const events = await collect(runner.events);
    const result = await runner.result;

    expect(attempts).toBe(FAST_RETRY.maxAttempts);
    expect(result.finalText).toBe("");
    const errorEvent = events.find((ev) => ev.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { message: string }).message).toMatch(/queue is full/i);
  });

  it("reports a clean typed error on 504 (queue wait timeout) without retrying", async () => {
    let attempts = 0;
    const info = await listen((_req, res) => {
      attempts++;
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "queue_wait_timeout" }));
    });

    const runner = askViaDaemon(info, { prompt: "hi", timeoutSec: 30, headless: false }, FAST_RETRY);
    const events = await collect(runner.events);

    expect(attempts).toBe(1); // no retry on 504
    const errorEvent = events.find((ev) => ev.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { message: string }).message).toMatch(/queue wait timed out/i);
  });

  it("reports a graceful message on a legacy 409 without crashing", async () => {
    const info = await listen((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "busy" }));
    });

    const runner = askViaDaemon(info, { prompt: "hi", timeoutSec: 30, headless: false }, FAST_RETRY);
    const events = await collect(runner.events);
    const result = await runner.result;

    const errorEvent = events.find((ev) => ev.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { message: string }).message).toMatch(/busy with another turn/i);
    expect(result.finalText).toBe("");
  });

  it("cancel() during a backoff sleep interrupts it and stops further attempts (C-092 G2)", async () => {
    let attempts = 0;
    const info = await listen((_req, res) => {
      attempts++;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "queue_full" }));
    });

    const SLOW_RETRY: RetryPolicy = { maxAttempts: 5, totalBudgetMs: 60_000, backoffMs: () => 5_000 };
    const runner = askViaDaemon(info, { prompt: "hi", timeoutSec: 30, headless: false }, SLOW_RETRY);

    // Let the first 429 land and the 5s backoff sleep begin before cancelling.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await runner.cancel();
    const result = await runner.result;
    const elapsed = Date.now() - started;

    expect(attempts).toBe(1); // cancel during backoff — no second attempt fired
    expect(elapsed).toBeLessThan(1_000); // sleep was interrupted, not waited out
    expect(result.finalText).toBe("");
  });
});

it("allows an idle conversation reload to outlast the five-second status timeout", async () => {
  const info = await listen((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, conversationId: "c1", queued: false, working: false }));
    }, 5_500);
  });

  await expect(requestDaemonReload(info, "c1")).resolves.toMatchObject({ ok: true, conversationId: "c1" });
}, 10_000);
