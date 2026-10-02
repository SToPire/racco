import assert from "node:assert/strict";
import test from "node:test";
import { describeTool, toolStatusLabel } from "./tool-presentation.js";
import { buildTimeline, type ToolTimelineRow } from "./store.js";

const command: ToolTimelineRow = {
  type: "tool",
  id: "command",
  tool: "command",
  input: { command: "native" },
  facts: { command: "npm test", summary: "检查类型" },
  output: "all checks passed",
  status: "completed",
};

test("normal presentation consumes shared facts even when raw native fields disagree", () => {
  const view = describeTool({
    ...command,
    facts: { summary: "read main.ts", exitCode: 0, durationMs: 1300 },
    details: {
      commandActions: [{ type: "read", path: "wrong.ts" }],
      exitCode: 42,
      durationMs: 999999,
    },
  });
  assert.deepEqual(view, {
    label: "command",
    summary: "read main.ts",
    outcome: "exit 0 · 1.3s",
  });
  assert.deepEqual(
    describeTool({
      ...command,
      facts: undefined,
      details: { command: "never parsed" },
    }),
    { label: "command", summary: '{"command":"native"}' },
  );
});

test("start facts survive completion facts and raw results remain inspectable", () => {
  const raw = { type: "claudeToolResult", result: { backgroundTaskId: "job" } };
  const [row] = buildTimeline([
    {
      type: "tool.started",
      id: "bash",
      tool: "Bash",
      input: {},
      facts: { command: "build", summary: "编译" },
    },
    {
      type: "tool.completed",
      id: "bash",
      status: "completed",
      details: raw,
      facts: { backgroundTaskId: "job" },
    },
  ]);
  assert.equal(row?.type, "tool");
  if (row?.type !== "tool") throw new Error("expected tool");
  assert.deepEqual(row.facts, {
    command: "build",
    summary: "编译",
    backgroundTaskId: "job",
  });
  assert.deepEqual(row.details, raw);
  assert.equal(describeTool(row).outcome, "后台任务 job");
});

test("normalized patches count real lines and preserve the raw row", () => {
  assert.deepEqual(
    describeTool({
      ...command,
      tool: "Edit",
      facts: {
        fileChanges: [
          {
            path: "counter.ts",
            kind: { type: "update", move_path: null },
            diff: "@@ -1,1 +1,1 @@\n---counter;\n+++counter;",
          },
        ],
      },
    }),
    { label: "Edit", summary: "counter.ts", outcome: "+1 −1" },
  );
  assert.equal(
    describeTool({
      ...command,
      facts: {
        fileChanges: [
          {
            path: "new.ts",
            kind: { type: "add" },
            diff: "@@ -0,0 +1,2 @@\n+- checklist\n+++counter;",
          },
        ],
      },
    }).outcome,
    "+2 −0",
  );
});

test("progress is distinct from final duration and previews stay bounded", () => {
  assert.equal(
    describeTool({
      ...command,
      status: "running",
      progress: { elapsedSeconds: 12, description: "Checking" },
    }).progress,
    "Checking · 已运行 12.0s",
  );
  assert.equal(
    describeTool({
      ...command,
      status: "incomplete",
      progress: { elapsedSeconds: 12 },
    }).progress,
    "最后进度 12.0s",
  );
  const output = "first\nsecond\nthird\nfourth";
  assert.equal(
    describeTool({ ...command, output, status: "failed" }).preview,
    "first\nsecond",
  );
  assert.equal(
    describeTool({ ...command, output, status: "running" }).preview,
    "third\nfourth",
  );
  assert.equal(describeTool({ ...command, output }).preview, undefined);
  assert.equal(
    describeTool({
      ...command,
      facts: undefined,
      input: { unknown: "x".repeat(500) },
    }).summary.length,
    180,
  );
  assert.equal(toolStatusLabel("interrupted"), "已中断");
  assert.equal(toolStatusLabel("incomplete"), "结果未知");
  assert.equal(toolStatusLabel("failed"), "失败");
});
