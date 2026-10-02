import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BackgroundAgentNotice } from "./BackgroundAgentNotice";

test("completed parents expose the read-only background boundary only while children are active", () => {
  const render = (state: "idle" | "running", child: "completed" | "running") =>
    renderToStaticMarkup(
      <BackgroundAgentNotice
        session={{ provider: "codex", state }}
        subagents={[{ state: child }]}
      />,
    );
  const background = render("idle", "running");
  assert.match(background, /后台子 Agent 仍在运行/);
  assert.match(background, /无法单独停止子任务/);
  assert.match(background, /后续问题会被拒绝/);
  assert.equal(render("running", "running"), "");
  assert.equal(render("idle", "completed"), "");
});
