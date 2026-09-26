import { HistoryQuerySchema } from "../shared/protocol.js";
import { HistoryCursorError } from "./history-page.js";
import type { AgentDriver } from "./drivers/driver.js";
import type { BuildInfo } from "./runtime/build-info.js";
import { CURRENT_SCHEMA_VERSION } from "./state/schema.js";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import {
  ClientCommandSchema,
  ProviderSchema,
  type HealthResponse,
  type ServerMessage,
} from "../shared/protocol.js";
import type { RaccoConfig } from "./config.js";
import { projectFileRoutes } from "./project-files/routes.js";
import { directoryRoutes } from "./directories/routes.js";
import { SessionHub } from "./session-hub.js";
import { WorktreeDirtyError } from "./worktrees/manager.js";
import { openRaccoStateDatabase } from "./state/database.js";
import { SessionRepository } from "./state/session-repository.js";

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function hasAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
) {
  if (origin === undefined) return true;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export type ServerOptions = {
  createDrivers: (log: FastifyBaseLogger) => AgentDriver[];
  build: BuildInfo;
  webRoot?: string;
  logger?: boolean;
};

export async function buildServer(
  config: RaccoConfig,
  options: ServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  const startedAt = new Date().toISOString();
  const providerFailures = new Map<string, string>();

  await app.register(fastifyCompress, { global: true });
  await app.register(directoryRoutes);
  const state = openRaccoStateDatabase(config.stateDir);
  const repository = new SessionRepository(state.database, state.close);
  await app.register(projectFileRoutes, {
    worktreeIsAvailable: (path: string) => hub.worktreePathIsReadable(path),
  });
  const drivers = options.createDrivers(app.log);
  const hub = new SessionHub(drivers, repository, config.worktreeRoot);
  app.addHook("onClose", async () => {
    await hub.close();
  });
  try {
    for (const driver of drivers) {
      try {
        await driver.start();
      } catch (error) {
        providerFailures.set(
          driver.provider,
          error instanceof Error ? error.message : String(error),
        );
        app.log.error(
          { err: error, provider: driver.provider },
          "Provider initialization failed",
        );
        await driver.close();
      }
    }
    await hub.initialize();
    await app.register(fastifyWebsocket, {
      options: {
        perMessageDeflate: {
          // Compress large snapshots without retaining a dictionary per socket.
          serverNoContextTakeover: true,
          clientNoContextTakeover: true,
          threshold: 1024,
        },
      },
    });
  } catch (error) {
    await hub.close();
    throw error;
  }

  app.get("/api/diagnostics", async () => ({
    build: options.build,
    process: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
    },
    storage: {
      stateDir: config.stateDir,
      worktreeRoot: config.worktreeRoot,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    },
    providers: Object.fromEntries(
      ["codex", "claude"].map((provider) => [
        provider,
        {
          status: hub.providerStatus(provider as "codex" | "claude"),
          ...(providerFailures.has(provider)
            ? { reason: providerFailures.get(provider) }
            : {}),
        },
      ]),
    ),
  }));

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    providers: {
      codex: hub.providerStatus("codex"),
      claude: hub.providerStatus("claude"),
    },
  }));

  const ModelsQuerySchema = z.strictObject({
    path: z.string().min(1),
  });
  app.get<{ Params: { provider: string }; Querystring: unknown }>(
    "/api/providers/:provider/models",
    async (request, reply) => {
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        !hasAllowedOrigin(request.headers.origin, request.headers.host)
      ) {
        return reply.code(403).send({ message: "不允许跨站读取模型目录" });
      }
      const provider = ProviderSchema.safeParse(request.params.provider);
      const query = ModelsQuerySchema.safeParse(request.query);
      if (!provider.success || !query.success)
        return reply
          .code(400)
          .send({ message: "Invalid model catalog request" });
      try {
        reply.header("Cache-Control", "no-store");
        return await hub.listModels(provider.data, query.data.path);
      } catch (error) {
        return reply.code(400).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  const WorktreesQuerySchema = z.strictObject({
    projectId: z.string().min(1),
  });
  app.get<{ Querystring: unknown }>(
    "/api/worktrees",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        !hasAllowedOrigin(request.headers.origin, request.headers.host)
      )
        return reply
          .code(403)
          .send({ message: "不允许跨站读取 Worktree 列表" });
      const query = WorktreesQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply
          .code(400)
          .send({ message: "Invalid worktree list request" });
      try {
        return await hub.listWorktrees(query.data.projectId);
      } catch (error) {
        return reply.code(404).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  // Re-reads from Git. This is the only path by which an external change — a
  // `git worktree add` in a terminal — reaches Racco; nothing polls.
  app.post<{ Querystring: unknown }>(
    "/api/worktrees/refresh",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        !hasAllowedOrigin(request.headers.origin, request.headers.host)
      )
        return reply
          .code(403)
          .send({ message: "不允许跨站刷新 Worktree 列表" });
      const query = WorktreesQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply
          .code(400)
          .send({ message: "Invalid worktree refresh request" });
      try {
        return await hub.refreshWorktrees(query.data.projectId);
      } catch (error) {
        return reply.code(400).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  const CreateWorktreeSchema = z.strictObject({
    name: z.string().min(1),
    baseRef: z.string().min(1).optional(),
  });
  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/worktrees",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        !hasAllowedOrigin(request.headers.origin, request.headers.host)
      )
        return reply.code(403).send({ message: "不允许跨站创建 Worktree" });
      const parsed = CreateWorktreeSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ message: "Invalid worktree creation request" });
      try {
        const created = await hub.createWorktree({
          projectId: request.params.projectId,
          name: parsed.data.name,
          ...(parsed.data.baseRef === undefined
            ? {}
            : { baseRef: parsed.data.baseRef }),
        });
        return created.catalog;
      } catch (error) {
        return reply.code(400).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  const DeleteWorktreeSchema = z.strictObject({
    projectId: z.string().min(1),
    path: z.string().min(1),
    force: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined ? false : value === "true" || value === "1",
      ),
    deleteBranch: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined ? false : value === "true" || value === "1",
      ),
  });
  app.delete<{ Querystring: unknown }>(
    "/api/worktrees",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        !hasAllowedOrigin(request.headers.origin, request.headers.host)
      )
        return reply.code(403).send({ message: "不允许跨站删除 Worktree" });
      const query = DeleteWorktreeSchema.safeParse(request.query);
      if (!query.success)
        return reply
          .code(400)
          .send({ message: "Invalid worktree delete request" });
      try {
        return await hub.deleteWorktree(query.data);
      } catch (error) {
        if (error instanceof WorktreeDirtyError) {
          // The client must re-confirm and retry with force=true before a dirty
          // directory is discarded; this is a decision point, not a failure.
          return reply.code(409).send({
            message: error.message,
          });
        }
        return reply.code(400).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  const SessionListQuerySchema = z.strictObject({});
  const NativeSessionsQuerySchema = z.strictObject({
    provider: ProviderSchema,
    path: z.string().min(1),
    cursor: z.string().min(1).max(8192).optional(),
  });
  app.get<{ Querystring: unknown }>(
    "/api/worktrees/native-sessions",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        !hasAllowedOrigin(request.headers.origin, request.headers.host)
      )
        return reply.code(403).send({ message: "不允许跨站读取会话列表" });
      const query = NativeSessionsQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply
          .code(400)
          .send({ message: "Invalid native session list request" });
      try {
        return await hub.listNativeSessions(
          query.data.provider,
          query.data.path,
          query.data.cursor,
        );
      } catch (error) {
        return reply.code(400).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  app.get<{ Querystring: unknown }>("/api/sessions", async (request, reply) => {
    if (!SessionListQuerySchema.safeParse(request.query).success) {
      return reply
        .code(400)
        .send({ message: "Session list does not accept query parameters" });
    }
    return hub.listSessions();
  });

  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      const snapshot = await hub.historySnapshot({
        sessionId: request.params.sessionId,
      });
      return snapshot ?? reply.code(404).send({ message: "Session not found" });
    },
  );

  app.get<{ Params: { sessionId: string }; Querystring: unknown }>(
    "/api/sessions/:sessionId/history",
    async (request, reply) => {
      const parsed = HistoryQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ message: "Invalid history query" });
      try {
        return await hub.historyPage(
          { sessionId: request.params.sessionId },
          {
            ...parsed.data,
            refresh: parsed.data.refresh === "true",
          },
        );
      } catch (error) {
        return reply
          .code(error instanceof HistoryCursorError ? 409 : 400)
          .send({
            message: error instanceof Error ? error.message : String(error),
          });
      }
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      try {
        const removed = hub.deleteSession(request.params.sessionId);
        if (removed === undefined) {
          return reply.code(404).send({ message: "Session not found" });
        }
        return reply.code(204).send();
      } catch (error) {
        return reply.code(500).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  const DeleteProjectQuerySchema = z.strictObject({
    removeWorktrees: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined ? false : value === "true" || value === "1",
      ),
  });
  app.delete<{ Params: { projectId: string }; Querystring: unknown }>(
    "/api/projects/:projectId",
    async (request, reply) => {
      try {
        const query = DeleteProjectQuerySchema.safeParse(request.query);
        if (!query.success) {
          return reply
            .code(400)
            .send({ message: "Invalid project delete request" });
        }
        const removed = await hub.deleteProject(
          request.params.projectId,
          query.data.removeWorktrees,
        );
        if (removed === undefined) {
          return reply.code(404).send({ message: "Project not found" });
        }
        return reply.code(204).send();
      } catch (error) {
        return reply.code(500).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  const ImportSessionSchema = z.strictObject({
    provider: ProviderSchema,
    providerSessionId: z.string().min(1),
    projectId: z.string().min(1),
    path: z.string().min(1),
  });
  const DeleteNativeSessionSchema = z.strictObject({
    provider: ProviderSchema,
    providerSessionId: z.string().min(1),
    projectId: z.string().min(1),
    path: z.string().min(1),
  });
  app.post<{ Body: unknown }>(
    "/api/sessions/import",
    async (request, reply) => {
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        !hasAllowedOrigin(request.headers.origin, request.headers.host)
      )
        return reply.code(403).send({ message: "不允许跨站导入会话" });
      const parsed = ImportSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ message: "Invalid session import request" });
      }
      try {
        return await hub.importSession(parsed.data);
      } catch (error) {
        return reply.code(400).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post<{ Body: unknown }>(
    "/api/sessions/delete-native",
    async (request, reply) => {
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        !hasAllowedOrigin(request.headers.origin, request.headers.host)
      )
        return reply.code(403).send({ message: "不允许跨站删除会话" });
      const parsed = DeleteNativeSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ message: "Invalid native session delete request" });
      }
      try {
        return await hub.deleteNativeSession(parsed.data);
      } catch (error) {
        return reply.code(400).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.get("/api/projects", async () => hub.listProjects());

  const ImportProjectSchema = z.strictObject({ path: z.string().min(1) });
  app.post<{ Body: unknown }>("/api/projects", async (request, reply) => {
    const parsed = ImportProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ message: "Invalid project import request" });
    }
    try {
      return await hub.importProject(parsed.data.path);
    } catch (error) {
      return reply.code(400).send({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get(
    "/api/ws",
    {
      websocket: true,
      preValidation: (request, reply, done) => {
        if (!hasAllowedOrigin(request.headers.origin, request.headers.host)) {
          void reply
            .code(403)
            .send({ message: "WebSocket origin is not allowed" });
          return;
        }
        done();
      },
    },
    (socket) => {
      hub.registerClient(socket);
      socket.on("message", (raw) => {
        void (async () => {
          let decoded: unknown;
          try {
            decoded = JSON.parse(raw.toString());
          } catch {
            send(socket, {
              type: "error",
              message: "Message must be valid JSON",
            });
            return;
          }

          const parsed = ClientCommandSchema.safeParse(decoded);
          if (!parsed.success) {
            send(socket, {
              type: "error",
              message: "Message does not match the Racco protocol",
            });
            return;
          }

          const command = parsed.data;
          try {
            if (command.type === "session.subscribe") {
              const snapshot = await hub.subscribe(socket, command);
              if (snapshot === undefined) throw new Error("Session not found");
              send(socket, { type: "ack", requestId: command.requestId });
              send(socket, snapshot);
              return;
            }

            if (command.type === "session.create") {
              const created = await hub.createSession(
                socket,
                command.provider,
                command.projectId,
                command.path,
                command.requestId,
                command.prompt,
                command.modelSettings,
              );
              await hub.startTurn(
                created.ref,
                command.prompt,
                `create:${command.requestId}`,
                command.modelSettings,
              );
              send(socket, {
                type: "ack",
                requestId: command.requestId,
                data: created.ref,
              });
              const snapshot = await hub.subscribe(socket, created.ref);
              if (snapshot) send(socket, snapshot);
              return;
            }

            if (command.type === "turn.start") {
              await hub.startTurn(
                command,
                command.prompt,
                command.requestId,
                command.modelSettings,
              );
              send(socket, { type: "ack", requestId: command.requestId });
              return;
            }

            if (command.type === "turn.interrupt") {
              if (!hub.interrupt(command)) throw new Error("No active turn");
              send(socket, { type: "ack", requestId: command.requestId });
              return;
            }

            if (command.type === "session.compact") {
              await hub.compact(command);
              send(socket, { type: "ack", requestId: command.requestId });
              return;
            }

            if (command.type === "interaction.resolve") {
              if (
                !hub.resolveInteraction(command.interactionId, command.response)
              ) {
                throw new Error("Interaction already resolved or not found");
              }
              send(socket, { type: "ack", requestId: command.requestId });
              return;
            }
          } catch (error) {
            send(socket, {
              type: "error",
              requestId: command.requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      });

      socket.on("close", () => hub.unregisterClient(socket));
      socket.on("error", (error) => {
        app.log.warn({ error }, "WebSocket client error");
        hub.unregisterClient(socket);
      });
    },
  );

  const webRoot = options.webRoot;
  if (webRoot !== undefined) {
    await app.register(fastifyStatic, {
      root: webRoot,
      setHeaders(reply, path) {
        // Vite 构建产物都带内容 hash，是内容寻址的，可永久缓存。
        // index.html 不带 hash，必须每次校验，否则部署新版本后手机永远看不到更新。
        if (path.endsWith("index.html")) {
          reply.header("Cache-Control", "public, max-age=0, must-revalidate");
        } else {
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        return reply.code(404).send({ message: "Not found" });
      }
      return reply.type("text/html").sendFile("index.html");
    });
  }

  return app;
}
