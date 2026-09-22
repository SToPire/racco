import type { SubagentState } from "../shared/protocol";
import type { SubagentTimelineRow } from "./store";

const STATE_LABELS: Record<SubagentState, string> = {
  starting: "启动中",
  running: "运行中",
  completed: "已完成",
  interrupted: "已中断",
  error: "失败",
  unknown: "状态未知",
};

export function subagentStateLabel(state: SubagentState): string {
  return STATE_LABELS[state];
}

export function subagentName(row: SubagentTimelineRow): string {
  return (
    row.name ?? row.agentPath?.split("/").filter(Boolean).at(-1) ?? "Subagent"
  );
}

export function formatAgentPath(path: string | undefined): string | undefined {
  const segments = path?.split("/").filter(Boolean);
  return segments === undefined || segments.length === 0
    ? undefined
    : segments.join(" › ");
}
