/**
 * Daemon wire format. Kept tiny and string-only so the client and server
 * can stay decoupled — the daemon process and the CLI are separate Node
 * processes, but they share this file.
 *
 * Auth model: a 256-bit random token is generated when the daemon starts
 * and stored in `daemon.json` (mode 600 on Unix). Every request must
 * carry it in the `Authorization: Bearer <token>` header. The daemon
 * binds to 127.0.0.1 only, so the threat model is "another local user
 * on this box reads daemon.json" — the file mode + loopback bind cover
 * the cases that matter.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { CGPRO_HOME, ensureDirs } from "../store/paths.js";

// CGPRO_DAEMON_JSON overrides the registration file path — lets a second
// daemon instance (C-073 ADR 004 second browser lane) register at a
// distinct path instead of colliding with the default single-lane file.
// Unset (the default) reproduces the prior hardcoded behavior exactly.
export const DAEMON_FILE = process.env.CGPRO_DAEMON_JSON || join(CGPRO_HOME, "daemon.json");
export const DAEMON_LOG = join(CGPRO_HOME, "logs", "daemon.log");

export interface DaemonInfo {
  version: 1;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  profile?: string;
  background: boolean;
}

export function readDaemonInfo(): DaemonInfo | null {
  if (!existsSync(DAEMON_FILE)) return null;
  try {
    const raw = readFileSync(DAEMON_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DaemonInfo>;
    if (
      parsed.version !== 1 ||
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.token !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      pid: parsed.pid,
      port: parsed.port,
      token: parsed.token,
      startedAt: parsed.startedAt ?? "",
      profile: parsed.profile,
      background: parsed.background ?? true,
    };
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  ensureDirs();
  writeFileSync(DAEMON_FILE, JSON.stringify(info, null, 2), "utf-8");
  // Best-effort permission tighten — no-op on Windows.
  try {
    chmodSync(DAEMON_FILE, 0o600);
  } catch {
    /* swallow */
  }
}

export function clearDaemonInfo(): void {
  if (existsSync(DAEMON_FILE)) {
    try {
      unlinkSync(DAEMON_FILE);
    } catch {
      /* swallow */
    }
  }
}

/** True if the OS-level process exists (not necessarily our daemon). */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- request payloads ------------------------------------------------

export interface AskRequest {
  prompt: string;
  model?: string;
  web?: boolean;
  connector?: string;
  images?: string[];
  conversationId?: string;
  /** Stable facade invocation ID used for exact cancellation. */
  invocationId?: string;
  /** Per-turn cap. Daemon clamps to 14,400 seconds. */
  timeoutSec: number;
}

export interface AskSummary {
  conversationId: string | null;
  finalText: string;
}

export interface StatusResponse {
  pid: number;
  startedAt: string;
  uptimeSec: number;
  background: boolean;
  profile?: string;
  busy: boolean;
  /** Authenticated account facts captured when the daemon starts. */
  account?: {
    email?: string;
    plan: string;
    proModelAvailable: boolean;
  };
  /** Conversation id of the current turn, if any. */
  currentConversation?: string | null;
  /** UUID of the last completed turn, if any. */
  lastConversation?: string | null;
}

export interface ReloadResponse {
  ok: boolean;
  conversationId: string;
  queued?: boolean;
  working?: boolean;
  finalText?: string;
}
