import { z } from "zod";

export const ModelSettingsSchema = z.strictObject({
  modelId: z.string().min(1),
  reasoningEffort: z.string().min(1).nullable(),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

const EffortCapabilitySchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      status: z.literal("supported"),
      options: z
        .array(
          z.strictObject({ value: z.string().min(1), description: z.string() }),
        )
        .min(1),
      suggestedValue: z.string().min(1).nullable(),
    })
    .refine(
      (value) =>
        new Set(value.options.map((option) => option.value)).size ===
          value.options.length &&
        (value.suggestedValue === null ||
          value.options.some(
            (option) => option.value === value.suggestedValue,
          )),
      "Invalid effort options",
    ),
  z.strictObject({ status: z.literal("unsupported") }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.string().min(1),
  }),
]);

export const ModelOptionSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  reasoningEffort: EffortCapabilitySchema,
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const ProviderModelCatalogSchema = z
  .strictObject({
    models: z.array(ModelOptionSchema),
    suggestedModelId: z.string().min(1).nullable(),
  })
  .refine(
    (catalog) =>
      new Set(catalog.models.map((model) => model.id)).size ===
        catalog.models.length &&
      (catalog.suggestedModelId === null ||
        catalog.models.some((model) => model.id === catalog.suggestedModelId)),
    "Invalid model catalog",
  );
export type ProviderModelCatalog = z.infer<typeof ProviderModelCatalogSchema>;

export function modelSettingsError(
  catalog: ProviderModelCatalog,
  settings: ModelSettings,
): string | undefined {
  const model = catalog.models.find(
    (candidate) => candidate.id === settings.modelId,
  );
  if (model === undefined)
    return `模型 ${settings.modelId} 当前不可选，请重新选择模型`;
  const effort = model.reasoningEffort;
  if (effort.status === "unavailable") return effort.reason;
  if (effort.status === "unsupported") {
    return settings.reasoningEffort === null
      ? undefined
      : "所选模型不支持调节推理强度";
  }
  return effort.options.some(
    (option) => option.value === settings.reasoningEffort,
  )
    ? undefined
    : `推理强度 ${settings.reasoningEffort ?? "未选择"} 当前不可选`;
}

export function sameModelSettings(
  left: ModelSettings | null,
  right: ModelSettings | null,
): boolean {
  return (
    left?.modelId === right?.modelId &&
    left?.reasoningEffort === right?.reasoningEffort
  );
}
