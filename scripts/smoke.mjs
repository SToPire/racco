import { WebSocket } from "ws";

const baseUrl = process.env.RACCO_URL ?? "http://127.0.0.1:7331";
const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/ws";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getJson(path) {
  const response = await fetch(baseUrl + path);
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { origin: baseUrl });
    const timeout = setTimeout(
      () => reject(new Error("WebSocket open timed out")),
      5_000,
    );
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function expectForeignOriginRejected() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { origin: "https://evil.example" });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Foreign-origin WebSocket check timed out"));
    }, 5_000);

    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("Foreign-origin WebSocket was accepted"));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      if (response.statusCode === 403) resolve();
      else reject(new Error(`Expected 403, received ${response.statusCode}`));
    });
    socket.once("error", () => {
      // `ws` may emit an error after `unexpected-response`; the status assertion
      // above is the authoritative result.
    });
  });
}

function waitForMessage(socket, predicate, description) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${description}`));
    }, 5_000);

    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    }

    socket.on("message", onMessage);
  });
}

async function expectUnknownSessionRejected(socket, suffix) {
  const requestId = `subscribe-unknown-${suffix}`;
  const rejected = waitForMessage(
    socket,
    (message) => message.type === "error" && message.requestId === requestId,
    `unknown-session error for ${suffix}`,
  );
  socket.send(
    JSON.stringify({
      type: "session.subscribe",
      requestId,
      sessionId: `unknown-${suffix}`,
    }),
  );
  return rejected;
}

const health = await getJson("/api/health");
assert(health.ok === true, "health payload mismatch");

const sessions = await getJson("/api/sessions");
assert(Array.isArray(sessions), "session list payload mismatch");

const projects = await getJson("/api/projects");
assert(Array.isArray(projects), "project list payload mismatch");

const home = await fetch(baseUrl + "/");
assert(home.ok && (await home.text()).includes("Racco"), "web app missing");

await expectForeignOriginRejected();

const [clientA, clientB] = await Promise.all([openSocket(), openSocket()]);
try {
  await Promise.all([
    expectUnknownSessionRejected(clientA, "a"),
    expectUnknownSessionRejected(clientB, "b"),
  ]);
  console.log(
    "Smoke test passed: HTTP, static UI, Origin guard, and two WebSocket clients",
  );
} finally {
  clientA.close();
  clientB.close();
}
