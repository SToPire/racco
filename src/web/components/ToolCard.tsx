import type { TimelineRow } from "../store";
import { describeTool, toolStatusLabel } from "../tool-presentation";

type ToolCardProps = {
  row: Extract<TimelineRow, { type: "tool" }>;
  selected: boolean;
  onSelect: () => void;
};

export function ToolCard({ row, selected, onSelect }: ToolCardProps) {
  const presentation = describeTool(row);
  return (
    <button
      aria-pressed={selected}
      data-timeline-row={row.id}
      className={`tool-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="tool-card-description">
        <span className="tool-card-heading">
          <strong title={presentation.label}>{presentation.label}</strong>
          <span className="tool-card-summary" title={presentation.summary}>
            {presentation.summary}
          </span>
          {presentation.outcome && (
            <small className="tool-card-outcome" title={presentation.outcome}>
              {presentation.outcome}
            </small>
          )}
        </span>
        {presentation.progress && (
          <small className="tool-card-progress" title={presentation.progress}>
            {presentation.progress}
          </small>
        )}
        {presentation.preview && (
          <span className={`tool-preview tool-preview-${row.status}`}>
            {presentation.preview}
          </span>
        )}
      </span>
      <span className={`tool-status tool-status-${row.status}`}>
        {toolStatusLabel(row.status)}
      </span>
    </button>
  );
}
