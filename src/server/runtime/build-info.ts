import { readFile } from "node:fs/promises";
import { z } from "zod";
export const BuildInfoSchema = z.strictObject({
  schema: z.literal(1),
  id: z.string().uuid(),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  dirty: z.boolean(),
  builtAt: z.iso.datetime(),
});
export type BuildInfo = z.infer<typeof BuildInfoSchema>;
export async function readBuildInfo(path: string | URL): Promise<BuildInfo> {
  return BuildInfoSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
