import assert from "node:assert/strict";

/** Verify semantic messages, not event volume or streaming update count. */
export function assertSmokeHistory(snapshot, users, assistants) {
  const messages = new Map();
  for (const event of snapshot.events) {
    if (event.type === "assistant.message.removed") messages.delete(event.id);
    if (
      event.type === "user.message" ||
      (event.type === "assistant.message" && event.phase !== "commentary")
    )
      messages.set(event.id, event);
  }
  const actual = [...messages.values()];
  assert.deepEqual(
    actual.map((message) => [message.type, message.text]),
    users.flatMap((text, index) => [
      ["user.message", text],
      ["assistant.message", assistants[index]],
    ]),
  );
  assert.equal(
    new Set(actual.map((message) => message.id)).size,
    users.length * 2,
    "Each turn must retain distinct message IDs",
  );
}
