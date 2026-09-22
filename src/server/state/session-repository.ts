import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type {
  ModelSettings,
  ProjectEntry,
  Provider,
  SessionLifecycle,
  SessionState,
  SessionSummary,
} from "../../shared/protocol.js";
import { ModelSettingsSchema } from "../../shared/model-settings.js";

type ProviderSessionState = "allocated" | "materialized" | "missing";

export type ManagedSession = {
  sessionId: string;
  provider: Provider;
  projectId: string;
  providerSessionId?: string;
  cwd: string;
  title?: string;
  lifecycle: SessionLifecycle;
  providerState: ProviderSessionState;
  state: SessionState;
  updatedAt: string;
  createRequestHash?: string;
  createRequestId?: string;
  selectedModelSettings: ModelSettings | null;
};

export type ManagedProject = {
  projectId: string;
  name: string;
  path: string;
  createdAt: string;
};

type SessionRow = Record<string, SQLOutputValue>;

function requiredString(row: SessionRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Invalid session row column: ${key}`);
  return value;
}

function optionalString(row: SessionRow, key: string): string | undefined {
  return row[key] === null ? undefined : requiredString(row, key);
}

function mapSession(row: SessionRow): ManagedSession {
  return {
    sessionId: requiredString(row, "id"),
    provider: requiredString(row, "provider") as Provider,
    projectId: requiredString(row, "project_id"),
    providerSessionId: optionalString(row, "provider_session_id"),
    cwd: requiredString(row, "cwd"),
    title: optionalString(row, "title"),
    lifecycle: requiredString(row, "lifecycle") as SessionLifecycle,
    providerState: requiredString(
      row,
      "provider_state",
    ) as ProviderSessionState,
    state: requiredString(row, "execution_state") as SessionState,
    updatedAt: requiredString(row, "updated_at"),
    createRequestHash: optionalString(row, "create_request_hash"),
    createRequestId: optionalString(row, "create_request_id"),
    selectedModelSettings:
      row.selected_model_settings === null
        ? null
        : ModelSettingsSchema.parse(
            JSON.parse(requiredString(row, "selected_model_settings")),
          ),
  };
}

function mapProject(row: SessionRow): ManagedProject {
  return {
    projectId: requiredString(row, "id"),
    name: requiredString(row, "name"),
    path: requiredString(row, "path"),
    createdAt: requiredString(row, "created_at"),
  };
}

export function toSessionSummary(session: ManagedSession): SessionSummary {
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    projectId: session.projectId,
    title: session.title,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    state: session.state,
    lifecycle: session.lifecycle,
    selectedModelSettings: session.selectedModelSettings,
    contextUsage: null,
    compacting: false,
  };
}

export function toProjectEntry(
  project: ManagedProject,
  available: boolean,
): ProjectEntry {
  return {
    projectId: project.projectId,
    name: project.name,
    path: project.path,
    available,
    createdAt: project.createdAt,
  };
}

export class SessionRepository {
  #closed = false;

  constructor(
    private readonly database: DatabaseSync,
    private readonly closeDatabase: () => void = () => database.close(),
  ) {}

  listProjects(): ManagedProject[] {
    return this.database
      .prepare("SELECT * FROM projects ORDER BY name, path")
      .all()
      .map(mapProject);
  }

  getProject(projectId: string): ManagedProject | undefined {
    const row = this.database
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(projectId);
    return row === undefined ? undefined : mapProject(row);
  }

  deleteProject(projectId: string): string[] {
    if (this.getProject(projectId) === undefined) return [];
    let sessionIds: string[] = [];
    this.#transaction(() => {
      sessionIds = this.database
        .prepare("SELECT id FROM sessions WHERE project_id = ?")
        .all(projectId)
        .map((row) => requiredString(row, "id"));
      this.database
        .prepare("DELETE FROM sessions WHERE project_id = ?")
        .run(projectId);
      this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    });
    return sessionIds;
  }

  deleteSession(sessionId: string): boolean {
    const info = this.database
      .prepare("DELETE FROM sessions WHERE id = ?")
      .run(sessionId);
    return info.changes > 0;
  }

  #findProjectByPath(path: string): ManagedProject | undefined {
    const row = this.database
      .prepare("SELECT * FROM projects WHERE path = ?")
      .get(path);
    return row === undefined ? undefined : mapProject(row);
  }

  importProject(input: { name: string; path: string }): ManagedProject {
    const existing = this.#findProjectByPath(input.path);
    if (existing !== undefined) return existing;
    const now = new Date().toISOString();

    const projectId = randomUUID();
    this.database
      .prepare(
        `INSERT INTO projects (
          id, name, path, created_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(projectId, input.name, input.path, now);
    return this.#requireProject(projectId);
  }

  list(): ManagedSession[] {
    return this.database
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
      .all()
      .map(mapSession);
  }

  get(sessionId: string): ManagedSession | undefined {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId);
    return row === undefined ? undefined : mapSession(row);
  }

  findByCreateRequestId(requestId: string): ManagedSession | undefined {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE create_request_id = ?")
      .get(requestId);
    return row === undefined ? undefined : mapSession(row);
  }

  findByProviderSession(
    provider: Provider,
    providerSessionId: string,
  ): ManagedSession | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM sessions WHERE provider = ? AND provider_session_id = ?",
      )
      .get(provider, providerSessionId);
    return row === undefined ? undefined : mapSession(row);
  }

  createProvisioning(input: {
    sessionId: string;
    provider: Provider;
    projectId: string;
    cwd: string;
    title: string;
    requestId: string;
    requestHash: string;
  }): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO sessions (
          id, provider, project_id, cwd, title, lifecycle,
          provider_state, execution_state, create_request_id, create_request_hash,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'provisioning', 'allocated', 'idle', ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.provider,
        input.projectId,
        input.cwd,
        input.title,
        input.requestId,
        input.requestHash,
        now,
        now,
      );
  }

  recordProviderSession(input: {
    sessionId: string;
    providerSessionId: string;
    materialized: boolean;
    cwd: string;
  }): ManagedSession {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE sessions
         SET provider_session_id = ?, provider_state = ?, cwd = ?,
             updated_at = ?
         WHERE id = ? AND lifecycle = 'provisioning'`,
      )
      .run(
        input.providerSessionId,
        input.materialized ? "materialized" : "allocated",
        input.cwd,
        now,
        input.sessionId,
      );
    return this.#require(input.sessionId);
  }

  failProvisioning(sessionId: string): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE sessions
         SET lifecycle = 'failed', execution_state = 'error',
             updated_at = ?
         WHERE id = ?`,
      )
      .run(now, sessionId);
  }

  importSession(input: {
    provider: Provider;
    providerSessionId: string;
    projectId: string;
    cwd: string;
    title?: string;
    updatedAt: string;
  }): ManagedSession {
    const existing = this.findByProviderSession(
      input.provider,
      input.providerSessionId,
    );
    if (existing !== undefined) {
      if (
        existing.projectId !== input.projectId ||
        existing.cwd !== input.cwd
      ) {
        throw new Error("Session is already managed by a different project");
      }
      return existing;
    }

    const now = new Date().toISOString();
    const sessionId = randomUUID();
    this.database
      .prepare(
        `INSERT INTO sessions (
          id, provider, provider_session_id, project_id, cwd, title, lifecycle,
          provider_state, execution_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'materialized', 'idle', ?, ?)`,
      )
      .run(
        sessionId,
        input.provider,
        input.providerSessionId,
        input.projectId,
        input.cwd,
        input.title ?? null,
        now,
        input.updatedAt,
      );
    return this.#require(sessionId);
  }

  markProviderMaterialized(sessionId: string): ManagedSession {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE sessions
         SET provider_state = 'materialized', updated_at = ?
         WHERE id = ?`,
      )
      .run(now, sessionId);
    return this.#require(sessionId);
  }

  updateMetadata(
    sessionId: string,
    input: { title?: string; providerUpdatedAt: string },
  ): ManagedSession {
    const current = this.#require(sessionId);
    const updatedAt =
      input.providerUpdatedAt > current.updatedAt
        ? input.providerUpdatedAt
        : current.updatedAt;
    this.database
      .prepare(
        `UPDATE sessions
         SET title = COALESCE(?, title), updated_at = ?,
             provider_state = 'materialized'
         WHERE id = ?`,
      )
      .run(input.title ?? null, updatedAt, sessionId);
    return this.#require(sessionId);
  }

  markProviderMissing(sessionId: string): ManagedSession {
    this.database
      .prepare("UPDATE sessions SET provider_state = 'missing' WHERE id = ?")
      .run(sessionId);
    return this.#require(sessionId);
  }

  acceptTurn(
    sessionId: string,
    modelSettings: ModelSettings,
    initial: boolean,
  ): ManagedSession {
    const session = this.#require(sessionId);
    if (
      session.providerSessionId === undefined ||
      session.lifecycle !== (initial ? "provisioning" : "active")
    )
      throw new Error("Session is not ready to accept this turn");
    this.database
      .prepare(
        `UPDATE sessions SET lifecycle = 'active',
      execution_state = 'running', selected_model_settings = ?, updated_at = ?
      WHERE id = ?`,
      )
      .run(
        JSON.stringify(ModelSettingsSchema.parse(modelSettings)),
        new Date().toISOString(),
        sessionId,
      );
    return this.#require(sessionId);
  }

  updateExecutionState(sessionId: string, state: SessionState): ManagedSession {
    this.database
      .prepare(
        `UPDATE sessions SET execution_state = ?, updated_at = ?
      WHERE id = ?`,
      )
      .run(state, new Date().toISOString(), sessionId);
    return this.#require(sessionId);
  }

  recoverInterrupted(): void {
    const now = new Date().toISOString();
    this.#transaction(() => {
      this.database
        .prepare(
          `UPDATE sessions
           SET execution_state = 'interrupted', updated_at = ?
           WHERE execution_state IN ('running', 'waiting_interaction')`,
        )
        .run(now);
      this.database
        .prepare(
          `UPDATE sessions
           SET lifecycle = 'failed', execution_state = 'error', updated_at = ?
           WHERE lifecycle = 'provisioning' AND provider_session_id IS NULL`,
        )
        .run(now);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.closeDatabase();
  }

  #require(sessionId: string): ManagedSession {
    const session = this.get(sessionId);
    if (session === undefined) throw new Error("Managed session not found");
    return session;
  }

  #requireProject(projectId: string): ManagedProject {
    const project = this.getProject(projectId);
    if (project === undefined) throw new Error("Managed project not found");
    return project;
  }

  #transaction(operation: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
