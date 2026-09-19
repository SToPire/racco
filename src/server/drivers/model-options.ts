import { z } from "zod";
import type {
  ModelOption,
  ProviderModelCatalog,
} from "../../shared/model-settings.js";

export const CodexModelListSchema = z.object({
  data: z.array(
    z.object({
      model: z.string().min(1),
      displayName: z.string().min(1),
      description: z.string(),
      hidden: z.boolean(),
      inputModalities: z.array(z.string()),
      isDefault: z.boolean(),
      supportedReasoningEfforts: z.array(
        z.object({
          reasoningEffort: z.string().min(1),
          description: z.string(),
        }),
      ),
      defaultReasoningEffort: z.string().min(1),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const unavailable = {
  status: "unavailable",
  reason: "Provider 未提供有效的推理强度选项，请稍后重新加载页面",
} as const;

export function codexModelCatalog(
  rows: z.infer<typeof CodexModelListSchema>["data"],
): ProviderModelCatalog {
  const visible = rows.filter(
    (row) => !row.hidden && row.inputModalities.includes("text"),
  );
  return {
    models: visible.map((row): ModelOption => {
      const options = row.supportedReasoningEfforts.map((option) => ({
        value: option.reasoningEffort,
        description: option.description,
      }));
      return {
        id: row.model,
        displayName: row.displayName,
        description: row.description,
        reasoningEffort:
          options.length > 0 &&
          new Set(options.map((o) => o.value)).size === options.length &&
          options.some((o) => o.value === row.defaultReasoningEffort)
            ? {
                status: "supported",
                options,
                suggestedValue: row.defaultReasoningEffort,
              }
            : unavailable,
      };
    }),
    suggestedModelId: visible.find((row) => row.isDefault)?.model ?? null,
  };
}

export const ClaudeEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const ClaudeModelSchema = z.object({
  value: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(z.string()).optional(),
});

export function claudeModelCatalog(input: unknown): ProviderModelCatalog {
  const rows = z.array(ClaudeModelSchema).parse(input);
  return {
    models: rows.map((row): ModelOption => {
      const levels = row.supportedEffortLevels;
      let reasoningEffort: ModelOption["reasoningEffort"] = unavailable;
      if (
        row.supportsEffort === false &&
        (levels === undefined || levels.length === 0)
      )
        reasoningEffort = { status: "unsupported" };
      if (
        row.supportsEffort === true &&
        levels &&
        levels.length > 0 &&
        new Set(levels).size === levels.length &&
        levels.every((level) => ClaudeEffortSchema.safeParse(level).success)
      ) {
        reasoningEffort = {
          status: "supported",
          options: levels.map((value) => ({ value, description: "" })),
          suggestedValue: levels.includes("high") ? "high" : null,
        };
      }
      return {
        id: row.value,
        displayName: row.displayName,
        description: row.description,
        reasoningEffort,
      };
    }),
    suggestedModelId: null,
  };
}
