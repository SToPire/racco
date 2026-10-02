import { randomUUID } from "node:crypto";
import type {
  InteractionRequest,
  InteractionResponse,
  ServerMessage,
} from "../shared/protocol.js";

type InteractionEvent = Extract<
  ServerMessage,
  { type: "interaction.requested" | "interaction.resolved" }
>;
type Pending = {
  sessionId: string;
  request: InteractionRequest;
  resolve(value: InteractionResponse): void;
  reject(error: unknown): void;
  detach(): void;
};

/** Owns one-shot settlement, native cancellation and session-wide cleanup. */
export class SessionInteractions {
  readonly #pending = new Map<string, Pending>();
  constructor(
    private readonly changed: (
      sessionId: string,
      event: InteractionEvent,
      pendingCount: number,
    ) => void,
  ) {}

  forSession(sessionId: string): InteractionRequest[] {
    return [...this.#pending.values()]
      .filter((item) => item.sessionId === sessionId)
      .map((item) => item.request);
  }
  async request(
    sessionId: string,
    request: Omit<InteractionRequest, "id">,
    signal?: AbortSignal,
  ): Promise<InteractionResponse> {
    signal?.throwIfAborted();
    const interaction = { ...request, id: randomUUID() };
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.#close(interaction.id, pending))
          reject(signal?.reason ?? new Error("Question cancelled"));
      };
      const pending: Pending = {
        sessionId,
        request: interaction,
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", abort),
      };
      this.#pending.set(interaction.id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      this.changed(
        sessionId,
        { type: "interaction.requested", session: { sessionId }, interaction },
        this.forSession(sessionId).length,
      );
    });
  }
  resolve(id: string, response: InteractionResponse): boolean {
    const pending = this.#pending.get(id);
    if (!pending || !this.#close(id, pending)) return false;
    pending.resolve(response);
    return true;
  }
  rejectSession(sessionId: string, error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId === sessionId && this.#close(id, pending))
        pending.reject(error);
    }
  }
  #close(id: string, pending: Pending): boolean {
    if (this.#pending.get(id) !== pending) return false;
    this.#pending.delete(id);
    pending.detach();
    this.changed(
      pending.sessionId,
      {
        type: "interaction.resolved",
        session: { sessionId: pending.sessionId },
        interactionId: id,
      },
      this.forSession(pending.sessionId).length,
    );
    return true;
  }
}
