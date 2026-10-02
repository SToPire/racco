import { ResponsivePanel } from "./ResponsivePanel";
import { UiIcon } from "./UiIcon";
import { useEffect, useMemo, useState } from "react";
import type { FileChange } from "../../shared/protocol";
import type { TimelineRow } from "../store";
import {
  buildTrajectory,
  type TrajectoryEntry,
  type TrajectoryKind,
} from "../trajectory";
import { FileChanges } from "./FileChanges";
import { MarkdownContent } from "./MarkdownContent";
import { FileReferenceScope } from "../FileNavigationContext";

type InspectorTab = "summary" | "payload" | "result" | "raw";
const inspectorLabels: Record<InspectorTab, string> = {
  summary: "概览",
  payload: "输入",
  result: "输出",
  raw: "原始数据",
};

function json(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

function kindLabel(kind: TrajectoryKind): string {
  if (kind === "user") return "用户";
  if (kind === "assistant") return "助手";
  if (kind === "context") return "上下文";
  if (kind === "tool") return "工具";
  if (kind === "subagent") return "Agent";
  return "系统";
}

function statusLabel(status: string | undefined): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "interrupted":
      return "已中断";
    default:
      return status ?? "—";
  }
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
    return <p className="trajectory-empty">暂无输出</p>;
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
  active = true,
  entry,
  onClose,
  onReveal,
}: {
  active?: boolean;
  entry: TrajectoryEntry;
  onClose: () => void;
  onReveal?: (entry: TrajectoryEntry) => void;
}) {
  const [tab, setTab] = useState<InspectorTab>("summary");
  const canReveal =
    entry.rowId !== undefined ||
    (entry.agentId !== undefined && entry.kind !== "assistant");
  const content = (
    <ResponsivePanel
      open={active}
      query="(max-width: 760px)"
      onClose={onClose}
      className={`trajectory-inspector${onReveal && canReveal ? " with-reveal" : ""}`}
      label="交互详情"
    >
      <header>
        <div>
          <span className={`trajectory-kind kind-${entry.kind}`}>
            {kindLabel(entry.kind)}
          </span>
          <small>
            {entry.turn === undefined ? "子任务" : `第 ${entry.turn} 轮`} · 步骤{" "}
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
      {onReveal && canReveal && (
        <button
          className="trajectory-reveal"
          type="button"
          onClick={() => onReveal(entry)}
        >
          在对话中查看
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
            {inspectorLabels[candidate]}
          </button>
        ))}
      </nav>
      <div className="trajectory-inspector-content">
        {tab === "summary" && (
          <>
            <dl>
              <div>
                <dt>执行者</dt>
                <dd>{entry.actor}</dd>
              </div>
              <div>
                <dt>类型</dt>
                <dd>{entry.label}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{statusLabel(entry.status)}</dd>
              </div>
              <div>
                <dt>层级</dt>
                <dd>{entry.agentPath ?? "Main Agent"}</dd>
              </div>
              <div>
                <dt>工作目录</dt>
                <dd>{entry.cwd ?? "—"}</dd>
              </div>
            </dl>
            <section>
              <h3>概览</h3>
              <p>{entry.summary || "—"}</p>
            </section>
          </>
        )}
        {tab === "payload" &&
          (entry.payload === undefined ? (
            <p className="trajectory-empty">暂无输入</p>
          ) : isFileChangePayload(entry.payload) ? (
            <FileChanges changes={entry.payload} />
          ) : (
            <pre>{json(entry.payload)}</pre>
          ))}
        {tab === "result" && <TrajectoryResult entry={entry} />}
        {tab === "raw" && <pre>{json(entry.raw)}</pre>}
      </div>
    </ResponsivePanel>
  );
  return entry.agentId === undefined ? (
    content
  ) : (
    <FileReferenceScope baseDirectory={entry.cwd}>{content}</FileReferenceScope>
  );
}

export function TrajectoryView({
  active = true,
  rows,
  onReveal,
  focusRowId,
}: {
  active?: boolean;
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
  useEffect(() => {
    if (!active) setSelectedId(undefined);
  }, [active]);
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
    entries.flatMap((entry) =>
      entry.agentId === undefined ? [] : [entry.agentId],
    ),
  ).size;

  return (
    <section
      className={`trajectory-view${selected === undefined ? "" : " detail-open"}`}
    >
      <header className="trajectory-toolbar">
        <div className="trajectory-metrics">
          <span>
            <UiIcon name="message" />
            {turns} 轮
          </span>
          <span>
            <UiIcon name="wrench" />
            {calls} 次调用
          </span>
          <span>
            <UiIcon name="agents" />
            {agents} 子 Agent
          </span>
        </div>
        <label className="trajectory-search">
          <span className="sr-only">搜索交互</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索交互"
            type="search"
            value={search}
          />
        </label>
      </header>

      <div className="trajectory-workspace">
        <div className="trajectory-entries" role="list">
          {visible.length === 0 && (
            <p className="trajectory-empty">暂无交互记录</p>
          )}
          {visible.map((entry, index) => {
            const showTurn =
              index === 0 ||
              visible[index - 1]?.turn !== entry.turn ||
              visible[index - 1]?.agentId !== entry.agentId;
            const turnLabel = showTurn
              ? entry.turn === undefined
                ? "子任务"
                : `第 ${entry.turn} 轮`
              : "";
            return (
              <div
                className="trajectory-entry-wrap"
                key={entry.id}
                role="listitem"
              >
                <small
                  className="trajectory-turn-label"
                  title={turnLabel || undefined}
                >
                  {turnLabel}
                </small>
                <button
                  aria-current={entry.id === selected?.id ? "true" : undefined}
                  className="trajectory-entry"
                  onClick={() => setSelectedId(entry.id)}
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
                    {entry.status === undefined
                      ? ""
                      : ` · ${statusLabel(entry.status)}`}
                  </small>
                </button>
              </div>
            );
          })}
        </div>
        {selected !== undefined && (
          <TrajectoryInspector
            active={active}
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
