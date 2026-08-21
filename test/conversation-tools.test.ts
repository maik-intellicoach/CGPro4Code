import { describe, expect, it } from "vitest";
import { extractLatestTurnToolNames } from "../src/api/conversations.js";

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
              invoked_resource: { resource_uri: "/app/link/search_context" },
            },
          },
        },
        "assistant-final": {
          parent: "new-tool",
          message: { author: { role: "assistant" } },
        },
      },
    };

    expect(extractLatestTurnToolNames(body)).toEqual(["search_context"]);
  });
});
