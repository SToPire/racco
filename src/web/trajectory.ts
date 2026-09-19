import type { SubagentState } from "../shared/protocol";
import type {
  AgentTimelineRow,
  SubagentTimelineRow,
  TimelineRow,
  ToolTimelineRow,
} from "./store";
import {
  formatAgentPath,
  subagentName,
  subagentStateLabel,
} from "./subagent-display";

export type TrajectoryKind =
  "system" | "user" | "assistant" | "context" | "tool" | "subagent";

export type TrajectoryEntry = {
  id: string;
  turn: number;
  step: number;
  kind: TrajectoryKind;
  label: string;
  summary: string;
  actor: string;
  agentPath?: string;
  cwd?: string;
  status?: string;
  payload?: unknown;
  result?: unknown;
  raw: unknown;
};

function compact(text: string, limit = 320): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

function toolLabel(row: ToolTimelineRow): string {
  if (row.tool === "command") return "Bash";
  if (row.tool === "fileChange") return "Files";
  return row.tool;
}

function toolSummary(row: ToolTimelineRow): string {
  const input =
    typeof row.input === "object" && row.input !== null
      ? (row.input as Record<string, unknown>)
      : undefined;
  if (row.tool === "command")
    return compact(stringify(input?.command ?? row.input));
  if (row.tool === "Context injection") {
    const fragments = input?.fragments;
    return Array.isArray(fragments)
      ? `${fragments.length} context fragment${fragments.length === 1 ? "" : "s"}`
      : "Injected context";
  }
  return compact(stringify(row.input));
}

function agentEntry(
  row: AgentTimelineRow,
  actor: string,
  prefix: string,
  agentPath?: string,
  cwd?: string,
): Omit<TrajectoryEntry, "turn" | "step"> {
  if (row.type === "user.message") {
    return {
      id: `${prefix}:user:${row.id}`,
      kind: "user",
      label: "User",
      summary: compact(row.text),
      actor,
      agentPath,
      cwd,
      payload: { text: row.text },
      raw: row,
    };
  }
  if (row.type === "assistant.message") {
    return {
      id: `${prefix}:assistant:${row.id}`,
      kind: "assistant",
      label: "Assistant",
      summary: compact(row.text),
      actor,
      agentPath,
      cwd,
      status:
        row.stopReason === "interrupted"
          ? "Interrupted"
          : row.stopReason === "error"
            ? "Failed"
            : row.partial
              ? "Streaming"
              : "Completed",
      result: row.text,
      raw: row,
    };
  }
  if (row.type === "system.notice") {
    return {
      id: `${prefix}:system:${row.id}`,
      kind: "system",
      label: "System",
      summary: compact(row.text),
      actor,
      agentPath,
      cwd,
      status: row.level,
      result: row.text,
      raw: row,
    };
  }
  return {
    id: `${prefix}:tool:${row.id}`,
    kind: row.tool === "Context injection" ? "context" : "tool",
    label: toolLabel(row),
    summary: toolSummary(row),
    actor,
    agentPath,
    cwd,
    status: row.status,
    payload: row.input,
    result: row.output,
    raw: row.details ?? row,
  };
}

function stateEntry(
  row: SubagentTimelineRow,
  state: { id: string; state: SubagentState; message?: string },
): Omit<TrajectoryEntry, "turn" | "step"> {
  const name = subagentName(row);
  return {
    id: `subagent:${row.agentId}:state:${state.id}`,
    kind: "subagent",
    label: "Agent state",
    summary: `${name} · ${subagentStateLabel(state.state)}${
      state.message === undefined ? "" : ` · ${compact(state.message)}`
    }`,
    actor: name,
    agentPath: formatAgentPath(row.agentPath),
    cwd: row.cwd,
    status: state.state,
    payload: {
      name,
      role: row.role,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
    },
    result: state.message,
    raw: state,
  };
}

export function buildTrajectory(rows: TimelineRow[]): TrajectoryEntry[] {
  const entries: TrajectoryEntry[] = [];
  let turn = 0;
  let step = 0;

  const append = (entry: Omit<TrajectoryEntry, "turn" | "step">) => {
    step += 1;
    entries.push({ ...entry, turn: Math.max(turn, 1), step });
  };

  for (const row of rows) {
    if (row.type !== "subagent") {
      if (row.type === "user.message") {
        turn += 1;
        step = 0;
      }
      append(agentEntry(row, "Main Agent", "main", undefined, undefined));
      continue;
    }

    const name = subagentName(row);
    const path = formatAgentPath(row.agentPath);
    append({
      id: `subagent:${row.agentId}:identity`,
      kind: "subagent",
      label: "Subagent",
      summary: `${name}${path === undefined ? "" : ` · ${path}`}`,
      actor: name,
      agentPath: path,
      cwd: row.cwd,
      status: row.state,
      payload: {
        name,
        role: row.role,
        agentPath: path,
        cwd: row.cwd,
        model: row.model,
        reasoningEffort: row.reasoningEffort,
      },
      result: row.statusMessage,
      raw: row,
    });
    if (row.prompt !== undefined) {
      append({
        id: `subagent:${row.agentId}:task`,
        kind: "user",
        label: "Task",
        summary: compact(row.prompt),
        actor: name,
        agentPath: path,
        cwd: row.cwd,
        payload: { prompt: row.prompt },
        raw: { type: "subagent.task", prompt: row.prompt },
      });
    }
    for (const activity of row.activities) append(stateEntry(row, activity));
    for (const childRow of row.timeline) {
      append(
        agentEntry(childRow, name, `subagent:${row.agentId}`, path, row.cwd),
      );
    }
  }

  return entries;
}
