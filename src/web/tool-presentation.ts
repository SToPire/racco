import type { ToolTimelineRow } from "./store";

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

function commandSummary(
  details: Record<string, unknown>,
): Pick<ToolPresentation, "label" | "summary"> | undefined {
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
    if (action.type === "read")
      return { label: "读取", summary: text(action.path) || text(action.name) };
    if (action.type === "listFiles")
      return {
        label: "列出文件",
        summary: text(action.path) || text(action.command),
      };
    return {
      label: "搜索",
      summary:
        [text(action.query), text(action.path)].filter(Boolean).join(" · ") ||
        text(action.command),
    };
  });
  const same = descriptions.every(
    (description) => description.label === descriptions[0]!.label,
  );
  return {
    label: same ? descriptions[0]!.label : "Bash",
    summary: paths(
      descriptions.map((description) =>
        same
          ? description.summary
          : `${description.label} ${description.summary}`,
      ),
    ),
  };
}

function fileChangeSummary(
  value: unknown,
): Pick<ToolPresentation, "summary" | "outcome"> {
  const changes = Array.isArray(value) ? value.map(record) : [];
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (typeof change.diff !== "string") continue;
    for (const line of change.diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
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
  let label = row.tool;
  let summary = description;
  let outcome: string | undefined;
  if (row.tool === "command" || row.tool === "Bash") {
    const action = row.tool === "command" ? commandSummary(details) : undefined;
    label = description ? "Bash" : (action?.label ?? "Bash");
    summary =
      description || action?.summary || text(input.command) || text(row.input);
    const facts: string[] = [];
    if (typeof details.exitCode === "number")
      facts.push(`exit ${details.exitCode}`);
    if (typeof details.durationMs === "number")
      facts.push(`${(details.durationMs / 1000).toFixed(1)}s`);
    outcome = facts.length ? facts.join(" · ") : undefined;
  } else if (row.tool === "fileChange") {
    label = "修改文件";
    ({ summary, outcome } = fileChangeSummary(row.input));
  } else if (row.tool === "Read" || row.tool === "read_file") {
    label = "读取";
    summary = text(input.file_path) || text(input.path) || description;
  } else if (["Edit", "Write", "MultiEdit"].includes(row.tool)) {
    label = row.tool === "Write" ? "写入" : "编辑";
    summary = text(input.file_path) || text(input.path) || description;
  } else if (row.tool === "Grep" || row.tool === "Glob") {
    label = row.tool === "Grep" ? "搜索" : "查找文件";
    summary =
      [text(input.pattern), text(input.path)].filter(Boolean).join(" · ") ||
      description;
  } else if (row.tool === "Agent" || row.tool === "Task") {
    label = "子任务";
    summary = description || text(input.prompt);
  } else if (row.tool === "WebSearch" || row.tool === "webSearch") {
    label = "搜索网页";
    summary = text(input.query) || description;
  } else if (row.tool === "WebFetch") {
    label = "读取网页";
    summary = text(input.url) || description;
  } else if (row.tool === "Context injection") {
    label = "补充上下文";
    summary = Array.isArray(input.fragments)
      ? `${input.fragments.length} 个片段`
      : "";
  }
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
    label,
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
