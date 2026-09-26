import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, parse } from "node:path";
import { WebSocket } from "ws";
import type {
  HistoryPage,
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
  DeleteWorktreeResult,
  WorktreeCatalog,
  WorktreeEntry,
} from "../shared/protocol.js";
import { z } from "zod";
import {
  HistoryCursorError,
  memoryHistoryPage,
  subagentSummaries,
} from "./history-page.js";
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
import { WorktreeService } from "./worktrees/service.js";
import { WorktreeAccess } from "./worktrees/access.js";
import { gitCommonDir } from "./worktrees/git.js";

type RuntimeSession = {
  summary: SessionSummary;
  events: TimelineEvent[];
  /** Only Claude has a complete in-memory history for pagination. */
  historyGeneration?: string | null;
  subscribers: Set<WebSocket>;
  revision: number;
  activeTurn?: {
    abortController: AbortController;
    terminalState?: "idle" | "interrupted" | "error";
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
  path: string,
  prompt: string,
  settings: ModelSettings,
): string {
  return requestHash([
    "session.create",
    provider,
    projectId,
    path,
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
  readonly #pendingSubscriptions = new Map<WebSocket, symbol>();
  readonly #interactions = new Map<string, PendingInteraction>();
  readonly #models = new ModelCatalogCache();
  readonly #nativeMutations = new Map<string, Promise<void>>();
  readonly #worktrees: WorktreeService;
  readonly #worktreeAccess = new WorktreeAccess();
  readonly #turnTasks = new Set<Promise<void>>();
  readonly #creating = new Map<
    string,
    { hash: string; task: Promise<ManagedSession> }
  >();
  #closed = false;

  constructor(
    drivers: AgentDriver[],
    private readonly repository: SessionRepository,
    worktreeRoot: string,
  ) {
    this.#worktrees = new WorktreeService(worktreeRoot, (projectId) =>
      this.repository
        .list()
        .filter((session) => session.projectId === projectId),
    );
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

  /**
   * The model catalog for one working directory. The boundary is the worktree,
   * not the project: a worktree is just another `cwd`, which is why the driver
   * interface needed no change.
   */
  async listModels(provider: Provider, path: string): Promise<ModelCatalog> {
    if (this.#closed) throw new Error("Racco closed");
    if (!(await this.worktreePathIsReadable(path)))
      throw new Error("Worktree directory is unavailable");
    const driver = this.#requireDriver(provider);
    const catalog = await this.#models.get(driver, path);
    if (this.#closed) throw new Error("Racco closed");
    return { provider, path, ...catalog };
  }

  /** The worktrees of a project, from the cache. Creates nothing, scans nothing. */
  async listWorktrees(projectId: string): Promise<WorktreeCatalog> {
    const project = this.repository.getProject(projectId);
    if (project === undefined) throw new Error("项目不存在或已删除");
    return this.#worktrees.catalog(project);
  }

  /**
   * Re-reads a project's worktrees from Git. This is the only way an external
   * change — a `git worktree add` in a terminal — enters Racco; there is no
   * polling and no filesystem watch.
   */
  async refreshWorktrees(projectId: string): Promise<WorktreeCatalog> {
    const project = this.repository.getProject(projectId);
    if (project === undefined) throw new Error("项目不存在或已删除");
    return this.#worktrees.refresh(project);
  }

  async createWorktree(input: {
    projectId: string;
    name: string;
    baseRef?: string;
  }): Promise<{ catalog: WorktreeCatalog; worktree: WorktreeEntry }> {
    const project = this.repository.getProject(input.projectId);
    if (project === undefined) throw new Error("项目不存在或已删除");
    if (!projectDirectoryIsAvailable(project.path))
      throw new Error("项目目录不可用");
    const created = await this.#worktreeAccess.use(
      project.projectId,
      project.path,
      () => this.#worktrees.create(project, input.name, input.baseRef),
    );
    for (const provider of ["codex", "claude"] as const) {
      this.#models.invalidate(provider, created.worktree.path);
    }
    this.#broadcastToClients({
      type: "worktree.upserted",
      worktree: created.worktree,
    });
    return created;
  }

  async deleteWorktree(input: {
    projectId: string;
    path: string;
    force?: boolean;
    deleteBranch?: boolean;
  }): Promise<DeleteWorktreeResult> {
    return this.#worktreeAccess.remove(
      input.projectId,
      input.path,
      async () => {
        const project = this.repository.getProject(input.projectId);
        if (project === undefined) throw new Error("项目不存在或已删除");

        // A worktree holding a running turn is not deleted: the alternative is
        // silently interrupting work the user is watching.
        for (const session of this.repository.list()) {
          if (
            session.projectId !== input.projectId ||
            session.cwd !== input.path
          )
            continue;
          const runtime = this.#sessions.get(session.sessionId);
          if (
            runtime?.activeTurn !== undefined ||
            runtime?.summary.compacting
          ) {
            throw new Error("该 Worktree 下有正在进行的对话，无法删除");
          }
        }

        const result = await this.#worktrees.remove(
          project,
          input.path,
          input.force,
          input.deleteBranch,
        );
        for (const sessionId of result.removedSessionIds) {
          this.#removeRuntime(sessionId);
          this.repository.deleteSession(sessionId);
          this.#broadcastToClients({ type: "session.removed", sessionId });
        }
        this.#broadcastToClients({
          type: "worktree.deleted",
          path: input.path,
        });
        return result;
      },
    );
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
    // One repository is registered once. The check is the Git *common* directory,
    // not the path, so importing a subdirectory of an already-registered
    // repository is refused with a pointer to the project that owns it, instead
    // of splitting one repository across two projects.
    const owner = await this.#projectOwningRepository(canonicalPath);
    if (owner !== undefined && owner.path !== canonicalPath) {
      throw new Error(`该仓库已注册为项目「${owner.name}」（${owner.path}）`);
    }
    const project = this.repository.importProject({
      name: basename(canonicalPath),
      path: canonicalPath,
    });
    const entry = toProjectEntry(project, true);
    this.#broadcastToClients({ type: "project.upserted", project: entry });
    return entry;
  }

  /**
   * The registered project that shares a Git common directory with `path`, if
   * any. A directory that is not in a repository has no owner.
   */
  async #projectOwningRepository(
    path: string,
  ): Promise<{ name: string; path: string } | undefined> {
    const commonDir = await gitCommonDir(path);
    if (commonDir === undefined) return undefined;
    for (const project of this.repository.listProjects()) {
      if (project.path === path) continue;
      if ((await gitCommonDir(project.path)) === commonDir) return project;
    }
    return undefined;
  }

  /**
   * Whether a directory is usable as a worktree root for file browsing, model
   * catalogs and native-session listings. A usable root is the primary worktree
   * of a registered project (its project directory) or a derived worktree that a
   * registered project's catalog claims. An arbitrary directory on the host is
   * not a worktree root: importing a project is the user's explicit act of
   * opening the daemon's filesystem, and these read endpoints do not broaden
   * that to unregistered paths.
   */
  async worktreePathIsReadable(path: string): Promise<boolean> {
    if (!projectDirectoryIsAvailable(path)) return false;
    // The project's own directory is its primary worktree.
    if (this.repository.listProjects().some((project) => project.path === path))
      return true;
    // A derived worktree must be claimed by a registered project's catalog. A
    // catalog that cannot be derived is skipped, not fatal: one degraded project
    // must not make every worktree unreadable.
    for (const project of this.repository.listProjects()) {
      try {
        const catalog = await this.#worktrees.catalog(project);
        if (catalog.worktrees.some((entry) => entry.path === path)) return true;
      } catch {
        // The project's worktrees are unknown right now; keep checking the rest.
      }
    }
    return false;
  }

  async deleteProject(
    projectId: string,
    removeWorktrees = false,
  ): Promise<ProjectEntry | undefined> {
    return this.#worktreeAccess.remove(projectId, undefined, async () => {
      const existing = this.repository.getProject(projectId);
      if (existing === undefined) return undefined;
      // Linked worktrees go with the project only when the caller asks; the
      // project directory itself is the main worktree and is never removed. When
      // they stay, the directories are left on disk and a later re-import of the
      // same project directory re-derives them from Git. Failures are reported,
      // not thrown: a directory that cannot be cleaned up must not trap the user.
      //
      // A linked worktree holding a live turn is never force-removed underneath
      // it, matching the single-worktree delete path: its directory is kept and
      // reported, not silently aborted. Project deletion still destroys the
      // project's sessions (including that live turn's record) either way.
      const report = removeWorktrees
        ? await this.#worktrees.removeForProject(
            existing,
            this.#linkedWorktreesWithLiveTurns(projectId),
          )
        : undefined;
      for (const provider of ["codex", "claude"] as const)
        this.#models.invalidate(provider, existing.path);
      const sessionIds = this.repository.deleteProject(projectId);
      for (const sessionId of sessionIds) {
        this.#removeRuntime(sessionId);
        this.#broadcastToClients({ type: "session.removed", sessionId });
      }
      this.#broadcastToClients({ type: "project.deleted", projectId });
      if (report !== undefined) {
        const stuck = report.removals.filter(
          (removal) => !removal.removed && !removal.skipped,
        );
        if (stuck.length > 0) {
          throw new Error(
            `项目已删除，但下列目录可能残留：${stuck
              .map(
                (removal) =>
                  `${removal.path}（${removal.reason ?? "未知原因"}）`,
              )
              .join("；")}`,
          );
        }
      }
      return toProjectEntry(existing, false);
    });
  }

  /** Paths of linked worktrees that hold a live or compacting turn. */
  #linkedWorktreesWithLiveTurns(projectId: string): Set<string> {
    const busy = new Set<string>();
    for (const session of this.repository.list()) {
      if (session.projectId !== projectId) continue;
      const runtime = this.#sessions.get(session.sessionId);
      if (runtime?.activeTurn !== undefined || runtime?.summary.compacting) {
        busy.add(session.cwd);
      }
    }
    return busy;
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
        if (managed.provider === "claude")
          runtime.historyGeneration = randomUUID();
        runtime.revision += 1;
      } else {
        this.#refreshRuntime(runtime, managed);
        return this.#snapshotWithNotice(
          ref.sessionId,
          runtime,
          "读取期间收到实时更新，本次未更新完整历史，请重试",
          "warning",
        );
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

  async historySnapshot(
    ref: SessionRef,
  ): Promise<SessionSnapshotMessage | undefined> {
    const managed = this.repository.get(ref.sessionId);
    if (!managed) return undefined;
    const page = await this.historyPage(ref, {});
    const runtime = this.#runtimeFor(this.#requireManaged(ref.sessionId));
    return {
      type: "session.snapshot",
      session: { ...runtime.summary },
      pendingInteractions: this.#pendingForSession(ref.sessionId),
      ...page,
    };
  }

  async historyPage(
    ref: SessionRef,
    input: { cursor?: string; agentId?: string; refresh?: boolean },
  ): Promise<HistoryPage> {
    const managed = this.#requireManaged(ref.sessionId);
    const runtime = this.#runtimeFor(managed);
    if (input.refresh && input.cursor !== undefined)
      throw new Error("Cannot refresh an older history page");
    if (managed.provider === "claude") {
      if (input.cursor !== undefined && runtime.historyGeneration == null)
        throw new HistoryCursorError("历史已更新，请重新加载对话");
      if (input.refresh && (runtime.activeTurn || runtime.summary.compacting))
        throw new Error("会话运行中，请稍后刷新历史");
      if (runtime.historyGeneration == null || input.refresh) {
        const previousGeneration = runtime.historyGeneration;
        const snapshot = await this.snapshot(ref);
        if (
          this.#sessions.get(ref.sessionId) !== runtime ||
          !this.repository.get(ref.sessionId)
        )
          throw new Error("Session not found");
        if (
          runtime.historyGeneration == null ||
          (input.refresh && runtime.historyGeneration === previousGeneration)
        ) {
          if (
            managed.providerState === "allocated" &&
            runtime.events.length === 0
          )
            runtime.historyGeneration = randomUUID();
          else {
            const notice = snapshot?.events.at(-1);
            throw new Error(
              notice?.type === "system.notice"
                ? notice.text
                : "历史读取未完成，请重试",
            );
          }
        }
      }
      if (
        input.agentId !== undefined &&
        !runtime.events.some(
          (event) => "agentId" in event && event.agentId === input.agentId,
        )
      )
        throw new Error("Subagent not found");
      return memoryHistoryPage(
        runtime.events,
        ref.sessionId,
        runtime.historyGeneration!,
        input.agentId,
        input.cursor,
      );
    }
    if (managed.lifecycle !== "active" || managed.providerState === "allocated")
      return { events: [], nextCursor: null };
    const driver = this.#requireDriver(managed.provider);
    if (!driver.readHistoryPage)
      throw new Error("Codex native history pagination is required");
    let cursor: string | undefined;
    if (input.cursor !== undefined) {
      try {
        const parsed = z
          .strictObject({
            sessionId: z.string(),
            agentId: z.string().nullable(),
            cursor: z.string(),
          })
          .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()));
        if (
          parsed.sessionId !== ref.sessionId ||
          parsed.agentId !== (input.agentId ?? null)
        )
          throw new Error("Wrong history");
        cursor = parsed.cursor;
      } catch {
        throw new HistoryCursorError("历史游标无效，请重新加载对话");
      }
    }
    const beforeRead = runtime.events.length;
    const activeAtRead = runtime.activeTurn;
    const page = await driver
      .readHistoryPage(providerHandle(managed), {
        cursor,
        agentId: input.agentId,
      })
      .catch((error: unknown) => {
        if (
          cursor !== undefined &&
          error instanceof Error &&
          /cursor/i.test(error.message)
        )
          throw new HistoryCursorError("历史游标已失效，请重新加载对话");
        throw error;
      });
    if (
      this.#sessions.get(ref.sessionId) !== runtime ||
      !this.repository.get(ref.sessionId)
    )
      throw new Error("Session not found");
    const updated =
      runtime.activeTurn || runtime.summary.compacting
        ? this.#requireManaged(ref.sessionId)
        : this.repository.updateMetadata(ref.sessionId, {
            title: page.metadata.title,
            providerUpdatedAt: page.metadata.updatedAt,
          });
    this.#refreshRuntime(runtime, updated);
    let events = page.events;
    if (input.cursor === undefined) {
      // The active root turn uses Racco's user-message ID; never display both
      // that optimistic row and the native user item for the same turn.
      const localStart = runtime.events.findLastIndex(
        (event) => event.type === "user.message",
      );
      if (
        input.agentId === undefined &&
        (runtime.activeTurn || activeAtRead) &&
        localStart !== -1
      ) {
        const local = runtime.events.slice(localStart);
        events = [
          ...events,
          ...memoryHistoryPage(local, ref.sessionId, "live").events,
          ...subagentSummaries(runtime.events),
        ];
      } else {
        const updates = runtime.events
          .slice(beforeRead)
          .filter((event) =>
            input.agentId === undefined
              ? event.type !== "subagent.event"
              : event.type === "subagent.event" &&
                event.agentId === input.agentId,
          );
        events = [...events, ...updates];
      }
    }
    return {
      events,
      nextCursor:
        page.nextCursor === null
          ? null
          : Buffer.from(
              JSON.stringify({
                sessionId: ref.sessionId,
                agentId: input.agentId ?? null,
                cursor: page.nextCursor,
              }),
            ).toString("base64url"),
    };
  }

  async subscribe(
    socket: WebSocket,
    ref: SessionRef,
  ): Promise<SessionSnapshotMessage | undefined> {
    this.#unsubscribe(socket);
    const request = Symbol();
    this.#pendingSubscriptions.set(socket, request);
    try {
      const snapshot = await this.historySnapshot(ref);
      // Provider reads can finish out of order. Only the last navigation may
      // own the socket; older snapshots can still refresh the client's cache.
      if (
        snapshot !== undefined &&
        this.#pendingSubscriptions.get(socket) === request &&
        socket.readyState === WebSocket.OPEN
      ) {
        this.#sessions.get(ref.sessionId)?.subscribers.add(socket);
        this.#socketSubscriptions.set(socket, ref.sessionId);
      }
      return snapshot;
    } finally {
      if (this.#pendingSubscriptions.get(socket) === request)
        this.#pendingSubscriptions.delete(socket);
    }
  }

  async createSession(
    socket: WebSocket,
    provider: Provider,
    projectId: string,
    path: string,
    requestId: string,
    prompt: string,
    inputSettings: ModelSettings,
  ): Promise<{ ref: SessionRef; snapshot: SessionSnapshotMessage }> {
    if (this.#closed) throw new Error("Racco closed");
    const modelSettings = ModelSettingsSchema.parse(inputSettings);
    const hash = creationHash(provider, projectId, path, prompt, modelSettings);
    const inflight = this.#creating.get(requestId);
    if (inflight && inflight.hash !== hash)
      throw new Error(
        "Session request ID was already used with different parameters",
      );
    let task = inflight?.task;
    if (!task) {
      task = this.#worktreeAccess.use(projectId, path, () =>
        this.#allocateSession(
          provider,
          projectId,
          path,
          requestId,
          modelSettings,
          hash,
        ),
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
    if (managed.provider === "claude" && managed.lifecycle === "provisioning")
      runtime.historyGeneration ??= randomUUID();
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
    path: string,
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
    await this.#assertWorktree(projectId, path);
    const catalog = await this.listModels(provider, path);
    const issue = modelSettingsError(catalog, modelSettings);
    if (issue) throw new Error(issue);
    if (this.#closed) throw new Error("Racco closed");
    const driver = this.#requireDriver(provider);
    const sessionId = randomUUID();
    this.repository.createProvisioning({
      sessionId,
      provider,
      projectId,
      cwd: path,
      title: provider === "codex" ? "New Codex session" : "New Claude session",
      requestId,
      requestHash: hash,
    });
    try {
      const created = await driver.createSession({
        raccoSessionId: sessionId,
        cwd: path,
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
    path: string,
    cursor?: string,
  ): Promise<NativeSessionPage> {
    if (!(await this.worktreePathIsReadable(path)))
      throw new Error("Worktree 目录不可用");
    const driver = this.#requireDriver(provider);
    const page = await driver.listSessions({
      cwd: path,
      cursor,
      signal: AbortSignal.timeout(15_000),
    });
    return NativeSessionPageSchema.parse({
      path,
      provider,
      sessions: page.sessions.map((session) => {
        const managed = this.repository.findByProviderSession(
          provider,
          session.providerSessionId,
        );
        return { ...session, managedSessionId: managed?.sessionId ?? null };
      }),
      nextCursor: page.nextCursor,
    });
  }

  async importSession(input: {
    provider: Provider;
    providerSessionId: string;
    projectId: string;
    path: string;
  }): Promise<SessionSummary> {
    return this.#worktreeAccess.use(input.projectId, input.path, () =>
      this.#withNativeMutation(
        input.provider,
        input.providerSessionId,
        async () => {
          if (this.repository.getProject(input.projectId) === undefined) {
            throw new Error("Project not found");
          }
          await this.#assertWorktree(input.projectId, input.path);
          const cwd = input.path;
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
          if (managed.provider === "claude")
            runtime.historyGeneration = randomUUID();
          runtime.revision += 1;
          this.#broadcastSessionSummary(runtime);
          return { ...runtime.summary };
        },
      ),
    );
  }

  async deleteNativeSession(input: {
    provider: Provider;
    providerSessionId: string;
    projectId: string;
    path: string;
  }): Promise<{ removedManagedSessionId: string | null }> {
    return this.#worktreeAccess.use(input.projectId, input.path, () =>
      this.#withNativeMutation(
        input.provider,
        input.providerSessionId,
        async () => {
          if (this.repository.getProject(input.projectId) === undefined) {
            throw new Error("Project not found");
          }
          await this.#assertWorktree(input.projectId, input.path);
          const managed = this.repository.findByProviderSession(
            input.provider,
            input.providerSessionId,
          );
          if (managed !== undefined && managed.projectId !== input.projectId) {
            throw new Error(
              "Session is already managed by a different project",
            );
          }
          if (managed !== undefined) {
            const runtime = this.#runtimeFor(managed);
            if (
              runtime.activeTurn !== undefined ||
              runtime.summary.compacting
            ) {
              throw new Error("Session is busy and cannot be deleted");
            }
          }
          const driver = this.#requireDriver(input.provider);
          await driver.deleteSession({
            providerSessionId: input.providerSessionId,
            cwd: input.path,
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
      ),
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

  /**
   * Refuses a `path` that is not currently one of the project's worktrees. This
   * keeps the directory boundary honest: a stale path from a client that has not
   * refreshed — a worktree removed in a terminal, say — cannot be used to create
   * or import a session in a directory the project no longer claims.
   */
  async #assertWorktree(projectId: string, path: string): Promise<void> {
    const project = this.repository.getProject(projectId);
    if (project === undefined) throw new Error("Project not found");
    if (!projectDirectoryIsAvailable(path))
      throw new Error("Worktree directory is unavailable");
    if (path === project.path) return;
    const catalog = await this.#worktrees.catalog(project);
    const match = catalog.worktrees.find((entry) => entry.path === path);
    if (match === undefined) {
      throw new Error("该目录不是当前项目的 Worktree，请刷新项目列表");
    }
    if (!match.available) throw new Error("Worktree 目录不可用");
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
    const target = this.#requireManaged(ref.sessionId);
    return this.#worktreeAccess.use(target.projectId, target.cwd, async () => {
      const modelSettings = ModelSettingsSchema.parse(inputSettings);
      let managed = this.#requireManaged(ref.sessionId);
      this.#assertNativeAvailable(managed);
      const initial =
        managed.createRequestId !== undefined &&
        requestId === `create:${managed.createRequestId}`;
      if (
        initial &&
        managed.createRequestHash !==
          creationHash(
            managed.provider,
            managed.projectId,
            managed.cwd,
            prompt,
            modelSettings,
          )
      ) {
        throw new Error("Initial turn does not match the creation request");
      }
      if (initial && managed.lifecycle === "active") return false;
      if (!initial && managed.lifecycle !== "active")
        throw new Error("Session is not active");
      // Check again after asynchronous discovery: another request may have won meanwhile.
      try {
        const catalog = await this.listModels(managed.provider, managed.cwd);
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

      if (managed.provider === "claude" && runtime.historyGeneration == null)
        await this.historyPage(ref, {});
      if (runtime.activeTurn !== undefined)
        throw new Error("Session already has an active turn");

      managed = this.repository.acceptTurn(
        ref.sessionId,
        modelSettings,
        initial,
      );

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
    });
  }

  async compact(ref: SessionRef): Promise<void> {
    if (this.#closed) throw new Error("Racco closed");
    const target = this.#requireManaged(ref.sessionId);
    return this.#worktreeAccess.use(target.projectId, target.cwd, async () => {
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
    });
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
        this.#turnTasks.delete(task);
        runtime.activeTurn = undefined;
        this.#rejectInteractions(
          managed.sessionId,
          new Error("Turn completed"),
        );
        const terminal = activeTurn.terminalState ?? "idle";
        if (this.#sessions.get(managed.sessionId) !== runtime) return;
        if (this.repository.get(managed.sessionId) === undefined) return;
        const persisted = this.repository.updateExecutionState(
          managed.sessionId,
          terminal,
        );
        this.#refreshRuntime(runtime, persisted);
        this.#broadcastSessionSummary(runtime);
      });
    this.#turnTasks.add(task);
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
    this.#pendingSubscriptions.delete(socket);
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
    this.#worktrees.close();
    for (const [sessionId, runtime] of this.#sessions) {
      if (runtime.activeTurn !== undefined) {
        runtime.activeTurn.terminalState = "interrupted";
        runtime.activeTurn.abortController.abort();
      }
      this.#rejectInteractions(sessionId, new Error("Racco closed"));
    }
    await Promise.allSettled(
      [...this.#drivers.values()].map((driver) => driver.close()),
    );
    await Promise.allSettled([
      ...this.#turnTasks,
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
        ...(managed.provider === "claude" ? { historyGeneration: null } : {}),
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
      nextCursor: null,
    };
  }

  #snapshotWithNotice(
    sessionId: string,
    runtime: RuntimeSession,
    text: string,
    level: "warning" | "error" = "error",
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
          level,
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
