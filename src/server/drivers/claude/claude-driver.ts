import { randomUUID } from "node:crypto";
import {
  deleteSession,
  getSessionInfo,
  listSessions,
  query,
  startup,
  type CanUseTool,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  ModelSettings,
  ProviderModelCatalog,
} from "../../../shared/protocol.js";
import { claudeModelCatalog, ClaudeEffortSchema } from "../model-options.js";
import { resolveProjectDirectory } from "../../project-path.js";
import type {
  AgentDriver,
  DriverContext,
  ProviderSessionCreation,
  ProviderSessionHandle,
  ProviderSessionMetadata,
  ProviderSessionPage,
  ProviderSessionUpdate,
  SessionSnapshot,
} from "../driver.js";
import { ProviderSessionNotFoundError, SESSION_PAGE_SIZE } from "../driver.js";
import { ClaudeLiveMapper, mapClaudeHistory } from "./event-mapper.js";
import { readClaudeHistory } from "./history.js";

type ActiveQuery = {
  abortController: AbortController;
  close(): void;
};

// Project the fields rendered by Racco; the SDK also supplies header/preview metadata.
const ClaudeQuestionsSchema = z
  .array(
    z.object({
      question: z.string().min(1),
      options: z
        .array(
          z.object({
            label: z.string().min(1),
            description: z.string(),
          }),
        )
        .min(2)
        .max(4),
      multiSelect: z.boolean(),
    }),
  )
  .min(1)
  .max(4);

export class ClaudeDriver implements AgentDriver {
  readonly provider = "claude" as const;
  readonly #activeQueries = new Map<string, ActiveQuery>();
  #ready = false;
  #sessionUpdate?: (sessionId: string, update: ProviderSessionUpdate) => void;

  constructor(
    private readonly log: {
      warn(data: unknown, message: string): void;
    },
    private readonly sdk: {
      query: typeof query;
      startup: typeof startup;
      listSessions: typeof listSessions;
      deleteSession: typeof deleteSession;
    } = {
      query,
      startup,
      listSessions,
      deleteSession,
    },
  ) {}

  get ready(): boolean {
    return this.#ready;
  }

  async listSessions({
    cwd,
    cursor,
    signal,
  }: Parameters<AgentDriver["listSessions"]>[0]): Promise<ProviderSessionPage> {
    this.#assertReady();
    if (cursor !== undefined && !/^(0|[1-9]\d*)$/.test(cursor))
      throw new Error("Invalid Claude session cursor");
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset > Number.MAX_SAFE_INTEGER - SESSION_PAGE_SIZE
    )
      throw new Error("Invalid Claude session cursor");
    signal.throwIfAborted();
    const page = await this.sdk.listSessions({
      dir: cwd,
      includeWorktrees: false,
      includeProgrammatic: true,
      limit: SESSION_PAGE_SIZE + 1,
      offset,
    });
    const sessions: ProviderSessionPage["sessions"] = [];
    for (const info of page.slice(0, SESSION_PAGE_SIZE)) {
      signal.throwIfAborted();
      const metadata = await this.#mapMetadata(info, cwd);
      if (metadata)
        sessions.push({ providerSessionId: info.sessionId, ...metadata });
    }
    signal.throwIfAborted();
    return {
      sessions,
      nextCursor:
        page.length > SESSION_PAGE_SIZE
          ? String(offset + SESSION_PAGE_SIZE)
          : null,
    };
  }

  async start(): Promise<void> {
    try {
      const warm = await this.sdk.startup({ initializeTimeoutMs: 15_000 });
      this.#ready = true;
      try {
        warm.close();
      } catch (closeError) {
        this.log.warn(
          { err: closeError },
          "Claude native binary validated but warm handle close failed",
        );
      }
    } catch (error) {
      this.#ready = false;
      this.log.warn(
        { err: error },
        "Claude native binary validation failed: provider will be unavailable",
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#ready = false;
    this.#sessionUpdate = undefined;
    for (const active of this.#activeQueries.values()) {
      active.abortController.abort();
      active.close();
    }
    this.#activeQueries.clear();
  }

  onSessionUpdate(
    listener: (sessionId: string, update: ProviderSessionUpdate) => void,
  ): void {
    this.#sessionUpdate = listener;
  }

  async readSession(handle: ProviderSessionHandle): Promise<SessionSnapshot> {
    this.#assertReady();
    const info = await getSessionInfo(handle.providerSessionId, {
      dir: handle.cwd,
    });
    if (info === undefined) {
      throw new ProviderSessionNotFoundError("Claude session not found");
    }
    const metadata = await this.#mapMetadata(info, handle.cwd);
    if (metadata === undefined) {
      throw new Error("Claude session working directory is unavailable");
    }
    const messages = await readClaudeHistory(
      handle.providerSessionId,
      handle.cwd,
    );
    return { metadata, events: mapClaudeHistory(messages) };
  }

  async deleteSession(handle: ProviderSessionHandle): Promise<void> {
    this.#assertReady();
    // The SDK restricts its search to the given project directory, so the
    // transcript file of another project's session cannot be deleted.
    await this.sdk.deleteSession(handle.providerSessionId, {
      dir: handle.cwd,
    });
  }

  async listModels({
    cwd,
    signal,
  }: {
    cwd: string;
    signal: AbortSignal;
  }): Promise<ProviderModelCatalog> {
    this.#assertReady();
    signal.throwIfAborted();
    const abortController = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* input() {
      await gate;
      yield* [];
    }
    const onAbort = () => {
      release();
      abortController.abort(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let probe: ReturnType<typeof query> | undefined;
    try {
      probe = this.sdk.query({
        prompt: input(),
        options: { cwd, persistSession: false, abortController },
      });
      return claudeModelCatalog(await probe.supportedModels());
    } finally {
      signal.removeEventListener("abort", onAbort);
      release();
      abortController.abort();
      probe?.close();
    }
  }

  async createSession(input: {
    raccoSessionId: string;
    cwd: string;
    modelSettings: ModelSettings;
  }): Promise<ProviderSessionCreation> {
    this.#assertReady();
    const canonicalCwd = await resolveProjectDirectory(input.cwd);
    if (canonicalCwd === undefined) {
      throw new Error("Project directory is unavailable");
    }
    return {
      providerSessionId: randomUUID(),
      cwd: canonicalCwd,
      materialized: false,
    };
  }

  async runTurn(input: {
    handle: ProviderSessionHandle;
    mode: "first" | "resume";
    prompt: string;
    modelSettings: ModelSettings;
    context: DriverContext;
    signal: AbortSignal;
  }): Promise<void> {
    this.#assertReady();
    const sessionId = input.handle.providerSessionId;
    const cwd = await resolveProjectDirectory(input.handle.cwd);
    if (cwd === undefined || cwd !== input.handle.cwd) {
      throw new Error("Claude session working directory is unavailable");
    }

    const abortController = new AbortController();
    let activeQuery: ReturnType<typeof query> | undefined;
    const onAbort = () => {
      abortController.abort();
      activeQuery?.close();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();

    const mapper = new ClaudeLiveMapper();
    let sawResult = false;
    let turnSucceeded = false;
    try {
      const canUseTool: CanUseTool = async (toolName, toolInput, options) =>
        this.#handleToolRequest(input.context, toolName, toolInput, options);

      activeQuery = this.sdk.query({
        prompt: input.prompt,
        options: {
          abortController,
          canUseTool,
          cwd,
          model: input.modelSettings.modelId,
          ...(input.modelSettings.reasoningEffort === null
            ? {}
            : {
                effort: ClaudeEffortSchema.parse(
                  input.modelSettings.reasoningEffort,
                ),
              }),
          // Use the query's effort, without an inherited environment override that
          // would also force the same effort onto independently configured subagents.
          env: {
            ...process.env,
            CLAUDE_CODE_EFFORT_LEVEL: undefined,
          },
          includePartialMessages: true,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          systemPrompt: { type: "preset", preset: "claude_code" },
          ...(input.mode === "first" ? { sessionId } : { resume: sessionId }),
          stderr: (data) => {
            const message = data.trim();
            if (message.length > 0) {
              this.log.warn({ message }, "Claude Agent SDK stderr");
            }
          },
        },
      });
      this.#activeQueries.set(sessionId, {
        abortController,
        close: () => activeQuery?.close(),
      });

      for await (const message of activeQuery) {
        if (message.type === "system" && message.subtype === "init") {
          if (message.session_id !== sessionId) {
            throw new Error(
              "Claude Agent SDK returned an unexpected session id",
            );
          }
          input.context.markProviderMaterialized();
        }

        const events = mapper.map(message);
        for (const event of events) {
          input.context.emit(event);
        }

        if (message.type === "result") {
          sawResult = true;
          if (message.subtype !== "success") {
            throw new Error(message.errors.join("\n") || message.subtype);
          }
          if (message.is_error) {
            throw new Error(message.result || "Claude turn failed");
          }
          input.context.setState("idle");
          turnSucceeded = true;
        }
      }

      if (!sawResult && !input.signal.aborted) {
        throw new Error("Claude Agent SDK ended without a turn result");
      }
      if (input.signal.aborted) input.context.setState("interrupted");
    } catch (error) {
      if (input.signal.aborted || abortController.signal.aborted) {
        input.context.setState("interrupted");
        return;
      }
      throw error;
    } finally {
      for (const event of mapper.finish(
        input.signal.aborted || abortController.signal.aborted
          ? "interrupted"
          : "error",
      )) {
        input.context.emit(event);
      }
      input.signal.removeEventListener("abort", onAbort);
      activeQuery?.close();
      this.#activeQueries.delete(sessionId);
      if (turnSucceeded && !input.signal.aborted) {
        this.#emitMetadataRefresh(sessionId, cwd);
      }
    }
  }

  async #emitMetadataRefresh(sessionId: string, cwd: string): Promise<void> {
    const listener = this.#sessionUpdate;
    if (listener === undefined) return;
    try {
      const info = await getSessionInfo(sessionId, { dir: cwd });
      if (info === undefined) return;
      const metadata = await this.#mapMetadata(info, cwd);
      if (metadata === undefined) return;
      listener(sessionId, { type: "metadata.changed", metadata });
    } catch (error) {
      this.log.warn(
        { err: error, sessionId },
        "Claude post-turn metadata refresh failed",
      );
    }
  }

  async #handleToolRequest(
    context: DriverContext,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): ReturnType<CanUseTool> {
    if (toolName === "AskUserQuestion") {
      const questions = ClaudeQuestionsSchema.parse(input.questions);
      const response = await context.requestInteraction({
        title: options.title ?? "Claude 需要更多信息",
        questions: questions.map((question, index) => ({
          id: String(index),
          text: question.question,
          multiple: question.multiSelect,
          options: question.options,
          allowOther: true,
        })),
      });
      if (response.decision !== "answer") {
        return {
          behavior: "deny",
          message: response.message ?? "User declined to answer",
        };
      }
      const answers = Object.fromEntries(
        questions.map((question, index) => [
          question.question,
          (response.answers[String(index)] ?? []).join(", "),
        ]),
      );
      return {
        behavior: "allow",
        updatedInput: { ...input, answers },
      };
    }

    // Racco runs the Claude provider in full-permission mode
    // (permissionMode: "bypassPermissions"). The canUseTool callback is only
    // wired so that AskUserQuestion can surface to the UI; every other tool —
    // including internal control-flow tools like ExitPlanMode / EnterPlanMode
    // and side-effecting tools like Bash / FileEdit — is allowed immediately.
    return { behavior: "allow", updatedInput: input };
  }

  async #mapMetadata(
    info: SDKSessionInfo,
    expectedCwd: string,
  ): Promise<ProviderSessionMetadata | undefined> {
    if (info.cwd === undefined) return undefined;
    const cwd = await resolveProjectDirectory(info.cwd);
    if (cwd === undefined || cwd !== expectedCwd) return undefined;
    return {
      title: info.customTitle ?? (info.summary || undefined),
      updatedAt: new Date(info.lastModified).toISOString(),
    };
  }

  #assertReady(): void {
    if (!this.#ready) throw new Error("Claude provider is unavailable");
  }
}
