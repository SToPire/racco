import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SessionSummary } from "../../shared/protocol";
import type { SubagentTimelineRow } from "../store";
import { sessionStateLabel } from "../session-presentation";
import { StateDot } from "./StateDot";
import {
  formatAgentPath,
  subagentName,
  subagentStateLabel,
} from "../subagent-display";

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
  const [focused, setFocused] = useState(() =>
    selected === undefined ? 0 : subagents.indexOf(selected) + 1,
  );
  const byId = new Map(subagents.map((row) => [row.agentId, row]));
  return (
    <div
      className="agent-switcher-menu"
      role="listbox"
      aria-label="切换 Agent"
      onKeyDown={(event) => {
        const options = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "[role=option]",
          ),
        );
        const index = options.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % options.length
            : event.key === "ArrowUp"
              ? (index + options.length - 1) % options.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          options[next]?.focus();
        }
      }}
    >
      <button
        tabIndex={focused === 0 ? 0 : -1}
        onFocus={() => setFocused(0)}
        aria-selected={selected === undefined}
        className={selected === undefined ? "selected" : ""}
        onClick={() => onSelect(undefined)}
        role="option"
        type="button"
      >
        <StateDot state={session.compacting ? "running" : session.state} />
        <span className="agent-option-copy">
          <strong>{session.title ?? "Main Agent"}</strong>
          <small>
            Main Agent · {sessionStateLabel(session.state, session.compacting)}
          </small>
        </span>
      </button>

      {subagents.map((row, index) => {
        const depth = subagentDepth(row, byId);
        const path = formatAgentPath(row.agentPath);
        const eventCount = row.timeline.length;
        return (
          <button
            tabIndex={focused === index + 1 ? 0 : -1}
            onFocus={() => setFocused(index + 1)}
            aria-selected={row.agentId === selected?.agentId}
            className={row.agentId === selected?.agentId ? "selected" : ""}
            key={row.agentId}
            onClick={() => onSelect(row.agentId)}
            role="option"
            style={{ "--agent-indent": `${9 + depth * 12}px` } as CSSProperties}
            type="button"
          >
            <StateDot state={row.state} />
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
  const stateLabel = selected
    ? subagentStateLabel(selected.state)
    : sessionStateLabel(session.state, session.compacting);

  useEffect(() => {
    if (!open) return;
    containerRef.current
      ?.querySelector<HTMLButtonElement>("[role=option][aria-selected=true]")
      ?.focus();
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        containerRef.current
          ?.querySelector<HTMLButtonElement>(".agent-switcher-trigger")
          ?.focus();
      }
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
    containerRef.current
      ?.querySelector<HTMLButtonElement>(".agent-switcher-trigger")
      ?.focus();
  }

  return (
    <div className="agent-switcher" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="agent-switcher-trigger"
        title={`${selected ? subagentName(selected) : "Main Agent"} · ${stateLabel}`}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <StateDot
          state={
            selected?.state ?? (session.compacting ? "running" : session.state)
          }
        />
        <strong>
          {selected === undefined ? "Main Agent" : subagentName(selected)}
        </strong>
        <span className="sr-only"> · {stateLabel}</span>
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
