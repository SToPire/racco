import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantActivity, assistantPhaseLabel } from "./AssistantActivity.js";

test("reasoning exposes a readable summary before expanding and omits empty completed summaries", () => {
  const html = renderToStaticMarkup(
    <AssistantActivity
      row={{
        type: "assistant.reasoning",
        id: "reason",
        summary: ["Checking session ownership", "Comparing provider contracts"],
      }}
    />,
  );
  assert.match(
    html,
    /<summary>[\s\S]*Checking session ownership[\s\S]*<\/summary>/,
  );
  assert.match(html, /Comparing provider contracts/);
  assert.doesNotMatch(html, /<details[^>]+open/);
  assert.equal(
    renderToStaticMarkup(
      <AssistantActivity
        row={{ type: "assistant.reasoning", id: "empty", summary: [] }}
      />,
    ),
    "",
  );
});

test("the proposed plan stays distinct from the changing execution checklist", () => {
  const proposal = renderToStaticMarkup(
    <AssistantActivity
      row={{
        type: "assistant.plan",
        id: "proposal",
        text: "## Rendering approach",
        stopReason: "interrupted",
      }}
    />,
  );
  const checklist = renderToStaticMarkup(
    <AssistantActivity
      row={{
        type: "plan.updated",
        state: "running",
        id: "progress",
        explanation: "Validating the change",
        steps: [
          { step: "Implement", status: "completed" },
          { step: "Run checks", status: "inProgress" },
          { step: "Report", status: "pending" },
        ],
      }}
    />,
  );
  assert.match(proposal, /aria-label="方案"/);
  assert.match(proposal, /<h2>Rendering approach<\/h2>/);
  assert.match(proposal, /已中断/);
  assert.match(checklist, /aria-label="执行计划"/);
  assert.match(checklist, /1 \/ 3 已完成/);
  assert.match(checklist, /进行中/);
  assert.match(checklist, /待开始/);
  assert.equal(assistantPhaseLabel("commentary"), "进展");
  assert.equal(assistantPhaseLabel("final_answer"), "答复");
  assert.equal(assistantPhaseLabel(null), undefined);
});

test("a stopped execution checklist preserves unfinished steps without showing them as running", () => {
  const html = renderToStaticMarkup(
    <AssistantActivity
      row={{
        type: "plan.updated",
        state: "interrupted",
        id: "stopped",
        explanation: null,
        steps: [{ step: "Run checks", status: "inProgress" }],
      }}
    />,
  );
  assert.match(html, /已中断/);
  assert.match(html, /未完成/);
  assert.doesNotMatch(html, /进行中/);
});
