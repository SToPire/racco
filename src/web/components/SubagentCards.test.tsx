import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentTimelineRow } from "../store";
import { SubagentCards } from "./SubagentCards";

function renderAgent(overrides: Partial<SubagentTimelineRow> = {}) {
  const row: SubagentTimelineRow = {
    type: "subagent",
    id: "subagent:reviewer",
    agentId: "reviewer",
    name: "Reviewer",
    prompt: "Review the session navigation",
    state: "completed",
    activities: [],
    timeline: [],
    ...overrides,
  };
  return renderToStaticMarkup(
    <SubagentCards subagents={[row]} onSelect={() => undefined} />,
  );
}

test("shows the task, state and provider-reported result without replacing it with transcript text", () => {
  const html = renderAgent({
    statusMessage: "Found one navigation defect",
    timeline: [
      { type: "assistant.message", id: "reply", text: "Transcript message" },
    ],
  });
  assert.match(html, /Review the session navigation/);
  assert.match(html, /已完成/);
  assert.match(html, /Found one navigation defect/);
  assert.match(html, /aria-label="查看 Reviewer 的对话"/);
  assert.doesNotMatch(html, /Transcript message/);
});

test("does not infer a result from transcript replies without a provider status message", () => {
  const timeline: SubagentTimelineRow["timeline"] = [
    { type: "assistant.message", id: "reply", text: "The navigation is fixed" },
  ];
  for (const state of [
    "starting",
    "running",
    "completed",
    "error",
    "interrupted",
    "unknown",
  ] as const) {
    assert.doesNotMatch(
      renderAgent({ state, timeline }),
      /The navigation is fixed/,
    );
  }
  assert.match(renderAgent({ state: "running", timeline }), /等待进展更新/);
  assert.match(renderAgent({ timeline }), /已结束，暂无结果摘要/);
  assert.match(renderAgent({ state: "unknown", timeline }), /状态未知/);
  assert.match(renderAgent({ state: "unknown", timeline }), /未收到子任务终态/);
});

test("does not invent a result from interrupted replies, partial replies or commentary before a tool", () => {
  const reply = {
    type: "assistant.message" as const,
    id: "reply",
    text: "I will inspect the navigation",
  };
  const timelines: SubagentTimelineRow["timeline"][] = [
    [{ ...reply, partial: true }],
    [{ ...reply, stopReason: "interrupted" }],
    [{ ...reply, stopReason: "error" }],
    [
      reply,
      {
        type: "tool",
        id: "tool",
        tool: "read",
        status: "completed",
        output: "",
      },
    ],
    [],
  ];
  for (const timeline of timelines) {
    const html = renderAgent({ timeline });
    assert.match(html, /已结束，暂无结果摘要/);
    assert.doesNotMatch(html, /I will inspect the navigation/);
  }
});

test("shows live status and uses the role when the provider has no task prompt", () => {
  const html = renderAgent({
    state: "running",
    prompt: " ",
    role: "Code review",
    statusMessage: "Checking the remaining files",
  });
  assert.match(html, /Code review/);
  assert.match(html, /运行中/);
  assert.match(html, /Checking the remaining files/);
  assert.doesNotMatch(html, />结果</);
});
