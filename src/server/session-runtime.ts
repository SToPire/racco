import type { WebSocket } from "ws";
import type {
  ContextUsage,
  SessionSummary,
  TimelineEvent,
} from "../shared/protocol.js";
import { SessionTimeline } from "./session-timeline.js";

export type ActiveTurn = {
  abortController: AbortController;
  terminalState?: "idle" | "interrupted" | "error";
};

/** Ephemeral execution/content state. Persistence and provider calls belong to the hub. */
export class SessionRuntime {
  readonly subscribers = new Set<WebSocket>();
  #summary: SessionSummary;
  #events = new SessionTimeline();
  #revision = 0;
  #readers = 0;
  #activeTurn?: ActiveTurn;

  constructor(summary: SessionSummary) {
    this.#summary = { ...summary };
  }
  get summary(): Readonly<SessionSummary> {
    return this.#summary;
  }
  get revision(): number {
    return this.#revision;
  }
  get readers(): number {
    return this.#readers;
  }
  get activeTurn(): ActiveTurn | undefined {
    return this.#activeTurn;
  }
  get hasActiveDescendants(): boolean {
    return this.#events.hasActiveDescendants;
  }
  get busy(): boolean {
    return this.#activeTurn !== undefined || this.#summary.compacting;
  }

  refreshSummary(summary: SessionSummary): void {
    if (summary.state !== this.#summary.state) this.#revision++;
    this.#summary = {
      ...summary,
      contextUsage: this.#summary.contextUsage,
      compacting: this.#summary.compacting,
    };
  }
  setContextUsage(usage: ContextUsage): void {
    this.#summary.contextUsage = usage;
    this.#revision++;
  }
  setCompacting(compacting: boolean): boolean {
    if (this.#summary.compacting === compacting) return false;
    if (compacting && this.#activeTurn !== undefined)
      throw new Error("Session is busy");
    this.#summary.compacting = compacting;
    this.#revision++;
    return true;
  }
  beginTurn(): ActiveTurn {
    if (this.busy) throw new Error("Session already has an active turn");
    const active = { abortController: new AbortController() };
    this.#activeTurn = active;
    return active;
  }
  finishTurn(active: ActiveTurn): void {
    if (this.#activeTurn === active) this.#activeTurn = undefined;
  }
  interrupt(): boolean {
    if (!this.#activeTurn) return false;
    this.#activeTurn.terminalState = "interrupted";
    this.#activeTurn.abortController.abort();
    return true;
  }
  retainRead(): () => void {
    this.#readers++;
    let retained = true;
    return () => {
      if (retained) {
        retained = false;
        this.#readers--;
      }
    };
  }
  append(event: TimelineEvent): void {
    this.#events.append(event);
    this.#revision++;
    this.#summary.updatedAt = new Date().toISOString();
  }
  replaceHistory(events: TimelineEvent[], expectedRevision?: number): boolean {
    if (
      expectedRevision !== undefined &&
      (this.#revision !== expectedRevision || this.busy)
    )
      return false;
    this.#events = new SessionTimeline(events);
    this.#revision++;
    return true;
  }
  snapshotEvents(): TimelineEvent[] {
    return this.#events.snapshot();
  }
}
