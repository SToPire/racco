import type { ClientCommand, ServerMessage } from "../shared/protocol";

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
  readonly #requests = new Map<
    string,
    { resolve(): void; reject(error: Error): void }
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
    });

    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket || typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        socket.close(1002, "Invalid Racco message");
        return;
      }
      if (message.type === "ack" || message.type === "error") {
        const pending =
          message.requestId === undefined
            ? undefined
            : this.#requests.get(message.requestId);
        if (pending) {
          this.#requests.delete(message.requestId!);
          if (message.type === "ack") pending.resolve();
          else pending.reject(new Error(message.message));
        }
      }
      for (const listener of this.#messageListeners) listener(message);
    });

    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      for (const pending of this.#requests.values())
        pending.reject(
          new Error(
            "连接中断，请求结果未确认；重连后请查看会话再决定是否重试。",
          ),
        );
      this.#requests.clear();
      this.#setStatus("closed");
      this.#scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  send(command: ClientCommand): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.#socket.send(JSON.stringify(command));
      return true;
    } catch {
      return false;
    }
  }

  request(command: ClientCommand): Promise<void> {
    if (this.#requests.has(command.requestId))
      return Promise.reject(new Error("Duplicate pending request ID"));
    return new Promise<void>((resolve, reject) => {
      this.#requests.set(command.requestId, {
        resolve,
        reject,
      });
      if (!this.send(command)) {
        this.#requests.delete(command.requestId);
        reject(new Error("WebSocket 尚未连接"));
      }
    });
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
    for (const request of this.#requests.values())
      request.reject(new Error("Racco connection closed"));
    this.#requests.clear();
    window.clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#socket = undefined;
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
