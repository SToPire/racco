import type {
  AgentTimelineEvent,
  TimelineEvent,
  ToolCompletionStatus,
} from "../../../shared/protocol.js";

/** Only calls awaiting a terminal event; completed/background launches are absent. */
export class CodexToolLifecycle {
  readonly #pending = new Map<string, Map<string, string>>();

  observe(
    threadId: string,
    turnId: string,
    events: readonly TimelineEvent[],
  ): void {
    for (const event of events) {
      if (event.type === "tool.started") {
        let pending = this.#pending.get(threadId);
        if (pending === undefined) {
          pending = new Map();
          this.#pending.set(threadId, pending);
        }
        pending.set(event.id, turnId);
      } else if (event.type === "tool.completed") {
        const pending = this.#pending.get(threadId);
        pending?.delete(event.id);
        if (pending?.size === 0) this.#pending.delete(threadId);
      }
    }
  }

  finish(
    threadId: string,
    status: Exclude<ToolCompletionStatus, "completed">,
    turnId?: string,
  ): AgentTimelineEvent[] {
    const pending = this.#pending.get(threadId);
    if (pending === undefined) return [];
    const events: AgentTimelineEvent[] = [];
    for (const [id, ownerTurnId] of pending) {
      if (turnId !== undefined && ownerTurnId !== turnId) continue;
      pending.delete(id);
      events.push({ type: "tool.completed", id, status });
    }
    if (pending.size === 0) this.#pending.delete(threadId);
    return events;
  }

  clear(): void {
    this.#pending.clear();
  }
}
