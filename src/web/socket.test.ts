import assert from "node:assert/strict";
import test from "node:test";
import { RaccoSocket } from "./socket.js";
import { fixtureModelSettings } from "../../test/model-catalog.js";
import type { ClientCommand } from "../shared/protocol.js";

test("unacknowledged actions fail on disconnect and are never replayed after reconnect", async (t) => {
  const clients: FakeSocket[] = [];
  const timers: Array<() => void> = [];
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
      setTimeout(callback: () => void) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout() {},
    },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeSocket,
  });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldSocket) Object.defineProperty(globalThis, "WebSocket", oldSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });
  const socket = new RaccoSocket();
  socket.connect();
  clients[0].open();
  const command: ClientCommand = {
    type: "turn.start",
    sessionId: "session",
    requestId: "original",
    prompt: "task",
    modelSettings: { ...fixtureModelSettings },
  };
  const sent = socket.request(command);
  const disconnected = assert.rejects(sent, /请求结果未确认/);
  clients[0].close();
  await disconnected;
  timers.shift()!();
  clients[1].open();
  assert.deepEqual(clients[1].sent, []);
  // A late response on the previous connection cannot settle a new request.
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
  socket.destroy();
});
