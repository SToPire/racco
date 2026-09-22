import type { FileChange } from "../shared/protocol";
import type { ToolTimelineRow } from "./store";

type ClaudeToolFacts = {
  backgroundTaskId?: string;
  change?: FileChange;
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

/** Extract card facts from the current native result, never output prose. */
export function claudeToolResult(
  row: ToolTimelineRow,
): ClaudeToolFacts | undefined {
  const details = record(row.details);
  if (details?.type !== "claudeToolResult") return undefined;
  const result = record(details.result);
  const facts: ClaudeToolFacts = {};
  if (result === undefined) return facts;

  if (
    row.tool === "Bash" &&
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    typeof result.interrupted === "boolean" &&
    typeof result.backgroundTaskId === "string" &&
    result.backgroundTaskId.length > 0
  ) {
    facts.backgroundTaskId = result.backgroundTaskId;
  }

  if (
    (row.tool === "Edit" || row.tool === "Write") &&
    typeof result.filePath === "string"
  ) {
    const diff = patchText(result.structuredPatch);
    if (
      diff !== undefined &&
      (row.tool === "Edit" ||
        result.type === "create" ||
        result.type === "update")
    ) {
      facts.change = {
        path: result.filePath,
        kind:
          row.tool === "Write" && result.type === "create"
            ? { type: "add" }
            : { type: "update", move_path: null },
        diff,
      };
    }
  }
  return facts;
}
