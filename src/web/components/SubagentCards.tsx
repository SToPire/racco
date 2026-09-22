import type { SubagentTimelineRow } from "../store";
import { subagentName, subagentStateLabel } from "../subagent-display";

export function SubagentCards({
  subagents,
  onSelect,
}: {
  subagents: SubagentTimelineRow[];
  onSelect: (agentId: string) => void;
}) {
  return (
    <section className="subagent-cards" aria-label="子 Agent 任务">
      <h2>子任务 · {subagents.length}</h2>
      <div className="subagent-card-list">
        {subagents.map((row) => {
          const name = subagentName(row);
          const preview = row.statusMessage?.trim() || undefined;
          return (
            <button
              className={`subagent-card state-${row.state}`}
              key={row.agentId}
              onClick={() => onSelect(row.agentId)}
              type="button"
              aria-label={`查看 ${name} 的对话`}
            >
              <span className="subagent-card-heading">
                <strong>{name}</strong>
                <span className="subagent-card-state">
                  <i className={`agent-status-dot state-${row.state}`} />
                  {subagentStateLabel(row.state)}
                </span>
              </span>
              <span className="subagent-card-task">
                {row.prompt?.trim() || row.role?.trim() || "未提供任务描述"}
              </span>
              {preview !== undefined ? (
                <span className="subagent-card-preview">
                  <span>{row.state === "completed" ? "结果" : "进展"}</span>
                  <span>{preview}</span>
                </span>
              ) : (
                <span className="subagent-card-empty">
                  {row.state === "completed"
                    ? "已结束，暂无结果摘要"
                    : row.state === "unknown"
                      ? "未收到子任务终态"
                      : row.state === "error" || row.state === "interrupted"
                        ? "暂无结束说明"
                        : "等待进展更新"}
                </span>
              )}
              <span className="subagent-card-link">查看对话 →</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
