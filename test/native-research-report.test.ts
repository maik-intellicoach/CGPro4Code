import { describe, expect, it } from "vitest";
import { extractLatestNativeResearchReport } from "../src/api/conversations.js";

function fixture(status = "completed") {
  const report = { author: { role: "assistant" }, status: "finished_successfully", end_turn: true,
    content: { content_type: "text", parts: ["A finding. \uE200cite\uE201"] },
    metadata: { resolved_model_slug: "gpt-5-thinking", content_references: [{ matched_text: "\uE200cite\uE201", alt: "[Source](https://example.com/)" }, { matched_text: " ", alt: "" }] } };
  const state = { status, report_message: report };
  const tool = { author: { role: "tool" }, metadata: {
    invoked_resource: { resource_uri: "/connector_openai_deep_research/start" },
    chatgpt_sdk: { widget_state: JSON.stringify(state), tool_response_metadata: { websocket_url: "SYNTHETIC_SECRET" } },
  } };
  const body: any = { current_node: "hidden", mapping: {
    user: { parent: null, message: { author: { role: "user" } } },
    tool: { parent: "user", message: tool },
    hidden: { parent: "tool", message: { author: { role: "assistant" }, content: { parts: [""] } } },
  } };
  return { body, tool, state, report };
}

describe("native app report extraction", () => {
  it("recovers the completed widget report behind a hidden empty assistant response", () => {
    const { body } = fixture();
    expect(extractLatestNativeResearchReport(body)).toEqual({ text: "A finding. [Source](https://example.com/)", model: "gpt-5-thinking", userNodeId: "user" });
    expect(JSON.stringify(extractLatestNativeResearchReport(body))).not.toContain("SYNTHETIC_SECRET");
  });
  it.each(["waiting_for_user_response_on_plan", "failed", "cancelled"])("does not accept a %s state", (status) => {
    expect(extractLatestNativeResearchReport(fixture(status).body)).toBeNull();
  });
  it("rejects an unfinished report despite the app completed flag", () => {
    const x=fixture(); x.state.report_message.end_turn=false; x.tool.metadata.chatgpt_sdk.widget_state=JSON.stringify(x.state);
    expect(extractLatestNativeResearchReport(x.body)).toBeNull();
  });
  it("ignores reports in earlier turns and abandoned branches", () => {
    const { body } = fixture();body.mapping.newUser={ parent:"hidden",message:{author:{role:"user"}} };body.current_node="newUser";
    expect(extractLatestNativeResearchReport(body)).toBeNull();
  });
  it("does not borrow an older complete report when the newest native app is incomplete", () => {
    const { body } = fixture(); const pending=fixture("waiting_for_user_response_on_plan");body.mapping.pending={parent:"hidden",message:pending.tool};body.current_node="pending";
    expect(extractLatestNativeResearchReport(body)).toBeNull();
  });
  it("rejects malformed state and does not loop on cyclic branches", () => {
    const x=fixture();x.tool.metadata.chatgpt_sdk.widget_state="not json";expect(extractLatestNativeResearchReport(x.body)).toBeNull();
    x.body.mapping.tool.message={};x.body.mapping.tool.parent="hidden";expect(extractLatestNativeResearchReport(x.body)).toBeNull();
  });
  it("ignores another app even when it has report-shaped metadata", () => {
    const x=fixture();x.tool.metadata.invoked_resource.resource_uri="/another_app/start";expect(extractLatestNativeResearchReport(x.body)).toBeNull();
  });
});
