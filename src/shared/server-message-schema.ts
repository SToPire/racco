import { z } from "zod";
import {
  ContextUsageSchema,
  ModelCatalogSchema,
  ProviderSchema,
  SessionRefSchema,
} from "./protocol.js";
import { ModelSettingsSchema } from "./model-settings.js";
import type {
  AssistantContentEvent,
  ServerMessage,
  SessionSummary,
  TimelineEvent,
} from "./protocol.js";

const id = z.string().min(1);
const text = z.string();
export const SessionSummarySchema = z.strictObject({
  sessionId: id,
  provider: ProviderSchema,
  projectId: id,
  title: text.optional(),
  cwd: id,
  updatedAt: z.iso.datetime(),
  state: z.enum([
    "idle",
    "running",
    "waiting_interaction",
    "interrupted",
    "error",
  ]),
  lifecycle: z.enum(["provisioning", "active", "failed"]),
  selectedModelSettings: ModelSettingsSchema.nullable(),
  contextUsage: ContextUsageSchema.nullable(),
  compacting: z.boolean(),
}) satisfies z.ZodType<SessionSummary>;
export const ProjectEntrySchema = z.strictObject({
  projectId: id,
  name: text,
  path: id,
  available: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const WorktreeEntrySchema = z.strictObject({
  projectId: id,
  path: id,
  kind: z.enum(["primary", "linked"]),
  name: text,
  branch: text.nullable(),
  head: text.nullable(),
  available: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
  removable: z.boolean(),
  dirty: z.boolean(),
  sessionCount: z.number().int().nonnegative(),
});
export const WorktreeCatalogSchema = z.strictObject({
  projectId: id,
  worktrees: z.array(WorktreeEntrySchema),
  degradedReason: text.nullable(),
});
export const DeleteWorktreeResultSchema = z.strictObject({
  catalog: WorktreeCatalogSchema,
  removedSessionIds: z.array(id),
  branchDeletion: z
    .union([
      z.strictObject({ branch: text, deleted: z.literal(true) }),
      z.strictObject({ branch: text, deleted: z.literal(false), reason: text }),
    ])
    .nullable(),
});
export const HealthResponseSchema = z.strictObject({
  ok: z.literal(true),
  providers: z.strictObject({
    codex: z.enum(["ready", "unavailable"]),
    claude: z.enum(["ready", "unavailable"]),
  }),
});
export const DirectoryListingSchema = z.strictObject({
  path: id,
  parentPath: id.nullable(),
  homePath: id,
  entries: z.array(
    z.strictObject({ name: text, path: id, hidden: z.boolean() }),
  ),
  truncated: z.boolean(),
});
export const ProjectTreeListingSchema = z.strictObject({
  path: text,
  entries: z.array(
    z.strictObject({
      name: text,
      path: text,
      kind: z.enum(["directory", "file", "unavailable"]),
      symlink: z.boolean(),
      reason: text.optional(),
    }),
  ),
  truncated: z.boolean(),
});
const file = {
  path: text,
  size: z.number().nonnegative(),
  modifiedAt: z.iso.datetime(),
};
export const ProjectFilePreviewSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...file, kind: z.literal("text"), content: text }),
  z.strictObject({ ...file, kind: z.literal("image"), dataUrl: text }),
  z.strictObject({ ...file, kind: z.literal("unavailable"), reason: text }),
]);
const FileChangeSchema = z.strictObject({
  path: text,
  kind: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("add") }),
    z.strictObject({ type: z.literal("delete") }),
    z.strictObject({ type: z.literal("update"), move_path: text.nullable() }),
  ]),
  diff: text,
});
const ToolFactsSchema = z.strictObject({
  summary: text.optional(),
  command: text.optional(),
  cwd: text.optional(),
  exitCode: z.number().optional(),
  durationMs: z.number().nonnegative().optional(),
  fileChanges: z.array(FileChangeSchema).optional(),
  backgroundTaskId: text.optional(),
});
const contentState = {
  partial: z.boolean().optional(),
  stopReason: z.enum(["interrupted", "error"]).optional(),
};
const AssistantContentSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("assistant.message"),
      id,
      text,
      phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
      ...contentState,
    }),
    z.strictObject({
      type: z.literal("assistant.reasoning"),
      id,
      summary: z.array(text),
      ...contentState,
    }),
    z.strictObject({
      type: z.literal("assistant.plan"),
      id,
      text,
      ...contentState,
    }),
  ])
  .refine(
    (value) => !value.partial || value.stopReason === undefined,
    "Partial content cannot carry a stop reason",
  )
  .transform((value) => value as AssistantContentEvent);
const AgentEventSchema = z.union([
  AssistantContentSchema,
  z.strictObject({
    type: z.literal("user.message"),
    id,
    text,
    imageCount: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("assistant.message.removed"), id }),
  z.strictObject({
    type: z.literal("plan.updated"),
    id,
    explanation: text.nullable(),
    steps: z.array(
      z.strictObject({
        step: text,
        status: z.enum(["pending", "inProgress", "completed"]),
      }),
    ),
    state: z.enum(["running", "completed", "interrupted", "error"]),
  }),
  z.strictObject({
    type: z.literal("tool.started"),
    id,
    tool: text,
    input: z.unknown(),
    details: z.unknown().optional(),
    facts: ToolFactsSchema.optional(),
  }),
  z.strictObject({ type: z.literal("tool.output"), id, output: text }),
  z.strictObject({
    type: z.literal("tool.progress"),
    id,
    elapsedSeconds: z.number().nonnegative(),
    description: text.optional(),
  }),
  z.strictObject({
    type: z.literal("tool.completed"),
    id,
    status: z.enum(["completed", "failed", "interrupted", "incomplete"]),
    output: text.optional(),
    details: z.unknown().optional(),
    facts: ToolFactsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("system.notice"),
    id,
    text,
    level: z.enum(["info", "warning", "error"]),
  }),
]);
export const TimelineEventSchema = z.union([
  AgentEventSchema,
  z.strictObject({
    type: z.literal("subagent.started"),
    id,
    agentId: id,
    parentAgentId: id.optional(),
    name: text.optional(),
    agentPath: text.optional(),
    cwd: text.optional(),
    role: text.optional(),
    prompt: text.optional(),
    model: text.optional(),
    reasoningEffort: text.optional(),
  }),
  z.strictObject({
    type: z.literal("subagent.state"),
    id,
    agentId: id,
    state: z.enum([
      "starting",
      "running",
      "completed",
      "interrupted",
      "error",
      "unknown",
    ]),
    message: text.optional(),
  }),
  z.strictObject({
    type: z.literal("subagent.event"),
    id,
    agentId: id,
    event: AgentEventSchema,
  }),
]) satisfies z.ZodType<TimelineEvent>;
export const InteractionRequestSchema = z.strictObject({
  id,
  title: text,
  sourceAgentId: id.optional(),
  questions: z.array(
    z.strictObject({
      id,
      text,
      multiple: z.boolean(),
      options: z
        .array(z.strictObject({ label: text, description: text.optional() }))
        .optional(),
      allowOther: z.boolean().optional(),
      secret: z.boolean().optional(),
    }),
  ),
});
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ack"),
    requestId: id,
    data: z.unknown().optional(),
  }),
  z.strictObject({
    type: z.literal("error"),
    requestId: id.optional(),
    message: text,
    code: z.literal("session_not_found").optional(),
  }),
  z.strictObject({
    type: z.literal("project.upserted"),
    project: ProjectEntrySchema,
  }),
  z.strictObject({ type: z.literal("project.deleted"), projectId: id }),
  z.strictObject({
    type: z.literal("worktree.upserted"),
    worktree: WorktreeEntrySchema,
  }),
  z.strictObject({ type: z.literal("worktree.deleted"), path: id }),
  z.strictObject({
    type: z.literal("session.upserted"),
    session: SessionSummarySchema,
  }),
  z.strictObject({ type: z.literal("session.removed"), sessionId: id }),
  z.strictObject({
    type: z.literal("session.snapshot"),
    session: SessionSummarySchema,
    events: z.array(TimelineEventSchema),
    pendingInteractions: z.array(InteractionRequestSchema),
  }),
  z.strictObject({
    type: z.literal("timeline.event"),
    session: SessionRefSchema,
    event: TimelineEventSchema,
  }),
  z.strictObject({
    type: z.literal("interaction.requested"),
    session: SessionRefSchema,
    interaction: InteractionRequestSchema,
  }),
  z.strictObject({
    type: z.literal("interaction.resolved"),
    session: SessionRefSchema,
    interactionId: id,
  }),
]) satisfies z.ZodType<ServerMessage>;

export const ApiResponseSchemas = {
  health: HealthResponseSchema,
  sessions: z.array(SessionSummarySchema),
  projects: z.array(ProjectEntrySchema),
  project: ProjectEntrySchema,
  session: SessionSummarySchema,
  worktrees: WorktreeCatalogSchema,
  deleteWorktree: DeleteWorktreeResultSchema,
  nativeDeletion: z.strictObject({ removedManagedSessionId: id.nullable() }),
  directory: DirectoryListingSchema,
  tree: ProjectTreeListingSchema,
  file: ProjectFilePreviewSchema,
  models: ModelCatalogSchema,
};
