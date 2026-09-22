import type { ToolTimelineRow } from "./store";
import { claudeToolResult } from "./claude-tool-result";
import { parseUnifiedDiff } from "../shared/file-diff";

type ToolPresentation = {
  label: string;
  summary: string;
  outcome?: string;
  preview?: string;
  progress?: string;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

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

function commandSummary(details: Record<string, unknown>): string | undefined {
  if (
    !Array.isArray(details.commandActions) ||
    details.commandActions.length === 0
  )
    return undefined;
  const actions = details.commandActions.map(record);
  if (
    actions.some(
      (action) => !["read", "search", "listFiles"].includes(text(action.type)),
    )
  )
    return undefined;
  const descriptions = actions.map((action) => {
    if (action.type === "read") return text(action.path) || text(action.name);
    if (action.type === "listFiles")
      return text(action.path) || text(action.command);
    return (
      [text(action.query), text(action.path)].filter(Boolean).join(" · ") ||
      text(action.command)
    );
  });
  const same = descriptions.every(
    (_, index) => actions[index]!.type === actions[0]!.type,
  );
  return same
    ? `${text(actions[0]!.type)} ${paths(descriptions)}`
    : paths(
        descriptions.map(
          (description, index) =>
            `${text(actions[index]!.type)} ${description}`,
        ),
      );
}

function fileChangeSummary(
  value: unknown,
): Pick<ToolPresentation, "summary" | "outcome"> {
  const changes = Array.isArray(value) ? value.map(record) : [];
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
  const input = record(row.input);
  const details = record(row.details);
  const description = text(input.description);
  let summary = description;
  let outcome: string | undefined;
  const nativeResult = claudeToolResult(row);
  if (row.tool === "command" || row.tool === "Bash") {
    const action = row.tool === "command" ? commandSummary(details) : undefined;
    summary = description || action || text(input.command) || text(row.input);
    const facts: string[] = [];
    if (typeof details.exitCode === "number")
      facts.push(`exit ${details.exitCode}`);
    if (typeof details.durationMs === "number")
      facts.push(`${(details.durationMs / 1000).toFixed(1)}s`);
    outcome = facts.length ? facts.join(" · ") : undefined;
  } else if (row.tool === "fileChange") {
    ({ summary, outcome } = fileChangeSummary(row.input));
  } else if (row.tool === "Read" || row.tool === "read_file") {
    summary = text(input.file_path) || text(input.path) || description;
  } else if (["Edit", "Write", "MultiEdit"].includes(row.tool)) {
    summary = text(input.file_path) || text(input.path) || description;
    if (nativeResult?.change) {
      ({ summary, outcome } = fileChangeSummary([nativeResult.change]));
    }
  } else if (row.tool === "Grep" || row.tool === "Glob") {
    summary =
      [text(input.pattern), text(input.path)].filter(Boolean).join(" · ") ||
      description;
  } else if (row.tool === "Agent" || row.tool === "Task") {
    summary = description || text(input.prompt);
  } else if (row.tool === "backgroundTask") {
    summary = description || text(input.taskId);
  } else if (row.tool === "WebSearch" || row.tool === "webSearch") {
    summary = text(input.query) || description;
  } else if (row.tool === "WebFetch") {
    summary = text(input.url) || description;
  } else if (row.tool === "Context injection") {
    summary = Array.isArray(input.fragments)
      ? `${input.fragments.length} 个片段`
      : "";
  }
  if (nativeResult?.backgroundTaskId)
    outcome = `后台任务 ${nativeResult.backgroundTaskId}`;
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
