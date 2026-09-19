import type { DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 8;

export function initializeStateSchema(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get()!.user_version;
  if (version === CURRENT_SCHEMA_VERSION) return;
  const hasTables =
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get() !== undefined;
  if (version !== 0 || hasTables) {
    throw new Error(
      `Racco state schema ${version} is unsupported; remove the state database and restart`,
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
        provider_session_id TEXT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        cwd TEXT NOT NULL,
        title TEXT,
        lifecycle TEXT NOT NULL CHECK (
          lifecycle IN ('provisioning', 'active', 'failed')
        ),
        provider_state TEXT NOT NULL CHECK (
          provider_state IN ('allocated', 'materialized', 'missing')
        ),
        execution_state TEXT NOT NULL CHECK (
          execution_state IN (
            'idle', 'running', 'waiting_interaction', 'interrupted', 'error'
          )
        ),
        create_request_id TEXT UNIQUE,
        create_request_hash TEXT,
        selected_model_settings TEXT CHECK (selected_model_settings IS NULL OR json_valid(selected_model_settings)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((create_request_id IS NULL) = (create_request_hash IS NULL))
      );

      CREATE UNIQUE INDEX sessions_provider_native_id
        ON sessions(provider, provider_session_id)
        WHERE provider_session_id IS NOT NULL;

      CREATE INDEX sessions_updated_at
        ON sessions(updated_at DESC);

      PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
