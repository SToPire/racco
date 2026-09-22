import { UiIcon } from "./UiIcon";
import type { ToolTimelineRow } from "../store";
import { describeTool } from "../tool-presentation";
import { ToolCard } from "./ToolCard";

type ToolGroupProps = {
  rows: ToolTimelineRow[];
  selectedToolId?: string;
  onSelectTool: (id: string) => void;
};

export function ToolGroup({
  rows,
  selectedToolId,
  onSelectTool,
}: ToolGroupProps) {
  const recent = new Set(rows.slice(-2).map((row) => row.id));
  const visible = rows.filter(
    (row) =>
      rows.length <= 3 ||
      row.status !== "completed" ||
      row.id === selectedToolId ||
      recent.has(row.id),
  );
  const shown = new Set(visible.map((row) => row.id));
  const earlier = rows.filter((row) => !shown.has(row.id));
  const counts = new Map<string, number>();
  for (const row of earlier) {
    const label = describeTool(row).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const renderTool = (row: ToolTimelineRow) => (
    <ToolCard
      key={row.id}
      row={row}
      selected={row.id === selectedToolId}
      onSelect={() => onSelectTool(row.id)}
    />
  );
  return (
    <div className="tool-group">
      {earlier.length > 0 && (
        <details className="tool-history">
          <summary>
            <UiIcon name="chevron-right" />
            <span>
              之前 {earlier.length} 项已完成活动 ·{" "}
              {[...counts]
                .map(([label, count]) => `${label} ${count}`)
                .join(" · ")}
            </span>
          </summary>
          <div className="tool-group-items">{earlier.map(renderTool)}</div>
        </details>
      )}
      <div className="tool-group-items">{visible.map(renderTool)}</div>
    </div>
  );
}
