import { useEffect, useId, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/protocol";
import type { SubagentTimelineRow } from "../store";
import { subagentName, subagentStateLabel } from "../subagent-display";
import { UiIcon } from "./UiIcon";

type AgentNode = { row: SubagentTimelineRow; children: AgentNode[] };

// Keep the centered 760px transcript clear of the 252px card, its 12px
// outer inset, and a 12px gap. Both sides of a centered column need that room.
const EXPANDED_CONTENT_WIDTH = 760 + 2 * (252 + 12 + 12);

// Streaming discovery may deliver children before their parents. Rebuild from
// current relationships, keeping disconnected nodes visible and cycles bounded.
export function agentForest(rows: SubagentTimelineRow[]): AgentNode[] {
  const byId = new Map(rows.map((row) => [row.agentId, row]));
  const children = new Map<string, SubagentTimelineRow[]>();
  for (const row of rows) {
    if (row.parentAgentId === undefined) continue;
    const siblings = children.get(row.parentAgentId) ?? [];
    siblings.push(row);
    children.set(row.parentAgentId, siblings);
  }
  const visited = new Set<string>();
  function visit(row: SubagentTimelineRow): AgentNode[] {
    if (visited.has(row.agentId)) return [];
    visited.add(row.agentId);
    return [
      { row, children: (children.get(row.agentId) ?? []).flatMap(visit) },
    ];
  }
  const roots = rows.filter(
    (row) => row.parentAgentId === undefined || !byId.has(row.parentAgentId),
  );
  return [...roots.flatMap(visit), ...rows.flatMap(visit)];
}

export function SubagentTopology({
  subagents,
  session,
  selectedAgentId,
  defaultExpanded,
  onSelect,
}: {
  subagents: SubagentTimelineRow[];
  session: SessionSummary;
  selectedAgentId?: string;
  defaultExpanded: boolean;
  onSelect: (agentId: string | undefined) => void;
}) {
  const container = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // Keep the menu in the tabs until the available width is known.
  const [compact, setCompact] = useState(true);
  const [expanded, setExpanded] = useState<boolean>();
  const open = expanded ?? (defaultExpanded && !compact);
  const contentId = useId();
  const forest = agentForest(subagents);
  const rooted = forest.filter((node) => node.row.parentAgentId === undefined);
  const disconnected = forest.filter(
    (node) => node.row.parentAgentId !== undefined,
  );
  useEffect(() => {
    const parent = container.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.borderBoxSize[0]?.inlineSize ?? parent.clientWidth;
      if (width > 0) setCompact(width < EXPANDED_CONTENT_WIDTH);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  function select(agentId: string | undefined) {
    onSelect(agentId);
    if (compact) {
      setExpanded(false);
      toggle.current?.focus();
    }
  }

  function renderNodes(nodes: AgentNode[]) {
    return (
      <ul className="subagent-branches">
        {nodes.map(({ row, children }) => {
          const name = subagentName(row);
          const preview = row.statusMessage?.trim() || undefined;
          return (
            <li key={row.agentId} data-agent-id={row.agentId}>
              <button
                className={`subagent-node state-${row.state}`}
                aria-current={
                  selectedAgentId === row.agentId ? "true" : undefined
                }
                onClick={() => select(row.agentId)}
                type="button"
                aria-label={`查看 ${name} 的对话`}
              >
                <span className="subagent-node-heading">
                  <strong>{name}</strong>
                  <span className="subagent-node-state">
                    <i className={`agent-status-dot state-${row.state}`} />
                    {subagentStateLabel(row.state)}
                  </span>
                </span>
                <span className="subagent-node-task">
                  {row.prompt?.trim() || row.role?.trim() || "未提供任务描述"}
                </span>
                {preview !== undefined ? (
                  <span className="subagent-node-preview">
                    <span>{row.state === "completed" ? "结果" : "进展"}</span>
                    <span>{preview}</span>
                  </span>
                ) : (
                  <span className="subagent-node-empty">
                    {row.state === "completed"
                      ? "已结束，暂无结果摘要"
                      : row.state === "unknown"
                        ? "未收到子任务终态"
                        : row.state === "error" || row.state === "interrupted"
                          ? "暂无结束说明"
                          : "等待进展更新"}
                  </span>
                )}
              </button>
              {children.length > 0 && renderNodes(children)}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <aside
      ref={container}
      className="subagent-topology"
      aria-label="子 Agent 拓扑"
      data-compact={compact}
      data-expanded={open}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setExpanded(false);
        toggle.current?.focus();
      }}
    >
      <button
        ref={toggle}
        className="subagent-topology-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setExpanded(!open)}
      >
        <UiIcon name="branch" />
        <strong>子 Agent</strong>
        <span>{subagents.length}</span>
        <UiIcon name={open ? "chevron-down" : "chevron-right"} />
      </button>
      <div className="subagent-topology-content" id={contentId} hidden={!open}>
        <button
          className="subagent-node subagent-root"
          aria-current={selectedAgentId === undefined ? "true" : undefined}
          aria-label="查看 Main Agent 的对话"
          type="button"
          onClick={() => select(undefined)}
        >
          <span className="subagent-node-heading">
            <strong>Main Agent</strong>
            <i className={`agent-status-dot state-${session.state}`} />
          </span>
        </button>
        {renderNodes(rooted)}
        {disconnected.length > 0 && (
          <div className="subagent-disconnected">
            <p>父级关系待确认</p>
            {renderNodes(disconnected)}
          </div>
        )}
      </div>
    </aside>
  );
}
