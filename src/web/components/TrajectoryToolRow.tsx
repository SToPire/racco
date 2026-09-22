import type { ToolTimelineRow } from "../store";
import { describeTool, toolStatusLabel } from "../tool-presentation";

export function TrajectoryToolRow({
  row,
  selected,
  onSelect,
}: {
  row: ToolTimelineRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const description = describeTool(row);
  return (
    <button
      aria-pressed={selected}
      data-timeline-row={row.id}
      className={`trajectory-tool-row${selected ? " selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="trajectory-tool-icon" aria-hidden="true">
        {row.tool === "command" || row.tool === "Bash" ? ">_" : "▧"}
      </span>
      <strong title={row.tool}>{description.label}</strong>
      <span>
        {[description.summary, description.outcome, description.progress]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <span className={`tool-status tool-status-${row.status}`}>
        {toolStatusLabel(row.status)}
      </span>
    </button>
  );
}
