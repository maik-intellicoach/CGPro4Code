import { beforeEach, expect, it, vi } from "vitest";
import type { Page } from "patchright";
vi.mock("../src/browser/chatgpt.js", () => ({ backendApiFetch: vi.fn(), fetchAuthSessionInPage: vi.fn() }));
import { backendApiFetch, fetchAuthSessionInPage } from "../src/browser/chatgpt.js";
import { archiveSavedConversation, conversationFingerprint, requireAccount, verifyFiling } from "../src/api/conversation-filing.js";
const page = {} as Page;
const id = "6aa51e0c-0688-83ec-a868-8dffde427046";
const project = "g-p-fixture";
function conversation(text = "saved answer", archived = false) {
  return { gizmo_id: project, is_archived: archived, current_node: "a", mapping: {
    a: { parent: "u", message: { id: "a", author: { role: "assistant" }, content: { parts: [text] }, status: "finished_successfully", end_turn: true } },
    u: { parent: null, message: { id: "u", author: { role: "user" }, content: { parts: ["prompt"] } } },
  } };
}
const input = () => ({ conversationId: id, projectId: project, expectedEmail: "fixture@example.com", fingerprint: conversationFingerprint(conversation()) });
const reply = (body: unknown, status = 200) => ({ ok: status === 200, status, body }) as Awaited<ReturnType<typeof backendApiFetch>>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchAuthSessionInPage).mockResolvedValue({ user: { email: "fixture@example.com" } } as any);
});
it("hash ignores archive/read metadata but detects changed output and new branches", () => {
  expect(conversationFingerprint(conversation())).toBe(conversationFingerprint({ ...conversation("saved answer", true), update_time: 99 }));
  expect(conversationFingerprint(conversation())).not.toBe(conversationFingerprint(conversation("new answer")));
  const changed = conversation(); changed.mapping.a.message.id = "new-turn";
  expect(conversationFingerprint(changed)).not.toBe(input().fingerprint);
});
it("refuses incomplete or cyclic snapshots", () => {
  expect(() => conversationFingerprint({ mapping: {}, current_node: "missing" })).toThrow();
  const cycle = conversation(); cycle.mapping.a.parent = "a";
  expect(() => conversationFingerprint(cycle)).toThrow();
});
it("fails before submission on wrong account without reading conversation", async () => {
  vi.mocked(fetchAuthSessionInPage).mockResolvedValue({ user: { email: "other@example.com" } } as any);
  await expect(requireAccount(page, input().expectedEmail)).rejects.toThrow("account identity mismatch");
  expect(backendApiFetch).not.toHaveBeenCalled();
});
it("reports Project mismatch separately from completed content", async () => {
  vi.mocked(backendApiFetch).mockResolvedValue(reply({ ...conversation(), gizmo_id: "g-p-other" }));
  expect(await verifyFiling(page, id, project, input().expectedEmail)).toMatchObject({ status: "mismatch", accountVerified: true, projectId: "g-p-other" });
  await expect(archiveSavedConversation(page, input())).rejects.toThrow("archive refused");
  expect(vi.mocked(backendApiFetch).mock.calls.every(c => c[2]?.method !== "PATCH")).toBe(true);
});
it("retains unavailable proof without turning a completed answer into failure", async () => {
  vi.mocked(backendApiFetch).mockRejectedValue(new Error("network"));
  expect(await verifyFiling(page, id, project, input().expectedEmail)).toMatchObject({ status: "unavailable", accountVerified: true });
});
it("refuses a continued chat before any mutation", async () => {
  vi.mocked(backendApiFetch).mockResolvedValue(reply(conversation("new answer")));
  await expect(archiveSavedConversation(page, input())).rejects.toThrow("archive refused");
  expect(backendApiFetch).toHaveBeenCalledTimes(1);
});
it("archives with actual readback and is idempotent when already archived", async () => {
  vi.mocked(backendApiFetch).mockResolvedValueOnce(reply(conversation())).mockResolvedValueOnce(reply({})).mockResolvedValue(reply(conversation("saved answer", true)));
  expect(await archiveSavedConversation(page, input())).toMatchObject({ archived: true, status: "verified" });
  expect(vi.mocked(backendApiFetch).mock.calls.filter(c => c[2]?.method === "PATCH")).toHaveLength(1);
  await archiveSavedConversation(page, input());
  expect(vi.mocked(backendApiFetch).mock.calls.filter(c => c[2]?.method === "PATCH")).toHaveLength(1);
});
it("restores our archive if a continuation races the write", async () => {
  vi.mocked(backendApiFetch).mockResolvedValueOnce(reply(conversation())).mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply(conversation("new answer", true))).mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply(conversation("new answer", false)));
  await expect(archiveSavedConversation(page, input())).rejects.toThrow("archive reverted");
  expect(vi.mocked(backendApiFetch).mock.calls.filter(c => c[2]?.method === "PATCH").at(-1)?.[2]?.body).toEqual({ is_archived: false });
});
