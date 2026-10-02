import type {
  ProjectEntry,
  ServerMessage,
  SessionSummary,
  WorktreeCatalog,
  WorktreeEntry,
} from "../shared/protocol";
import {
  removeProject,
  removeProjectWorktrees,
  removeSession,
  removeWorktree,
  replaceProjectWorktrees,
  upsertProject,
  upsertSession,
  upsertWorktree,
} from "./catalog";

export type CatalogData = {
  projects: ProjectEntry[];
  sessions: SessionSummary[];
  worktrees: WorktreeEntry[];
  worktreeErrors: Record<string, string>;
};
export type CatalogChange =
  | Extract<
      ServerMessage,
      {
        type:
          | "project.upserted"
          | "project.deleted"
          | "session.upserted"
          | "session.removed"
          | "worktree.upserted"
          | "worktree.deleted";
      }
    >
  | { type: "worktree.catalog"; catalog: WorktreeCatalog }
  | { type: "worktree.error"; projectId: string; error?: string };
export type CatalogState = CatalogData & {
  generation: number;
  loadedGeneration: number;
  pending: CatalogChange[] | undefined;
  worktreeReads: Record<
    string,
    { generation: number; changes: CatalogChange[] }
  >;
};
export const initialCatalogState: CatalogState = {
  projects: [],
  sessions: [],
  worktrees: [],
  worktreeErrors: {},
  generation: 0,
  loadedGeneration: 0,
  pending: undefined,
  worktreeReads: {},
};
export type CatalogAction =
  | { type: "worktree.begin"; projectId: string; generation: number }
  | {
      type: "worktree.end";
      projectId: string;
      generation: number;
      catalog?: WorktreeCatalog;
    }
  | { type: "begin"; generation: number }
  | { type: "loaded"; generation: number; data: CatalogData }
  | { type: "failed"; generation: number }
  | { type: "change"; change: CatalogChange };

function changeCatalog(state: CatalogData, change: CatalogChange): CatalogData {
  switch (change.type) {
    case "project.upserted":
      return {
        ...state,
        projects: upsertProject(state.projects, change.project),
      };
    case "project.deleted": {
      const worktreeErrors = { ...state.worktreeErrors };
      delete worktreeErrors[change.projectId];
      return {
        ...state,
        projects: removeProject(state.projects, change.projectId),
        sessions: state.sessions.filter(
          (session) => session.projectId !== change.projectId,
        ),
        worktrees: removeProjectWorktrees(state.worktrees, change.projectId),
        worktreeErrors,
      };
    }
    case "session.upserted":
      return {
        ...state,
        sessions: upsertSession(state.sessions, change.session),
      };
    case "session.removed":
      return {
        ...state,
        sessions: removeSession(state.sessions, change.sessionId),
      };
    case "worktree.upserted":
      return {
        ...state,
        worktrees: upsertWorktree(state.worktrees, change.worktree),
      };
    case "worktree.deleted":
      return {
        ...state,
        worktrees: removeWorktree(state.worktrees, change.path),
      };
    case "worktree.catalog":
      return changeCatalog(
        {
          ...state,
          worktrees: replaceProjectWorktrees(
            state.worktrees,
            change.catalog.projectId,
            change.catalog.worktrees,
          ),
        },
        {
          type: "worktree.error",
          projectId: change.catalog.projectId,
          error: change.catalog.degradedReason ?? undefined,
        },
      );
    case "worktree.error": {
      const worktreeErrors = { ...state.worktreeErrors };
      if (change.error === undefined) delete worktreeErrors[change.projectId];
      else worktreeErrors[change.projectId] = change.error;
      return { ...state, worktreeErrors };
    }
  }
}

function affectsWorktrees(change: CatalogChange, projectId: string): boolean {
  switch (change.type) {
    case "project.deleted":
    case "worktree.error":
      return change.projectId === projectId;
    case "worktree.upserted":
      return change.worktree.projectId === projectId;
    case "worktree.deleted":
      return true;
    case "worktree.catalog":
      return change.catalog.projectId === projectId;
    default:
      return false;
  }
}

/** A refresh is a baseline: ordered events observed during it always win. */
export function catalogReducer(
  state: CatalogState,
  action: CatalogAction,
): CatalogState {
  if (action.type === "change") {
    return {
      ...state,
      ...changeCatalog(state, action.change),
      worktreeReads: Object.fromEntries(
        Object.entries(state.worktreeReads).map(([id, read]) => [
          id,
          affectsWorktrees(action.change, id)
            ? { ...read, changes: [...read.changes, action.change] }
            : read,
        ]),
      ),
      pending:
        state.pending === undefined
          ? undefined
          : [...state.pending, action.change],
    };
  }
  if (action.type === "worktree.begin")
    return {
      ...state,
      worktreeReads: {
        ...state.worktreeReads,
        [action.projectId]: { generation: action.generation, changes: [] },
      },
    };
  if (action.type === "worktree.end") {
    const read = state.worktreeReads[action.projectId];
    if (read?.generation !== action.generation) return state;
    const worktreeReads = { ...state.worktreeReads };
    delete worktreeReads[action.projectId];
    if (!action.catalog) return { ...state, worktreeReads };
    const change: CatalogChange = {
      type: "worktree.catalog",
      catalog: action.catalog,
    };
    let next = catalogReducer(
      { ...state, worktreeReads },
      { type: "change", change },
    );
    for (const live of read.changes)
      next = catalogReducer(next, { type: "change", change: live });
    return next;
  }
  if (action.type === "begin")
    return {
      ...state,
      generation: action.generation,
      pending: [],
      // This refresh supersedes project reads already in flight. Reads begun
      // afterwards still record live changes and can update this baseline.
      worktreeReads: {},
    };
  if (action.generation !== state.generation || state.pending === undefined)
    return state;
  if (action.type === "failed") return { ...state, pending: undefined };
  const data = state.pending.reduce(changeCatalog, action.data);
  return {
    ...state,
    ...data,
    generation: action.generation,
    loadedGeneration: action.generation,
    pending: undefined,
  };
}
