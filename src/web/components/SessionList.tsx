import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectEntry,
  SessionRef,
  SessionState,
  SessionSummary,
  WorktreeEntry,
} from "../../shared/protocol";
import { ProviderLogo } from "./ProviderLogo";
import { RaccoLogo } from "./RaccoLogo";

type SessionListProps = {
  projects: ProjectEntry[];
  worktrees: WorktreeEntry[];
  worktreeErrors?: Record<string, string>;
  sessions: SessionSummary[];
  /** Worktrees are being re-read for this project, if any. */
  refreshingProjectId?: string;
  selectedWorktreePath: string;
  onSelectWorktree: (path: string) => void;
  activeRef?: SessionRef;
  loading: boolean;
  error?: string;
  onOpen: (session: SessionSummary) => void;
  /** Start a conversation in a worktree; omitted path means the primary one. */
  onNew: (worktree?: WorktreeEntry) => void;
  onImportProject?: () => void;
  onDeleteProject?: (projectId: string, removeWorktrees: boolean) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRefreshWorktrees?: (projectId: string) => void;
  onDeleteWorktree?: (worktree: WorktreeEntry) => void;
};

const SESSION_STATE_LABELS: Record<SessionState, string> = {
  idle: "空闲",
  running: "运行中",
  waiting_interaction: "等待操作",
  interrupted: "已中断",
  error: "错误",
};

function isActive(activeRef: SessionRef | undefined, session: SessionSummary) {
  return activeRef?.sessionId === session.sessionId;
}

/** Sessions whose cwd matches no derived worktree: the "gone worktree" group. */
const ORPHAN_GROUP = "\u0000orphans";

export function SessionList({
  projects,
  worktrees,
  worktreeErrors,
  sessions,
  refreshingProjectId,
  selectedWorktreePath,
  onSelectWorktree,
  activeRef,
  loading,
  error,
  onOpen,
  onNew,
  onImportProject,
  onDeleteProject,
  onDeleteSession,
  onRefreshWorktrees,
  onDeleteWorktree,
}: SessionListProps) {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(
    () => new Set(),
  );
  /** Project whose delete confirmation dialog is open, if any. */
  const [pendingDeleteProject, setPendingDeleteProject] =
    useState<ProjectEntry | null>(null);
  /** Whether the open delete dialog also removes worktree directories. */
  const [removeWorktreesChecked, setRemoveWorktreesChecked] = useState(false);
  const worktreesByProject = useMemo(() => {
    const grouped = new Map<string, WorktreeEntry[]>();
    for (const worktree of worktrees) {
      const current = grouped.get(worktree.projectId);
      if (current === undefined) grouped.set(worktree.projectId, [worktree]);
      else current.push(worktree);
    }
    return grouped;
  }, [worktrees]);
  /** Sessions keyed by worktree path, so a row is found by `cwd`. */
  const sessionsByPath = useMemo(() => {
    const grouped = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const current = grouped.get(session.cwd);
      if (current === undefined) grouped.set(session.cwd, [session]);
      else current.push(session);
    }
    return grouped;
  }, [sessions]);
  const activeSession = sessions.find(
    (session) => session.sessionId === activeRef?.sessionId,
  );
  const activeWorktreePath = activeSession?.cwd;
  const activeProjectId = activeSession?.projectId;

  useEffect(() => {
    if (activeProjectId === undefined) return;
    setCollapsedProjects((current) => {
      if (!current.has(activeProjectId)) return current;
      const next = new Set(current);
      next.delete(activeProjectId);
      return next;
    });
  }, [activeProjectId, activeRef?.sessionId]);

  useEffect(() => {
    if (activeWorktreePath === undefined) return;
    setCollapsedWorktrees((current) => {
      if (!current.has(activeWorktreePath)) return current;
      const next = new Set(current);
      next.delete(activeWorktreePath);
      return next;
    });
  }, [activeWorktreePath, activeRef?.sessionId]);

  function toggleProject(projectId: string) {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function toggleWorktree(path: string) {
    setCollapsedWorktrees((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderSession(session: SessionSummary) {
    return (
      <div className="history-row-wrap" key={session.sessionId}>
        <button
          aria-current={isActive(activeRef, session) ? "page" : undefined}
          className={`history-row${isActive(activeRef, session) ? " active" : ""}`}
          onClick={() => onOpen(session)}
          title={session.title ?? session.sessionId}
          type="button"
        >
          <span className={`history-avatar history-avatar-${session.provider}`}>
            <ProviderLogo provider={session.provider} />
          </span>
          <span className="history-copy">
            <strong>{session.title ?? session.sessionId}</strong>
            <small>
              {session.provider === "codex" ? "Codex" : "Claude"}
              {" · "}
              {session.compacting
                ? "压缩中"
                : SESSION_STATE_LABELS[session.state]}
            </small>
          </span>
          <span
            aria-label={
              session.compacting
                ? "压缩中"
                : SESSION_STATE_LABELS[session.state]
            }
            className={`state-dot state-dot-${session.compacting ? "running" : session.state}`}
          />
        </button>
        {onDeleteSession !== undefined && (
          <button
            aria-label={`删除对话 ${session.title ?? session.sessionId}`}
            className="row-delete-button"
            onClick={() => {
              if (
                window.confirm(
                  `删除对话「${session.title ?? session.sessionId}」？`,
                )
              ) {
                onDeleteSession(session.sessionId);
              }
            }}
            title="删除对话"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4.5 6.5h15M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <aside className="sidebar">
      <header className="project-sidebar-header">
        <RaccoLogo className="sidebar-logo" />
        <div className="project-sidebar-actions">
          {onImportProject !== undefined && (
            <button
              aria-label="导入项目"
              onClick={onImportProject}
              title="导入项目"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.5Z" />
                <path d="M15.5 11.5v5m-2.5-2.5h5" />
              </svg>
            </button>
          )}
          <button
            aria-label="新建对话"
            onClick={() => onNew()}
            title="新建对话"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </header>

      <nav className="project-tree" aria-label="项目、Worktree 与对话">
        {loading && <p className="sidebar-empty">正在读取项目…</p>}
        {error && <p className="sidebar-error">{error}</p>}
        {!loading && projects.length === 0 && (
          <p className="sidebar-empty">还没有项目</p>
        )}

        {projects.map((project) => {
          const projectWorktrees =
            worktreesByProject.get(project.projectId) ?? [];
          const primary = projectWorktrees.find(
            (entry) => entry.kind === "primary",
          );
          const expanded = !collapsedProjects.has(project.projectId);
          const projectSessionCount = projectWorktrees.reduce(
            (total, worktree) =>
              total + (sessionsByPath.get(worktree.path)?.length ?? 0),
            0,
          );
          const refreshing = refreshingProjectId === project.projectId;
          // Sessions whose cwd is not one of the derived worktrees. They are kept
          // visible as a read-only group rather than dropped: they are history
          // that cannot be regenerated, and the reason is usually that the
          // worktree was removed outside Racco.
          const known = new Set(projectWorktrees.map((entry) => entry.path));
          const orphans = sessions.filter(
            (session) =>
              session.projectId === project.projectId &&
              !known.has(session.cwd),
          );
          return (
            <section
              aria-label={`项目 ${project.name}`}
              className="project-tree-group"
              key={project.projectId}
            >
              <div className="project-tree-header-row">
                <button
                  aria-expanded={expanded}
                  className={`project-tree-header${
                    selectedWorktreePath === project.path ? " selected" : ""
                  }`}
                  onClick={() => toggleProject(project.projectId)}
                  title={project.path}
                  type="button"
                >
                  <svg
                    className="project-folder-icon"
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                  >
                    <path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.5Z" />
                  </svg>
                  <span
                    aria-label={project.available ? "项目可用" : "项目不可用"}
                    className={`project-availability${project.available ? " available" : ""}`}
                  />
                  <span className="project-tree-copy">
                    <strong>{project.name}</strong>
                    <small>{project.path}</small>
                  </span>
                  <small className="project-session-count">
                    {projectSessionCount}
                  </small>
                  <svg
                    className={`project-chevron${expanded ? " expanded" : ""}`}
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                  >
                    <path d="m9 7 5 5-5 5" />
                  </svg>
                </button>
                <div className="project-row-actions">
                  <button
                    aria-label={`在项目 ${project.name} 中新建对话`}
                    className="project-new-session-button"
                    disabled={!project.available || primary === undefined}
                    onClick={() => {
                      if (primary !== undefined) onNew(primary);
                    }}
                    title={project.available ? "新建对话" : "项目路径不可用"}
                    type="button"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  {onRefreshWorktrees !== undefined && (
                    <button
                      aria-label={`刷新 ${project.name} 的 Worktree 列表`}
                      className={`project-refresh-button${refreshing ? " spinning" : ""}`}
                      disabled={refreshing}
                      onClick={() => onRefreshWorktrees(project.projectId)}
                      title={
                        refreshing
                          ? "正在刷新 Worktree 列表"
                          : "刷新 Worktree 列表"
                      }
                      type="button"
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24">
                        <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4.5V10h-5.5" />
                      </svg>
                    </button>
                  )}
                  {onDeleteProject !== undefined && (
                    <button
                      aria-label={`删除项目 ${project.name}`}
                      className="row-delete-button"
                      onClick={() => {
                        setPendingDeleteProject(project);
                        setRemoveWorktreesChecked(false);
                      }}
                      title="删除项目"
                      type="button"
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24">
                        <path d="M4.5 6.5h15M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {worktreeErrors?.[project.projectId] && (
                <p className="sidebar-error" role="alert">
                  {worktreeErrors[project.projectId]}
                </p>
              )}
              {expanded && (
                <div
                  aria-label={`${project.name} 的 Worktree`}
                  className="project-worktree-list"
                  role="group"
                >
                  {projectWorktrees.length === 0 && (
                    <p className="project-tree-empty">暂无 Worktree</p>
                  )}
                  {projectWorktrees.map((worktree) => {
                    const worktreeSessions =
                      sessionsByPath.get(worktree.path) ?? [];
                    const worktreeCollapsed = collapsedWorktrees.has(
                      worktree.path,
                    );
                    const unavailable = !worktree.available;
                    return (
                      <div className="worktree-group" key={worktree.path}>
                        <div className="worktree-row-wrap">
                          <button
                            aria-expanded={!worktreeCollapsed}
                            className={`worktree-row${
                              selectedWorktreePath === worktree.path
                                ? " selected"
                                : ""
                            }${unavailable ? " unavailable" : ""}`}
                            onClick={() => {
                              onSelectWorktree(worktree.path);
                              toggleWorktree(worktree.path);
                            }}
                            title={worktree.path}
                            type="button"
                          >
                            <svg
                              className={`worktree-chevron${worktreeCollapsed ? "" : " expanded"}`}
                              aria-hidden="true"
                              viewBox="0 0 24 24"
                            >
                              <path d="m9 7 5 5-5 5" />
                            </svg>
                            <span
                              aria-label={
                                unavailable
                                  ? "Worktree 不可用"
                                  : "Worktree 可用"
                              }
                              className={`worktree-availability${unavailable ? "" : " available"}`}
                            />
                            <span className="worktree-copy">
                              <strong>{worktree.name}</strong>
                              <small>
                                {worktree.kind === "primary"
                                  ? "主工作区"
                                  : worktree.branch === null
                                    ? "detached"
                                    : worktree.branch}
                              </small>
                            </span>
                            {worktree.locked && (
                              <span
                                className="worktree-badge"
                                title="已被 git worktree lock 锁定"
                              >
                                锁定
                              </span>
                            )}
                            {worktree.prunable && (
                              <span
                                className="worktree-badge worktree-badge-warn"
                                title="目录已不存在，元数据仍在"
                              >
                                目录缺失
                              </span>
                            )}
                            <small className="project-session-count">
                              {worktreeSessions.length}
                            </small>
                          </button>
                          <div className="project-row-actions">
                            <button
                              aria-label={`在 ${worktree.name} 中新建对话`}
                              className="project-new-session-button"
                              disabled={unavailable || !project.available}
                              onClick={() => onNew(worktree)}
                              title={
                                unavailable ? "Worktree 目录不可用" : "新建对话"
                              }
                              type="button"
                            >
                              <svg aria-hidden="true" viewBox="0 0 24 24">
                                <path d="M12 5v14M5 12h14" />
                              </svg>
                            </button>
                            {onDeleteWorktree !== undefined &&
                              worktree.removable && (
                                <button
                                  aria-label={`删除 Worktree ${worktree.name}`}
                                  className="row-delete-button"
                                  onClick={() => onDeleteWorktree(worktree)}
                                  title="删除 Worktree"
                                  type="button"
                                >
                                  <svg aria-hidden="true" viewBox="0 0 24 24">
                                    <path d="M4.5 6.5h15M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
                                  </svg>
                                </button>
                              )}
                          </div>
                        </div>

                        {!worktreeCollapsed && (
                          <div
                            aria-label={`${worktree.name} 的对话`}
                            className="project-session-list"
                            role="group"
                          >
                            {worktreeSessions.length === 0 && (
                              <p className="project-tree-empty">暂无对话</p>
                            )}
                            {worktreeSessions.map(renderSession)}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {orphans.length > 0 && (
                    <div className="worktree-group" key={ORPHAN_GROUP}>
                      <div className="worktree-row-wrap">
                        <span
                          className="worktree-row worktree-row-static"
                          title="这些对话的工作目录已不在 Git 的 Worktree 列表中；点项目行的刷新按钮可重新读取。"
                        >
                          <span className="worktree-availability" />
                          <span className="worktree-copy">
                            <strong>已失效的 Worktree</strong>
                            <small>
                              {orphans.length} 个对话的目录已不在列表中
                            </small>
                          </span>
                        </span>
                      </div>
                      <div className="project-session-list" role="group">
                        {orphans.map(renderSession)}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </nav>
      {pendingDeleteProject !== null && onDeleteProject !== undefined && (
        <ConfirmDeleteProjectDialog
          project={pendingDeleteProject}
          worktrees={
            worktreesByProject.get(pendingDeleteProject.projectId) ?? []
          }
          sessionsByPath={sessionsByPath}
          removeWorktrees={removeWorktreesChecked}
          onChangeRemoveWorktrees={setRemoveWorktreesChecked}
          onCancel={() => setPendingDeleteProject(null)}
          onConfirm={(removeWorktrees) => {
            const projectId = pendingDeleteProject.projectId;
            setPendingDeleteProject(null);
            onDeleteProject(projectId, removeWorktrees);
          }}
        />
      )}
    </aside>
  );
}

export function ConfirmDeleteProjectDialog({
  project,
  worktrees,
  sessionsByPath,
  removeWorktrees,
  onChangeRemoveWorktrees,
  onCancel,
  onConfirm,
}: {
  project: ProjectEntry;
  worktrees: WorktreeEntry[];
  sessionsByPath: Map<string, SessionSummary[]>;
  removeWorktrees: boolean;
  onChangeRemoveWorktrees: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: (removeWorktrees: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);
  const linked = worktrees.filter((worktree) => worktree.kind === "linked");
  const dirty = linked.filter((worktree) => worktree.dirty);
  // Every conversation of the project is destroyed, including ones in the
  // project directory (primary worktree) and orphans whose cwd matches no
  // derived worktree. Count them all so the dialog does not understate.
  const sessionCount = [...sessionsByPath.values()].reduce(
    (total, sessions) =>
      total +
      sessions.filter((session) => session.projectId === project.projectId)
        .length,
    0,
  );
  return (
    <dialog
      aria-labelledby="confirm-delete-project-title"
      className="confirm-delete-dialog"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <h2 id="confirm-delete-project-title">删除项目 {project.name}？</h2>
      <p className="confirm-delete-dialog-copy">
        {linked.length === 0
          ? "该项目下没有链接的 Worktree。"
          : `该项目下有 ${linked.length} 个链接的 Worktree（目录与分支）：`}
      </p>
      {linked.length > 0 && (
        <ul className="confirm-delete-dialog-list">
          {linked.map((worktree) => (
            <li key={worktree.path}>
              <span className="confirm-delete-dialog-path">
                {worktree.path}
              </span>
              {worktree.dirty && (
                <span className="confirm-delete-dialog-badge">
                  有未提交的修改
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {linked.length > 0 && (
        <label className="confirm-delete-dialog-checkbox">
          <input
            checked={removeWorktrees}
            onChange={(event) => onChangeRemoveWorktrees(event.target.checked)}
            type="checkbox"
          />
          同时删除磁盘上的 Worktree 目录
          {dirty.length > 0 &&
            `（含 ${dirty.length} 个未提交目录，删除后将无法恢复）`}
        </label>
      )}
      {sessionCount > 0 && (
        <p className="confirm-delete-dialog-copy">
          同时删除 {sessionCount} 个对话。
        </p>
      )}
      <p className="confirm-delete-dialog-note">项目目录本身不会被删除。</p>
      <div className="confirm-delete-dialog-actions">
        <button
          className="confirm-delete-cancel-button"
          onClick={onCancel}
          type="button"
        >
          取消
        </button>
        <button
          autoFocus
          className="confirm-delete-confirm-button"
          onClick={() => onConfirm(removeWorktrees)}
          type="button"
        >
          删除项目
        </button>
      </div>
    </dialog>
  );
}
