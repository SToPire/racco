import type { UserInput } from "../../shared/user-input";
import { UiIcon } from "./UiIcon";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
import { SubagentTopology } from "./SubagentTopology";
import { Timeline } from "./Timeline";
import { TrajectoryView } from "./TrajectoryView";
import { TurnNavigator } from "./TurnNavigator";
import { useModelSelection } from "../hooks/useModelSelection";
import { useConversationScroll } from "../hooks/useConversationScroll";
import type { TrajectoryEntry } from "../trajectory";
import { FileReferenceScope } from "../FileNavigationContext";
import { sessionStateLabel } from "../session-presentation";

type SessionViewProps = {
  active: boolean;
  loaded: boolean;
  session: SessionSummary;
  rows: TimelineRow[];
  interactions: InteractionRequest[];
  connection: SocketStatus;
  sending: boolean;
  error?: string;
  onBack: () => void;
  onSend: (
    content: UserInput,
    modelSettings: ModelSettings,
  ) => Promise<boolean>;
  onSelectTool: (id: string | undefined) => void;
  onInterrupt: () => void;
  onCompact: () => Promise<boolean>;
  onResolve: (id: string, response: InteractionResponse) => void;
  selectedToolId?: string;
};

export function SessionView({
  active,
  loaded,
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
  const subagents = useMemo(
    () =>
      rows.filter((row): row is SubagentTimelineRow => row.type === "subagent"),
    [rows],
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [viewMode, setViewMode] = useState<"chat" | "trajectory">("chat");
  const conversationRef = useRef<HTMLElement>(null);
  const [scrollbarGutter, setScrollbarGutter] = useState(0);
  const [trajectoryTargetId, setTrajectoryTargetId] = useState<string>();
  const revealTarget = useRef<string | undefined>(undefined);
  const reading = useConversationScroll(
    conversationRef,
    `${session.sessionId}:${selectedAgentId ?? "main"}`,
    active && loaded && viewMode === "chat",
  );
  const selectedSubagent = subagents.find(
    (row) => row.agentId === selectedAgentId,
  );
  const mainRows = useMemo(
    () =>
      rows.filter((row): row is AgentTimelineRow => row.type !== "subagent"),
    [rows],
  );
  const selectedRows: AgentTimelineRow[] = useMemo(
    () =>
      selectedSubagent === undefined
        ? mainRows
        : [
            ...(selectedSubagent.prompt === undefined ||
            selectedSubagent.timeline.find((row) => row.type === "user.message")
              ?.text === selectedSubagent.prompt
              ? []
              : [
                  {
                    type: "user.message" as const,
                    id: `subagent-task:${selectedSubagent.agentId}`,
                    text: selectedSubagent.prompt,
                    imageCount: 0,
                  },
                ]),
            ...selectedSubagent.timeline,
          ],
    [mainRows, selectedSubagent],
  );
  const requests = useMemo(
    () =>
      rows.filter(
        (row): row is Extract<TimelineRow, { type: "user.message" }> =>
          row.type === "user.message",
      ),
    [rows],
  );
  const turnActive =
    session.state === "running" || session.state === "waiting_interaction";
  const inputDisabled =
    !loaded || session.compacting || session.lifecycle !== "active";

  // Match the scroll container's two stable gutters without clipping footer menus.
  useLayoutEffect(() => {
    const element = conversationRef.current;
    if (!active || viewMode !== "chat" || !element) return;
    const measure = () =>
      setScrollbarGutter((element.offsetWidth - element.clientWidth) / 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, viewMode]);

  useEffect(() => {
    if (viewMode !== "chat" || revealTarget.current === undefined) return;
    const target = conversationRef.current?.querySelector<HTMLElement>(
      `[data-timeline-row="${CSS.escape(revealTarget.current)}"]`,
    );
    if (!target) return;
    reading.pauseFollowing();
    const history = target.closest<HTMLDetailsElement>("details.tool-history");
    if (history) history.open = true;
    target.scrollIntoView({ block: "center", behavior: "instant" });
    revealTarget.current = undefined;
  }, [viewMode, selectedAgentId, reading.pauseFollowing]);

  function revealInChat(entry: TrajectoryEntry) {
    setSelectedAgentId(entry.agentId);
    revealTarget.current = entry.rowId;
    onSelectTool(
      entry.kind === "tool" || entry.kind === "context"
        ? entry.rowId
        : undefined,
    );
    setViewMode("chat");
  }

  function selectAgent(agentId: string | undefined) {
    setSelectedAgentId(agentId);
    setViewMode("chat");
    onSelectTool(undefined);
  }

  function sendToMainAgent(content: UserInput, modelSettings: ModelSettings) {
    setSelectedAgentId(undefined);
    return onSend(content, modelSettings);
  }

  return (
    <section
      className="session-view"
      hidden={!active}
      data-session-id={session.sessionId}
      style={
        {
          "--conversation-scrollbar-gutter": `${viewMode === "chat" ? scrollbarGutter : 0}px`,
        } as CSSProperties
      }
    >
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
            {subagents.length > 0 && (
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
            className={`run-state state-${session.compacting ? "running" : session.state}`}
            role="status"
            aria-label="会话状态"
            aria-atomic="true"
          >
            {sessionStateLabel(session.state, session.compacting)}
          </span>
          <span
            className={`connection-status connection-${connection}`}
            role="status"
            aria-label="连接状态"
            aria-atomic="true"
          >
            <span className="connection-dot" aria-hidden="true" />
            <span
              className={
                connection === "open"
                  ? "connection-label sr-only"
                  : "connection-label"
              }
            >
              {connection === "open"
                ? "已连接"
                : connection === "connecting"
                  ? "连接中"
                  : "连接已断开"}
            </span>
          </span>
        </div>
      </header>

      <nav className="session-view-tabs view-tabs" aria-label="会话视图">
        <div className="segmented-switch">
          <button
            aria-current={viewMode === "chat" ? "page" : undefined}
            onClick={() => setViewMode("chat")}
            type="button"
          >
            对话
          </button>
          <button
            aria-current={viewMode === "trajectory" ? "page" : undefined}
            onClick={() => {
              setTrajectoryTargetId(selectedToolId);
              setViewMode("trajectory");
              onSelectTool(undefined);
            }}
            type="button"
          >
            执行轨迹
          </button>
        </div>
      </nav>

      <div className="session-content">
        {subagents.length > 0 && (
          <SubagentTopology
            subagents={subagents}
            session={session}
            selectedAgentId={selectedSubagent?.agentId}
            defaultExpanded={viewMode === "chat"}
            onSelect={selectAgent}
          />
        )}
        {viewMode === "chat" ? (
          <section
            className="conversation"
            ref={conversationRef}
            aria-busy={!loaded}
          >
            {error && <p className="error-banner">{error}</p>}
            {selectedRows.length === 0 ? (
              <div className="conversation-empty">
                <span
                  className={`history-avatar history-avatar-${session.provider}`}
                >
                  <ProviderLogo provider={session.provider} />
                </span>
                <p>{loaded ? "等待第一条消息…" : "正在读取对话…"}</p>
              </div>
            ) : (
              <FileReferenceScope
                baseDirectory={
                  selectedSubagent === undefined
                    ? session.cwd
                    : selectedSubagent.cwd
                }
              >
                <Timeline
                  sessionId={session.sessionId}
                  denseTools={selectedSubagent !== undefined}
                  onSelectTool={onSelectTool}
                  provider={session.provider}
                  rows={selectedRows}
                  selectedToolId={selectedToolId}
                />
              </FileReferenceScope>
            )}
          </section>
        ) : (
          <TrajectoryView
            active={active}
            rows={rows}
            focusRowId={trajectoryTargetId}
            onReveal={revealInChat}
          />
        )}
        {viewMode === "chat" && !reading.following && (
          <button
            className="conversation-follow-latest"
            type="button"
            onClick={reading.followLatest}
          >
            回到最新内容 ↓
          </button>
        )}
        {viewMode === "chat" &&
          active &&
          selectedSubagent === undefined &&
          requests.length > 1 && (
            <TurnNavigator
              sessionId={session.sessionId}
              requests={requests}
              scrollContainerRef={conversationRef}
            />
          )}
      </div>

      <footer
        className={`session-footer${viewMode === "trajectory" ? " session-footer-trajectory" : ""}`}
      >
        <div className="composer-stack">
          {viewMode === "trajectory" && error && (
            <p className="error-banner">{error}</p>
          )}
          {interactions.length > 0 && (
            <div className="session-interactions">
              {interactions.map((interaction) => (
                <InteractionCard
                  interaction={interaction}
                  key={interaction.id}
                  onResolve={onResolve}
                />
              ))}
            </div>
          )}
          {turnActive && (
            <button className="stop-button" onClick={onInterrupt} type="button">
              <span aria-hidden="true" />
              停止生成
            </button>
          )}
          <Composer
            scope={`session:${session.sessionId}`}
            compacting={session.compacting}
            contextControls={
              session.provider === "codex" ? (
                <ContextControls
                  usage={session.contextUsage}
                  compacting={session.compacting}
                  disabled={
                    sending ||
                    inputDisabled ||
                    turnActive ||
                    connection !== "open"
                  }
                  onCompact={onCompact}
                />
              ) : undefined
            }
            selection={selection}
            inputDisabled={inputDisabled}
            sendDisabled={inputDisabled || turnActive || connection !== "open"}
            onSend={sendToMainAgent}
            sending={sending}
          />
          <details className="session-send-target">
            <summary>
              发送目标：{session.provider === "codex" ? "Codex" : "Claude"} ·{" "}
              {session.cwd.split("/").filter(Boolean).at(-1)}
            </summary>
            <p aria-label="执行目录">{session.cwd}</p>
          </details>
          <small className="composer-hint">
            {connection !== "open"
              ? "连接未就绪，可继续编辑草稿；恢复后请手动发送"
              : turnActive && !inputDisabled && !sending
                ? selectedSubagent === undefined
                  ? "可先写草稿 · 当前任务结束后才能发送"
                  : "可先写草稿 · 当前任务结束后发送给 Main Agent"
                : selectedSubagent === undefined
                  ? "Enter 发送 · Shift + Enter 换行"
                  : "消息发送给 Main Agent · Enter 发送"}
          </small>
        </div>
      </footer>
    </section>
  );
}
