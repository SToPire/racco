import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentTimelineRow } from "../store.js";
import { AgentSwitcherMenu } from "./AgentSwitcher.js";

function subagent(
  agentId: string,
  name: string,
  agentPath: string,
  parentAgentId?: string,
): SubagentTimelineRow {
  return {
    type: "subagent",
    id: `subagent:${agentId}`,
    agentId,
    parentAgentId,
    name,
    agentPath,
    cwd: "/work/project",
    state: "completed",
    activities: [{ id: `completed:${agentId}`, state: "completed" }],
    timeline: [],
  };
}

test("lists the main agent and nested subagents inside one session switcher", () => {
  const html = renderToStaticMarkup(
    <AgentSwitcherMenu
      onSelect={() => undefined}
      selectedAgentId="child"
      session={{
        sessionId: "session-1",
        projectId: "project-1",
        provider: "codex",
        title: "Main task",
        cwd: "/work/project",
        state: "idle",
        updatedAt: "2026-09-03T00:00:00.000Z",
        lifecycle: "active",
        selectedModelSettings: null,
        contextUsage: null,
        compacting: false,
      }}
      subagents={[
        subagent("parent", "Turing", "/root/reviewer"),
        subagent("child", "Curie", "/root/reviewer/checker", "parent"),
      ]}
    />,
  );

  assert.equal(html.match(/role="option"/g)?.length, 3);
  assert.match(html, /Main task/);
  assert.match(html, /Turing/);
  assert.match(html, /Curie/);
  assert.match(html, /root › reviewer/);
  assert.match(html, /root › reviewer › checker/);
  assert.equal(html.match(/aria-selected="true"/g)?.length, 1);
});
