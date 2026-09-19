import { UiIcon } from "./UiIcon";
import { useState, type ReactNode } from "react";
import type { FileChange } from "../../shared/protocol";
import type { ToolTimelineRow } from "../store";
import { FileChanges } from "./FileChanges";

type ToolInspectorProps = {
  row: ToolTimelineRow;
  onClose: () => void;
};

type InspectorTab = "input" | "output" | "raw";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2) ?? "";
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return typeof value === "string" ? value : stringify(value);
}

function InspectorGroup({
  title,
  summary,
  open = false,
  children,
}: {
  title: string;
  summary?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="inspector-group" open={open || undefined}>
      <summary>
        <UiIcon name="chevron-right" />
        <span>{title}</span>
        {summary !== undefined && <small>{summary}</small>}
      </summary>
      <div className="inspector-group-content">{children}</div>
    </details>
  );
}

function PropertyList({
  entries,
}: {
  entries: Array<[label: string, value: unknown]>;
}) {
  return (
    <dl className="inspector-properties">
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={displayValue(value)}>{displayValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function CommandDetails({ row }: { row: ToolTimelineRow }) {
  const details = asRecord(row.details);
  if (details === undefined)
    throw new Error("Missing command execution details");
  const { command, cwd } = details;
  const actions = details.commandActions as unknown[];
  const duration =
    typeof details.durationMs === "number"
      ? `${details.durationMs} ms`
      : details.durationMs;
  const outputSummary =
    row.output.length === 0
      ? "empty"
      : `${row.output.split("\n").length} lines · ${row.output.length} chars`;
  const hasPlugin =
    (details.pluginId !== null && details.pluginId !== undefined) ||
    (details.scriptPath !== null && details.scriptPath !== undefined);

  return (
    <div className="inspector-groups">
      <InspectorGroup
        title="Execution"
        summary={displayValue(details.status)}
        open
      >
        <PropertyList
          entries={[
            ["Item ID", details.id],
            ["Item type", details.type],
            ["Status", details.status],
            ["Exit code", details.exitCode],
            ["Duration", duration],
            ["Source", details.source],
            ["Process ID", details.processId],
            ["Output", outputSummary],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup
        title="Command"
        summary={typeof cwd === "string" ? cwd : undefined}
        open
      >
        <pre>{stringify(command)}</pre>
        <div className="inspector-subfield">
          <span>Working directory</span>
          <code className="inspector-path">{displayValue(cwd)}</code>
        </div>
      </InspectorGroup>

      <InspectorGroup title="Actions" summary={`${actions.length}`}>
        {actions.length === 0 ? (
          <p className="inspector-empty">没有解析出的 command action</p>
        ) : (
          <div className="command-actions">
            {actions.map((action, index) => {
              const value = asRecord(action);
              return (
                <article key={index}>
                  <header>
                    <strong>{displayValue(value?.type)}</strong>
                    <span>#{index + 1}</span>
                  </header>
                  <pre>{stringify(action)}</pre>
                </article>
              );
            })}
          </div>
        )}
      </InspectorGroup>

      {hasPlugin && (
        <InspectorGroup title="Plugin">
          <PropertyList
            entries={[
              ["Plugin ID", details.pluginId],
              ["Script path", details.scriptPath],
            ]}
          />
        </InspectorGroup>
      )}
    </div>
  );
}

function InputPanel({ row }: { row: ToolTimelineRow }) {
  if (row.tool === "command") return <CommandDetails row={row} />;
  if (row.tool === "fileChange")
    return <FileChanges changes={row.input as FileChange[]} />;
  return <pre>{stringify(row.input)}</pre>;
}

export function ToolInspector({ row, onClose }: ToolInspectorProps) {
  const hasInput = row.input !== undefined;
  const hasOutput = row.output.length > 0 || row.tool === "command";
  const hasRaw = row.details !== undefined;
  const defaultTab: InspectorTab = hasInput ? "input" : "output";
  const [requestedTab, setRequestedTab] = useState<InspectorTab>(defaultTab);
  let activeTab =
    requestedTab === "input" && !hasInput
      ? "output"
      : requestedTab === "output" && !hasOutput
        ? "input"
        : requestedTab;
  if (activeTab === "raw" && !hasRaw) activeTab = hasInput ? "input" : "output";
  const inputLabel =
    row.tool === "command"
      ? "Details"
      : row.tool === "fileChange"
        ? "Changes"
        : "Input";

  return (
    <aside className="tool-inspector" aria-label="工具详情">
      <header className="inspector-header">
        <div>
          <small>Tool</small>
          <h2>{row.tool}</h2>
        </div>
        <span className={`tool-status tool-status-${row.status}`}>
          {row.status === "running"
            ? "运行中"
            : row.status === "completed"
              ? "已完成"
              : "失败"}
        </span>
        <button
          className="icon-button"
          aria-label="关闭工具详情"
          onClick={onClose}
          type="button"
        >
          <UiIcon name="close" />
        </button>
      </header>

      <div
        className="inspector-tabs view-tabs"
        role="tablist"
        aria-label="工具详情选项卡"
      >
        {hasInput && (
          <button
            aria-selected={activeTab === "input"}
            onClick={() => setRequestedTab("input")}
            role="tab"
            type="button"
          >
            {inputLabel}
          </button>
        )}
        {hasOutput && (
          <button
            aria-selected={activeTab === "output"}
            onClick={() => setRequestedTab("output")}
            role="tab"
            type="button"
          >
            Output
          </button>
        )}
        {hasRaw && (
          <button
            aria-selected={activeTab === "raw"}
            onClick={() => setRequestedTab("raw")}
            role="tab"
            type="button"
          >
            Raw
          </button>
        )}
      </div>

      <section className="inspector-content" role="tabpanel">
        {activeTab === "input" ? (
          <InputPanel row={row} />
        ) : activeTab === "raw" ? (
          <pre>{stringify(row.details)}</pre>
        ) : row.output.length > 0 ? (
          <pre>{row.output}</pre>
        ) : (
          <p className="inspector-empty">暂无输出</p>
        )}
      </section>
    </aside>
  );
}
