import { UiIcon } from "./UiIcon";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { FileChange } from "../../shared/protocol";
import type { ToolTimelineRow } from "../store";
import { FileChanges } from "./FileChanges";
import { toolStatusLabel } from "../tool-presentation";

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

      <InspectorGroup title="Execution" summary={displayValue(details.status)}>
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

function OutputPanel({
  row,
  following,
  onFollowingChange,
}: {
  row: ToolTimelineRow;
  following: boolean;
  onFollowingChange: (following: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyResult, setCopyResult] = useState<{
    output: string;
    message: string;
  }>();
  const command =
    row.tool === "command" ? asRecord(row.details)?.command : undefined;
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (following && scroll !== null) scroll.scrollTop = scroll.scrollHeight;
  }, [following, row.output]);

  async function copyOutput() {
    const output = row.output;
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
        <button
          className="inspector-follow-button"
          type="button"
          aria-pressed={following}
          onClick={() => onFollowingChange(!following)}
        >
          <UiIcon name="chevron-down" />
          跟随末尾
        </button>
        <span role="status">
          {copyResult?.output === row.output ? copyResult.message : ""}
        </span>
        <button
          className="icon-button"
          type="button"
          aria-label="复制输出"
          title="复制输出"
          disabled={row.output.length === 0}
          onClick={() => void copyOutput()}
        >
          <UiIcon name="copy" />
        </button>
      </div>
      <div
        className="inspector-output-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const scroll = event.currentTarget;
          if (
            following &&
            scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 24
          ) {
            onFollowingChange(false);
          }
        }}
      >
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
  const hasInput = row.input !== undefined;
  const hasRaw = row.details !== undefined;
  const hasOutput =
    row.output.length > 0 || row.tool === "command" || (!hasInput && !hasRaw);
  const defaultTab: InspectorTab =
    row.output.length > 0
      ? "output"
      : hasInput
        ? "input"
        : hasRaw
          ? "raw"
          : "output";
  const [requestedTab, setRequestedTab] = useState<InspectorTab>();
  const [following, setFollowing] = useState(row.status === "running");
  const selectedTab = requestedTab ?? defaultTab;
  let activeTab =
    selectedTab === "input" && !hasInput
      ? "output"
      : selectedTab === "output" && !hasOutput && hasInput
        ? "input"
        : selectedTab;
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
      >
        {hasInput && (
          <button
            id={`${id}-input`}
            aria-controls={`${id}-panel`}
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
            id={`${id}-output`}
            aria-controls={`${id}-panel`}
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
            id={`${id}-raw`}
            aria-controls={`${id}-panel`}
            aria-selected={activeTab === "raw"}
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
          <OutputPanel
            row={row}
            following={following}
            onFollowingChange={setFollowing}
          />
        )}
      </section>
    </aside>
  );
}
