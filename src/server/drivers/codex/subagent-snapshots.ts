import { randomUUID } from "node:crypto";
import type {
  AgentTimelineEvent,
  SubagentState,
  ToolCompletionStatus,
} from "../../../shared/protocol.js";
import type {
  CodexThread,
  CodexTurn,
  CodexThreadItem,
  JsonRpcNotification,
  ItemNotification,
  DeltaNotification,
  TurnNotification,
  ErrorNotification,
  ThreadStatusNotification,
} from "./types.js";
import { mapItemEvents } from "./event-mapper.js";
import { CodexActivityMapper } from "./activity-mapper.js";
import { CodexToolLifecycle } from "./tool-lifecycle.js";
export type SubagentLink = {
  agentId: string;
  rootThreadId: string;
  name?: string;
  state?: SubagentState;
  snapshotGeneration: number;
  appliedSnapshotGeneration: number;
  currentTurn?: { id: string; terminal: boolean; completedItems: Set<string> };
};

export type SnapshotRead = {
  generation: number;
  changedItems: Set<string>;
  endedTurns: Set<string>;
  unalignedItems: Set<string>;
  endedThread: boolean;
  stateChanged: boolean;
  invalid: boolean;
};

export function subagentTurnState(turn: CodexTurn): SubagentState {
  if (turn.status === "inProgress") return "running";
  if (turn.status === "interrupted") return "interrupted";
  if (turn.status === "failed") return "error";
  return "completed";
}

/** Owns child identity, read generations, terminal precedence and delta alignment. No RPC or callbacks. */
export class CodexSubagentSnapshots {
  readonly #links = new Map<string, SubagentLink>();
  readonly #snapshotReads = new Map<string, Set<SnapshotRead>>();
  readonly #unalignedItems = new Map<string, Map<string, string>>();
  constructor(
    private readonly roots: Set<string>,
    private readonly activity: CodexActivityMapper,
    private readonly tools: CodexToolLifecycle,
    private readonly output: Map<
      string,
      { output: string; live: boolean; generation: number }
    >,
  ) {}
  get(id: string) {
    return this.#links.get(id);
  }
  entries() {
    return this.#links.entries();
  }
  delete(id: string) {
    this.invalidate(id);
    this.#links.delete(id);
  }
  clear() {
    this.clearReads();
    this.#links.clear();
  }
  invalidate(id: string) {
    for (const read of this.#snapshotReads.get(id) ?? []) read.invalid = true;
    this.#unalignedItems.delete(id);
  }
  acceptsTurnState(id: string, turnId: string): boolean {
    const current = this.#links.get(id)?.currentTurn;
    return current === undefined || current.id === turnId;
  }
  setState(id: string, state: SubagentState) {
    const link = this.#links.get(id);
    if (!link) return;
    link.state = state;
    if (state !== "starting" && state !== "running") {
      if (link.currentTurn) {
        link.currentTurn.terminal = true;
        link.currentTurn.completedItems.clear();
      }
      this.#unalignedItems.delete(id);
    }
  }
  beginRead(id: string, root: string): SnapshotRead {
    const link = this.remember(id, root);
    const read: SnapshotRead = {
      generation: ++link.snapshotGeneration,
      changedItems: new Set(),
      endedTurns: new Set(),
      unalignedItems: new Set(),
      endedThread: false,
      stateChanged: false,
      invalid: false,
    };
    let reads = this.#snapshotReads.get(id);
    if (!reads) {
      reads = new Set();
      this.#snapshotReads.set(id, reads);
    }
    reads.add(read);
    return read;
  }
  endRead(id: string, read: SnapshotRead) {
    const reads = this.#snapshotReads.get(id);
    reads?.delete(read);
    if (reads?.size === 0) this.#snapshotReads.delete(id);
  }
  seedStarted(thread: CodexThread, root: string) {
    return this.seed(
      thread,
      root,
      ++this.remember(thread.id, root).snapshotGeneration,
    );
  }
  resolver(rootThreadId: string) {
    return (threadId: string): string | undefined => {
      const link = this.#links.get(threadId);
      return link?.rootThreadId === rootThreadId ? link.agentId : undefined;
    };
  }

  registerThreadSpawns(thread: CodexThread, rootThreadId: string): void {
    for (const turn of thread.turns)
      for (const item of turn.items) this.registerSpawn(item, rootThreadId);
  }

  registerSpawn(item: CodexThreadItem, rootThreadId: string): void {
    if (item.type === "subAgentActivity" && item.kind === "started") {
      this.remember(item.agentThreadId, rootThreadId);
    } else if (
      item.type === "collabAgentToolCall" &&
      item.tool === "spawnAgent"
    ) {
      for (const threadId of item.receiverThreadIds)
        this.remember(threadId, rootThreadId);
    }
  }

  remember(providerThreadId: string, rootThreadId: string): SubagentLink {
    if (providerThreadId === rootThreadId || this.roots.has(providerThreadId)) {
      throw new Error("Codex root thread cannot be registered as a subagent");
    }
    const existing = this.#links.get(providerThreadId);
    if (existing !== undefined) {
      if (existing.rootThreadId !== rootThreadId) {
        throw new Error("Codex subagent belongs to multiple root threads");
      }
      return existing;
    }
    const link: SubagentLink = {
      agentId: randomUUID(),
      rootThreadId,
      snapshotGeneration: 0,
      appliedSnapshotGeneration: 0,
    };
    this.#links.set(providerThreadId, link);
    return link;
  }

  seed(
    thread: CodexThread,
    rootThreadId: string,
    generation: number,
    read?: SnapshotRead,
  ): boolean {
    if (read?.endedThread || read?.invalid) return false;
    const link = this.#links.get(thread.id)!;
    if (generation < link.appliedSnapshotGeneration) return false;
    const latest = thread.turns.at(-1);
    const previousTurn = link.currentTurn;
    if (
      previousTurn !== undefined &&
      (!thread.turns.some((turn) => turn.id === previousTurn.id) ||
        (previousTurn.terminal &&
          latest?.id === previousTurn.id &&
          latest.status === "inProgress"))
    ) {
      if (read) throw new Error("Codex 子任务快照早于已观测的轮次状态，请重试");
      return false;
    }
    if (
      previousTurn !== undefined &&
      thread.turns.some(
        (turn) =>
          turn.id === previousTurn.id &&
          turn.status === "inProgress" &&
          turn.items.some(
            (item) =>
              !read?.changedItems.has(item.id) &&
              previousTurn.completedItems.has(item.id) &&
              (("status" in item && item.status === "inProgress") ||
                (item.type === "webSearch" && item.action === null)),
          ),
      )
    ) {
      if (read) throw new Error("Codex 子任务快照早于已观测的工具终态，请重试");
      return false;
    }
    if (
      latest !== undefined &&
      (previousTurn === undefined || latest.id !== previousTurn.id)
    ) {
      link.currentTurn = {
        id: latest.id,
        terminal: latest.status !== "inProgress",
        completedItems: new Set(),
      };
    }
    if (latest !== undefined && !read?.stateChanged) {
      link.state = subagentTurnState(latest);
      if (
        latest.status !== "inProgress" &&
        link.currentTurn?.id === latest.id
      ) {
        link.currentTurn.terminal = true;
        link.currentTurn.completedItems.clear();
      }
    }
    link.appliedSnapshotGeneration = generation;
    this.registerThreadSpawns(thread, rootThreadId);
    const subagents = this.resolver(rootThreadId);
    for (const turn of thread.turns) {
      if (read?.endedTurns.has(turn.id)) continue;
      if (turn.status !== "inProgress") {
        this.#clearUnalignedTurn(thread.id, turn.id);
        if (!turn.items.some((item) => read?.changedItems.has(item.id))) {
          this.activity.finish(thread.id, undefined, turn.id);
          this.finishTools(thread.id, "incomplete", turn.id);
        }
        continue;
      }
      for (const item of turn.items) {
        if (read?.changedItems.has(item.id)) continue;
        if (
          link.currentTurn?.id === turn.id &&
          link.currentTurn.completedItems.has(item.id)
        ) {
          continue;
        }
        this.activity.seed(thread.id, turn.id, item, generation);
        if (item.type === "commandExecution") {
          const key = `${thread.id}:${item.id}`;
          const previous = this.output.get(key);
          if (item.status !== "inProgress") this.output.delete(key);
          else if (
            !previous?.live &&
            (previous?.generation ?? -1) <= generation
          ) {
            this.output.set(key, {
              output: item.aggregatedOutput ?? "",
              live: false,
              generation,
            });
          }
        }
        this.tools.observe(
          thread.id,
          turn.id,
          mapItemEvents(item, subagents, "snapshot"),
        );
        if (
          (("status" in item && item.status !== "inProgress") ||
            (item.type === "webSearch" && item.action !== null)) &&
          link.currentTurn?.id === turn.id
        )
          link.currentTurn.completedItems.add(item.id);
        this.#unalignedItems.get(thread.id)?.delete(item.id);
      }
      if (this.#unalignedItems.get(thread.id)?.size === 0)
        this.#unalignedItems.delete(thread.id);
    }
    return true;
  }

  observe(threadId: string, notification: JsonRpcNotification): boolean {
    const reads = this.#snapshotReads.get(threadId);
    const link = this.#links.get(threadId);
    if (
      notification.method === "item/started" ||
      notification.method === "item/completed"
    ) {
      const { item, turnId } = notification.params as ItemNotification;
      if (link !== undefined && link.currentTurn === undefined)
        link.currentTurn = {
          id: turnId,
          terminal: false,
          completedItems: new Set(),
        };
      if (
        notification.method === "item/completed" &&
        link?.currentTurn?.id === turnId
      )
        link.currentTurn.completedItems.add(item.id);
      for (const read of reads ?? []) {
        read.changedItems.add(item.id);
        read.unalignedItems.delete(item.id);
      }
      const unaligned = this.#unalignedItems.get(threadId);
      unaligned?.delete(item.id);
      if (unaligned?.size === 0) this.#unalignedItems.delete(threadId);
    } else if (
      [
        "item/commandExecution/outputDelta",
        "item/agentMessage/delta",
        "item/plan/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
      ].includes(notification.method)
    ) {
      const delta = notification.params as DeltaNotification;
      if (
        link?.currentTurn?.id === delta.turnId &&
        (link.currentTurn.terminal ||
          link.currentTurn.completedItems.has(delta.itemId))
      )
        return true;
      for (const read of reads ?? []) read.changedItems.add(delta.itemId);
      const aligned =
        notification.method === "item/commandExecution/outputDelta"
          ? this.output.has(`${threadId}:${delta.itemId}`)
          : this.activity.hasContent(threadId, delta.itemId);
      if (
        !aligned &&
        (link !== undefined ||
          (reads?.size ?? 0) > 0 ||
          this.#unalignedItems.get(threadId)?.has(delta.itemId))
      ) {
        let unaligned = this.#unalignedItems.get(threadId);
        if (unaligned === undefined) {
          unaligned = new Map();
          this.#unalignedItems.set(threadId, unaligned);
        }
        unaligned.set(delta.itemId, delta.turnId);
        for (const read of reads ?? []) read.unalignedItems.add(delta.itemId);
        return true;
      }
    } else if (notification.method === "turn/started") {
      const { turn } = notification.params as TurnNotification;
      for (const read of reads ?? []) read.stateChanged = true;
      if (link !== undefined)
        link.currentTurn = {
          id: turn.id,
          terminal: false,
          completedItems: new Set(),
        };
    } else if (notification.method === "turn/completed") {
      const { turn } = notification.params as TurnNotification;
      if (
        link !== undefined &&
        (link.currentTurn === undefined || link.currentTurn.id === turn.id)
      ) {
        link.currentTurn = {
          id: turn.id,
          terminal: true,
          completedItems: new Set(),
        };
      }
      for (const read of reads ?? []) {
        read.endedTurns.add(turn.id);
        read.stateChanged = true;
      }
      this.#clearUnalignedTurn(threadId, turn.id);
    } else if (notification.method === "error") {
      const error = notification.params as ErrorNotification;
      if (!error.willRetry) {
        for (const read of reads ?? []) {
          read.endedTurns.add(error.turnId);
          read.stateChanged = true;
        }
        this.#clearUnalignedTurn(threadId, error.turnId);
      }
    } else if (notification.method === "thread/status/changed") {
      const { status } = notification.params as ThreadStatusNotification;
      for (const read of reads ?? []) read.stateChanged = true;
      if (status.type !== "active") {
        for (const read of reads ?? []) read.endedThread = true;
        this.#unalignedItems.delete(threadId);
      }
    } else if (notification.method === "thread/deleted") {
      for (const read of reads ?? []) read.invalid = true;
      this.#unalignedItems.delete(threadId);
    }
    return false;
  }

  #clearUnalignedTurn(threadId: string, turnId: string): void {
    const unaligned = this.#unalignedItems.get(threadId);
    for (const [id, ownerTurnId] of unaligned ?? []) {
      if (ownerTurnId === turnId) unaligned!.delete(id);
    }
    if (unaligned?.size === 0) this.#unalignedItems.delete(threadId);
  }

  clearReads(): void {
    for (const reads of this.#snapshotReads.values()) {
      for (const read of reads) read.invalid = true;
    }
    this.#snapshotReads.clear();
    this.#unalignedItems.clear();
  }

  finishTools(
    threadId: string,
    status: Exclude<ToolCompletionStatus, "completed">,
    turnId?: string,
  ): AgentTimelineEvent[] {
    const events = this.tools.finish(threadId, status, turnId);
    for (const event of events) this.output.delete(`${threadId}:${event.id}`);
    return events;
  }
}
