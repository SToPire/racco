import { WebSocket } from "ws";
import type { ServerMessage } from "../shared/protocol.js";

export const SOCKET_HIGH_WATER_BYTES = 1024 * 1024;

/** A slow peer recovers from a fresh snapshot instead of retaining a backlog. */
function sendSerialized(socket: WebSocket, serialized: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  // Allow one complete message (including a large history snapshot), but never
  // append another once the pending queue exceeds the high water mark. Thus the
  // queue is bounded by the mark plus one message, not by total stream length.
  if (socket.bufferedAmount > SOCKET_HIGH_WATER_BYTES) {
    socket.terminate();
    return;
  }
  try {
    socket.send(serialized, (error) => {
      if (error) socket.terminate();
    });
  } catch {
    socket.terminate();
  }
}

export function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN)
    sendSerialized(socket, JSON.stringify(message));
}

/** Serialize once per fanout; one stalled socket cannot block another. */
export function broadcast(
  sockets: Iterable<WebSocket>,
  message: ServerMessage,
): void {
  let serialized: string | undefined;
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    serialized ??= JSON.stringify(message);
    sendSerialized(socket, serialized);
  }
}
