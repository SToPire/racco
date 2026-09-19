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
} from "../shared/protocol";
import {
  ModelCatalogSchema,
  NativeSessionPageSchema,
} from "../shared/protocol";

export async function listModels(
  provider: Provider,
  projectId: string,
  signal: AbortSignal,
): Promise<ModelCatalog> {
  const query = new URLSearchParams({
    projectId,
  });
  const response = await fetch(`/api/providers/${provider}/models?${query}`, {
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    throw new Error(payload?.message ?? "无法读取模型列表");
  }
  const catalog = ModelCatalogSchema.parse(await response.json());
  if (catalog.provider !== provider || catalog.projectId !== projectId)
    throw new Error("模型目录与当前项目不符");
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
    throw new Error(
      payload?.message ?? `${response.status} ${response.statusText}`,
    );
  }
}

export function getHealth(): Promise<HealthResponse> {
  return getJson("/api/health");
}

export function listSessions(): Promise<SessionSummary[]> {
  return getJson("/api/sessions");
}

export async function listNativeSessions(
  projectId: string,
  provider: Provider,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<NativeSessionPage> {
  const query = new URLSearchParams({ provider });
  if (cursor !== undefined) query.set("cursor", cursor);
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/native-sessions?${query}`,
    { signal },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    throw new Error(payload?.message ?? "无法读取会话列表");
  }
  const page = NativeSessionPageSchema.parse(await response.json());
  if (page.projectId !== projectId || page.provider !== provider)
    throw new Error("会话列表与当前项目不符");
  return page;
}

export function importSession(
  provider: Provider,
  providerSessionId: string,
  projectId: string,
): Promise<SessionSummary> {
  return postJson("/api/sessions/import", {
    provider,
    providerSessionId,
    projectId,
  });
}

export function deleteNativeSession(
  provider: Provider,
  providerSessionId: string,
  projectId: string,
): Promise<{ removedManagedSessionId: string | null }> {
  return postJson("/api/sessions/delete-native", {
    provider,
    providerSessionId,
    projectId,
  });
}

export function listProjects(): Promise<ProjectEntry[]> {
  return getJson("/api/projects");
}

export function deleteProject(projectId: string): Promise<void> {
  return del(`/api/projects/${encodeURIComponent(projectId)}`);
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

async function readProjectResource<T>(
  projectId: string,
  resource: "tree" | "file",
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${resource}?${new URLSearchParams({ path })}`,
    { signal },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { message?: string } | undefined;
    throw new Error(payload?.message ?? `读取失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

export function listProjectFiles(
  projectId: string,
  path = "",
  signal?: AbortSignal,
): Promise<ProjectTreeListing> {
  return readProjectResource(projectId, "tree", path, signal);
}

export function readProjectFile(
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<ProjectFilePreview> {
  return readProjectResource(projectId, "file", path, signal);
}
