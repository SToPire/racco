import type {
  SubagentState,
  SessionState,
  TimelineEvent,
} from "../../../shared/protocol.js";
import type { ProviderSessionMetadata } from "../driver.js";
import { isAssistantItem, mapAssistantItem } from "./activity-mapper.js";
import { CodexToolLifecycle } from "./tool-lifecycle.js";
import { mapFileChange } from "./file-change.js";
import type {
  CodexThread,
  CodexThreadItem,
  CodexThreadStatus,
  CodexTurn,
  CollabAgentStatus,
  SubAgentActivityKind,
} from "./types.js";

type SubagentIdResolver = (providerThreadId: string) => string;
type ItemEvent = Exclude<TimelineEvent, { type: "subagent.event" }>;

function stringify(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function mapThreadState(status: CodexThreadStatus): SessionState {
  if (status.type === "active") return "running";
  if (status.type === "systemError") return "error";
  return "idle";
}

export function mapTurnState(turn: CodexTurn): SessionState {
  if (turn.status === "failed") return "error";
  if (turn.status === "interrupted") return "interrupted";
  if (turn.status === "inProgress") return "running";
  return "idle";
}

function mapCollabAgentState(status: CollabAgentStatus): SubagentState {
  if (status === "pendingInit") return "starting";
  if (status === "running") return "running";
  if (status === "interrupted") return "interrupted";
  if (status === "errored" || status === "notFound") return "error";
  return "completed";
}

function mapSubagentActivityState(kind: SubAgentActivityKind): SubagentState {
  if (kind === "started") return "starting";
  if (kind === "interacted") return "running";
  if (kind === "interrupted") return "interrupted";
  return "completed";
}

function pathName(path: string | undefined): string | undefined {
  return path?.split("/").filter(Boolean).at(-1);
}

function subagentPath(source: CodexThread["source"]): string | undefined {
  if (typeof source !== "object" || !("subAgent" in source)) return undefined;
  const subagent = source.subAgent;
  return typeof subagent === "object" && "thread_spawn" in subagent
    ? (subagent.thread_spawn.agent_path ?? undefined)
    : undefined;
}

export function mapThreadSummary(thread: CodexThread): ProviderSessionMetadata {
  return {
    title: (thread.name ?? thread.preview) || undefined,
    updatedAt: new Date(thread.updatedAt * 1_000).toISOString(),
  };
}

export function mapThreadEvents(
  thread: CodexThread,
  resolveSubagentId: SubagentIdResolver,
): ItemEvent[] {
  const tools = new CodexToolLifecycle();
  return thread.turns.flatMap((turn) => {
    const events = turn.items.flatMap((item) =>
      mapItemEvents(item, resolveSubagentId),
    );
    tools.observe(thread.id, turn.id, events);
    if (turn.status !== "inProgress") {
      events.push(
        ...tools.finish(
          thread.id,
          turn.status === "interrupted"
            ? "interrupted"
            : turn.status === "failed"
              ? "failed"
              : "incomplete",
          turn.id,
        ),
      );
    }
    if (turn.status === "failed") {
      events.push({
        type: "system.notice",
        id: `${turn.id}:error`,
        text: turn.error?.message ?? "Codex turn failed",
        level: "error",
      });
    }
    return events;
  });
}

export function mapItemEvents(
  item: CodexThreadItem,
  resolveSubagentId: SubagentIdResolver,
): ItemEvent[] {
  if (item.type === "contextCompaction") {
    return [
      {
        type: "system.notice",
        id: item.id,
        level: "info",
        text: "上下文已压缩",
      },
    ];
  }
  if (item.type === "userMessage") {
    const text = item.content
      .filter(
        (content): content is { type: string; text: string } =>
          content.type === "text" && typeof content.text === "string",
      )
      .map((content) => content.text)
      .join("\n");
    return text.length === 0
      ? []
      : [{ type: "user.message", id: item.id, text }];
  }

  if (isAssistantItem(item)) return [mapAssistantItem(item)];

  if (item.type === "hookPrompt") {
    const text = item.fragments.map((fragment) => fragment.text).join("\n\n");
    return [
      {
        type: "tool.started",
        id: item.id,
        tool: "Context injection",
        input: { fragments: item.fragments },
        details: item,
      },
      {
        type: "tool.completed",
        id: item.id,
        status: "completed",
        output: text,
        details: item,
      },
    ];
  }

  if (item.type === "commandExecution") {
    const events: ItemEvent[] = [
      {
        type: "tool.started",
        id: item.id,
        tool: "command",
        input: { command: item.command, cwd: item.cwd },
        details: item,
      },
    ];
    if (item.aggregatedOutput !== null) {
      events.push({
        type: "tool.output",
        id: item.id,
        output: item.aggregatedOutput,
      });
    }
    if (item.status !== "inProgress") {
      events.push({
        type: "tool.completed",
        id: item.id,
        status:
          item.status === "completed" &&
          (item.exitCode === null || item.exitCode === 0)
            ? "completed"
            : "failed",
        output: item.aggregatedOutput ?? undefined,
        details: item,
      });
    }
    return events;
  }

  if (item.type === "fileChange") {
    const events: ItemEvent[] = [
      {
        type: "tool.started",
        id: item.id,
        tool: "fileChange",
        input: item.changes.map(mapFileChange),
        details: item,
      },
    ];
    if (item.status !== "inProgress") {
      events.push({
        type: "tool.completed",
        id: item.id,
        status: item.status === "completed" ? "completed" : "failed",
        details: item,
      });
    }
    return events;
  }

  if (item.type === "mcpToolCall") {
    const output =
      item.error === null ? stringify(item.result) : stringify(item.error);
    const events: ItemEvent[] = [
      {
        type: "tool.started",
        id: item.id,
        tool: `${item.server}/${item.tool}`,
        input: item.arguments,
        details: item,
      },
    ];
    if (item.status !== "inProgress") {
      events.push({
        type: "tool.completed",
        id: item.id,
        status:
          item.status === "completed" && item.error === null
            ? "completed"
            : "failed",
        output,
        details: item,
      });
    }
    return events;
  }

  if (item.type === "dynamicToolCall") {
    const events: ItemEvent[] = [
      {
        type: "tool.started",
        id: item.id,
        tool: item.namespace ? `${item.namespace}/${item.tool}` : item.tool,
        input: item.arguments,
        details: item,
      },
    ];
    if (item.status !== "inProgress") {
      events.push({
        type: "tool.completed",
        id: item.id,
        status:
          item.status === "completed" && item.success === true
            ? "completed"
            : "failed",
        output: stringify(item.contentItems),
        details: item,
      });
    }
    return events;
  }

  if (item.type === "subAgentActivity") {
    const agentId = resolveSubagentId(item.agentThreadId);
    const events: ItemEvent[] = [];
    if (item.kind === "started") {
      events.push({
        type: "subagent.started",
        id: item.id,
        agentId,
        name: pathName(item.agentPath),
        agentPath: item.agentPath,
      });
    }
    events.push({
      type: "subagent.state",
      id: `${item.id}:state`,
      agentId,
      state: mapSubagentActivityState(item.kind),
    });
    return events;
  }

  if (item.type === "collabAgentToolCall") {
    const events: ItemEvent[] = [];
    if (item.tool === "spawnAgent") {
      item.receiverThreadIds.forEach((threadId, index) => {
        events.push({
          type: "subagent.started",
          id: `${item.id}:spawn:${index}`,
          agentId: resolveSubagentId(threadId),
          prompt: item.prompt ?? undefined,
          model: item.model ?? undefined,
          reasoningEffort: item.reasoningEffort ?? undefined,
        });
      });
    }
    for (const [threadId, state] of Object.entries(item.agentsStates)) {
      if (state === undefined) continue;
      events.push({
        type: "subagent.state",
        id: `${item.id}:state:${events.length}`,
        agentId: resolveSubagentId(threadId),
        state: mapCollabAgentState(state.status),
        message: state.message ?? undefined,
      });
    }
    return events;
  }

  return [];
}

export function mapSubagentThread(
  thread: CodexThread,
  agentId: string,
  resolveSubagentId: SubagentIdResolver,
  parentAgentId?: string,
): TimelineEvent[] {
  const agentPath = subagentPath(thread.source);
  const events: TimelineEvent[] = [
    {
      type: "subagent.started",
      id: `${agentId}:metadata`,
      agentId,
      parentAgentId,
      name: thread.agentNickname ?? pathName(agentPath),
      agentPath,
      cwd: thread.cwd,
      role: thread.agentRole ?? undefined,
    },
  ];

  events.push(
    ...mapSubagentEvents(mapThreadEvents(thread, resolveSubagentId), agentId),
  );

  const lastTurn = thread.turns.at(-1);
  const state: SubagentState =
    lastTurn?.status === "inProgress"
      ? "running"
      : lastTurn?.status === "interrupted"
        ? "interrupted"
        : lastTurn?.status === "failed"
          ? "error"
          : lastTurn?.status === "completed"
            ? "completed"
            : thread.status.type === "active"
              ? "running"
              : thread.status.type === "systemError"
                ? "error"
                : "starting";
  events.push({
    type: "subagent.state",
    id: `${agentId}:state`,
    agentId,
    state,
    message: lastTurn?.error?.message ?? undefined,
  });
  return events;
}

export function mapSubagentEvents(
  events: ItemEvent[],
  agentId: string,
): TimelineEvent[] {
  return events.map((event) => {
    if (event.type === "subagent.started" || event.type === "subagent.state") {
      return event;
    }
    return {
      type: "subagent.event",
      id: `${agentId}:event:${event.type}:${event.id}`,
      agentId,
      event: { ...event, id: `${agentId}:${event.id}` },
    };
  });
}
