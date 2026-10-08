import { z } from "zod";

export const GitChangeGroupSchema = z.enum([
  "conflict",
  "unstaged",
  "staged",
  "untracked",
]);
export type GitChangeGroup = z.infer<typeof GitChangeGroupSchema>;
export const GitChangeEntrySchema = z.strictObject({
  path: z.string().min(1),
  oldPath: z.string().nullable(),
  group: GitChangeGroupSchema,
  status: z.string().min(1),
  submodule: z.boolean(),
  submoduleState: z.string().nullable(),
});
export type GitChangeEntry = z.infer<typeof GitChangeEntrySchema>;
export const GitChangesSchema = z.strictObject({
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  readAt: z.string(),
  entries: z.array(GitChangeEntrySchema),
});
export type GitChanges = z.infer<typeof GitChangesSchema>;
export const GitChangeDiffSchema = z.strictObject({
  path: z.string(),
  file: z.string(),
  oldPath: z.string().nullable(),
  group: GitChangeGroupSchema,
  readAt: z.string(),
  kind: z.enum([
    "text",
    "binary",
    "metadata",
    "conflict",
    "submodule",
    "unavailable",
  ]),
  diff: z.string(),
  reason: z.string().nullable(),
  currentFileAvailable: z.boolean(),
});
export type GitChangeDiff = z.infer<typeof GitChangeDiffSchema>;
