import assert from "node:assert/strict";
import test from "node:test";
import type {
  BashOutput,
  FileEditOutput,
  FileWriteOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import type { ToolTimelineRow } from "./store.js";
import { claudeToolResult } from "./claude-tool-result.js";

function row(tool: string, result: unknown): ToolTimelineRow {
  return {
    type: "tool",
    id: "tool-1",
    tool,
    input: {},
    output: "Model summary",
    status: "completed",
    details: { type: "claudeToolResult", result, content: "Model summary" },
  };
}

test("keeps native background task identity for the activity summary", () => {
  const result: BashOutput = {
    stdout: "error is a search term here",
    stderr: "warning text",
    interrupted: true,
    backgroundTaskId: "task-1",
    timedOutAfterMs: 1500,
    persistedOutputPath: "/work/tool-results/full.txt",
    persistedOutputSize: 3000,
  };
  const view = claudeToolResult(row("Bash", result));
  assert.deepEqual(view, { backgroundTaskId: "task-1" });
});

test("uses recorded Edit hunks without rebuilding a diff from strings", () => {
  const result: FileEditOutput = {
    filePath: "/work/app.ts",
    oldString: "old",
    newString: "new",
    originalFile: "old",
    structuredPatch: [
      {
        oldStart: 20,
        oldLines: 1,
        newStart: 20,
        newLines: 2,
        lines: ["-old", "+new", "+extra"],
      },
    ],
    userModified: false,
    replaceAll: false,
  };
  const view = claudeToolResult(row("Edit", result));
  assert.deepEqual(view?.change, {
    path: "/work/app.ts",
    kind: { type: "update", move_path: null },
    diff: "@@ -20,1 +20,2 @@\n-old\n+new\n+extra",
  });
});

test("an empty Write patch does not claim the file was unchanged", () => {
  const result: FileWriteOutput = {
    type: "update",
    filePath: "/work/large.txt",
    content: "replacement",
    structuredPatch: [],
    originalFile: null,
  };
  const view = claudeToolResult(row("Write", result));
  assert.equal(view?.change?.path, "/work/large.txt");
  assert.equal(view?.change?.diff, "");
});

test("does not invent summary facts from malformed or missing results", () => {
  assert.deepEqual(
    claudeToolResult(
      row("Edit", {
        filePath: "/work/app.ts",
        structuredPatch: [{ lines: ["+text"] }],
      }),
    ),
    {},
  );
  const missing = row("Edit", undefined);
  missing.details = { type: "claudeToolResult", content: "Model summary" };
  assert.deepEqual(claudeToolResult(missing), {});
  assert.equal(
    claudeToolResult({ ...missing, details: { filePath: "/work/app.ts" } }),
    undefined,
  );
});
