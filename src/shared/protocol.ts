import { z } from "zod";
import {
  ModelSettingsSchema,
  ProviderModelCatalogSchema,
} from "./model-settings.js";
import type { ModelSettings } from "./model-settings.js";
export type {
  ModelSettings,
  ModelOption,
  ProviderModelCatalog,
} from "./model-settings.js";

export const ProviderSchema = z.enum(["codex", "claude"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const ModelCatalogSchema = ProviderModelCatalogSchema.safeExtend({
  provider: ProviderSchema,
  projectId: z.string().min(1),
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export const NativeSessionSchema = z.strictObject({
  providerSessionId: z.string().min(1),
  title: z.string().optional(),
  updatedAt: z.iso.datetime(),
  managedSessionId: z.string().min(1).nullable(),
});
export type NativeSession = z.infer<typeof NativeSessionSchema>;

export const NativeSessionPageSchema = z.strictObject({
  projectId: z.string().min(1),
  provider: ProviderSchema,
  sessions: z.array(NativeSessionSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type NativeSessionPage = z.infer<typeof NativeSessionPageSchema>;

export type SessionState =
  "idle" | "running" | "waiting_interaction" | "interrupted" | "error";

export const ContextUsageSchema = z.strictObject({
  usedTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive().nullable(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const SessionRefSchema = z.strictObject({
  // Conversation APIs use Racco IDs. Native IDs are only for discovery/import.
  sessionId: z.string().min(1),
});
export type SessionRef = z.infer<typeof SessionRefSchema>;

export type SessionLifecycle = "provisioning" | "active" | "failed";

export type SubagentState =
  "starting" | "running" | "completed" | "interrupted" | "error";

export type SessionSummary = SessionRef & {
  provider: Provider;
  projectId: string;
  title?: string;
  cwd: string;
  updatedAt: string;
  state: SessionState;
  lifecycle: SessionLifecycle;
  selectedModelSettings: ModelSettings | null;
  contextUsage: ContextUsage | null;
  compacting: boolean;
};

export type AssistantMessageEvent = {
  type: "assistant.message";
  id: string;
  text: string;
} & (
  | { partial: true; stopReason?: never }
  | { partial?: false; stopReason?: "interrupted" | "error" }
);

export type AgentTimelineEvent =
  | { type: "user.message"; id: string; text: string }
  | AssistantMessageEvent
  | { type: "assistant.message.removed"; id: string }
  | {
      type: "tool.started";
      id: string;
      tool: string;
      input: unknown;
      details?: unknown;
    }
  | { type: "tool.output"; id: string; output: string }
  | {
      type: "tool.completed";
      id: string;
      success: boolean;
      output?: string;
      details?: unknown;
    }
  | {
      type: "system.notice";
      id: string;
      text: string;
      level: "info" | "warning" | "error";
    };

export type TimelineEvent =
  | AgentTimelineEvent
  | {
      type: "subagent.started";
      id: string;
      agentId: string;
      parentAgentId?: string;
      name?: string;
      agentPath?: string;
      cwd?: string;
      role?: string;
      prompt?: string;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: "subagent.state";
      id: string;
      agentId: string;
      state: SubagentState;
      message?: string;
    }
  | {
      type: "subagent.event";
      id: string;
      agentId: string;
      event: AgentTimelineEvent;
    };

export type FileChange = {
  path: string;
  kind:
    | { type: "add" }
    | { type: "delete" }
    | { type: "update"; move_path: string | null };
  diff: string;
};

export type InteractionRequest = {
  id: string;
  title: string;
  questions: Array<{
    id: string;
    text: string;
    multiple: boolean;
    options?: Array<{ label: string; description?: string }>;
    allowOther?: boolean;
    secret?: boolean;
  }>;
};

export const InteractionResponseSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("deny"),
    message: z.string().optional(),
  }),
  z.strictObject({
    decision: z.literal("answer"),
    answers: z.record(z.string(), z.array(z.string())),
  }),
]);
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

const RequestIdSchema = z.string().min(1);

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("session.create"),
    requestId: RequestIdSchema,
    provider: ProviderSchema,
    projectId: z.string().min(1),
    prompt: z.string().min(1),
    modelSettings: ModelSettingsSchema,
  }),
  z.strictObject({
    type: z.literal("session.subscribe"),
    requestId: RequestIdSchema,
    sessionId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("turn.start"),
    requestId: RequestIdSchema,
    sessionId: z.string().min(1),
    prompt: z.string().min(1),
    modelSettings: ModelSettingsSchema,
  }),
  z.strictObject({
    type: z.literal("session.compact"),
    requestId: RequestIdSchema,
    sessionId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("turn.interrupt"),
    requestId: RequestIdSchema,
    sessionId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("interaction.resolve"),
    requestId: RequestIdSchema,
    interactionId: z.string().min(1),
    response: InteractionResponseSchema,
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export type SessionSnapshotMessage = {
  type: "session.snapshot";
  session: SessionSummary;
  events: TimelineEvent[];
  pendingInteractions: InteractionRequest[];
};

export type ServerMessage =
  | { type: "ack"; requestId: string; data?: unknown }
  | { type: "error"; requestId?: string; message: string }
  | { type: "project.upserted"; project: ProjectEntry }
  | { type: "project.deleted"; projectId: string }
  | { type: "session.upserted"; session: SessionSummary }
  | { type: "session.removed"; sessionId: string }
  | SessionSnapshotMessage
  | { type: "timeline.event"; session: SessionRef; event: TimelineEvent }
  | {
      type: "interaction.requested";
      session: SessionRef;
      interaction: InteractionRequest;
    }
  | {
      type: "interaction.resolved";
      session: SessionRef;
      interactionId: string;
    };

export type ProviderStatus = "ready" | "unavailable";

export type HealthResponse = {
  ok: true;
  providers: Record<Provider, ProviderStatus>;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  hidden: boolean;
};

export type DirectoryListing = {
  path: string;
  parentPath: string | null;
  homePath: string;
  entries: DirectoryEntry[];
  truncated: boolean;
};

export type ProjectEntry = {
  projectId: string;
  name: string;
  path: string;
  available: boolean;
  createdAt: string;
};

export type ProjectFileEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "unavailable";
  symlink: boolean;
  reason?: string;
};

export type ProjectTreeListing = {
  path: string;
  entries: ProjectFileEntry[];
  truncated: boolean;
};

export type ProjectFilePreview = {
  path: string;
  size: number;
  modifiedAt: string;
} & (
  | { kind: "text"; content: string }
  | { kind: "image"; dataUrl: string }
  | { kind: "unavailable"; reason: string }
);
