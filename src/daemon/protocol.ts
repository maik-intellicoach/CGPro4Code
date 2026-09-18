import type { FilingProof } from "../api/conversation-filing.js";
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
// CGPRO_DAEMON_LOG overrides the shared daemon log path — lets a test run or
// a second lane write its own file instead of appending to the live log.
// Unset (the default) reproduces the prior hardcoded behavior exactly.
export const DAEMON_LOG = process.env.CGPRO_DAEMON_LOG || join(CGPRO_HOME, "logs", "daemon.log");
/** Directory for daemon logs. stderr from a daemon child lands here too. */
export const DAEMON_LOG_DIR = process.env.CGPRO_DAEMON_LOG_DIR || join(CGPRO_HOME, "logs");

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

export function clearDaemonInfo(expectedPid?: number): void {
  if (existsSync(DAEMON_FILE)) {
    if (expectedPid !== undefined) {
      const current = readDaemonInfo();
      if (!current || current.pid !== expectedPid) return;
    }
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
  deepResearch?: boolean;
  connector?: string;
  images?: string[];
  conversationId?: string;
  /** ChatGPT Project id (`g-p-...`) for new conversations. */
  gizmoId?: string;
  /** Stable project URL slug; may be used without an id. */
  gizmoShortUrl?: string;
  /** Stable facade invocation ID used for exact cancellation. */
  invocationId?: string;
  expectedAccountEmail?: string;
  /** Per-turn cap. Daemon clamps to 14,400 seconds. */
  timeoutSec: number;
}

export interface AskSummary {
  filing?: FilingProof;
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
  interaction?: InteractionStatus;
  /** Per-tab occupancy (CGPRO_DAEMON_SLOTS; total stays 1 unless configured). */
  slots?: {
    total: number;
    busy: number;
    free: number;
    items: Array<{
      slot: number;
      busy: boolean;
      invocationId: string | null;
      conversationId: string | null;
      interaction: InteractionStatus;
    }>;
  };
}

export interface InteractionStatus {
  state: "unknown" | "ready" | "degraded";
  checkedAt?: string;
  failureCode?: string;
}

export interface PreflightRequest {
  model: "gpt-6-pro";
  connector: string;
  gizmoId: string;
  gizmoShortUrl?: string;
  expectedAccountEmail: string;
  /** Deliver and measure this prompt without submitting it (P-035 2026-09-18). */
  probePrompt?: string;
}

export interface ReloadResponse {
  ok: boolean;
  conversationId: string;
  queued?: boolean;
  working?: boolean;
  finalText?: string;
}
