import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { WebSocket } from "ws";
import { startFixture } from "../../../test/fixtures/server.js";
import { fixtureModelSettings } from "../../../test/model-catalog.js";
import { MAX_CLIENT_MESSAGE_BYTES } from "../../shared/user-input.js";
import { ImageInputs } from "./input.js";
import type { ServerMessage } from "../../shared/protocol.js";

const build = {
  schema: 1 as const,
  id: "test",
  sourceRevision: "test",
  sourceDigest: "test",
  dirty: false,
  builtAt: new Date().toISOString(),
};

test("the WebSocket enforces image model capability, emits only placeholders, and bounds decompressed messages", async (t) => {
  const prepare = t.mock.method(ImageInputs.prototype, "prepare");
  const root = await mkdtemp(join(tmpdir(), "racco-image-wire-"));
  const fixture = await startFixture({ directory: root, build });
  const socket = new WebSocket(
    fixture.url.replace("http:", "ws:") + "/api/ws",
    { origin: fixture.url, perMessageDeflate: true },
  );
  t.after(async () => {
    socket.terminate();
    await fixture.app.close();
    await rm(root, { recursive: true, force: true });
  });
  socket.on("error", () => {});
  const received: string[] = [];
  socket.on("message", (data) => received.push(String(data)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  function wait(
    predicate: (message: ServerMessage) => boolean,
  ): Promise<ServerMessage> {
    const existing = received
      .map((raw) => JSON.parse(raw) as ServerMessage)
      .find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("message", onMessage);
        reject(new Error("Missing server message"));
      }, 5000);
      function onMessage(data: unknown) {
        const message = JSON.parse(String(data)) as ServerMessage;
        if (predicate(message)) {
          clearTimeout(timer);
          socket.off("message", onMessage);
          resolve(message);
        }
      }
      socket.on("message", onMessage);
    });
  }
  async function request(command: Record<string, unknown>) {
    const requestId = randomUUID();
    const reply = wait(
      (message) =>
        (message.type === "ack" || message.type === "error") &&
        message.requestId === requestId,
    );
    socket.send(JSON.stringify({ ...command, requestId }));
    return reply;
  }
  assert.equal((await request({ type: "connection.ping" })).type, "ack");
  const sessionId = fixture.sessions[0].sessionId;
  await request({ type: "session.subscribe", sessionId });
  const data = (
    await sharp({
      create: { width: 16, height: 16, channels: 3, background: "red" },
    })
      .png()
      .toBuffer()
  ).toString("base64");
  const content = [{ type: "image", mediaType: "image/png", data }];
  const rejected = await request({
    type: "turn.start",
    sessionId,
    content,
    modelSettings: { modelId: "fixture-fast", reasoningEffort: "low" },
  });
  assert.equal(rejected.type, "error");
  if (rejected.type === "error") assert.match(rejected.message, /不支持图片/);
  const malformed = await request({
    type: "turn.start",
    sessionId,
    content: [{ type: "image", mediaType: "image/png", data: "not-base64" }],
    modelSettings: fixtureModelSettings,
  });
  assert.equal(malformed.type, "error");
  if (malformed.type === "error") {
    assert.match(malformed.message, /消息内容无效/);
    assert(!malformed.message.includes("not-base64"));
  }
  const startIndex = received.length;
  const accepted = await request({
    type: "turn.start",
    sessionId,
    content,
    modelSettings: fixtureModelSettings,
  });
  assert.equal(accepted.type, "ack");
  await wait(
    (message) =>
      message.type === "timeline.event" &&
      message.event.type === "user.message" &&
      message.event.imageCount === 1,
  );
  await wait(
    (message) =>
      message.type === "timeline.event" &&
      message.event.type === "assistant.message",
  );
  assert(received.slice(startIndex).every((raw) => !raw.includes(data)));
  const snapshot = (
    await fixture.app.inject(`/api/sessions/${sessionId}`)
  ).json();
  assert(!JSON.stringify(snapshot).includes(data));
  assert(
    snapshot.events.some(
      (event: { type: string; imageCount?: number }) =>
        event.type === "user.message" && event.imageCount === 1,
    ),
  );
  const beforeCreation = prepare.mock.callCount();
  const created = await request({
    type: "session.create",
    provider: "codex",
    projectId: fixture.projects[0]!.projectId,
    path: fixture.projects[0]!.path,
    content: Array(4).fill(content[0]),
    modelSettings: fixtureModelSettings,
  });
  assert.equal(created.type, "ack");
  assert.equal(
    prepare.mock.callCount() - beforeCreation,
    1,
    "creation and its initial turn share one full image validation",
  );
  const closed = new Promise<number>((resolve) =>
    socket.once("close", resolve),
  );
  socket.send("x".repeat(MAX_CLIENT_MESSAGE_BYTES + 1), { compress: true });
  assert.equal(await closed, 1009);
});
