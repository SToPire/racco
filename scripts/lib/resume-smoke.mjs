import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { smokeModelSettings } from "./smoke-model-settings.mjs";
import { assertSmokeHistory } from "./smoke-history.mjs";

async function json(baseUrl, path, body) {
  const response = await fetch(
    baseUrl + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function connect(baseUrl) {
  const socket = new WebSocket(baseUrl.replace(/^http/, "ws") + "/api/ws", {
    origin: baseUrl,
  });
  const messages = [];
  const waiters = new Set();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    for (const notify of waiters) notify();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket startup timed out"));
    }, 10000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  function waitFor(predicate, since = 0) {
    return new Promise((resolve, reject) => {
      let cursor = since;
      const timer = setTimeout(
        () => finish(new Error("Resume smoke timed out")),
        180000,
      );
      function finish(error, value) {
        clearTimeout(timer);
        waiters.delete(check);
        if (error) reject(error);
        else resolve(value);
      }
      function check() {
        while (cursor < messages.length) {
          const message = messages[cursor++];
          if (message.type === "error")
            return finish(new Error(message.message));
          if (predicate(message)) return finish(undefined, message);
        }
      }
      waiters.add(check);
      check();
    });
  }
  return {
    async command(command) {
      const requestId = randomUUID();
      const since = messages.length;
      const ack = waitFor(
        (message) => message.type === "ack" && message.requestId === requestId,
        since,
      );
      socket.send(JSON.stringify({ ...command, requestId }));
      const reply = await ack;
      return { data: reply.data, since };
    },
    async turn(command) {
      const { data, since } = await this.command(command);
      const sessionId = command.sessionId ?? data.sessionId;
      let sawRunning = false;
      await waitFor((message) => {
        if (
          message.type !== "session.upserted" ||
          message.session.sessionId !== sessionId
        )
          return false;
        if (message.session.state === "running") sawRunning = true;
        return (
          sawRunning &&
          ["idle", "error", "interrupted"].includes(message.session.state)
        );
      }, since).then((message) => assert.equal(message.session.state, "idle"));
      return sessionId;
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise((resolve) => socket.once("close", resolve));
      socket.close();
      const timer = setTimeout(() => socket.terminate(), 1000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function nativeId(baseUrl, provider, cwd, sessionId) {
  const page = await json(
    baseUrl,
    `/api/worktrees/native-sessions?${new URLSearchParams({ provider, path: cwd })}`,
  );
  const native = page.sessions.find(
    (candidate) => candidate.managedSessionId === sessionId,
  );
  assert(native, "Created session must be discoverable by its native ID");
  return native.providerSessionId;
}

/** The caller owns cleanup; this routine really stops and starts its daemon. */
export async function runResumeSmoke(server, provider) {
  const remembered = `MEMORY_${randomUUID().replaceAll("-", "")}`;
  const firstPrompt = `Remember this secret code: ${remembered}. Reply with exactly the code. Do not use any tools.`;
  const resumePrompt =
    "What secret code did I ask you to remember? Reply with exactly that code. Do not use any tools.";
  assert(!resumePrompt.includes(remembered));
  let socket;
  try {
    await server.start();
    const firstProcess = (await json(server.baseUrl, "/api/diagnostics"))
      .process.pid;
    const project = await json(server.baseUrl, "/api/projects", {
      path: server.cwd,
    });
    const modelSettings = await smokeModelSettings(
      server.baseUrl,
      provider,
      server.cwd,
    );
    socket = await connect(server.baseUrl);
    const sessionId = await socket.turn({
      type: "session.create",
      provider,
      projectId: project.projectId,
      path: project.path,
      modelSettings,
      content: [{ type: "text", text: firstPrompt }],
    });
    assertSmokeHistory(
      await json(server.baseUrl, `/api/sessions/${sessionId}`),
      [firstPrompt],
      [remembered],
    );
    const originalNativeId = await nativeId(
      server.baseUrl,
      provider,
      server.cwd,
      sessionId,
    );
    await socket.close();
    socket = undefined;
    await server.stop();
    await server.start();
    assert.notEqual(
      (await json(server.baseUrl, "/api/diagnostics")).process.pid,
      firstProcess,
      "Cold resume must use a new daemon process",
    );
    assert.equal(
      await nativeId(server.baseUrl, provider, server.cwd, sessionId),
      originalNativeId,
      "Native identity changed across restart",
    );
    assertSmokeHistory(
      await json(server.baseUrl, `/api/sessions/${sessionId}`),
      [firstPrompt],
      [remembered],
    );
    socket = await connect(server.baseUrl);
    await socket.command({ type: "session.subscribe", sessionId });
    await socket.turn({
      type: "turn.start",
      sessionId,
      modelSettings,
      content: [{ type: "text", text: resumePrompt }],
    });
    assert.equal(
      await nativeId(server.baseUrl, provider, server.cwd, sessionId),
      originalNativeId,
    );
    assertSmokeHistory(
      await json(server.baseUrl, `/api/sessions/${sessionId}`),
      [firstPrompt, resumePrompt],
      [remembered, remembered],
    );
    return { sessionId, nativeId: originalNativeId };
  } finally {
    await socket?.close();
  }
}
