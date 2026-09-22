import assert from "node:assert/strict";
import test from "node:test";
import { describeTool, toolStatusLabel } from "./tool-presentation.js";
import type { ToolTimelineRow } from "./store.js";

const command: ToolTimelineRow = {
  type: "tool",
  id: "command",
  tool: "command",
  input: { command: "npm test" },
  output: "all checks passed",
  status: "completed",
};

test("uses native read/search semantics without guessing shell intent", () => {
  assert.deepEqual(
    describeTool({
      ...command,
      details: {
        commandActions: [
          { type: "read", path: "src/main.ts", command: "cat src/main.ts" },
        ],
      },
    }),
    { label: "command", summary: "read src/main.ts" },
  );
  assert.equal(
    describeTool({
      ...command,
      details: {
        commandActions: [
          { type: "search", query: "tool.started", path: "src/" },
        ],
      },
    }).summary,
    "search tool.started · src/",
  );
  assert.equal(
    describeTool({
      ...command,
      details: { commandActions: [{ type: "unknown", command: "npm test" }] },
    }).summary,
    "npm test",
  );
});

test("keeps Claude's purpose and targets human-readable", () => {
  assert.equal(
    describeTool({
      ...command,
      tool: "Bash",
      input: { command: "npm test", description: "验证工具展示" },
    }).summary,
    "验证工具展示",
  );
  assert.deepEqual(
    describeTool({
      ...command,
      tool: "Edit",
      input: {
        file_path: "src/main.ts",
        old_string: "secret old text",
        new_string: "new",
      },
    }),
    { label: "Edit", summary: "src/main.ts" },
  );
  assert.deepEqual(
    describeTool({
      ...command,
      tool: "Grep",
      input: { pattern: "command", path: "src" },
    }),
    { label: "Grep", summary: "command · src" },
  );
});

test("reports exit and duration facts without inventing test counts or success", () => {
  assert.equal(
    describeTool({ ...command, details: { exitCode: 0, durationMs: 1300 } })
      .outcome,
    "exit 0 · 1.3s",
  );
  assert.equal(describeTool(command).outcome, undefined);
});

test("displays native progress separately from final duration and distinguishes missing results from interruption", () => {
  const running = describeTool({
    ...command,
    status: "running",
    progress: { elapsedSeconds: 12, description: "Checking types" },
  });
  assert.equal(running.progress, "Checking types · 已运行 12.0s");
  assert.equal(running.outcome, undefined);
  const ended = describeTool({
    ...command,
    status: "incomplete",
    progress: { elapsedSeconds: 12 },
  });
  assert.equal(ended.progress, "最后进度 12.0s");
  assert.equal(ended.outcome, undefined);
  assert.equal(describeTool(command).progress, undefined);
  assert.equal(toolStatusLabel("interrupted"), "已中断");
  assert.equal(toolStatusLabel("incomplete"), "结果未知");
  assert.equal(toolStatusLabel("failed"), "失败");
});

test("exposes bounded failure and live output while preserving the raw row", () => {
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
  assert.equal(output, "first\nsecond\nthird\nfourth");
});

test("shows real file paths and diff line counts without counting headers", () => {
  assert.deepEqual(
    describeTool({
      ...command,
      tool: "fileChange",
      input: [
        {
          path: "a.ts",
          kind: { type: "update", move_path: null },
          diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra",
        },
      ],
    }),
    { label: "fileChange", summary: "a.ts", outcome: "+2 −1" },
  );
});

test("unknown tools retain their name and bounded literal input", () => {
  const result = describeTool({
    ...command,
    tool: "mcp.custom",
    input: { something: "x".repeat(500) },
  });
  assert.equal(result.label, "mcp.custom");
  assert.ok(result.summary.startsWith('{"something":'));
  assert.equal(result.summary.length, 180);
});

test("Claude edit summaries count the recorded native patch facts", () => {
  const result = describeTool({
    ...command,
    tool: "Edit",
    input: { file_path: "src/main.ts" },
    details: {
      type: "claudeToolResult",
      content: [],
      result: {
        filePath: "src/main.ts",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            lines: ["-old", "+new", "+extra"],
          },
        ],
      },
    },
  });
  assert.equal(result.summary, "src/main.ts");
  assert.equal(result.outcome, "+2 −1");
});

test("increment/decrement hunk lines and Claude Write creations remain real changes", () => {
  const edited = describeTool({
    ...command,
    tool: "Edit",
    input: { file_path: "counter.ts" },
    details: {
      type: "claudeToolResult",
      content: [],
      result: {
        filePath: "counter.ts",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["---counter;", "+++counter;"],
          },
        ],
      },
    },
  });
  assert.equal(edited.outcome, "+1 −1");
  const written = describeTool({
    ...command,
    tool: "Write",
    input: { file_path: "README.md" },
    details: {
      type: "claudeToolResult",
      content: [],
      result: {
        filePath: "README.md",
        type: "create",
        structuredPatch: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: ["+- checklist", "+++counter;"],
          },
        ],
      },
    },
  });
  assert.equal(
    written.outcome,
    "+2 −0",
    "Claude already supplies a patch, even for a newly created file",
  );
});
