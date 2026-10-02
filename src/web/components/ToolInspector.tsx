import { ResponsivePanel } from "./ResponsivePanel";
import { UiIcon } from "./UiIcon";
import { useId, useState, type ReactNode } from "react";
import type { ToolTimelineRow } from "../store";
import { FileChanges } from "./FileChanges";
import { toolStatusLabel } from "../tool-presentation";

type ToolInspectorProps = {
  row: ToolTimelineRow;
  onClose: () => void;
};

type InspectorTab = "input" | "output" | "raw";

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
  const facts = row.facts;
  return (
    <div className="inspector-groups">
      <InspectorGroup title="Command" summary={facts?.cwd} open>
        <pre>{facts?.command}</pre>
        {facts?.cwd !== undefined && (
          <div className="inspector-subfield">
            <span>Working directory</span>
            <code className="inspector-path">{facts.cwd}</code>
          </div>
        )}
      </InspectorGroup>
      <InspectorGroup title="Execution" summary={toolStatusLabel(row.status)}>
        <PropertyList
          entries={[
            ["Status", toolStatusLabel(row.status)],
            ["Exit code", facts?.exitCode],
            [
              "Duration",
              facts?.durationMs === undefined
                ? undefined
                : `${facts.durationMs} ms`,
            ],
            ["Background task", facts?.backgroundTaskId],
          ]}
        />
      </InspectorGroup>
    </div>
  );
}

function InputPanel({ row }: { row: ToolTimelineRow }) {
  if (row.facts?.command !== undefined) return <CommandDetails row={row} />;
  if (row.facts?.fileChanges !== undefined)
    return <FileChanges changes={row.facts.fileChanges} />;
  return <pre>{stringify(row.input)}</pre>;
}

function OutputPanel({ row }: { row: ToolTimelineRow }) {
  const [copyResult, setCopyResult] = useState<{
    output: string;
    message: string;
  }>();
  const command = row.facts?.command;
  const copyText = row.output;

  async function copyOutput() {
    const output = copyText;
    try {
      await navigator.clipboard.writeText(output);
      setCopyResult({ output, message: "已复制" });
    } catch {
      setCopyResult({ output, message: "复制失败，请手动选择文本" });
    }
  }

  return (
    <div className="inspector-output-panel">
      <div className="inspector-output-toolbar">
        <span role="status">
          {copyResult?.output === copyText ? copyResult.message : ""}
        </span>
        <button
          className="icon-button"
          type="button"
          aria-label="复制输出"
          title="复制输出"
          disabled={copyText.length === 0}
          onClick={() => void copyOutput()}
        >
          <UiIcon name="copy" />
        </button>
      </div>
      <div className="inspector-output-scroll">
        {typeof command === "string" && (
          <div className="inspector-output-command">
            <small>Command</small>
            <code>{command}</code>
          </div>
        )}
        {row.output.length > 0 ? (
          <pre data-tool-output>{row.output}</pre>
        ) : (
          <p className="inspector-empty">
            {row.status === "running" ? "等待工具输出…" : "工具未返回文本输出"}
          </p>
        )}
      </div>
    </div>
  );
}

export function ToolInspector({ row, onClose }: ToolInspectorProps) {
  const id = useId();
  const hasInput =
    row.input !== undefined ||
    row.facts?.command !== undefined ||
    row.facts?.fileChanges !== undefined;
  const hasRaw = row.details !== undefined;
  const hasReadableOutput = row.output.length > 0;
  const hasOutput =
    hasReadableOutput ||
    row.facts?.command !== undefined ||
    (!hasInput && !hasRaw);
  const defaultTab: InspectorTab = hasReadableOutput
    ? "output"
    : hasInput
      ? "input"
      : hasRaw
        ? "raw"
        : "output";
  const [requestedTab, setRequestedTab] = useState<InspectorTab>();
  const selectedTab = requestedTab ?? defaultTab;
  let activeTab =
    selectedTab === "input" && !hasInput
      ? "output"
      : selectedTab === "output" && !hasOutput && hasInput
        ? "input"
        : selectedTab;
  if (activeTab === "raw" && !hasRaw) activeTab = hasInput ? "input" : "output";
  const inputLabel =
    row.facts?.command !== undefined
      ? "Details"
      : row.facts?.fileChanges !== undefined
        ? "Changes"
        : "Input";

  return (
    <ResponsivePanel
      className="tool-inspector"
      label="工具详情"
      query="(max-width: 1100px)"
      onClose={onClose}
    >
      <header className="inspector-header">
        <div>
          <small>Tool</small>
          <h2>{row.tool}</h2>
        </div>
        <span className={`tool-status tool-status-${row.status}`}>
          {toolStatusLabel(row.status)}
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
        onKeyDown={(event) => {
          const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "[role=tab]",
            ),
          );
          const index = tabs.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "ArrowRight"
              ? (index + 1) % tabs.length
              : event.key === "ArrowLeft"
                ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : undefined;
          if (next !== undefined) {
            event.preventDefault();
            tabs[next]?.focus();
            tabs[next]?.click();
          }
        }}
      >
        {hasInput && (
          <button
            id={`${id}-input`}
            aria-controls={`${id}-panel`}
            aria-selected={activeTab === "input"}
            tabIndex={activeTab === "input" ? 0 : -1}
            onClick={() => setRequestedTab("input")}
            role="tab"
            type="button"
          >
            {inputLabel}
          </button>
        )}
        {hasOutput && (
          <button
            id={`${id}-output`}
            aria-controls={`${id}-panel`}
            aria-selected={activeTab === "output"}
            tabIndex={activeTab === "output" ? 0 : -1}
            onClick={() => setRequestedTab("output")}
            role="tab"
            type="button"
          >
            Output
          </button>
        )}
        {hasRaw && (
          <button
            id={`${id}-raw`}
            aria-controls={`${id}-panel`}
            aria-selected={activeTab === "raw"}
            tabIndex={activeTab === "raw" ? 0 : -1}
            onClick={() => setRequestedTab("raw")}
            role="tab"
            type="button"
          >
            Raw
          </button>
        )}
      </div>

      <section
        className={`inspector-content${activeTab === "output" ? " inspector-content-output" : ""}`}
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${activeTab}`}
      >
        {activeTab === "input" ? (
          <InputPanel row={row} />
        ) : activeTab === "raw" ? (
          <pre>{stringify(row.details)}</pre>
        ) : (
          <OutputPanel row={row} />
        )}
      </section>
    </ResponsivePanel>
  );
}
