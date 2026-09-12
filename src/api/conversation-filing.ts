import { createHash } from "node:crypto";
import type { Page } from "patchright";
import { backendApiFetch, fetchAuthSessionInPage } from "../browser/chatgpt.js";

export interface FilingProof {
  status: "verified" | "mismatch" | "unavailable";
  conversationId: string;
  projectId: string | null;
  accountVerified: boolean;
  preSubmitVerified?: boolean;
  fingerprint?: string;
  archived?: boolean;
}

/** Hash message identity/content only: reads and archive flags must not change it. */
export function conversationFingerprint(body: Record<string, any>): string {
  const mapping = body.mapping;
  if (!mapping || typeof mapping !== "object" || !body.current_node) throw new Error("conversation content unavailable");
  const branch: unknown[] = [];
  const seen = new Set<string>();
  let id: string | null = body.current_node;
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = mapping[id];
    if (!node) throw new Error("conversation branch incomplete");
    const m = node.message;
    if (m) branch.push({ id: m.id, author: m.author, content: m.content, status: m.status, end_turn: m.end_turn });
    id = node.parent ?? null;
  }
  if (!branch.length || id) throw new Error("conversation branch invalid");
  return createHash("sha256").update(JSON.stringify(branch)).digest("hex");
}

export async function requireAccount(page: Page, expectedEmail: string): Promise<void> {
  const auth = await fetchAuthSessionInPage(page, 10_000);
  if (!expectedEmail || auth?.user?.email?.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new Error("ChatGPT account identity mismatch");
  }
}

export async function verifyFiling(page: Page, id: string, projectId: string, expectedEmail: string): Promise<FilingProof> {
  const result: FilingProof = { status: "unavailable", conversationId: id, projectId: null, accountVerified: false };
  try {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^g-p-[A-Za-z0-9_-]+$/.test(projectId)) return result;
    await requireAccount(page, expectedEmail);
    result.accountVerified = true;
    const response = await backendApiFetch(page, `/backend-api/conversation/${id}`, { timeoutMs: 15_000 });
    if (!response.ok || !response.body || typeof response.body !== "object") return result;
    const body = response.body as Record<string, any>;
    result.projectId = typeof body.gizmo_id === "string" ? body.gizmo_id : null;
    result.archived = body.is_archived === true;
    result.fingerprint = conversationFingerprint(body);
    result.status = result.projectId === projectId ? "verified" : "mismatch";
    return result;
  } catch {
    // Filing is secondary to the already completed answer; the caller retains both.
    return result;
  }
}

export async function archiveSavedConversation(page: Page, input: {
  conversationId: string; projectId: string; expectedEmail: string; fingerprint: string;
}): Promise<FilingProof> {
  const before = await verifyFiling(page, input.conversationId, input.projectId, input.expectedEmail);
  if (before.status !== "verified" || before.fingerprint !== input.fingerprint) {
    throw new Error("archive refused: account, Project or conversation content changed");
  }
  if (!before.archived) {
    // Observed from ChatGPT's Archive action and restoration trial, 2026-09-12.
    const response = await backendApiFetch(page, `/backend-api/conversation/${input.conversationId}`, {
      method: "PATCH", body: { is_archived: true }, timeoutMs: 15_000,
    });
    if (!response.ok) throw new Error(`archive HTTP ${response.status}`);
  }
  const after = await verifyFiling(page, input.conversationId, input.projectId, input.expectedEmail);
  if (!before.archived && after.accountVerified && after.fingerprint && (after.fingerprint !== input.fingerprint || after.projectId !== before.projectId)) {
    // A human continuation raced our PATCH. Undo only this call's archive.
    const restored = await backendApiFetch(page, `/backend-api/conversation/${input.conversationId}`, {
      method: "PATCH", body: { is_archived: false }, timeoutMs: 15_000,
    });
    const restoredProof = restored.ok
      ? await verifyFiling(page, input.conversationId, input.projectId, input.expectedEmail) : null;
    if (!restoredProof?.accountVerified || restoredProof.archived !== false || !restoredProof.fingerprint) {
      throw new Error("archive race: restoration not verified");
    }
    throw new Error("archive refused: conversation changed during archival; archive reverted");
  }
  if (after.status !== "verified" || !after.archived || after.fingerprint !== input.fingerprint) {
    throw new Error("archive readback not verified");
  }
  return after;
}
