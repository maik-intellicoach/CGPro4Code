import { beforeEach, expect, it, vi } from "vitest";
import type { Page } from "patchright";
vi.mock("../src/browser/chatgpt.js", () => ({ backendApiFetch: vi.fn(), fetchAuthSessionInPage: vi.fn(), fetchAuthSessionOutcome: vi.fn() }));
import { backendApiFetch, fetchAuthSessionInPage, fetchAuthSessionOutcome } from "../src/browser/chatgpt.js";
import { archiveSavedConversation, conversationFingerprint, requireAccount, verifyFiling } from "../src/api/conversation-filing.js";
import { AccountRequirementError, classifyInteractionFailure } from "../src/errors.js";
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
  vi.mocked(fetchAuthSessionOutcome).mockImplementation(async (p, t) => {
    const s = await fetchAuthSessionInPage(p, t);
    if (!s) return { ok: false, code: "evaluation_failure" };
    return { ok: true, session: s };
  });
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

it("distinguishes success on exact email match", async () => {
  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: true,
    session: { user: { email: "operator@example.com" } } as any,
  });
  await expect(requireAccount(page, "operator@example.com")).resolves.toBeUndefined();
});

it("distinguishes case-insensitive match", async () => {
  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: true,
    session: { user: { email: "Operator@Example.Com" } } as any,
  });
  await expect(requireAccount(page, "operator@example.com")).resolves.toBeUndefined();
});

it("distinguishes mismatched known email", async () => {
  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: true,
    session: { user: { email: "wrong@example.com" } } as any,
  });
  let thrown: unknown;
  try {
    await requireAccount(page, "expected@example.com");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AccountRequirementError);
  expect((thrown as AccountRequirementError).code).toBe("account_identity_mismatch");
  expect(classifyInteractionFailure(thrown)).toEqual({ code: "account_identity_mismatch" });
});

it("distinguishes empty expected identity", async () => {
  let thrown: unknown;
  try {
    await requireAccount(page, "");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AccountRequirementError);
  expect((thrown as AccountRequirementError).code).toBe("account_expected_identity_missing");
  expect(classifyInteractionFailure(thrown)).toEqual({ code: "account_expected_identity_missing" });
});

it("distinguishes absent identity", async () => {
  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: true,
    session: { user: {} } as any,
  });
  let thrown: unknown;
  try {
    await requireAccount(page, "expected@example.com");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AccountRequirementError);
  expect((thrown as AccountRequirementError).code).toBe("account_identity_absent");
  expect(classifyInteractionFailure(thrown)).toEqual({ code: "account_identity_absent" });
});

it("distinguishes HTTP failure", async () => {
  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: false,
    code: "http_failure",
    httpStatus: 503,
  });
  let thrown: unknown;
  try {
    await requireAccount(page, "expected@example.com");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AccountRequirementError);
  expect((thrown as AccountRequirementError).code).toBe("account_http_failure");
  expect((thrown as AccountRequirementError).httpStatus).toBe(503);
  expect(classifyInteractionFailure(thrown)).toEqual({ code: "account_http_failure", httpStatus: 503 });
});

it("distinguishes abort timeout", async () => {
  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: false,
    code: "timeout",
  });
  let thrown: unknown;
  try {
    await requireAccount(page, "expected@example.com");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AccountRequirementError);
  expect((thrown as AccountRequirementError).code).toBe("account_abort_timeout");
  expect(classifyInteractionFailure(thrown)).toEqual({ code: "account_abort_timeout" });
});

it("distinguishes parse error", async () => {
  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: false,
    code: "invalid_json",
  });
  let thrown: unknown;
  try {
    await requireAccount(page, "expected@example.com");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AccountRequirementError);
  expect((thrown as AccountRequirementError).code).toBe("account_parse_error");
  expect(classifyInteractionFailure(thrown)).toEqual({ code: "account_parse_error" });
});

it("distinguishes evaluation rejection", async () => {
  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: false,
    code: "evaluation_failure",
  });
  let thrown: unknown;
  try {
    await requireAccount(page, "expected@example.com");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AccountRequirementError);
  expect((thrown as AccountRequirementError).code).toBe("account_evaluation_rejection");
  expect(classifyInteractionFailure(thrown)).toEqual({ code: "account_evaluation_rejection" });
});

it("never includes synthetic secret canary in classified diagnostics or error messages", async () => {
  const canarySecret = "CANARY_TOKEN_secret_xyz123456789";
  const canaryEmail = "canary-secret-identity@private-domain.test";

  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: true,
    session: { user: { email: canaryEmail }, accessToken: canarySecret } as any,
  });

  let mismatchError: unknown;
  try {
    await requireAccount(page, "other-canary@private-domain.test");
  } catch (err) {
    mismatchError = err;
  }

  const classifiedMismatch = classifyInteractionFailure(mismatchError);
  const classifiedStr = JSON.stringify(classifiedMismatch);
  expect(classifiedStr).not.toContain(canarySecret);
  expect(classifiedStr).not.toContain(canaryEmail);
  expect(classifiedStr).not.toContain("private-domain");

  expect((mismatchError as Error).message).not.toContain(canarySecret);
  expect((mismatchError as Error).message).not.toContain(canaryEmail);

  // Unclassified error fallback also does not leak
  const contaminated = new Error(`ChatGPT account identity mismatch: ${canarySecret}`);
  const classifiedContaminated = classifyInteractionFailure(contaminated);
  expect(classifiedContaminated.code).toBe("unclassified_error");
  expect(JSON.stringify(classifiedContaminated)).not.toContain(canarySecret);
});

it("confirms fetchAuthSessionInPage callers receive session-or-null across all outcomes", async () => {
  const actualChatgpt = await vi.importActual<typeof import("../src/browser/chatgpt.js")>("../src/browser/chatgpt.js");

  // 1. Success returns session
  const successPage = {
    evaluate: vi.fn().mockResolvedValue({
      ok: true,
      payload: { user: { id: "user-1", email: "auth@example.com" }, accessToken: "tok" },
    }),
  } as unknown as Page;
  const outcomeSuccess = await actualChatgpt.fetchAuthSessionOutcome(successPage, 1000);
  expect(outcomeSuccess.ok).toBe(true);
  const sessionSuccess = await actualChatgpt.fetchAuthSessionInPage(successPage, 1000);
  expect(sessionSuccess).not.toBeNull();
  expect(sessionSuccess?.user?.email).toBe("auth@example.com");

  // 2. HTTP failure returns http_failure outcome with status only, and null session
  const httpFailurePage = {
    evaluate: vi.fn().mockResolvedValue({
      ok: false,
      code: "http_failure",
      httpStatus: 401,
    }),
  } as unknown as Page;
  const outcomeHttp = await actualChatgpt.fetchAuthSessionOutcome(httpFailurePage, 1000);
  expect(outcomeHttp).toEqual({ ok: false, code: "http_failure", httpStatus: 401 });
  const sessionHttp = await actualChatgpt.fetchAuthSessionInPage(httpFailurePage, 1000);
  expect(sessionHttp).toBeNull();

  // 3. Timeout returns timeout outcome and null session
  const timeoutPage = {
    evaluate: vi.fn().mockResolvedValue({
      ok: false,
      code: "timeout",
    }),
  } as unknown as Page;
  const outcomeTimeout = await actualChatgpt.fetchAuthSessionOutcome(timeoutPage, 1000);
  expect(outcomeTimeout).toEqual({ ok: false, code: "timeout" });
  const sessionTimeout = await actualChatgpt.fetchAuthSessionInPage(timeoutPage, 1000);
  expect(sessionTimeout).toBeNull();

  // 4. Invalid JSON returns invalid_json outcome and null session
  const invalidJsonPage = {
    evaluate: vi.fn().mockResolvedValue({
      ok: false,
      code: "invalid_json",
    }),
  } as unknown as Page;
  const outcomeJson = await actualChatgpt.fetchAuthSessionOutcome(invalidJsonPage, 1000);
  expect(outcomeJson).toEqual({ ok: false, code: "invalid_json" });
  const sessionJson = await actualChatgpt.fetchAuthSessionInPage(invalidJsonPage, 1000);
  expect(sessionJson).toBeNull();

  // 5. Evaluation rejection returns evaluation_failure outcome and null session
  const evalFailurePage = {
    evaluate: vi.fn().mockRejectedValue(new Error("Context destroyed")),
  } as unknown as Page;
  const outcomeEval = await actualChatgpt.fetchAuthSessionOutcome(evalFailurePage, 1000);
  expect(outcomeEval).toEqual({ ok: false, code: "evaluation_failure" });
  const sessionEval = await actualChatgpt.fetchAuthSessionInPage(evalFailurePage, 1000);
  expect(sessionEval).toBeNull();
});

it("proves legacy object containing accessToken but no user.email is returned unchanged by fetchAuthSessionInPage, while requireAccount refuses", async () => {
  const actualChatgpt = await vi.importActual<typeof import("../src/browser/chatgpt.js")>("../src/browser/chatgpt.js");
  const legacySession = {
    accessToken: "tok-legacy-12345",
    user: { id: "user-legacy-id" }, // no email
  };
  const pageWithLegacy = {
    evaluate: vi.fn().mockResolvedValue({
      ok: true,
      payload: legacySession,
    }),
  } as unknown as Page;

  // fetchAuthSessionOutcome preserves the parsed session
  const outcome = await actualChatgpt.fetchAuthSessionOutcome(pageWithLegacy, 1000);
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.session).toEqual(legacySession);
    expect(outcome.session.accessToken).toBe("tok-legacy-12345");
  }

  // fetchAuthSessionInPage returns the parsed session unchanged
  const inPageSession = await actualChatgpt.fetchAuthSessionInPage(pageWithLegacy, 1000);
  expect(inPageSession).toEqual(legacySession);

  // requireAccount alone refuses the session missing user.email
  vi.mocked(fetchAuthSessionOutcome).mockResolvedValueOnce({
    ok: true,
    session: legacySession as any,
  });
  let thrown: unknown;
  try {
    await requireAccount(pageWithLegacy, "expected@example.com");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AccountRequirementError);
  expect((thrown as AccountRequirementError).code).toBe("account_identity_absent");
  expect(classifyInteractionFailure(thrown)).toEqual({ code: "account_identity_absent" });
});

it("classifies aborted body parsing during r.json() as timeout, retaining invalid-json for actual parse errors", async () => {
  const actualChatgpt = await vi.importActual<typeof import("../src/browser/chatgpt.js")>("../src/browser/chatgpt.js");

  const mockPage = {
    evaluate: vi.fn().mockImplementation(async (fn: any, timeout: any) => {
      return fn(timeout);
    }),
  } as unknown as Page;

  const originalFetch = globalThis.fetch;
  try {
    // 1. Fetch resolves headers, but r.json() aborts (AbortError) at deadline
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(abortErr),
    }) as any;

    const outcomeTimeout = await actualChatgpt.fetchAuthSessionOutcome(mockPage, 5000);
    expect(outcomeTimeout).toEqual({ ok: false, code: "timeout" });

    // 2. Fetch resolves headers, but body is invalid JSON (SyntaxError)
    const syntaxErr = new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(syntaxErr),
    }) as any;

    const outcomeInvalidJson = await actualChatgpt.fetchAuthSessionOutcome(mockPage, 5000);
    expect(outcomeInvalidJson).toEqual({ ok: false, code: "invalid_json" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
