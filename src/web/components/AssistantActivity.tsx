import type {
  AssistantPhase,
  AssistantPlanEvent,
  AssistantReasoningEvent,
  PlanUpdatedEvent,
} from "../../shared/protocol";
import { MarkdownContent } from "./MarkdownContent";

export type AssistantActivityRow =
  AssistantReasoningEvent | AssistantPlanEvent | PlanUpdatedEvent;

export function assistantPhaseLabel(
  phase: AssistantPhase | null | undefined,
): string | undefined {
  if (phase === "commentary") return "进展";
  if (phase === "final_answer") return "答复";
  return undefined;
}

function contentStatus(row: AssistantReasoningEvent | AssistantPlanEvent) {
  if (row.stopReason === "interrupted") return "已中断";
  if (row.stopReason === "error") return "未完成";
  return row.partial ? "生成中" : undefined;
}

export function AssistantActivity({ row }: { row: AssistantActivityRow }) {
  if (row.type === "plan.updated") {
    const completed = row.steps.filter(
      (step) => step.status === "completed",
    ).length;
    return (
      <section
        className="assistant-activity execution-plan"
        aria-label="执行计划"
      >
        <header>
          <strong>执行计划</strong>
          <span>
            {completed} / {row.steps.length} 已完成
            {row.state === "interrupted"
              ? " · 已中断"
              : row.state === "error"
                ? " · 未完成"
                : row.state === "completed"
                  ? " · 本轮结束"
                  : ""}
          </span>
        </header>
        {row.explanation && (
          <div className="assistant-activity-content message-content">
            <MarkdownContent text={row.explanation} />
          </div>
        )}
        <ol>
          {row.steps.map((step, index) => (
            <li key={index} className={`plan-step plan-step-${step.status}`}>
              <span aria-hidden="true">
                {step.status === "completed"
                  ? "✓"
                  : step.status === "inProgress"
                    ? "◉"
                    : "○"}
              </span>
              <span>{step.step}</span>
              <small>
                {step.status === "completed"
                  ? "已完成"
                  : row.state !== "running"
                    ? "未完成"
                    : step.status === "inProgress"
                      ? "进行中"
                      : "待开始"}
              </small>
            </li>
          ))}
        </ol>
      </section>
    );
  }
  if (row.type === "assistant.plan") {
    if (row.text.length === 0 && !row.partial) return null;
    return (
      <section className="assistant-activity proposed-plan" aria-label="方案">
        <header>
          <strong>方案</strong>
          <span>{contentStatus(row)}</span>
        </header>
        <div className="assistant-activity-content message-content">
          <MarkdownContent text={row.text || "正在整理方案…"} />
        </div>
      </section>
    );
  }
  const summary = row.summary.filter((part) => part.trim().length > 0);
  if (summary.length === 0 && !row.partial) return null;
  return (
    <details className="assistant-activity reasoning-summary">
      <summary>
        <strong>思考摘要</strong>
        <span className="reasoning-preview">
          {summary[0] || "正在整理思路…"}
        </span>
        <small>{contentStatus(row)}</small>
      </summary>
      {summary.map((part, index) => (
        <div className="assistant-activity-content message-content" key={index}>
          <MarkdownContent text={part} />
        </div>
      ))}
    </details>
  );
}
