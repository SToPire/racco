import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineRow } from "../store.js";
import { SessionView } from "./SessionView.js";

test("keeps the main conversation visible and offers an active subagent task card", () => {
  const rows: TimelineRow[] = [
    { type: "assistant.message", id: "root-message", text: "root output" },
    {
      type: "subagent",
      id: "subagent:agent-1",
      agentId: "agent-1",
      name: "Nietzsche",
      agentPath: "/root/report_date",
      cwd: "/work/project",
      prompt: "Report today's date",
      state: "running",
      activities: [{ id: "running", state: "running" }],
      timeline: [
        {
          type: "tool",
          id: "command",
          tool: "command",
          input: { command: "date" },
          output: "2026-09-03",
          status: "completed",
        },
        {
          type: "assistant.message",
          id: "child-message",
          text: "child output",
        },
      ],
    },
  ];
  const html = renderToStaticMarkup(
    <SessionView
      active={true}
      loaded={true}
      connection="open"
      interactions={[]}
      onBack={() => undefined}
      onInterrupt={() => undefined}
      onCompact={async () => true}
      onResolve={() => undefined}
      onSelectTool={() => undefined}
      onSend={async () => true}
      rows={rows}
      sending={false}
      session={{
        sessionId: "session-1",
        projectId: "project-1",
        provider: "codex",
        title: "Main task",
        cwd: "/work/project",
        state: "running",
        updatedAt: "2026-09-03T00:00:00.000Z",
        lifecycle: "active",
        selectedModelSettings: null,
        contextUsage: null,
        compacting: false,
      }}
    />,
  );

  assert.match(html, /Main task/);
  assert.match(html, /Nietzsche/);
  assert.match(html, />Main Agent</);
  assert.match(html, /Report today&#x27;s date/);
  assert.match(html, /aria-label="查看 Nietzsche 的对话"/);
  assert.match(html, /等待进展更新/);
  assert.match(html, /root output/);
  assert.doesNotMatch(html, /child output/);
  assert.doesNotMatch(html, /trajectory-tool-row/);
  assert.doesNotMatch(html, /\/root\/report_date/);
});
