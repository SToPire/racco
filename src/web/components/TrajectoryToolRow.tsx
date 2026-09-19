import type { ToolTimelineRow } from "../store";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compact(value: unknown): string {
  if (typeof value === "string") return value.replaceAll(/\s+/g, " ").trim();
  return JSON.stringify(value)?.replaceAll(/\s+/g, " ").trim() ?? "";
}

function summary(row: ToolTimelineRow): string {
  const input = asRecord(row.input);
  if (row.tool === "command") return compact(input?.command ?? row.input);
  if (row.tool === "Context injection") {
    const fragments = input?.fragments;
    return Array.isArray(fragments)
      ? `${fragments.length} context fragment${fragments.length === 1 ? "" : "s"}`
      : "Injected context";
  }
  if (row.tool === "fileChange") {
    return Array.isArray(row.input)
      ? `${row.input.length} file change${row.input.length === 1 ? "" : "s"}`
      : compact(row.input);
  }
  return compact(row.input);
}

function label(row: ToolTimelineRow): string {
  if (row.tool === "command") return "Bash";
  if (row.tool === "fileChange") return "Files";
  return row.tool;
}

export function TrajectoryToolRow({
  row,
  selected,
  onSelect,
}: {
  row: ToolTimelineRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const description = summary(row);
  return (
    <button
      aria-pressed={selected}
      className={`trajectory-tool-row${selected ? " selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="trajectory-tool-icon" aria-hidden="true">
        {row.tool === "command" ? ">_" : "▧"}
      </span>
      <strong>{label(row)}</strong>
      {description.length > 0 && <span>{description}</span>}
      <i
        className={`trajectory-tool-status status-${row.status}`}
        aria-hidden="true"
      />
    </button>
  );
}
