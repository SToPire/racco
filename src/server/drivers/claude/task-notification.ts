import type { SDKTaskNotificationMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeHistoryMessage } from "./event-mapper.js";

export type AgentTaskNotification = Pick<
  SDKTaskNotificationMessage,
  "task_id" | "tool_use_id" | "status" | "summary"
> & { uuid: string };

/** Read the native notification header, never task output or user-authored text. */
export function historicalTaskNotifications(
  entry: ClaudeHistoryMessage,
): AgentTaskNotification[] {
  const origin = entry.origin as
    { kind?: unknown; subkind?: unknown } | undefined;
  if (
    entry.type !== "user" ||
    origin?.kind !== "task-notification" ||
    origin.subkind !== undefined
  )
    return [];
  const content = (entry.message as { content?: unknown })?.content;
  const blocks =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block, index) => {
    if (block?.type !== "text" || typeof block.text !== "string") return [];
    // Result bodies may themselves contain tags. Only the anchored native
    // header can establish identity and status; the body stays opaque.
    const match =
      /^\s*<task-notification>\s*<task-id>([^<>\s]+)<\/task-id>\s*(?:<tool-use-id>([^<>\s]+)<\/tool-use-id>\s*)?<output-file>([^<>]*)<\/output-file>\s*<status>(completed|failed|stopped)<\/status>\s*<summary>([\s\S]*?)<\/summary>[\s\S]*<\/task-notification>\s*$/.exec(
        block.text,
      );
    if (!match) return [];
    return [
      {
        task_id: match[1]!,
        ...(match[2] === undefined ? {} : { tool_use_id: match[2] }),
        status: match[4] as SDKTaskNotificationMessage["status"],
        summary: match[5]!,
        uuid: `${entry.uuid}:task-notification:${index}`,
      },
    ];
  });
}
