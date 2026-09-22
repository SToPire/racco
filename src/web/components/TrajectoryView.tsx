import { UiIcon } from "./UiIcon";
import { useMemo, useState } from "react";
import type { FileChange } from "../../shared/protocol";
import type { TimelineRow } from "../store";
import {
  buildTrajectory,
  type TrajectoryEntry,
  type TrajectoryKind,
} from "../trajectory";
import { FileChanges } from "./FileChanges";
import { MarkdownContent } from "./MarkdownContent";

type InspectorTab = "summary" | "payload" | "result" | "raw";

function json(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

function kindLabel(kind: TrajectoryKind): string {
  if (kind === "user") return "USER";
  if (kind === "assistant") return "ASSISTANT";
  if (kind === "context") return "CONTEXT";
  if (kind === "tool") return "TOOL";
  if (kind === "subagent") return "AGENT";
  return "SYSTEM";
}

function isFileChangePayload(value: unknown): value is FileChange[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { path?: unknown }).path === "string" &&
        typeof (item as { diff?: unknown }).diff === "string" &&
        (item as { kind?: unknown }).kind !== undefined,
    )
  );
}

export function TrajectoryResult({ entry }: { entry: TrajectoryEntry }) {
  if (entry.result === undefined || entry.result === "") {
    return <p className="trajectory-empty">No result</p>;
  }
  if (typeof entry.result !== "string") return <pre>{json(entry.result)}</pre>;
  if (entry.kind === "tool" || entry.kind === "context") {
    return <pre>{entry.result}</pre>;
  }
  return (
    <div className="message-content">
      <MarkdownContent text={entry.result} />
    </div>
  );
}

export function TrajectoryInspector({
  entry,
  onClose,
  onReveal,
}: {
  entry: TrajectoryEntry;
  onClose: () => void;
  onReveal?: (entry: TrajectoryEntry) => void;
}) {
  const [tab, setTab] = useState<InspectorTab>("summary");
  return (
    <aside
      className={`trajectory-inspector${onReveal && (entry.rowId !== undefined || entry.agentId !== undefined) ? " with-reveal" : ""}`}
      aria-label="交互详情"
    >
      <header>
        <div>
          <span className={`trajectory-kind kind-${entry.kind}`}>
            {kindLabel(entry.kind)}
          </span>
          <small>
            {entry.turn === undefined ? "子任务" : `Turn ${entry.turn}`} · Step{" "}
            {entry.step}
          </small>
        </div>
        <button
          className="icon-button"
          aria-label="关闭交互详情"
          onClick={onClose}
          type="button"
        >
          <UiIcon name="close" />
        </button>
      </header>
      {onReveal &&
        (entry.rowId !== undefined || entry.agentId !== undefined) && (
          <button
            className="trajectory-reveal"
            type="button"
            onClick={() => onReveal(entry)}
          >
            在 Chat 中查看
          </button>
        )}
      <nav
        className="trajectory-inspector-tabs view-tabs"
        aria-label="交互详情选项卡"
      >
        {(["summary", "payload", "result", "raw"] as const).map((candidate) => (
          <button
            aria-current={tab === candidate ? "page" : undefined}
            key={candidate}
            onClick={() => setTab(candidate)}
            type="button"
          >
            {candidate[0]?.toUpperCase()}
            {candidate.slice(1)}
          </button>
        ))}
      </nav>
      <div className="trajectory-inspector-content">
        {tab === "summary" && (
          <>
            <dl>
              <div>
                <dt>Actor</dt>
                <dd>{entry.actor}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{entry.label}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{entry.status ?? "—"}</dd>
              </div>
              <div>
                <dt>Hierarchy</dt>
                <dd>{entry.agentPath ?? "Main Agent"}</dd>
              </div>
              <div>
                <dt>Working directory</dt>
                <dd>{entry.cwd ?? "—"}</dd>
              </div>
            </dl>
            <section>
              <h3>Summary</h3>
              <p>{entry.summary || "—"}</p>
            </section>
          </>
        )}
        {tab === "payload" &&
          (entry.payload === undefined ? (
            <p className="trajectory-empty">No payload</p>
          ) : isFileChangePayload(entry.payload) ? (
            <FileChanges changes={entry.payload} />
          ) : (
            <pre>{json(entry.payload)}</pre>
          ))}
        {tab === "result" && <TrajectoryResult entry={entry} />}
        {tab === "raw" && <pre>{json(entry.raw)}</pre>}
      </div>
    </aside>
  );
}

export function TrajectoryView({
  rows,
  onReveal,
  focusRowId,
}: {
  rows: TimelineRow[];
  onReveal?: (entry: TrajectoryEntry) => void;
  focusRowId?: string;
}) {
  const entries = useMemo(() => buildTrajectory(rows), [rows]);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () =>
      entries.find(
        (entry) => entry.rowId === focusRowId && focusRowId !== undefined,
      )?.id,
  );
  const [search, setSearch] = useState("");
  const selected = entries.find((entry) => entry.id === selectedId);
  const query = search.trim().toLowerCase();
  const visible =
    query.length === 0
      ? entries
      : entries.filter((entry) =>
          [entry.label, entry.summary, entry.actor, entry.agentPath ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(query),
        );
  const turns = new Set(
    entries.flatMap((entry) => (entry.turn === undefined ? [] : [entry.turn])),
  ).size;
  const calls = entries.filter(
    (entry) => entry.kind === "tool" || entry.kind === "context",
  ).length;
  const agents = new Set(
    entries
      .filter((entry) => entry.actor !== "Main Agent")
      .map((entry) => entry.actor),
  ).size;

  return (
    <section
      className={`trajectory-view${selected === undefined ? "" : " detail-open"}`}
    >
      <header className="trajectory-toolbar">
        <div className="trajectory-metrics">
          <span>
            <UiIcon name="message" />
            {turns} Turns
          </span>
          <span>
            <UiIcon name="terminal" />
            {calls} Calls
          </span>
          <span>
            <UiIcon name="agents" />
            {agents} Subagents
          </span>
        </div>
        <label className="trajectory-search">
          <span className="sr-only">搜索交互</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            type="search"
            value={search}
          />
        </label>
      </header>

      <div className="trajectory-workspace">
        <div className="trajectory-entries" role="list">
          {visible.length === 0 && (
            <p className="trajectory-empty">No interactions</p>
          )}
          {visible.map((entry, index) => {
            const showTurn =
              index === 0 ||
              visible[index - 1]?.turn !== entry.turn ||
              visible[index - 1]?.agentId !== entry.agentId;
            return (
              <div className="trajectory-entry-wrap" key={entry.id}>
                <small className="trajectory-turn-label">
                  {showTurn
                    ? entry.turn === undefined
                      ? "子任务"
                      : `Turn ${entry.turn}`
                    : ""}
                </small>
                <button
                  aria-current={entry.id === selected?.id ? "true" : undefined}
                  className="trajectory-entry"
                  onClick={() => setSelectedId(entry.id)}
                  role="listitem"
                  type="button"
                >
                  <span className={`trajectory-kind kind-${entry.kind}`}>
                    {kindLabel(entry.kind)}
                  </span>
                  <strong>{entry.label}</strong>
                  <span className="trajectory-entry-summary">
                    {entry.summary}
                  </span>
                  <small>
                    {entry.actor}
                    {entry.status === undefined ? "" : ` · ${entry.status}`}
                  </small>
                </button>
              </div>
            );
          })}
        </div>
        {selected !== undefined && (
          <TrajectoryInspector
            entry={selected}
            key={selected.id}
            onClose={() => setSelectedId(undefined)}
            onReveal={onReveal}
          />
        )}
      </div>
    </section>
  );
}
