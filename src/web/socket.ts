import type { ClientCommand, ServerMessage } from "../shared/protocol";

export const SOCKET_REQUEST_TIMEOUT_MS = 30_000;
export const SOCKET_HEARTBEAT_INTERVAL_MS = 15_000;
export const SOCKET_HEARTBEAT_TIMEOUT_MS = 10_000;

const unknownOutcome = () =>
  new Error(
    "连接中断或响应超时，请求结果未确认；重连后请查看会话再决定是否重试。",
  );

export type SocketStatus = "connecting" | "open" | "closed";

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: SocketStatus) => void;

export class RaccoSocket {
  readonly #messageListeners = new Set<MessageListener>();
  readonly #statusListeners = new Set<StatusListener>();
  readonly #reconnectDelays = [500, 1_000, 2_000, 5_000];
  #socket?: WebSocket;
  #status: SocketStatus = "closed";
  #reconnectAttempt = 0;
  #reconnectTimer?: number;
  #destroyed = false;
  #heartbeatTimer?: number;
  readonly #requests = new Map<
    string,
    { resolve(data: unknown): void; reject(error: Error): void; timer: number }
  >();

  connect(): void {
    if (
      this.#destroyed ||
      this.#socket?.readyState === WebSocket.OPEN ||
      this.#socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    window.clearTimeout(this.#reconnectTimer);
    this.#setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      this.#reconnectAttempt = 0;
      this.#setStatus("open");
      this.#scheduleHeartbeat(socket);
    });

    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket || typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        this.#disconnect(socket, new Error("服务器消息无效，请刷新后重试"));
        return;
      }
      if (message.type === "ack" || message.type === "error") {
        const pending =
          message.requestId === undefined
            ? undefined
            : this.#requests.get(message.requestId);
        if (pending) {
          this.#requests.delete(message.requestId!);
          window.clearTimeout(pending.timer);
          if (message.type === "ack") pending.resolve(message.data);
          else pending.reject(new Error(message.message));
        }
      }
      for (const listener of this.#messageListeners) listener(message);
    });

    socket.addEventListener("close", () => this.#disconnect(socket));
    socket.addEventListener("error", () => this.#disconnect(socket));
  }

  request(command: ClientCommand): Promise<unknown> {
    return this.#request(command, SOCKET_REQUEST_TIMEOUT_MS);
  }

  #request(command: ClientCommand, timeout: number): Promise<unknown> {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("WebSocket 尚未连接"));
    if (this.#requests.has(command.requestId))
      return Promise.reject(new Error("Duplicate pending request ID"));
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => this.#disconnect(socket), timeout);
      this.#requests.set(command.requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(command));
      } catch {
        this.#disconnect(socket);
      }
    });
  }

  #scheduleHeartbeat(socket: WebSocket): void {
    this.#heartbeatTimer = window.setTimeout(() => {
      if (this.#socket !== socket) return;
      void this.#request(
        { type: "connection.ping", requestId: crypto.randomUUID() },
        SOCKET_HEARTBEAT_TIMEOUT_MS,
      ).then(
        () => {
          if (this.#socket === socket) this.#scheduleHeartbeat(socket);
        },
        () => {},
      );
    }, SOCKET_HEARTBEAT_INTERVAL_MS);
  }

  #rejectRequests(error: Error): void {
    for (const pending of this.#requests.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#requests.clear();
  }

  #disconnect(socket: WebSocket, error = unknownOutcome()): void {
    if (this.#socket !== socket) return;
    // Do not wait for the browser's close handshake on a half-open network.
    this.#socket = undefined;
    window.clearTimeout(this.#heartbeatTimer);
    this.#rejectRequests(error);
    this.#setStatus("closed");
    this.#scheduleReconnect();
    socket.close();
  }

  onMessage(listener: MessageListener): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  destroy(): void {
    this.#destroyed = true;
    this.#rejectRequests(new Error("Racco connection closed"));
    window.clearTimeout(this.#reconnectTimer);
    window.clearTimeout(this.#heartbeatTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    this.#setStatus("closed");
  }

  #scheduleReconnect(): void {
    if (this.#destroyed) return;
    const index = Math.min(
      this.#reconnectAttempt,
      this.#reconnectDelays.length - 1,
    );
    const delay = this.#reconnectDelays[index];
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  #setStatus(status: SocketStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}
