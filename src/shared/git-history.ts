import { z } from "zod";

export const GIT_HISTORY_BATCH_SIZE = 15;
export const GIT_HISTORY_MAX_COMMITS = 5000;
export const GIT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

export const GitObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const GitHistoryScopeSchema = z.enum(["current", "all"]);
export type GitHistoryScope = z.infer<typeof GitHistoryScopeSchema>;
export const GitParentSchema = z.union([GitObjectIdSchema, z.literal("root")]);

const PersonSchema = z.strictObject({ name: z.string(), email: z.string() });
export const GitCommitRefSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(["head", "branch", "remote", "tag"]),
});
export const GitCommitSummarySchema = z.strictObject({
  oid: GitObjectIdSchema,
  parents: z.array(GitObjectIdSchema),
  boundaryParents: z.array(GitObjectIdSchema),
  subject: z.string(),
  textUnavailableReason: z.string().nullable(),
  author: PersonSchema,
  authoredAt: z.string(),
  committedAt: z.string(),
  refs: z.array(GitCommitRefSchema),
});
export type GitCommitSummary = z.infer<typeof GitCommitSummarySchema>;

export const GitHistoryPageSchema = z.strictObject({
  path: z.string(),
  scope: GitHistoryScopeSchema,
  snapshotId: z.string().min(1),
  head: GitObjectIdSchema.nullable(),
  branch: z.string().nullable(),
  readAt: z.string(),
  commits: z.array(GitCommitSummarySchema).max(GIT_HISTORY_BATCH_SIZE),
  nextCursor: z.string().nullable(),
  shallow: z.boolean(),
});
export type GitHistoryPage = z.infer<typeof GitHistoryPageSchema>;

export const GitCommitFileSchema = z.strictObject({
  path: z.string().min(1),
  oldPath: z.string().nullable(),
  status: z.enum(["A", "M", "D", "R", "C", "T"]),
  oldMode: z.string().nullable(),
  newMode: z.string().nullable(),
  oldOid: GitObjectIdSchema.nullable(),
  newOid: GitObjectIdSchema.nullable(),
});
export type GitCommitFile = z.infer<typeof GitCommitFileSchema>;
export const GitCommitDetailSchema = z.strictObject({
  path: z.string(),
  snapshotId: z.string(),
  commit: GitCommitSummarySchema.extend({
    message: z.string(),
    committer: PersonSchema,
  }),
  baseOid: GitObjectIdSchema.nullable(),
  unavailableReason: z.string().nullable(),
  files: z.array(GitCommitFileSchema).max(1000),
});
export type GitCommitDetail = z.infer<typeof GitCommitDetailSchema>;

export const GitCommitDiffSchema = z.strictObject({
  path: z.string(),
  snapshotId: z.string(),
  oid: GitObjectIdSchema,
  baseOid: GitObjectIdSchema.nullable(),
  file: z.string(),
  oldPath: z.string().nullable(),
  kind: z.enum(["text", "binary", "metadata", "submodule", "unavailable"]),
  diff: z.string(),
  reason: z.string().nullable(),
});
export type GitCommitDiff = z.infer<typeof GitCommitDiffSchema>;
