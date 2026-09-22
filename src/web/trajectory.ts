import { describeTool } from "./tool-presentation";
import type { SubagentState } from "../shared/protocol";
import type {
  AgentTimelineRow,
  SubagentTimelineRow,
  TimelineRow,
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
  turn?: number;
  step: number;
  kind: TrajectoryKind;
  label: string;
  summary: string;
  actor: string;
  agentId?: string;
  rowId?: string;
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

function agentEntryContent(
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
  if (
    row.type === "assistant.reasoning" ||
    row.type === "assistant.plan" ||
    row.type === "plan.updated"
  ) {
    const text =
      row.type === "assistant.reasoning"
        ? row.summary.join("\n\n")
        : row.type === "assistant.plan"
          ? row.text
          : [
              row.explanation,
              ...row.steps.map((step) => `${step.status}: ${step.step}`),
            ]
              .filter(Boolean)
              .join("\n");
    return {
      id: `${prefix}:${row.type}:${row.id}`,
      kind: "assistant",
      label:
        row.type === "assistant.reasoning"
          ? "思考摘要"
          : row.type === "assistant.plan"
            ? "方案"
            : "执行计划",
      summary: compact(text),
      actor,
      agentPath,
      cwd,
      status:
        row.type === "plan.updated"
          ? row.state
          : row.stopReason === "interrupted"
            ? "Interrupted"
            : row.stopReason === "error"
              ? "Failed"
              : row.partial
                ? "Streaming"
                : "Completed",
      result: text,
      raw: row,
    };
  }
  return {
    id: `${prefix}:tool:${row.id}`,
    kind: row.tool === "Context injection" ? "context" : "tool",
    label: describeTool(row).label,
    summary: [
      describeTool(row).summary,
      describeTool(row).outcome,
      describeTool(row).progress,
    ]
      .filter(Boolean)
      .join(" · "),
    actor,
    agentPath,
    cwd,
    status: row.status,
    payload: row.input,
    result: row.output,
    raw: row.details ?? row,
  };
}

function agentEntry(
  row: AgentTimelineRow,
  actor: string,
  prefix: string,
  agentPath?: string,
  cwd?: string,
  agentId?: string,
): Omit<TrajectoryEntry, "turn" | "step"> {
  return {
    ...agentEntryContent(row, actor, prefix, agentPath, cwd),
    rowId: row.id,
    agentId,
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
    let childStep = 0;
    const appendChild = (entry: Omit<TrajectoryEntry, "turn" | "step">) => {
      // Native child history does not establish its place in the main turn sequence.
      entries.push({ ...entry, agentId: row.agentId, step: ++childStep });
    };
    appendChild({
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
      appendChild({
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
    for (const activity of row.activities)
      appendChild(stateEntry(row, activity));
    for (const childRow of row.timeline) {
      appendChild(
        agentEntry(
          childRow,
          name,
          `subagent:${row.agentId}`,
          path,
          row.cwd,
          row.agentId,
        ),
      );
    }
  }

  return entries;
}
