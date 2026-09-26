import type {
  HistoryPage,
  ContextUsage,
  InteractionRequest,
  InteractionResponse,
  Provider,
  ModelSettings,
  ProviderModelCatalog,
  SessionState,
  TimelineEvent,
} from "../../shared/protocol.js";

export type ProviderSessionHandle = {
  providerSessionId: string;
  cwd: string;
};

export type ProviderSessionCreation = ProviderSessionHandle & {
  materialized: boolean;
};

export type ProviderSessionMetadata = {
  title?: string;
  updatedAt: string;
};

export type SessionSnapshot = {
  metadata: ProviderSessionMetadata;
  events: TimelineEvent[];
};

export type ProviderSessionPage = {
  sessions: Array<ProviderSessionMetadata & { providerSessionId: string }>;
  nextCursor: string | null;
};

export const SESSION_PAGE_SIZE = 50;

export type ProviderSessionUpdate =
  | { type: "context.usage"; usage: ContextUsage }
  | { type: "compaction.finished" }
  | { type: "metadata.changed"; metadata: ProviderSessionMetadata }
  | Extract<
      TimelineEvent,
      {
        type:
          | "system.notice"
          | "subagent.started"
          | "subagent.state"
          | "subagent.event";
      }
    >;

export interface DriverContext {
  emit(event: TimelineEvent): void;
  setState(state: SessionState): void;
  requestInteraction(
    request: Omit<InteractionRequest, "id">,
  ): Promise<InteractionResponse>;
  markProviderMaterialized(): void;
}

export interface AgentDriver {
  readonly provider: Provider;
  readonly ready: boolean;

  onSessionUpdate(
    listener: (
      providerSessionId: string,
      update: ProviderSessionUpdate,
    ) => void,
  ): void;

  start(): Promise<void>;
  close(): Promise<void>;
  listSessions(input: {
    cwd: string;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<ProviderSessionPage>;
  listModels(input: {
    cwd: string;
    signal: AbortSignal;
  }): Promise<ProviderModelCatalog>;
  readSession(handle: ProviderSessionHandle): Promise<SessionSnapshot>;
  /** Native turn pagination. Claude uses the hub's already-loaded history. */
  readHistoryPage?(
    handle: ProviderSessionHandle,
    input: {
      cursor?: string;
      agentId?: string;
    },
  ): Promise<HistoryPage & { metadata: ProviderSessionMetadata }>;
  deleteSession(handle: ProviderSessionHandle): Promise<void>;
  createSession(input: {
    raccoSessionId: string;
    cwd: string;
    modelSettings: ModelSettings;
  }): Promise<ProviderSessionCreation>;
  runTurn(input: {
    handle: ProviderSessionHandle;
    mode: "first" | "resume";
    prompt: string;
    modelSettings: ModelSettings;
    context: DriverContext;
    signal: AbortSignal;
  }): Promise<void>;
  compact?(input: { handle: ProviderSessionHandle }): Promise<void>;
}

export class ProviderSessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSessionNotFoundError";
  }
}
