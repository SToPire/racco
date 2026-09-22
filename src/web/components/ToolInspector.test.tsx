import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolInspector } from "./ToolInspector.js";
import { mapItemEvents } from "../../server/drivers/codex/event-mapper.js";
import { buildTimeline } from "../store.js";
import type { ToolTimelineRow } from "../store.js";

test("places the command before collapsed execution metadata when there is no output", () => {
  const html = renderToStaticMarkup(
    <ToolInspector
      onClose={() => undefined}
      row={{
        type: "tool",
        id: "command-1",
        tool: "command",
        input: { command: "pwd", cwd: "/work/project" },
        details: {
          type: "commandExecution",
          id: "command-1",
          command: "pwd",
          cwd: "/work/project",
          status: "completed",
          commandActions: [{ type: "unknown", command: "pwd" }],
          aggregatedOutput: "",
          exitCode: 0,
          durationMs: 7,
          processId: null,
          source: "agent",
          pluginId: null,
          scriptPath: null,
        },
        output: "",
        status: "completed",
      }}
    />,
  );

  assert.match(html, /aria-label="工具详情"/);
  assert.match(html, />Command</);
  assert.match(html, />Output</);
  assert.match(html, />Raw</);
  assert.match(html, />Execution</);
  assert.match(html, />Actions</);
  assert.match(html, />7 ms</);
  assert.match(html, />agent</);
  assert.match(html, />pwd</);
  assert.match(html, /\/work\/project/);
  assert(html.indexOf(">Command<") < html.indexOf(">Execution<"));
  assert.match(
    html,
    /<details class="inspector-group" open=""><summary>.*?<span>Command<\/span>/,
  );
  assert.match(
    html,
    /<details class="inspector-group"><summary>.*?<span>Execution<\/span>/,
  );
});

for (const status of [
  "running",
  "completed",
  "failed",
  "interrupted",
  "incomplete",
] as const) {
  test(`opens ${status} tool results on Output with a copy control`, () => {
    const row: ToolTimelineRow = {
      type: "tool",
      id: "tool-1",
      tool: "Bash",
      input: { command: "pnpm test" },
      details: { source: "provider" },
      output: "Test log\nFailure detail\n",
      status,
    };
    const html = renderToStaticMarkup(
      <ToolInspector row={row} onClose={() => undefined} />,
    );
    assert.match(html, /aria-selected="true"[^>]*>Output<\/button>/);
    assert.match(
      html,
      /data-tool-output="true">Test log\nFailure detail\n<\/pre>/,
    );
    assert.match(html, /aria-label="复制输出"/);
    assert.doesNotMatch(html, /跟随末尾/);
    assert.doesNotMatch(html, /<pre>\{\n/);
  });
}

test("shows the model-facing Edit output without a second structured result", () => {
  const html = renderToStaticMarkup(
    <ToolInspector
      onClose={() => undefined}
      row={{
        type: "tool",
        id: "edit-1",
        tool: "Edit",
        input: { file_path: "/work/app.ts" },
        status: "completed",
        output: "File updated",
        details: {
          type: "claudeToolResult",
          result: {
            filePath: "/work/app.ts",
            structuredPatch: [
              {
                oldStart: 8,
                oldLines: 1,
                newStart: 8,
                newLines: 1,
                lines: ["-old", "+new"],
              },
            ],
          },
          content: "File updated",
        },
      }}
    />,
  );
  assert.match(html, /aria-selected="true"[^>]*>Output<\/button>/);
  assert.match(html, /data-tool-output="true">File updated<\/pre>/);
  assert.doesNotMatch(html, /diff-line-|模型收到的输出/);
});

test("shows only the model-facing Bash output, including interrupted calls", () => {
  const html = renderToStaticMarkup(
    <ToolInspector
      onClose={() => undefined}
      row={{
        type: "tool",
        id: "bash-1",
        tool: "Bash",
        input: { command: "pnpm test" },
        status: "interrupted",
        output: "Tool stopped",
        details: {
          type: "claudeToolResult",
          result: {
            stdout: "partial result",
            stderr: "test diagnostics",
            interrupted: true,
            backgroundTaskId: "task-1",
            persistedOutputPath: "/work/output.txt",
          },
          content: "Tool stopped",
        },
      }}
    />,
  );
  assert.match(html, /已中断/);
  assert.match(html, /data-tool-output="true">Tool stopped<\/pre>/);
  assert.doesNotMatch(
    html,
    /test diagnostics|partial result|后台任务|\/work\/output\.txt|模型收到的输出/,
  );
});

test("shows an explicit empty result for a tool without input or output", () => {
  const html = renderToStaticMarkup(
    <ToolInspector
      row={{
        type: "tool",
        id: "empty",
        tool: "unknown",
        output: "",
        status: "completed",
      }}
      onClose={() => undefined}
    />,
  );
  assert.match(html, /工具未返回文本输出/);
  assert.match(html, /aria-label="复制输出"[^>]*disabled=""/);
  assert.match(html, /aria-selected="true"[^>]*>Output<\/button>/);
});

test("renders current Codex file changes from the mapped timeline", () => {
  const [row] = buildTimeline(
    mapItemEvents(
      {
        type: "fileChange",
        id: "change-1",
        status: "completed",
        changes: [
          {
            path: "/work/file.ts",
            kind: { type: "update", move_path: "/work/renamed.ts" },
            diff: "@@ -1 +1 @@\n-old\n+new",
          },
          {
            path: "/work/new.ts",
            kind: { type: "add" },
            diff: "@@ -0,0 +1,1 @@\n+created",
          },
          {
            path: "/work/removed.ts",
            kind: { type: "delete" },
            diff: "@@ -1,1 +0,0 @@\n-removed",
          },
        ],
      },
      () => "unused-agent",
    ),
  );
  assert(row?.type === "tool");
  const html = renderToStaticMarkup(
    <ToolInspector onClose={() => undefined} row={row} />,
  );

  assert.match(html, />Changes</);
  assert.match(html, /\/work\/file\.ts/);
  assert.match(html, /diff-line-removed/);
  assert.match(html, /diff-line-added/);
  assert.match(html, /Moved to <code>\/work\/renamed.ts/);
  assert.match(html, /file-change-kind-add/);
  assert.match(html, /file-change-kind-delete/);
});
