import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import {
  detectWelcomeBackModal,
  fetchAuthSessionInPage,
  firstResolved,
  type AuthSessionFull,
} from "../../browser/chatgpt.js";
import { assertNoDaemon } from "../../daemon/client.js";

export interface LoginOptions {
  profile?: string;
  timeout?: number;
}

/**
 * Login flow:
 *   1. Open Chrome headed against the persistent profile.
 *   2. Navigate to chatgpt.com.
 *   3. Poll /backend-api/me every 2s. The endpoint always returns 200,
 *      but the `id` field discriminates: "user-XXX" = real account,
 *      "ua-XXX" = anonymous trial. We close the browser only when we
 *      see "user-XXX", so the user has all the time they need.
 */
export async function loginCommand(opts: LoginOptions): Promise<number> {
  await assertNoDaemon("login");
  const timeoutSec = opts.timeout ?? 300;
  const startedAt = Date.now();

  console.log(chalk.bold("Opening Chromium…"));
  console.log("");
  console.log("  1. Sign in to your ChatGPT account in the browser window.");
  console.log("  2. The browser closes by itself the moment login is detected.");
  console.log("");

  // Login MUST show the window so the user can sign in.
  const session = await openSession({ headed: true, background: false, profilePath: opts.profile });
  const spinner = ora("Waiting for sign-in…").start();

  try {
    // Navigate to chatgpt.com home first — if a "Welcome back" modal
    // appears (stale session), click the account card to trigger the
    // Google OAuth re-auth flow. If no modal, fall through to the
    // normal login page.
    await session.page.goto("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await session.page.waitForTimeout(3_000);

    if (await detectWelcomeBackModal(session.page)) {
      spinner.text = "Welcome back modal detected — clicking your account…";
      const accountCard = await firstResolved(session.page, [
        '[data-testid="log-back-form"] [role="button"]:first-of-type',
        '[data-testid="log-back-form"] > div:first-child',
        '[data-testid="log-back-form"] :has(img)',
      ]);
      if (accountCard) {
        await accountCard.click({ timeout: 5_000 }).catch(() => {});
        spinner.text = "Google OAuth in progress — complete sign-in if prompted…";
        // Wait for the OAuth redirect chain to finish (Google → chatgpt.com).
        const oauthDeadline = Date.now() + 120_000;
        while (Date.now() < oauthDeadline) {
          const url = session.page.url();
          if (url.includes("chatgpt.com") && !url.includes("auth/login")) break;
          await session.page.waitForTimeout(1_000);
        }
        await session.page.waitForTimeout(3_000);
      }
    } else {
      // No welcome-back modal — go to the dedicated login page.
      await session.page
        .goto("https://chatgpt.com/auth/login", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        .catch(() => {});
    }

    const deadline = startedAt + timeoutSec * 1000;
    let lastSpinnerUpdate = 0;
    while (Date.now() < deadline) {
      // Must be on chatgpt.com (not Google OAuth redirect) to check
      const url = session.page.url();
      if (url.includes("chatgpt.com")) {
        // Reject if still showing the Welcome back modal or anonymous trial
        const hasModal = await detectWelcomeBackModal(session.page).catch(() => false);
        const hasLoginBtn = await firstResolved(session.page, [
          '[data-testid="login-button"]',
        ]).then((l) => !!l).catch(() => false);
        if (!hasModal && !hasLoginBtn) {
          const sess = await fetchAuthSessionInPage(session.page);
          if (sess?.user?.id?.startsWith("user-")) {
            spinner.succeed("Signed in — closing browser.");
            console.log("");
            console.log(chalk.green("✔ Logged in"));
            console.log(`  ${chalk.bold("Account:")}  ${sess.user.email ?? "(no email)"}`);
            console.log(`  ${chalk.bold("Name:")}     ${sess.user.name ?? "(no name)"}`);
            if (sess.expires) {
              console.log(`  ${chalk.bold("Expires:")}  ${new Date(sess.expires).toLocaleString()}`);
            }
            console.log("");
            console.log(
              chalk.dim('Profile is now warm. Run `cgpro status`, then `cgpro ask "..."`.'),
            );
            return 0;
          }
        }
      }
      const now = Date.now();
      if (now - lastSpinnerUpdate > 1_500) {
        const elapsed = Math.round((now - startedAt) / 1000);
        const context = url.includes("google.com")
          ? "Google OAuth…"
          : url.includes("auth.openai.com")
            ? "OpenAI auth…"
            : "Waiting for sign-in…";
        spinner.text = `${context} (${elapsed}s)`;
        lastSpinnerUpdate = now;
      }
      await session.page.waitForTimeout(1_000);
    }

    spinner.fail(`Timed out after ${timeoutSec}s — still anonymous.`);
    console.log("");
    console.log(
      chalk.yellow(
        'Common cause: the "Try ChatGPT" guest mode shows the composer\n' +
          'without an actual login. Look for the "Log in" button at the\n' +
          "top right and complete a real sign-in flow.",
      ),
    );
    return 7;
  } finally {
    await session.close();
  }
}

// Auth detection now lives in browser/chatgpt.ts (fetchAuthSessionInPage)
// — the in-page /api/auth/session call is the only signal that
// reliably discriminates anonymous trial sessions from real ones.
export type _LoginInternalsKept = AuthSessionFull;
