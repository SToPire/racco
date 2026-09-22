export async function smokeModelSettings(
  baseUrl,
  provider,
  path,
  saved = null,
) {
  const response = await fetch(
    `${baseUrl}/api/providers/${provider}/models?${new URLSearchParams({ path })}`,
  );
  if (!response.ok)
    throw new Error(
      `Model catalog returned ${response.status}: ${await response.text()}`,
    );
  const catalog = await response.json();
  const modelId =
    process.env.RACCO_MODEL ??
    saved?.modelId ??
    catalog.suggestedModelId ??
    catalog.models[0]?.id;
  const model = catalog.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Model is not available: ${modelId}`);
  const capability = model.reasoningEffort;
  if (capability.status === "unavailable") throw new Error(capability.reason);
  const reasoningEffort =
    process.env.RACCO_EFFORT ??
    (modelId === saved?.modelId ? saved.reasoningEffort : undefined) ??
    (capability.status === "supported"
      ? (capability.suggestedValue ?? capability.options[0]?.value)
      : null);
  if (
    capability.status === "supported" &&
    !capability.options.some((option) => option.value === reasoningEffort)
  )
    throw new Error(`Effort is not available: ${reasoningEffort}`);
  if (capability.status === "unsupported" && reasoningEffort !== null)
    throw new Error("Model does not support effort");
  return { modelId, reasoningEffort };
}
