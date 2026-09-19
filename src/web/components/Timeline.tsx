import type { Provider } from "../../shared/protocol";
import { groupTimelineRows, type AgentTimelineRow } from "../store";
import { userRequestAnchorId } from "../timeline-navigation";
import { MarkdownContent } from "./MarkdownContent";
import { ProviderLogo } from "./ProviderLogo";
import { TrajectoryToolRow } from "./TrajectoryToolRow";
import { ToolGroup } from "./ToolGroup";

type TimelineProps = {
  rows: AgentTimelineRow[];
  provider: Provider;
  selectedToolId?: string;
  onSelectTool: (id: string) => void;
  denseTools?: boolean;
};

export function Timeline({
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
            <p className={`notice notice-${row.level}`} key={row.id}>
              {row.text}
            </p>
          );
        }
        const user = row.type === "user.message";
        return (
          <article
            className={`message message-${user ? "user" : "assistant"}`}
            id={user ? userRequestAnchorId(row.id) : undefined}
            key={row.id}
          >
            {!user && (
              <span className={`message-avatar message-avatar-${provider}`}>
                <ProviderLogo provider={provider} />
              </span>
            )}
            <div className="message-content">
              <MarkdownContent text={row.text} />
            </div>
          </article>
        );
      })}
    </div>
  );
}
