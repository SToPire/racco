import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { WorktreeEntry } from "../shared/protocol";
import { DirectoryBrowser } from "./components/DirectoryBrowser";
import { NewSessionView } from "./components/NewSessionView";
import { ProjectDock, type DockPanel } from "./components/ProjectDock";
import { SessionList } from "./components/SessionList";
import { SessionView } from "./components/SessionView";
import { ToolInspector } from "./components/ToolInspector";
import {
  FileNavigationContext,
  FileReferenceScope,
} from "./FileNavigationContext";
import type { FileOpenRequest, ProjectFileLocation } from "./file-navigation";
import { useProjectPicker } from "./hooks/useProjectPicker";
import { useRacco } from "./hooks/useRacco";
import { useWorkspaceNavigation } from "./hooks/useWorkspaceNavigation";
import { findTimelineTool } from "./store";

export function App() {
  const navigation = useWorkspaceNavigation();
  const {
    activeRef,
    historyOpen,
    newSessionProjectId,
    setNewSessionProjectId,
  } = navigation;
  const racco = useRacco({
    activeRef,
    onOpen: navigation.openSession,
    onHome: navigation.showHistory,
  });
  const {
    session,
    sessions,
    projects,
    worktrees,
    worktreeErrors,
    health,
    loading,
    homeError,
    sessionError,
    connection,
    sending,
    creating,
    rows,
    sessionViews,
    openSession,
    showHistory,
    deleteNativeSession,
    deleteProject,
    deleteSession,
    deleteWorktree,
    refreshProjectWorktrees,
    createWorktree,
    createSession,
    sendTurn,
    compactSession,
    interruptTurn,
    resolveInteraction,
  } = racco;
  const {
    directoryPicker,
    setDirectoryPicker,
    openProjectPicker,
    importSelectedDirectory,
  } = useProjectPicker(
    projects,
    newSessionProjectId,
    selectNewSessionProject,
    racco.addProject,
  );
  const [selectedToolId, setSelectedToolId] = useState<string>();
  const [dockPanel, setDockPanel] = useState<DockPanel>();
  const [dockWidth, setDockWidth] = useState(560);
  /** The worktree selected in the tree and mirrored by the dock. */
  const [selectedWorktreePath, setSelectedWorktreePath] = useState("");
  /** Worktree chosen in the new-session view; empty means the primary one. */
  const [newSessionWorktreePath, setNewSessionWorktreePath] = useState("");
  const [fileRequest, setFileRequest] = useState<FileOpenRequest>();
  const fileRequestSequence = useRef(0);
  const onFileOpened = useCallback((requestId: number) => {
    setFileRequest((current) =>
      current?.requestId === requestId ? undefined : current,
    );
  }, []);

  useEffect(() => setSelectedToolId(undefined), [activeRef]);

  function startNewSession(worktree?: WorktreeEntry) {
    racco.clearHomeError();
    const target =
      worktree ??
      worktrees.find(
        (entry) => entry.path === selectedWorktreePath && entry.available,
      ) ??
      worktrees.find((entry) => entry.available);
    setNewSessionWorktreePath(target?.path ?? "");
    setSelectedWorktreePath(target?.path ?? "");
    navigation.startNewSession(
      target?.projectId ??
        projects.find((project) => project.available)?.projectId ??
        "",
    );
  }

  const selectedTool = findTimelineTool(rows, selectedToolId);
  const selectedToolOwner = rows.find(
    (row) =>
      row.type === "subagent" &&
      row.timeline.some((candidate) => candidate === selectedTool),
  );
  const contextWorktree = worktrees.find(
    (worktree) => worktree.path === selectedWorktreePath,
  );
  const sessionWorktree = worktrees.find(
    (worktree) => worktree.path === session?.cwd,
  );

  // Opening a different session selects its directory once. Subsequent manual
  // selections remain usable while that session stays open.
  useEffect(() => {
    if (session?.cwd !== undefined) {
      setSelectedWorktreePath(session.cwd);
    }
  }, [session?.sessionId, session?.cwd]);
  useEffect(() => {
    const path =
      newSessionWorktreePath ||
      projects.find((project) => project.projectId === newSessionProjectId)
        ?.path;
    if (
      activeRef === undefined &&
      path !== undefined &&
      worktrees.some((entry) => entry.path === path)
    ) {
      setSelectedWorktreePath(path);
      return;
    }
    if (worktrees.some((entry) => entry.path === selectedWorktreePath)) return;
    const fallback =
      worktrees.find((worktree) => worktree.available) ?? worktrees[0];
    if (fallback !== undefined) setSelectedWorktreePath(fallback.path);
  }, [
    activeRef,
    newSessionProjectId,
    newSessionWorktreePath,
    projects,
    selectedWorktreePath,
    worktrees,
  ]);

  const dockWorktreePath =
    contextWorktree?.path ??
    worktrees.find((worktree) => worktree.available)?.path ??
    worktrees[0]?.path ??
    "";

  function selectNewSessionProject(projectId: string) {
    setNewSessionProjectId(projectId);
    setNewSessionWorktreePath("");
  }

  function selectNewSessionWorktree(path: string) {
    setNewSessionWorktreePath(path);
  }

  function selectWorktree(path: string) {
    setSelectedWorktreePath(path);
    if (activeRef === undefined) {
      const worktree = worktrees.find((entry) => entry.path === path);
      if (worktree !== undefined) {
        setNewSessionProjectId(worktree.projectId);
        setNewSessionWorktreePath(path);
      }
    }
  }

  function openReferencedFile(location: ProjectFileLocation) {
    if (session === undefined) return;
    setSelectedToolId(undefined);
    setSelectedWorktreePath(session.cwd);
    setDockPanel("files");
    fileRequestSequence.current += 1;
    setFileRequest({
      ...location,
      worktreePath: session.cwd,
      requestId: fileRequestSequence.current,
    });
  }

  return (
    <FileNavigationContext.Provider
      value={
        session === undefined
          ? undefined
          : {
              projectRoot: session.cwd,
              baseDirectory: session.cwd,
              available: sessionWorktree?.available === true,
              onOpenFile: openReferencedFile,
            }
      }
    >
      <main
        style={{ "--project-dock-width": `${dockWidth}px` } as CSSProperties}
        className={`app-layout${historyOpen ? " history-open" : ""}${selectedTool !== undefined ? " inspector-open" : ""}${dockPanel ? " dock-open" : ""}`}
      >
        <SessionList
          worktrees={worktrees}
          worktreeErrors={worktreeErrors}
          selectedWorktreePath={selectedWorktreePath}
          onSelectWorktree={selectWorktree}
          refreshingProjectId={racco.busyWorktreeProjectId}
          activeRef={activeRef}
          error={homeError}
          loading={loading}
          onNew={startNewSession}
          onDeleteProject={deleteProject}
          onDeleteSession={deleteSession}
          onDeleteWorktree={async (worktree, deleteBranch) => {
            try {
              await deleteWorktree(
                worktree.projectId,
                worktree.path,
                false,
                deleteBranch,
              );
            } catch (error) {
              if (!(error instanceof Error)) return;
              const dirtyLines = [
                `「${worktree.name}」含未提交的修改或未跟踪的文件。`,
                "删除会一并丢弃这些内容，无法恢复。",
                ...(deleteBranch && worktree.branch !== null
                  ? [`本地分支 ${worktree.branch} 也会被删除。`]
                  : []),
                "确认继续删除吗？",
              ];
              if (!window.confirm(dirtyLines.join("\n\n"))) return;
              await deleteWorktree(
                worktree.projectId,
                worktree.path,
                true,
                deleteBranch,
              );
            }
          }}
          onRefreshWorktrees={(projectId) =>
            void refreshProjectWorktrees(projectId)
          }
          onImportProject={() => openProjectPicker(false)}
          onOpen={openSession}
          projects={projects}
          sessions={sessions}
        />

        <section className="workspace">
          {activeRef !== undefined && session === undefined && (
            <div className="conversation-loading">
              <span className="button-spinner" />
              <p>正在读取对话…</p>
              {sessionError && <p className="error-banner">{sessionError}</p>}
            </div>
          )}
          {sessionViews.map((view) => (
            <SessionView
              key={view.session.sessionId}
              active={activeRef?.sessionId === view.session.sessionId}
              loaded={view.loaded}
              connection={connection}
              error={
                activeRef?.sessionId === view.session.sessionId
                  ? sessionError
                  : undefined
              }
              interactions={view.interactions}
              onBack={showHistory}
              onInterrupt={interruptTurn}
              onCompact={compactSession}
              onResolve={resolveInteraction}
              onSelectTool={setSelectedToolId}
              onSend={sendTurn}
              rows={view.rows}
              selectedToolId={selectedToolId}
              sending={sending}
              session={view.session}
            />
          ))}
          {activeRef === undefined && (
            <NewSessionView
              active={!historyOpen}
              connected={connection === "open"}
              creating={creating}
              error={homeError}
              health={health}
              onBack={showHistory}
              onCreate={createSession}
              onImportProject={() => openProjectPicker(true)}
              onProjectChange={selectNewSessionProject}
              onWorktreeChange={selectNewSessionWorktree}
              onCreateWorktree={createWorktree}
              worktreeError={worktreeErrors[newSessionProjectId]}
              busyWorktree={racco.busyWorktreeProjectId === newSessionProjectId}
              projectId={newSessionProjectId}
              projects={projects}
              worktrees={worktrees}
              worktreePath={newSessionWorktreePath}
            />
          )}
        </section>

        {directoryPicker !== undefined && (
          <DirectoryBrowser
            initialPath={directoryPicker.initialPath}
            projects={projects}
            onClose={() => setDirectoryPicker(undefined)}
            onImport={importSelectedDirectory}
          />
        )}

        {selectedTool !== undefined && (
          <FileReferenceScope
            baseDirectory={
              selectedToolOwner?.type === "subagent"
                ? selectedToolOwner.cwd
                : session?.cwd
            }
          >
            <ToolInspector
              key={selectedTool.id}
              onClose={() => setSelectedToolId(undefined)}
              row={selectedTool}
            />
          </FileReferenceScope>
        )}
        <ProjectDock
          active={dockPanel}
          width={dockWidth}
          projects={projects}
          worktrees={worktrees}
          worktreePath={dockWorktreePath}
          fileRequest={fileRequest}
          onFileOpened={onFileOpened}
          onWorktreeChange={selectWorktree}
          onToggle={(panel) =>
            setDockPanel((current) => (current === panel ? undefined : panel))
          }
          onResize={setDockWidth}
          sessions={sessions}
          onImport={(provider, nativeId, path) =>
            racco.importSession(
              provider,
              nativeId,
              worktrees.find((worktree) => worktree.path === path)?.projectId ??
                "",
              path,
            )
          }
          onDeleteNative={(provider, nativeId, path) =>
            deleteNativeSession(
              provider,
              nativeId,
              worktrees.find((worktree) => worktree.path === path)?.projectId ??
                "",
              path,
            )
          }
          onOpen={openSession}
        />
      </main>
    </FileNavigationContext.Provider>
  );
}
