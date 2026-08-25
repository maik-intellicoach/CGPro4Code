import { describe, expect, it } from "vitest";
import {
  extractLatestTurnConnectorState,
  extractLatestTurnToolCalls,
  extractLatestTurnToolNames,
} from "../src/api/conversations.js";
import { exactConnectorLabelIndex } from "../src/browser/conversation.js";

describe("extractLatestTurnToolNames", () => {
  it("walks only the current branch back to its latest user message", () => {
    const body = {
      current_node: "assistant-final",
      mapping: {
        "old-tool": {
          parent: "old-user",
          message: {
            author: { role: "tool" },
            metadata: { invoked_resource: { resource_uri: "/app/link/old_tool" } },
          },
        },
        "new-user": { parent: "old-tool", message: { author: { role: "user" } } },
        "new-tool": {
          parent: "new-user",
          message: {
            author: { role: "tool" },
            metadata: {
              invoked_resource: {
                resource_uri: "/app/link/search_context",
                app_name: "p035-low-risk-workstation",
              },
            },
          },
        },
        "assistant-final": {
          parent: "new-tool",
          message: { author: { role: "assistant" } },
        },
      },
    };

    expect(extractLatestTurnToolNames(body, "p035-low-risk-workstation")).toEqual(["search_context"]);
    expect(extractLatestTurnToolNames(body, "wrong-connector")).toEqual([]);
  });

  it("rejects a correct tool tail from the wrong or missing connector app", () => {
    const tool = (app_name?: string) => ({
      current_node: "tool",
      mapping: {
        tool: {
          parent: "user",
          message: {
            author: { role: "tool" },
            metadata: { invoked_resource: { resource_uri: "/app/link/search_context", app_name } },
          },
        },
        user: { parent: null, message: { author: { role: "user" } } },
      },
    });
    expect(extractLatestTurnToolNames(tool("wrong-connector"), "p035-low-risk-workstation")).toEqual([]);
    expect(extractLatestTurnToolNames(tool(), "p035-low-risk-workstation")).toEqual([]);
  });

  it("preserves repeated tool-call occurrences with stable branch IDs", () => {
    const body = {
      current_node: "assistant-final",
      mapping: {
        user: { parent: null, message: { author: { role: "user" } } },
        search1: {
          parent: "user",
          message: {
            id: "message-search-1",
            author: { role: "tool" },
            metadata: { invoked_resource: { resource_uri: "/app/link/search_context", app_name: "p035-low-risk-workstation" } },
          },
        },
        search2: {
          parent: "search1",
          message: {
            id: "message-search-2",
            author: { role: "tool" },
            metadata: { invoked_resource: { resource_uri: "/app/link/search_context", app_name: "p035-low-risk-workstation" } },
          },
        },
        "assistant-final": { parent: "search2", message: { author: { role: "assistant" } } },
      },
    };

    expect(extractLatestTurnToolCalls(body, "p035-low-risk-workstation")).toEqual([
      { id: "message-search-1", name: "search_context" },
      { id: "message-search-2", name: "search_context" },
    ]);
  });
});

describe("extractLatestTurnConnectorState", () => {
  it("requires the current branch to return to an assistant after connector work", () => {
    const body = {
      current_node: "tool",
      mapping: {
        user: { parent: null, message: { author: { role: "user" } } },
        tool: {
          parent: "user",
          message: {
            author: { role: "tool" },
            metadata: {
              invoked_resource: {
                resource_uri: "/app/link/search_context",
                app_name: "p035-low-risk-workstation",
              },
            },
          },
        },
        assistant: { parent: "tool", message: { author: { role: "assistant" } } },
      },
    };

    expect(extractLatestTurnConnectorState(body, "p035-low-risk-workstation")).toMatchObject({
      currentRole: "tool",
      calls: [{ name: "search_context" }],
    });
    body.current_node = "assistant";
    expect(extractLatestTurnConnectorState(body, "p035-low-risk-workstation")).toMatchObject({
      currentRole: "assistant",
      calls: [{ name: "search_context" }],
    });
  });
});

describe("exact connector picker matching", () => {
  it("chooses the exact label before a suffixed lookalike", () => {
    expect(exactConnectorLabelIndex(
      ["p035-low-risk-workstation backup", "  p035-low-risk-workstation  "],
      "p035-low-risk-workstation",
    )).toBe(1);
  });

  it("rejects a suffix-only lookalike", () => {
    expect(exactConnectorLabelIndex(
      ["p035-low-risk-workstation backup"],
      "p035-low-risk-workstation",
    )).toBe(-1);
  });
});
