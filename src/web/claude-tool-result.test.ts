import assert from "node:assert/strict";
import test from "node:test";
import type {
  BashOutput,
  FileEditOutput,
  FileWriteOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import type { ToolTimelineRow } from "./store.js";
import { claudeToolResult } from "./claude-tool-result.js";

function row(
  tool: string,
  result: unknown,
  content: unknown = "Model summary",
): ToolTimelineRow {
  return {
    type: "tool",
    id: "tool-1",
    tool,
    input: {},
    output: "Model summary",
    status: "completed",
    details: { type: "claudeToolResult", result, content },
  };
}

test("reads Bash streams and execution facts from the structured SDK result", () => {
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
  assert.equal(view?.stdout, result.stdout);
  assert.equal(view?.stderr, result.stderr);
  assert.deepEqual(view?.fields, [
    ["执行状态", "已中断"],
    ["后台任务", "task-1"],
    ["超时后转入后台", "1500 ms"],
    ["完整输出文件", "/work/tool-results/full.txt"],
    ["完整输出大小", "3000 bytes"],
  ]);
  assert.match(view!.copyText, /stderr:\nwarning text/);
  assert.match(view!.copyText, /stdout:\nerror is a search term here/);
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
  assert.equal(view?.copyText, view?.change?.diff);
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
  assert.equal(view?.emptyPatch, true);
  assert.equal(view?.copyText, "Model summary");
});

test("keeps malformed or missing structured data on the ordinary output path", () => {
  assert.equal(
    claudeToolResult(
      row("Edit", {
        filePath: "/work/app.ts",
        structuredPatch: [{ lines: ["+text"] }],
      }),
    )?.kind,
    "generic",
  );
  const missing = row("Edit", undefined);
  missing.details = { type: "claudeToolResult", content: "Model summary" };
  assert.equal(claudeToolResult(missing)?.missingStructuredResult, true);
  assert.equal(
    claudeToolResult({ ...missing, details: { filePath: "/work/app.ts" } }),
    undefined,
  );
});

test("describes image attachments without treating image bytes as stdout", () => {
  const result: BashOutput = {
    stdout: "cGljdHVyZQ==",
    stderr: "",
    interrupted: false,
    isImage: true,
  };
  const view = claudeToolResult(
    row("Bash", result, [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: result.stdout,
        },
      },
    ]),
  );
  assert.equal(view?.stdout, "");
  assert.deepEqual(view?.attachments, [
    { label: "图像附件", mediaType: "image/png" },
  ]);
  assert.doesNotMatch(view!.copyText, /cGljdHVyZQ==/);
});
