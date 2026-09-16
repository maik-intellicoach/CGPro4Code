import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { goHome, isLoggedIn } from "../../browser/chatgpt.js";
import { SELECTORS, type SelectorSet } from "../../browser/selectors.js";
import { assertNoDaemon } from "../../daemon/client.js";

export interface DoctorOptions {
  profile?: string;
  headed?: boolean;
}

/**
 * How long the sign-in check may take before the audit gives up.
 *
 * P-035 2026-09-16: this was 8s, which a cold launch on a healthy profile does
 * not always beat -- the daemon's own start path allows 60s for the same
 * profile and reported `proModelAvailable: true` minutes after an 8s check had
 * declared it signed out. The failure mode is nasty because it is silent: the
 * audit then runs against the login page, where every selector legitimately
 * fails, and the operator reads a full table of ✖ as selector drift.
 */
const SIGNIN_TIMEOUT_MS = Number(
  process.env.CGPRO_DOCTOR_SIGNIN_TIMEOUT_MS ?? 60_000,
);

export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  await assertNoDaemon("doctor", opts.profile);
  const session = await openSession({ headed: !!opts.headed, profilePath: opts.profile });
  const spinner = ora("Auditing selectors against chatgpt.com…").start();
  let exitCode = 0;
  try {
    await goHome(session.page);
    const logged = await isLoggedIn(session.page, SIGNIN_TIMEOUT_MS);
    if (!logged) {
      // Never audit the login page: every selector fails there by definition,
      // so the table would report drift that does not exist and bury the real
      // problem (no usable session). Refuse, and say which profile and how to
      // fix it.
      spinner.warn("Not signed in — cannot audit selectors.");
      console.log("");
      console.log(
        chalk.yellow(
          "The profile has no usable ChatGPT session, so every selector would fail on the login page.",
        ),
      );
      console.log(
        chalk.dim(
          `  Profile: ${opts.profile ?? "default"}; sign in with: CGPRO_USE_CHROME=1 cgpro login --profile <dir>`,
        ),
      );
      return 6;
    }
    spinner.succeed("Signed in. Running selector audit.");

    console.log("");
    console.log(chalk.bold("Selector audit"));
    console.log(chalk.dim("─".repeat(60)));
    const keys = Object.keys(SELECTORS) as Array<keyof SelectorSet>;
    const widthKey = Math.max(...keys.map((k) => k.length)) + 2;
    for (const key of keys) {
      const candidates = SELECTORS[key];
      let firstWorking = -1;
      for (let i = 0; i < candidates.length; i++) {
        try {
          const count = await session.page
            .locator(candidates[i])
            .first()
            .count();
          if (count > 0) {
            firstWorking = i;
            break;
          }
        } catch {
          /* try next */
        }
      }
      const padded = key.toString().padEnd(widthKey);
      if (firstWorking === -1) {
        console.log(`${chalk.red("✖")} ${padded}${chalk.red("no candidate matched")}`);
        exitCode = 5;
      } else if (firstWorking === 0) {
        console.log(`${chalk.green("✔")} ${padded}${chalk.dim(candidates[0])}`);
      } else {
        console.log(
          `${chalk.yellow("⚠")} ${padded}${chalk.yellow(`fallback #${firstWorking}`)} ${chalk.dim(candidates[firstWorking])}`,
        );
      }
    }
    console.log("");
    if (exitCode === 0) {
      console.log(chalk.green("All selectors resolve."));
    } else {
      console.log(
        chalk.yellow(
          "Some selectors failed. File a bug at https://github.com/yannabadie/CGPro4Code/issues",
        ),
      );
    }
    return exitCode;
  } finally {
    await session.close();
  }
}
