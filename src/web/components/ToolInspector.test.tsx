import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolInspector } from "./ToolInspector.js";
import { mapItemEvents } from "../../server/drivers/codex/event-mapper.js";
import { buildTimeline } from "../store.js";

test("renders command metadata in the inspector", () => {
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
          aggregatedOutput: "/work/project\n",
          exitCode: 0,
          durationMs: 7,
          processId: null,
          source: "agent",
          pluginId: null,
          scriptPath: null,
        },
        output: "/work/project\n",
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
          { path: "/work/new.ts", kind: { type: "add" }, diff: "+created" },
          {
            path: "/work/removed.ts",
            kind: { type: "delete" },
            diff: "-removed",
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
