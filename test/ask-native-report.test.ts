import { afterEach, expect, it, vi } from "vitest";
const runAsk = vi.fn();
vi.mock("../src/core/orchestrator.js", () => ({ runAsk: (...args: unknown[]) => runAsk(...args) }));
vi.mock("../src/store/config.js", () => ({ loadConfig: () => ({ timeoutSec: 1200 }) }));
vi.mock("../src/store/session.js", () => ({ clearActiveConversation: vi.fn(), saveActiveConversationId: vi.fn(), getActiveConversationId: () => null }));
vi.mock("ora", () => ({ default: () => ({ start() { return this; }, stop: vi.fn(), fail: vi.fn() }) }));
const { askCommand } = await import("../src/cli/commands/ask.js");
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(() => {
  vi.restoreAllMocks();
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
});
it("prints the complete native report once after preliminary deltas and done text", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  runAsk.mockReturnValue({
    events: (async function* () {
      yield { type: "delta", text: "Starting research" };
      yield { type: "done", finalText: "preliminary dispatcher text" };
    })(),
    result: Promise.resolve({ conversationId: null, finalText: "Completed report with sources", events: [] }),
  });
  expect(await askCommand("research", { deepResearch: true, daemon: false, project: false, newSession: true })).toBe(0);
  expect(out.mock.calls.map(c => c[0]).join("")).toBe("Completed report with sources\n");
});
