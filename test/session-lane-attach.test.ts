import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/browser/session.js";

// P-045 G7 (2026-10-28). CGPro attaches over CDP to a bcp-started, headed
// Brave lane (CGPRO_CDP_ENDPOINT). bcp owns that browser: lane mode opens and
// closes only its own tabs, never moves a window and never kills a lane
// browser. patchright and the interceptor are mocked; no browser is touched.
const launchPersistentContext = vi.hoisted(() => vi.fn());
const connectOverCDP = vi.hoisted(() => vi.fn());
const ensureInterceptorInstalled = vi.hoisted(() => vi.fn());
const protocol = vi.hoisted(() => ({ clearDaemonInfo: vi.fn() }));

vi.mock("patchright", () => ({ chromium: { launchPersistentContext, connectOverCDP } }));
vi.mock("../src/core/stream.js", () => ({ ensureInterceptorInstalled }));
vi.mock("../src/daemon/protocol.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/protocol.js")>()),
  ...protocol,
}));

const { configuredLaneEndpoint, isP045LaneProfile, laneCdpEndpoint, openSession } = await import(
  "../src/browser/session.js"
);
const { closeDaemonSession, killProfileBrowsers, SESSION_CLOSE_TIMEOUT_MS } = await import(
  "../src/daemon/server.js"
);

function fakeLane() {
  const page = { on: vi.fn(), close: vi.fn(async () => undefined) };
  const context = {
    pages: () => [{ on: vi.fn(), close: vi.fn() }],
    newPage: vi.fn(async () => page),
    newCDPSession: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  };
  const browser = { contexts: () => [context], close: vi.fn(async () => undefined) };
  connectOverCDP.mockResolvedValue(browser);
  return { page, context, browser };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("P-045 lane attach (G7)", () => {
  it("accepts only a literal loopback port", () => {
    expect(laneCdpEndpoint(undefined)).toBeNull();
    expect(laneCdpEndpoint("  ")).toBeNull();
    expect(laneCdpEndpoint("http://127.0.0.1:9252/")).toBe("http://127.0.0.1:9252");
    expect(() => laneCdpEndpoint("http://localhost:9252")).toThrow(/127\.0\.0\.1/);
    expect(() => laneCdpEndpoint("http://10.0.0.5:9252")).toThrow();
    expect(() => laneCdpEndpoint("ws://127.0.0.1:9252")).toThrow();
    expect(() => laneCdpEndpoint("http://127.0.0.1:99999")).toThrow();
  });

  it("reads CGPRO_CDP_ENDPOINT when no endpoint is passed", () => {
    vi.stubEnv("CGPRO_CDP_ENDPOINT", "http://127.0.0.1:9252");
    expect(configuredLaneEndpoint()).toBe("http://127.0.0.1:9252");
  });

  it("attaches, opens its own tab, and never touches a window", async () => {
    const { page, context } = fakeLane();

    const session = await openSession({ cdpEndpoint: "http://127.0.0.1:9252", headed: true, background: true });

    expect(launchPersistentContext).not.toHaveBeenCalled();
    expect(connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:9252");
    expect(ensureInterceptorInstalled).toHaveBeenCalledWith(context);
    expect(session.page).toBe(page);
    expect(session.lane).toBe("http://127.0.0.1:9252");
    // parkWindow/showWindow both go through a CDP session; lane mode opens none.
    expect(context.newCDPSession).not.toHaveBeenCalled();
  });

  it("on close drops only its own and adopted tabs plus the connection, never the context", async () => {
    const { page, context, browser } = fakeLane();
    const session = await openSession({ cdpEndpoint: "http://127.0.0.1:9252" });
    const slotTab = { close: vi.fn(async () => undefined) };
    session.adopt?.(slotTab as never);
    const foreign = context.pages()[0];

    await session.close();

    expect(page.close).toHaveBeenCalled();
    expect(slotTab.close).toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });
});

describe("lane mode never kills a lane browser (G7)", () => {
  it("recognises P-045 lane user-data dirs", () => {
    expect(isP045LaneProfile("/Users/maik/.p045-lane-p035-cgpro-ms1980-brave")).toBe(true);
    expect(isP045LaneProfile("/Users/maik/.p045-lane-x/")).toBe(true);
    expect(isP045LaneProfile("/Users/maik/Library/Application Support/cgpro/chrome_profile")).toBe(false);
  });

  it("killProfileBrowsers refuses a lane profile without listing processes", () => {
    const listProcesses = vi.fn(() => "123 brave --user-data-dir=/Users/maik/.p045-lane-a");
    const kill = vi.fn();
    expect(killProfileBrowsers("/Users/maik/.p045-lane-a", { listProcesses, kill })).toEqual([]);
    expect(listProcesses).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("killProfileBrowsers still kills the old CGPro profile's browser and skips any lane line", () => {
    const listing = [
      "201 chromium --user-data-dir=/cgpro/chrome_profile --foo",
      "202 brave --user-data-dir=/Users/maik/.p045-lane-a --x=--user-data-dir=/cgpro/chrome_profile",
    ].join("\n");
    const kill = vi.fn();
    expect(killProfileBrowsers("/cgpro/chrome_profile", { listProcesses: () => listing, kill })).toEqual([201]);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("a lane session whose close hangs is abandoned after the bound, never killed", async () => {
    vi.useFakeTimers();
    const session = {
      lane: "http://127.0.0.1:9252",
      close: vi.fn(() => new Promise<void>(() => {})),
    } as unknown as Session;
    const kill = vi.fn((_dir: string) => [101]);
    const closing = closeDaemonSession(session, "/cgpro/chrome_profile", kill);
    await vi.advanceTimersByTimeAsync(SESSION_CLOSE_TIMEOUT_MS);
    await closing;
    expect(kill).not.toHaveBeenCalled();
    expect(protocol.clearDaemonInfo).toHaveBeenCalledWith(process.pid);
  });
});
