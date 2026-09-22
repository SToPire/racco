import type {
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKToolProgressMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentTimelineEvent,
  SubagentState,
  TimelineEvent,
  ToolCompletionStatus,
} from "../../../shared/protocol.js";

type Owner = { parentToolUseId: string | null; ownerAgentId?: string };
type ToolCall = Owner & { name: string; input: unknown };
type Agent = {
  id: string;
  toolUseId?: string;
  parentAgentId?: string;
  state: SubagentState;
  message?: string;
  cwd?: string;
};
type Task = Owner & {
  id: string;
  toolUseId?: string;
  agent: boolean;
  description: string;
  settled: boolean;
};
type TaskUpdate = SDKTaskProgressMessage | SDKTaskNotificationMessage;
type PendingToolProgress = {
  elapsedSeconds?: number;
  retry?: {
    uuid: string;
    detail: NonNullable<SDKToolProgressMessage["subagent_retry"]>;
  };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map(record)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block!.text)
    .join("\n");
}

/** Query-scoped native identities, progress, and ownership; no inferred stdout. */
export class ClaudeActivityTracker {
  readonly #calls = new Map<string, ToolCall>();
  readonly #pendingTools = new Map<string, Owner>();
  readonly #settledTools = new Set<string>();
  readonly #pendingToolProgress = new Map<
    string,
    Map<string, PendingToolProgress>
  >();
  readonly #toolElapsedSeconds = new Map<string, number>();
  readonly #agents = new Map<string, Agent>();
  readonly #agentByTool = new Map<string, string>();
  readonly #pendingChildEvents = new Map<string, AgentTimelineEvent[]>();
  readonly #tasks = new Map<string, Task>();
  readonly #pendingTaskUpdates = new Map<string, TaskUpdate[]>();
  readonly #ignoredTasks = new Set<string>();
  readonly #appliedStops = new Set<string>();

  observe(
    events: readonly AgentTimelineEvent[],
    parentToolUseId: string | null,
    ownerAgentId?: string,
  ): TimelineEvent[] {
    const result: TimelineEvent[] = [];
    for (const event of events) {
      if (event.type === "tool.started") {
        const owner = {
          parentToolUseId,
          ...(ownerAgentId === undefined ? {} : { ownerAgentId }),
        };
        this.#calls.set(event.id, {
          name: event.tool,
          input: event.input,
          ...owner,
        });
        if (!this.#settledTools.has(event.id))
          this.#pendingTools.set(event.id, owner);
        const agentId = this.#agentByTool.get(event.id);
        if (agentId !== undefined)
          result.push(...this.registerAgent(agentId, event.id));
      } else if (event.type === "tool.completed") {
        this.#pendingTools.delete(event.id);
        this.#settledTools.add(event.id);
        this.#pendingToolProgress.delete(event.id);
        this.#toolElapsedSeconds.delete(event.id);
        const call = this.#calls.get(event.id);
        const details = record(event.details);
        const output =
          details?.type === "claudeToolResult"
            ? record(details.result)
            : undefined;
        if (
          call?.name === "TaskStop" &&
          event.status === "completed" &&
          output !== undefined
        ) {
          result.push(...this.#stopTask(event.id, output, event.output));
        }
        if (
          call?.name === "Agent" &&
          typeof output?.agentId === "string" &&
          output.agentId !== ""
        ) {
          const previousAgent = this.#agents.get(output.agentId);
          // Parent and child histories are read separately. Filling a missing
          // launch identity must not overturn an already observed stop.
          const preserveStop = previousAgent?.state === "interrupted";
          result.push(
            ...this.registerAgent(
              output.agentId,
              event.id,
              undefined,
              typeof output.worktreePath === "string" &&
                output.worktreePath.length > 0
                ? output.worktreePath
                : undefined,
            ),
          );
          if (output.status === "completed" && !preserveStop) {
            const task = this.#tasks.get(output.agentId);
            if (task) task.settled = true;
            result.push(
              ...this.#finishAgentTools(output.agentId, "incomplete"),
            );
            result.push(
              ...this.#setAgentState(
                output.agentId,
                "completed",
                textContent(output.content),
                `${event.id}:result`,
              ),
            );
          } else if (
            output.status === "async_launched" &&
            this.#agents.get(output.agentId)?.state === "starting"
          ) {
            result.push(
              ...this.#setAgentState(
                output.agentId,
                "running",
                typeof output.description === "string"
                  ? output.description
                  : "",
                `${event.id}:launched`,
              ),
            );
          }
        }
      }
      result.push(...this.#route([event], parentToolUseId, ownerAgentId));
      if (event.type === "tool.started") {
        const progress = this.#pendingToolProgress
          .get(event.id)
          ?.get(event.tool);
        this.#pendingToolProgress.delete(event.id);
        if (progress !== undefined && !this.#settledTools.has(event.id)) {
          result.push(
            ...this.#emitToolProgress(
              event.id,
              progress,
              this.#calls.get(event.id)!,
            ),
          );
        }
      }
    }
    return result;
  }

  registerAgent(
    agentId: string,
    toolUseId?: string,
    parentAgentId?: string,
    cwd?: string,
  ): TimelineEvent[] {
    if (!agentId) throw new Error("Missing Claude subagent identity");
    const existing = this.#agents.get(agentId);
    toolUseId ??= existing?.toolUseId;
    cwd ??= existing?.cwd;
    const call =
      toolUseId === undefined ? undefined : this.#calls.get(toolUseId);
    const input = record(call?.input);
    const parent =
      parentAgentId ??
      call?.ownerAgentId ??
      (call?.parentToolUseId
        ? this.#agentByTool.get(call.parentToolUseId)
        : undefined) ??
      existing?.parentAgentId;
    const agent: Agent = {
      id: agentId,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      ...(parent === undefined ? {} : { parentAgentId: parent }),
      state: existing?.state ?? "starting",
      ...(existing?.message === undefined ? {} : { message: existing.message }),
      ...(cwd === undefined ? {} : { cwd }),
    };
    this.#agents.set(agentId, agent);
    if (toolUseId !== undefined) this.#agentByTool.set(toolUseId, agentId);
    const events: TimelineEvent[] = [
      {
        type: "subagent.started",
        id: `claude-agent:${agentId}`,
        agentId,
        ...(cwd === undefined ? {} : { cwd }),
        ...(parent === undefined ? {} : { parentAgentId: parent }),
        ...(typeof input?.description === "string"
          ? { name: input.description }
          : {}),
        ...(typeof input?.prompt === "string" ? { prompt: input.prompt } : {}),
        ...(typeof input?.subagent_type === "string"
          ? { role: input.subagent_type }
          : {}),
        ...(typeof input?.model === "string" ? { model: input.model } : {}),
      },
    ];
    if (toolUseId !== undefined) {
      const pending = this.#pendingChildEvents.get(toolUseId);
      this.#pendingChildEvents.delete(toolUseId);
      if (pending) events.push(...this.#route(pending, toolUseId));
      for (const child of this.#agents.values()) {
        if (child.toolUseId === undefined || child.id === agentId) continue;
        if (
          this.#calls.get(child.toolUseId)?.parentToolUseId !== toolUseId ||
          child.parentAgentId === agentId
        )
          continue;
        child.parentAgentId = agentId;
        events.push({
          type: "subagent.started",
          id: `claude-agent:${child.id}`,
          agentId: child.id,
          parentAgentId: agentId,
        });
      }
    }
    return events;
  }

  map(message: SDKMessage): TimelineEvent[] | undefined {
    if (message.type === "tool_progress") {
      if (
        !Number.isFinite(message.elapsed_time_seconds) ||
        message.elapsed_time_seconds < 0
      )
        throw new Error("Invalid Claude tool progress duration");
      // Pulse IDs are not call IDs. A forwarded child Bash pulse may name the
      // delegating Agent call as its parent, so parent identity alone is not
      // enough: its native tool name must match before applying an observation.
      const callId = message.parent_tool_use_id;
      if (callId === null || this.#settledTools.has(callId)) return [];
      const call = this.#calls.get(callId);
      if (call !== undefined && call.name !== message.tool_name) return [];
      const sources =
        this.#pendingToolProgress.get(callId) ??
        new Map<string, PendingToolProgress>();
      const progress = sources.get(message.tool_name) ?? {};
      if (message.subagent_retry !== undefined) {
        progress.retry = { uuid: message.uuid, detail: message.subagent_retry };
      } else if (
        message.heartbeat === true ||
        message.tool_name === "Bash" ||
        message.tool_name === "PowerShell"
      ) {
        progress.elapsedSeconds = Math.max(
          progress.elapsedSeconds ?? 0,
          message.elapsed_time_seconds,
        );
      } else {
        // Agent retry resolution and REPL call notifications carry a zero
        // placeholder, not an elapsed-time measurement.
        return [];
      }
      if (call === undefined) {
        sources.set(message.tool_name, progress);
        this.#pendingToolProgress.set(callId, sources);
        return [];
      }
      return this.#emitToolProgress(callId, progress, call);
    }
    if (message.type === "tool_use_summary") {
      const parents = new Set(
        message.preceding_tool_use_ids.map(
          (id) => this.#calls.get(id)?.parentToolUseId,
        ),
      );
      const owner = parents.size === 1 ? parents.values().next().value : null;
      return this.#route(
        [
          {
            type: "system.notice",
            id: `claude-tool-summary:${message.uuid}`,
            text: message.summary,
            level: "info",
          },
        ],
        owner ?? null,
      );
    }
    if (message.type !== "system") return undefined;
    if (message.subtype === "task_started") return this.#startTask(message);
    if (
      message.subtype !== "task_progress" &&
      message.subtype !== "task_notification"
    )
      return undefined;
    if (this.#ignoredTasks.has(message.task_id)) return [];
    if (
      message.subtype === "task_notification" &&
      (message.ambient || message.skip_transcript)
    )
      return [];
    const task = this.#tasks.get(message.task_id);
    if (task === undefined) {
      const updates = this.#pendingTaskUpdates.get(message.task_id) ?? [];
      updates.push(message);
      this.#pendingTaskUpdates.set(message.task_id, updates);
      return [];
    }
    return this.#updateTask(task, message);
  }

  finish(status: Exclude<ToolCompletionStatus, "completed">): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    for (const [id, owner] of this.#pendingTools) {
      this.#settledTools.add(id);
      const ownerId =
        owner.ownerAgentId ??
        (owner.parentToolUseId === null
          ? undefined
          : this.#agentByTool.get(owner.parentToolUseId));
      const ownerState =
        ownerId === undefined ? undefined : this.#agents.get(ownerId)?.state;
      // Child history is projected after the parent's stop/result records.
      // Preserve that explicit terminal fact for child calls missing a result.
      const terminalStatus =
        ownerState === "interrupted"
          ? "interrupted"
          : ownerState === "error"
            ? "failed"
            : status;
      events.push(
        ...this.#route(
          [{ type: "tool.completed", id, status: terminalStatus }],
          owner.parentToolUseId,
          owner.ownerAgentId,
        ),
      );
    }
    this.#pendingTools.clear();
    this.#pendingToolProgress.clear();
    this.#toolElapsedSeconds.clear();
    for (const task of this.#tasks.values()) {
      if (task.settled || task.agent) continue;
      events.push(
        ...this.#route(
          [{ type: "tool.completed", id: `claude-task:${task.id}`, status }],
          task.parentToolUseId,
          task.ownerAgentId,
        ),
      );
      task.settled = true;
    }
    for (const [taskId, updates] of this.#pendingTaskUpdates) {
      const last = updates.at(-1)!;
      const task: Task = {
        id: taskId,
        agent: false,
        parentToolUseId: null,
        description:
          last.subtype === "task_progress" ? last.description : last.summary,
        settled: false,
      };
      events.push({
        type: "tool.started",
        id: `claude-task:${taskId}`,
        tool: "backgroundTask",
        input: { taskId, description: task.description },
      });
      for (const update of updates)
        events.push(...this.#updateTask(task, update));
      if (!task.settled)
        events.push({
          type: "tool.completed",
          id: `claude-task:${taskId}`,
          status,
        });
    }
    this.#pendingTaskUpdates.clear();
    for (const agent of this.#agents.values()) {
      if (agent.state !== "starting" && agent.state !== "running") continue;
      const message = [agent.message, "执行流已结束，未收到子任务终态"]
        .filter(Boolean)
        .join(" · ");
      events.push(
        ...this.#setAgentState(
          agent.id,
          "unknown",
          message,
          `unresolved:${agent.id}`,
        ),
      );
    }
    for (const [toolUseId, pending] of this.#pendingChildEvents) {
      events.push({
        type: "system.notice",
        id: `claude-unresolved-child:${toolUseId}`,
        text: `未能将 ${pending.length} 条子任务事件关联到原生 Agent（调用 ${toolUseId}）。`,
        level: "warning",
      });
    }
    this.#pendingChildEvents.clear();
    return events;
  }

  #route(
    events: readonly AgentTimelineEvent[],
    parentToolUseId: string | null,
    ownerAgentId?: string,
  ): TimelineEvent[] {
    if (parentToolUseId === null && ownerAgentId === undefined)
      return [...events];
    const agentId =
      ownerAgentId ??
      (parentToolUseId === null
        ? undefined
        : this.#agentByTool.get(parentToolUseId));
    if (agentId !== undefined)
      return events.map((event) => ({
        type: "subagent.event",
        id: `claude-child:${agentId}:${event.id}`,
        agentId,
        event,
      }));
    if (parentToolUseId === null) throw new Error("Missing Claude event owner");
    const pending = this.#pendingChildEvents.get(parentToolUseId) ?? [];
    pending.push(...events);
    this.#pendingChildEvents.set(parentToolUseId, pending);
    return [];
  }

  #emitToolProgress(
    callId: string,
    progress: PendingToolProgress,
    owner: Owner,
  ): TimelineEvent[] {
    const events: AgentTimelineEvent[] = [];
    const previousElapsed = this.#toolElapsedSeconds.get(callId);
    if (
      progress.elapsedSeconds !== undefined &&
      (previousElapsed === undefined ||
        progress.elapsedSeconds > previousElapsed)
    ) {
      this.#toolElapsedSeconds.set(callId, progress.elapsedSeconds);
      events.push({
        type: "tool.progress",
        id: callId,
        elapsedSeconds: progress.elapsedSeconds,
      });
    }
    if (progress.retry !== undefined) {
      const { uuid, detail } = progress.retry;
      events.push({
        type: "system.notice",
        id: `claude-tool-retry:${uuid}`,
        level: "warning",
        text: `Agent API 重试 ${detail.attempt}/${detail.max_retries} · ${detail.error_category}${detail.error_status === null ? "" : ` (${detail.error_status})`} · ${detail.retry_delay_ms} ms 后重试`,
      });
    }
    return events.length === 0
      ? []
      : this.#route(events, owner.parentToolUseId, owner.ownerAgentId);
  }

  #setAgentState(
    agentId: string,
    state: SubagentState,
    message: string,
    id: string,
  ): TimelineEvent[] {
    const agent = this.#agents.get(agentId);
    if (agent === undefined)
      throw new Error("Unregistered Claude subagent state");
    agent.state = state;
    agent.message = message;
    return [
      {
        type: "subagent.state",
        id: `claude-agent-state:${id}`,
        agentId,
        state,
        ...(message ? { message } : {}),
      },
    ];
  }

  #stopTask(
    sourceCallId: string,
    output: Record<string, unknown>,
    text?: string,
  ): TimelineEvent[] {
    const { task_id: taskId, task_type: taskType } = output;
    if (
      typeof taskId !== "string" ||
      taskId.length === 0 ||
      typeof taskType !== "string" ||
      taskType.length === 0 ||
      this.#ignoredTasks.has(taskId)
    )
      return [];
    const agent = taskType === "local_agent";
    const existing = this.#tasks.get(taskId);
    if (
      (existing !== undefined && existing.agent !== agent) ||
      (!agent && this.#agents.has(taskId))
    )
      return [];
    if (this.#appliedStops.has(sourceCallId)) return [];
    this.#appliedStops.add(sourceCallId);
    const message =
      typeof output.message === "string" ? output.message : (text ?? "");
    const events: TimelineEvent[] = [];
    const task: Task = existing ?? {
      id: taskId,
      agent,
      parentToolUseId: null,
      description: "",
      settled: true,
    };
    task.settled = true;
    this.#tasks.set(taskId, task);
    this.#pendingTaskUpdates.delete(taskId);
    if (agent) {
      if (!this.#agents.has(taskId)) events.push(...this.registerAgent(taskId));
      events.push(...this.#finishAgentTools(taskId, "interrupted"));
      events.push(
        ...this.#setAgentState(
          taskId,
          "interrupted",
          message,
          `stop:${sourceCallId}`,
        ),
      );
    } else {
      if (existing === undefined)
        events.push({
          type: "tool.started",
          id: `claude-task:${taskId}`,
          tool: "backgroundTask",
          input: undefined,
        });
      events.push(
        ...this.#route(
          [
            {
              type: "tool.completed",
              id: `claude-task:${taskId}`,
              status: "interrupted",
              output: message,
              details: {
                type: "claudeTaskResult",
                taskId,
                taskType,
                stoppedByToolUseId: sourceCallId,
                result: output,
              },
            },
          ],
          task.parentToolUseId,
          task.ownerAgentId,
        ),
      );
    }
    return events;
  }

  #finishAgentTools(
    agentId: string,
    status: Exclude<ToolCompletionStatus, "completed">,
  ): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    for (const [id, owner] of this.#pendingTools) {
      const ownerId =
        owner.ownerAgentId ??
        (owner.parentToolUseId === null
          ? undefined
          : this.#agentByTool.get(owner.parentToolUseId));
      if (ownerId !== agentId) continue;
      this.#pendingTools.delete(id);
      this.#settledTools.add(id);
      this.#pendingToolProgress.delete(id);
      this.#toolElapsedSeconds.delete(id);
      events.push(
        ...this.#route(
          [{ type: "tool.completed", id, status }],
          owner.parentToolUseId,
          owner.ownerAgentId,
        ),
      );
    }
    return events;
  }

  #startTask(message: SDKTaskStartedMessage): TimelineEvent[] {
    if (message.ambient || message.skip_transcript) {
      this.#ignoredTasks.add(message.task_id);
      this.#pendingTaskUpdates.delete(message.task_id);
      return [];
    }
    const existing = this.#tasks.get(message.task_id);
    if (existing !== undefined && existing.toolUseId === message.tool_use_id)
      return [];
    const call =
      message.tool_use_id === undefined
        ? undefined
        : this.#calls.get(message.tool_use_id);
    const task: Task = {
      id: message.task_id,
      ...(message.tool_use_id === undefined
        ? {}
        : { toolUseId: message.tool_use_id }),
      agent: message.task_type === "local_agent",
      parentToolUseId: call?.parentToolUseId ?? null,
      ...(call?.ownerAgentId === undefined
        ? {}
        : { ownerAgentId: call.ownerAgentId }),
      description: message.description,
      settled: false,
    };
    this.#tasks.set(task.id, task);
    const events: TimelineEvent[] = [];
    if (task.agent) {
      events.push(...this.registerAgent(task.id, task.toolUseId));
      events.push({
        type: "subagent.started",
        id: `claude-agent:${task.id}`,
        agentId: task.id,
        name: message.description,
        ...(message.prompt === undefined ? {} : { prompt: message.prompt }),
        ...(message.subagent_type === undefined
          ? {}
          : { role: message.subagent_type }),
      });
      events.push(
        ...this.#setAgentState(
          task.id,
          "running",
          message.description,
          message.uuid,
        ),
      );
    } else {
      events.push(
        ...this.#route(
          [
            {
              type: "tool.started",
              id: `claude-task:${task.id}`,
              tool: "backgroundTask",
              input: {
                taskId: task.id,
                description: task.description,
                taskType: message.task_type,
              },
            },
          ],
          task.parentToolUseId,
          task.ownerAgentId,
        ),
      );
    }
    const pending = this.#pendingTaskUpdates.get(task.id);
    this.#pendingTaskUpdates.delete(task.id);
    if (pending)
      for (const update of pending)
        events.push(...this.#updateTask(task, update));
    return events;
  }

  #updateTask(task: Task, message: TaskUpdate): TimelineEvent[] {
    if (message.subtype === "task_progress") {
      if (task.settled) return [];
      const description = [
        message.summary || message.description,
        message.last_tool_name,
      ]
        .filter(Boolean)
        .join(" · ");
      if (task.agent)
        return this.#setAgentState(
          task.id,
          "running",
          `${description} · ${message.usage.tool_uses} 次工具调用 · ${message.usage.total_tokens} tokens · ${(message.usage.duration_ms / 1000).toFixed(1)}s`,
          `progress:${task.id}`,
        );
      return this.#route(
        [
          {
            type: "tool.progress",
            id: `claude-task:${task.id}`,
            elapsedSeconds: message.usage.duration_ms / 1000,
            description,
          },
        ],
        task.parentToolUseId,
        task.ownerAgentId,
      );
    }
    task.settled = true;
    if (task.agent)
      return [
        ...this.#finishAgentTools(
          task.id,
          message.status === "completed"
            ? "incomplete"
            : message.status === "stopped"
              ? "interrupted"
              : "failed",
        ),
        ...this.#setAgentState(
          task.id,
          message.status === "completed"
            ? "completed"
            : message.status === "stopped"
              ? "interrupted"
              : "error",
          message.summary,
          message.uuid,
        ),
      ];
    return this.#route(
      [
        {
          type: "tool.completed",
          id: `claude-task:${task.id}`,
          status: message.status === "stopped" ? "interrupted" : message.status,
          output: message.summary,
          details: {
            type: "claudeTaskResult",
            taskId: task.id,
            outputFile: message.output_file,
            ...(message.usage === undefined ? {} : { usage: message.usage }),
          },
        },
      ],
      task.parentToolUseId,
      task.ownerAgentId,
    );
  }
}
