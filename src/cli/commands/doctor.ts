import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { goHome, isLoggedIn } from "../../browser/chatgpt.js";
import { SELECTORS, TURN_CRITICAL_SELECTORS, type SelectorSet } from "../../browser/selectors.js";
import { assertNoDaemon, fetchSelectorAudit, getLiveDaemon, probeDomShape } from "../../daemon/client.js";
import { readDaemonInfo } from "../../daemon/protocol.js";

export interface DoctorOptions {
  profile?: string;
  headed?: boolean;
  /** Audit the running daemon's own page instead of opening a browser. */
  viaDaemon?: boolean;
  /** Probe one conversation's DOM shape through the daemon (read-only, content-free). */
  domShape?: string;
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

/**
 * One table renderer for both sources, so they cannot read differently.
 *
 * Only three outcomes matter, and only one of them is a failure (P-035
 * 2026-09-16): a fallback or an unresolved surface-scoped key is normal on a
 * bare page, while a miss on `TURN_CRITICAL_SELECTORS` means a turn cannot
 * start. Before this split every healthy lane exited 5 with 12 of 22 keys
 * "failed", which made the audit useless as a pre-flight check.
 */
function renderAudit(rows: AuditRow[], critical: string[]): number {
  let exitCode = 0;
  const widthKey = Math.max(...rows.map((row) => row.key.length)) + 2;
  for (const row of rows) {
    const padded = row.key.padEnd(widthKey);
    const isCritical = critical.includes(row.key);
    if (row.firstWorking === -1) {
      if (isCritical) {
        console.log(`${chalk.red("✖")} ${padded}${chalk.red("no candidate matched (turn-critical)")}`);
        exitCode = 5;
      } else {
        console.log(`${chalk.dim(`· ${padded}not on this surface`)}`);
      }
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
    console.log(chalk.green("Every turn-critical selector resolves."));
  } else {
    console.log(
      chalk.yellow(
        "A turn-critical selector does not resolve. File a bug at https://github.com/yannabadie/CGPro4Code/issues",
      ),
    );
  }
  return exitCode;
}

const UNKNOWN_ROWS: AuditRow[] = (Object.keys(SELECTORS) as Array<keyof SelectorSet>).map(
  (key) => ({ key: key.toString(), candidates: SELECTORS[key], firstWorking: -1 }),
);

const criticalKeys: string[] = TURN_CRITICAL_SELECTORS.map((key) => key.toString());

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
  return renderAudit(
    audit.results.length > 0 ? audit.results : UNKNOWN_ROWS,
    audit.missingCritical ?? [],
  );
}

/**
 * Probe the shape of one conversation's DOM through the daemon
 * (P-035 2026-09-28, vendor r39).
 *
 * Prints the daemon's content-free JSON summary and exits 0. Every failure --
 * no daemon, a refusal (409 `busy`, 400 `invalid_conversation_id`) or a failed
 * probe (502 `dom_shape_failed`) -- prints the route's own error code and exits
 * non-zero, so a caller can script it.
 */
async function doctorDomShape(conversationId: string): Promise<number> {
  const info = readDaemonInfo();
  if (!info) {
    console.error(
      chalk.red("✖ No daemon is registered. Start a lane first: cgpro daemon start"),
    );
    return 6;
  }
  const live = await getLiveDaemon();
  if (!live) {
    console.error(chalk.red("✖ The registered daemon is not answering."));
    return 6;
  }
  const spinner = ora(`Probing the DOM shape of conversation ${conversationId.slice(0, 8)}…`).start();
  // Failures are written to stderr, not to the spinner: the route's error code
  // is the part a caller scripts on, so it must not be swallowed by an
  // interactive spinner line.
  const fail = (message: string): number => {
    spinner.stop();
    console.error(chalk.red(`✖ ${message}`));
    return 6;
  };
  const result = await probeDomShape(live, conversationId);
  if (result.status === 0) return fail("The daemon never answered the probe.");
  if (result.status !== 200) {
    let code = `http_${result.status}`;
    try {
      const parsed = JSON.parse(result.text) as { error?: string };
      if (parsed?.error) code = parsed.error;
    } catch {
      /* keep the http_<status> fallback */
    }
    return fail(`The daemon refused the dom-shape probe: ${code}`);
  }
  let summary: unknown;
  try {
    summary = JSON.parse(result.text);
  } catch {
    return fail("The daemon returned a probe result that is not JSON.");
  }
  spinner.succeed(`Probed conversation ${conversationId.slice(0, 8)} — content-free summary follows.`);
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  // P-035 2026-09-28 (vendor r39). The probe runs on the daemon's own
  // authenticated page, so `--dom-shape` implies the daemon path whether or not
  // `--via-daemon` was passed with it.
  if (opts.domShape) return await doctorDomShape(opts.domShape);
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
    return renderAudit(rows, criticalKeys);
  } finally {
    await session.close();
  }
}
