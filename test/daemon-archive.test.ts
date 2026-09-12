import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Session } from "../src/browser/session.js";
vi.mock("../src/api/conversation-filing.js", () => ({ archiveSavedConversation: vi.fn() }));
import { archiveSavedConversation } from "../src/api/conversation-filing.js";
import { AskQueue, PreAdmissionReaderBudget, handleRequest, type ServerState } from "../src/daemon/server.js";
const identity = { conversationId: "6aa51e0c-0688-83ec-a868-8dffde427046", projectId: "g-p-fixture", expectedEmail: "fixture@example.com", fingerprint: "a".repeat(64) };
function state(): ServerState {
  return { session: { page: {} } as Session, token: "fixture", startedAt: new Date(), background: true, queue: new AskQueue(8, 60_000), readerBudget: new PreAdmissionReaderBudget(8), askInFlight: false, currentInvocation: null, currentRunner: null, currentConversation: null, lastConversation: null, reloadConversation: null };
}
async function request(s: ServerState, body: unknown = identity, token = "fixture") {
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/archive-saved", headers: { authorization: `Bearer ${token}` }, setEncoding() {} });
  const result = { status: 0, body: "" };
  const res = Object.assign(new EventEmitter(), { writeHead(code: number) { result.status = code; }, end(text: string) { result.body = text; } });
  const done = handleRequest(req as IncomingMessage, res as ServerResponse, s);
  req.emit("data", JSON.stringify(body)); req.emit("end"); await done;
  return result;
}
beforeEach(() => vi.resetAllMocks());
it("requires the existing daemon token before archive work", async () => {
  expect((await request(state(), identity, "wrong")).status).toBe(401);
  expect(archiveSavedConversation).not.toHaveBeenCalled();
});
it.each([{ ...identity, conversationId: [identity.conversationId] }, { ...identity, fingerprint: "bad" }, { ...identity, expectedEmail: {} }])("rejects malformed identity before browser work", async body => {
  expect((await request(state(), body)).status).toBe(400);
  expect(archiveSavedConversation).not.toHaveBeenCalled();
});
it("never displaces a busy ask and releases the queue after a failure", async () => {
  const s = state(); s.queue.tryAcquire();
  expect((await request(s)).status).toBe(409);
  expect(archiveSavedConversation).not.toHaveBeenCalled();
  s.queue.release();
  vi.mocked(archiveSavedConversation).mockRejectedValue(new Error("changed"));
  expect((await request(s)).status).toBe(409);
  expect(s.queue.tryAcquire()).toBe(true); s.queue.release();
});
it("returns verified archive metadata and frees the queue", async () => {
  const s = state();
  vi.mocked(archiveSavedConversation).mockResolvedValue({ status: "verified", conversationId: identity.conversationId, projectId: identity.projectId, accountVerified: true, archived: true });
  const result = await request(s);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.body).archived).toBe(true);
  expect(s.queue.tryAcquire()).toBe(true); s.queue.release();
});
