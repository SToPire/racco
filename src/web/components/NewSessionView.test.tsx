import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewSessionView } from "./NewSessionView.js";

test("requires a project and exposes the project picker", () => {
  const html = renderToStaticMarkup(
    <NewSessionView
      active={true}
      creating={false}
      connected={true}
      health={{ ok: true, providers: { codex: "ready", claude: "ready" } }}
      onBack={() => undefined}
      onCreate={async () => true}
      onImportProject={() => undefined}
      onProjectChange={() => undefined}
      projectId=""
      projects={[]}
    />,
  );
  assert.match(html, /aria-label="项目"/);
  assert.match(html, /请先导入项目/);
  assert.match(html, /aria-label="新建并发送"[^>]*disabled=""/);
});
