// patchright is a drop-in Playwright fork that patches CDP leaks
// (navigator.webdriver, isolated-world detection, etc.). Both runtime
// and types come from patchright so Locator types stay compatible.
import { chromium, type BrowserContext, type FileChooser, type Page } from "patchright";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ProfileLockedError } from "../errors.js";
import { profileDir, ensureDirs } from "../store/paths.js";
import { ensureInterceptorInstalled } from "../core/stream.js";

export interface SessionOptions {
  headed?: boolean;
  profilePath?: string;
  /** Use system Chrome via channel="chrome". Falls back to bundled Chromium if false. */
  useSystemChrome?: boolean;
  /**
   * Open the browser window off-screen + minimized so the user doesn't see
   * a popup, while keeping the (auth-bearing) headed Chromium fingerprint.
   * Real headless mode gets challenged by Cloudflare.
   */
  background?: boolean;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Launches a Chromium-based browser with a persistent profile.
 *
 * - First-time and login flows pass `headed: true` so the user can sign in
 *   and clear any 2FA / Cloudflare challenges.
 * - Subsequent runs reuse the same profile directory; the cookie jar and
 *   IndexedDB stay warm so headless operation works without re-challenges.
 * - The fetch interceptor for /backend-api/conversation is installed once
 *   per context BEFORE any navigation, so it catches the very first request.
 */
export async function openSession(opts: SessionOptions = {}): Promise<Session> {
  ensureDirs();
  const dir = profileDir(opts.profilePath);
  const headless = !(opts.headed ?? false);
  // Default to bundled Chromium: channel:"chrome" + launchPersistentContext
  // is flaky on Windows when the user's main Chrome is already open. Bundled
  // Chromium is dedicated and isolated; opt-in to system Chrome via env or
  // explicit flag.
  const useSystemChrome =
    opts.useSystemChrome ?? process.env.CGPRO_USE_CHROME === "1";

  // Patchright's stealth patches do most of the work. We add only:
  //   --password-store=basic  → avoid macOS keychain prompts (no-op on win)
  //   --lang=en-US,en         → consistent locale across launches
  // We deliberately do NOT add --disable-blink-features=AutomationControlled
  // (patchright handles blink-feature leaks differently and that flag would
  // re-introduce a sec-ch-ua signal Cloudflare checks for).
  const launchArgs: string[] = [
    "--password-store=basic",
    "--lang=en-US,en",
    // Dedicated cgpro profiles have one automation-owned tab. There is no
    // user browsing session to restore, so Chrome's crash bubble only blocks
    // selectors after an abnormal adapter exit.
    "--hide-crash-restore-bubble",
  ];
  // Background mode: keep the headed Chromium fingerprint (Cloudflare
  // challenges headless), but park the window off-screen + minimised
  // so it never pops up in front of the user.
  // DEFAULT IS ON — the user wants cgpro to be transparent. Pass
  // `background: false` (or set CGPRO_NO_BACKGROUND=1) to actually see
  // the browser (used by `cgpro login` because the user must interact).
  const envForceShow = process.env.CGPRO_NO_BACKGROUND === "1";
  const background = (opts.background ?? !envForceShow) && !envForceShow;
  if (background && !headless) {
    launchArgs.push("--window-position=-32000,-32000", "--start-minimized");
  }

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(dir, {
      headless,
      channel: useSystemChrome ? "chrome" : undefined,
      args: launchArgs,
      // Patchright disables Chromium's process sandbox unless this is
      // explicitly true. Dedicated local profiles do not require that
      // concession, and Chrome surfaces it as an unsupported/security banner.
      chromiumSandbox: true,
      // Strip Playwright's automation default flags so navigator.webdriver
      // is undefined and the UA doesn't include "HeadlessChrome" markers.
      ignoreDefaultArgs: ["--enable-automation"],
      viewport: null,
      locale: "en-US",
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Intentionally NOT setting userAgent: real Chrome already presents a
      // valid, current UA; pinning it would mismatch sec-ch-ua headers.
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
  } catch (err: unknown) {
    const msg = (err as Error).message ?? "";
    if (
      msg.includes("ProcessSingleton") ||
      msg.includes("user data directory is already in use") ||
      msg.includes("SingletonLock")
    ) {
      throw new ProfileLockedError();
    }
    if (useSystemChrome && (msg.includes("channel") || msg.includes("Executable doesn't exist"))) {
      // Retry with bundled Chromium.
      return openSession({ ...opts, useSystemChrome: false });
    }
    throw err;
  }

  // Note: we don't override navigator.webdriver here. patchright already
  // does that at a deeper level (and stacking a Page-level override on top
  // creates a detectable inconsistency).

  // Install the SSE interceptor BEFORE any page navigation so the very
  // first /backend-api/conversation hit is captured.
  await ensureInterceptorInstalled(context);

  // Single tab per session.
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  installFileChooserGuard(context, page);

  return {
    context,
    page,
    async close() {
      await context.close();
      if (!normalizeProfileExitState(dir)) {
        throw new Error("persistent Chrome profile closed but its clean-exit marker could not be recorded");
      }
    },
  };
}

/**
 * Never let a native OS file-open dialog reach the user's screen.
 *
 * We drive a REAL Chrome via patchright. Nothing here registered a
 * `filechooser` listener, and without one Chrome raises the genuine macOS
 * picker whenever the composer's hidden `input[type=file]` is activated. On
 * 2026-08-27 a planning run did exactly that mid-prompt and Maik had to cancel
 * a Finder window repeatedly while the run stalled (invocation a9f3717e:
 * 4m46s between connector_selected and prompt_submitted).
 *
 * Registering the listener is what makes patchright intercept the dialog, so
 * this handler both suppresses the modal AND turns a silent UI hijack into a
 * loud stderr diagnostic. Intended uploads are unaffected: `attachImages`
 * calls `setInputFiles` directly on the input element, which never emits a
 * `filechooser` event.
 */
export function installFileChooserGuard(context: BrowserContext, page?: Page): void {
  const guard = (chooser: FileChooser): void => {
    const element = chooser.element();
    void element
      .evaluate((node: Element) => ({
        name: node.getAttribute("name"),
        testid: node.getAttribute("data-testid"),
        accept: node.getAttribute("accept"),
      }))
      .catch(() => null)
      .then((detail) => {
        console.error(
          "[cgpro:filechooser] BLOCKED an unrequested native file dialog " +
            `(multiple=${chooser.isMultiple()} detail=${JSON.stringify(detail)}). ` +
            "cgpro never uploads through the OS picker; attachments go through setInputFiles. " +
            "If this fires during a turn, the composer was hijacked - check the prompt path.",
        );
      });
    // Empty file list dismisses the chooser without uploading anything.
    void chooser.setFiles([]).catch(() => undefined);
  };
  // `filechooser` is a Page event, so cover the current tab and any tab the
  // app opens later (cgpro is single-tab today, but a stray popup must not
  // become an unguarded surface).
  page?.on("filechooser", guard);
  context.on("page", (opened: Page) => opened.on("filechooser", guard));
}

/**
 * Chrome leaves `profile.exit_type=Crashed` behind for automation-owned
 * persistent contexts even when Patchright's context.close() resolves. Update
 * only that dedicated profile marker, only after Chrome has closed, using an
 * atomic same-directory replacement so Preferences cannot be half-written.
 */
export function normalizeProfileExitState(dir: string): boolean {
  const preferences = join(dir, "Default", "Preferences");
  if (!existsSync(preferences)) return false;
  const temporary = `${preferences}.cgpro-${process.pid}-${Date.now()}.tmp`;
  try {
    const mode = statSync(preferences).mode & 0o777;
    const document = JSON.parse(readFileSync(preferences, "utf-8")) as Record<string, unknown>;
    const profile = document.profile && typeof document.profile === "object"
      ? document.profile as Record<string, unknown>
      : {};
    profile.exit_type = "Normal";
    profile.exited_cleanly = true;
    document.profile = profile;
    writeFileSync(temporary, JSON.stringify(document), { encoding: "utf-8", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, preferences);
    return true;
  } catch {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      /* The original marker write failure remains authoritative. */
    }
    return false;
  }
}

export function profileExists(profilePath?: string): boolean {
  const dir = profileDir(profilePath);
  return existsSync(dir) && existsSync(`${dir}/Default`);
}
