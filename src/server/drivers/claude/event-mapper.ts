import type {
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AssistantMessageEvent,
  TimelineEvent,
} from "../../../shared/protocol.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageContent(message: unknown): unknown[] {
  const content = asRecord(message)?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content))
    throw new Error("Invalid Claude message content");
  return content;
}

function requiredIdentifier(
  block: Record<string, unknown>,
  key: string,
): string {
  const value = block[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid Claude tool field: ${key}`);
  }
  return value;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => asRecord(item))
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item?.text)
      .join("\n");
    if (text.length > 0) return text;
  }
  return JSON.stringify(value, null, 2) ?? "";
}

function mapAssistant(message: unknown, uuid: string): TimelineEvent[] {
  const content = messageContent(message);
  if (
    asRecord(message)?.model === "<synthetic>" &&
    content.length === 1 &&
    asRecord(content[0])?.type === "text" &&
    asRecord(content[0])?.text === "No response requested."
  )
    return [];
  return content.flatMap((value, index): TimelineEvent[] => {
    const block = asRecord(value);
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text.length === 0
        ? []
        : [
            {
              type: "assistant.message",
              id: `${uuid}:text:${index}`,
              text: block.text,
            },
          ];
    }
    if (block?.type === "tool_use") {
      return [
        {
          type: "tool.started",
          id: requiredIdentifier(block, "id"),
          tool: requiredIdentifier(block, "name"),
          input: block.input,
        },
      ];
    }
    return [];
  });
}

function mapToolResults(
  message: unknown,
  structuredResult?: unknown,
): TimelineEvent[] {
  return messageContent(message).flatMap((value): TimelineEvent[] => {
    const block = asRecord(value);
    if (block?.type !== "tool_result") return [];
    return [
      {
        type: "tool.completed",
        id: requiredIdentifier(block, "tool_use_id"),
        success: block.is_error !== true,
        output: stringify(block.content ?? structuredResult),
      },
    ];
  });
}

function mapUserText(message: unknown, uuid: string): TimelineEvent[] {
  const text = messageContent(message)
    .map((value) => asRecord(value))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block?.text)
    .join("\n");
  return text.length === 0 ? [] : [{ type: "user.message", id: uuid, text }];
}

export function mapClaudeHistory(messages: SessionMessage[]): TimelineEvent[] {
  return messages.flatMap((entry) => {
    if (entry.type === "assistant")
      return mapAssistant(entry.message, entry.uuid);
    if (entry.type === "user") {
      return [
        ...mapUserText(entry.message, entry.uuid),
        ...mapToolResults(entry.message),
      ];
    }
    return [];
  });
}

/** One mapper per query: stream state must not survive an interrupted turn. */
export class ClaudeLiveMapper {
  #stream?: {
    messageId: string;
    textBlock?: { index: number; id: string; text: string };
  };
  readonly #completedTextIds = new Map<string, string>();
  readonly #seenAssistants = new Set<string>();
  readonly #pendingText = new Map<string, string>();

  map(message: SDKMessage): TimelineEvent[] {
    if (message.type === "stream_event") {
      // The SDK forwards token deltas for the main session only.
      if (message.parent_tool_use_id !== null) return [];
      const event = message.event;
      if (event.type === "message_start") {
        const removed = this.#discardPendingText();
        this.#stream = { messageId: event.message.id };
        return removed;
      } else if (event.type === "message_stop") {
        this.#stream = undefined;
      } else if (event.type === "content_block_start") {
        if (this.#stream === undefined)
          throw new Error("Claude content block started without a message");
        this.#stream.textBlock =
          event.content_block.type === "text"
            ? {
                index: event.index,
                id: `${this.#stream.messageId}:text:${event.index}`,
                text: event.content_block.text,
              }
            : undefined;
        return this.#partialText();
      } else if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const block = this.#stream?.textBlock;
        if (block === undefined || block.index !== event.index)
          throw new Error("Claude text delta has no matching content block");
        if (event.delta.text.length === 0) return [];
        block.text += event.delta.text;
        return this.#partialText();
      } else if (
        event.type === "content_block_stop" &&
        this.#stream?.textBlock?.index === event.index
      ) {
        this.#stream.textBlock = undefined;
      }
      return [];
    }
    if (message.type === "assistant") {
      const events = mapAssistant(message.message, message.uuid);
      const replay = this.#seenAssistants.has(message.uuid);
      this.#seenAssistants.add(message.uuid);
      const mainResponse =
        !replay &&
        message.parent_tool_use_id === null &&
        message.message.model !== "<synthetic>" &&
        message.error === undefined;
      const removed: TimelineEvent[] = [];
      if (
        mainResponse &&
        this.#stream !== undefined &&
        message.message.id !== this.#stream.messageId
      ) {
        // A failed stream can fall back to a non-streaming API response. The
        // SDK does not emit message_stop or a reset for the abandoned attempt.
        removed.push(...this.#discardPendingText());
        this.#stream = undefined;
      }
      // The SDK emits each complete content block before content_block_stop.
      // Its envelope UUID differs from every stream event's UUID, and its
      // one-element content array does not retain the API's block index.
      const block = this.#stream?.textBlock;
      if (
        mainResponse &&
        block !== undefined &&
        message.message.id === this.#stream?.messageId
      ) {
        for (const event of events) {
          if (
            event.type === "assistant.message" &&
            !this.#completedTextIds.has(event.id)
          ) {
            this.#completedTextIds.set(event.id, block.id);
            this.#pendingText.delete(block.id);
          }
        }
      }
      return [
        ...removed,
        ...events.map((event) =>
          event.type === "assistant.message"
            ? {
                type: event.type,
                id: this.#completedTextIds.get(event.id) ?? event.id,
                text: event.text,
                ...(message.aborted
                  ? { stopReason: "interrupted" as const }
                  : {}),
              }
            : event,
        ),
      ];
    }
    if (message.type === "user") {
      return mapToolResults(message.message, message.tool_use_result);
    }
    return [];
  }

  finish(
    stopReason: NonNullable<AssistantMessageEvent["stopReason"]>,
  ): TimelineEvent[] {
    const events: TimelineEvent[] = [...this.#pendingText].map(
      ([id, text]) => ({
        type: "assistant.message",
        id,
        text,
        stopReason,
      }),
    );
    this.#pendingText.clear();
    this.#stream = undefined;
    return events;
  }

  #discardPendingText(): TimelineEvent[] {
    const events: TimelineEvent[] = [...this.#pendingText.keys()].map((id) => ({
      type: "assistant.message.removed",
      id,
    }));
    this.#pendingText.clear();
    return events;
  }

  #partialText(): TimelineEvent[] {
    const block = this.#stream?.textBlock;
    if (block === undefined || block.text.length === 0) return [];
    this.#pendingText.set(block.id, block.text);
    return [
      {
        type: "assistant.message",
        id: block.id,
        text: block.text,
        partial: true,
      },
    ];
  }
}
