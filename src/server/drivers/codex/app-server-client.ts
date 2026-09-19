import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RequestId,
} from "./types.js";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type ServerRequestHandler = (request: JsonRpcRequest) => Promise<unknown>;
type NotificationListener = (notification: JsonRpcNotification) => void;
type ExitListener = (error: Error) => void;

export class CodexAppServerClient {
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #exitListeners = new Set<ExitListener>();
  #process?: ChildProcessWithoutNullStreams;
  #readline?: Interface;
  #nextId = 1;
  #closing = false;

  constructor(
    private readonly log: {
      info(data: unknown, message: string): void;
      warn(data: unknown, message: string): void;
    },
    private readonly serverRequestHandler: ServerRequestHandler,
  ) {}

  async start(): Promise<void> {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process = child;
    this.#readline = createInterface({ input: child.stdout });

    this.#readline.on("line", (line) => this.#handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message.length > 0)
        this.log.warn({ message }, "Codex app-server stderr");
    });
    child.on("error", (error) => this.#handleExit(error));
    child.on("exit", (code, signal) => {
      if (!this.#closing) {
        this.#handleExit(
          new Error(`Codex app-server exited (code=${code}, signal=${signal})`),
        );
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "racco",
        title: "Racco",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
    this.log.info({}, "Codex app-server initialized");
  }

  onNotification(listener: NotificationListener): void {
    this.#notificationListeners.add(listener);
  }

  onExit(listener: ExitListener): void {
    this.#exitListeners.add(listener);
  }

  async request<T>(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.#process === undefined) {
      throw new Error("Codex app-server has not started");
    }
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
    const onAbort = () => {
      this.#pending.get(id)?.reject(signal?.reason as Error);
      this.#pending.delete(id);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return (await promise) as T;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  notify(method: string, params?: unknown): void {
    this.#send(params === undefined ? { method } : { method, params });
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#readline?.close();
    const child = this.#process;
    this.#process = undefined;
    if (child !== undefined && child.exitCode === null) child.kill("SIGTERM");
    this.#rejectPending(new Error("Codex app-server closed"));
  }

  #send(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    const child = this.#process;
    if (child === undefined || child.stdin.destroyed) {
      throw new Error("Codex app-server stdin is unavailable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#handleExit(new Error("Invalid Codex app-server JSON"));
      return;
    }
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    ) {
      this.#handleExit(new Error("Invalid Codex app-server envelope"));
      return;
    }
    const envelope = message as Record<string, unknown>;
    if (
      envelope.id !== undefined &&
      typeof envelope.id !== "string" &&
      typeof envelope.id !== "number"
    ) {
      this.#handleExit(new Error("Invalid Codex app-server request ID"));
      return;
    }

    if (typeof envelope.method === "string" && envelope.id !== undefined) {
      void this.#handleServerRequest(envelope as JsonRpcRequest);
      return;
    }
    if (typeof envelope.method === "string") {
      const notification = envelope as JsonRpcNotification;
      for (const listener of this.#notificationListeners)
        listener(notification);
      return;
    }
    if (
      envelope.id !== undefined &&
      ("result" in envelope || "error" in envelope)
    ) {
      this.#handleResponse(envelope as JsonRpcResponse);
      return;
    }
    this.#handleExit(new Error("Invalid Codex app-server envelope"));
  }

  #handleResponse(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    if (response.error !== undefined) {
      pending.reject(
        new Error(`Codex ${response.error.code}: ${response.error.message}`),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
    let response: JsonRpcResponse;
    try {
      const result = await this.serverRequestHandler(request);
      response = { id: request.id, result };
    } catch (error) {
      response = {
        id: request.id,
        error: {
          code: -32_000,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (this.#process === undefined || this.#process.stdin.destroyed) return;
    this.#send(response);
  }

  #handleExit(error: Error): void {
    const child = this.#process;
    if (child === undefined) return;
    this.#process = undefined;
    this.#readline?.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    this.#rejectPending(error);
    for (const listener of this.#exitListeners) listener(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
