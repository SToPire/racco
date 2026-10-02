import type { SessionSummary } from "../../shared/protocol";
import type { SubagentTimelineRow } from "../store";

export function BackgroundAgentNotice({
  session,
  subagents,
}: {
  session: Pick<SessionSummary, "provider" | "state">;
  subagents: Pick<SubagentTimelineRow, "state">[];
}) {
  if (
    session.provider !== "codex" ||
    session.state === "running" ||
    session.state === "waiting_interaction" ||
    !subagents.some(
      (agent) => agent.state === "starting" || agent.state === "running",
    )
  )
    return null;
  return (
    <p className="background-agent-notice" role="note">
      主任务已结束，后台子 Agent
      仍在运行。这里只能查看进展，无法单独停止子任务；后续问题会被拒绝，无法在此回答。
    </p>
  );
}
