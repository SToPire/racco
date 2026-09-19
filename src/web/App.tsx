import { type CSSProperties, useEffect, useState } from "react";
import { useRacco } from "./hooks/useRacco";
import { useWorkspaceNavigation } from "./hooks/useWorkspaceNavigation";
import { useProjectPicker } from "./hooks/useProjectPicker";
import { SessionList } from "./components/SessionList";
import { SessionView } from "./components/SessionView";
import { DirectoryBrowser } from "./components/DirectoryBrowser";
import { NewSessionView } from "./components/NewSessionView";
import { ProjectDock, type DockPanel } from "./components/ProjectDock";
import { ToolInspector } from "./components/ToolInspector";
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
    health,
    loading,
    homeError,
    sessionError,
    connection,
    sending,
    creating,
    rows,
    interactions,
    openSession,
    showHistory,
    deleteNativeSession,
    deleteProject,
    deleteSession,
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
    setNewSessionProjectId,
    racco.addProject,
  );
  const [selectedToolId, setSelectedToolId] = useState<string>();
  const [dockPanel, setDockPanel] = useState<DockPanel>();
  const [dockWidth, setDockWidth] = useState(560);
  const [dockProjectId, setDockProjectId] = useState("");
  useEffect(() => setSelectedToolId(undefined), [activeRef]);
  function startNewSession(projectId?: string) {
    racco.clearHomeError();
    navigation.startNewSession(
      projectId ??
        projects.find((project) => project.available)?.projectId ??
        "",
    );
  }
  const selectedTool = findTimelineTool(rows, selectedToolId);
  const contextProjectId = session?.projectId ?? newSessionProjectId;
  useEffect(() => {
    if (contextProjectId) setDockProjectId(contextProjectId);
  }, [contextProjectId, activeRef?.sessionId, historyOpen]);
  const projectId = projects.some(
    (project) => project.projectId === dockProjectId,
  )
    ? dockProjectId
    : (projects[0]?.projectId ?? "");

  return (
    <main
      style={{ "--project-dock-width": `${dockWidth}px` } as CSSProperties}
      className={`app-layout${historyOpen ? " history-open" : ""}${selectedTool !== undefined ? " inspector-open" : ""}${dockPanel ? " dock-open" : ""}`}
    >
      <SessionList
        selectedProjectId={projectId}
        onSelectProject={setDockProjectId}
        activeRef={activeRef}
        error={homeError}
        loading={loading}
        onNew={startNewSession}
        onDeleteProject={deleteProject}
        onDeleteSession={deleteSession}
        onImportProject={() => openProjectPicker(false)}
        onOpen={openSession}
        projects={projects}
        sessions={sessions}
      />

      <section className="workspace">
        {activeRef !== undefined ? (
          session === undefined ? (
            <div className="conversation-loading">
              <span className="button-spinner" />
              <p>正在读取对话…</p>
              {sessionError && <p className="error-banner">{sessionError}</p>}
            </div>
          ) : (
            <SessionView
              key={session.sessionId}
              connection={connection}
              error={sessionError}
              interactions={interactions}
              onBack={showHistory}
              onInterrupt={interruptTurn}
              onCompact={compactSession}
              onResolve={resolveInteraction}
              onSelectTool={setSelectedToolId}
              onSend={sendTurn}
              rows={rows}
              selectedToolId={selectedToolId}
              sending={sending}
              session={session}
            />
          )
        ) : (
          <NewSessionView
            active={!historyOpen}
            connected={connection === "open"}
            creating={creating}
            error={homeError}
            health={health}
            onBack={showHistory}
            onCreate={createSession}
            onImportProject={() => openProjectPicker(true)}
            onProjectChange={setNewSessionProjectId}
            projectId={newSessionProjectId}
            projects={projects}
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
        <ToolInspector
          key={selectedTool.id}
          onClose={() => setSelectedToolId(undefined)}
          row={selectedTool}
        />
      )}
      <ProjectDock
        active={dockPanel}
        width={dockWidth}
        projects={projects}
        projectId={projectId}
        onProjectChange={setDockProjectId}
        onToggle={(panel) =>
          setDockPanel((current) => (current === panel ? undefined : panel))
        }
        onResize={setDockWidth}
        sessions={sessions}
        onImport={racco.importSession}
        onDeleteNative={deleteNativeSession}
        onOpen={openSession}
      />
    </main>
  );
}
