import type { SessionState, SubagentState } from "../../shared/protocol";

/** The adjacent state label carries meaning independently of the dot's color. */
export function StateDot({ state }: { state: SessionState | SubagentState }) {
  return <span className={`state-dot state-${state}`} aria-hidden="true" />;
}
