import { afterEach, expect, it, vi } from "vitest";
const runAsk = vi.fn();
const fail = vi.fn();
vi.mock("../src/core/orchestrator.js", () => ({ runAsk: (...args: unknown[]) => runAsk(...args) }));
vi.mock("../src/store/config.js", () => ({ loadConfig: () => ({ timeoutSec: 1200 }) }));
vi.mock("../src/store/session.js", () => ({ clearActiveConversation: vi.fn(), saveActiveConversationId: vi.fn(), getActiveConversationId: () => null }));
vi.mock("ora", () => ({ default: () => ({ start() { return this; }, stop: vi.fn(), fail }) }));
const { askCommand } = await import("../src/cli/commands/ask.js");
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(() => {
  vi.restoreAllMocks();
  fail.mockClear();
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
});
it.each([
  { got: "gpt-5-thinking", served: "gpt-5-thinking" },
  { got: null, served: "unknown" },
])("fails a model mismatch but still prints the answer: %j", async ({ got, served }) => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  runAsk.mockReturnValue({
    events: (async function* () {
      yield { type: "tool", name: "model-mismatch", meta: { wanted: "gpt-6-pro", got } };
      yield { type: "done", finalText: "Answer from the served model" };
    })(),
    result: Promise.resolve({ conversationId: null, finalText: "Answer from the served model", events: [] }),
  });
  expect(await askCommand("research", { daemon: false, project: false, newSession: true, noStream: true })).toBe(1);
  expect(out.mock.calls.map(c => c[0]).join("")).toContain("Answer from the served model");
  expect(fail).toHaveBeenCalledWith(`Model mismatch: asked for "gpt-6-pro", ChatGPT served "${served}"`);
});
it("succeeds when no model mismatch is reported", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  runAsk.mockReturnValue({
    events: (async function* () {
      yield { type: "done", finalText: "Pro answer" };
    })(),
    result: Promise.resolve({ conversationId: null, finalText: "Pro answer", events: [] }),
  });
  expect(await askCommand("research", { daemon: false, project: false, newSession: true, noStream: true })).toBe(0);
  expect(out.mock.calls.map(c => c[0]).join("")).toContain("Pro answer");
  expect(fail).not.toHaveBeenCalled();
});
