import type { FileChange } from "../shared/protocol";
import type { ToolTimelineRow } from "./store";

type ResultField = [label: string, value: string];

export type ClaudeToolResultView = {
  kind: "bash" | "edit" | "generic";
  missingStructuredResult: boolean;
  fields: ResultField[];
  attachments: Array<{ label: string; mediaType?: string }>;
  stdout?: string;
  stderr?: string;
  change?: FileChange;
  emptyPatch?: boolean;
  copyText: string;
  hasReadableResult: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function patchText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const patches: string[] = [];
  for (const item of value) {
    const hunk = record(item);
    if (
      hunk === undefined ||
      ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(
        (number) =>
          typeof number === "number" &&
          Number.isSafeInteger(number) &&
          number >= 0,
      ) ||
      !Array.isArray(hunk.lines) ||
      !hunk.lines.every((line) => typeof line === "string")
    )
      return undefined;
    patches.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
    );
  }
  return patches.join("\n");
}

/** Consume only the current native Claude result envelope, never output prose. */
export function claudeToolResult(
  row: ToolTimelineRow,
): ClaudeToolResultView | undefined {
  const details = record(row.details);
  if (details?.type !== "claudeToolResult") return undefined;
  const result = record(details.result);
  const view: ClaudeToolResultView = {
    kind: "generic",
    missingStructuredResult: !Object.hasOwn(details, "result"),
    fields: [],
    attachments: [],
    copyText: row.output,
    hasReadableResult: false,
  };
  const content = Array.isArray(details.content) ? details.content : [];
  for (const value of content) {
    const block = record(value);
    if (
      block === undefined ||
      typeof block.type !== "string" ||
      block.type === "text"
    )
      continue;
    const source = record(block.source);
    const label =
      typeof block.title === "string"
        ? block.title
        : block.type === "image"
          ? "图像附件"
          : block.type === "document"
            ? "文档附件"
            : `${block.type} 附件`;
    const mediaType =
      typeof source?.media_type === "string" ? source.media_type : undefined;
    view.attachments.push({
      label,
      ...(mediaType === undefined ? {} : { mediaType }),
    });
  }

  if (
    row.tool === "Bash" &&
    result !== undefined &&
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    typeof result.interrupted === "boolean"
  ) {
    view.kind = "bash";
    view.stdout = result.isImage === true ? "" : result.stdout;
    view.stderr = result.stderr;
    if (result.interrupted) view.fields.push(["执行状态", "已中断"]);
    if (
      typeof result.backgroundTaskId === "string" &&
      result.backgroundTaskId.length > 0
    ) {
      view.fields.push(["后台任务", result.backgroundTaskId]);
    }
    if (
      typeof result.timedOutAfterMs === "number" &&
      Number.isFinite(result.timedOutAfterMs)
    ) {
      view.fields.push(["超时后转入后台", `${result.timedOutAfterMs} ms`]);
    }
    for (const [label, key] of [
      ["完整输出文件", "persistedOutputPath"],
      ["原始输出文件", "rawOutputPath"],
    ] as const) {
      if (typeof result[key] === "string" && result[key].length > 0)
        view.fields.push([label, result[key]]);
    }
    if (
      typeof result.persistedOutputSize === "number" &&
      Number.isSafeInteger(result.persistedOutputSize) &&
      result.persistedOutputSize >= 0
    ) {
      view.fields.push(["完整输出大小", `${result.persistedOutputSize} bytes`]);
    }
    if (result.isImage === true && view.attachments.length === 0)
      view.attachments.push({ label: "图像输出" });
    view.copyText = [
      view.stderr && `stderr:\n${view.stderr}`,
      view.stdout && `stdout:\n${view.stdout}`,
      ...view.fields.map(([label, value]) => `${label}: ${value}`),
      ...view.attachments.map(
        ({ label, mediaType }) =>
          `${label}${mediaType ? ` (${mediaType})` : ""}`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (view.copyText.length === 0) view.copyText = row.output;
    view.hasReadableResult = true;
  }

  if (
    (row.tool === "Edit" || row.tool === "Write") &&
    result !== undefined &&
    typeof result.filePath === "string"
  ) {
    const diff = patchText(result.structuredPatch);
    if (
      diff !== undefined &&
      (row.tool === "Edit" ||
        result.type === "create" ||
        result.type === "update")
    ) {
      view.kind = "edit";
      view.change = {
        path: result.filePath,
        kind:
          row.tool === "Write" && result.type === "create"
            ? { type: "add" }
            : { type: "update", move_path: null },
        diff,
      };
      view.emptyPatch = diff.length === 0;
      view.copyText = diff || row.output;
      view.hasReadableResult = true;
    }
  }
  if (view.attachments.length > 0) view.hasReadableResult = true;
  return view;
}
