import type { TimelineRow } from "../store";

type ToolCardProps = {
  row: Extract<TimelineRow, { type: "tool" }>;
  selected: boolean;
  onSelect: () => void;
};

export function ToolCard({ row, selected, onSelect }: ToolCardProps) {
  return (
    <button
      aria-pressed={selected}
      className={`tool-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <strong>{row.tool}</strong>
      <span className={`tool-status tool-status-${row.status}`}>
        {row.status === "running"
          ? "运行中"
          : row.status === "completed"
            ? "已完成"
            : "失败"}
      </span>
    </button>
  );
}
