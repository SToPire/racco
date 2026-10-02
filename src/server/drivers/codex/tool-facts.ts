import type { ToolFacts } from "../../../shared/protocol.js";
import type { CodexThreadItem } from "./types.js";
import { mapFileChange } from "./file-change.js";

function paths(values: string[]): string {
  const unique = [...new Set(values.filter(Boolean))];
  return (
    unique.slice(0, 3).join("、") +
    (unique.length > 3 ? ` 等 ${unique.length} 项` : "")
  );
}

/** Native action classification is interpreted here, never in the browser. */
export function codexToolFacts(item: CodexThreadItem): ToolFacts {
  if (item.type === "commandExecution") {
    const actions = item.commandActions;
    let summary = item.command;
    if (
      actions.length > 0 &&
      actions.every((action) => action.type !== "unknown")
    ) {
      const descriptions = actions.map((action) => {
        if (action.type === "read") return action.path || action.name;
        if (action.type === "listFiles") return action.path || action.command;
        if (action.type === "search")
          return (
            [action.query, action.path].filter(Boolean).join(" · ") ||
            action.command
          );
        return "";
      });
      summary = actions.every((action) => action.type === actions[0]!.type)
        ? `${actions[0]!.type} ${paths(descriptions)}`
        : paths(
            descriptions.map(
              (description, index) => `${actions[index]!.type} ${description}`,
            ),
          );
    }
    return {
      summary,
      command: item.command,
      cwd: item.cwd,
      ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
      ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
    };
  }
  if (item.type === "fileChange")
    return { fileChanges: item.changes.map(mapFileChange) };
  if (item.type === "hookPrompt")
    return { summary: `${item.fragments.length} 个片段` };
  if (item.type === "webSearch") {
    const action = item.action;
    let summary = "";
    if (action?.type === "openPage") summary = action.url ?? "";
    if (action?.type === "findInPage")
      summary = [action.pattern, action.url].filter(Boolean).join(" · ");
    if (action?.type === "search")
      summary = action.queries?.join("、") || action.query || "";
    return { summary: summary || item.query || "网页操作" };
  }
  return {};
}
