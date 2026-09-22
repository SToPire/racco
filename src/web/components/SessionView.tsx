import { UiIcon } from "./UiIcon";
import { useEffect, useRef, useState } from "react";
import type {
  InteractionRequest,
  InteractionResponse,
  SessionSummary,
  ModelSettings,
} from "../../shared/protocol";
import type { SocketStatus } from "../socket";
import type {
  AgentTimelineRow,
  SubagentTimelineRow,
  TimelineRow,
} from "../store";
import { formatAgentPath, subagentName } from "../subagent-display";
import { AgentSwitcher } from "./AgentSwitcher";
import { Composer } from "./Composer";
import { ContextControls } from "./ContextControls";
import { InteractionCard } from "./InteractionCard";
import { ProviderLogo } from "./ProviderLogo";
import { Timeline } from "./Timeline";
import { TrajectoryView } from "./TrajectoryView";
import { TurnNavigator } from "./TurnNavigator";
import { useModelSelection } from "../hooks/useModelSelection";

type SessionViewProps = {
  session: SessionSummary;
  rows: TimelineRow[];
  interactions: InteractionRequest[];
  connection: SocketStatus;
  sending: boolean;
  error?: string;
  onBack: () => void;
  onSend: (text: string, modelSettings: ModelSettings) => Promise<boolean>;
  onSelectTool: (id: string | undefined) => void;
  onInterrupt: () => void;
  onCompact: () => Promise<boolean>;
  onResolve: (id: string, response: InteractionResponse) => void;
  selectedToolId?: string;
};

function activeSubagent(subagents: SubagentTimelineRow[]) {
  return subagents.findLast(
    (row) => row.state === "starting" || row.state === "running",
  );
}

export function SessionView({
  session,
  rows,
  interactions,
  connection,
  sending,
  error,
  onBack,
  onSend,
  onSelectTool,
  onInterrupt,
  onCompact,
  onResolve,
  selectedToolId,
}: SessionViewProps) {
  const selection = useModelSelection(
    session.provider,
    session.cwd,
    session.selectedModelSettings,
    false,
    connection === "open",
  );
  const conversationRef = useRef<HTMLElement>(null);
  const autoSelectedAgents = useRef(new Set<string>());
  const subagents = rows.filter(
    (row): row is SubagentTimelineRow => row.type === "subagent",
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(
    () => activeSubagent(subagents)?.agentId,
  );
  const [viewMode, setViewMode] = useState<"chat" | "trajectory">("chat");
  const selectedSubagent = subagents.find(
    (row) => row.agentId === selectedAgentId,
  );
  const mainRows = rows.filter(
    (row): row is AgentTimelineRow => row.type !== "subagent",
  );
  const selectedRows: AgentTimelineRow[] =
    selectedSubagent === undefined
      ? mainRows
      : [
          ...(selectedSubagent.prompt === undefined
            ? []
            : [
                {
                  type: "user.message" as const,
                  id: `subagent-task:${selectedSubagent.agentId}`,
                  text: selectedSubagent.prompt,
                },
              ]),
          ...selectedSubagent.timeline,
        ];
  const requests = rows.filter(
    (row): row is Extract<TimelineRow, { type: "user.message" }> =>
      row.type === "user.message",
  );

  useEffect(() => {
    autoSelectedAgents.current.clear();
    setSelectedAgentId(activeSubagent(subagents)?.agentId);
    setViewMode("chat");
  }, [session.sessionId]);

  useEffect(() => {
    const unseenActive = subagents.filter(
      (row) =>
        (row.state === "starting" || row.state === "running") &&
        !autoSelectedAgents.current.has(row.agentId),
    );
    const active = unseenActive.at(-1);
    if (active === undefined) return;
    for (const row of unseenActive) autoSelectedAgents.current.add(row.agentId);
    setSelectedAgentId(active.agentId);
    onSelectTool(undefined);
  }, [onSelectTool, subagents]);

  function selectAgent(agentId: string | undefined) {
    setSelectedAgentId(agentId);
    setViewMode("chat");
    onSelectTool(undefined);
  }

  function sendToMainAgent(text: string, modelSettings: ModelSettings) {
    setSelectedAgentId(undefined);
    return onSend(text, modelSettings);
  }

  return (
    <section className="session-view">
      <header className="pane-header session-header">
        <button
          aria-label="返回对话历史"
          className="mobile-back-button icon-button"
          onClick={onBack}
          type="button"
        >
          <UiIcon name="back" />
        </button>
        <div className="session-heading-copy">
          <div className="session-title-line">
            <h1>{session.title ?? session.sessionId}</h1>
            {session.provider === "codex" && subagents.length > 0 && (
              <>
                <span className="session-agent-separator">/</span>
                <AgentSwitcher
                  onSelect={selectAgent}
                  selectedAgentId={selectedSubagent?.agentId}
                  session={session}
                  subagents={subagents}
                />
              </>
            )}
            <span
              className={`provider-label provider-label-${session.provider}`}
            >
              {session.provider === "codex" ? "Codex" : "Claude"}
            </span>
          </div>
          <p title={selectedSubagent?.cwd ?? session.cwd}>
            {selectedSubagent === undefined
              ? session.cwd
              : `${formatAgentPath(selectedSubagent.agentPath) ?? subagentName(selectedSubagent)} · ${selectedSubagent.cwd ?? session.cwd}`}
          </p>
        </div>
        <div className="session-statuses">
          <span
            className={`run-state run-state-${session.compacting ? "running" : session.state}`}
          >
            {session.compacting
              ? "压缩中"
              : session.state === "running"
                ? "运行中"
                : session.state === "waiting_interaction"
                  ? "等待操作"
                  : session.state === "error"
                    ? "出错"
                    : session.state === "interrupted"
                      ? "已停止"
                      : "空闲"}
          </span>
          <span className={`connection-dot connection-${connection}`} />
        </div>
      </header>

      <nav className="session-view-tabs view-tabs" aria-label="会话视图">
        <div className="segmented-switch">
          <button
            aria-current={viewMode === "chat" ? "page" : undefined}
            onClick={() => setViewMode("chat")}
            type="button"
          >
            Chat
          </button>
          <button
            aria-current={viewMode === "trajectory" ? "page" : undefined}
            onClick={() => {
              setViewMode("trajectory");
              onSelectTool(undefined);
            }}
            type="button"
          >
            Trajectory
          </button>
        </div>
      </nav>

      {viewMode === "chat" ? (
        <section className="conversation" ref={conversationRef}>
          {error && <p className="error-banner">{error}</p>}
          {selectedRows.length === 0 ? (
            <div className="conversation-empty">
              <span
                className={`history-avatar history-avatar-${session.provider}`}
              >
                <ProviderLogo provider={session.provider} />
              </span>
              <p>等待第一条消息…</p>
            </div>
          ) : (
            <Timeline
              denseTools={selectedSubagent !== undefined}
              onSelectTool={onSelectTool}
              provider={session.provider}
              rows={selectedRows}
              selectedToolId={selectedToolId}
            />
          )}
        </section>
      ) : (
        <TrajectoryView rows={rows} />
      )}

      {viewMode === "chat" &&
        selectedSubagent === undefined &&
        requests.length > 1 && (
          <TurnNavigator
            requests={requests}
            scrollContainerRef={conversationRef}
          />
        )}

      {viewMode === "chat" && (
        <footer className="session-footer">
          <div className="composer-stack">
            {interactions.map((interaction) => (
              <InteractionCard
                interaction={interaction}
                key={interaction.id}
                onResolve={onResolve}
              />
            ))}
            {(session.state === "running" ||
              session.state === "waiting_interaction") && (
              <button
                className="stop-button"
                onClick={onInterrupt}
                type="button"
              >
                <span aria-hidden="true" />
                停止生成
              </button>
            )}
            <Composer
              compacting={session.compacting}
              contextControls={
                session.provider === "codex" ? (
                  <ContextControls
                    usage={session.contextUsage}
                    compacting={session.compacting}
                    disabled={
                      sending ||
                      session.compacting ||
                      connection !== "open" ||
                      session.lifecycle !== "active" ||
                      session.state === "running" ||
                      session.state === "waiting_interaction"
                    }
                    onCompact={onCompact}
                  />
                ) : undefined
              }
              selection={selection}
              disabled={
                session.compacting ||
                connection !== "open" ||
                session.lifecycle !== "active" ||
                session.state === "running" ||
                session.state === "waiting_interaction"
              }
              onSend={sendToMainAgent}
              sending={sending}
            />
            <small className="composer-hint">
              {selectedSubagent === undefined
                ? "Enter 发送 · Shift + Enter 换行"
                : "消息发送给 Main Agent · Enter 发送"}
            </small>
          </div>
        </footer>
      )}
    </section>
  );
}
