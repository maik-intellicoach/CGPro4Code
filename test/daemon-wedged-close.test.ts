import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/browser/session.js";

// P-035 2026-10-14, 8ebb7404: the stop endpoint awaited session.close() on a
// wedged browser that never closed, so the stop never answered and the retry
// never ran. The close is now bounded; on timeout the profile's browser is
// killed. Process lookup and kill are mocked: no real process is touched.
const protocol = vi.hoisted(() => ({
  clearDaemonInfo: vi.fn(),
  readDaemonInfo: vi.fn(),
  pidIsAlive: vi.fn(),
}));
vi.mock("../src/daemon/protocol.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/protocol.js")>()),
  ...protocol,
}));
const client = vi.hoisted(() => ({ getLiveDaemon: vi.fn(async () => null) }));
vi.mock("../src/daemon/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/client.js")>()),
  ...client,
}));
const killBrowsers = vi.hoisted(() => vi.fn((_dir: string) => [4242]));
vi.mock("../src/daemon/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/daemon/server.js")>();
  return { ...actual, killProfileBrowsers: (dir: string) => killBrowsers(dir) };
});

const { closeDaemonSession, killProfileBrowsers, SESSION_CLOSE_TIMEOUT_MS } = await vi.importActual<
  typeof import("../src/daemon/server.js")
>("../src/daemon/server.js");
const { daemonStopCmd } = await import("../src/cli/commands/daemon.js");

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("closeDaemonSession is bounded (P-035 2026-10-14)", () => {
  it("a close that never resolves ends after the bound, kills this profile's browser, clears daemon info", async () => {
    vi.useFakeTimers();
    const session = { close: vi.fn(() => new Promise<void>(() => {})) } as unknown as Session;
    const kill = vi.fn((_dir: string) => [101]);
    let settled = false;
    const closing = closeDaemonSession(session, "/lanes/personal", kill).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SESSION_CLOSE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(settled).toBe(true);
    expect(SESSION_CLOSE_TIMEOUT_MS).toBe(20_000);
    expect(kill.mock.calls).toEqual([["/lanes/personal"]]);
    expect(protocol.clearDaemonInfo).toHaveBeenCalledWith(process.pid);
  });

  it("a normal close kills nothing and clears daemon info", async () => {
    const session = { close: vi.fn(async () => {}) } as unknown as Session;
    const kill = vi.fn((_dir: string) => []);
    await closeDaemonSession(session, "/lanes/personal", kill);
    expect(kill).not.toHaveBeenCalled();
    expect(protocol.clearDaemonInfo).toHaveBeenCalledWith(process.pid);
  });
});

describe("killProfileBrowsers matches the exact profile argument", () => {
  it("signals only processes launched on this profile", () => {
    const listing = [
      "  101 /Apps/Chrome --type=browser --user-data-dir=/lanes/personal --no-first-run",
      "  102 /Apps/Chrome --user-data-dir=/lanes/personal",
      "  103 /Apps/Chrome --user-data-dir=/lanes/personal-2 --x",
      "  104 /Apps/Chrome --user-data-dir=/lanes/other",
      `  ${process.pid} node --user-data-dir=/lanes/personal`,
    ].join("\n");
    const kill = vi.fn();
    const killed = killProfileBrowsers("/lanes/personal", { listProcesses: () => listing, kill });
    expect(killed).toEqual([101, 102]);
    expect(kill.mock.calls).toEqual([
      [101, "SIGKILL"],
      [102, "SIGKILL"],
    ]);
  });

  it("a failed listing kills nothing and does not throw", () => {
    const kill = vi.fn();
    const killed = killProfileBrowsers("/lanes/personal", {
      listProcesses: () => {
        throw new Error("ps failed");
      },
      kill,
    });
    expect(killed).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("cgpro daemon stop, forced path", () => {
  function forcedStop(profile: string | undefined) {
    protocol.readDaemonInfo.mockReturnValue({
      version: 1, pid: 999_999, port: 1, token: "t", startedAt: "", background: true, profile,
    });
    // Alive for the first check, gone after SIGTERM.
    protocol.pidIsAlive.mockReturnValueOnce(true).mockReturnValue(false);
    const order: string[] = [];
    const signal = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig: string) => {
      order.push(`kill ${pid} ${sig}`);
      return true;
    }) as typeof process.kill);
    killBrowsers.mockImplementation((dir: string) => {
      order.push(`browsers ${dir}`);
      return [4242];
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    return { order, signal };
  }

  it("kills the lane's browser after the daemon pid when the profile is known", async () => {
    const { order } = forcedStop("/lanes/personal");
    await expect(daemonStopCmd({ force: true })).resolves.toBe(0);
    expect(order).toEqual(["kill 999999 SIGTERM", "browsers /lanes/personal"]);
    expect(protocol.clearDaemonInfo).toHaveBeenCalledWith(999_999);
  });

  it("an unknown profile kills no browser and does not throw", async () => {
    const { order } = forcedStop(undefined);
    await expect(daemonStopCmd({ force: true })).resolves.toBe(0);
    expect(order).toEqual(["kill 999999 SIGTERM"]);
    expect(killBrowsers).not.toHaveBeenCalled();
  });
});
