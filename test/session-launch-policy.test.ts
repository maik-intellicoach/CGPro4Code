import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launchPersistentContext = vi.hoisted(() => vi.fn());
const ensureInterceptorInstalled = vi.hoisted(() => vi.fn());

vi.mock("patchright", () => ({
  chromium: { launchPersistentContext },
}));

vi.mock("../src/core/stream.js", () => ({
  ensureInterceptorInstalled,
}));

import { openSession } from "../src/browser/session.js";

describe("dedicated Chrome launch policy", () => {
  it("keeps Chromium's process sandbox enabled and hides only the crash bubble", async () => {
    // `on` is part of the fake because openSession installs the file-chooser
    // guard (no native OS picker may ever reach the screen).
    const page = { on: vi.fn() };
    const context = {
      pages: () => [page],
      newPage: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    launchPersistentContext.mockResolvedValue(context);

    const profilePath = mkdtempSync(join(tmpdir(), "cgpro-launch-policy-"));
    await openSession({
      profilePath,
      headed: true,
      background: false,
      useSystemChrome: false,
    });

    expect(launchPersistentContext).toHaveBeenCalledWith(
      profilePath,
      expect.objectContaining({
        chromiumSandbox: true,
        args: expect.arrayContaining(["--hide-crash-restore-bubble"]),
      }),
    );
  });
});

/**
 * Regression cover for the background posture. Before this, background mode was
 * two launch arguments: `--window-position=-32000,-32000`, which Chrome's window
 * sizer clamps back onto the nearest display, and `--start-minimized`, which is
 * not a Chromium switch at all. Neither governed windows opened after launch, so
 * every daemon slot put a visible window on the user's desktop.
 */
describe("background window posture", () => {
  function fakeContext() {
    const send = vi.fn(async (method: string) =>
      method === "Browser.getWindowForTarget" ? { windowId: 7 } : {},
    );
    const cdp = { send, detach: vi.fn(async () => undefined) };
    const page = { on: vi.fn() };
    const context = {
      pages: () => [page],
      newPage: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      newCDPSession: vi.fn(async () => cdp),
    };
    return { context, page, send };
  }

  const minimized = [
    "Browser.setWindowBounds",
    { windowId: 7, bounds: { windowState: "minimized" } },
  ];

  it("minimises the first window before openSession returns", async () => {
    const { context, send } = fakeContext();
    launchPersistentContext.mockResolvedValue(context);

    await openSession({
      profilePath: mkdtempSync(join(tmpdir(), "cgpro-background-")),
      headed: true,
      background: true,
    });

    expect(send).toHaveBeenCalledWith(...minimized);
  });

  it("minimises a window opened after launch", async () => {
    const { context, send } = fakeContext();
    launchPersistentContext.mockResolvedValue(context);

    await openSession({
      profilePath: mkdtempSync(join(tmpdir(), "cgpro-background-")),
      headed: true,
      background: true,
    });
    send.mockClear();

    // Every "page" handler gets the new tab; only the posture one touches CDP.
    const opened = { on: vi.fn() };
    for (const [event, handler] of context.on.mock.calls) {
      if (event === "page") (handler as (p: unknown) => void)(opened);
    }
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(...minimized));

    expect(context.newCDPSession).toHaveBeenCalledWith(opened);
  });

  it("leaves the window visible when background is off, so login still works", async () => {
    const { context } = fakeContext();
    launchPersistentContext.mockResolvedValue(context);

    await openSession({
      profilePath: mkdtempSync(join(tmpdir(), "cgpro-background-")),
      headed: true,
      background: false,
    });

    expect(context.newCDPSession).not.toHaveBeenCalled();
  });
});
