import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerMessage } from "../shared/protocol.js";
import { broadcast, send, SOCKET_HIGH_WATER_BYTES } from "./socket-sender.js";

test("fanout serializes once and isolates slow sockets and send errors", () => {
  let serializations = 0;
  const message = {
    type: "ack",
    requestId: "reply",
    toJSON() {
      serializations++;
      return { type: "ack", requestId: "reply" };
    },
  } as ServerMessage;
  const received: string[] = [];
  let terminated = 0;
  const socket = (bufferedAmount: number, fails = false) =>
    ({
      readyState: WebSocket.OPEN,
      bufferedAmount,
      send(value: string, callback: (error?: Error) => void) {
        if (fails) callback(new Error("closed during send"));
        else received.push(value);
      },
      terminate() {
        terminated++;
      },
    }) as unknown as WebSocket;
  broadcast(
    [
      socket(SOCKET_HIGH_WATER_BYTES + 1),
      socket(0, true),
      socket(0),
      socket(0),
    ],
    message,
  );
  assert.equal(serializations, 1);
  assert.equal(terminated, 2);
  assert.deepEqual(received, [
    '{"type":"ack","requestId":"reply"}',
    '{"type":"ack","requestId":"reply"}',
  ]);
});

test(
  "a paused real receiver is bounded while another drains, then reconnects for a snapshot",
  { timeout: 15_000 },
  async (t) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const port = address.port;
    const clients: WebSocket[] = [];
    t.after(async () => {
      for (const client of clients) client.terminate();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    async function connect() {
      const accepted = once(server, "connection");
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      clients.push(client);
      await once(client, "open");
      const [socket] = (await accepted) as [WebSocket];
      return { client, socket };
    }
    const slow = await connect();
    const normal = await connect();
    slow.client.pause();
    let received = 0;
    normal.client.on("message", () => received++);
    const message: ServerMessage = {
      type: "timeline.event",
      session: { sessionId: "stream" },
      event: {
        type: "assistant.message",
        id: "answer",
        text: "x".repeat(128 * 1024),
      },
    };
    const frameBytes = Buffer.byteLength(JSON.stringify(message)) + 16;
    let sent = 0;
    while (slow.socket.readyState === WebSocket.OPEN && sent < 300) {
      broadcast([slow.socket, normal.socket], message);
      sent++;
      assert.ok(
        slow.socket.bufferedAmount <= SOCKET_HIGH_WATER_BYTES + frameBytes,
      );
      await delay(2);
    }
    assert.notEqual(slow.socket.readyState, WebSocket.OPEN);
    for (let retry = 0; received < sent && retry < 100; retry++) await delay(5);
    assert.equal(received, sent);
    assert.equal(normal.socket.readyState, WebSocket.OPEN);

    const reconnected = await connect();
    const restored = once(reconnected.client, "message");
    // A full message larger than the water mark must still pass, otherwise an
    // existing long history could never recover after a slow-peer disconnect.
    const snapshot = {
      ...message,
      event: {
        ...message.event,
        text: "final".repeat(SOCKET_HIGH_WATER_BYTES),
      },
    };
    send(reconnected.socket, snapshot);
    const [wire] = await restored;
    assert.deepEqual(JSON.parse(String(wire)), snapshot);
  },
);
