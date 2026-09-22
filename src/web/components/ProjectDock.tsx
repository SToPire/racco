import { useEffect, useRef, useState } from "react";
import type {
  ProjectEntry,
  Provider,
  SessionSummary,
  WorktreeEntry,
} from "../../shared/protocol";
import { UiIcon } from "./UiIcon";
import { FileIcon } from "./files/FileIcon";
import { ProjectFiles } from "./files/ProjectFiles";
import { ProjectSessions } from "./ProjectSessions";
import type { FileOpenRequest } from "../file-navigation";

export type DockPanel = "files" | "sessions";

type Props = {
  active?: DockPanel;
  width: number;
  projects: ProjectEntry[];
  /** All projects' worktrees, listed under each project in the selector. */
  worktrees: WorktreeEntry[];
  /** The selected worktree's path; the dock is rooted here, not at the project. */
  worktreePath: string;
  onWorktreeChange: (path: string) => void;
  fileRequest?: FileOpenRequest;
  onFileOpened: (requestId: number) => void;
  onToggle: (panel: DockPanel) => void;
  onResize: (width: number) => void;
  sessions: SessionSummary[];
  onImport: (
    provider: Provider,
    nativeId: string,
    path: string,
  ) => Promise<SessionSummary>;
  onDeleteNative: (
    provider: Provider,
    nativeId: string,
    path: string,
  ) => Promise<void>;
  onOpen: (session: SessionSummary) => void;
};

export function ProjectDock({
  active,
  width,
  projects,
  worktrees,
  worktreePath,
  onWorktreeChange,
  fileRequest,
  onFileOpened,
  onToggle,
  onResize,
  sessions,
  onImport,
  onDeleteNative,
  onOpen,
}: Props) {
  const open = active !== undefined;
  const label = active === "sessions" ? "会话" : "文件";
  const dock = useRef<HTMLElement>(null);
  const [maximumWidth, setMaximumWidth] = useState(360);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const filesLauncher = useRef<HTMLButtonElement>(null);
  const sessionsLauncher = useRef<HTMLButtonElement>(null);
  const worktreeSelector = useRef<HTMLSelectElement>(null);
  const previousPanel = useRef(active);
  useEffect(() => {
    if (previousPanel.current && !active)
      (previousPanel.current === "files"
        ? filesLauncher
        : sessionsLauncher
      ).current?.focus();
    else if (previousPanel.current !== active && active)
      worktreeSelector.current?.focus();
    previousPanel.current = active;
  }, [active]);
  useEffect(() => {
    const element = dock.current;
    const workspace = element?.parentElement?.querySelector(".workspace");
    if (!element || !workspace) return;
    const update = () => {
      const available =
        getComputedStyle(element).position === "fixed"
          ? window.innerWidth - 48
          : element.getBoundingClientRect().width +
            workspace.getBoundingClientRect().width -
            64;
      setMaximumWidth(Math.max(360, Math.floor(available)));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(workspace);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  const worktree = worktrees.find(
    (candidate) => candidate.path === worktreePath,
  );
  const resize = (next: number) =>
    onResize(Math.max(360, Math.min(next, maximumWidth)));
  const controls = (
    <div className="project-dock-controls">
      <select
        ref={worktreeSelector}
        aria-label={`${label}侧栏 Worktree`}
        value={worktree?.path ?? ""}
        onChange={(event) => onWorktreeChange(event.target.value)}
        title={worktree?.path}
      >
        <option value="" disabled>
          选择 Worktree
        </option>
        {projects.map((project) => {
          const projectWorktrees = worktrees.filter(
            (candidate) => candidate.projectId === project.projectId,
          );
          return (
            <optgroup key={project.projectId} label={project.name}>
              {projectWorktrees.length === 0 && (
                <option value="" disabled>
                  暂无 Worktree
                </option>
              )}
              {projectWorktrees.map((candidate) => (
                <option
                  key={candidate.path}
                  value={candidate.path}
                  disabled={!candidate.available}
                >
                  {projectWorktrees.length > 1 || projects.length > 1
                    ? `${project.name} · ${candidate.name}`
                    : candidate.name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      <button
        className="icon-button"
        aria-label={`折叠${label}侧栏`}
        aria-expanded={open}
        onClick={() => active && onToggle(active)}
        type="button"
        title={`折叠${label}侧栏`}
      >
        <UiIcon name="panel-close" />
      </button>
    </div>
  );
  return (
    <aside
      ref={dock}
      className={`project-dock${open ? " open" : ""}`}
      aria-label={`${label}侧栏`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          onToggle(active!);
        }
      }}
    >
      <div className="project-dock-content" hidden={!open}>
        <div
          className="project-dock-resizer"
          role="separator"
          aria-label={`调整${label}侧栏宽度`}
          aria-orientation="vertical"
          aria-valuemin={360}
          aria-valuemax={maximumWidth}
          aria-valuenow={Math.min(width, maximumWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = {
              x: event.clientX,
              width:
                event.currentTarget
                  .closest(".project-dock")
                  ?.getBoundingClientRect().width ?? width,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (drag.current)
              resize(drag.current.width + drag.current.x - event.clientX);
          }}
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onLostPointerCapture={() => {
            drag.current = undefined;
          }}
          onDoubleClick={() => resize(560)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const current =
                dock.current?.getBoundingClientRect().width ?? width;
              resize(current + (event.key === "ArrowLeft" ? 32 : -32));
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              resize(event.key === "Home" ? 360 : maximumWidth);
            }
          }}
        />
        <div
          className="project-dock-expanded"
          id="files-dock-panel"
          hidden={active !== "files"}
        >
          {worktree === undefined ? (
            <>
              <div className="file-dock-tabs-row">
                <span className="file-tab-files">
                  <FileIcon folder />
                  Files
                </span>
                {active === "files" && controls}
              </div>
              <div className="file-preview-empty">
                <FileIcon folder />
                <p>
                  {projects.length === 0
                    ? "导入项目后，即可浏览文件。"
                    : "请选择要浏览的 Worktree。"}
                </p>
              </div>
            </>
          ) : (
            <ProjectFiles
              key={worktree.path}
              worktree={worktree}
              enabled={active === "files"}
              controls={active === "files" ? controls : null}
              fileRequest={
                fileRequest?.worktreePath === worktree.path
                  ? fileRequest
                  : undefined
              }
              onFileOpened={onFileOpened}
            />
          )}
        </div>
        <div
          className="project-dock-expanded"
          id="sessions-dock-panel"
          hidden={active !== "sessions"}
        >
          {worktree ? (
            <ProjectSessions
              key={worktree.path}
              worktree={worktree}
              enabled={active === "sessions"}
              controls={active === "sessions" ? controls : null}
              sessions={sessions}
              onImport={onImport}
              onDeleteNative={onDeleteNative}
              onOpen={onOpen}
            />
          ) : (
            <>
              <header className="file-dock-tabs-row">
                <span className="dock-panel-title">
                  <UiIcon name="message" />
                  会话
                </span>
                {active === "sessions" && controls}
              </header>
              <div className="file-preview-empty">
                <UiIcon name="message" />
                <p>
                  {projects.length === 0
                    ? "导入项目后，即可浏览已有会话。"
                    : "请选择要浏览的 Worktree。"}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
      <nav className="project-dock-rail" aria-label="项目工具">
        <button
          className="project-dock-launcher"
          ref={filesLauncher}
          aria-controls="files-dock-panel"
          aria-label="展开文件侧栏"
          aria-expanded={active === "files"}
          onClick={() => onToggle("files")}
          type="button"
          title="项目文件"
        >
          <FileIcon folder />
        </button>
        <button
          className="project-dock-launcher"
          ref={sessionsLauncher}
          aria-controls="sessions-dock-panel"
          aria-label="展开会话侧栏"
          aria-expanded={active === "sessions"}
          onClick={() => onToggle("sessions")}
          type="button"
          title="项目会话"
        >
          <UiIcon name="message" />
        </button>
      </nav>
    </aside>
  );
}
