import type {
  ProjectEntry,
  SessionSummary,
  WorktreeEntry,
} from "../shared/protocol";

export function upsertSession(
  current: SessionSummary[],
  session: SessionSummary,
): SessionSummary[] {
  return [
    session,
    ...current.filter((candidate) => candidate.sessionId !== session.sessionId),
  ].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.sessionId.localeCompare(right.sessionId),
  );
}

export function upsertProject(
  current: ProjectEntry[],
  project: ProjectEntry,
): ProjectEntry[] {
  return [
    ...current.filter((candidate) => candidate.projectId !== project.projectId),
    project,
  ].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.path.localeCompare(right.path),
  );
}

export function removeProject(
  current: ProjectEntry[],
  projectId: string,
): ProjectEntry[] {
  return current.filter((candidate) => candidate.projectId !== projectId);
}

export function removeSession(
  current: SessionSummary[],
  sessionId: string,
): SessionSummary[] {
  return current.filter((candidate) => candidate.sessionId !== sessionId);
}

/** Worktrees of one project, in display order: primary first, then by name. */
export function upsertWorktree(
  current: WorktreeEntry[],
  worktree: WorktreeEntry,
): WorktreeEntry[] {
  return [
    ...current.filter((candidate) => candidate.path !== worktree.path),
    worktree,
  ].sort(compareWorktrees);
}

export function replaceProjectWorktrees(
  current: WorktreeEntry[],
  projectId: string,
  worktrees: WorktreeEntry[],
): WorktreeEntry[] {
  return [
    ...current.filter((candidate) => candidate.projectId !== projectId),
    ...worktrees,
  ].sort(compareWorktrees);
}

export function removeWorktree(
  current: WorktreeEntry[],
  path: string,
): WorktreeEntry[] {
  return current.filter((candidate) => candidate.path !== path);
}

export function removeProjectWorktrees(
  current: WorktreeEntry[],
  projectId: string,
): WorktreeEntry[] {
  return current.filter((candidate) => candidate.projectId !== projectId);
}

function compareWorktrees(left: WorktreeEntry, right: WorktreeEntry): number {
  if (left.kind !== right.kind) return left.kind === "primary" ? -1 : 1;
  return (
    left.name.localeCompare(right.name) || left.path.localeCompare(right.path)
  );
}
