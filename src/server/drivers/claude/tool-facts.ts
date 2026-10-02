import type { ToolFacts } from "../../../shared/protocol.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function claudeToolInputFacts(tool: string, value: unknown): ToolFacts {
  const input = record(value);
  let summary = text(input.description);
  if (tool === "Bash")
    return {
      summary: summary || text(input.command),
      ...(typeof input.command === "string" ? { command: input.command } : {}),
    };
  if (["Read", "Edit", "Write", "MultiEdit"].includes(tool))
    summary = text(input.file_path) || summary;
  else if (tool === "Grep" || tool === "Glob")
    summary =
      [text(input.pattern), text(input.path)].filter(Boolean).join(" · ") ||
      summary;
  else if (tool === "Agent" || tool === "Task") summary ||= text(input.prompt);
  else if (tool === "WebSearch") summary = text(input.query) || summary;
  else if (tool === "WebFetch") summary = text(input.url) || summary;
  return summary ? { summary } : {};
}

function patchText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const patches: string[] = [];
  for (const item of value) {
    const hunk = record(item);
    if (
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

/** Extract only recognized structural facts, never infer them from output prose. */
export function claudeToolResultFacts(value: unknown): ToolFacts {
  const result = record(value);
  const facts: ToolFacts = {};
  if (
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    typeof result.interrupted === "boolean" &&
    typeof result.backgroundTaskId === "string" &&
    result.backgroundTaskId.length > 0
  )
    facts.backgroundTaskId = result.backgroundTaskId;
  if (typeof result.filePath === "string") {
    const diff = patchText(result.structuredPatch);
    // Edit carries no type; Write explicitly declares create/update.
    if (
      diff !== undefined &&
      (result.type === undefined ||
        result.type === "create" ||
        result.type === "update")
    )
      facts.fileChanges = [
        {
          path: result.filePath,
          kind:
            result.type === "create"
              ? { type: "add" }
              : { type: "update", move_path: null },
          diff,
        },
      ];
  }
  return facts;
}
