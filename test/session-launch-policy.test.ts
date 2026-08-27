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
