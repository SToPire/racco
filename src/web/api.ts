import type {
  HealthResponse,
  DirectoryListing,
  ProjectEntry,
  ProjectFilePreview,
  ProjectTreeListing,
  SessionSummary,
  ModelCatalog,
  Provider,
  NativeSessionPage,
  DeleteWorktreeResult,
  WorktreeCatalog,
} from "../shared/protocol";
import {
  ModelCatalogSchema,
  NativeSessionPageSchema,
} from "../shared/protocol";

export async function listModels(
  provider: Provider,
  path: string,
  signal: AbortSignal,
): Promise<ModelCatalog> {
  const query = new URLSearchParams({ path });
  const response = await fetch(`/api/providers/${provider}/models?${query}`, {
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    throw new Error(payload?.message ?? "无法读取模型列表");
  }
  const catalog = ModelCatalogSchema.parse(await response.json());
  if (catalog.provider !== provider || catalog.path !== path)
    throw new Error("模型目录与当前 Worktree 不符");
  return catalog;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    throw new Error(
      payload?.message ?? `${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as T;
}

async function del(url: string): Promise<void> {
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    const error = new Error(
      payload?.message ?? `${response.status} ${response.statusText}`,
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
}

async function delJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    const error = new Error(
      payload?.message ?? `${response.status} ${response.statusText}`,
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

export function getHealth(): Promise<HealthResponse> {
  return getJson("/api/health");
}

export function listSessions(): Promise<SessionSummary[]> {
  return getJson("/api/sessions");
}

export async function listNativeSessions(
  path: string,
  provider: Provider,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<NativeSessionPage> {
  const query = new URLSearchParams({ provider, path });
  if (cursor !== undefined) query.set("cursor", cursor);
  const response = await fetch(`/api/worktrees/native-sessions?${query}`, {
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    throw new Error(payload?.message ?? "无法读取会话列表");
  }
  const page = NativeSessionPageSchema.parse(await response.json());
  if (page.path !== path || page.provider !== provider)
    throw new Error("会话列表与当前 Worktree 不符");
  return page;
}

export function importSession(
  provider: Provider,
  providerSessionId: string,
  projectId: string,
  path: string,
): Promise<SessionSummary> {
  return postJson("/api/sessions/import", {
    provider,
    providerSessionId,
    projectId,
    path,
  });
}

export function deleteNativeSession(
  provider: Provider,
  providerSessionId: string,
  projectId: string,
  path: string,
): Promise<{ removedManagedSessionId: string | null }> {
  return postJson("/api/sessions/delete-native", {
    provider,
    providerSessionId,
    projectId,
    path,
  });
}

export function listWorktrees(projectId: string): Promise<WorktreeCatalog> {
  return getJson(`/api/worktrees?${new URLSearchParams({ projectId })}`);
}

export function refreshWorktrees(projectId: string): Promise<WorktreeCatalog> {
  return postJson(
    `/api/worktrees/refresh?${new URLSearchParams({ projectId })}`,
    undefined,
  );
}

export function createWorktree(
  projectId: string,
  name: string,
  baseRef?: string,
): Promise<WorktreeCatalog> {
  return postJson(
    `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
    baseRef === undefined ? { name } : { name, baseRef },
  );
}

export function deleteWorktree(
  projectId: string,
  path: string,
  force = false,
  deleteBranch = false,
): Promise<DeleteWorktreeResult> {
  const query = new URLSearchParams({ projectId, path });
  if (force) query.set("force", "true");
  if (deleteBranch) query.set("deleteBranch", "true");
  return delJson(`/api/worktrees?${query}`);
}

export function listProjects(): Promise<ProjectEntry[]> {
  return getJson("/api/projects");
}

export function deleteProject(
  projectId: string,
  removeWorktrees = false,
): Promise<void> {
  const query = removeWorktrees
    ? new URLSearchParams({ removeWorktrees: "true" })
    : "";
  return del(`/api/projects/${encodeURIComponent(projectId)}?${query}`);
}

export function deleteSession(sessionId: string): Promise<void> {
  return del(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function importProject(path: string): Promise<ProjectEntry> {
  return postJson("/api/projects", { path });
}

export async function listDirectories(
  path?: string,
  signal?: AbortSignal,
): Promise<DirectoryListing> {
  const query = path === undefined ? "" : `?${new URLSearchParams({ path })}`;
  const response = await fetch(`/api/directories${query}`, { signal });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    throw new Error(payload?.message ?? `无法读取目录（${response.status}）`);
  }
  return (await response.json()) as DirectoryListing;
}

async function readWorktreeResource<T>(
  resource: "tree" | "file",
  path: string,
  relative: string,
  signal?: AbortSignal,
): Promise<T> {
  const query =
    resource === "tree"
      ? new URLSearchParams({ path, dir: relative })
      : new URLSearchParams({ path, file: relative });
  const response = await fetch(`/api/worktrees/${resource}?${query}`, {
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    throw new Error(payload?.message ?? `读取失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

export function listWorktreeFiles(
  path: string,
  dir = "",
  signal?: AbortSignal,
): Promise<ProjectTreeListing> {
  return readWorktreeResource("tree", path, dir, signal);
}

export function readWorktreeFile(
  path: string,
  file: string,
  signal?: AbortSignal,
): Promise<ProjectFilePreview> {
  return readWorktreeResource("file", path, file, signal);
}
