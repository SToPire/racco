import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, parse } from "node:path";
import { WebSocket } from "ws";
import type {
  InteractionRequest,
  InteractionResponse,
  ProjectEntry,
  Provider,
  ProviderStatus,
  ServerMessage,
  SessionRef,
  SessionSnapshotMessage,
  SessionState,
  SessionSummary,
  TimelineEvent,
  ModelSettings,
  ModelCatalog,
  NativeSessionPage,
} from "../shared/protocol.js";
import { NativeSessionPageSchema } from "../shared/protocol.js";
import type {
  AgentDriver,
  DriverContext,
  ProviderSessionHandle,
} from "./drivers/driver.js";
import { ProviderSessionNotFoundError } from "./drivers/driver.js";
import { resolveProjectDirectory } from "./project-path.js";
import {
  ModelSettingsSchema,
  modelSettingsError,
} from "../shared/model-settings.js";
import { ModelCatalogCache } from "./model-catalog.js";
import type { ManagedSession } from "./state/session-repository.js";
import {
  SessionRepository,
  toProjectEntry,
  toSessionSummary,
} from "./state/session-repository.js";

type RuntimeSession = {
  summary: SessionSummary;
  events: TimelineEvent[];
  subscribers: Set<WebSocket>;
  revision: number;
  activeTurn?: {
    abortController: AbortController;
    terminalState?: "idle" | "interrupted" | "error";
    task?: Promise<void>;
  };
};

type PendingInteraction = {
  sessionId: string;
  request: InteractionRequest;
  resolve(response: InteractionResponse): void;
  reject(error: Error): void;
};

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

function providerHandle(session: ManagedSession): ProviderSessionHandle {
  if (session.providerSessionId === undefined) {
    throw new Error("Managed session has no provider session ID");
  }
  return {
    providerSessionId: session.providerSessionId,
    cwd: session.cwd,
  };
}

function projectDirectoryIsAvailable(path: string): boolean {
  try {
    const cwd = realpathSync(path);
    return (
      cwd === path && cwd !== parse(cwd).root && statSync(cwd).isDirectory()
    );
  } catch {
    return false;
  }
}

function requestHash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function creationHash(
  provider: Provider,
  projectId: string,
  prompt: string,
  settings: ModelSettings,
): string {
  return requestHash([
    "session.create",
    provider,
    projectId,
    prompt,
    settings.modelId,
    settings.reasoningEffort,
  ]);
}

export class SessionHub {
  readonly #drivers = new Map<Provider, AgentDriver>();
  readonly #sessions = new Map<string, RuntimeSession>();
  readonly #clients = new Set<WebSocket>();
  readonly #socketSubscriptions = new Map<WebSocket, string>();
  readonly #interactions = new Map<string, PendingInteraction>();
  readonly #models = new ModelCatalogCache();
  readonly #nativeMutations = new Map<string, Promise<void>>();
  readonly #creating = new Map<
    string,
    { hash: string; task: Promise<ManagedSession> }
  >();
  #closed = false;

  constructor(
    drivers: AgentDriver[],
    private readonly repository: SessionRepository,
  ) {
    for (const driver of drivers) {
      this.#drivers.set(driver.provider, driver);
      driver.onSessionUpdate((providerSessionId, update) => {
        if (this.#closed) return;
        let managed = this.repository.findByProviderSession(
          driver.provider,
          providerSessionId,
        );
        if (!managed) return;
        const runtime = this.#runtimeFor(managed);
        if (update.type === "context.usage") {
          runtime.summary.contextUsage = update.usage;
          runtime.revision += 1;
          this.#broadcastSessionSummary(runtime);
        } else if (update.type === "compaction.finished") {
          this.#setCompacting(runtime, false);
        } else if (update.type === "metadata.changed") {
          const before = managed.title;
          managed = this.repository.updateMetadata(managed.sessionId, {
            title: update.metadata.title,
            providerUpdatedAt: update.metadata.updatedAt,
          });
          this.#refreshRuntime(runtime, managed);
          if ((managed.title ?? undefined) !== before) {
            this.#broadcastSessionSummary(runtime);
          }
        } else {
          this.#appendTimelineEvent(runtime, managed.sessionId, update);
        }
      });
    }
  }

  async initialize(): Promise<void> {
    this.repository.recoverInterrupted();

    // Claude session IDs are allocated before its first query. If the Racco
    // stopped just after Claude materialized the transcript, repair that flag
    // with a targeted lookup rather than enumerating any Provider history.
    for (const managed of this.repository.list()) {
      if (
        managed.lifecycle !== "active" ||
        managed.providerState !== "allocated" ||
        managed.providerSessionId === undefined
      ) {
        continue;
      }
      const driver = this.#drivers.get(managed.provider);
      if (driver === undefined || !driver.ready) continue;
      try {
        const snapshot = await driver.readSession(providerHandle(managed));
        this.repository.updateMetadata(managed.sessionId, {
          title: snapshot.metadata.title,
          providerUpdatedAt: snapshot.metadata.updatedAt,
        });
      } catch {
        // Leave unconfirmed sessions allocated; a subsequent operation reports
        // its current Provider error directly to the client.
      }
    }
  }

  providerStatus(provider: Provider): ProviderStatus {
    return this.#drivers.get(provider)?.ready ? "ready" : "unavailable";
  }

  async listModels(
    provider: Provider,
    projectId: string,
  ): Promise<ModelCatalog> {
    if (this.#closed) throw new Error("Racco closed");
    const project = this.repository.getProject(projectId);
    if (!project) throw new Error("Project not found");
    if (!projectDirectoryIsAvailable(project.path))
      throw new Error("Project directory is unavailable");
    const driver = this.#requireDriver(provider);
    const catalog = await this.#models.get(driver, project.path);
    if (this.#closed) throw new Error("Racco closed");
    if (!this.repository.getProject(projectId))
      throw new Error("Project not found");
    return { provider, projectId, ...catalog };
  }

  listProjects(): ProjectEntry[] {
    return this.repository
      .listProjects()
      .map((project) =>
        toProjectEntry(project, projectDirectoryIsAvailable(project.path)),
      );
  }

  async importProject(path: string): Promise<ProjectEntry> {
    const canonicalPath = await resolveProjectDirectory(path);
    if (canonicalPath === undefined) {
      throw new Error(
        "Project must be an existing absolute directory other than /",
      );
    }
    const project = this.repository.importProject({
      name: basename(canonicalPath),
      path: canonicalPath,
    });
    const entry = toProjectEntry(project, true);
    this.#broadcastToClients({ type: "project.upserted", project: entry });
    return entry;
  }

  deleteProject(projectId: string): ProjectEntry | undefined {
    const existing = this.repository.getProject(projectId);
    if (existing === undefined) return undefined;
    for (const provider of ["codex", "claude"] as const)
      this.#models.invalidate(provider, existing.path);
    const sessionIds = this.repository.deleteProject(projectId);
    for (const sessionId of sessionIds) {
      this.#removeRuntime(sessionId);
      this.#broadcastToClients({ type: "session.removed", sessionId });
    }
    this.#broadcastToClients({ type: "project.deleted", projectId });
    return toProjectEntry(existing, false);
  }

  deleteSession(sessionId: string): SessionSummary | undefined {
    const existing = this.repository.get(sessionId);
    if (existing === undefined) return undefined;
    this.#removeRuntime(sessionId);
    this.repository.deleteSession(sessionId);
    this.#broadcastToClients({ type: "session.removed", sessionId });
    return toSessionSummary(existing);
  }

  listSessions(): SessionSummary[] {
    return this.repository
      .list()
      .map((managed) => ({ ...this.#runtimeFor(managed).summary }));
  }

  async snapshot(ref: SessionRef): Promise<SessionSnapshotMessage | undefined> {
    let managed = this.repository.get(ref.sessionId);
    if (managed === undefined) return undefined;
    const runtime = this.#runtimeFor(managed);

    if (runtime.activeTurn !== undefined || runtime.summary.compacting) {
      return this.#snapshotMessage(ref.sessionId, runtime);
    }
    if (!projectDirectoryIsAvailable(managed.cwd)) {
      return this.#snapshotWithNotice(
        ref.sessionId,
        runtime,
        "Managed session working directory is unavailable",
      );
    }
    if (
      managed.lifecycle !== "active" ||
      managed.providerState === "allocated"
    ) {
      return this.#snapshotMessage(ref.sessionId, runtime);
    }

    const driver = this.#drivers.get(managed.provider);
    if (driver === undefined || !driver.ready) {
      return this.#snapshotWithNotice(
        ref.sessionId,
        runtime,
        `${managed.provider} provider is unavailable`,
      );
    }

    const revisionBeforeRead = runtime.revision;
    try {
      const snapshot = await driver.readSession(providerHandle(managed));
      managed = this.repository.updateMetadata(managed.sessionId, {
        title: snapshot.metadata.title,
        providerUpdatedAt: snapshot.metadata.updatedAt,
      });
      if (
        runtime.revision === revisionBeforeRead &&
        runtime.activeTurn === undefined
      ) {
        this.#refreshRuntime(runtime, managed);
        runtime.events = snapshot.events;
        runtime.revision += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ProviderSessionNotFoundError) {
        managed = this.repository.markProviderMissing(managed.sessionId);
      }
      this.#refreshRuntime(runtime, managed);
      return this.#snapshotWithNotice(ref.sessionId, runtime, message);
    }

    return this.#snapshotMessage(ref.sessionId, runtime);
  }

  async subscribe(
    socket: WebSocket,
    ref: SessionRef,
  ): Promise<SessionSnapshotMessage | undefined> {
    const snapshot = await this.snapshot(ref);
    if (snapshot === undefined) return undefined;
    this.#unsubscribe(socket);
    this.#sessions.get(ref.sessionId)?.subscribers.add(socket);
    this.#socketSubscriptions.set(socket, ref.sessionId);
    return snapshot;
  }

  async createSession(
    socket: WebSocket,
    provider: Provider,
    projectId: string,
    requestId: string,
    prompt: string,
    inputSettings: ModelSettings,
  ): Promise<{ ref: SessionRef; snapshot: SessionSnapshotMessage }> {
    if (this.#closed) throw new Error("Racco closed");
    const modelSettings = ModelSettingsSchema.parse(inputSettings);
    const hash = creationHash(provider, projectId, prompt, modelSettings);
    const inflight = this.#creating.get(requestId);
    if (inflight && inflight.hash !== hash)
      throw new Error(
        "Session request ID was already used with different parameters",
      );
    let task = inflight?.task;
    if (!task) {
      task = this.#allocateSession(
        provider,
        projectId,
        requestId,
        modelSettings,
        hash,
      );
      this.#creating.set(requestId, { hash, task });
    }
    let managed: ManagedSession;
    try {
      managed = await task;
    } finally {
      if (this.#creating.get(requestId)?.task === task)
        this.#creating.delete(requestId);
    }
    if (this.#closed) throw new Error("Racco closed");
    const runtime = this.#runtimeFor(managed);
    if (socket.readyState === WebSocket.OPEN) {
      this.#unsubscribe(socket);
      runtime.subscribers.add(socket);
      this.#socketSubscriptions.set(socket, managed.sessionId);
    }
    return {
      ref: { sessionId: managed.sessionId },
      snapshot: this.#snapshotMessage(managed.sessionId, runtime),
    };
  }

  async #allocateSession(
    provider: Provider,
    projectId: string,
    requestId: string,
    modelSettings: ModelSettings,
    hash: string,
  ): Promise<ManagedSession> {
    const existing = this.repository.findByCreateRequestId(requestId);
    if (existing) {
      if (existing.createRequestHash !== hash)
        throw new Error(
          "Session request ID was already used with different parameters",
        );
      if (existing.lifecycle === "failed")
        throw new Error("Session creation failed");
      return existing;
    }
    const catalog = await this.listModels(provider, projectId);
    const issue = modelSettingsError(catalog, modelSettings);
    if (issue) throw new Error(issue);
    if (this.#closed) throw new Error("Racco closed");
    const project = this.repository.getProject(projectId);
    if (!project || !projectDirectoryIsAvailable(project.path))
      throw new Error("Project directory is unavailable");
    const driver = this.#requireDriver(provider);
    const sessionId = randomUUID();
    this.repository.createProvisioning({
      sessionId,
      provider,
      projectId,
      cwd: project.path,
      title: provider === "codex" ? "New Codex session" : "New Claude session",
      requestId,
      requestHash: hash,
    });
    try {
      const created = await driver.createSession({
        raccoSessionId: sessionId,
        cwd: project.path,
        modelSettings,
      });
      const managed = this.repository.recordProviderSession({
        sessionId,
        providerSessionId: created.providerSessionId,
        materialized: created.materialized,
        cwd: created.cwd,
      });
      this.#broadcastSessionSummary(this.#runtimeFor(managed));
      return managed;
    } catch (error) {
      if (!this.#closed && this.repository.get(sessionId)) {
        this.repository.failProvisioning(sessionId);
        this.#broadcastSessionSummary(
          this.#runtimeFor(this.#requireManaged(sessionId)),
        );
      }
      throw error;
    }
  }

  async listNativeSessions(
    provider: Provider,
    projectId: string,
    cursor?: string,
  ): Promise<NativeSessionPage> {
    const project = this.repository.getProject(projectId);
    if (!project) throw new Error("项目不存在或已删除");
    if (!projectDirectoryIsAvailable(project.path))
      throw new Error("项目目录不可用");
    const driver = this.#requireDriver(provider);
    const page = await driver.listSessions({
      cwd: project.path,
      cursor,
      signal: AbortSignal.timeout(15_000),
    });
    if (!this.repository.getProject(projectId)) throw new Error("项目已删除");
    return NativeSessionPageSchema.parse({
      projectId,
      provider,
      sessions: page.sessions.flatMap((session) => {
        const managed = this.repository.findByProviderSession(
          provider,
          session.providerSessionId,
        );
        if (managed && managed.projectId !== projectId) return [];
        return [{ ...session, managedSessionId: managed?.sessionId ?? null }];
      }),
      nextCursor: page.nextCursor,
    });
  }

  async importSession(input: {
    provider: Provider;
    providerSessionId: string;
    projectId: string;
  }): Promise<SessionSummary> {
    return this.#withNativeMutation(
      input.provider,
      input.providerSessionId,
      async () => {
        const project = this.repository.getProject(input.projectId);
        if (project === undefined) {
          throw new Error("Project not found");
        }
        if (!projectDirectoryIsAvailable(project.path)) {
          throw new Error("Project directory is unavailable");
        }
        const cwd = project.path;
        const existing = this.repository.findByProviderSession(
          input.provider,
          input.providerSessionId,
        );
        if (existing !== undefined) {
          if (existing.projectId !== input.projectId) {
            throw new Error(
              "Session is already managed by a different project",
            );
          }
          return toSessionSummary(existing);
        }

        const driver = this.#requireDriver(input.provider);
        const snapshot = await driver.readSession({
          providerSessionId: input.providerSessionId,
          cwd,
        });
        const managed = this.repository.importSession({
          provider: input.provider,
          providerSessionId: input.providerSessionId,
          projectId: input.projectId,
          cwd,
          title: snapshot.metadata.title,
          updatedAt: snapshot.metadata.updatedAt,
        });
        const runtime = this.#runtimeFor(managed);
        runtime.events = snapshot.events;
        runtime.revision += 1;
        this.#broadcastSessionSummary(runtime);
        return { ...runtime.summary };
      },
    );
  }

  async deleteNativeSession(input: {
    provider: Provider;
    providerSessionId: string;
    projectId: string;
  }): Promise<{ removedManagedSessionId: string | null }> {
    return this.#withNativeMutation(
      input.provider,
      input.providerSessionId,
      async () => {
        const project = this.repository.getProject(input.projectId);
        if (project === undefined) {
          throw new Error("Project not found");
        }
        if (!projectDirectoryIsAvailable(project.path)) {
          throw new Error("Project directory is unavailable");
        }
        const managed = this.repository.findByProviderSession(
          input.provider,
          input.providerSessionId,
        );
        if (managed !== undefined && managed.projectId !== input.projectId) {
          throw new Error("Session is already managed by a different project");
        }
        if (managed !== undefined) {
          const runtime = this.#runtimeFor(managed);
          if (runtime.activeTurn !== undefined || runtime.summary.compacting) {
            throw new Error("Session is busy and cannot be deleted");
          }
        }
        const driver = this.#requireDriver(input.provider);
        await driver.deleteSession({
          providerSessionId: input.providerSessionId,
          cwd: project.path,
        });
        if (managed !== undefined) {
          this.#removeRuntime(managed.sessionId);
          this.repository.deleteSession(managed.sessionId);
          this.#broadcastToClients({
            type: "session.removed",
            sessionId: managed.sessionId,
          });
          return { removedManagedSessionId: managed.sessionId };
        }
        return { removedManagedSessionId: null };
      },
    );
  }

  // Serialize native reads that register a session with destructive deletion.
  // The reservation is visible before the first await, including queued work.
  async #withNativeMutation<T>(
    provider: Provider,
    providerSessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([provider, providerSessionId]);
    const previous = this.#nativeMutations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = previous.then(() => gate);
    this.#nativeMutations.set(key, pending);
    await previous;
    try {
      if (this.#closed) throw new Error("Racco closed");
      return await operation();
    } finally {
      release();
      if (this.#nativeMutations.get(key) === pending) {
        this.#nativeMutations.delete(key);
      }
    }
  }

  #assertNativeAvailable(managed: ManagedSession): void {
    if (
      managed.providerSessionId !== undefined &&
      this.#nativeMutations.has(
        JSON.stringify([managed.provider, managed.providerSessionId]),
      )
    )
      throw new Error("Session is busy with a native import or deletion");
  }

  async startTurn(
    ref: SessionRef,
    prompt: string,
    requestId: string,
    inputSettings: ModelSettings,
  ): Promise<boolean> {
    if (this.#closed) throw new Error("Racco closed");
    const modelSettings = ModelSettingsSchema.parse(inputSettings);
    let managed = this.#requireManaged(ref.sessionId);
    this.#assertNativeAvailable(managed);
    const initial =
      managed.createRequestId !== undefined &&
      requestId === `create:${managed.createRequestId}`;
    if (
      initial &&
      managed.createRequestHash !==
        creationHash(managed.provider, managed.projectId, prompt, modelSettings)
    ) {
      throw new Error("Initial turn does not match the creation request");
    }
    if (initial && managed.lifecycle === "active") return false;
    if (!initial && managed.lifecycle !== "active")
      throw new Error("Session is not active");
    // Check again after asynchronous discovery: another request may have won meanwhile.
    try {
      const catalog = await this.listModels(
        managed.provider,
        managed.projectId,
      );
      const issue = modelSettingsError(catalog, modelSettings);
      if (issue) throw new Error(issue);
    } catch (error) {
      if (
        initial &&
        !this.#closed &&
        this.repository.get(ref.sessionId)?.lifecycle === "provisioning"
      ) {
        this.repository.failProvisioning(ref.sessionId);
        this.#broadcastSessionSummary(
          this.#runtimeFor(this.#requireManaged(ref.sessionId)),
        );
      }
      throw error;
    }
    if (this.#closed) throw new Error("Racco closed");
    managed = this.#requireManaged(ref.sessionId);
    this.#assertNativeAvailable(managed);
    if (initial && managed.lifecycle === "active") return false;
    if (!projectDirectoryIsAvailable(managed.cwd)) {
      throw new Error("Managed session working directory is unavailable");
    }
    const driver = this.#requireDriver(managed.provider);
    const runtime = this.#runtimeFor(managed);
    if (runtime.activeTurn !== undefined || runtime.summary.compacting)
      throw new Error("Session already has an active turn");

    managed = this.repository.acceptTurn(ref.sessionId, modelSettings, initial);

    const abortController = new AbortController();
    const activeTurn: NonNullable<RuntimeSession["activeTurn"]> = {
      abortController,
    };
    runtime.activeTurn = activeTurn;
    this.#refreshRuntime(runtime, this.#requireManaged(ref.sessionId));
    this.#appendTimelineEvent(runtime, ref.sessionId, {
      type: "user.message",
      id: randomUUID(),
      text: prompt,
    });
    this.#broadcastSessionSummary(runtime);

    this.#launchOperation(managed, runtime, activeTurn, (context, signal) =>
      driver.runTurn({
        handle: providerHandle(managed),
        mode: managed.providerState === "allocated" ? "first" : "resume",
        prompt,
        modelSettings,
        context,
        signal,
      }),
    );
    return true;
  }

  async compact(ref: SessionRef): Promise<void> {
    if (this.#closed) throw new Error("Racco closed");
    const managed = this.#requireManaged(ref.sessionId);
    this.#assertNativeAvailable(managed);
    if (managed.provider !== "codex")
      throw new Error("Compaction is only supported for Codex sessions");
    if (
      managed.lifecycle !== "active" ||
      managed.providerState !== "materialized"
    )
      throw new Error("Session is not ready for compaction");
    if (!projectDirectoryIsAvailable(managed.cwd))
      throw new Error("Project directory is unavailable");
    const driver = this.#requireDriver(managed.provider);
    if (!driver.compact)
      throw new Error("Provider does not support compaction");
    const runtime = this.#runtimeFor(managed);
    if (runtime.activeTurn !== undefined || runtime.summary.compacting)
      throw new Error("Session is busy");
    this.#setCompacting(runtime, true);
    try {
      await driver.compact({ handle: providerHandle(managed) });
    } catch (error) {
      this.#setCompacting(runtime, false);
      throw error;
    }
  }

  #setCompacting(runtime: RuntimeSession, compacting: boolean): void {
    if (
      this.#sessions.get(runtime.summary.sessionId) !== runtime ||
      runtime.summary.compacting === compacting
    )
      return;
    runtime.summary.compacting = compacting;
    runtime.revision += 1;
    this.#broadcastSessionSummary(runtime);
  }

  #launchOperation(
    managed: ManagedSession,
    runtime: RuntimeSession,
    activeTurn: NonNullable<RuntimeSession["activeTurn"]>,
    execute: (context: DriverContext, signal: AbortSignal) => Promise<void>,
  ): void {
    const { abortController } = activeTurn;
    const context = this.#driverContext(managed.sessionId, runtime, (state) => {
      if (state === "idle") {
        activeTurn.terminalState ??= state;
      } else if (state === "interrupted" || state === "error") {
        activeTurn.terminalState = state;
      } else {
        this.#setLiveState(managed.sessionId, runtime, state);
      }
    });
    const task = Promise.resolve()
      .then(() => execute(context, abortController.signal))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#models.invalidate(managed.provider, managed.cwd);
        if (abortController.signal.aborted) {
          activeTurn.terminalState = "interrupted";
          return;
        }
        context.emit({
          type: "system.notice",
          id: randomUUID(),
          text: message,
          level: "error",
        });
        activeTurn.terminalState = "error";
      })
      .finally(() => {
        runtime.activeTurn = undefined;
        this.#rejectInteractions(
          managed.sessionId,
          new Error("Turn completed"),
        );
        const terminal = activeTurn.terminalState ?? "idle";
        if (this.repository.get(managed.sessionId) === undefined) return;
        const persisted = this.repository.updateExecutionState(
          managed.sessionId,
          terminal,
        );
        this.#refreshRuntime(runtime, persisted);
        this.#broadcastSessionSummary(runtime);
      });
    activeTurn.task = task;
  }

  interrupt(ref: SessionRef): boolean {
    const runtime = this.#sessions.get(ref.sessionId);
    if (runtime?.activeTurn === undefined) return false;
    runtime.activeTurn.terminalState = "interrupted";
    runtime.activeTurn.abortController.abort();
    this.#rejectInteractions(ref.sessionId, new Error("Turn interrupted"));
    return true;
  }

  resolveInteraction(id: string, response: InteractionResponse): boolean {
    const pending = this.#interactions.get(id);
    if (pending === undefined) return false;
    this.#interactions.delete(id);
    const runtime = this.#sessions.get(pending.sessionId);
    if (runtime !== undefined) {
      this.#broadcast(runtime, {
        type: "interaction.resolved",
        session: { sessionId: pending.sessionId },
        interactionId: id,
      });
      if (runtime.activeTurn !== undefined) {
        this.#setLiveState(pending.sessionId, runtime, "running");
      }
    }
    pending.resolve(response);
    return true;
  }

  registerClient(socket: WebSocket): void {
    this.#clients.add(socket);
  }

  unregisterClient(socket: WebSocket): void {
    this.#unsubscribe(socket);
    this.#clients.delete(socket);
  }

  #unsubscribe(socket: WebSocket): void {
    const sessionId = this.#socketSubscriptions.get(socket);
    if (sessionId !== undefined) {
      this.#sessions.get(sessionId)?.subscribers.delete(socket);
      this.#socketSubscriptions.delete(socket);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#models.close();
    const tasks: Promise<void>[] = [];
    for (const [sessionId, runtime] of this.#sessions) {
      if (runtime.activeTurn !== undefined) {
        runtime.activeTurn.terminalState = "interrupted";
        runtime.activeTurn.abortController.abort();
        if (runtime.activeTurn.task !== undefined)
          tasks.push(runtime.activeTurn.task);
      }
      this.#rejectInteractions(sessionId, new Error("Racco closed"));
    }
    await Promise.allSettled(
      [...this.#drivers.values()].map((driver) => driver.close()),
    );
    await Promise.allSettled([
      ...tasks,
      ...[...this.#creating.values()].map((entry) => entry.task),
    ]);
    this.#clients.clear();
    this.repository.close();
  }

  #requireDriver(provider: Provider): AgentDriver {
    const driver = this.#drivers.get(provider);
    if (driver === undefined || !driver.ready) {
      throw new Error(`${provider} provider is unavailable`);
    }
    return driver;
  }

  #requireManaged(sessionId: string): ManagedSession {
    const session = this.repository.get(sessionId);
    if (session === undefined) throw new Error("Session not found");
    return session;
  }

  #runtimeFor(managed: ManagedSession): RuntimeSession {
    let runtime = this.#sessions.get(managed.sessionId);
    if (runtime === undefined) {
      runtime = {
        summary: toSessionSummary(managed),
        events: [],
        subscribers: new Set(),
        revision: 0,
      };
      this.#sessions.set(managed.sessionId, runtime);
    } else {
      this.#refreshRuntime(runtime, managed);
    }
    return runtime;
  }

  #refreshRuntime(runtime: RuntimeSession, managed: ManagedSession): void {
    runtime.summary = {
      ...toSessionSummary(managed),
      contextUsage: runtime.summary.contextUsage,
      compacting: runtime.summary.compacting,
    };
  }

  #driverContext(
    sessionId: string,
    runtime: RuntimeSession,
    setState: (state: SessionState) => void,
  ): DriverContext {
    return {
      emit: (event) => {
        if (event.type !== "user.message") {
          this.#appendTimelineEvent(runtime, sessionId, event);
        }
      },
      setState,
      requestInteraction: (request) =>
        this.#requestInteraction(sessionId, runtime, request),
      markProviderMaterialized: () => {
        const managed = this.repository.markProviderMaterialized(sessionId);
        this.#refreshRuntime(runtime, managed);
      },
    };
  }

  #appendTimelineEvent(
    runtime: RuntimeSession,
    sessionId: string,
    event: TimelineEvent,
  ): void {
    runtime.events.push(event);
    runtime.revision += 1;
    runtime.summary.updatedAt = new Date().toISOString();
    this.#broadcast(runtime, {
      type: "timeline.event",
      session: { sessionId },
      event,
    });
  }

  #requestInteraction(
    sessionId: string,
    runtime: RuntimeSession,
    request: Omit<InteractionRequest, "id">,
  ): Promise<InteractionResponse> {
    const interaction: InteractionRequest = { ...request, id: randomUUID() };
    if (runtime.activeTurn !== undefined) {
      this.#setLiveState(sessionId, runtime, "waiting_interaction");
    }
    this.#broadcast(runtime, {
      type: "interaction.requested",
      session: { sessionId },
      interaction,
    });
    return new Promise((resolve, reject) => {
      this.#interactions.set(interaction.id, {
        sessionId,
        request: interaction,
        resolve,
        reject,
      });
    });
  }

  #setLiveState(
    sessionId: string,
    runtime: RuntimeSession,
    state: "running" | "waiting_interaction",
  ): void {
    if (runtime.summary.state === state || !this.repository.get(sessionId))
      return;
    const managed = this.repository.updateExecutionState(sessionId, state);
    this.#refreshRuntime(runtime, managed);
    runtime.revision += 1;
    this.#broadcastSessionSummary(runtime);
  }

  #pendingForSession(sessionId: string): InteractionRequest[] {
    return [...this.#interactions.values()]
      .filter((pending) => pending.sessionId === sessionId)
      .map((pending) => pending.request);
  }

  #snapshotMessage(
    sessionId: string,
    runtime: RuntimeSession,
  ): SessionSnapshotMessage {
    return {
      type: "session.snapshot",
      session: { ...runtime.summary },
      events: [...runtime.events],
      pendingInteractions: this.#pendingForSession(sessionId),
    };
  }

  #snapshotWithNotice(
    sessionId: string,
    runtime: RuntimeSession,
    text: string,
  ): SessionSnapshotMessage {
    const snapshot = this.#snapshotMessage(sessionId, runtime);
    return {
      ...snapshot,
      events: [
        ...snapshot.events,
        {
          type: "system.notice",
          id: `racco-read-error:${runtime.revision}`,
          text,
          level: "error",
        },
      ],
    };
  }

  #rejectInteractions(sessionId: string, error: Error): void {
    for (const [id, pending] of this.#interactions) {
      if (pending.sessionId === sessionId) {
        this.#interactions.delete(id);
        pending.reject(error);
      }
    }
  }

  #broadcast(runtime: RuntimeSession, message: ServerMessage): void {
    for (const subscriber of runtime.subscribers) send(subscriber, message);
  }

  #broadcastSessionSummary(runtime: RuntimeSession): void {
    this.#broadcastToClients({
      type: "session.upserted",
      session: { ...runtime.summary },
    });
  }

  #broadcastToClients(message: ServerMessage): void {
    for (const client of this.#clients) send(client, message);
  }

  /** Remove a session from the in-memory runtime map, aborting any active turn. */
  #removeRuntime(sessionId: string): void {
    const runtime = this.#sessions.get(sessionId);
    if (runtime === undefined) return;
    // Clean up socket subscriptions for this session so that #socketSubscriptions
    // does not hold stale entries pointing to a deleted session.
    for (const subscriber of runtime.subscribers) {
      this.#socketSubscriptions.delete(subscriber);
    }
    if (runtime.activeTurn !== undefined) {
      runtime.activeTurn.terminalState = "interrupted";
      runtime.activeTurn.abortController.abort();
    }
    this.#rejectInteractions(sessionId, new Error("Session deleted"));
    this.#sessions.delete(sessionId);
  }
}
