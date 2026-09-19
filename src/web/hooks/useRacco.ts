import { useCallback, useEffect, useRef, useState } from "react";
import { SessionRefSchema } from "../../shared/protocol";
import type {
  HealthResponse,
  ModelSettings,
  InteractionRequest,
  InteractionResponse,
  ProjectEntry,
  Provider,
  ServerMessage,
  SessionRef,
  SessionSummary,
} from "../../shared/protocol";
import {
  deleteNativeSession as requestDeleteNativeSession,
  deleteProject as requestDeleteProject,
  deleteSession as requestDeleteSession,
  getHealth,
  importProject,
  importSession as requestImportSession,
  listProjects,
  listSessions,
} from "../api";
import {
  removeProject,
  removeSession,
  upsertProject,
  upsertSession,
} from "../catalog";
import { RaccoSocket, type SocketStatus } from "../socket";
import { applyTimelineEvent, buildTimeline, type TimelineRow } from "../store";

function matchesRef(
  ref: SessionRef | undefined,
  candidate: SessionRef,
): boolean {
  return ref?.sessionId === candidate.sessionId;
}

export function useRacco({
  activeRef,
  onOpen,
  onHome,
}: {
  activeRef?: SessionRef;
  onOpen: (ref: SessionRef) => void;
  onHome: () => void;
}) {
  const [socket] = useState(() => new RaccoSocket());
  const [activeSession, setActiveSession] = useState<SessionSummary>();
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [interactions, setInteractions] = useState<InteractionRequest[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [health, setHealth] = useState<HealthResponse>();
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [homeError, setHomeError] = useState<string>();
  const [sessionError, setSessionError] = useState<string>();
  const [connection, setConnection] = useState<SocketStatus>("closed");
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const pendingSend = useRef<string | undefined>(undefined);
  const pendingCreate = useRef<string | undefined>(undefined);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  /** Pre-delete snapshot to detect double navigation (REST success + WS broadcast). */
  const navigatingFromDelete = useRef(false);

  const loadHome = useCallback(async () => {
    setLoading(true);
    setHomeError(undefined);
    try {
      const [nextHealth, nextSessions, nextProjects] = await Promise.all([
        getHealth(),
        listSessions(),
        listProjects(),
      ]);
      setHealth(nextHealth);
      setSessions(nextSessions);
      setProjects(nextProjects);
    } catch (error) {
      setHomeError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  useEffect(() => {
    socket.connect();
    return () => socket.destroy();
  }, [socket]);

  useEffect(
    () =>
      socket.onStatus((status) => {
        setConnection(status);
        if (status === "closed" && pendingSend.current !== undefined) {
          setSessionError(
            "连接中断，请求结果未确认；重连后请查看会话再决定是否重试。",
          );
        }
        if (status === "closed" && pendingCreate.current !== undefined) {
          setHomeError("连接中断，创建结果未确认；重连后请先查看会话列表。");
        }
        if (status === "open" && activeRef !== undefined) {
          socket.send({
            type: "session.subscribe",
            requestId: crypto.randomUUID(),
            ...activeRef,
          });
        }
      }),
    [activeRef, socket],
  );

  useEffect(
    () =>
      socket.onMessage((message: ServerMessage) => {
        if (message.type === "ack") return;
        if (message.type === "error") {
          setSessionError(message.message);
          return;
        }

        if (message.type === "project.upserted") {
          setProjects((current) => upsertProject(current, message.project));
          return;
        }

        if (message.type === "project.deleted") {
          setProjects((current) => removeProject(current, message.projectId));
          setSessions((current) =>
            current.filter(
              (session) => session.projectId !== message.projectId,
            ),
          );
          maybeNavigateAwayForProjectId(message.projectId);
          return;
        }

        if (message.type === "session.removed") {
          setSessions((current) => removeSession(current, message.sessionId));
          if (
            !navigatingFromDelete.current &&
            activeRef !== undefined &&
            matchesRef(activeRef, { sessionId: message.sessionId })
          ) {
            navigatingFromDelete.current = true;
            showHistory();
          }
          return;
        }

        if (message.type === "session.upserted") {
          setSessions((current) => upsertSession(current, message.session));
          if (matchesRef(activeRef, message.session)) {
            setActiveSession(message.session);
          }
          return;
        }

        if (message.type === "session.snapshot") {
          setSessions((current) => upsertSession(current, message.session));
          if (!matchesRef(activeRef, message.session)) return;
          setActiveSession(message.session);
          setRows(buildTimeline(message.events));
          setInteractions(message.pendingInteractions);
          setSessionError(undefined);
          return;
        }

        if (!matchesRef(activeRef, message.session)) return;
        if (message.type === "timeline.event") {
          setRows((current) => applyTimelineEvent(current, message.event));
        } else if (message.type === "interaction.requested") {
          setInteractions((current) => [
            ...current.filter((item) => item.id !== message.interaction.id),
            message.interaction,
          ]);
        } else if (message.type === "interaction.resolved") {
          setInteractions((current) =>
            current.filter((item) => item.id !== message.interactionId),
          );
        }
      }),
    [activeRef, socket],
  );

  useEffect(() => {
    setRows([]);
    setInteractions([]);
    setSessionError(undefined);
    if (activeRef === undefined) setActiveSession(undefined);
  }, [activeRef]);

  function openSession(session: SessionSummary) {
    const next: SessionRef = {
      sessionId: session.sessionId,
    };
    clearDeleteNavigationFlag();
    navigateToRef(next, session);
  }

  function navigateToRef(ref: SessionRef, session?: SessionSummary) {
    setActiveSession(session);
    onOpen(ref);
  }

  function showHistory() {
    onHome();
    void loadHome();
  }

  function rememberProject(project: ProjectEntry): ProjectEntry {
    setProjects((current) => upsertProject(current, project));
    return project;
  }

  async function addProject(path: string): Promise<ProjectEntry> {
    return rememberProject(await importProject(path));
  }

  async function importSession(
    provider: Provider,
    providerSessionId: string,
    projectId: string,
  ): Promise<SessionSummary> {
    const imported = await requestImportSession(
      provider,
      providerSessionId,
      projectId,
    );
    setSessions((current) => upsertSession(current, imported));
    return imported;
  }

  async function deleteNativeSession(
    provider: Provider,
    providerSessionId: string,
    projectId: string,
  ): Promise<void> {
    const removed = await requestDeleteNativeSession(
      provider,
      providerSessionId,
      projectId,
    );
    const removedManagedSessionId = removed.removedManagedSessionId;
    if (removedManagedSessionId !== null) {
      // Optimistic local removal; the server's session.removed broadcast is the
      // idempotent backstop when the WebSocket is connected.
      setSessions((current) => removeSession(current, removedManagedSessionId));
    }
  }

  /** Navigate home once when the currently-open session's project is deleted. */
  function maybeNavigateAwayForProjectId(projectId: string) {
    if (navigatingFromDelete.current) return;
    if (activeRef === undefined) return;
    const activeProjectId = sessionsRef.current.find(
      (candidate) => candidate.sessionId === activeRef.sessionId,
    )?.projectId;
    if (activeProjectId !== projectId) return;
    navigatingFromDelete.current = true;
    showHistory();
  }

  /** Replace the navigated-away-from-delete flag once a session is opened. */
  function clearDeleteNavigationFlag() {
    navigatingFromDelete.current = false;
  }

  async function deleteProject(projectId: string): Promise<void> {
    setHomeError(undefined);
    // Optimistic removal so the UI reflects the delete even if the WebSocket
    // is disconnected and no broadcast arrives; the server broadcast backstop
    // in the onMessage handler stays idempotent.
    setProjects((current) => removeProject(current, projectId));
    setSessions((current) =>
      current.filter((session) => session.projectId !== projectId),
    );
    maybeNavigateAwayForProjectId(projectId);
    try {
      await requestDeleteProject(projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHomeError(message);
      // Re-fetch so the UI does not silently drift from server state; re-set
      // the error after the fetch clears it, so the user actually sees it.
      void loadHome().finally(() => setHomeError(message));
    }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    setSessionError(undefined);
    setSessions((current) => removeSession(current, sessionId));
    if (!navigatingFromDelete.current && activeRef !== undefined) {
      maybeNavigateAwayForSessionId(sessionId);
    }
    try {
      await requestDeleteSession(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessionError(message);
      // Re-fetch so the UI does not silently drift from server state; re-set
      // the error after the fetch clears it, so the user actually sees it.
      void loadHome().finally(() => setSessionError(message));
    }
  }

  function maybeNavigateAwayForSessionId(sessionId: string) {
    if (navigatingFromDelete.current) return;
    if (activeRef === undefined) return;
    if (!matchesRef(activeRef, { sessionId })) return;
    navigatingFromDelete.current = true;
    showHistory();
  }

  async function createSession(
    provider: Provider,
    projectId: string,
    prompt: string,
    modelSettings: ModelSettings,
  ): Promise<boolean> {
    if (pendingCreate.current !== undefined) return false;
    const requestId = crypto.randomUUID();
    pendingCreate.current = requestId;
    setCreating(true);
    setHomeError(undefined);
    // Keep the returned session ref separately while request() waits for ACK.
    let createdRef: SessionRef | undefined;
    const off = socket.onMessage((message) => {
      if (message.type === "ack" && message.requestId === requestId) {
        const result = SessionRefSchema.safeParse(message.data);
        if (result.success) createdRef = result.data;
      }
    });
    try {
      await socket.request({
        type: "session.create",
        requestId,
        provider,
        projectId,
        prompt,
        modelSettings,
      });
      if (!createdRef) throw new Error("Racco 返回了无效的 session ref");
      navigateToRef(createdRef);
      return true;
    } catch (error) {
      setHomeError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      off();
      pendingCreate.current = undefined;
      setCreating(false);
    }
  }

  async function sendTurn(
    prompt: string,
    modelSettings: ModelSettings,
  ): Promise<boolean> {
    if (activeRef === undefined || pendingSend.current !== undefined)
      return false;
    const requestId = crypto.randomUUID();
    pendingSend.current = requestId;
    setSending(true);
    setSessionError(undefined);
    try {
      await socket.request({
        type: "turn.start",
        requestId,
        ...activeRef,
        prompt,
        modelSettings,
      });
      return true;
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      pendingSend.current = undefined;
      setSending(false);
    }
  }

  function interruptTurn() {
    if (activeRef === undefined) return;
    socket.send({
      type: "turn.interrupt",
      requestId: crypto.randomUUID(),
      ...activeRef,
    });
  }

  async function compactSession(): Promise<boolean> {
    if (activeRef === undefined || pendingSend.current !== undefined)
      return false;
    const requestId = crypto.randomUUID();
    pendingSend.current = requestId;
    setSending(true);
    setSessionError(undefined);
    try {
      await socket.request({
        type: "session.compact",
        requestId,
        ...activeRef,
      });
      return true;
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      pendingSend.current = undefined;
      setSending(false);
    }
  }

  function resolveInteraction(id: string, response: InteractionResponse) {
    socket.send({
      type: "interaction.resolve",
      requestId: crypto.randomUUID(),
      interactionId: id,
      response,
    });
  }

  const session =
    activeRef === undefined
      ? undefined
      : (activeSession ??
        sessions.find((candidate) => matchesRef(activeRef, candidate)));
  return {
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
    addProject,
    importSession,
    deleteNativeSession,
    deleteProject,
    deleteSession,
    createSession,
    sendTurn,
    compactSession,
    interruptTurn,
    resolveInteraction,
    clearHomeError: () => setHomeError(undefined),
  };
}
