import { smokeModelSettings } from "./lib/smoke-model-settings.mjs";
import { WebSocket } from "ws";

const baseUrl = process.env.RACCO_URL ?? "http://127.0.0.1:7331";
const cwd = process.env.RACCO_TEST_CWD ?? process.cwd();
const provider = process.env.RACCO_PROVIDER ?? "codex";
const interactionKind = process.env.RACCO_INTERACTION ?? "bypass";
const action = process.env.RACCO_ACTION ?? "resolve";
const label = provider === "claude" ? "Claude" : "Codex";
const token = provider.toUpperCase();
const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/ws";
const expected = `${token}_${interactionKind.toUpperCase()}_OK`;
const runId = Date.now().toString(36);
const createRequestId = `create-${interactionKind}-${provider}-${runId}`;
let sessionId;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  ["bypass", "question"].includes(interactionKind),
  "unsupported interaction mode",
);
assert(["resolve", "interrupt"].includes(action), "unsupported action");
assert(
  action !== "interrupt" || interactionKind === "question",
  "interrupt requires question mode",
);

const projectResponse = await fetch(`${baseUrl}/api/projects`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: cwd }),
});
assert(projectResponse.ok, `project import returned ${projectResponse.status}`);
const project = await projectResponse.json();
const modelSettings = await smokeModelSettings(baseUrl, provider, project.path);

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

let sawRunning = false;
let sawInteraction = false;
let sawToolSuccess = false;
const assistantMessages = new Map();

try {
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} ${interactionKind} turn timed out`)),
      180_000,
    );

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "error") {
        clearTimeout(timeout);
        reject(new Error(message.message));
        return;
      }
      if (message.type === "ack" && message.requestId === createRequestId) {
        sessionId = message.data.sessionId;
        return;
      }
      if ("session" in message && message.session.sessionId !== sessionId)
        return;
      if (message.type === "interaction.requested") {
        if (interactionKind === "bypass") {
          clearTimeout(timeout);
          socket.send(
            JSON.stringify({
              type: "turn.interrupt",
              requestId: `unexpected-interaction-${message.interaction.id}`,
              sessionId: message.session.sessionId,
            }),
          );
          reject(new Error(`${label} unexpectedly requested user input`));
          return;
        }
        sawInteraction = true;
        if (action === "interrupt") {
          socket.send(
            JSON.stringify({
              type: "turn.interrupt",
              requestId: `interrupt-${message.interaction.id}`,
              sessionId: message.session.sessionId,
            }),
          );
          return;
        }
        const response = {
          decision: "answer",
          answers: Object.fromEntries(
            message.interaction.questions.map((question) => [
              question.id,
              [question.options?.[0]?.label ?? "Racco"],
            ]),
          ),
        };
        socket.send(
          JSON.stringify({
            type: "interaction.resolve",
            requestId: `resolve-${message.interaction.id}`,
            interactionId: message.interaction.id,
            response,
          }),
        );
      }
      if (
        message.type === "timeline.event" &&
        message.event.type === "tool.completed" &&
        message.event.success
      ) {
        sawToolSuccess = true;
      }
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
        (action === "interrupt"
          ? message.session.state === "interrupted"
          : message.session.state === "idle")
      ) {
        clearTimeout(timeout);
        resolve();
      }
      if (
        message.type === "session.upserted" &&
        message.session.state === "error"
      ) {
        clearTimeout(timeout);
        reject(
          new Error(`${label} ${interactionKind} turn entered error state`),
        );
      }
    });
  });

  socket.send(
    JSON.stringify({
      type: "session.create",
      modelSettings,
      requestId: createRequestId,
      provider,
      projectId: project.projectId,
      path: project.path,
      prompt:
        interactionKind === "question"
          ? `Call AskUserQuestion with one single-select question and two short options. After receiving the answer, reply with exactly ${expected}.`
          : "Run exactly `curl --max-time 30 -fsSI https://example.com >/dev/null` using the shell, then reply with exactly " +
            expected +
            ".",
    }),
  );

  await completed;
  if (interactionKind === "bypass") {
    assert(sawToolSuccess, `${label} did not complete a tool successfully`);
  } else {
    assert(
      sawInteraction,
      `${label} did not emit a ${interactionKind} request`,
    );
  }
  if (action === "interrupt") {
    console.log(`${label} interrupt smoke passed`);
  } else {
    assert(
      [...assistantMessages.values()].join("\n").includes(expected),
      `assistant response did not contain ${expected}`,
    );
    console.log(`${label} ${interactionKind} smoke passed`);
  }
} finally {
  socket.close();
}
