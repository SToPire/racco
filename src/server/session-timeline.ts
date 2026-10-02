import type { TimelineEvent } from "../shared/protocol.js";

/** Keeps replayable content without retaining every cumulative stream prefix. */
export class SessionTimeline {
  readonly #events: TimelineEvent[] = [];
  readonly #contentSlots = new Map<string, { type: string; index: number }>();

  constructor(events: readonly TimelineEvent[] = []) {
    for (const event of events) this.append(event);
  }

  append(event: TimelineEvent): void {
    if (event.type === "subagent.started" || event.type === "subagent.state") {
      this.#events.push(event);
      return;
    }
    const content = event.type === "subagent.event" ? event.event : event;
    const key = JSON.stringify([
      event.type === "subagent.event" ? event.agentId : null,
      content.id,
    ]);
    const previous = this.#contentSlots.get(key);
    if (
      content.type === "assistant.message" ||
      content.type === "assistant.reasoning" ||
      content.type === "assistant.plan" ||
      content.type === "tool.output"
    ) {
      if (previous?.type === content.type) {
        // Keep the first position: replacing content does not move a UI row.
        this.#events[previous.index] = event;
        return;
      }
      this.#contentSlots.set(key, {
        type: content.type,
        index: this.#events.length,
      });
    } else if (
      content.type !== "tool.progress" ||
      previous?.type !== "tool.output"
    ) {
      // Starts/completions may replace tool output, and removals may recreate
      // a message later at a different position. Never compact across them.
      this.#contentSlots.delete(key);
    }
    this.#events.push(event);
  }

  snapshot(): TimelineEvent[] {
    return [...this.#events];
  }
}
