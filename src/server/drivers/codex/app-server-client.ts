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

/** A response from the peer, distinct from transport failure or a lost response. */
export class CodexRpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`Codex ${code}: ${message}`);
    this.name = "CodexRpcResponseError";
  }

  get requestRejected(): boolean {
    // Invalid request, unknown method, invalid parameters. Internal/server errors
    // do not establish that execution never began.
    return [-32600, -32601, -32602].includes(this.code);
  }
}

export class CodexAppServerClient {
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #exitListeners = new Set<ExitListener>();
  #process?: ChildProcessWithoutNullStreams;
  #readline?: Interface;
  #nextId = 1;
  #closing = false;
  #child?: ChildProcessWithoutNullStreams;
  #processClosed?: Promise<void>;
  readonly #processExitListeners = new Set<() => void>();

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
    this.#child = child;
    this.#processClosed = new Promise<void>((resolve) => {
      child.once("close", () => {
        this.#child = undefined;
        for (const listener of this.#processExitListeners) listener();
        resolve();
      });
    });
    this.#readline = createInterface({ input: child.stdout });

    this.#readline.on("line", (line) => {
      try {
        this.#handleLine(line);
      } catch (error) {
        this.#handleExit(
          new Error("Invalid Codex app-server message", { cause: error }),
        );
      }
    });
    this.#readline.on("error", (error) => this.#handleExit(error));
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream.on("error", (error) => this.#handleExit(error));
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

  onProcessExit(listener: () => void): void {
    this.#processExitListeners.add(listener);
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
    this.#process = undefined;
    this.#rejectPending(new Error("Codex app-server closed"));
    await this.#stopProcess();
  }

  async #stopProcess(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 3000);
    force.unref();
    try {
      await this.#processClosed;
    } finally {
      clearTimeout(force);
    }
  }

  #send(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    const child = this.#process;
    if (child === undefined || child.stdin.destroyed) {
      throw new Error("Codex app-server stdin is unavailable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    if (this.#process === undefined) return;
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
      void this.#handleServerRequest(envelope as JsonRpcRequest).catch(
        (error: unknown) =>
          this.#handleExit(
            error instanceof Error ? error : new Error(String(error)),
          ),
      );
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
    if (response.error !== undefined) {
      if (
        response.error === null ||
        typeof response.error !== "object" ||
        !Number.isInteger(response.error.code) ||
        typeof response.error.message !== "string"
      )
        throw new Error("Invalid Codex app-server response error");
      this.#pending.delete(response.id);
      pending.reject(
        new CodexRpcResponseError(response.error.code, response.error.message),
      );
    } else {
      this.#pending.delete(response.id);
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
    void this.#stopProcess();
    this.#rejectPending(error);
    for (const listener of this.#exitListeners) listener(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
