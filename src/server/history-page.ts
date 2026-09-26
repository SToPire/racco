import { z } from "zod";
import {
  HISTORY_PAGE_SIZE,
  type AgentTimelineEvent,
  type HistoryPage,
  type TimelineEvent,
} from "../shared/protocol.js";

export class HistoryCursorError extends Error {}

const Cursor = z.strictObject({
  sessionId: z.string(),
  agentId: z.string().nullable(),
  generation: z.string(),
  before: z.string(),
});

/** Scan on demand: no stored turn index or second copy of history. */
export function memoryHistoryPage(
  events: TimelineEvent[],
  sessionId: string,
  generation: string,
  agentId?: string,
  cursor?: string,
): HistoryPage {
  const timeline = events.flatMap((event) => {
    if (event.type === "subagent.event")
      return event.agentId === agentId ? [event.event] : [];
    if (event.type === "subagent.started" || event.type === "subagent.state")
      return [];
    return agentId === undefined ? [event] : [];
  });
  const first = new Map<string, number>();
  const starts: number[] = [];
  for (const [index, event] of timeline.entries()) {
    if (first.has(event.id)) continue;
    first.set(event.id, index);
    if (event.type === "user.message") starts.push(index);
  }
  let end = timeline.length;
  if (cursor !== undefined) {
    try {
      const parsed = Cursor.parse(
        JSON.parse(Buffer.from(cursor, "base64url").toString()),
      );
      if (
        parsed.sessionId !== sessionId ||
        parsed.agentId !== (agentId ?? null) ||
        parsed.generation !== generation
      )
        throw new Error("History changed");
      const index = first.get(parsed.before);
      if (index === undefined || !starts.includes(index))
        throw new Error("Unknown boundary");
      end = index;
    } catch {
      throw new HistoryCursorError("历史已更新，请重新加载对话");
    }
  }
  const earlier = starts.filter((index) => index < end);
  const start =
    earlier.length > HISTORY_PAGE_SIZE
      ? earlier[earlier.length - HISTORY_PAGE_SIZE]
      : 0;
  const selected = timeline.filter((event) => {
    const index = first.get(event.id)!;
    return index >= start && index < end;
  });
  const materialized = materializeEvents(selected);
  const pageEvents: TimelineEvent[] =
    agentId === undefined
      ? materialized
      : materialized.map((event) => ({
          type: "subagent.event",
          id: `${agentId}:${event.id}`,
          agentId,
          event,
        }));
  if (cursor === undefined)
    pageEvents.push(
      ...subagentSummaries(events).filter(
        (event) =>
          agentId === undefined ||
          ("agentId" in event && event.agentId === agentId),
      ),
    );
  return {
    events: pageEvents,
    nextCursor:
      start === 0
        ? null
        : Buffer.from(
            JSON.stringify({
              sessionId,
              agentId: agentId ?? null,
              generation,
              before: timeline[start].id,
            }),
          ).toString("base64url"),
  };
}

export function subagentSummaries(events: TimelineEvent[]): TimelineEvent[] {
  const summaries = new Map<string, TimelineEvent>();
  for (const event of events) {
    if (event.type !== "subagent.started" && event.type !== "subagent.state")
      continue;
    const key = `${event.type}:${event.agentId}`;
    summaries.set(key, { ...summaries.get(key), ...event } as TimelineEvent);
  }
  return [...summaries.values()];
}

/** Keep row order and the last value of each lifecycle event, not every streamed prefix. */
function materializeEvents(events: AgentTimelineEvent[]): AgentTimelineEvent[] {
  const rows = new Map<string, Map<string, AgentTimelineEvent>>();
  for (const event of events) {
    const row = rows.get(event.id) ?? new Map<string, AgentTimelineEvent>();
    if (
      event.type === "assistant.message" &&
      row.has("assistant.message.removed")
    )
      rows.delete(event.id);
    rows.set(event.id, row);
    if (event.type === "assistant.message.removed")
      row.delete("assistant.message");
    if (event.type === "assistant.message")
      row.delete("assistant.message.removed");
    let value = event;
    if (event.type === "tool.completed") {
      const previous = [...row.values()].reverse();
      const output = previous.find(
        (entry) =>
          (entry.type === "tool.output" || entry.type === "tool.completed") &&
          entry.output !== undefined,
      );
      const details = previous.find(
        (entry) =>
          entry.type === "tool.started" ||
          (entry.type === "tool.completed" && entry.details !== undefined),
      );
      value = {
        ...event,
        output:
          event.output ??
          (output && "output" in output ? output.output : undefined),
        details:
          event.details ??
          (details && "details" in details ? details.details : undefined),
      };
    }
    row.delete(event.type);
    row.set(event.type, value);
  }
  return [...rows.values()].flatMap((row) => [...row.values()]);
}
