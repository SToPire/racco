import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SessionSummary } from "../../shared/protocol";
import type { SubagentTimelineRow } from "../store";
import {
  formatAgentPath,
  subagentName,
  subagentStateLabel,
} from "../subagent-display";

function sessionStateLabel(state: SessionSummary["state"]): string {
  if (state === "running") return "运行中";
  if (state === "waiting_interaction") return "等待操作";
  if (state === "interrupted") return "已中断";
  if (state === "error") return "失败";
  return "空闲";
}

function subagentDepth(
  row: SubagentTimelineRow,
  byId: Map<string, SubagentTimelineRow>,
): number {
  let depth = 1;
  let parentId = row.parentAgentId;
  const visited = new Set<string>([row.agentId]);
  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentAgentId;
  }
  return depth;
}

export function AgentSwitcherMenu({
  session,
  subagents,
  selectedAgentId,
  onSelect,
}: {
  session: SessionSummary;
  subagents: SubagentTimelineRow[];
  selectedAgentId?: string;
  onSelect: (agentId: string | undefined) => void;
}) {
  const selected = subagents.find((row) => row.agentId === selectedAgentId);
  const byId = new Map(subagents.map((row) => [row.agentId, row]));
  return (
    <div className="agent-switcher-menu" role="listbox" aria-label="切换 Agent">
      <button
        aria-selected={selected === undefined}
        className={selected === undefined ? "selected" : ""}
        onClick={() => onSelect(undefined)}
        role="option"
        type="button"
      >
        <span className={`agent-status-dot state-${session.state}`} />
        <span className="agent-option-copy">
          <strong>{session.title ?? "Main Agent"}</strong>
          <small>Main Agent · {sessionStateLabel(session.state)}</small>
        </span>
      </button>

      {subagents.map((row) => {
        const depth = subagentDepth(row, byId);
        const path = formatAgentPath(row.agentPath);
        const eventCount = row.timeline.length;
        return (
          <button
            aria-selected={row.agentId === selected?.agentId}
            className={row.agentId === selected?.agentId ? "selected" : ""}
            key={row.agentId}
            onClick={() => onSelect(row.agentId)}
            role="option"
            style={{ "--agent-indent": `${9 + depth * 12}px` } as CSSProperties}
            type="button"
          >
            <span className={`agent-status-dot state-${row.state}`} />
            <span className="agent-option-copy">
              <strong>{subagentName(row)}</strong>
              <small>
                {path ?? row.role ?? "Subagent"} ·{" "}
                {subagentStateLabel(row.state)} · {eventCount} events
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AgentSwitcher({
  session,
  subagents,
  selectedAgentId,
  onSelect,
}: {
  session: SessionSummary;
  subagents: SubagentTimelineRow[];
  selectedAgentId?: string;
  onSelect: (agentId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = subagents.find((row) => row.agentId === selectedAgentId);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function choose(agentId: string | undefined) {
    onSelect(agentId);
    setOpen(false);
  }

  return (
    <div className="agent-switcher" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="agent-switcher-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span
          className={`agent-status-dot state-${selected?.state ?? session.state}`}
        />
        <strong>
          {selected === undefined ? "Main Agent" : subagentName(selected)}
        </strong>
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="m8 10 4-4 4 4M8 14l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <AgentSwitcherMenu
          onSelect={choose}
          selectedAgentId={selected?.agentId}
          session={session}
          subagents={subagents}
        />
      )}
    </div>
  );
}
