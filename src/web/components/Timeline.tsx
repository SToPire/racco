import type { Provider } from "../../shared/protocol";
import { memo } from "react";
import { groupTimelineRows, type AgentTimelineRow } from "../store";
import { userRequestAnchorId } from "../timeline-navigation";
import { MarkdownContent } from "./MarkdownContent";
import { ProviderLogo } from "./ProviderLogo";
import { TrajectoryToolRow } from "./TrajectoryToolRow";
import { ToolGroup } from "./ToolGroup";
import { AssistantActivity, assistantPhaseLabel } from "./AssistantActivity";

type TimelineProps = {
  sessionId: string;
  rows: AgentTimelineRow[];
  provider: Provider;
  selectedToolId?: string;
  onSelectTool: (id: string) => void;
  denseTools?: boolean;
};

export const Timeline = memo(function Timeline({
  sessionId,
  rows,
  provider,
  selectedToolId,
  onSelectTool,
  denseTools = false,
}: TimelineProps) {
  const sections = groupTimelineRows(rows);

  return (
    <div className="timeline" aria-live="polite">
      {sections.map((section) => {
        if (section.type === "tool-group") {
          if (denseTools) {
            return (
              <div className="trajectory-tool-list" key={section.id}>
                {section.rows.map((row) => (
                  <TrajectoryToolRow
                    key={row.id}
                    onSelect={() => onSelectTool(row.id)}
                    row={row}
                    selected={row.id === selectedToolId}
                  />
                ))}
              </div>
            );
          }
          return (
            <ToolGroup
              key={section.id}
              onSelectTool={onSelectTool}
              rows={section.rows}
              selectedToolId={selectedToolId}
            />
          );
        }
        const row = section.row;
        if (row.type === "system.notice") {
          return (
            <p
              className={`notice notice-${row.level}`}
              key={row.id}
              data-timeline-row={row.id}
            >
              {row.text}
            </p>
          );
        }
        if (
          row.type === "assistant.reasoning" ||
          row.type === "assistant.plan" ||
          row.type === "plan.updated"
        ) {
          return (
            <div key={row.id} data-timeline-row={row.id}>
              <AssistantActivity row={row} />
            </div>
          );
        }
        const user = row.type === "user.message";
        return (
          <article
            className={`message message-${user ? "user" : "assistant"}`}
            id={user ? userRequestAnchorId(sessionId, row.id) : undefined}
            key={row.id}
            data-timeline-row={row.id}
          >
            {!user && (
              <span className={`message-avatar message-avatar-${provider}`}>
                <ProviderLogo provider={provider} />
              </span>
            )}
            <div className="message-content">
              {!user &&
                (assistantPhaseLabel(row.phase) ||
                  row.partial ||
                  row.stopReason) && (
                  <small className="assistant-message-state">
                    {[
                      assistantPhaseLabel(row.phase),
                      row.stopReason === "interrupted"
                        ? "已中断"
                        : row.stopReason === "error"
                          ? "未完成"
                          : row.partial
                            ? "生成中"
                            : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                )}
              <MarkdownContent text={row.text} />
            </div>
          </article>
        );
      })}
    </div>
  );
});
