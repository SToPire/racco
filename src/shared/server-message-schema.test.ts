import assert from "node:assert/strict";
import test from "node:test";
import {
  ServerMessageSchema,
  TimelineEventSchema,
  SessionSummarySchema,
} from "./server-message-schema.js";

test("valid JSON with a wrong current message shape fails before reaching reducers", () => {
  for (const value of [
    null,
    [],
    { type: "session.removed" },
    {
      type: "timeline.event",
      session: { sessionId: "s" },
      event: { type: "assistant.message", id: "one", text: 42 },
    },
    { type: "ack", requestId: "a", legacy: true },
  ]) {
    assert.equal(ServerMessageSchema.safeParse(value).success, false);
  }
});

test("raw tool details remain opaque while shared facts and content state are checked", () => {
  assert.equal(
    TimelineEventSchema.safeParse({
      type: "tool.started",
      id: "t",
      tool: "command",
      input: {},
      details: { nativeFutureField: 42 },
    }).success,
    true,
  );
  assert.equal(
    TimelineEventSchema.safeParse({
      type: "tool.started",
      id: "t",
      tool: "command",
      input: {},
      facts: { command: 42 },
    }).success,
    false,
  );
  assert.equal(
    TimelineEventSchema.safeParse({
      type: "assistant.message",
      id: "a",
      text: "hello",
      partial: true,
      stopReason: "error",
    }).success,
    false,
  );
  assert.equal(
    TimelineEventSchema.safeParse({
      type: "assistant.message",
      id: "a",
      text: "hello",
      partial: false,
      stopReason: "error",
    }).success,
    true,
  );
});

test("summary validation rejects unknown state and absent required fields", () => {
  assert.equal(
    SessionSummarySchema.safeParse({ sessionId: "s", state: "running" })
      .success,
    false,
  );
});
