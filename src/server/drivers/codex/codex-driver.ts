import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ContextUsageSchema } from "../../../shared/protocol.js";
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
  context: DriverContext,
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
  readonly #turnWaiters = new Map<string, TurnWaiter>();
  readonly #compactions = new Map<string, string | undefined>();
  readonly #activityMapper = new CodexActivityMapper();
  readonly #toolLifecycle = new CodexToolLifecycle();
  readonly #toolOutput = new Map<string, string>();
  readonly #subagents = new Map<string, SubagentLink>();
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
    this.#sessionUpdate = undefined;
    const error = new Error("Codex provider closed");
    for (const [threadId, context] of this.#contexts) {
      emitAgentEvents(context, this.#finishTools(threadId, "failed"));
    }
    for (const [threadId, subagent] of this.#subagents) {
      const context = this.#contexts.get(subagent.rootThreadId);
      if (context !== undefined) {
        emitAgentEvents(
          context,
          this.#finishTools(threadId, "failed"),
          subagent,
        );
      }
    }
    for (const threadId of this.#compactions.keys())
      this.#finishCompaction(threadId);
    for (const waiter of this.#turnWaiters.values()) waiter.reject(error);
    this.#turnWaiters.clear();
    this.#loadedThreads.clear();
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
      events.push(
        ...mapSubagentThread(
          subagentThread,
          link.agentId,
          resolveSubagentId,
          parentAgentId,
        ),
      );
    }
    return {
      metadata: mapThreadSummary(thread),
      events,
    };
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

  async #readSubagentThreads(rootThreadId: string): Promise<CodexThread[]> {
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
      if (response.nextCursor === null) break;
      if (seenCursors.has(response.nextCursor)) {
        throw new Error("Codex returned a repeated subagent cursor");
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    } while (cursor !== undefined);

    const threads: CodexThread[] = [];
    for (const summary of summaries) {
      const response = await this.#client.request<ThreadReadResponse>(
        "thread/read",
        {
          threadId: summary.id,
          includeTurns: true,
        },
      );
      if (
        response.thread.id !== summary.id ||
        response.thread.parentThreadId == null
      ) {
        throw new Error("Codex returned an invalid subagent thread");
      }
      threads.push(response.thread);
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
      for (const [threadId, link] of this.#subagents) {
        if (
          threadId === deleted.threadId ||
          link.rootThreadId === deleted.threadId
        )
          this.#subagents.delete(threadId);
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
    if (context === undefined) {
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
      emitAgentEvents(context, activityEvents, subagent);
      return;
    }

    if (
      notification.method === "item/started" ||
      notification.method === "item/completed"
    ) {
      const { item, turnId } = notification.params as ItemNotification;
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
        context.emit(event);
      if (notification.method === "item/completed") {
        this.#toolOutput.delete(`${threadId}:${item.id}`);
      }
      return;
    }
    if (notification.method === "item/commandExecution/outputDelta") {
      const delta = notification.params as DeltaNotification;
      const cacheId = `${delta.threadId}:${delta.itemId}`;
      const output = (this.#toolOutput.get(cacheId) ?? "") + delta.delta;
      this.#toolOutput.set(cacheId, output);
      if (subagent === undefined) {
        context.emit({ type: "tool.output", id: delta.itemId, output });
      } else {
        context.emit({
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
        context.setState("running");
      } else {
        const started = notification.params as TurnNotification;
        context.emit({
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
        context,
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
        context,
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
        context.emit({
          type: "subagent.state",
          id: `${subagent.agentId}:turn-completed:${completed.turn.id}`,
          agentId: subagent.agentId,
          state: subagentTurnState(completed.turn),
          message: completed.turn.error?.message ?? undefined,
        });
      } else {
        context.setState(mapTurnState(completed.turn));
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
        context.setState(mapThreadState(changed.status));
      } else {
        context.emit({
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
          context,
          this.#finishTools(threadId, "failed", error.turnId),
          subagent,
        );
        emitAgentEvents(
          context,
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
        if (error.willRetry) context.emit(event);
        if (!error.willRetry) {
          context.setState("error");
          this.#turnWaiters.get(threadId)?.reject(new Error(message));
        }
      } else {
        context.emit({
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
    const context = this.#contexts.get(rootThreadId);
    if (context === undefined) return;

    const link = this.#rememberSubagent(thread.id, rootThreadId);
    link.name = thread.agentNickname ?? undefined;
    const parentAgentId =
      parentThreadId === rootThreadId ? undefined : parent?.agentId;
    const resolveSubagentId = (providerThreadId: string) =>
      this.#rememberSubagent(providerThreadId, rootThreadId).agentId;
    for (const event of mapSubagentThread(
      thread,
      link.agentId,
      resolveSubagentId,
      parentAgentId,
    )) {
      context.emit(event);
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
    for (const [threadId, subagent] of this.#subagents) {
      const context = this.#contexts.get(subagent.rootThreadId);
      if (context !== undefined) {
        emitAgentEvents(
          context,
          this.#activityMapper.finish(threadId, "error"),
          subagent,
        );
        emitAgentEvents(
          context,
          this.#finishTools(threadId, "failed"),
          subagent,
        );
      }
    }
    this.#activityMapper.clear();
    this.#toolLifecycle.clear();
    for (const waiter of this.#turnWaiters.values()) waiter.reject(error);
    this.#turnWaiters.clear();
  }

  #assertReady(): void {
    if (!this.#ready) throw new Error("Codex provider is unavailable");
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
