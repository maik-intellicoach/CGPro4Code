import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { goHome, isLoggedIn } from "../../browser/chatgpt.js";
import { SELECTORS, type SelectorSet } from "../../browser/selectors.js";
import { assertNoDaemon, fetchSelectorAudit, getLiveDaemon } from "../../daemon/client.js";
import { readDaemonInfo } from "../../daemon/protocol.js";

export interface DoctorOptions {
  profile?: string;
  headed?: boolean;
  /** Audit the running daemon's own page instead of opening a browser. */
  viaDaemon?: boolean;
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

export interface AuditRow {
  key: string;
  candidates: string[];
  firstWorking: number;
}

/** One table renderer for both sources, so they cannot read differently. */
function renderAudit(rows: AuditRow[]): number {
  let exitCode = 0;
  const widthKey = Math.max(...rows.map((row) => row.key.length)) + 2;
  for (const row of rows) {
    const padded = row.key.padEnd(widthKey);
    if (row.firstWorking === -1) {
      console.log(`${chalk.red("✖")} ${padded}${chalk.red("no candidate matched")}`);
      exitCode = 5;
    } else if (row.firstWorking === 0) {
      console.log(`${chalk.green("✔")} ${padded}${chalk.dim(row.candidates[0])}`);
    } else {
      console.log(
        `${chalk.yellow("⚠")} ${padded}${chalk.yellow(`fallback #${row.firstWorking}`)} ${chalk.dim(row.candidates[row.firstWorking])}`,
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
}

const UNKNOWN_ROWS: AuditRow[] = (Object.keys(SELECTORS) as Array<keyof SelectorSet>).map(
  (key) => ({ key: key.toString(), candidates: SELECTORS[key], firstWorking: -1 }),
);

/**
 * Audit the page the daemon already holds (P-035 2026-09-16).
 *
 * The daemon is authenticated on its profile; a separately launched `doctor`
 * was not, so it audited the login page and reported every selector broken.
 * Counting is read-only, so this is safe while lanes are serving.
 */
async function doctorViaDaemon(): Promise<number> {
  const info = readDaemonInfo();
  if (!info) {
    console.error(
      chalk.red("✖ No daemon is registered. Start a lane first, or run without --via-daemon."),
    );
    return 6;
  }
  const live = await getLiveDaemon();
  if (!live) {
    console.error(
      chalk.red(
        "✖ The registered daemon is not answering. Run without --via-daemon to open a browser instead.",
      ),
    );
    return 6;
  }
  const spinner = ora("Auditing selectors on the daemon's own page…").start();
  const audit = await fetchSelectorAudit(live);
  if (!audit) {
    spinner.fail("The daemon did not return an audit (it may have no page yet).");
    return 6;
  }
  spinner.succeed(
    `Auditing the daemon's live page${
      audit.inFlight > 0 ? chalk.dim(` (${audit.inFlight} page(s) mid-turn)`) : ""
    }.`,
  );
  console.log("");
  console.log(chalk.bold("Selector audit"));
  console.log(chalk.dim("─".repeat(60)));
  return renderAudit(audit.results.length > 0 ? audit.results : UNKNOWN_ROWS);
}

export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  if (opts.viaDaemon) return await doctorViaDaemon();

  await assertNoDaemon("doctor", opts.profile);
  const session = await openSession({ headed: !!opts.headed, profilePath: opts.profile });
  const spinner = ora("Auditing selectors against chatgpt.com…").start();
  try {
    await goHome(session.page);
    const logged = await isLoggedIn(session.page, SIGNIN_TIMEOUT_MS);
    if (!logged) {
      // Never audit the login page: every selector fails there by definition,
      // so the table would report drift that does not exist and bury the real
      // problem (no usable session). Refuse, and say which profile and how to
      // fix it -- or point at the mode that works.
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
      console.log(
        chalk.dim("  Or audit a running lane's own page, which is already signed in: cgpro doctor --via-daemon"),
      );
      return 6;
    }
    spinner.succeed("Signed in. Running selector audit.");

    console.log("");
    console.log(chalk.bold("Selector audit"));
    console.log(chalk.dim("─".repeat(60)));
    const rows: AuditRow[] = [];
    for (const row of UNKNOWN_ROWS) {
      let firstWorking = -1;
      for (let i = 0; i < row.candidates.length; i++) {
        try {
          const count = await session.page.locator(row.candidates[i]).first().count();
          if (count > 0) {
            firstWorking = i;
            break;
          }
        } catch {
          /* try next */
        }
      }
      rows.push({ ...row, firstWorking });
    }
    return renderAudit(rows);
  } finally {
    await session.close();
  }
}
