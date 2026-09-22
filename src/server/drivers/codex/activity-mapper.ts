import type {
  AgentTimelineEvent,
  AssistantMessageEvent,
  AssistantPlanEvent,
  AssistantReasoningEvent,
  PlanUpdatedEvent,
} from "../../../shared/protocol.js";
import type {
  CodexThreadItem,
  DeltaNotification,
  ItemNotification,
  JsonRpcNotification,
  ReasoningSummaryDeltaNotification,
  ReasoningSummaryPartNotification,
  TurnPlanNotification,
} from "./types.js";

type ContentSnapshot =
  | Omit<AssistantMessageEvent, "partial" | "stopReason">
  | Omit<AssistantPlanEvent, "partial" | "stopReason">
  | Omit<AssistantReasoningEvent, "partial" | "stopReason">;

type AssistantItem = Extract<
  CodexThreadItem,
  { type: "agentMessage" | "plan" | "reasoning" }
>;

export function isAssistantItem(item: CodexThreadItem): item is AssistantItem {
  return (
    item.type === "agentMessage" ||
    item.type === "plan" ||
    item.type === "reasoning"
  );
}

export function mapAssistantItem(item: AssistantItem): ContentSnapshot {
  if (item.type === "reasoning") {
    return {
      type: "assistant.reasoning",
      id: item.id,
      summary: [...item.summary],
    };
  }
  if (item.type === "plan") {
    return { type: "assistant.plan", id: item.id, text: item.text };
  }
  return {
    type: "assistant.message",
    id: item.id,
    text: item.text,
    phase: item.phase,
  };
}

/** Accumulates only displayable content. Raw reasoning never enters this state. */
export class CodexActivityMapper {
  // Snapshot items have no per-item streaming state. Keep their content available
  // for a later delta without treating already completed blocks as pending.
  readonly #baselines = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      generation: number;
      content: ContentSnapshot;
    }
  >();
  readonly #pending = new Map<
    string,
    { threadId: string; turnId: string; content: ContentSnapshot }
  >();
  readonly #plans = new Map<
    string,
    { turnId: string; event: PlanUpdatedEvent }
  >();

  seed(
    threadId: string,
    turnId: string,
    item: CodexThreadItem,
    generation: number,
  ): void {
    if (!isAssistantItem(item)) return;
    const key = `${threadId}:${item.id}`;
    if (
      this.#pending.has(key) ||
      (this.#baselines.get(key)?.generation ?? -1) > generation
    )
      return;
    this.#baselines.set(key, {
      threadId,
      turnId,
      generation,
      content: mapAssistantItem(item),
    });
  }

  hasContent(threadId: string, itemId: string): boolean {
    const key = `${threadId}:${itemId}`;
    return this.#pending.has(key) || this.#baselines.has(key);
  }

  hasPending(threadId: string, itemId: string): boolean {
    return this.#pending.has(`${threadId}:${itemId}`);
  }
  map(notification: JsonRpcNotification): AgentTimelineEvent[] | undefined {
    if (
      notification.method === "item/started" ||
      notification.method === "item/completed"
    ) {
      const { threadId, turnId, item } =
        notification.params as ItemNotification;
      if (!isAssistantItem(item)) return undefined;
      const key = `${threadId}:${item.id}`;
      const content = mapAssistantItem(item);
      this.#baselines.delete(key);
      if (notification.method === "item/completed") {
        this.#pending.delete(key);
        return [content];
      }
      this.#pending.set(key, { threadId, turnId, content });
      return [{ ...content, partial: true }];
    }

    if (notification.method === "turn/plan/updated") {
      const { threadId, turnId, explanation, plan } =
        notification.params as TurnPlanNotification;
      const event: PlanUpdatedEvent = {
        type: "plan.updated",
        id: `${turnId}:plan`,
        explanation,
        steps: plan.map((step) => ({ ...step })),
        state: "running",
      };
      this.#plans.set(threadId, { turnId, event });
      return [event];
    }

    if (notification.method === "item/reasoning/textDelta") return [];

    if (
      notification.method === "item/agentMessage/delta" ||
      notification.method === "item/plan/delta"
    ) {
      const delta = notification.params as DeltaNotification;
      const key = `${delta.threadId}:${delta.itemId}`;
      const type =
        notification.method === "item/agentMessage/delta"
          ? "assistant.message"
          : "assistant.plan";
      const previous = (this.#pending.get(key) ?? this.#baselines.get(key))
        ?.content;
      if (previous !== undefined && previous.type !== type) {
        throw new Error("Codex text delta does not match its item type");
      }
      const text =
        (previous !== undefined && "text" in previous ? previous.text : "") +
        delta.delta;
      const content: ContentSnapshot =
        type === "assistant.message"
          ? {
              type,
              id: delta.itemId,
              text,
              phase:
                previous?.type === "assistant.message" ? previous.phase : null,
            }
          : { type, id: delta.itemId, text };
      this.#baselines.delete(key);
      this.#pending.set(key, {
        threadId: delta.threadId,
        turnId: delta.turnId,
        content,
      });
      return [{ ...content, partial: true }];
    }

    if (
      notification.method === "item/reasoning/summaryTextDelta" ||
      notification.method === "item/reasoning/summaryPartAdded"
    ) {
      const delta = notification.params as
        ReasoningSummaryDeltaNotification | ReasoningSummaryPartNotification;
      if (!Number.isSafeInteger(delta.summaryIndex) || delta.summaryIndex < 0) {
        throw new Error("Invalid Codex reasoning summary index");
      }
      const key = `${delta.threadId}:${delta.itemId}`;
      const previous = (this.#pending.get(key) ?? this.#baselines.get(key))
        ?.content;
      if (previous !== undefined && previous.type !== "assistant.reasoning") {
        throw new Error("Codex reasoning delta does not match its item type");
      }
      const summary = previous ? [...previous.summary] : [];
      while (summary.length <= delta.summaryIndex) summary.push("");
      if ("delta" in delta) summary[delta.summaryIndex] += delta.delta;
      const content: ContentSnapshot = {
        type: "assistant.reasoning",
        id: delta.itemId,
        summary,
      };
      this.#baselines.delete(key);
      this.#pending.set(key, {
        threadId: delta.threadId,
        turnId: delta.turnId,
        content,
      });
      return [{ ...content, partial: true }];
    }
    return undefined;
  }

  finish(
    threadId: string,
    stopReason?: "interrupted" | "error",
    turnId?: string,
  ): AgentTimelineEvent[] {
    const events: AgentTimelineEvent[] = [];
    for (const [key, baseline] of this.#baselines) {
      if (
        baseline.threadId === threadId &&
        (turnId === undefined || baseline.turnId === turnId)
      ) {
        this.#baselines.delete(key);
      }
    }
    for (const [key, pending] of this.#pending) {
      if (
        pending.threadId !== threadId ||
        (turnId !== undefined && pending.turnId !== turnId)
      )
        continue;
      this.#pending.delete(key);
      events.push({
        ...pending.content,
        ...(stopReason === undefined ? {} : { stopReason }),
      });
    }
    const plan = this.#plans.get(threadId);
    if (
      plan !== undefined &&
      (turnId === undefined || plan.turnId === turnId)
    ) {
      this.#plans.delete(threadId);
      events.push({ ...plan.event, state: stopReason ?? "completed" });
    }
    return events;
  }

  clear(): void {
    this.#baselines.clear();
    this.#pending.clear();
    this.#plans.clear();
  }
}
