import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ContextUsageSchema,
  HISTORY_PAGE_SIZE,
} from "../../../shared/protocol.js";
import type {
  AgentTimelineEvent,
  ToolCompletionStatus,
  InteractionResponse,
  SubagentState,
  TimelineEvent,
  ModelSettings,
  ProviderModelCatalog,
} from "../../../shared/protocol.js";
import type {
  AgentDriver,
  DriverContext,
  ProviderSessionCreation,
  ProviderSessionHandle,
  SessionSnapshot,
  ProviderSessionUpdate,
  ProviderSessionPage,
} from "../driver.js";
import { ProviderSessionNotFoundError, SESSION_PAGE_SIZE } from "../driver.js";
import { resolveProjectDirectory } from "../../project-path.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { CodexActivityMapper } from "./activity-mapper.js";
import { CodexToolLifecycle } from "./tool-lifecycle.js";
import { CodexModelListSchema, codexModelCatalog } from "../model-options.js";
import {
  mapItemEvents,
  mapSubagentEvents,
  mapSubagentThread,
  mapThreadEvents,
  mapThreadState,
  mapThreadSummary,
  mapTurnState,
} from "./event-mapper.js";
import type {
  DeltaNotification,
  ErrorNotification,
  ItemNotification,
  JsonRpcNotification,
  JsonRpcRequest,
  CodexThread,
  CodexTurn,
  ThreadReadResponse,
  ThreadListResponse,
  ThreadStartResponse,
  ThreadStartedNotification,
  ThreadStatusNotification,
  TurnNotification,
  TurnStartResponse,
  TokenUsageNotification,
  UserInputParams,
} from "./types.js";

type TurnWaiter = {
  resolve(): void;
  reject(error: Error): void;
  turnId?: string;
  pending: JsonRpcNotification[];
  interrupt(): void;
};

type SubagentLink = {
  agentId: string;
  rootThreadId: string;
  name?: string;
  state?: SubagentState;
  snapshotGeneration: number;
  appliedSnapshotGeneration: number;
  currentTurn?: { id: string; terminal: boolean; completedItems: Set<string> };
};

type SnapshotRead = {
  generation: number;
  changedItems: Set<string>;
  endedTurns: Set<string>;
  unalignedItems: Set<string>;
  endedThread: boolean;
  stateChanged: boolean;
  invalid: boolean;
};

const SessionListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      cwd: z.string(),
      name: z.string().nullable(),
      preview: z.string(),
      updatedAt: z.number().int().nonnegative(),
      parentThreadId: z.string().nullable().optional(),
      source: z.unknown(),
    }),
  ),
  nextCursor: z.string().min(1).nullable(),
});

function subagentTurnState(turn: CodexTurn): SubagentState {
  if (turn.status === "inProgress") return "running";
  if (turn.status === "interrupted") return "interrupted";
  if (turn.status === "failed") return "error";
  return "completed";
}

function subagentThreadState(status: CodexThread["status"]): SubagentState {
  if (status.type === "active") return "running";
  if (status.type === "systemError") return "error";
  return "completed";
}

function emitAgentEvents(
  context: Pick<DriverContext, "emit">,
  events: AgentTimelineEvent[],
  subagent?: SubagentLink,
): void {
  for (const event of events) {
    context.emit(
      subagent === undefined
        ? event
        : {
            type: "subagent.event",
            id: `${subagent.agentId}:event:${event.type}:${event.id}`,
            agentId: subagent.agentId,
            event: { ...event, id: `${subagent.agentId}:${event.id}` },
          },
    );
  }
}

export class CodexDriver implements AgentDriver {
  readonly provider = "codex" as const;
  readonly #client: CodexAppServerClient;
  readonly #contexts = new Map<string, DriverContext>();
  readonly #loadedThreads = new Set<string>();
  readonly #observedRoots = new Set<string>();
  readonly #turnWaiters = new Map<string, TurnWaiter>();
  readonly #compactions = new Map<string, string | undefined>();
  readonly #activityMapper = new CodexActivityMapper();
  readonly #toolLifecycle = new CodexToolLifecycle();
  readonly #toolOutput = new Map<
    string,
    { output: string; live: boolean; generation: number }
  >();
  readonly #subagents = new Map<string, SubagentLink>();
  readonly #snapshotReads = new Map<string, Set<SnapshotRead>>();
  readonly #unalignedItems = new Map<string, Map<string, string>>();
  #ready = false;
  #sessionUpdate?: (
    providerSessionId: string,
    update: ProviderSessionUpdate,
  ) => void;

  constructor(log: ConstructorParameters<typeof CodexAppServerClient>[0]) {
    this.#client = new CodexAppServerClient(log, (request) =>
      this.#handleServerRequest(request),
    );
    this.#client.onNotification((notification) =>
      this.#handleNotification(notification),
    );
    this.#client.onExit((error) => this.#handleExit(error));
  }

  get ready(): boolean {
    return this.#ready;
  }

  async listSessions({
    cwd,
    cursor,
    signal,
  }: Parameters<AgentDriver["listSessions"]>[0]): Promise<ProviderSessionPage> {
    this.#assertReady();
    const page = SessionListSchema.parse(
      await this.#client.request(
        "thread/list",
        {
          cwd,
          cursor,
          limit: SESSION_PAGE_SIZE,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: false,
          sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
          useStateDbOnly: true,
        },
        signal,
      ),
    );
    if (page.nextCursor !== null && page.nextCursor === cursor)
      throw new Error("Codex returned a repeated session cursor");
    const sessions: ProviderSessionPage["sessions"] = [];
    for (const thread of page.data) {
      signal.throwIfAborted();
      if (
        thread.parentThreadId ||
        (typeof thread.source === "object" &&
          thread.source !== null &&
          "subAgent" in thread.source)
      )
        continue;
      if ((await resolveProjectDirectory(thread.cwd)) !== cwd) continue;
      sessions.push({
        providerSessionId: thread.id,
        title: thread.name || thread.preview || undefined,
        updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
      });
    }
    return { sessions, nextCursor: page.nextCursor };
  }

  async listModels({
    signal,
  }: {
    cwd: string;
    signal: AbortSignal;
  }): Promise<ProviderModelCatalog> {
    this.#assertReady();
    const rows: Parameters<typeof codexModelCatalog>[0] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = CodexModelListSchema.parse(
        await this.#client.request(
          "model/list",
          {
            limit: 100,
            includeHidden: false,
            cursor,
          },
          signal,
        ),
      );
      rows.push(...page.data);
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (cursors.has(cursor))
          throw new Error("Codex returned a repeated model cursor");
        cursors.add(cursor);
      }
    } while (cursor !== null);
    return codexModelCatalog(rows);
  }

  async start(): Promise<void> {
    await this.#client.start();
    this.#ready = true;
  }

  async close(): Promise<void> {
    this.#ready = false;
    this.#clearSnapshotReads();
    const error = new Error("Codex provider closed");
    for (const [threadId, context] of this.#contexts) {
      emitAgentEvents(context, this.#finishTools(threadId, "failed"));
    }
    this.#finishSubagents(error);
    this.#sessionUpdate = undefined;
    for (const threadId of this.#compactions.keys())
      this.#finishCompaction(threadId);
    for (const waiter of this.#turnWaiters.values()) waiter.reject(error);
    this.#turnWaiters.clear();
    this.#loadedThreads.clear();
    this.#observedRoots.clear();
    this.#contexts.clear();
    this.#subagents.clear();
    this.#activityMapper.clear();
    this.#toolLifecycle.clear();
    this.#toolOutput.clear();
    await this.#client.close();
  }

  async readSession(handle: ProviderSessionHandle): Promise<SessionSnapshot> {
    this.#assertReady();
    let response: ThreadReadResponse;
    try {
      response = await this.#client.request<ThreadReadResponse>("thread/read", {
        threadId: handle.providerSessionId,
        includeTurns: true,
      });
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw new ProviderSessionNotFoundError("Codex thread not found");
      }
      throw error;
    }
    const cwd = await resolveProjectDirectory(response.thread.cwd);
    if (cwd === undefined) {
      throw new Error("Codex thread working directory is unavailable");
    }
    if (cwd !== handle.cwd) {
      throw new Error(
        "Codex thread working directory does not match the managed session",
      );
    }
    const thread = { ...response.thread, cwd };
    this.#observedRoots.add(thread.id);
    const resolveSubagentId = (providerThreadId: string) =>
      this.#rememberSubagent(providerThreadId, thread.id).agentId;
    const events: TimelineEvent[] = mapThreadEvents(thread, resolveSubagentId);
    const subagentThreads = await this.#readSubagentThreads(thread.id);
    for (const subagentThread of subagentThreads) {
      const parentThreadId = subagentThread.parentThreadId!;
      const link = this.#rememberSubagent(subagentThread.id, thread.id);
      link.name = subagentThread.agentNickname ?? link.name;
      const parentAgentId =
        parentThreadId === thread.id
          ? undefined
          : this.#rememberSubagent(parentThreadId, thread.id).agentId;
      const childEvents = mapSubagentThread(
        subagentThread,
        link.agentId,
        resolveSubagentId,
        parentAgentId,
      );
      events.push(...childEvents);
      if (link.state === undefined) {
        const state = childEvents.at(-1);
        if (state?.type === "subagent.state") link.state = state.state;
      }
    }
    return {
      metadata: mapThreadSummary(thread),
      events,
    };
  }

  async readHistoryPage(
    handle: ProviderSessionHandle,
    input: { cursor?: string; agentId?: string },
  ) {
    this.#assertReady();
    const activeWaiter = this.#turnWaiters.get(handle.providerSessionId);
    const root = await this.#client.request<ThreadReadResponse>("thread/read", {
      threadId: handle.providerSessionId,
      includeTurns: false,
    });
    if ((await resolveProjectDirectory(root.thread.cwd)) !== handle.cwd)
      throw new Error(
        "Codex thread working directory does not match the managed session",
      );
    this.#observedRoots.add(root.thread.id);
    const summaries =
      input.cursor === undefined || input.agentId !== undefined
        ? await this.#listSubagentThreads(root.thread.id)
        : [];
    const child =
      input.agentId === undefined
        ? undefined
        : summaries.find(
            (thread) =>
              this.#subagents.get(thread.id)?.agentId === input.agentId,
          );
    if (input.agentId !== undefined && child === undefined)
      throw new Error("Subagent not found");
    const thread = child ?? root.thread;
    const link =
      child === undefined ? undefined : this.#subagents.get(child.id)!;
    const read: SnapshotRead | undefined =
      link === undefined || input.cursor !== undefined
        ? undefined
        : {
            generation: ++link.snapshotGeneration,
            changedItems: new Set(),
            endedTurns: new Set(),
            unalignedItems: new Set(),
            endedThread: false,
            stateChanged: false,
            invalid: false,
          };
    if (read) {
      const reads =
        this.#snapshotReads.get(thread.id) ?? new Set<SnapshotRead>();
      reads.add(read);
      this.#snapshotReads.set(thread.id, reads);
    }
    try {
      const waiterBeforePage = this.#turnWaiters.get(handle.providerSessionId);
      const page = await this.#client.request<{
        data: CodexTurn[];
        nextCursor: string | null;
      }>("thread/turns/list", {
        threadId: thread.id,
        cursor: input.cursor,
        limit: HISTORY_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "full",
      });
      // The hub owns the live root turn, including its optimistic user ID.
      // Use native turn identity, never prompt text, to exclude that duplicate.
      const liveTurns = new Set([
        activeWaiter?.turnId,
        waiterBeforePage?.turnId,
        this.#turnWaiters.get(handle.providerSessionId)?.turnId,
      ]);
      const paged = {
        ...thread,
        turns: [...page.data]
          .reverse()
          .filter((turn) => child !== undefined || !liveTurns.has(turn.id)),
      };
      if (read) {
        if (read.invalid || read.unalignedItems.size > 0)
          throw new Error("Codex 子代理在读取期间发生变化，请重试");
        this.#seedThreadContent(paged, root.thread.id, read.generation, read);
      }
      const resolve = (id: string) =>
        this.#rememberSubagent(id, root.thread.id).agentId;
      const events =
        child === undefined
          ? mapThreadEvents(paged, resolve)
          : mapSubagentThread(
              paged,
              input.agentId!,
              resolve,
              child.parentThreadId === root.thread.id
                ? undefined
                : resolve(child.parentThreadId!),
            );
      if (child === undefined && input.cursor === undefined) {
        for (const summary of summaries) {
          const agentId = resolve(summary.id);
          const parent =
            summary.parentThreadId === root.thread.id
              ? undefined
              : resolve(summary.parentThreadId!);
          events.push(
            ...mapSubagentThread(
              { ...summary, turns: [] },
              agentId,
              resolve,
              parent,
            ),
          );
        }
      }
      return {
        metadata: mapThreadSummary(root.thread),
        events,
        nextCursor: page.nextCursor,
      };
    } finally {
      if (read) {
        const reads = this.#snapshotReads.get(thread.id);
        reads?.delete(read);
        if (reads?.size === 0) this.#snapshotReads.delete(thread.id);
      }
    }
  }

  async deleteSession(handle: ProviderSessionHandle): Promise<void> {
    this.#assertReady();
    // Validate ownership through the thread's own cwd before destroying the
    // rollout file, so a stale native ID from another project cannot be deleted.
    let response: ThreadReadResponse;
    try {
      response = await this.#client.request<ThreadReadResponse>("thread/read", {
        threadId: handle.providerSessionId,
      });
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw new ProviderSessionNotFoundError("Codex thread not found");
      }
      throw error;
    }
    const cwd = await resolveProjectDirectory(response.thread.cwd);
    if (cwd === undefined) {
      throw new Error("Codex thread working directory is unavailable");
    }
    if (cwd !== handle.cwd) {
      throw new Error(
        "Codex thread working directory does not match the managed session",
      );
    }
    await this.#client.request("thread/delete", {
      threadId: handle.providerSessionId,
    });
  }

  async createSession(input: {
    raccoSessionId: string;
    cwd: string;
    modelSettings: ModelSettings;
  }): Promise<ProviderSessionCreation> {
    this.#assertReady();
    const canonicalCwd = await resolveProjectDirectory(input.cwd);
    if (canonicalCwd === undefined) {
      throw new Error("Project directory is unavailable");
    }
    const response = await this.#client.request<ThreadStartResponse>(
      "thread/start",
      {
        cwd: canonicalCwd,
        model: input.modelSettings.modelId,
        config: { model_reasoning_effort: input.modelSettings.reasoningEffort },
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        threadSource: `racco:${input.raccoSessionId}`,
      },
    );
    this.#observedRoots.add(response.thread.id);
    this.#loadedThreads.add(response.thread.id);
    return {
      providerSessionId: response.thread.id,
      cwd: canonicalCwd,
      materialized: true,
    };
  }

  async runTurn(input: {
    handle: ProviderSessionHandle;
    mode: "first" | "resume";
    prompt: string;
    modelSettings: ModelSettings;
    context: DriverContext;
    signal: AbortSignal;
  }): Promise<void> {
    this.#assertReady();
    input.signal.throwIfAborted();
    const sessionId = input.handle.providerSessionId;
    if (this.#contexts.has(sessionId) || this.#compactions.has(sessionId))
      throw new Error("Codex thread is already busy");
    this.#contexts.set(sessionId, input.context);
    let waiter: TurnWaiter | undefined;
    let interrupted = false;
    const onAbort = () => {
      if (waiter?.turnId === undefined || interrupted) return;
      interrupted = true;
      void this.#client
        .request("turn/interrupt", {
          threadId: sessionId,
          turnId: waiter.turnId,
        })
        .catch((error: unknown) =>
          waiter?.reject(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
    };
    try {
      await this.#ensureLoaded(sessionId, input.modelSettings);
      input.signal.throwIfAborted();
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const completion = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      // A notification can reject while turn/start is still waiting for its RPC.
      void completion.catch(() => undefined);
      waiter = {
        resolve,
        reject,
        pending: [],
        interrupt: () => {
          if (input.signal.aborted) onAbort();
        },
      };
      this.#turnWaiters.set(sessionId, waiter);
      input.signal.addEventListener("abort", onAbort, { once: true });
      const response = await this.#client.request<TurnStartResponse>(
        "turn/start",
        {
          threadId: sessionId,
          model: input.modelSettings.modelId,
          effort: input.modelSettings.reasoningEffort,
          clientUserMessageId: randomUUID(),
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
        },
      );
      waiter.turnId = response.turn.id;
      for (const notification of waiter.pending)
        this.#handleNotification(notification);
      waiter.pending.length = 0;
      waiter.interrupt();
      await completion;
    } finally {
      emitAgentEvents(
        input.context,
        this.#activityMapper.finish(
          sessionId,
          input.signal.aborted ? "interrupted" : "error",
        ),
      );
      emitAgentEvents(
        input.context,
        this.#finishTools(
          sessionId,
          input.signal.aborted ? "interrupted" : "failed",
        ),
      );
      input.signal.removeEventListener("abort", onAbort);
      this.#turnWaiters.delete(sessionId);
      this.#contexts.delete(sessionId);
    }
    if (!input.signal.aborted) {
      // Best-effort: do not block turn resolution on an extra thread/read.
      void this.#emitMetadataRefresh(
        input.handle.providerSessionId,
        input.handle.cwd,
      );
    }
  }

  async #emitMetadataRefresh(
    threadId: string,
    expectedCwd: string,
  ): Promise<void> {
    const listener = this.#sessionUpdate;
    if (listener === undefined) return;
    try {
      const response = await this.#client.request<ThreadReadResponse>(
        "thread/read",
        { threadId },
      );
      const cwd = await resolveProjectDirectory(response.thread.cwd);
      if (cwd === undefined || cwd !== expectedCwd) return;
      listener(threadId, {
        type: "metadata.changed",
        metadata: mapThreadSummary({ ...response.thread, cwd }),
      });
    } catch {
      // Metadata refresh is best-effort; the next snapshot will pick it up.
    }
  }

  onSessionUpdate(
    listener: (
      providerSessionId: string,
      update: ProviderSessionUpdate,
    ) => void,
  ): void {
    this.#sessionUpdate = listener;
  }

  async compact({
    handle,
  }: Parameters<NonNullable<AgentDriver["compact"]>>[0]): Promise<void> {
    this.#assertReady();
    await this.#ensureLoaded(handle.providerSessionId);
    const threadId = handle.providerSessionId;
    if (this.#contexts.has(threadId) || this.#compactions.has(threadId))
      throw new Error("Codex thread is already busy");
    // Install before the RPC: native start/completion events can precede its ACK.
    this.#compactions.set(threadId, undefined);
    try {
      await this.#client.request("thread/compact/start", { threadId });
    } catch (error) {
      this.#finishCompaction(threadId);
      throw error;
    }
  }

  #finishCompaction(threadId: string): void {
    if (!this.#compactions.delete(threadId)) return;
    this.#sessionUpdate?.(threadId, { type: "compaction.finished" });
  }

  async #listSubagentThreads(rootThreadId: string): Promise<CodexThread[]> {
    const summaries: CodexThread[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.#client.request<ThreadListResponse>(
        "thread/list",
        {
          ancestorThreadId: rootThreadId,
          sourceKinds: [
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
          ],
          useStateDbOnly: true,
          limit: 100,
          cursor,
        },
      );
      summaries.push(...response.data);
      // Discovery precedes the per-child reads, which can each yield to live events.
      for (const summary of response.data)
        this.#rememberSubagent(summary.id, rootThreadId);
      if (response.nextCursor === null) break;
      if (seenCursors.has(response.nextCursor)) {
        throw new Error("Codex returned a repeated subagent cursor");
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    } while (cursor !== undefined);

    return summaries;
  }

  async #readSubagentThreads(rootThreadId: string): Promise<CodexThread[]> {
    const summaries = await this.#listSubagentThreads(rootThreadId);
    const threads: CodexThread[] = [];
    for (const summary of summaries) {
      const link = this.#rememberSubagent(summary.id, rootThreadId);
      for (let attempt = 0; attempt < 2; attempt++) {
        const read: SnapshotRead = {
          generation: ++link.snapshotGeneration,
          changedItems: new Set(),
          endedTurns: new Set(),
          unalignedItems: new Set(),
          endedThread: false,
          stateChanged: false,
          invalid: false,
        };
        let reads = this.#snapshotReads.get(summary.id);
        if (reads === undefined) {
          reads = new Set();
          this.#snapshotReads.set(summary.id, reads);
        }
        reads.add(read);
        try {
          const response = await this.#client.request<ThreadReadResponse>(
            "thread/read",
            { threadId: summary.id, includeTurns: true },
          );
          if (
            response.thread.id !== summary.id ||
            response.thread.parentThreadId == null
          ) {
            throw new Error("Codex returned an invalid subagent thread");
          }
          if (read.invalid)
            throw new Error(
              "Codex subagent changed while reading its snapshot",
            );
          if (read.unalignedItems.size > 0) {
            if (attempt === 0) continue;
            throw new Error(
              "Codex 流式快照无法对齐，请重试；等待完整内容前不会应用缺少前缀的增量",
            );
          }
          this.#seedThreadContent(
            response.thread,
            rootThreadId,
            read.generation,
            read,
          );
          threads.push(response.thread);
          break;
        } finally {
          reads.delete(read);
          if (reads.size === 0 && this.#snapshotReads.get(summary.id) === reads)
            this.#snapshotReads.delete(summary.id);
        }
      }
    }
    return threads;
  }

  #rememberSubagent(
    providerThreadId: string,
    rootThreadId: string,
  ): SubagentLink {
    const existing = this.#subagents.get(providerThreadId);
    if (existing !== undefined) {
      if (existing.rootThreadId !== rootThreadId) {
        throw new Error("Codex subagent belongs to multiple root threads");
      }
      return existing;
    }
    const link: SubagentLink = {
      agentId: randomUUID(),
      rootThreadId,
      snapshotGeneration: 0,
      appliedSnapshotGeneration: 0,
    };
    this.#subagents.set(providerThreadId, link);
    return link;
  }

  async #ensureLoaded(
    threadId: string,
    modelSettings?: ModelSettings,
  ): Promise<void> {
    if (this.#loadedThreads.has(threadId)) return;
    try {
      await this.#client.request("thread/resume", {
        threadId,
        ...(modelSettings === undefined
          ? {}
          : {
              model: modelSettings.modelId,
              config: { model_reasoning_effort: modelSettings.reasoningEffort },
            }),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("already has an active writer")
      )
        throw new Error(
          "该会话正在其他 Codex 窗口中打开，请先关闭该窗口后再继续。",
          { cause: error },
        );
      throw error;
    }
    this.#loadedThreads.add(threadId);
    this.#observedRoots.add(threadId);
  }

  #handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "thread/started") {
      this.#handleThreadStarted(
        notification.params as ThreadStartedNotification,
      );
      return;
    }

    const params = notification.params as Record<string, unknown> | undefined;
    const threadId =
      typeof params?.threadId === "string" ? params.threadId : undefined;
    if (threadId === undefined) return;
    if (this.#observeSnapshotNotification(threadId, notification)) return;
    if (this.#compactions.has(threadId)) {
      if (notification.method === "turn/started") {
        const { turn } = notification.params as TurnNotification;
        if (this.#compactions.get(threadId) === undefined)
          this.#compactions.set(threadId, turn.id);
      } else if (notification.method === "turn/completed") {
        const { turn } = notification.params as TurnNotification;
        const compactTurnId = this.#compactions.get(threadId);
        if (compactTurnId === undefined || compactTurnId === turn.id) {
          if (turn.status === "failed" || turn.status === "interrupted") {
            this.#sessionUpdate?.(threadId, {
              type: "system.notice",
              id: randomUUID(),
              level: "error",
              text: turn.error?.message ?? "上下文压缩已中断",
            });
          }
          this.#finishCompaction(threadId);
        }
      } else if (notification.method === "error") {
        const error = notification.params as ErrorNotification;
        const compactTurnId = this.#compactions.get(threadId);
        if (
          !error.willRetry &&
          (compactTurnId === undefined || compactTurnId === error.turnId)
        )
          this.#finishCompaction(threadId);
      }
    }
    if (notification.method === "thread/deleted") {
      const deleted = notification.params as { threadId: string };
      this.#loadedThreads.delete(deleted.threadId);
      this.#observedRoots.delete(deleted.threadId);
      this.#unalignedItems.delete(deleted.threadId);
      for (const [threadId, link] of this.#subagents) {
        if (
          threadId === deleted.threadId ||
          link.rootThreadId === deleted.threadId
        ) {
          for (const read of this.#snapshotReads.get(threadId) ?? [])
            read.invalid = true;
          this.#unalignedItems.delete(threadId);
          const events = [
            ...this.#finishTools(threadId, "interrupted"),
            ...this.#activityMapper.finish(threadId, "interrupted"),
          ];
          if (link.rootThreadId !== deleted.threadId) {
            emitAgentEvents(
              {
                emit: (event) => this.#emitRootEvent(link.rootThreadId, event),
              },
              events,
              link,
            );
            if (
              events.length > 0 ||
              link.state === "starting" ||
              link.state === "running"
            ) {
              this.#emitRootEvent(link.rootThreadId, {
                type: "subagent.state",
                id: `${link.agentId}:deleted`,
                agentId: link.agentId,
                state: "interrupted",
              });
            }
          }
          this.#subagents.delete(threadId);
        }
      }
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const { tokenUsage } = notification.params as TokenUsageNotification;
      const usage = ContextUsageSchema.safeParse({
        usedTokens: tokenUsage?.last?.totalTokens,
        maxTokens: tokenUsage?.modelContextWindow,
      });
      if (!usage.success) {
        this.#handleExit(new Error("Invalid Codex context usage"));
        return;
      }
      this.#sessionUpdate?.(threadId, {
        type: "context.usage",
        usage: usage.data,
      });
      return;
    }

    const subagent =
      threadId === undefined ? undefined : this.#subagents.get(threadId);
    const rootThreadId = subagent?.rootThreadId ?? threadId;
    const context =
      rootThreadId === undefined ? undefined : this.#contexts.get(rootThreadId);
    // Child streams outlive individual main turns; only main events require a turn context.
    if (context === undefined && subagent === undefined) {
      if (notification.method === "error") {
        const error = notification.params as ErrorNotification;
        this.#sessionUpdate?.(threadId, {
          type: "system.notice",
          id: randomUUID(),
          text: error.error.message,
          level: error.willRetry ? "warning" : "error",
        });
      } else if (notification.method === "item/completed") {
        const { item } = notification.params as ItemNotification;
        if (item.type === "contextCompaction")
          this.#sessionUpdate?.(threadId, {
            type: "system.notice",
            id: item.id,
            text: "上下文已压缩",
            level: "info",
          });
      }
      return;
    }
    const emitter = {
      emit: (event: TimelineEvent) => this.#emitRootEvent(rootThreadId, event),
    };
    const resolveSubagentId = (providerThreadId: string) =>
      this.#rememberSubagent(providerThreadId, rootThreadId).agentId;

    // Only the turn ID returned by turn/start belongs to the pending message.
    // An earlier compact action can emit its terminal event while this RPC waits.
    if (subagent === undefined) {
      const waiter = this.#turnWaiters.get(threadId);
      const eventTurnId =
        notification.method === "turn/started" ||
        notification.method === "turn/completed"
          ? (notification.params as TurnNotification).turn.id
          : notification.method === "error"
            ? (notification.params as ErrorNotification).turnId
            : undefined;
      if (waiter !== undefined && eventTurnId !== undefined) {
        if (waiter.turnId === undefined) {
          waiter.pending.push(notification);
          return;
        }
        if (waiter.turnId !== eventTurnId) {
          if (notification.method === "error") {
            const { error, willRetry } =
              notification.params as ErrorNotification;
            this.#sessionUpdate?.(threadId, {
              type: "system.notice",
              id: randomUUID(),
              text: error.message,
              level: willRetry ? "warning" : "error",
            });
          }
          return;
        }
        if (notification.method === "turn/started") waiter.interrupt();
      }
    }

    const activityEvents = this.#activityMapper.map(notification);
    if (activityEvents !== undefined) {
      emitAgentEvents(emitter, activityEvents, subagent);
      return;
    }

    if (
      notification.method === "item/started" ||
      notification.method === "item/completed"
    ) {
      const { item, turnId } = notification.params as ItemNotification;
      if (item.type === "commandExecution" && item.status === "inProgress") {
        this.#toolOutput.set(`${threadId}:${item.id}`, {
          output: item.aggregatedOutput ?? "",
          live: true,
          generation: 0,
        });
      }
      if (
        item.type === "contextCompaction" &&
        notification.method === "item/started"
      )
        return;
      if (item.type === "subAgentActivity") {
        this.#rememberSubagent(item.agentThreadId, rootThreadId).name =
          item.agentPath.split("/").filter(Boolean).at(-1);
      }
      const events = mapItemEvents(item, resolveSubagentId);
      this.#toolLifecycle.observe(threadId, turnId, events);
      for (const event of subagent === undefined
        ? events
        : mapSubagentEvents(events, subagent.agentId))
        emitter.emit(event);
      if (notification.method === "item/completed") {
        this.#toolOutput.delete(`${threadId}:${item.id}`);
      }
      return;
    }
    if (notification.method === "item/commandExecution/outputDelta") {
      const delta = notification.params as DeltaNotification;
      const cacheId = `${delta.threadId}:${delta.itemId}`;
      const output =
        (this.#toolOutput.get(cacheId)?.output ?? "") + delta.delta;
      this.#toolOutput.set(cacheId, { output, live: true, generation: 0 });
      if (subagent === undefined) {
        emitter.emit({ type: "tool.output", id: delta.itemId, output });
      } else {
        emitter.emit({
          type: "subagent.event",
          id: `${subagent.agentId}:event:tool.output:${delta.itemId}`,
          agentId: subagent.agentId,
          event: {
            type: "tool.output",
            id: `${subagent.agentId}:${delta.itemId}`,
            output,
          },
        });
      }
      return;
    }
    if (notification.method === "turn/started") {
      if (subagent === undefined) {
        context!.setState("running");
      } else {
        const started = notification.params as TurnNotification;
        emitter.emit({
          type: "subagent.state",
          id: `${subagent.agentId}:turn-started:${started.turn.id}`,
          agentId: subagent.agentId,
          state: "running",
        });
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const completed = notification.params as TurnNotification;
      emitAgentEvents(
        emitter,
        this.#finishTools(
          threadId,
          completed.turn.status === "interrupted"
            ? "interrupted"
            : completed.turn.status === "failed"
              ? "failed"
              : "incomplete",
          completed.turn.id,
        ),
        subagent,
      );
      emitAgentEvents(
        emitter,
        this.#activityMapper.finish(
          threadId,
          completed.turn.status === "interrupted"
            ? "interrupted"
            : completed.turn.status === "failed"
              ? "error"
              : undefined,
          completed.turn.id,
        ),
        subagent,
      );
      if (subagent !== undefined) {
        emitter.emit({
          type: "subagent.state",
          id: `${subagent.agentId}:turn-completed:${completed.turn.id}`,
          agentId: subagent.agentId,
          state: subagentTurnState(completed.turn),
          message: completed.turn.error?.message ?? undefined,
        });
      } else {
        context!.setState(mapTurnState(completed.turn));
        const waiter = this.#turnWaiters.get(threadId);
        if (completed.turn.status === "failed") {
          waiter?.reject(
            new Error(completed.turn.error?.message ?? "Codex turn failed"),
          );
        } else {
          waiter?.resolve();
        }
      }
      return;
    }
    if (notification.method === "thread/status/changed") {
      const changed = notification.params as ThreadStatusNotification;
      if (subagent === undefined) {
        context!.setState(mapThreadState(changed.status));
      } else {
        emitter.emit({
          type: "subagent.state",
          id: `${subagent.agentId}:thread-state:${randomUUID()}`,
          agentId: subagent.agentId,
          state: subagentThreadState(changed.status),
        });
      }
      return;
    }
    if (notification.method === "error") {
      const error = notification.params as ErrorNotification;
      const message = error.error.message;
      if (!error.willRetry) {
        emitAgentEvents(
          emitter,
          this.#finishTools(threadId, "failed", error.turnId),
          subagent,
        );
        emitAgentEvents(
          emitter,
          this.#activityMapper.finish(threadId, "error", error.turnId),
          subagent,
        );
      }
      if (subagent === undefined) {
        const event: TimelineEvent = {
          type: "system.notice",
          id: randomUUID(),
          text: message,
          level: error.willRetry ? "warning" : "error",
        };
        if (error.willRetry) emitter.emit(event);
        if (!error.willRetry) {
          context!.setState("error");
          this.#turnWaiters.get(threadId)?.reject(new Error(message));
        }
      } else {
        emitter.emit({
          type: "subagent.state",
          id: `${subagent.agentId}:error:${randomUUID()}`,
          agentId: subagent.agentId,
          state: error.willRetry ? "running" : "error",
          message,
        });
      }
    }
  }

  #handleThreadStarted(notification: ThreadStartedNotification): void {
    const thread = notification.thread;
    const parentThreadId = thread.parentThreadId;
    if (parentThreadId == null) return;
    const parent = this.#subagents.get(parentThreadId);
    const rootThreadId = parent?.rootThreadId ?? parentThreadId;
    if (
      !this.#observedRoots.has(rootThreadId) &&
      !this.#contexts.has(rootThreadId)
    )
      return;

    const link = this.#rememberSubagent(thread.id, rootThreadId);
    link.name = thread.agentNickname ?? undefined;
    const parentAgentId =
      parentThreadId === rootThreadId ? undefined : parent?.agentId;
    const resolveSubagentId = (providerThreadId: string) =>
      this.#rememberSubagent(providerThreadId, rootThreadId).agentId;
    const protectedIds = new Set(
      thread.turns.flatMap((turn) =>
        turn.status !== "inProgress"
          ? []
          : turn.items
              .filter(
                (item) =>
                  this.#activityMapper.hasPending(thread.id, item.id) ||
                  (item.type === "commandExecution" &&
                    item.status === "inProgress" &&
                    this.#toolOutput.get(`${thread.id}:${item.id}`)?.live) ||
                  (link.currentTurn?.id === turn.id &&
                    link.currentTurn.completedItems.has(item.id)),
              )
              .map((item) => `${link.agentId}:${item.id}`),
      ),
    );
    if (
      !this.#seedThreadContent(thread, rootThreadId, ++link.snapshotGeneration)
    )
      return;
    for (const event of mapSubagentThread(
      thread,
      link.agentId,
      resolveSubagentId,
      parentAgentId,
    )) {
      if (
        event.type === "subagent.event" &&
        event.agentId === link.agentId &&
        protectedIds.has(event.event.id)
      )
        continue;
      this.#emitRootEvent(rootThreadId, event);
    }
  }

  async #handleServerRequest(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === "item/tool/requestUserInput") {
      const params = request.params as UserInputParams;
      const response = await this.#requestUserInput(params.threadId, {
        title: "Codex 需要更多信息",
        questions: params.questions.map((question) => ({
          id: question.id,
          text: question.question,
          multiple: false,
          options: question.options ?? undefined,
          allowOther: question.isOther,
          secret: question.isSecret,
        })),
      });
      const answers =
        response.decision === "answer"
          ? Object.fromEntries(
              params.questions.map((question) => [
                question.id,
                { answers: response.answers[question.id] ?? [] },
              ]),
            )
          : {};
      return { answers };
    }

    throw new Error(`Unsupported Codex server request: ${request.method}`);
  }

  async #requestUserInput(
    threadId: string,
    request: Parameters<DriverContext["requestInteraction"]>[0],
  ): Promise<InteractionResponse> {
    const subagent = this.#subagents.get(threadId);
    const context = this.#contexts.get(subagent?.rootThreadId ?? threadId);
    if (context === undefined)
      return { decision: "deny", message: "No active client" };
    return context.requestInteraction(
      subagent === undefined
        ? request
        : {
            ...request,
            title: `${subagent.name ?? "Subagent"} · ${request.title}`,
          },
    );
  }

  #handleExit(error: Error): void {
    this.#ready = false;
    this.#clearSnapshotReads();
    for (const threadId of this.#compactions.keys()) {
      this.#sessionUpdate?.(threadId, {
        type: "system.notice",
        id: randomUUID(),
        level: "error",
        text: error.message,
      });
      this.#finishCompaction(threadId);
    }
    for (const [threadId, context] of this.#contexts) {
      emitAgentEvents(context, this.#activityMapper.finish(threadId, "error"));
      emitAgentEvents(context, this.#finishTools(threadId, "failed"));
      context.setState("error");
    }
    this.#finishSubagents(error);
    this.#activityMapper.clear();
    this.#toolLifecycle.clear();
    this.#toolOutput.clear();
    this.#subagents.clear();
    this.#observedRoots.clear();
    this.#loadedThreads.clear();
    for (const waiter of this.#turnWaiters.values()) waiter.reject(error);
    this.#turnWaiters.clear();
  }

  #assertReady(): void {
    if (!this.#ready) throw new Error("Codex provider is unavailable");
  }

  #seedThreadContent(
    thread: CodexThread,
    rootThreadId: string,
    generation: number,
    read?: SnapshotRead,
  ): boolean {
    if (read?.endedThread || read?.invalid) return false;
    const link = this.#subagents.get(thread.id)!;
    if (generation < link.appliedSnapshotGeneration) return false;
    const latest = thread.turns.at(-1);
    const previousTurn = link.currentTurn;
    if (
      previousTurn !== undefined &&
      (!thread.turns.some((turn) => turn.id === previousTurn.id) ||
        (previousTurn.terminal &&
          latest?.id === previousTurn.id &&
          latest.status === "inProgress"))
    ) {
      if (read) throw new Error("Codex 子任务快照早于已观测的轮次状态，请重试");
      return false;
    }
    if (
      previousTurn !== undefined &&
      thread.turns.some(
        (turn) =>
          turn.id === previousTurn.id &&
          turn.status === "inProgress" &&
          turn.items.some(
            (item) =>
              !read?.changedItems.has(item.id) &&
              previousTurn.completedItems.has(item.id) &&
              "status" in item &&
              item.status === "inProgress",
          ),
      )
    ) {
      if (read) throw new Error("Codex 子任务快照早于已观测的工具终态，请重试");
      return false;
    }
    if (
      latest !== undefined &&
      (previousTurn === undefined || latest.id !== previousTurn.id)
    ) {
      link.currentTurn = {
        id: latest.id,
        terminal: latest.status !== "inProgress",
        completedItems: new Set(),
      };
    }
    if (latest !== undefined && !read?.stateChanged) {
      link.state = subagentTurnState(latest);
      if (
        latest.status !== "inProgress" &&
        link.currentTurn?.id === latest.id
      ) {
        link.currentTurn.terminal = true;
        link.currentTurn.completedItems.clear();
      }
    }
    link.appliedSnapshotGeneration = generation;
    const resolveSubagentId = (id: string) =>
      this.#rememberSubagent(id, rootThreadId).agentId;
    for (const turn of thread.turns) {
      if (read?.endedTurns.has(turn.id)) continue;
      if (turn.status !== "inProgress") {
        this.#clearUnalignedTurn(thread.id, turn.id);
        if (!turn.items.some((item) => read?.changedItems.has(item.id))) {
          this.#activityMapper.finish(thread.id, undefined, turn.id);
          this.#finishTools(thread.id, "incomplete", turn.id);
        }
        continue;
      }
      for (const item of turn.items) {
        if (read?.changedItems.has(item.id)) continue;
        if (
          link.currentTurn?.id === turn.id &&
          link.currentTurn.completedItems.has(item.id)
        ) {
          continue;
        }
        this.#activityMapper.seed(thread.id, turn.id, item, generation);
        if (item.type === "commandExecution") {
          const key = `${thread.id}:${item.id}`;
          const previous = this.#toolOutput.get(key);
          if (item.status !== "inProgress") this.#toolOutput.delete(key);
          else if (
            !previous?.live &&
            (previous?.generation ?? -1) <= generation
          ) {
            this.#toolOutput.set(key, {
              output: item.aggregatedOutput ?? "",
              live: false,
              generation,
            });
          }
        }
        this.#toolLifecycle.observe(
          thread.id,
          turn.id,
          mapItemEvents(item, resolveSubagentId),
        );
        if (
          "status" in item &&
          item.status !== "inProgress" &&
          link.currentTurn?.id === turn.id
        )
          link.currentTurn.completedItems.add(item.id);
        this.#unalignedItems.get(thread.id)?.delete(item.id);
      }
      if (this.#unalignedItems.get(thread.id)?.size === 0)
        this.#unalignedItems.delete(thread.id);
    }
    return true;
  }

  #observeSnapshotNotification(
    threadId: string,
    notification: JsonRpcNotification,
  ): boolean {
    const reads = this.#snapshotReads.get(threadId);
    const link = this.#subagents.get(threadId);
    if (
      notification.method === "item/started" ||
      notification.method === "item/completed"
    ) {
      const { item, turnId } = notification.params as ItemNotification;
      if (link !== undefined && link.currentTurn === undefined)
        link.currentTurn = {
          id: turnId,
          terminal: false,
          completedItems: new Set(),
        };
      if (
        notification.method === "item/completed" &&
        link?.currentTurn?.id === turnId
      )
        link.currentTurn.completedItems.add(item.id);
      for (const read of reads ?? []) {
        read.changedItems.add(item.id);
        read.unalignedItems.delete(item.id);
      }
      const unaligned = this.#unalignedItems.get(threadId);
      unaligned?.delete(item.id);
      if (unaligned?.size === 0) this.#unalignedItems.delete(threadId);
    } else if (
      [
        "item/commandExecution/outputDelta",
        "item/agentMessage/delta",
        "item/plan/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
      ].includes(notification.method)
    ) {
      const delta = notification.params as DeltaNotification;
      if (
        link?.currentTurn?.id === delta.turnId &&
        (link.currentTurn.terminal ||
          link.currentTurn.completedItems.has(delta.itemId))
      )
        return true;
      for (const read of reads ?? []) read.changedItems.add(delta.itemId);
      const aligned =
        notification.method === "item/commandExecution/outputDelta"
          ? this.#toolOutput.has(`${threadId}:${delta.itemId}`)
          : this.#activityMapper.hasContent(threadId, delta.itemId);
      if (
        !aligned &&
        (link !== undefined ||
          (reads?.size ?? 0) > 0 ||
          this.#unalignedItems.get(threadId)?.has(delta.itemId))
      ) {
        let unaligned = this.#unalignedItems.get(threadId);
        if (unaligned === undefined) {
          unaligned = new Map();
          this.#unalignedItems.set(threadId, unaligned);
        }
        unaligned.set(delta.itemId, delta.turnId);
        for (const read of reads ?? []) read.unalignedItems.add(delta.itemId);
        return true;
      }
    } else if (notification.method === "turn/started") {
      const { turn } = notification.params as TurnNotification;
      for (const read of reads ?? []) read.stateChanged = true;
      if (link !== undefined)
        link.currentTurn = {
          id: turn.id,
          terminal: false,
          completedItems: new Set(),
        };
    } else if (notification.method === "turn/completed") {
      const { turn } = notification.params as TurnNotification;
      if (
        link !== undefined &&
        (link.currentTurn === undefined || link.currentTurn.id === turn.id)
      ) {
        link.currentTurn = {
          id: turn.id,
          terminal: true,
          completedItems: new Set(),
        };
      }
      for (const read of reads ?? []) {
        read.endedTurns.add(turn.id);
        read.stateChanged = true;
      }
      this.#clearUnalignedTurn(threadId, turn.id);
    } else if (notification.method === "error") {
      const error = notification.params as ErrorNotification;
      if (!error.willRetry) {
        for (const read of reads ?? []) {
          read.endedTurns.add(error.turnId);
          read.stateChanged = true;
        }
        this.#clearUnalignedTurn(threadId, error.turnId);
      }
    } else if (notification.method === "thread/status/changed") {
      const { status } = notification.params as ThreadStatusNotification;
      for (const read of reads ?? []) read.stateChanged = true;
      if (status.type !== "active") {
        for (const read of reads ?? []) read.endedThread = true;
        this.#unalignedItems.delete(threadId);
      }
    } else if (notification.method === "thread/deleted") {
      for (const read of reads ?? []) read.invalid = true;
      this.#unalignedItems.delete(threadId);
    }
    return false;
  }

  #clearUnalignedTurn(threadId: string, turnId: string): void {
    const unaligned = this.#unalignedItems.get(threadId);
    for (const [id, ownerTurnId] of unaligned ?? []) {
      if (ownerTurnId === turnId) unaligned!.delete(id);
    }
    if (unaligned?.size === 0) this.#unalignedItems.delete(threadId);
  }

  #clearSnapshotReads(): void {
    for (const reads of this.#snapshotReads.values()) {
      for (const read of reads) read.invalid = true;
    }
    this.#snapshotReads.clear();
    this.#unalignedItems.clear();
  }

  #emitRootEvent(rootThreadId: string, event: TimelineEvent): void {
    if (event.type === "subagent.state") {
      for (const [threadId, link] of this.#subagents) {
        if (link.agentId === event.agentId) {
          link.state = event.state;
          if (event.state !== "starting" && event.state !== "running") {
            if (link.currentTurn !== undefined) {
              link.currentTurn.terminal = true;
              link.currentTurn.completedItems.clear();
            }
            this.#unalignedItems.delete(threadId);
            emitAgentEvents(
              { emit: (nested) => this.#emitRootEvent(rootThreadId, nested) },
              [
                ...this.#finishTools(
                  threadId,
                  event.state === "completed"
                    ? "incomplete"
                    : event.state === "interrupted"
                      ? "interrupted"
                      : "failed",
                ),
                ...this.#activityMapper.finish(
                  threadId,
                  event.state === "completed"
                    ? undefined
                    : event.state === "interrupted"
                      ? "interrupted"
                      : "error",
                ),
              ],
              link,
            );
          }
          break;
        }
      }
    }
    const context = this.#contexts.get(rootThreadId);
    if (context !== undefined) {
      context.emit(event);
    } else if (
      event.type === "subagent.started" ||
      event.type === "subagent.state" ||
      event.type === "subagent.event" ||
      event.type === "system.notice"
    ) {
      this.#sessionUpdate?.(rootThreadId, event);
    }
  }

  #finishSubagents(error: Error): void {
    for (const [threadId, subagent] of this.#subagents) {
      const events = [
        ...this.#activityMapper.finish(threadId, "error"),
        ...this.#finishTools(threadId, "failed"),
      ];
      emitAgentEvents(
        { emit: (event) => this.#emitRootEvent(subagent.rootThreadId, event) },
        events,
        subagent,
      );
      if (
        events.length > 0 ||
        subagent.state === "starting" ||
        subagent.state === "running"
      ) {
        this.#emitRootEvent(subagent.rootThreadId, {
          type: "subagent.state",
          id: `${subagent.agentId}:provider-exit`,
          agentId: subagent.agentId,
          state: "error",
          message: error.message,
        });
      }
    }
  }

  #finishTools(
    threadId: string,
    status: Exclude<ToolCompletionStatus, "completed">,
    turnId?: string,
  ): AgentTimelineEvent[] {
    const events = this.#toolLifecycle.finish(threadId, status, turnId);
    for (const event of events)
      this.#toolOutput.delete(`${threadId}:${event.id}`);
    return events;
  }
}
