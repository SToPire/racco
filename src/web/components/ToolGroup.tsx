import { UiIcon } from "./UiIcon";
import type { ToolTimelineRow } from "../store";
import { ToolCard } from "./ToolCard";

type ToolGroupProps = {
  rows: ToolTimelineRow[];
  selectedToolId?: string;
  onSelectTool: (id: string) => void;
};

function summaryText(rows: ToolTimelineRow[]): string {
  const count = rows.length;
  const commandsOnly = rows.every((row) => row.tool === "command");
  const running = rows.some((row) => row.status === "running");
  const failed = rows.filter((row) => row.status === "failed").length;
  const noun = commandsOnly
    ? count === 1
      ? "command"
      : "commands"
    : count === 1
      ? "tool call"
      : "tool calls";
  const label = `${running ? "Running" : "Ran"} ${count} ${noun}`;
  return failed === 0 ? label : `${label} · ${failed} failed`;
}

export function ToolGroup({
  rows,
  selectedToolId,
  onSelectTool,
}: ToolGroupProps) {
  return (
    <details className="tool-group">
      <summary>
        <UiIcon name="chevron-right" />
        <span>{summaryText(rows)}</span>
      </summary>
      <div className="tool-group-items">
        {rows.map((row) => (
          <ToolCard
            key={row.id}
            onSelect={() => onSelectTool(row.id)}
            row={row}
            selected={row.id === selectedToolId}
          />
        ))}
      </div>
    </details>
  );
}
