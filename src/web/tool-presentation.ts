import type { ToolTimelineRow } from "./store";
import type { FileChange } from "../shared/protocol";
import { parseUnifiedDiff } from "../shared/file-diff";

type ToolPresentation = {
  label: string;
  summary: string;
  outcome?: string;
  preview?: string;
  progress?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function compact(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function paths(values: string[]): string {
  const unique = [...new Set(values.filter(Boolean))];
  return (
    unique.slice(0, 3).join("、") +
    (unique.length > 3 ? ` 等 ${unique.length} 项` : "")
  );
}

function fileChangeSummary(
  changes: FileChange[],
): Pick<ToolPresentation, "summary" | "outcome"> {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (typeof change.diff !== "string") continue;
    for (const line of parseUnifiedDiff(change.diff)) {
      if (line.kind === "added") added += 1;
      if (line.kind === "removed") removed += 1;
    }
  }
  return {
    summary: paths(changes.map((change) => text(change.path))),
    ...(added + removed > 0 ? { outcome: `+${added} −${removed}` } : {}),
  };
}

/** Describe recorded intent and execution facts without inferring task success. */
export function describeTool(row: ToolTimelineRow): ToolPresentation {
  const facts = row.facts;
  let summary = text(facts?.summary) || text(facts?.command);
  const result = [
    ...(facts?.exitCode === undefined ? [] : [`exit ${facts.exitCode}`]),
    ...(facts?.durationMs === undefined
      ? []
      : [`${(facts.durationMs / 1000).toFixed(1)}s`]),
  ];
  let outcome = result.length ? result.join(" · ") : undefined;
  if (facts?.fileChanges !== undefined)
    ({ summary, outcome } = fileChangeSummary(facts.fileChanges));
  if (facts?.backgroundTaskId) outcome = `后台任务 ${facts.backgroundTaskId}`;
  if (!summary && row.input !== undefined)
    summary = text(
      typeof row.input === "string" ? row.input : JSON.stringify(row.input),
    );
  const lines = row.output
    // Terminal previews omit ANSI color sequences; the inspector keeps raw output.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const preview =
    row.status === "failed"
      ? lines.slice(0, 2).join("\n")
      : row.status !== "completed"
        ? lines.slice(-2).join("\n")
        : "";
  const progress =
    row.progress === undefined
      ? undefined
      : [
          text(row.progress.description),
          `${row.status === "running" ? "已运行" : "最后进度"} ${row.progress.elapsedSeconds.toFixed(1)}s`,
        ]
          .filter(Boolean)
          .join(" · ");
  return {
    label: row.tool,
    summary: compact(summary),
    ...(outcome ? { outcome } : {}),
    ...(preview ? { preview: compact(preview, 280) } : {}),
    ...(progress ? { progress: compact(progress) } : {}),
  };
}

export function toolStatusLabel(status: ToolTimelineRow["status"]): string {
  const labels: Record<ToolTimelineRow["status"], string> = {
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    interrupted: "已中断",
    incomplete: "结果未知",
  };
  return labels[status];
}
