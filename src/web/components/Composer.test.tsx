import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fixtureModelCatalog,
  fixtureModelSettings,
} from "../../../test/model-catalog";
import { Composer } from "./Composer";
import type { ModelSelection } from "./ModelSettingsControls";

const selection: ModelSelection = {
  catalog: {
    provider: "codex",
    path: "/work/project",
    ...fixtureModelCatalog(),
  },
  draft: fixtureModelSettings,
  loading: false,
  error: undefined,
  notice: undefined,
  issue: undefined,
  valid: true,
  chooseModel: () => undefined,
  chooseEffort: () => undefined,
};

function renderComposer({
  inputDisabled = false,
  sendDisabled = false,
  sending = false,
  compacting = false,
} = {}) {
  return renderToStaticMarkup(
    <Composer
      inputDisabled={inputDisabled}
      sendDisabled={sendDisabled}
      sending={sending}
      compacting={compacting}
      selection={selection}
      onSend={async () => true}
    />,
  );
}

test("permits draft editing while sending a new turn is disabled", () => {
  const html = renderComposer({ sendDisabled: true });
  const input = html.match(/<textarea\b[^>]*>/)?.[0];
  assert.ok(input);
  assert.doesNotMatch(input, /disabled/);
  assert.match(input, /可先准备草稿，任务结束后发送/);
  assert.match(html, /aria-label="模型"[^>]*disabled=""/);
});

test("locks draft editing while a submission is awaiting confirmation", () => {
  const html = renderComposer({ sending: true });
  const input = html.match(/<textarea\b[^>]*>/)?.[0];
  assert.ok(input);
  assert.match(input, /disabled=""/);
  assert.match(input, /正在发送，请稍候/);
  assert.match(html, /aria-label="发送中"[^>]*disabled=""/);
});

test("compaction locks the entire composer even when other controls allow editing", () => {
  const html = renderComposer({ compacting: true });
  assert.match(html, /composer-compacting/);
  assert.match(html, /<textarea[^>]*disabled=""[^>]*正在压缩上下文/);
  assert.match(html, /aria-label="模型"[^>]*disabled=""/);
  assert.match(html, /aria-label="发送"[^>]*disabled=""/);
});

test("an unavailable session prevents editing regardless of submission state", () => {
  const html = renderComposer({ inputDisabled: true });
  assert.match(html, /<textarea[^>]*disabled=""/);
  assert.match(html, /aria-label="发送"[^>]*disabled=""/);
});
