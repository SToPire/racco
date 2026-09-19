import type {
  ModelOption,
  ModelSettings,
  ProviderModelCatalog,
} from "../shared/model-settings.js";

export function selectModel(
  model: ModelOption,
  previousEffort: string | null,
): ModelSettings {
  const capability = model.reasoningEffort;
  if (capability.status !== "supported")
    return { modelId: model.id, reasoningEffort: null };
  const effort = capability.options.some(
    (option) => option.value === previousEffort,
  )
    ? previousEffort
    : (capability.suggestedValue ??
      (capability.options.length === 1 ? capability.options[0].value : null));
  return { modelId: model.id, reasoningEffort: effort };
}

export function suggestedSettings(
  catalog: ProviderModelCatalog,
): ModelSettings | null {
  const model = catalog.models.find(
    (candidate) => candidate.id === catalog.suggestedModelId,
  );
  return model ? selectModel(model, null) : null;
}
