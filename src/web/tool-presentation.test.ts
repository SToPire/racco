import assert from "node:assert/strict";
import test from "node:test";
import { describeTool } from "./tool-presentation.js";
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
    { label: "读取", summary: "src/main.ts" },
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
    "tool.started · src/",
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
    { label: "编辑", summary: "src/main.ts" },
  );
  assert.equal(
    describeTool({
      ...command,
      tool: "Grep",
      input: { pattern: "command", path: "src" },
    }).summary,
    "command · src",
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
          diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n+extra",
        },
      ],
    }),
    { label: "修改文件", summary: "a.ts", outcome: "+2 −1" },
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
