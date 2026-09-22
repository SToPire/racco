import assert from "node:assert/strict";
import test from "node:test";
import {
  userRequestAnchorId,
  userRequestPreview,
} from "./timeline-navigation.js";

test("builds stable encoded anchors for user request IDs", () => {
  assert.equal(
    userRequestAnchorId("session-1", "message/1:用户"),
    "user-request-session-1-message%2F1%3A%E7%94%A8%E6%88%B7",
  );
});

test("normalizes and truncates user request previews", () => {
  assert.equal(userRequestPreview("  first\n\nsecond  "), "first second");
  assert.equal(userRequestPreview("一二三四五", 4), "一二三…");
  assert.equal(userRequestPreview("   "), "空请求");
});
