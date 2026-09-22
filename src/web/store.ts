import type {
  AgentTimelineEvent,
  SubagentState,
  TimelineEvent,
  ToolCompletionStatus,
  ToolProgress,
} from "../shared/protocol";

export type ToolTimelineRow = {
  type: "tool";
  id: string;
  tool: string;
  input?: unknown;
  details?: unknown;
  output: string;
  status: "running" | ToolCompletionStatus;
  progress?: ToolProgress;
};

export type AgentTimelineRow =
  | Extract<
      AgentTimelineEvent,
      {
        type:
          | "user.message"
          | "assistant.message"
          | "assistant.reasoning"
          | "assistant.plan"
          | "plan.updated";
      }
    >
  | Extract<AgentTimelineEvent, { type: "system.notice" }>
  | ToolTimelineRow;

export type SubagentTimelineRow = {
  type: "subagent";
  id: string;
  agentId: string;
  parentAgentId?: string;
  name?: string;
  agentPath?: string;
  cwd?: string;
  role?: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  state: SubagentState;
  statusMessage?: string;
  activities: Array<{ id: string; state: SubagentState; message?: string }>;
  timeline: AgentTimelineRow[];
};

export type TimelineRow = AgentTimelineRow | SubagentTimelineRow;

function emptySubagent(agentId: string): SubagentTimelineRow {
  return {
    type: "subagent",
    id: `subagent:${agentId}`,
    agentId,
    state: "starting",
    activities: [],
    timeline: [],
  };
}

type TimelineSection =
  | {
      type: "tool-group";
      id: string;
      rows: ToolTimelineRow[];
    }
  | {
      type: "row";
      id: string;
      row: Exclude<AgentTimelineRow, { type: "tool" }>;
    };

export function findTimelineTool(
  rows: readonly TimelineRow[],
  id: string | undefined,
): ToolTimelineRow | undefined {
  if (id === undefined) return undefined;
  for (const row of rows) {
    if (row.type === "tool" && row.id === id) return row;
    if (row.type !== "subagent") continue;
    const tool = row.timeline.find(
      (candidate): candidate is ToolTimelineRow =>
        candidate.type === "tool" && candidate.id === id,
    );
    if (tool !== undefined) return tool;
  }
  return undefined;
}

function applyAgentTimelineEvent(
  rows: TimelineRow[],
  event: AgentTimelineEvent,
): void {
  const index = rows.findIndex(
    (row) => row.type !== "subagent" && row.id === event.id,
  );

  if (event.type === "assistant.message.removed") {
    if (index !== -1 && rows[index].type === "assistant.message")
      rows.splice(index, 1);
    return;
  }

  if (
    event.type === "user.message" ||
    event.type === "assistant.message" ||
    event.type === "assistant.reasoning" ||
    event.type === "assistant.plan" ||
    event.type === "plan.updated" ||
    event.type === "system.notice"
  ) {
    if (index === -1) rows.push(event);
    else rows[index] = event;
    return;
  }

  const previous =
    index === -1 || rows[index].type !== "tool" ? undefined : rows[index];
  const details =
    event.type === "tool.started"
      ? event.details
      : event.type === "tool.completed"
        ? (event.details ?? previous?.details)
        : previous?.details;
  const tool: ToolTimelineRow = {
    type: "tool",
    id: event.id,
    tool:
      event.type === "tool.started" ? event.tool : (previous?.tool ?? "tool"),
    input: event.type === "tool.started" ? event.input : previous?.input,
    ...(details === undefined ? {} : { details }),
    ...(event.type === "tool.progress"
      ? {
          progress: {
            elapsedSeconds: event.elapsedSeconds,
            ...(event.description === undefined
              ? {}
              : { description: event.description }),
          },
        }
      : previous?.progress === undefined
        ? {}
        : { progress: previous.progress }),
    output:
      event.type === "tool.output"
        ? event.output
        : event.type === "tool.completed"
          ? (event.output ?? previous?.output ?? "")
          : (previous?.output ?? ""),
    status:
      event.type === "tool.completed"
        ? event.status
        : (previous?.status ?? "running"),
  };

  if (index === -1) rows.push(tool);
  else rows[index] = tool;
}

export function applyTimelineEvent(
  rows: TimelineRow[],
  event: TimelineEvent,
): TimelineRow[] {
  const next = [...rows];
  if (
    event.type !== "subagent.started" &&
    event.type !== "subagent.state" &&
    event.type !== "subagent.event"
  ) {
    applyAgentTimelineEvent(next, event);
    return next;
  }

  const subagentIndex = next.findIndex(
    (row) => row.type === "subagent" && row.agentId === event.agentId,
  );
  const previous =
    subagentIndex === -1 || next[subagentIndex]?.type !== "subagent"
      ? undefined
      : next[subagentIndex];
  let subagent: SubagentTimelineRow = previous ?? emptySubagent(event.agentId);

  if (event.type === "subagent.started") {
    subagent = {
      ...subagent,
      ...(event.parentAgentId === undefined
        ? {}
        : { parentAgentId: event.parentAgentId }),
      ...(event.name === undefined ? {} : { name: event.name }),
      ...(event.agentPath === undefined ? {} : { agentPath: event.agentPath }),
      ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
      ...(event.role === undefined ? {} : { role: event.role }),
      ...(event.prompt === undefined ? {} : { prompt: event.prompt }),
      ...(event.model === undefined ? {} : { model: event.model }),
      ...(event.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: event.reasoningEffort }),
    };
  } else if (event.type === "subagent.state") {
    const activities = [...subagent.activities];
    const activity = {
      id: event.id,
      state: event.state,
      ...(event.message === undefined ? {} : { message: event.message }),
    };
    const activityIndex = activities.findIndex(
      (candidate) => candidate.id === event.id,
    );
    const lastActivity = activities.at(-1);
    if (activityIndex !== -1) {
      activities[activityIndex] = activity;
    } else if (
      lastActivity?.state !== activity.state ||
      lastActivity.message !== activity.message
    ) {
      activities.push(activity);
    }
    if (event.message === undefined) {
      const { statusMessage: _statusMessage, ...withoutStatusMessage } =
        subagent;
      subagent = { ...withoutStatusMessage, state: event.state, activities };
    } else {
      subagent = {
        ...subagent,
        state: event.state,
        statusMessage: event.message,
        activities,
      };
    }
  } else {
    subagent = {
      ...subagent,
      timeline: [...subagent.timeline],
    };
    applyAgentTimelineEvent(subagent.timeline, event.event);
  }

  if (subagentIndex === -1) next.push(subagent);
  else next[subagentIndex] = subagent;
  return next;
}

export function buildTimeline(events: TimelineEvent[]): TimelineRow[] {
  // A snapshot is built once with indexed slots. Reusing the incremental
  // reducer over the growing array copies and scans the full history per event.
  const rows = new Map<string, TimelineRow>();
  const children = new Map<string, Map<string, TimelineRow>>();
  function apply(
    target: Map<string, TimelineRow>,
    key: string,
    event: AgentTimelineEvent,
  ) {
    const previous = target.get(key);
    const slot = previous === undefined ? [] : [previous];
    applyAgentTimelineEvent(slot, event);
    if (slot.length === 0) target.delete(key);
    else target.set(key, slot[0]);
  }
  for (const event of events) {
    if (
      event.type === "subagent.started" ||
      event.type === "subagent.state" ||
      event.type === "subagent.event"
    ) {
      const key = `subagent:${event.agentId}`;
      const previous = rows.get(key) ?? emptySubagent(event.agentId);
      if (event.type === "subagent.event") {
        let timeline = children.get(event.agentId);
        if (timeline === undefined) {
          timeline = new Map();
          children.set(event.agentId, timeline);
        }
        apply(timeline, event.event.id, event.event);
        rows.set(key, previous);
      } else {
        rows.set(key, applyTimelineEvent([previous], event)[0]);
      }
    } else {
      apply(rows, `row:${event.id}`, event);
    }
  }
  return [...rows.values()].map((row) =>
    row.type === "subagent"
      ? {
          ...row,
          timeline: [
            ...(children.get(row.agentId)?.values() ?? []),
          ] as AgentTimelineRow[],
        }
      : row,
  );
}

export function groupTimelineRows(rows: AgentTimelineRow[]): TimelineSection[] {
  const sections: TimelineSection[] = [];
  let activeToolGroup:
    Extract<TimelineSection, { type: "tool-group" }> | undefined;

  for (const row of rows) {
    if (row.type === "tool") {
      if (activeToolGroup === undefined) {
        activeToolGroup = {
          type: "tool-group",
          id: `tool-group:${row.id}`,
          rows: [],
        };
        sections.push(activeToolGroup);
      }
      activeToolGroup.rows.push(row);
      continue;
    }

    activeToolGroup = undefined;
    sections.push({ type: "row", id: row.id, row });
  }

  return sections;
}
