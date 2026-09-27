import type {
  AssistantPlanEvent,
  AssistantReasoningEvent,
  PlanUpdatedEvent,
} from "../shared/protocol";

export type AssistantActivityRow =
  AssistantReasoningEvent | AssistantPlanEvent | PlanUpdatedEvent;

export function isAssistantActivityVisible(row: AssistantActivityRow): boolean {
  if (row.type === "plan.updated" || row.partial) return true;
  return row.type === "assistant.reasoning"
    ? row.summary.some((part) => part.trim().length > 0)
    : row.text.trim().length > 0;
}
