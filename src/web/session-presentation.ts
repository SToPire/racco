import type { SessionState } from "../shared/protocol";

const SESSION_STATE_LABELS: Record<SessionState, string> = {
  idle: "空闲",
  running: "运行中",
  waiting_interaction: "等待操作",
  interrupted: "已中断",
  error: "出错",
};

export function sessionStateLabel(
  state: SessionState,
  compacting = false,
): string {
  return compacting ? "压缩中" : SESSION_STATE_LABELS[state];
}
