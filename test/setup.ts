import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unit tests must never append to the live daemon log: a test that boots an
// in-process server would otherwise inject fake `ask turn failed` lines into
// the shared file every lane writes to, corrupting incident reads. Point the
// log at a per-run temp directory before any src module resolves DAEMON_LOG.
const logDir = mkdtempSync(join(tmpdir(), "cgpro-test-log-"));
process.env.CGPRO_DAEMON_LOG_DIR = logDir;
process.env.CGPRO_DAEMON_LOG = join(logDir, "daemon.log");
