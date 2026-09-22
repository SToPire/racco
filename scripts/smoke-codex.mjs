import { smokeModelSettings } from "./lib/smoke-model-settings.mjs";
import { WebSocket } from "ws";

const baseUrl = process.env.RACCO_URL ?? "http://127.0.0.1:7331";
const cwd = process.env.RACCO_TEST_CWD ?? process.cwd();
const provider = process.env.RACCO_PROVIDER ?? "codex";
const label = provider === "claude" ? "Claude" : "Codex";
const token = provider.toUpperCase();
const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/ws";
const runId = Date.now().toString(36);
let sessionId;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function importTestProject() {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: cwd }),
  });
  assert(response.ok, `project import returned ${response.status}`);
  return response.json();
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { origin: baseUrl });
    const timeout = setTimeout(
      () => reject(new Error("WebSocket open timed out")),
      10_000,
    );
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function waitForAck(socket, requestId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Racco ack timed out")),
      30_000,
    );
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (message.type === "error" && message.requestId === requestId) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        reject(new Error(message.message));
      }
      if (message.type === "ack" && message.requestId === requestId) {
        if (message.data !== undefined) sessionId = message.data.sessionId;
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve(message.data);
      }
    }
    socket.on("message", onMessage);
  });
}

function waitForTurn(socket, expected) {
  let sawRunning = false;
  const assistantMessages = new Map();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} turn timed out`)),
      180_000,
    );
    function finish(error) {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      if (error) reject(error);
      else resolve([...assistantMessages.values()].join("\n"));
    }
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (message.type === "error") return finish(new Error(message.message));
      if ("session" in message && message.session.sessionId !== sessionId)
        return;
      if (
        message.type === "timeline.event" &&
        message.event.type === "assistant.message"
      ) {
        assistantMessages.set(message.event.id, message.event.text);
      }
      if (
        message.type === "timeline.event" &&
        message.event.type === "assistant.message.removed"
      ) {
        assistantMessages.delete(message.event.id);
      }
      if (
        message.type === "session.upserted" &&
        message.session.state === "running"
      ) {
        sawRunning = true;
      }
      if (
        message.type === "session.upserted" &&
        sawRunning &&
        message.session.state === "idle"
      ) {
        const rendered = [...assistantMessages.values()].join("\n");
        return rendered.includes(expected)
          ? finish()
          : finish(new Error(`assistant response did not contain ${expected}`));
      }
      if (
        message.type === "session.upserted" &&
        message.session.state === "error"
      ) {
        return finish(new Error(`${label} turn entered error state`));
      }
    }
    socket.on("message", onMessage);
  });
}

const project = await importTestProject();
const modelSettings = await smokeModelSettings(baseUrl, provider, project.path);
const socket = await openSocket();
try {
  const firstExpected = `${token}_RACCO_OK`;
  const createRequestId = `create-${provider}-${runId}`;
  const createAck = waitForAck(socket, createRequestId);
  const firstTurn = waitForTurn(socket, firstExpected);
  socket.send(
    JSON.stringify({
      type: "session.create",
      modelSettings,
      requestId: createRequestId,
      provider,
      projectId: project.projectId,
      path: project.path,
      prompt: `Reply with exactly ${firstExpected}. Do not use any tools.`,
    }),
  );

  const ref = await createAck;
  await firstTurn;
  assert(typeof ref?.sessionId === "string", "missing Racco session ref");

  const secondExpected = `${token}_FOLLOWUP_OK`;
  const followupRequestId = `followup-${provider}-${runId}`;
  const secondAck = waitForAck(socket, followupRequestId);
  const secondTurn = waitForTurn(socket, secondExpected);
  socket.send(
    JSON.stringify({
      type: "turn.start",
      modelSettings,
      requestId: followupRequestId,
      sessionId: ref.sessionId,
      prompt: `Reply with exactly ${secondExpected}. Do not use any tools.`,
    }),
  );
  await secondAck;
  await secondTurn;

  const response = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(ref.sessionId)}`,
  );
  assert(response.ok, `session read returned ${response.status}`);
  const snapshot = await response.json();
  assert(
    snapshot.events.length >= 4,
    `persisted ${label} history is incomplete`,
  );
  console.log(
    `${label} create/follow-up smoke passed for session ${ref.sessionId}`,
  );
} finally {
  socket.close();
}
