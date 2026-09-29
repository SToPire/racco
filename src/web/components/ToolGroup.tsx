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
  const historyLength = rows.length <= 3 ? 0 : rows.length - 2;
  const earlier = rows.slice(0, historyLength);
  const recent = rows.slice(historyLength);
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
              较早 {earlier.length} 项 ·{" "}
              {[...counts]
                .map(([label, count]) => `${label} ${count}`)
                .join(" · ")}
            </span>
          </summary>
          <div className="tool-group-items">{earlier.map(renderTool)}</div>
        </details>
      )}
      <div className="tool-group-items">{recent.map(renderTool)}</div>
    </div>
  );
}
