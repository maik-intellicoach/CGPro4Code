import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "patchright";
import type { Session } from "../src/browser/session.js";
import type { StreamEvent } from "../src/core/stream.js";
import { ConnectorEvidenceRateLimitError, PreSubmitInteractionError, TurnTimeoutError } from "../src/errors.js";

const requireAccount = vi.fn();
const verifyFiling = vi.fn();
vi.mock("../src/api/conversation-filing.js", () => ({
  requireAccount: (...args: unknown[]) => requireAccount(...args),
  verifyFiling: (...args: unknown[]) => verifyFiling(...args),
}));
const goHome = vi.fn();
const isLoggedIn = vi.fn();
const currentConversationId = vi.fn();
const latestAssistantModelSlug = vi.fn();
const openConversation = vi.fn();
const clearComposer = vi.fn();
const assertPreflightDraftSafe = vi.fn();
const readLatestAssistantText = vi.fn();
const sendPrompt = vi.fn();
const setConnector = vi.fn();
const probePromptDelivery = vi.fn();
const ensureProSixMaximum = vi.fn();
const setDeepResearch = vi.fn();
const setWebSearch = vi.fn();
const stopCurrentTurn = vi.fn();
const waitForComposerHydrated = vi.fn();
const waitTurnComplete = vi.fn();
const fetchLatestTurnConnectorState = vi.fn();
const fetchLatestNativeResearchReport = vi.fn();
const fetchNativeResearchUserNodes = vi.fn();

vi.mock("../src/browser/chatgpt.js", () => ({
  requireSelector: vi.fn(async () => ({})),
  goHome: (...args: unknown[]) => goHome(...args),
  isLoggedIn: (...args: unknown[]) => isLoggedIn(...args),
}));
vi.mock("../src/browser/conversation.js", () => ({
  ensureProSixMaximum: (...args: unknown[]) => ensureProSixMaximum(...args),
  clearComposer: (...args: unknown[]) => clearComposer(...args),
  assertPreflightDraftSafe: (...args: unknown[]) => assertPreflightDraftSafe(...args),
  currentConversationId: (...args: unknown[]) => currentConversationId(...args),
  latestAssistantModelSlug: (...args: unknown[]) => latestAssistantModelSlug(...args),
  openConversation: (...args: unknown[]) => openConversation(...args),
  readLatestAssistantText: (...args: unknown[]) => readLatestAssistantText(...args),
  sendPrompt: (...args: unknown[]) => sendPrompt(...args),
  setConnector: (...args: unknown[]) => setConnector(...args),
  // r36: the connector phase now runs only on the probe path, so this file's
  // one connector-phase case drives a probe preflight. The orchestrator imports
  // `probePromptDelivery` unconditionally, so the mock factory must name it even
  // though that case fails inside `setConnector` before the probe is reached.
  probePromptDelivery: (...args: unknown[]) => probePromptDelivery(...args),
  setDeepResearch: (...args: unknown[]) => setDeepResearch(...args),
  setWebSearch: (...args: unknown[]) => setWebSearch(...args),
  stopCurrentTurn: (...args: unknown[]) => stopCurrentTurn(...args),
  // r13 moved the bounded composer-hydration wait into conversation.ts; the
  // preflight still calls it, so the mock factory must name it.
  waitForComposerHydrated: (...args: unknown[]) => waitForComposerHydrated(...args),
  waitTurnComplete: (...args: unknown[]) => waitTurnComplete(...args),
}));
vi.mock("../src/api/conversations.js", () => ({
  fetchNativeResearchUserNodes: (...args: unknown[]) => fetchNativeResearchUserNodes(...args),
  fetchLatestNativeResearchReport: (...args: unknown[]) => fetchLatestNativeResearchReport(...args),
  fetchLatestTurnConnectorState: (...args: unknown[]) => fetchLatestTurnConnectorState(...args),
}));

const { runAskOnSession, runInteractionPreflight } = await import("../src/core/orchestrator.js");

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function session(): Session {
  return {
    context: {},
    page: { url: () => "https://chatgpt.com/", locator: () => ({ count: async () => 1 }) } as unknown as Page,
    close: vi.fn(async () => {}),
  } as unknown as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  assertPreflightDraftSafe.mockReset().mockResolvedValue(undefined);
  requireAccount.mockReset().mockResolvedValue(undefined);
  verifyFiling.mockReset().mockResolvedValue({ status: "unavailable", conversationId: "id", projectId: null, accountVerified: false });
  fetchNativeResearchUserNodes.mockResolvedValue(new Set());
  fetchLatestNativeResearchReport.mockResolvedValue(null);
  goHome.mockResolvedValue(undefined);
  isLoggedIn.mockResolvedValue(true);
  openConversation.mockResolvedValue(undefined);
  ensureProSixMaximum.mockResolvedValue({ model: "gpt-6-pro", power: 4 });
  sendPrompt.mockImplementation(async (_page, _prompt, _preserve, _cancelled, guard) => { await guard?.(); return 0; });
  setWebSearch.mockResolvedValue(true);
  setConnector.mockResolvedValue(undefined);
  probePromptDelivery.mockReset().mockResolvedValue({ requestedChars: 1, arrivedChars: 1, complete: true });
  setDeepResearch.mockResolvedValue(true);
  stopCurrentTurn.mockResolvedValue("");
  currentConversationId.mockReturnValue(null);
  latestAssistantModelSlug.mockResolvedValue(null);
  readLatestAssistantText.mockResolvedValue("");
  fetchLatestTurnConnectorState.mockReset().mockResolvedValue({
    currentUserNodeId: "new-user",
    calls: [],
    currentRole: "assistant",
    currentStatus: "finished_successfully",
    currentEndTurn: true,
    currentContentType: "text",
    currentIsThinkingPreamble: false,
  });
});

describe("runInteractionPreflight cleanup", () => {
  function preflightSession(): Session {
    return {
      ...session(),
      page: { keyboard: { press: vi.fn(async () => {}) } } as unknown as Page,
    } as Session;
  }

  const options = {
    model: "gpt-6-pro" as const,
    connector: "fixture-connector",
    gizmoId: "g-p-fixture",
    expectedAccountEmail: "fixture@example.com",
  };

  it("fails readiness when final cleanup cannot restore a clean composer", async () => {
    clearComposer
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup composer unavailable"));
    await expect(runInteractionPreflight(options, preflightSession())).rejects.toThrow(
      "interaction preflight cleanup failed",
    );
  });

  it("preserves the original error while reporting cleanup and the failed verification phase", async () => {
    const original = new Error("private connector/account detail");
    const onPhase = vi.fn();
    setConnector.mockRejectedValueOnce(original);
    goHome.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("cleanup navigation failed"));
    // r36: the ordinary preflight no longer runs the connector phase, so the
    // connector-phase failure this case pins is driven by the probe path, where
    // that phase still runs unchanged (same timeline, same expected calls).
    await expect(runInteractionPreflight({ ...options, probePrompt: "probe" }, preflightSession(), onPhase))
      .rejects.toBe(original);
    expect(onPhase.mock.calls.map(([phase, failed]) => [phase, failed])).toEqual([
      ["home", undefined], ["login", undefined], ["account-home", undefined],
      ["project", undefined], ["account-project", undefined], ["composer", undefined],
      ["connector", undefined], ["connector", "connector"], ["cleanup-escape", "connector"],
      ["cleanup-home", "connector"], ["cleanup-home", "connector"],
    ]);
    expect(JSON.stringify(onPhase.mock.calls)).not.toContain("private");
  });

  it("threads model subphases and retains the original failure through outer cleanup", async () => {
    const original = new Error("model failed");
    ensureProSixMaximum.mockImplementationOnce(async (_page, report) => {
      report("model-cleanup-menu-count", "model-slider-focus", { code: "browser_operation_timeout" });
      throw original;
    });
    const onPhase = vi.fn();
    await expect(runInteractionPreflight(options, preflightSession(), onPhase)).rejects.toBe(original);
    expect(onPhase).toHaveBeenCalledWith("model-cleanup-menu-count", "model-slider-focus", { code: "browser_operation_timeout" });
    expect(onPhase).toHaveBeenLastCalledWith("cleanup-composer", "model-slider-focus", { code: "browser_operation_timeout" });
  });

  it("stops cleanup after navigation failure", async () => {
    const onPhase = vi.fn();
    goHome.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(runInteractionPreflight(options, preflightSession(), onPhase)).rejects.toThrow(
      "interaction preflight cleanup failed",
    );
    expect(onPhase).toHaveBeenLastCalledWith("cleanup-home", "cleanup-home", { code: "unclassified_error" });
  });
});

describe("runAskOnSession native Deep Research contract", () => {
  it("accepts verified maximum UI selection while retaining the distinct native engine", async () => {
    currentConversationId.mockReturnValue("native-conversation");
    fetchLatestNativeResearchReport.mockResolvedValue({ text: "Native sourced report", model: "gpt-5-thinking", userNodeId: "new-user" });
    waitTurnComplete.mockImplementationOnce(async (_page, _timeout, _count, _stable, control) => {
      await control.pollEvidence();
      expect(control.externalComplete()).toBe(true);
    });
    const runner = runAskOnSession({ prompt: "research", deepResearch: true, model: "gpt-6-pro", timeoutSec: 1200, headless: false }, session());
    const events = await collect(runner.events);
    await expect(runner.result).resolves.toMatchObject({ finalText: "Native sourced report" });
    expect(readLatestAssistantText).not.toHaveBeenCalled();
    expect(events.some(e => e.type === "tool" && e.name === "model-mismatch")).toBe(false);
    expect(events).toContainEqual({ type: "tool", name: "model-thinking-verified", meta: { model: "gpt-6-pro", power: 4 } });
    expect(events).toContainEqual({ type: "tool", name: "native-research-report", meta: { model: "gpt-5-thinking", source: "widget_state", selectionBasis: "verified-ui-maximum", uiModel: "gpt-6-pro" } });
  });
  it("fails closed when the maximum UI verification fails", async () => {
    ensureProSixMaximum.mockRejectedValueOnce(new Error("6 Pro thinking power did not reach its maximum"));
    const runner = runAskOnSession({ prompt: "research", deepResearch: true, model: "gpt-6-pro", timeoutSec: 1200, headless: false }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("did not reach its maximum");
    expect(waitTurnComplete).not.toHaveBeenCalled();
  });

  it("emits structured pre-submit metadata for a typed control failure", async () => {
    ensureProSixMaximum.mockRejectedValueOnce(new PreSubmitInteractionError(
      "model_control_activation_timeout",
      "model_verification",
      "control did not activate",
    ));
    const runner = runAskOnSession({ prompt: "research", model: "gpt-6-pro", timeoutSec: 1200, headless: false }, session());
    const events = await collect(runner.events);
    await expect(runner.result).rejects.toThrow("control did not activate");
    expect(events).toContainEqual({
      type: "error",
      message: "control did not activate",
      code: "model_control_activation_timeout",
      phase: "model_verification",
      promptSubmitted: false,
    });
  });

  // P-035 2026-09-27. A live ask reaches the facade through the daemon relaying
  // THESE emitter events, so the reset date has to ride the streamed error event
  // itself -- the daemon's later catch emits a second event the facade does not
  // reliably read. The Pro code carries availableAfter + limitText; every other
  // pre-submit code keeps exactly today's shape.
  it("carries the Pro reset date and tooltip on the streamed error event, and leaves other codes unchanged", async () => {
    ensureProSixMaximum.mockRejectedValueOnce(new PreSubmitInteractionError(
      "pro_usage_limit_reached",
      "model_verification",
      "ChatGPT Pro usage limit reached before submission: Limit reached. Try again after Sep 30, 2026.",
      { availableAfter: "2026-09-30T00:00:00+08:00", limitText: "Limit reached. Try again after Sep 30, 2026." },
    ));
    const limited = runAskOnSession({ prompt: "research", model: "gpt-6-pro", timeoutSec: 1200, headless: false }, session());
    const limitedEvents = await collect(limited.events);
    await expect(limited.result).rejects.toThrow("Pro usage limit reached before submission");
    expect(limitedEvents).toContainEqual({
      type: "error",
      message: "ChatGPT Pro usage limit reached before submission: Limit reached. Try again after Sep 30, 2026.",
      code: "pro_usage_limit_reached",
      phase: "model_verification",
      promptSubmitted: false,
      availableAfter: "2026-09-30T00:00:00+08:00",
      limitText: "Limit reached. Try again after Sep 30, 2026.",
    });

    // A different pre-submit code keeps exactly the pre-existing event shape.
    ensureProSixMaximum.mockRejectedValueOnce(new PreSubmitInteractionError(
      "model_control_activation_timeout",
      "model_verification",
      "control did not activate",
    ));
    const other = runAskOnSession({ prompt: "research", model: "gpt-6-pro", timeoutSec: 1200, headless: false }, session());
    const otherEvents = await collect(other.events);
    await expect(other.result).rejects.toThrow("control did not activate");
    const otherError = otherEvents.find((event) => event.type === "error");
    expect(otherError).toEqual({
      type: "error",
      message: "control did not activate",
      code: "model_control_activation_timeout",
      phase: "model_verification",
      promptSubmitted: false,
    });
    expect(otherError).not.toHaveProperty("availableAfter");
    expect(otherError).not.toHaveProperty("limitText");
  });
  it("retains the ordinary planning non-Pro model guard", async () => {
    latestAssistantModelSlug.mockResolvedValue("gpt-5-thinking");
    const runner = runAskOnSession({ prompt: "plan", model: "gpt-6-pro", timeoutSec: 1200, headless: false }, session());
    const events = await collect(runner.events); await runner.result;
    expect(events).toContainEqual({ type: "tool", name: "model-mismatch", meta: { wanted: "gpt-6-pro", got: "gpt-5-thinking" } });
  });
  it("rejects the old report while the new submitted turn has not persisted", async () => {
    currentConversationId.mockReturnValue("resumed-conversation");
    fetchNativeResearchUserNodes.mockResolvedValue(new Set(["old-user"]));
    fetchLatestNativeResearchReport.mockResolvedValue({ text: "Old report", model: "gpt-5-thinking", userNodeId: "old-user" });
    waitTurnComplete.mockImplementationOnce(async (_page, _timeout, _count, _stable, control) => {
      await control.pollEvidence();
      expect(control.externalComplete()).toBe(false);
      expect(await control.confirmComplete()).toBe(false);
      throw new Error("new turn not yet persisted");
    });
    const runner = runAskOnSession({ prompt: "research again", deepResearch: true, timeoutSec: 1200, headless: false }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("new turn not yet persisted");
    expect(fetchNativeResearchUserNodes.mock.invocationCallOrder[0]).toBeLessThan(sendPrompt.mock.invocationCallOrder[0]);
  });
  it("selects native Deep Research before submission and never enables Web Search", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    readLatestAssistantText.mockResolvedValueOnce("researched");
    const activeSession = session();
    const runner = runAskOnSession(
      {
        prompt: "research this",
        deepResearch: true,
        web: true,
        timeoutSec: 1_200,
        headless: false,
      },
      activeSession,
    );

    const events = await collect(runner.events);
    await expect(runner.result).resolves.toMatchObject({ finalText: "researched" });
    expect(setDeepResearch).toHaveBeenCalledWith(activeSession.page, true);
    expect(setWebSearch).not.toHaveBeenCalled();
    expect(setConnector).not.toHaveBeenCalled();
    expect(setDeepResearch.mock.invocationCallOrder[0]).toBeLessThan(sendPrompt.mock.invocationCallOrder[0]);
    expect(clearComposer.mock.invocationCallOrder[0]).toBeLessThan(setDeepResearch.mock.invocationCallOrder[0]);
    expect(sendPrompt.mock.calls[0][2]).toBe(true);
    expect(events).toContainEqual({ type: "tool", name: "deep-research-selected" });
  });

  it("rejects connector plus native Deep Research before touching the browser", async () => {
    const runner = runAskOnSession(
      {
        prompt: "invalid mixed turn",
        connector: "IntelliCoach Context",
        deepResearch: true,
        timeoutSec: 1_200,
        headless: false,
      },
      session(),
    );

    const events = await collect(runner.events);
    await expect(runner.result).rejects.toThrow("native Deep Research and connectors are mutually exclusive");
    expect(goHome).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "error", message: "native Deep Research and connectors are mutually exclusive" },
    ]);
  });
});

// P-035 2026-10-03 G3-B. Live intelli: a failed Deep Research turn left the
// native chip in the home composer, ChatGPT kept it across restarts, and every
// preflight refused on it.
describe("runAskOnSession native Deep Research chip hygiene", () => {
  const offCalls = () => setDeepResearch.mock.calls.filter(call => call[1] === false);

  it("removes an inherited chip on an ordinary turn before web-search setup and submit", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    const activeSession = session();
    const runner = runAskOnSession({ prompt: "plain", web: true, timeoutSec: 1_200, headless: false }, activeSession);
    await collect(runner.events);
    await runner.result;
    expect(setDeepResearch).toHaveBeenCalledTimes(1);
    expect(setDeepResearch).toHaveBeenCalledWith(activeSession.page, false);
    expect(setDeepResearch.mock.invocationCallOrder[0]).toBeLessThan(setWebSearch.mock.invocationCallOrder[0]);
    expect(setDeepResearch.mock.invocationCallOrder[0]).toBeLessThan(sendPrompt.mock.invocationCallOrder[0]);
  });

  it("removes an inherited chip on a connector turn before the connector is selected", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    const runner = runAskOnSession({ prompt: "plain", connector: "IntelliCoach Context", timeoutSec: 1_200, headless: false }, session());
    await collect(runner.events);
    await runner.result.catch(() => undefined);
    expect(offCalls()).toHaveLength(1);
    expect(setDeepResearch.mock.invocationCallOrder[0]).toBeLessThan(setConnector.mock.invocationCallOrder[0]);
  });

  it("fails an ordinary turn before submit when the inherited chip cannot be removed", async () => {
    setDeepResearch.mockRejectedValueOnce(new Error("ChatGPT native Deep Research could not be turned off"));
    const runner = runAskOnSession({ prompt: "plain", web: true, timeoutSec: 1_200, headless: false }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("could not be turned off");
    expect(setWebSearch).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  // P-035 2026-10-03 G3-B (sixth run). The persisted mode can also render as
  // the app mention `@deep-research`; `setDeepResearch(page, false)` now
  // removes it, so both of its callers clear it too. The composer is modelled
  // by one flag the mock clears exactly as the real off path does.
  const mentionComposer = (initially: boolean) => {
    const composer = { mention: initially };
    setDeepResearch.mockImplementation(async (_page: unknown, on: boolean) => {
      if (on) { composer.mention = true; return true; }
      const removed = composer.mention;
      composer.mention = false;
      return removed;
    });
    return composer;
  };

  it("clears an inherited Deep Research mention on an ordinary turn before submit", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    const composer = mentionComposer(true);
    let mentionAtSubmit: boolean | undefined;
    sendPrompt.mockImplementationOnce(async () => { mentionAtSubmit = composer.mention; });
    const activeSession = session();
    const runner = runAskOnSession({ prompt: "plain", web: true, timeoutSec: 1_200, headless: false }, activeSession);
    await collect(runner.events);
    await runner.result.catch(() => undefined);
    expect(setDeepResearch).toHaveBeenCalledWith(activeSession.page, false);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(mentionAtSubmit).toBe(false);
  });

  it("fails an ordinary turn before submit when the Deep Research mention cannot be removed", async () => {
    setDeepResearch.mockRejectedValueOnce(new Error("ChatGPT native Deep Research mention could not be removed"));
    const runner = runAskOnSession({ prompt: "plain", web: true, timeoutSec: 1_200, headless: false }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("ChatGPT native Deep Research mention could not be removed");
    expect(setWebSearch).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("clears its own Deep Research mention when a Deep Research turn fails before submit", async () => {
    const original = new Error("native user nodes unavailable");
    currentConversationId.mockReturnValue("native-conversation");
    fetchNativeResearchUserNodes.mockRejectedValueOnce(original);
    const composer = mentionComposer(false);
    const activeSession = session();
    const runner = runAskOnSession({ prompt: "research", deepResearch: true, timeoutSec: 1_200, headless: false }, activeSession);
    await collect(runner.events);
    await expect(runner.result).rejects.toBe(original);
    expect(setDeepResearch.mock.calls.map(call => call[1])).toEqual([true, false]);
    expect(composer.mention).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("clears its own chip when a Deep Research turn fails between selection and submit", async () => {
    const original = new Error("native user nodes unavailable");
    currentConversationId.mockReturnValue("native-conversation");
    fetchNativeResearchUserNodes.mockRejectedValueOnce(original);
    const activeSession = session();
    const runner = runAskOnSession({ prompt: "research", deepResearch: true, timeoutSec: 1_200, headless: false }, activeSession);
    await collect(runner.events);
    await expect(runner.result).rejects.toBe(original);
    expect(setDeepResearch.mock.calls.map(call => call[1])).toEqual([true, false]);
    expect(setDeepResearch).toHaveBeenLastCalledWith(activeSession.page, false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("clears its own chip when selection itself fails after the chip appeared", async () => {
    setDeepResearch.mockRejectedValueOnce(new Error("6 Pro thinking power did not reach its maximum"));
    const runner = runAskOnSession({ prompt: "research", deepResearch: true, timeoutSec: 1_200, headless: false }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("did not reach its maximum");
    expect(offCalls()).toHaveLength(1);
  });

  it("clears its own chip on a verify-callback failure and on a pre-submit refusal", async () => {
    ensureProSixMaximum.mockRejectedValueOnce(new Error("6 Pro thinking power did not reach its maximum"));
    const verify = runAskOnSession({ prompt: "research", deepResearch: true, timeoutSec: 1_200, headless: false }, session());
    await collect(verify.events);
    await expect(verify.result).rejects.toThrow("did not reach its maximum");
    expect(offCalls()).toHaveLength(1);

    setDeepResearch.mockClear();
    const refusal = new PreSubmitInteractionError("pro_usage_limit_reached", "model_verification", "Pro limit");
    sendPrompt.mockRejectedValueOnce(refusal);
    const refused = runAskOnSession({ prompt: "research", deepResearch: true, timeoutSec: 1_200, headless: false }, session());
    await collect(refused.events);
    await expect(refused.result).rejects.toBe(refusal);
    expect(offCalls()).toHaveLength(1);
  });

  it("keeps the original error when clearing the chip also fails", async () => {
    const original = new Error("native user nodes unavailable");
    currentConversationId.mockReturnValue("native-conversation");
    fetchNativeResearchUserNodes.mockRejectedValueOnce(original);
    setDeepResearch.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("could not be turned off"));
    const runner = runAskOnSession({ prompt: "research", deepResearch: true, timeoutSec: 1_200, headless: false }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toBe(original);
  });

  it("leaves the chip alone once the prompt may have been submitted", async () => {
    sendPrompt.mockRejectedValueOnce(new Error("send button vanished"));
    const sendFailed = runAskOnSession({ prompt: "research", deepResearch: true, timeoutSec: 1_200, headless: false }, session());
    await collect(sendFailed.events);
    await expect(sendFailed.result).rejects.toThrow("send button vanished");
    expect(offCalls()).toHaveLength(0);

    waitTurnComplete.mockRejectedValueOnce(new Error("response failed"));
    const afterSubmit = runAskOnSession({ prompt: "research", deepResearch: true, timeoutSec: 1_200, headless: false }, session());
    await collect(afterSubmit.events);
    await expect(afterSubmit.result).rejects.toThrow("response failed");
    expect(offCalls()).toHaveLength(0);
  });
});

describe("runAskOnSession connector contract", () => {
  it("records a connector-free submission before a later response failure", async () => {
    waitTurnComplete.mockRejectedValueOnce(new Error("response failed"));
    const runner = runAskOnSession({ prompt: "test", web: false, timeoutSec: 1_200, headless: false }, session());
    const result = expect(runner.result).rejects.toThrow("response failed");
    const events = await collect(runner.events);
    await result;
    const submitted = events.findIndex((event) => event.type === "tool" && event.name === "prompt-submitted");
    const failed = events.findIndex((event) => event.type === "error");
    expect(submitted).toBeGreaterThanOrEqual(0);
    expect(failed).toBeGreaterThan(submitted);
    expect(events[submitted]).toEqual({ type: "tool", name: "prompt-submitted", meta: {} });
  });

  it("emits exact connector selection and prompt submission evidence in lifecycle order", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    readLatestAssistantText.mockResolvedValueOnce("grounded");
    const activeSession = session();
    const runner = runAskOnSession(
      {
        prompt: "test",
        connector: "IntelliCoach Context",
        web: false,
        timeoutSec: 1_200,
        headless: false,
      },
      activeSession,
    );

    const result = runner.result;
    const events = await collect(runner.events);
    await expect(result).resolves.toMatchObject({ finalText: "grounded" });
    expect(setWebSearch).toHaveBeenCalledWith(activeSession.page, false);
    expect(setConnector).toHaveBeenCalledWith(activeSession.page, "IntelliCoach Context");
    expect(setConnector.mock.invocationCallOrder[0]).toBeLessThan(sendPrompt.mock.invocationCallOrder[0]);
    expect(events).toContainEqual({
      type: "tool",
      name: "connector-selected",
      meta: { connector: "IntelliCoach Context" },
    });
    expect(events).toContainEqual({
      type: "tool",
      name: "prompt-submitted",
      meta: { connector: "IntelliCoach Context" },
    });
    const connectorLifecycle = events.filter(
      (event) => event.type === "tool" &&
        (event.name === "connector-selected" || event.name === "prompt-submitted"),
    );
    expect(connectorLifecycle).toEqual([
      { type: "tool", name: "connector-selected", meta: { connector: "IntelliCoach Context" } },
      { type: "tool", name: "prompt-submitted", meta: { connector: "IntelliCoach Context" } },
    ]);
    expect(sendPrompt.mock.invocationCallOrder[0]).toBeLessThan(waitTurnComplete.mock.invocationCallOrder[0]);
  });

  it("emits connector tool evidence from the completed conversation branch", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    readLatestAssistantText.mockResolvedValueOnce("grounded");
    fetchLatestTurnConnectorState.mockResolvedValueOnce({ currentUserNodeId: "new-user", calls: [
      { id: "call-1", name: "search_context" },
      { id: "call-2", name: "search_context" },
      { id: "call-3", name: "fetch_excerpt" },
    ] });
    const activeSession = session();
    const runner = runAskOnSession(
      {
        prompt: "test",
        connector: "p035-low-risk-workstation",
        timeoutSec: 1_200,
        headless: false,
      },
      activeSession,
    );

    const result = runner.result;
    const events = await collect(runner.events);
    await expect(result).resolves.toMatchObject({ finalText: "grounded" });
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledWith(
      activeSession.page,
      "11111111-1111-1111-1111-111111111111",
      "p035-low-risk-workstation",
      10_000,
      false,
    );
    expect(events).toContainEqual({
      type: "tool", name: "search_context",
      meta: { source: "latest-conversation-turn", connector: "p035-low-risk-workstation", callId: "call-1" },
    });
    expect(events).toContainEqual({
      type: "tool", name: "fetch_excerpt",
      meta: { source: "latest-conversation-turn", connector: "p035-low-risk-workstation", callId: "call-3" },
    });
    expect(events.filter((event) => event.type === "tool" && event.name === "search_context")).toHaveLength(2);
  });

  it("rate-limits active branch evidence and performs one final fetch", async () => {
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    fetchLatestTurnConnectorState.mockResolvedValue({ currentUserNodeId: "new-user", calls: [
      { id: "active-call-1", name: "search_context" },
    ] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    waitTurnComplete.mockImplementationOnce(
      async (_page, _timeout, _prior, _stable, control: { pollEvidence?: () => Promise<void> }) => {
        await control.pollEvidence?.();
        await vi.waitFor(() => expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        clock.mockReturnValue(1_029_999);
        await control.pollEvidence?.();
        expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(1_030_000);
        await control.pollEvidence?.();
        await vi.waitFor(() => expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(2));
        await Promise.resolve();
      },
    );
    readLatestAssistantText.mockResolvedValueOnce("grounded");
    const runner = runAskOnSession(
      {
        prompt: "test",
        connector: "p035-low-risk-workstation",
        timeoutSec: 1_200,
        headless: false,
      },
      session(),
    );

    const events = await collect(runner.events);
    await expect(runner.result).resolves.toMatchObject({ finalText: "grounded" });
    expect(events.filter((event) => event.type === "tool" && event.name === "search_context")).toHaveLength(1);
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(3);
    clock.mockRestore();
  });

  it("backs active evidence polling off for two minutes after HTTP 429", async () => {
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    fetchLatestTurnConnectorState
      .mockRejectedValueOnce(new Error("conversation connector state fetch failed with HTTP 429"))
      .mockResolvedValue({ currentUserNodeId: "new-user", calls: [] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    waitTurnComplete.mockImplementationOnce(
      async (_page, _timeout, _prior, _stable, control: { pollEvidence?: () => Promise<void> }) => {
        await control.pollEvidence?.();
        await vi.waitFor(() => expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        clock.mockReturnValue(2_060_000);
        await control.pollEvidence?.();
        expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(2_120_000);
        await control.pollEvidence?.();
        await vi.waitFor(() => expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(2));
        await Promise.resolve();
      },
    );
    const runner = runAskOnSession(
      { prompt: "test", connector: "p035-low-risk-workstation", timeoutSec: 1_200, headless: false },
      session(),
    );

    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    expect(await collect(runner.events)).toContainEqual(expect.objectContaining({ type: "done" }));
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(3);
    clock.mockRestore();
  });

  it("retains the finished answer as partial while failing terminal evidence verification", async () => {
    readLatestAssistantText.mockResolvedValue("finished answer");
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    waitTurnComplete.mockResolvedValueOnce(undefined);
    fetchLatestTurnConnectorState.mockRejectedValueOnce(
      new Error("conversation connector state fetch failed with HTTP 429"),
    );
    const runner = runAskOnSession(
      {
        prompt: "test",
        connector: "p035-low-risk-workstation",
        timeoutSec: 1_200,
        headless: false,
      },
      session(),
    );

    await expect(runner.result).rejects.toThrow("conversation connector state fetch failed with HTTP 429");
    const events = await collect(runner.events);
    expect(events).toContainEqual({ type: "delta", text: "finished answer" });
    expect(events).toContainEqual({ type: "error", message: "conversation connector state fetch failed with HTTP 429" });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  it("coalesces completion with polling and skips a redundant terminal GET", async () => {
    currentConversationId.mockReturnValue("conversation");
    waitTurnComplete.mockImplementationOnce(async (_p, _t, _n, _s, control) => {
      await Promise.all([control.pollEvidence(), control.confirmComplete()]);
      expect(await control.confirmComplete()).toBe(true);
      expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
      expect(fetchLatestTurnConnectorState.mock.calls[0].slice(-2)).toEqual([10_000, false]);
    });
    const runner = runAskOnSession({ prompt: "test", connector: "connector", timeoutSec: 1200, headless: false }, session());
    await runner.result;
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
  });

  it("completion cannot bypass Retry-After or accept a stale resumed turn", async () => {
    currentConversationId.mockReturnValue("conversation");
    fetchNativeResearchUserNodes.mockResolvedValueOnce(new Set(["new-user"]));
    fetchLatestTurnConnectorState.mockRejectedValueOnce(Object.assign(new Error("HTTP 429"), { retryAfterMs: 600_000 }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    waitTurnComplete.mockImplementationOnce(async (_p, _t, _n, _s, control) => {
      expect(await control.confirmComplete()).toBe(false);
      clock.mockReturnValue(3_120_000);
      await control.pollEvidence();
      expect(await control.confirmComplete()).toBe(false);
      expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(3_600_000);
      expect(await control.confirmComplete()).toBe(false);
      expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(2);
      throw new Error("still awaiting current turn");
    });
    const runner = runAskOnSession({ prompt: "test", connector: "connector", timeoutSec: 1200, headless: false }, session());
    await expect(runner.result).rejects.toThrow("still awaiting current turn");
    clock.mockRestore();
  });

  it("fails permanent completion verification while retaining only the new answer", async () => {
    currentConversationId.mockReturnValue("conversation");
    readLatestAssistantText.mockResolvedValue("new answer");
    fetchLatestTurnConnectorState.mockRejectedValueOnce(new Error("conversation connector state fetch failed with HTTP 403"));
    waitTurnComplete.mockImplementationOnce(async (_p, _t, _n, _s, control) => {
      await control.confirmComplete();
      throw new Error("permanent error was swallowed");
    });
    const runner = runAskOnSession({ prompt: "test", connector: "connector", timeoutSec: 1200, headless: false }, session());
    await expect(runner.result).rejects.toThrow("HTTP 403");
    const events = await collect(runner.events);
    expect(events).toContainEqual({ type: "delta", text: "new answer" });
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(1);
  });

  // P-035 2026-09-23. intelli's connector turns died ~1 s after Send on a 404 from
  // the mid-turn read of a conversation too new to be served (91ae62ef).
  it("waits out a 404 right after Send and completes once the conversation is readable", async () => {
    currentConversationId.mockReturnValue("conversation");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fetchLatestTurnConnectorState.mockRejectedValueOnce(new Error("conversation connector state fetch failed with HTTP 404"));
    waitTurnComplete.mockImplementationOnce(async (_p, _t, _n, _s, control) => {
      expect(await control.confirmComplete()).toBe(false);
      clock.mockReturnValue(1_031_000);
      expect(await control.confirmComplete()).toBe(true);
    });
    const runner = runAskOnSession({ prompt: "test", connector: "connector", timeoutSec: 1200, headless: false }, session());
    await expect(runner.result).resolves.toBeDefined();
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  it("fails a 404 that outlasts the grace as HTTP 404, not as a stalled turn", async () => {
    currentConversationId.mockReturnValue("conversation");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fetchLatestTurnConnectorState.mockRejectedValue(new Error("conversation connector state fetch failed with HTTP 404"));
    waitTurnComplete.mockImplementationOnce(async (_p, _t, _n, _s, control) => {
      expect(await control.confirmComplete()).toBe(false);
      clock.mockReturnValue(1_060_000);
      expect(await control.confirmComplete()).toBe(false);
      clock.mockReturnValue(1_121_000);
      await control.confirmComplete();
      throw new Error("a durable 404 was swallowed");
    });
    const runner = runAskOnSession({ prompt: "test", connector: "connector", timeoutSec: 1200, headless: false }, session());
    await expect(runner.result).rejects.toThrow("HTTP 404");
    expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(3);
    clock.mockRestore();
  });

  it("reports a 404 still inside its grace as HTTP 404 when the turn times out first", async () => {
    currentConversationId.mockReturnValue("conversation");
    fetchLatestTurnConnectorState.mockRejectedValue(new Error("conversation connector state fetch failed with HTTP 404"));
    waitTurnComplete.mockImplementationOnce(async (_p, _t, _n, _s, control) => {
      expect(await control.confirmComplete()).toBe(false);
      throw new TurnTimeoutError(60);
    });
    const runner = runAskOnSession({ prompt: "test", connector: "connector", timeoutSec: 60, headless: false }, session());
    await expect(runner.result).rejects.toThrow("HTTP 404");
  });

  it("fails before sending when the required connector cannot be selected", async () => {
    setConnector.mockRejectedValueOnce(new Error("connector unavailable"));
    const runner = runAskOnSession(
      { prompt: "test", connector: "IntelliCoach Context", timeoutSec: 1_200, headless: false },
      session(),
    );

    await expect(runner.result).rejects.toThrow("connector unavailable");
    expect(await collect(runner.events)).toEqual([{ type: "error", message: "connector unavailable" }]);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("emits no connector-selected and never submits when the picker click did not attach the connector", async () => {
    setConnector.mockRejectedValueOnce(
      new Error(
        'ChatGPT connector "IntelliCoach Context" was clicked but never became attached to the composer (the exact label row does not report an attached state after the click).',
      ),
    );
    const runner = runAskOnSession(
      { prompt: "test", connector: "IntelliCoach Context", timeoutSec: 1_200, headless: false },
      session(),
    );

    await expect(runner.result).rejects.toThrow("never became attached to the composer");
    const events = await collect(runner.events);
    expect(events).toEqual([
      expect.objectContaining({ type: "error", message: expect.stringContaining("never became attached") }),
    ]);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("does not emit prompt submission when sending fails", async () => {
    sendPrompt.mockRejectedValueOnce(new Error("send unavailable"));
    const runner = runAskOnSession(
      { prompt: "test", connector: "IntelliCoach Context", timeoutSec: 1_200, headless: false },
      session(),
    );

    await expect(runner.result).rejects.toThrow("send unavailable");
    expect(await collect(runner.events)).toEqual([
      { type: "tool", name: "connector-selected", meta: { connector: "IntelliCoach Context" } },
      { type: "error", message: "send unavailable" },
    ]);
  });

  it("does not emit prompt submission when cancellation makes sending return without submitting", async () => {
    let finishSend: (value: number) => void = () => {};
    sendPrompt.mockImplementationOnce(
      () => new Promise<number>((resolve) => { finishSend = resolve; }),
    );
    waitTurnComplete.mockResolvedValueOnce(undefined);
    const runner = runAskOnSession(
      { prompt: "test", connector: "IntelliCoach Context", timeoutSec: 1_200, headless: false },
      session(),
    );

    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    await runner.cancel();
    finishSend(0);

    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    const events = await collect(runner.events);
    expect(events).toContainEqual({
      type: "tool", name: "connector-selected", meta: { connector: "IntelliCoach Context" },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool", name: "prompt-submitted" }));
  });

  // P-035 G3 r44. Live 2026-09-28: the acceptance turn completed but the
  // facade got only the 62-char file path and a null model, because the DOM
  // bubble lost both. The conversation record's own message holds them.
  const BACKEND_REPLY = "/tmp/path.md\n> quote\nOK";
  function finishedBackendMessage(overrides: Record<string, unknown> = {}) {
    return {
      currentUserNodeId: "new-user",
      calls: [],
      currentRole: "assistant",
      currentStatus: "finished_successfully",
      currentEndTurn: true,
      currentContentType: "text",
      currentIsThinkingPreamble: false,
      currentModelSlug: "gpt-6-pro",
      currentText: BACKEND_REPLY,
      ...overrides,
    };
  }

  it("takes a finished connector turn's reply and model from the conversation record", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    latestAssistantModelSlug.mockResolvedValue(null);
    readLatestAssistantText.mockResolvedValue("/tmp/path.md");
    fetchLatestTurnConnectorState.mockResolvedValue(finishedBackendMessage());

    const runner = runAskOnSession(
      { prompt: "accept", model: "gpt-6-pro", connector: "p035-low-risk-workstation", timeoutSec: 1_200, headless: false },
      session(),
    );
    const events = await collect(runner.events);
    await expect(runner.result).resolves.toMatchObject({ finalText: BACKEND_REPLY });
    expect(events).toContainEqual({ type: "done", finalText: BACKEND_REPLY });
    expect(events.some((event) => event.type === "tool" && event.name === "model-mismatch")).toBe(false);
  });

  it("keeps today's DOM path when the connector record's reply is unfinished", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    latestAssistantModelSlug.mockResolvedValue(null);
    readLatestAssistantText.mockResolvedValue("/tmp/path.md");
    fetchLatestTurnConnectorState.mockResolvedValue(
      finishedBackendMessage({ currentStatus: "in_progress", currentEndTurn: false }),
    );

    const runner = runAskOnSession(
      { prompt: "accept", model: "gpt-6-pro", connector: "p035-low-risk-workstation", timeoutSec: 1_200, headless: false },
      session(),
    );
    const events = await collect(runner.events);
    await expect(runner.result).resolves.toMatchObject({ finalText: "/tmp/path.md" });
    expect(events).toContainEqual({ type: "done", finalText: "/tmp/path.md" });
    // No DOM slug and no finished record -> the r43 mismatch still fires.
    expect(events).toContainEqual({ type: "tool", name: "model-mismatch", meta: { wanted: "gpt-6-pro", got: null } });
  });

  it("records the final-text source in one content-free stderr line", async () => {
    waitTurnComplete.mockResolvedValueOnce(undefined);
    currentConversationId.mockReturnValue("11111111-1111-1111-1111-111111111111");
    latestAssistantModelSlug.mockResolvedValue(null);
    readLatestAssistantText.mockResolvedValue("/tmp/path.md");
    fetchLatestTurnConnectorState.mockResolvedValue(finishedBackendMessage());

    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const runner = runAskOnSession(
        { prompt: "accept", model: "gpt-6-pro", connector: "p035-low-risk-workstation", timeoutSec: 1_200, headless: false },
        session(),
      );
      await collect(runner.events);
      await runner.result;
    } finally {
      spy.mockRestore();
    }

    const line = lines.find((entry) => entry.startsWith("[cgpro:final] "));
    expect(line).toBe(`[cgpro:final] source=backend len=${BACKEND_REPLY.length} model=gpt-6-pro`);
    expect(line).not.toContain("quote");
    expect(line).not.toContain("/tmp/path.md");
  });
});

describe("runAskOnSession wait failure propagation", () => {
  it("forwards the pre-submit anyMessages count captured by sendPrompt into the wait", async () => {
    sendPrompt.mockImplementationOnce(
      async (_page, _prompt, _preserve, _cancelled, guard, _connector, submitCounts) => {
        await guard?.();
        // The real sendPrompt fills this slot next to priorAssistantCount.
        if (submitCounts) submitCounts.priorAnyMessages = 4;
        return 0;
      },
    );
    waitTurnComplete.mockResolvedValueOnce(undefined);
    const activeSession = session();
    const runner = runAskOnSession(
      { prompt: "test", timeoutSec: 1_200, headless: false },
      activeSession,
    );
    const events = await collect(runner.events);
    await runner.result;

    expect(events).toContainEqual({ type: "tool", name: "prompt-submitted", meta: {} });
    expect(waitTurnComplete).toHaveBeenCalledWith(
      activeSession.page,
      1_200_000,
      0,
      undefined,
      expect.objectContaining({ consumeReload: undefined }),
      4,
    );
  });

  it("keeps the 588-second browser closure distinct from a configured 1200-second timeout", async () => {
    const closed = new Error("Target page, context or browser has been closed");
    waitTurnComplete.mockRejectedValueOnce(closed);
    const activeSession = session();
    const runner = runAskOnSession(
      { prompt: "test", timeoutSec: 1_200, headless: false },
      activeSession,
    );

    const result = runner.result.catch((error) => error);
    const events = await collect(runner.events);

    expect(await result).toBe(closed);
    expect(events).toEqual([{ type: "tool", name: "prompt-submitted", meta: {} }, { type: "error", message: closed.message }]);
    expect(waitTurnComplete).toHaveBeenCalledWith(
      activeSession.page,
      1_200_000,
      0,
      undefined,
      expect.objectContaining({ consumeReload: undefined }),
      // P-035 G3 r38. The mock `sendPrompt` never fills the pre-submit
      // anyMessages slot, so the turn passes unknown and rule 2 stays off.
      null,
    );
  });

  it("keeps the existing cancellation path non-terminal when a wait rejects afterwards", async () => {
    const closed = new Error("Target page, context or browser has been closed");
    let rejectWait: (error: Error) => void = () => {};
    waitTurnComplete.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectWait = reject; }),
    );
    const runner = runAskOnSession(
      { prompt: "test", timeoutSec: 1_200, headless: false },
      session(),
    );

    await vi.waitFor(() => expect(waitTurnComplete).toHaveBeenCalledTimes(1));
    await runner.cancel();
    expect(stopCurrentTurn).toHaveBeenCalledTimes(1);
    rejectWait(closed);

    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    expect(await collect(runner.events)).toEqual([{ type: "tool", name: "prompt-submitted", meta: {} }, { type: "done", finalText: "" }]);
  });

  it("lets cancellation resolve the active waiter without a later browser error", async () => {
    waitTurnComplete.mockImplementationOnce(
      (_page, _timeout, _prior, _stable, control: { cancelled?: () => boolean }) =>
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (control.cancelled?.()) {
              resolve();
              return;
            }
            setTimeout(check, 0);
          };
          check();
        }),
    );
    const runner = runAskOnSession(
      { prompt: "test", timeoutSec: 1_200, headless: false },
      session(),
    );

    await vi.waitFor(() => expect(waitTurnComplete).toHaveBeenCalledTimes(1));
    await runner.cancel();

    await expect(runner.result).resolves.toMatchObject({ finalText: "" });
    expect(stopCurrentTurn).toHaveBeenCalledTimes(1);
    expect(await collect(runner.events)).toEqual([{ type: "tool", name: "prompt-submitted", meta: {} }, { type: "done", finalText: "" }]);
  });
});


describe("account and Project filing contract", () => {
  const opts = { prompt: "plan", model: "gpt-6-pro", timeoutSec: 1200, headless: false, gizmoId: "g-p-fixture", expectedAccountEmail: "fixture@example.com" };
  it("refuses account mismatch before any prompt submission", async () => {
    requireAccount.mockRejectedValueOnce(new Error("account mismatch"));
    const runner = runAskOnSession(opts, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("account mismatch");
    expect(sendPrompt).not.toHaveBeenCalled();
  });
  it("refuses a resumed chat outside the expected Project before sending", async () => {
    verifyFiling.mockResolvedValue({ status: "mismatch" });
    const runner = runAskOnSession({ ...opts, conversationId: "existing" }, session());
    await collect(runner.events);
    await expect(runner.result).rejects.toThrow("Project membership not verified before submission");
    expect(sendPrompt).not.toHaveBeenCalled();
  });
  it("retains completed output when post-submit filing cannot be verified", async () => {
    currentConversationId.mockReturnValue("id");
    readLatestAssistantText.mockResolvedValue("completed answer");
    const runner = runAskOnSession(opts, session());
    await collect(runner.events);
    const result = await runner.result;
    expect(result.finalText).toBe("completed answer");
    expect(result.filing).toMatchObject({ status: "unavailable", preSubmitVerified: true });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });
});


describe("bounded connector HTTP 429 failure", () => {
  it.each([false, true])("preserves partial output and identity, stops only its page (terminal=%s)", async (terminal) => {
    const { ensureInterceptorInstalled } = await import("../src/core/stream.js");
    const bindings: Record<string, (...args: any[]) => void> = {};
    await ensureInterceptorInstalled({
      exposeBinding: async (name: string, callback: (...args: any[]) => void) => { bindings[name] = callback; },
      addInitScript: async () => {},
    } as unknown as BrowserContext);
    const active = session();
    const sibling = session();
    let finishSibling!: () => void;
    waitTurnComplete.mockImplementationOnce(() => new Promise<void>(resolve => { finishSibling = resolve; }));
    const siblingRunner = runAskOnSession({ prompt: "sibling", timeoutSec: 7200, headless: false }, sibling);
    const siblingEvents = collect(siblingRunner.events);
    await vi.waitFor(() => expect(waitTurnComplete).toHaveBeenCalledTimes(1));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const original = Object.assign(new Error("conversation connector state fetch failed with HTTP 429"), { retryAfterMs: 180_000 });
    fetchLatestTurnConnectorState.mockRejectedValue(original);
    waitTurnComplete.mockImplementationOnce(async (_page, _timeout, _prior, _stable, control) => {
      bindings.__cgproStart({ page: active.page }, "active");
      bindings.__cgproChunk({ page: active.page }, "active", 'data: {"conversation_id":"active-id","v":"collected partial"}\n\n');
      // Allow the public event iterator to retain the SSE identity before polling.
      await new Promise(resolve => setImmediate(resolve));
      expect(control.conversationId()).toBe("active-id");
      for (let attempt = 0; attempt < 2; attempt++) {
        clock.mockReturnValue(1_000_000 + attempt * 180_000);
        await control.pollEvidence();
        clock.mockReturnValue(1_000_000 + (attempt + 1) * 180_000 - 1);
        expect(await control.confirmComplete()).toBe(false);
        expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(attempt + 1);
      }
      clock.mockReturnValue(1_360_000);
      if (!terminal) await control.pollEvidence();
    });
    try {
      const runner = runAskOnSession({ prompt: "active", connector: "fixture", timeoutSec: 7200, headless: false }, active);
      const events = collect(runner.events);
      await expect(runner.result).rejects.toMatchObject({
        name: "ConnectorEvidenceRateLimitError", httpStatus: 429, consecutiveFailures: 3, cause: original,
      });
      const delivered = await events;
      expect(delivered).toContainEqual(expect.objectContaining({ type: "started", conversationId: "active-id" }));
      expect(delivered).toContainEqual({ type: "delta", text: "collected partial" });
      expect(delivered).toContainEqual({ type: "error", message: new ConnectorEvidenceRateLimitError(original).message });
      expect(delivered.some(e => e.type === "done")).toBe(false);
      expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(3);
      expect(fetchLatestTurnConnectorState.mock.calls.every(call => call[4] === false)).toBe(true);
      expect(stopCurrentTurn).toHaveBeenCalledTimes(1);
      expect(stopCurrentTurn).toHaveBeenCalledWith(active.page);
      expect(active.close).not.toHaveBeenCalled();
      expect(sibling.close).not.toHaveBeenCalled();
      expect(sendPrompt).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
      finishSibling();
      await siblingRunner.result;
      expect((await siblingEvents).some(e => e.type === "error")).toBe(false);
    }
  });

  it("a successful read resets the streak even when it cannot prove completion", async () => {
    currentConversationId.mockReturnValue("active-id");
    const failure = new Error("conversation connector state fetch failed with HTTP 429");
    fetchLatestTurnConnectorState.mockReset()
      .mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ currentUserNodeId: null, calls: [] })
      .mockRejectedValue(failure);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    waitTurnComplete.mockImplementationOnce(async (_page, _timeout, _prior, _stable, control) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        clock.mockReturnValue(1_000_000 + attempt * 120_000);
        await control.pollEvidence();
      }
      expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(5);
      clock.mockReturnValue(1_600_000);
      await control.pollEvidence();
    });
    try {
      const runner = runAskOnSession({ prompt: "active", connector: "fixture", timeoutSec: 7200, headless: false }, session());
      const events = collect(runner.events);
      await expect(runner.result).rejects.toBeInstanceOf(ConnectorEvidenceRateLimitError);
      await events;
      expect(fetchLatestTurnConnectorState).toHaveBeenCalledTimes(6);
    } finally { clock.mockRestore(); }
  });
});
