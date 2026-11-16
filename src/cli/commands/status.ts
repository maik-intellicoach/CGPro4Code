import { statSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { openSession } from "../../browser/session.js";
import { fetchAuthSession, goHome, isLoggedIn } from "../../browser/chatgpt.js";
import { detectPlan, fetchMe } from "../../api/me.js";
import { fetchModels, findProSlug } from "../../api/models.js";
import { NotLoggedInError } from "../../errors.js";
import { assertNoDaemon, getDaemonStatus, getLiveDaemon } from "../../daemon/client.js";
import { DAEMON_FILE, readDaemonInfo, type DaemonInfo } from "../../daemon/protocol.js";

export interface StatusOptions {
  profile?: string;
  headless?: boolean;
}

export async function statusCommand(opts: StatusOptions): Promise<number> {
  // P-035 2026-11-16. A bare `cgpro status` used to launch a cold browser on
  // the default profile even while a registered daemon held the account, so
  // it reported a bundled-browser failure instead of the daemon's real
  // health. Without an explicit --profile, a registered daemon is the answer:
  // read it over HTTP and never open or move a page. An explicit --profile
  // keeps the cold-start route (and its assertNoDaemon guard) unchanged.
  if (opts.profile === undefined) {
    const registered = readDaemonInfo();
    if (registered) return await statusFromDaemon(registered);
    // readDaemonInfo() returns null for an absent registry AND for one that
    // is malformed, unreadable or a different version. Only genuine absence
    // may fall through to a cold launch; anything else could sit beside a
    // live daemon, so fail closed without reading or printing its contents.
    const unusable = unusableRegistryReason();
    if (unusable !== null) {
      console.error(chalk.red(`Daemon registry ${DAEMON_FILE} ${unusable}; status did not launch a browser.`));
      console.error(
        chalk.dim("  Inspect with `cgpro daemon status`, or pass --profile <path> for a cold-start check of another profile."),
      );
      return 1;
    }
  }
  return await coldStatus(opts);
}

/** null only when the registry is genuinely absent (ENOENT); otherwise why it is unusable. */
function unusableRegistryReason(): string | null {
  try {
    statSync(DAEMON_FILE);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return null;
    return `could not be checked (${typeof code === "string" ? code : "unknown error"})`;
  }
  return "exists but is unreadable, malformed, or an unsupported version";
}

async function statusFromDaemon(registered: DaemonInfo): Promise<number> {
  const live = await getLiveDaemon();
  if (!live) {
    // Fail closed: launching a second browser next to a registered but
    // unresponsive daemon is exactly the guess this route must not make.
    console.error(
      chalk.red(`Daemon registered (pid ${registered.pid}) but not responding; status did not launch a browser.`),
    );
    console.error(
      chalk.dim("  Inspect with `cgpro daemon status`, or pass --profile <path> for a cold-start check of another profile."),
    );
    return 1;
  }
  const status = await getDaemonStatus(live);
  if (!status) {
    console.error(chalk.red(`Daemon (pid ${live.pid}) answered health but not /status; session health unknown.`));
    return 1;
  }

  const browserOk = status.browserConnected === true;
  const account = status.account;
  const interaction = status.interaction?.state ?? "unknown";
  const healthy = browserOk && account !== undefined && interaction !== "degraded";

  console.log("");
  console.log(chalk.bold("ChatGPT Pro CLI status (via daemon)"));
  console.log(`  ${chalk.bold("Daemon:")}       pid ${live.pid}, port ${live.port}`);
  console.log(`  ${chalk.bold("Profile:")}      ${status.profile ?? live.profile ?? "(default)"}`);
  console.log(
    `  ${chalk.bold("Browser:")}      ${
      status.browserConnected === true
        ? chalk.green("connected")
        : status.browserConnected === false
          ? chalk.red("disconnected")
          : chalk.yellow("unknown")
    }`,
  );
  console.log(`  ${chalk.bold("Account:")}      ${account?.email ?? "(unknown)"}`);
  console.log(`  ${chalk.bold("Plan:")}         ${account?.plan ?? "(unknown)"}`);
  if (account === undefined) {
    console.log(`  ${chalk.bold("Pro model:")}    ${chalk.yellow("unknown")}`);
  } else if (account.proModelAvailable) {
    console.log(`  ${chalk.bold("Pro model:")}    ${chalk.green("✓")}`);
  } else {
    console.log(`  ${chalk.bold("Pro model:")}    ${chalk.yellow("not detected")}`);
  }
  console.log(`  ${chalk.bold("Interaction:")}  ${interaction}`);
  if (status.slots) {
    console.log(`  ${chalk.bold("Slots:")}        ${status.slots.free} free of ${status.slots.total}`);
  }

  if (!healthy) {
    const reasons: string[] = [];
    if (!browserOk) reasons.push(status.browserConnected === false ? "browser disconnected" : "browser state unknown");
    if (account === undefined) reasons.push("account not captured");
    if (interaction === "degraded") reasons.push("interaction degraded");
    console.error(chalk.red(`Session not healthy: ${reasons.join(", ")}.`));
    return 1;
  }
  console.log(chalk.green("Session healthy."));
  return 0;
}

async function coldStatus(opts: StatusOptions): Promise<number> {
  await assertNoDaemon("status", opts.profile);
  // Default to headed — chatgpt.com challenges headless Chromium even
  // with a warmed-up profile. Pass --headless to override.
  const session = await openSession({
    headed: !opts.headless,
    profilePath: opts.profile,
  });
  const spinner = ora("Checking session…").start();
  try {
    await goHome(session.page);
    if (!(await isLoggedIn(session.page, 8_000))) {
      spinner.fail("Not signed in.");
      throw new NotLoggedInError();
    }
    const auth = await fetchAuthSession(session.page);
    const me = await fetchMe(session.page, auth?.accessToken);
    const models = await fetchModels(session.page, auth?.accessToken);
    spinner.succeed("Session healthy.");

    const email = auth?.user?.email ?? me?.email ?? "(unknown)";
    const plan = detectPlan(me);
    const proSlug = findProSlug(models);
    const expires = auth?.expires ? new Date(auth.expires).toLocaleString() : "(unknown)";

    console.log("");
    console.log(chalk.bold("ChatGPT Pro CLI status"));
    console.log(`  ${chalk.bold("Account:")}      ${email}`);
    console.log(`  ${chalk.bold("Plan:")}         ${plan}`);
    console.log(`  ${chalk.bold("Token until:")} ${expires}`);
    console.log(`  ${chalk.bold("Models:")}       ${models.length} available`);
    if (proSlug) {
      console.log(`  ${chalk.bold("GPT-5.5 Pro:")} ${chalk.green("✓")} (slug: ${proSlug})`);
    } else {
      console.log(`  ${chalk.bold("GPT-5.5 Pro:")} ${chalk.yellow("not detected")}`);
    }
    return 0;
  } finally {
    await session.close();
  }
}
