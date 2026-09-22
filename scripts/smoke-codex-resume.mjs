import { smokeModelSettings } from "./lib/smoke-model-settings.mjs";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.RACCO_URL ?? "http://127.0.0.1:7331";
const provider = process.env.RACCO_PROVIDER ?? "codex";
const label = provider === "claude" ? "Claude" : "Codex";
const sessionId = process.env.RACCO_SESSION_ID;
if (!sessionId) throw new Error("RACCO_SESSION_ID is required");
const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/ws";
const expected = `${provider.toUpperCase()}_RESUME_OK`;
const runId = randomUUID();
const subscribeRequestId = `subscribe-${runId}`;
const turnRequestId = `resume-${runId}`;

const socket = await new Promise((resolve, reject) => {
  const client = new WebSocket(wsUrl, { origin: baseUrl });
  const timeout = setTimeout(
    () => reject(new Error("WebSocket open timed out")),
    10_000,
  );
  client.once("open", () => {
    clearTimeout(timeout);
    resolve(client);
  });
  client.once("error", reject);
});

function waitFor(requestId, predicate, description) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${description} timed out`)),
      180_000,
    );
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if ("session" in message && message.session.sessionId !== sessionId)
        return;
      if (
        message.type === "error" &&
        (!message.requestId || message.requestId === requestId)
      ) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        reject(new Error(message.message));
        return;
      }
      if (predicate(message)) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve(message);
      }
    }
    socket.on("message", onMessage);
  });
}

try {
  const subscribed = waitFor(
    subscribeRequestId,
    (message) => message.type === "session.snapshot",
    "session snapshot",
  );
  socket.send(
    JSON.stringify({
      type: "session.subscribe",
      requestId: subscribeRequestId,
      sessionId,
    }),
  );
  const snapshot = await subscribed;
  const modelSettings = await smokeModelSettings(
    baseUrl,
    snapshot.session.provider,
    snapshot.session.cwd,
    snapshot.session.selectedModelSettings,
  );

  let sawRunning = false;
  const assistantMessages = new Map();
  const completed = waitFor(
    turnRequestId,
    (message) => {
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
      return (
        message.type === "session.upserted" &&
        sawRunning &&
        message.session.state === "idle"
      );
    },
    "resumed turn",
  );
  socket.send(
    JSON.stringify({
      type: "turn.start",
      modelSettings,
      requestId: turnRequestId,
      sessionId,
      prompt: `Reply with exactly ${expected}. Do not use any tools.`,
    }),
  );
  await completed;
  if (![...assistantMessages.values()].join("\n").includes(expected)) {
    throw new Error(`assistant response did not contain ${expected}`);
  }
  console.log(`${label} restart/resume smoke passed for session ${sessionId}`);
} finally {
  socket.close();
}
