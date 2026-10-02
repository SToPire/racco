import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  RaccoSocket,
  SOCKET_HEARTBEAT_INTERVAL_MS,
  SOCKET_HEARTBEAT_TIMEOUT_MS,
  SOCKET_REQUEST_TIMEOUT_MS,
} from "./socket.js";
import { fixtureModelSettings } from "../../test/model-catalog.js";
import type { ClientCommand } from "../shared/protocol.js";

const command: ClientCommand = {
  type: "turn.start",
  sessionId: "session",
  requestId: "original",
  content: [{ type: "text", text: "task" }],
  modelSettings: { ...fixtureModelSettings },
};

function fixture(t: TestContext) {
  const clients: FakeSocket[] = [];
  const timers = new Map<number, { due: number; callback(): void }>();
  let now = 0;
  let timerId = 0;
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent: string[] = [];
    constructor() {
      super();
      clients.push(this);
    }
    send(value: string) {
      this.sent.push(value);
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    close() {
      // Model a network where the native close handshake never completes.
      this.readyState = 2;
    }
    closeFromPeer() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    reply(message: object) {
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(message) }),
      );
    }
  }
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", host: "localhost" },
      setTimeout(callback: () => void, delay: number) {
        const id = ++timerId;
        timers.set(id, { due: now + delay, callback });
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeSocket,
  });
  const socket = new RaccoSocket();
  t.after(() => {
    socket.destroy();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldSocket) Object.defineProperty(globalThis, "WebSocket", oldSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });
  async function advance(delay: number) {
    const end = now + delay;
    while (true) {
      const next = [...timers]
        .sort((a, b) => a[1].due - b[1].due)
        .find(([, value]) => value.due <= end);
      if (!next) break;
      now = next[1].due;
      timers.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
    }
    now = end;
  }
  socket.connect();
  clients[0].open();
  return { socket, clients, advance, timers };
}

test("unacknowledged actions fail on disconnect and are never replayed after reconnect", async (t) => {
  const { socket, clients, advance } = fixture(t);
  const disconnected = assert.rejects(
    socket.request(command),
    /请求结果未确认/,
  );
  clients[0].closeFromPeer();
  await disconnected;
  await advance(500);
  clients[1].open();
  assert.deepEqual(clients[1].sent, []);
  const compact = socket.request({
    type: "session.compact",
    sessionId: "session",
    requestId: "compact",
  });
  clients[0].reply({ type: "ack", requestId: "original" });
  clients[1].reply({ type: "ack", requestId: "compact" });
  await compact;
  const rejected = socket.request({ ...command, requestId: "rejected" });
  clients[1].reply({
    type: "error",
    requestId: "rejected",
    message: "invalid effort",
  });
  await assert.rejects(rejected, /invalid effort/);
  const created = socket.request({
    type: "session.create",
    requestId: "created",
    provider: "codex",
    projectId: "project",
    path: "/project",
    content: [{ type: "text", text: "task" }],
    modelSettings: fixtureModelSettings,
  });
  clients[1].reply({
    type: "ack",
    requestId: "created",
    data: { sessionId: "new-session" },
  });
  assert.deepEqual(await created, { sessionId: "new-session" });
});

test("heartbeat detects a silent half-open connection without waiting for close", async (t) => {
  const { socket, clients, advance } = fixture(t);
  const statuses: string[] = [];
  socket.onStatus((status) => statuses.push(status));
  await advance(SOCKET_HEARTBEAT_INTERVAL_MS);
  assert.equal(JSON.parse(clients[0].sent[0]).type, "connection.ping");
  await advance(SOCKET_HEARTBEAT_TIMEOUT_MS);
  assert.equal(statuses.at(-1), "closed");
  await advance(500);
  assert.equal(clients.length, 2);
  clients[1].open();
  assert.deepEqual(clients[1].sent, []);
});

test("a command has a bounded unknown outcome even when heartbeat ACKs arrive", async (t) => {
  const { socket, clients, advance } = fixture(t);
  const rejected = assert.rejects(socket.request(command), /请求结果未确认/);
  await advance(SOCKET_HEARTBEAT_INTERVAL_MS);
  const ping = JSON.parse(clients[0].sent[1]);
  clients[0].reply({ type: "ack", requestId: ping.requestId });
  await Promise.resolve();
  await advance(SOCKET_REQUEST_TIMEOUT_MS - SOCKET_HEARTBEAT_INTERVAL_MS);
  await rejected;
  await advance(500);
  clients[1].open();
  assert.deepEqual(clients[1].sent, []);
});

test("ACKs clear deadlines and destroy clears all scheduled work", async (t) => {
  const { socket, clients, advance, timers } = fixture(t);
  const pending = socket.request(command);
  clients[0].reply({ type: "ack", requestId: command.requestId });
  await pending;
  for (let count = 0; count < 3; count++) {
    await advance(SOCKET_HEARTBEAT_INTERVAL_MS);
    const ping = JSON.parse(clients[0].sent.at(-1)!);
    clients[0].reply({ type: "ack", requestId: ping.requestId });
    await Promise.resolve();
  }
  assert.equal(clients.length, 1);
  socket.destroy();
  assert.equal(timers.size, 0);
});

test("structurally invalid server JSON closes the connection and never reaches the domain", async (t) => {
  const { socket, clients } = fixture(t);
  const messages: string[] = [];
  socket.onMessage((message) => messages.push(message.type));
  const pending = assert.rejects(socket.request(command), /不符合当前协议/);
  clients[0].reply({ type: "session.removed" });
  await pending;
  assert.deepEqual(messages, ["error"]);
  assert.equal(clients[0].readyState, 2);
});
