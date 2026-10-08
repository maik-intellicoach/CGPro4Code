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
  // P-035 D13 2026-10-08, run 144151b2: GPT-6 Pro was selected, gpt-6-instant
  // dispatched the app and deep-research-mini wrote the report.
  it("names the report's own engine, never the dispatcher or the composer model", () => {
    const x=fixture();(x.report.metadata as any).resolved_model_slug="deep-research-mini";
    (x.tool.metadata as any).resolved_model_slug="gpt-6-instant";(x.tool.metadata as any).model_slug="gpt-6-instant";
    (x.tool.metadata as any).default_model_slug="gpt-6-pro";x.tool.metadata.chatgpt_sdk.widget_state=JSON.stringify(x.state);
    expect(extractLatestNativeResearchReport(x.body)?.model).toBe("deep-research-mini");
  });
  it("falls back to the app tool node's slug when the report names none", () => {
    const x=fixture();delete (x.report.metadata as any).resolved_model_slug;
    (x.tool.metadata as any).model_slug="gpt-6-instant";(x.tool.metadata as any).default_model_slug="gpt-6-pro";
    x.tool.metadata.chatgpt_sdk.widget_state=JSON.stringify(x.state);
    expect(extractLatestNativeResearchReport(x.body)?.model).toBe("gpt-6-instant");
    delete (x.tool.metadata as any).model_slug;
    expect(extractLatestNativeResearchReport(x.body)?.model).toBeNull();
  });
  it("ignores another app even when it has report-shaped metadata", () => {
    const x=fixture();x.tool.metadata.invoked_resource.resource_uri="/another_app/start";expect(extractLatestNativeResearchReport(x.body)).toBeNull();
  });
  // Trimmed from the GPT-6 Deep Research report of invocation 144151b2 (P-035 2026-10-08):
  // content_references is empty and the sources sit in metadata.citations with code-point offsets.
  function gpt6Report(text: string, offsets: Array<[number, number]>) {
    const x = fixture();
    const sources = [
      { title: "Meet ScreenCaptureKit - WWDC22 - Videos - Apple Developer", url: "https://developer.apple.com/videos/play/wwdc2022/10156/#:~:text=On%20the%20video%20side%2C%20the,to%20the%20CMSampleBuffer%20in%20SCStreamFrameInfo" },
      { title: "Take ScreenCaptureKit to the next level - WWDC22 - Videos - Apple Developer", url: "https://developer.apple.com/la/videos/play/wwdc2022/10155/#:~:text=let%20attachments%20%3D%20attachmentsArray,return" },
    ];
    x.report.content.parts = [text];
    (x.report.metadata as any) = { resolved_model_slug: "deep-research-mini", content_references: [], citations: offsets.map(([start_ix, end_ix], i) => ({
      start_ix, end_ix, citation_format_type: "tether_v4",
      metadata: { type: "webpage", ...sources[i], text: "", pub_date: null, extra: { cited_message_idx: 31, start_line_num: 381, end_line_num: 390 }, og_tags: null },
    })) };
    x.tool.metadata.chatgpt_sdk.widget_state = JSON.stringify(x.state);
    return x.body;
  }
  const meet = "([Meet ScreenCaptureKit - WWDC22 - Videos - Apple Developer](https://developer.apple.com/videos/play/wwdc2022/10156/#:~:text=On%20the%20video%20side%2C%20the,to%20the%20CMSampleBuffer%20in%20SCStreamFrameInfo))";
  const next = "([Take ScreenCaptureKit to the next level - WWDC22 - Videos - Apple Developer](https://developer.apple.com/la/videos/play/wwdc2022/10155/#:~:text=let%20attachments%20%3D%20attachmentsArray,return))";
  it("resolves GPT-6 tether_v4 citations by offset when content_references is empty", () => {
    const body = gpt6Report("to avoid re-saving static content【31†L381-L390】【5†L218-L224】. Com", [[33, 47], [47, 60]]);
    expect(extractLatestNativeResearchReport(body)?.text).toBe(`to avoid re-saving static content${meet}${next}. Com`);
  });
  it("indexes citation offsets in code points, before trimming", () => {
    const body = gpt6Report("\n\u{1F4F7} content【31†L381-L390】", [[10, 24]]);
    expect(extractLatestNativeResearchReport(body)?.text).toBe(`\u{1F4F7} content${meet}`);
  });
  it("leaves a marker visible when its citation offsets do not land on it", () => {
    const body = gpt6Report("content【31†L381-L390】", [[6, 20]]);
    expect(extractLatestNativeResearchReport(body)?.text).toBe("content【31†L381-L390】");
  });
});
