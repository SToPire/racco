import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionLoadState } from "./SessionLoadState.js";
for (const status of ["error", "not-found"] as const) {
  test(`${status} stops the spinner and provides retry and back without a session`, () => {
    const html = renderToStaticMarkup(
      <SessionLoadState
        status={status}
        error="Read failed"
        onRetry={() => {}}
        onBack={() => {}}
      />,
    );
    assert.match(html, /role="alert"/);
    assert.match(html, /重试读取/);
    assert.match(html, /返回项目/);
    assert.doesNotMatch(html, /button-spinner|正在读取/);
  });
}
