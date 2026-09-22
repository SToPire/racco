import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureModelCatalog } from "../model-catalog.js";
import { setTimeout as delay } from "node:timers/promises";
import type { Provider, TimelineEvent } from "../../src/shared/protocol.js";
import type {
  AgentDriver,
  ProviderSessionHandle,
  SessionSnapshot,
  ProviderSessionUpdate,
} from "../../src/server/drivers/driver.js";

/** Deterministic test provider; it never starts a model process or executes tools. */
export class FixtureDriver implements AgentDriver {
  ready = false;
  #sessionUpdate?: (id: string, update: ProviderSessionUpdate) => void;
  onSessionUpdate(
    listener: (id: string, update: ProviderSessionUpdate) => void,
  ) {
    this.#sessionUpdate = listener;
  }
  constructor(
    readonly provider: Provider,
    private readonly directory: string,
  ) {}
  async start() {
    await mkdir(this.directory, { recursive: true });
    this.ready = true;
  }
  async close() {
    this.ready = false;
  }
  async listModels() {
    return fixtureModelCatalog();
  }
  async listSessions({
    cwd,
    cursor,
    signal,
  }: Parameters<AgentDriver["listSessions"]>[0]) {
    const snapshots = [];
    for (const name of await readdir(this.directory)) {
      signal.throwIfAborted();
      const snapshot = JSON.parse(
        await readFile(join(this.directory, name), "utf8"),
      ) as SessionSnapshot & { cwd: string };
      if (snapshot.cwd === cwd)
        snapshots.push({
          providerSessionId: name.slice(0, -5),
          ...snapshot.metadata,
        });
    }
    snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = Number(cursor ?? 0);
    return {
      sessions: snapshots.slice(offset, offset + 50),
      nextCursor: snapshots.length > offset + 50 ? String(offset + 50) : null,
    };
  }
  private file(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id))
      throw new Error("Invalid fixture session ID");
    return join(this.directory, `${id}.json`);
  }
  async readSession(handle: ProviderSessionHandle): Promise<SessionSnapshot> {
    const snapshot = JSON.parse(
      await readFile(this.file(handle.providerSessionId), "utf8"),
    ) as SessionSnapshot & { cwd: string };
    if (snapshot.cwd !== handle.cwd)
      throw new Error("Session belongs to a different project");
    return snapshot;
  }
  async deleteSession(handle: ProviderSessionHandle): Promise<void> {
    const snapshot = JSON.parse(
      await readFile(this.file(handle.providerSessionId), "utf8"),
    ) as SessionSnapshot & { cwd: string };
    if (snapshot.cwd !== handle.cwd)
      throw new Error("Session belongs to a different project");
    await rm(this.file(handle.providerSessionId), { force: false });
  }
  async seed(id: string, title: string, cwd: string) {
    const snapshot: SessionSnapshot & { cwd: string } = {
      cwd,
      metadata: { title, updatedAt: new Date().toISOString() },
      events: [
        {
          type: "user.message",
          id: "fixture-user",
          text: "检查项目文件与会话视图。",
        },
        {
          type: "tool.started",
          id: "fixture-tool",
          tool: "read_file",
          input: { path: "README.md" },
        },
        {
          type: "tool.completed",
          id: "fixture-tool",
          status: "completed",
          output: "# Fixture project\nNo external providers are used.",
        },
        {
          type: "assistant.message",
          id: "fixture-reply",
          text: "这是固定的开发测试场景。\n\n可以查看 `Files`、切换 **Trajectory**，或发送消息验证交互。",
        },
      ],
    };
    await writeFile(this.file(id), JSON.stringify(snapshot));
  }
  async createSession(input: Parameters<AgentDriver["createSession"]>[0]) {
    const providerSessionId = randomUUID();
    await writeFile(
      this.file(providerSessionId),
      JSON.stringify({
        cwd: input.cwd,
        metadata: {
          title: "Fixture session",
          updatedAt: new Date().toISOString(),
        },
        events: [],
      }),
    );
    return { providerSessionId, cwd: input.cwd, materialized: true };
  }
  async runTurn(input: Parameters<AgentDriver["runTurn"]>[0]) {
    const snapshot = await this.readSession(input.handle);
    snapshot.events.push({
      type: "user.message",
      id: randomUUID(),
      text: input.prompt,
    });
    const emit = (event: TimelineEvent) => {
      snapshot.events.push(event);
      input.context.emit(event);
    };
    try {
      if (input.prompt === "wait")
        await delay(60_000, undefined, { signal: input.signal });
      else await delay(40, undefined, { signal: input.signal });
      if (input.prompt === "error") throw new Error("Fixture provider failure");
      let suffix = "";
      if (input.prompt === "question") {
        const answer = await input.context.requestInteraction({
          title: "Fixture question",
          questions: [
            {
              id: "choice",
              text: "选择一个选项",
              multiple: false,
              options: [{ label: "Alpha" }, { label: "Beta" }],
            },
          ],
        });
        suffix = ` (${answer.decision})`;
      }
      emit({
        type: "assistant.message",
        id: randomUUID(),
        text: `Fixture: ${input.prompt}${suffix}`,
      });
      if (this.provider === "codex")
        this.#sessionUpdate?.(input.handle.providerSessionId, {
          type: "context.usage",
          usage: { usedTokens: 81920, maxTokens: 272000 },
        });
      input.context.setState("idle");
    } finally {
      snapshot.metadata.updatedAt = new Date().toISOString();
      await writeFile(
        this.file(input.handle.providerSessionId),
        JSON.stringify(snapshot),
      );
    }
  }

  async compact(input: Parameters<NonNullable<AgentDriver["compact"]>>[0]) {
    if (this.provider !== "codex") throw new Error("Compaction unsupported");
    const snapshot = await this.readSession(input.handle);
    if (
      snapshot.events.some(
        (event) =>
          event.type === "user.message" && event.text === "compact-error",
      )
    )
      throw new Error("Fixture compaction failed");
    const id = input.handle.providerSessionId;
    void delay(1500)
      .then(async () => {
        if (
          snapshot.events.some(
            (event) =>
              event.type === "user.message" &&
              event.text === "compact-async-error",
          )
        )
          throw new Error("Fixture asynchronous compaction failed");
        this.#sessionUpdate?.(id, {
          type: "context.usage",
          usage: { usedTokens: 12000, maxTokens: 272000 },
        });
        const event: TimelineEvent = {
          type: "system.notice",
          id: randomUUID(),
          level: "info",
          text: "上下文已压缩",
        };
        snapshot.events.push(event);
        await writeFile(this.file(id), JSON.stringify(snapshot));
        this.#sessionUpdate?.(id, event);
      })
      .catch((error: unknown) => {
        this.#sessionUpdate?.(id, {
          type: "system.notice",
          id: randomUUID(),
          level: "error",
          text: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() =>
        this.#sessionUpdate?.(id, { type: "compaction.finished" }),
      );
  }
}
