import assert from "node:assert/strict";
import test from "node:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnNavigator } from "./TurnNavigator.js";

test("renders the current request position in its collapsed state", () => {
  const html = renderToStaticMarkup(
    <TurnNavigator
      sessionId="session-1"
      requests={[
        { type: "user.message", id: "user-1", text: "First request" },
        { type: "user.message", id: "user-2", text: "Second request" },
      ]}
      scrollContainerRef={createRef<HTMLElement>()}
    />,
  );

  assert.match(html, /aria-label="用户请求导航"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /1 \/ 2/);
  assert.doesNotMatch(html, /role="menu"/);
});
