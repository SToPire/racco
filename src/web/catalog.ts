import type { ProjectEntry, SessionSummary } from "../shared/protocol";

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
