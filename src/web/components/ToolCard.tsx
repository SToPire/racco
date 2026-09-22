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
      className={`tool-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="tool-card-description">
        <strong>{presentation.label}</strong>
        <span>{presentation.summary}</span>
        {presentation.outcome && <small>{presentation.outcome}</small>}
        {presentation.progress && <small>{presentation.progress}</small>}
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
