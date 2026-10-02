import { z } from "zod";
import { ApiResponseSchemas } from "../shared/server-message-schema";
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
  const catalog = parseResponse(ModelCatalogSchema, await response.json());
  if (catalog.provider !== provider || catalog.path !== path)
    throw new Error("模型目录与当前 Worktree 不符");
  return catalog;
}

async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return parseResponse(schema, await response.json());
}

async function postJson<T>(
  url: string,
  schema: z.ZodType<T>,
  body: unknown,
): Promise<T> {
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
  return parseResponse(schema, await response.json());
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

async function delJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
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
  return parseResponse(schema, await response.json());
}

export function getHealth(): Promise<HealthResponse> {
  return getJson("/api/health", ApiResponseSchemas.health);
}

export function listSessions(): Promise<SessionSummary[]> {
  return getJson("/api/sessions", ApiResponseSchemas.sessions);
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
  const page = parseResponse(NativeSessionPageSchema, await response.json());
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
  return postJson("/api/sessions/import", ApiResponseSchemas.session, {
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
  return postJson(
    "/api/sessions/delete-native",
    ApiResponseSchemas.nativeDeletion,
    {
      provider,
      providerSessionId,
      projectId,
      path,
    },
  );
}

export function listWorktrees(projectId: string): Promise<WorktreeCatalog> {
  return getJson(
    `/api/worktrees?${new URLSearchParams({ projectId })}`,
    ApiResponseSchemas.worktrees,
  );
}

export function refreshWorktrees(projectId: string): Promise<WorktreeCatalog> {
  return postJson(
    `/api/worktrees/refresh?${new URLSearchParams({ projectId })}`,
    ApiResponseSchemas.worktrees,
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
    ApiResponseSchemas.worktrees,
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
  return delJson(`/api/worktrees?${query}`, ApiResponseSchemas.deleteWorktree);
}

export function listProjects(): Promise<ProjectEntry[]> {
  return getJson("/api/projects", ApiResponseSchemas.projects);
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
  return postJson("/api/projects", ApiResponseSchemas.project, { path });
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
  return parseResponse(ApiResponseSchemas.directory, await response.json());
}

async function readWorktreeResource<T>(
  resource: "tree" | "file",
  schema: z.ZodType<T>,
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
  return parseResponse(schema, await response.json());
}

export function listWorktreeFiles(
  path: string,
  dir = "",
  signal?: AbortSignal,
): Promise<ProjectTreeListing> {
  return readWorktreeResource(
    "tree",
    ApiResponseSchemas.tree,
    path,
    dir,
    signal,
  );
}

export function readWorktreeFile(
  path: string,
  file: string,
  signal?: AbortSignal,
): Promise<ProjectFilePreview> {
  return readWorktreeResource(
    "file",
    ApiResponseSchemas.file,
    path,
    file,
    signal,
  );
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error("服务器响应不符合当前协议，请刷新后重试。");
  return result.data;
}

export function restartProvider(provider: Provider): Promise<HealthResponse> {
  return postJson(
    `/api/providers/${provider}/restart`,
    ApiResponseSchemas.health,
    undefined,
  );
}
