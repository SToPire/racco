import type { UserInput } from "../../shared/user-input";
import { useCallback, useEffect, useRef, useState, useReducer } from "react";
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
  WorktreeEntry,
  WorktreeCatalog,
} from "../../shared/protocol";
import {
  createWorktree as requestCreateWorktree,
  deleteNativeSession as requestDeleteNativeSession,
  deleteProject as requestDeleteProject,
  deleteSession as requestDeleteSession,
  deleteWorktree as requestDeleteWorktree,
  getHealth,
  restartProvider,
  importProject,
  importSession as requestImportSession,
  listProjects,
  listSessions,
  listWorktrees,
  refreshWorktrees,
} from "../api";
import {
  catalogReducer,
  initialCatalogState,
  type CatalogChange,
} from "../catalog-state";
import { RaccoRequestError, RaccoSocket, type SocketStatus } from "../socket";
import { applyTimelineEvent, buildTimeline, type TimelineRow } from "../store";
import {
  visitSession,
  updateSessionContent,
  forgetSessionContent,
  type SessionCache,
} from "../session-cache";

const EMPTY_ROWS: TimelineRow[] = [];
const EMPTY_INTERACTIONS: InteractionRequest[] = [];

function matchesRef(
  ref: SessionRef | undefined,
  candidate: SessionRef,
): boolean {
  return ref?.sessionId === candidate.sessionId;
}

/**
 * Reads every project's worktree list, once, for the initial load. Each project
 * is independent: one repository that cannot be read leaves the others intact
 * and shows up as its own degraded catalog rather than failing the whole load.
 * The primary entry is synthesized by the server even then, so a project is
 * never left without a row.
 */
async function loadAllWorktrees(
  projects: ProjectEntry[],
): Promise<
  Array<{ projectId: string; catalog?: WorktreeCatalog; error?: string }>
> {
  return Promise.all(
    projects.map(async ({ projectId }) => {
      try {
        const catalog = await listWorktrees(projectId);
        return {
          projectId,
          catalog,
          error: catalog.degradedReason ?? undefined,
        };
      } catch (error) {
        return {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
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
  const [sessionCache, setSessionCache] = useState<SessionCache>(
    () => new Map(),
  );
  const [catalog, dispatchCatalog] = useReducer(
    catalogReducer,
    initialCatalogState,
  );
  const { sessions, projects, worktrees, worktreeErrors } = catalog;
  const homeGeneration = useRef(0);
  const worktreeGeneration = useRef(0);
  const changeCatalog = useCallback(
    (change: CatalogChange) => dispatchCatalog({ type: "change", change }),
    [],
  );
  const [health, setHealth] = useState<HealthResponse>();
  const [loading, setLoading] = useState(true);
  const [homeError, setHomeError] = useState<string>();
  const [sessionError, setSessionError] = useState<string>();
  const [subscription, setSubscription] = useState<{
    sessionId: string;
    status: "loading" | "not-found" | "error";
  }>();
  const [subscriptionAttempt, setSubscriptionAttempt] = useState(0);
  /** Project whose worktree list is being re-read, or being created in. */
  const [busyWorktreeProjectId, setBusyWorktreeProjectId] = useState<string>();
  const [connection, setConnection] = useState<SocketStatus>("closed");
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const pendingSend = useRef<string | undefined>(undefined);
  const pendingCreate = useRef<string | undefined>(undefined);
  const subscriptionRequests = useRef(new Set<string>());
  const connectedBefore = useRef(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  /** Pre-delete snapshot to detect double navigation (REST success + WS broadcast). */
  const navigatingFromDelete = useRef(false);

  const loadHome = useCallback(async () => {
    const generation = ++homeGeneration.current;
    dispatchCatalog({ type: "begin", generation });
    setLoading(true);
    setHomeError(undefined);
    try {
      const [nextHealth, nextSessions, nextProjects] = await Promise.all([
        getHealth(),
        listSessions(),
        listProjects(),
      ]);
      const results = await loadAllWorktrees(nextProjects);
      if (generation !== homeGeneration.current) return;
      setHealth(nextHealth);
      dispatchCatalog({
        type: "loaded",
        generation,
        data: {
          projects: nextProjects,
          sessions: nextSessions,
          worktrees: results.flatMap(
            (result) => result.catalog?.worktrees ?? [],
          ),
          worktreeErrors: Object.fromEntries(
            results.flatMap((result) =>
              result.error === undefined
                ? []
                : [[result.projectId, result.error]],
            ),
          ),
        },
      });
    } catch (error) {
      if (generation !== homeGeneration.current) return;
      dispatchCatalog({ type: "failed", generation });
      setHomeError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === homeGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (catalog.loadedGeneration === 0) return;
    setSessionCache(
      (current) =>
        new Map(
          [...current].flatMap(([id, content]) => {
            const session = sessions.find((entry) => entry.sessionId === id);
            return session === undefined
              ? []
              : [[id, { ...content, session }] as const];
          }),
        ),
    );
  }, [sessions, catalog.loadedGeneration]);

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
        if (status === "open") {
          if (connectedBefore.current) void loadHome();
          connectedBefore.current = true;
        }
      }),
    [loadHome, socket],
  );

  useEffect(() => {
    if (activeRef === undefined) return;
    if (connection !== "open") {
      setSubscription({
        sessionId: activeRef.sessionId,
        status: connection === "closed" ? "error" : "loading",
      });
      if (connection === "closed")
        setSessionError("连接已断开，恢复连接后可重试读取。");
      return;
    }
    let cancelled = false;
    setSubscription({ sessionId: activeRef.sessionId, status: "loading" });
    setSessionError(undefined);
    const requestId = crypto.randomUUID();
    subscriptionRequests.current.add(requestId);
    void socket
      .request({
        type: "session.subscribe",
        requestId,
        sessionId: activeRef.sessionId,
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSubscription({
            sessionId: activeRef.sessionId,
            status:
              error instanceof RaccoRequestError &&
              error.code === "session_not_found"
                ? "not-found"
                : "error",
          });
          setSessionError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => subscriptionRequests.current.delete(requestId));
    return () => {
      cancelled = true;
    };
  }, [activeRef?.sessionId, connection, socket, subscriptionAttempt]);

  useEffect(
    () =>
      socket.onMessage((message: ServerMessage) => {
        if (message.type === "ack") return;
        if (message.type === "error") {
          if (
            message.requestId !== undefined &&
            subscriptionRequests.current.has(message.requestId)
          )
            return;
          setSessionError(message.message);
          return;
        }

        if (message.type === "project.upserted") {
          changeCatalog(message);
          return;
        }

        if (message.type === "project.deleted") {
          setSessionCache((current) =>
            forgetSessionContent(
              current,
              (content) => content.session.projectId === message.projectId,
            ),
          );
          changeCatalog(message);
          maybeNavigateAwayForProjectId(message.projectId);
          return;
        }

        if (message.type === "worktree.upserted") {
          changeCatalog(message);
          return;
        }

        if (message.type === "worktree.deleted") {
          changeCatalog(message);
          return;
        }

        if (message.type === "session.removed") {
          setSessionCache((current) =>
            forgetSessionContent(
              current,
              (content) => content.session.sessionId === message.sessionId,
            ),
          );
          changeCatalog(message);
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
          changeCatalog({ type: "session.upserted", session: message.session });
          setSessionCache((current) =>
            updateSessionContent(
              current,
              message.session.sessionId,
              (content) => ({ ...content, session: message.session }),
            ),
          );
          return;
        }

        if (message.type === "session.snapshot") {
          changeCatalog({ type: "session.upserted", session: message.session });
          setSessionCache((current) =>
            updateSessionContent(
              matchesRef(activeRef, message.session)
                ? visitSession(current, message.session)
                : current,
              message.session.sessionId,
              (content) => ({
                ...content,
                session: message.session,
                rows: buildTimeline(message.events),
                interactions: message.pendingInteractions,
                loaded: true,
              }),
            ),
          );
          if (matchesRef(activeRef, message.session))
            setSessionError(undefined);
          return;
        }

        if (message.type === "timeline.event") {
          setSessionCache((current) =>
            updateSessionContent(
              current,
              message.session.sessionId,
              (content) => ({
                ...content,
                rows: applyTimelineEvent(content.rows, message.event),
              }),
            ),
          );
        } else if (message.type === "interaction.requested") {
          setSessionCache((current) =>
            updateSessionContent(
              current,
              message.session.sessionId,
              (content) => ({
                ...content,
                interactions: [
                  ...content.interactions.filter(
                    (item) => item.id !== message.interaction.id,
                  ),
                  message.interaction,
                ],
              }),
            ),
          );
        } else if (message.type === "interaction.resolved") {
          setSessionCache((current) =>
            updateSessionContent(
              current,
              message.session.sessionId,
              (content) => ({
                ...content,
                interactions: content.interactions.filter(
                  (item) => item.id !== message.interactionId,
                ),
              }),
            ),
          );
        }
      }),
    [activeRef, socket],
  );

  useEffect(() => {
    setSessionError(undefined);
  }, [activeRef?.sessionId]);

  function openSession(session: SessionSummary) {
    const next: SessionRef = {
      sessionId: session.sessionId,
    };
    clearDeleteNavigationFlag();
    navigateToRef(next, session);
  }

  function navigateToRef(ref: SessionRef, session?: SessionSummary) {
    if (session !== undefined)
      setSessionCache((current) => visitSession(current, session));
    onOpen(ref);
  }

  function showHistory() {
    onHome();
  }

  function rememberProject(project: ProjectEntry): ProjectEntry {
    changeCatalog({ type: "project.upserted", project });
    return project;
  }

  async function addProject(path: string): Promise<ProjectEntry> {
    const project = rememberProject(await importProject(path));
    // A fresh import has no worktrees in local state yet; the catalog read
    // synthesizes the primary row, so the project is never rendered empty.
    const generation = beginWorktreeRead(project.projectId);
    try {
      const catalog = await listWorktrees(project.projectId);
      rememberWorktreeCatalog(catalog, generation);
    } catch (error) {
      changeCatalog({
        type: "worktree.error",
        projectId: project.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      endWorktreeRead(project.projectId, generation);
    }
    return project;
  }

  /** Re-reads one project's worktrees from Git. The only refresh there is. */
  async function refreshProjectWorktrees(projectId: string): Promise<void> {
    setBusyWorktreeProjectId(projectId);
    clearWorktreeError(projectId);
    const generation = beginWorktreeRead(projectId);
    try {
      const catalog = await refreshWorktrees(projectId);
      rememberWorktreeCatalog(catalog, generation);
    } catch (error) {
      // The previous list stays on screen; only the error is added.
      changeCatalog({
        type: "worktree.error",
        projectId: projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      endWorktreeRead(projectId, generation);
      setBusyWorktreeProjectId(undefined);
    }
  }

  async function createWorktree(
    projectId: string,
    name: string,
  ): Promise<WorktreeEntry | undefined> {
    setBusyWorktreeProjectId(projectId);
    clearWorktreeError(projectId);
    const generation = beginWorktreeRead(projectId);
    try {
      const catalog = await requestCreateWorktree(projectId, name);
      rememberWorktreeCatalog(catalog, generation);
      return catalog.worktrees.find(
        (worktree) => worktree.kind === "linked" && worktree.branch === name,
      );
    } catch (error) {
      changeCatalog({
        type: "worktree.error",
        projectId: projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      endWorktreeRead(projectId, generation);
      setBusyWorktreeProjectId(undefined);
    }
  }

  async function deleteWorktree(
    projectId: string,
    path: string,
    force = false,
    deleteBranch = false,
  ): Promise<void> {
    setBusyWorktreeProjectId(projectId);
    clearWorktreeError(projectId);
    const generation = beginWorktreeRead(projectId);
    try {
      const result = await requestDeleteWorktree(
        projectId,
        path,
        force,
        deleteBranch,
      );
      rememberWorktreeCatalog(result.catalog, generation);
      // The sessions that lived in that directory are gone with it; removing
      // them locally keeps the tree from showing rows the server no longer has.
      if (result.removedSessionIds.length > 0) {
        const removed = new Set(result.removedSessionIds);
        setSessionCache((current) =>
          forgetSessionContent(current, (content) =>
            removed.has(content.session.sessionId),
          ),
        );
        for (const sessionId of removed)
          changeCatalog({ type: "session.removed", sessionId });
      }
      const branchDeletion = result.branchDeletion;
      if (branchDeletion?.deleted === false) {
        changeCatalog({
          type: "worktree.error",
          projectId: projectId,
          error: `Worktree 已删除，但本地分支 ${branchDeletion.branch} 删除失败：${branchDeletion.reason}`,
        });
      }
    } catch (error) {
      // A dirty directory is a decision the caller must make (re-confirm and
      // retry with force), not an error to park in the sidebar. Other failures
      // are shown in place.
      const status = (error as { status?: number } | null)?.status;
      if (status === 409) throw error;
      changeCatalog({
        type: "worktree.error",
        projectId: projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      endWorktreeRead(projectId, generation);
      setBusyWorktreeProjectId(undefined);
    }
  }

  function beginWorktreeRead(projectId: string) {
    const generation = ++worktreeGeneration.current;
    dispatchCatalog({ type: "worktree.begin", projectId, generation });
    return generation;
  }
  function endWorktreeRead(projectId: string, generation: number) {
    dispatchCatalog({ type: "worktree.end", projectId, generation });
  }
  function rememberWorktreeCatalog(
    catalog: WorktreeCatalog,
    generation: number,
  ) {
    dispatchCatalog({
      type: "worktree.end",
      projectId: catalog.projectId,
      catalog,
      generation,
    });
  }

  function clearWorktreeError(projectId: string) {
    changeCatalog({ type: "worktree.error", projectId });
  }

  async function importSession(
    provider: Provider,
    providerSessionId: string,
    projectId: string,
    path: string,
  ): Promise<SessionSummary> {
    const imported = await requestImportSession(
      provider,
      providerSessionId,
      projectId,
      path,
    );
    changeCatalog({ type: "session.upserted", session: imported });
    return imported;
  }

  async function deleteNativeSession(
    provider: Provider,
    providerSessionId: string,
    projectId: string,
    path: string,
  ): Promise<void> {
    const removed = await requestDeleteNativeSession(
      provider,
      providerSessionId,
      projectId,
      path,
    );
    const removedManagedSessionId = removed.removedManagedSessionId;
    if (removedManagedSessionId !== null) {
      setSessionCache((current) =>
        forgetSessionContent(
          current,
          (content) => content.session.sessionId === removedManagedSessionId,
        ),
      );
      // Optimistic local removal; the server's session.removed broadcast is the
      // idempotent backstop when the WebSocket is connected.
      changeCatalog({
        type: "session.removed",
        sessionId: removedManagedSessionId,
      });
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

  async function deleteProject(
    projectId: string,
    removeWorktrees = false,
  ): Promise<void> {
    setHomeError(undefined);
    // Optimistic removal so the UI reflects the delete even if the WebSocket
    // is disconnected and no broadcast arrives; the server broadcast backstop
    // in the onMessage handler stays idempotent. When the worktrees stay on
    // disk, their local rows go away with the project; re-importing the same
    // directory re-derives them.
    changeCatalog({ type: "project.deleted", projectId });
    setSessionCache((current) =>
      forgetSessionContent(
        current,
        (content) => content.session.projectId === projectId,
      ),
    );
    maybeNavigateAwayForProjectId(projectId);
    try {
      await requestDeleteProject(projectId, removeWorktrees);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHomeError(message);
      // Re-fetch so the UI does not silently drift from server state; re-set
      // the error after the fetch clears it, so the user actually sees it.
      void loadHome().finally(() => setHomeError(message));
    }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    setSessionCache((current) =>
      forgetSessionContent(
        current,
        (content) => content.session.sessionId === sessionId,
      ),
    );
    setSessionError(undefined);
    changeCatalog({ type: "session.removed", sessionId });
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
    path: string,
    content: UserInput,
    modelSettings: ModelSettings,
  ): Promise<boolean> {
    if (pendingCreate.current !== undefined) return false;
    const requestId = crypto.randomUUID();
    pendingCreate.current = requestId;
    setCreating(true);
    setHomeError(undefined);
    try {
      const data = await socket.request({
        type: "session.create",
        requestId,
        provider,
        projectId,
        path,
        content,
        modelSettings,
      });
      const result = SessionRefSchema.safeParse(data);
      if (!result.success) throw new Error("Racco 返回了无效的 session ref");
      navigateToRef(result.data);
      return true;
    } catch (error) {
      setHomeError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      pendingCreate.current = undefined;
      setCreating(false);
    }
  }

  async function sendTurn(
    content: UserInput,
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
        content,
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
    void socket
      .request({
        type: "turn.interrupt",
        requestId: crypto.randomUUID(),
        ...activeRef,
      })
      .catch((error) => setSessionError(String(error.message)));
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
    void socket
      .request({
        type: "interaction.resolve",
        requestId: crypto.randomUUID(),
        interactionId: id,
        response,
      })
      .catch((error) => setSessionError(String(error.message)));
  }

  const session =
    activeRef === undefined
      ? undefined
      : (sessionCache.get(activeRef.sessionId)?.session ??
        sessions.find((candidate) => matchesRef(activeRef, candidate)));
  useEffect(() => {
    if (session !== undefined)
      setSessionCache((current) => visitSession(current, session));
  }, [activeRef?.sessionId, session?.sessionId]);
  const activeContent =
    activeRef === undefined ? undefined : sessionCache.get(activeRef.sessionId);
  const rows = activeContent?.rows ?? EMPTY_ROWS;
  const interactions = activeContent?.interactions ?? EMPTY_INTERACTIONS;
  return {
    session,
    sessionLoadState: activeContent?.loaded
      ? ("ready" as const)
      : subscription !== undefined &&
          subscription.sessionId === activeRef?.sessionId
        ? subscription.status
        : ("loading" as const),
    retrySession: () => {
      socket.connect();
      setSubscriptionAttempt((attempt) => attempt + 1);
    },
    sessions,
    projects,
    worktrees,
    worktreeErrors,
    busyWorktreeProjectId,
    health,
    loading,
    homeError,
    sessionError,
    connection,
    sending,
    creating,
    rows,
    interactions,
    sessionViews: [...sessionCache.values()],
    openSession,
    showHistory,
    addProject,
    importSession,
    deleteNativeSession,
    deleteProject,
    deleteSession,
    refreshProjectWorktrees,
    createWorktree,
    deleteWorktree,
    createSession,
    sendTurn,
    compactSession,
    interruptTurn,
    resolveInteraction,
    restartProvider: async () => setHealth(await restartProvider("codex")),
    clearHomeError: () => setHomeError(undefined),
  };
}
