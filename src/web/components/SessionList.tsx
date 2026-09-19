import { useEffect, useMemo, useState } from "react";
import type {
  ProjectEntry,
  SessionRef,
  SessionState,
  SessionSummary,
} from "../../shared/protocol";
import { ProviderLogo } from "./ProviderLogo";
import { RaccoLogo } from "./RaccoLogo";

type SessionListProps = {
  projects: ProjectEntry[];
  sessions: SessionSummary[];
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  activeRef?: SessionRef;
  loading: boolean;
  error?: string;
  onOpen: (session: SessionSummary) => void;
  onNew: (projectId?: string) => void;
  onImportProject?: () => void;
  onDeleteProject?: (projectId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
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

export function SessionList({
  projects,
  sessions,
  selectedProjectId,
  onSelectProject,
  activeRef,
  loading,
  error,
  onOpen,
  onNew,
  onImportProject,
  onDeleteProject,
  onDeleteSession,
}: SessionListProps) {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const current = grouped.get(session.projectId);
      if (current === undefined) grouped.set(session.projectId, [session]);
      else current.push(session);
    }
    return grouped;
  }, [sessions]);
  const activeProjectId = sessions.find(
    (session) => session.sessionId === activeRef?.sessionId,
  )?.projectId;

  useEffect(() => {
    if (activeProjectId === undefined) return;
    setCollapsedProjects((current) => {
      if (!current.has(activeProjectId)) return current;
      const next = new Set(current);
      next.delete(activeProjectId);
      return next;
    });
  }, [activeProjectId, activeRef?.sessionId]);

  function toggleProject(projectId: string) {
    onSelectProject(projectId);
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
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

      <nav className="project-tree" aria-label="项目与对话">
        {loading && <p className="sidebar-empty">正在读取项目…</p>}
        {error && <p className="sidebar-error">{error}</p>}
        {!loading && projects.length === 0 && (
          <p className="sidebar-empty">还没有项目</p>
        )}

        {projects.map((project) => {
          const projectSessions =
            sessionsByProject.get(project.projectId) ?? [];
          const expanded = !collapsedProjects.has(project.projectId);
          return (
            <section
              aria-label={`项目 ${project.name}`}
              className="project-tree-group"
              key={project.projectId}
            >
              <div className="project-tree-header-row">
                <button
                  aria-expanded={expanded}
                  className={`project-tree-header${selectedProjectId === project.projectId ? " selected" : ""}`}
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
                    {projectSessions.length}
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
                    aria-label={`在 ${project.name} 中新建对话`}
                    className="project-new-session-button"
                    disabled={!project.available}
                    onClick={() => onNew(project.projectId)}
                    title={project.available ? "新建对话" : "项目路径不可用"}
                    type="button"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  {onDeleteProject !== undefined && (
                    <button
                      aria-label={`删除项目 ${project.name}`}
                      className="row-delete-button"
                      onClick={() => {
                        const sessionCount = projectSessions.length;
                        if (
                          window.confirm(
                            sessionCount === 0
                              ? `删除项目 ${project.name}？`
                              : `删除项目 ${project.name} 及其 ${sessionCount} 个对话？`,
                          )
                        ) {
                          onDeleteProject(project.projectId);
                        }
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

              {expanded && (
                <div
                  aria-label={`${project.name} 的对话`}
                  className="project-session-list"
                  role="group"
                >
                  {projectSessions.length === 0 && (
                    <p className="project-tree-empty">暂无对话</p>
                  )}
                  {projectSessions.map((session) => (
                    <div className="history-row-wrap" key={session.sessionId}>
                      <button
                        aria-current={
                          isActive(activeRef, session) ? "page" : undefined
                        }
                        className={`history-row${
                          isActive(activeRef, session) ? " active" : ""
                        }`}
                        onClick={() => onOpen(session)}
                        title={session.title ?? session.sessionId}
                        type="button"
                      >
                        <span
                          className={`history-avatar history-avatar-${session.provider}`}
                        >
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
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </nav>
    </aside>
  );
}
