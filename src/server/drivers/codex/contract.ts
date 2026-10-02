import { z } from "zod";

/** The experimental RPC contract is tested against this exact upstream release. */
export const SUPPORTED_CODEX_VERSION = "0.160.0";
export const CODEX_HISTORY_MODE = "legacy" as const;

const InitializeResponseSchema = z.object({
  userAgent: z.string(),
  codexHome: z.string().min(1),
  platformFamily: z.literal("unix"),
  platformOs: z.literal("linux"),
});

export function validateCodexHandshake(value: unknown): void {
  const response = InitializeResponseSchema.safeParse(value);
  if (
    !response.success ||
    !response.data.userAgent.startsWith(`racco/${SUPPORTED_CODEX_VERSION} `)
  ) {
    throw new Error(
      `Unsupported Codex app-server; install @openai/codex@${SUPPORTED_CODEX_VERSION} on Linux`,
    );
  }
}
