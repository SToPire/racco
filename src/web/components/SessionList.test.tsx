import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectEntry, SessionSummary } from "../../shared/protocol.js";
import { SessionList } from "./SessionList.js";

const projects: ProjectEntry[] = [
  {
    projectId: "project-alpha",
    name: "alpha",
    path: "/work/alpha",
    available: true,
    createdAt: "2026-09-03T00:00:00.000Z",
  },
  {
    projectId: "project-empty",
    name: "empty",
    path: "/work/empty",
    available: true,
    createdAt: "2026-09-03T00:00:00.000Z",
  },
];

const sessions: SessionSummary[] = [
  {
    sessionId: "session-one",
    provider: "codex",
    projectId: "project-alpha",
    title: "First task",
    cwd: "/work/alpha",
    updatedAt: "2026-09-03T00:01:00.000Z",
    state: "running",
    lifecycle: "active",
    selectedModelSettings: null,
    contextUsage: null,
    compacting: false,
  },
];

test("renders sessions beneath their owning projects", () => {
  const html = renderToStaticMarkup(
    <SessionList
      selectedProjectId="project-alpha"
      onSelectProject={() => undefined}
      activeRef={{ sessionId: "session-one" }}
      loading={false}
      onNew={() => undefined}
      onOpen={() => undefined}
      projects={projects}
      sessions={sessions}
    />,
  );

  assert.match(html, /alt="Racco"/);
  assert.match(
    html,
    /aria-label="项目 alpha"[\s\S]*aria-label="alpha 的对话"[\s\S]*First task[\s\S]*Codex · 运行中/,
  );
  assert.match(
    html,
    /aria-label="项目 empty"[\s\S]*aria-label="empty 的对话"[\s\S]*暂无对话/,
  );
  assert.match(html, /aria-current="page"/);
});
