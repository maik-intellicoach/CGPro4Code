import { describe, it, expect, vi } from "vitest";
import { AskQueue, QueueFullError, QueueWaitTimeoutError } from "../src/daemon/server.js";

describe("AskQueue", () => {
  it("admits asks one at a time in arrival order", async () => {
    const queue = new AskQueue(8, 60_000);
    const order: number[] = [];

    await queue.acquire();
    order.push(0);

    const p2 = queue.acquire().then(() => order.push(1));
    const p3 = queue.acquire().then(() => order.push(2));

    // Second and third are still queued behind the first, still in flight.
    expect(order).toEqual([0]);

    queue.release();
    await p2;
    expect(order).toEqual([0, 1]);

    queue.release();
    await p3;
    expect(order).toEqual([0, 1, 2]);
  });

  it("rejects a new arrival with QueueFullError once the waiting line hits maxDepth", async () => {
    const queue = new AskQueue(1, 60_000);
    await queue.acquire(); // becomes active
    const waiter = queue.acquire(); // fills the one waiting slot

    await expect(queue.acquire()).rejects.toBeInstanceOf(QueueFullError);

    queue.release();
    await waiter; // drain so the test doesn't leak a pending handle
  });

  it("rejects a waiter with QueueWaitTimeoutError after maxWaitMs", async () => {
    vi.useFakeTimers();
    try {
      const queue = new AskQueue(8, 1_000);
      await queue.acquire(); // keep active so the next ask has to wait
      const waiter = queue.acquire();
      const assertion = expect(waiter).rejects.toBeInstanceOf(QueueWaitTimeoutError);
      vi.advanceTimersByTime(1_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes depth and busy for health/status reporting", async () => {
    const queue = new AskQueue(8, 60_000);
    expect(queue.depth).toBe(0);
    expect(queue.busy).toBe(false);

    await queue.acquire();
    expect(queue.busy).toBe(true);
    expect(queue.depth).toBe(0);

    const waiter = queue.acquire();
    expect(queue.depth).toBe(1);

    queue.release();
    await waiter;
    expect(queue.depth).toBe(0);
    expect(queue.busy).toBe(true);

    queue.release();
    expect(queue.busy).toBe(false);
  });
});
