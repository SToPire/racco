import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { WebSocket } from "ws";
import { buildServer } from "../src/server/server.ts";
import { CodexDriver } from "../src/server/drivers/codex/codex-driver.ts";
import { ClaudeDriver } from "../src/server/drivers/claude/claude-driver.ts";
import { buildInfo } from "./lib/build-info.mjs";

// Isolated state/project; never restarts the user's daemon or imports their sessions.
const root = await mkdtemp(join(tmpdir(), "racco-image-smoke-"));
const path = join(root, "project");
await mkdir(path);
execFileSync("git", ["init", "-q", path]);
const config = {
  host: "127.0.0.1",
  allowedHosts: ["127.0.0.1", "localhost", "[::1]"],
  port: 0,
  stateDir: join(root, "state"),
  worktreeRoot: join(root, "worktrees"),
};
const build = await buildInfo();
let app, socket, baseUrl, imageDirectory;
let messages = [];
const waiters = new Set();
const sessions = [];
const inputs = [];
for (const color of ["red", "blue"]) {
  const buffer = await sharp({
    create: { width: 128, height: 128, channels: 3, background: color },
  })
    .png()
    .toBuffer();
  inputs.push({
    type: "image",
    mediaType: "image/png",
    data: buffer.toString("base64"),
  });
}
const text = (value) => ({ type: "text", text: value });
async function start() {
  app = await buildServer(config, {
    build,
    logger: false,
    createDrivers: (log, images) => {
      imageDirectory = images.directory;
      return [new CodexDriver(log, images), new ClaudeDriver(log)];
    },
  });
  await app.listen({ host: config.host, port: 0 });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  messages = [];
  socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/api/ws", {
    origin: baseUrl,
  });
  socket.on("message", (raw) => {
    const value = String(raw);
    for (const input of inputs)
      assert(
        !value.includes(input.data),
        "Image bytes leaked into server messages",
      );
    const message = JSON.parse(value);
    messages.push(message);
    for (const notify of waiters) notify(message);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}
async function stop() {
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.close();
    await closed;
  }
  await app?.close();
}
function waitFor(predicate) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(notify);
      reject(new Error("Image smoke timed out"));
    }, 180_000);
    function notify(message) {
      if (predicate(message)) {
        clearTimeout(timer);
        waiters.delete(notify);
        resolve(message);
      }
    }
    waiters.add(notify);
  });
}
async function command(value) {
  const requestId = randomUUID();
  const ack = waitFor(
    (m) =>
      m.requestId === requestId && (m.type === "ack" || m.type === "error"),
  );
  socket.send(JSON.stringify({ ...value, requestId }));
  const result = await ack;
  if (result.type === "error") throw new Error(result.message);
  return result.data;
}
async function turn(value, expected) {
  messages = [];
  const created = await command(value);
  const sessionId = created?.sessionId ?? value.sessionId;
  if (created)
    sessions.push({
      provider: value.provider,
      sessionId,
      modelSettings: value.modelSettings,
    });
  const running = await waitFor(
    (m) =>
      m.type === "session.upserted" &&
      m.session.sessionId === sessionId &&
      m.session.state === "running",
  );
  const startedAt = messages.indexOf(running);
  const settled = await waitFor(
    (m) =>
      messages.indexOf(m) > startedAt &&
      m.type === "session.upserted" &&
      m.session.sessionId === sessionId &&
      ["idle", "error", "interrupted"].includes(m.session.state),
  );
  if (settled.session.state !== "idle")
    throw new Error(
      JSON.stringify(
        messages.filter(
          (m) => m.type === "error" || m.event?.type === "system.notice",
        ),
      ),
    );
  const answer = messages
    .filter(
      (m) =>
        m.type === "timeline.event" && m.event.type === "assistant.message",
    )
    .map((m) => m.event.text)
    .join("\n");
  assert(answer.trim(), "No assistant answer");
  if (expected) assert.match(answer, expected);
  assert.deepEqual(
    await readdir(imageDirectory),
    [],
    "Completed input left temporary files",
  );
  return sessionId;
}
async function api(url, body) {
  const response = await fetch(
    baseUrl + url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseUrl },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok)
    throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return response.json();
}
let project;
try {
  await start();
  project = await api("/api/projects", { path });
  for (const provider of ["codex", "claude"]) {
    const catalog = await api(
      `/api/providers/${provider}/models?${new URLSearchParams({ path })}`,
    );
    const requested =
      process.env[
        provider === "codex" ? "RACCO_CODEX_MODEL" : "RACCO_CLAUDE_MODEL"
      ];
    const model = requested
      ? catalog.models.find((candidate) => candidate.id === requested)
      : (catalog.models.find(
          (candidate) =>
            candidate.id === catalog.suggestedModelId &&
            candidate.imageInput !== "unsupported",
        ) ??
        catalog.models.find(
          (candidate) => candidate.imageInput !== "unsupported",
        ));
    assert(model, `No available image model for ${provider}`);
    assert.notEqual(model.reasoningEffort.status, "unavailable");
    const modelSettings = {
      modelId: model.id,
      reasoningEffort:
        model.reasoningEffort.status === "supported"
          ? (model.reasoningEffort.suggestedValue ??
            model.reasoningEffort.options[0].value)
          : null,
    };
    const sessionId = await turn(
      {
        type: "session.create",
        provider,
        projectId: project.projectId,
        path,
        modelSettings,
        content: [
          text(
            "In English, name the two solid colors in order. Be brief and do not use tools.",
          ),
          ...inputs,
        ],
      },
      /red[\s\S]*blue/i,
    );
    await turn(
      {
        type: "turn.start",
        sessionId,
        modelSettings,
        content: [text("Reply with exactly CONTINUE_OK. Do not use tools.")],
      },
      /CONTINUE_OK/,
    );
    await turn({
      type: "turn.start",
      sessionId,
      modelSettings,
      content: [inputs[0]],
    });
    const snapshot = await api(`/api/sessions/${sessionId}`);
    const users = snapshot.events.filter(
      (event) => event.type === "user.message",
    );
    assert.deepEqual(
      users.map((event) => event.imageCount),
      [2, 0, 1],
    );
    for (const input of inputs)
      assert(!JSON.stringify(snapshot).includes(input.data));
    console.log(
      JSON.stringify({
        provider,
        model: model.id,
        images: "passed",
        temporaryCleanup: "passed",
        textFollowup: "passed",
        historyPlaceholders: "passed",
      }),
    );
  }
  await stop();
  await start();
  for (const { provider, sessionId, modelSettings } of sessions) {
    await command({ type: "session.subscribe", sessionId });
    await turn(
      {
        type: "turn.start",
        sessionId,
        modelSettings,
        content: [text("Reply with exactly RESTART_OK. Do not use tools.")],
      },
      /RESTART_OK/,
    );
    console.log(
      JSON.stringify({ provider, coldResumeWithoutImages: "passed" }),
    );
  }
  console.log("Racco image smoke passed");
} finally {
  if (app && project)
    for (const { provider, sessionId } of sessions) {
      const page = await api(
        `/api/worktrees/native-sessions?${new URLSearchParams({ provider, path })}`,
      ).catch(() => null);
      const native = page?.sessions.find(
        (candidate) => candidate.managedSessionId === sessionId,
      );
      if (native)
        await api("/api/sessions/delete-native", {
          provider,
          providerSessionId: native.providerSessionId,
          projectId: project.projectId,
          path,
        }).catch((error) =>
          console.error(`Smoke session cleanup failed: ${error.message}`),
        );
    }
  await stop();
  await rm(root, { recursive: true, force: true });
}
