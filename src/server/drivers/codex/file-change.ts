import type { FileChange } from "../../../shared/protocol.js";
import type { CodexFileChange } from "./types.js";

/** Codex Add/Delete contain file text; the shared display contract is unified diff. */
export function mapFileChange(change: CodexFileChange): FileChange {
  if (change.kind.type === "update") return { ...change };
  if (change.kind.type !== "add" && change.kind.type !== "delete")
    throw new Error("Unsupported Codex file change kind");
  if (change.diff.length === 0) return { ...change };
  const lines = change.diff.split("\n");
  const trailingNewline = change.diff.endsWith("\n");
  if (trailingNewline) lines.pop();
  const added = change.kind.type === "add";
  const range = `1,${lines.length}`;
  const header = added ? `@@ -0,0 +${range} @@` : `@@ -${range} +0,0 @@`;
  const body = lines.map((line) => `${added ? "+" : "-"}${line}`).join("\n");
  return {
    ...change,
    diff: `${header}\n${body}${trailingNewline ? "\n" : "\n\\ No newline at end of file"}`,
  };
}
