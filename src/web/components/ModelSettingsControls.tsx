import type { useModelSelection } from "../hooks/useModelSelection";
import { SelectionMenu } from "./SelectionMenu";

export type ModelSelection = ReturnType<typeof useModelSelection>;

export function ModelSettingsControls({
  selection,
  disabled,
}: {
  selection: ModelSelection;
  disabled: boolean;
}) {
  const model = selection.catalog?.models.find(
    (candidate) => candidate.id === selection.draft?.modelId,
  );
  const capability = model?.reasoningEffort;
  return (
    <div className="model-settings-controls">
      <SelectionMenu
        label="模型"
        value={selection.draft?.modelId ?? null}
        disabled={
          disabled ||
          !selection.catalog ||
          selection.catalog.models.length === 0
        }
        options={
          selection.catalog?.models.map((candidate) => ({
            value: candidate.id,
            label: candidate.displayName,
            disabled: candidate.reasoningEffort.status === "unavailable",
          })) ?? []
        }
        onChange={selection.chooseModel}
        secondary={
          capability?.status === "supported"
            ? {
                label: "推理强度",
                value: selection.draft?.reasoningEffort ?? null,
                options: capability.options.map((option) => ({
                  value: option.value,
                  label: option.value,
                })),
                onChange: selection.chooseEffort,
              }
            : undefined
        }
      />
    </div>
  );
}

export function ModelSettingsStatus({
  selection,
}: {
  selection: ModelSelection;
}) {
  const text = selection.loading
    ? "正在读取模型与推理强度…"
    : (selection.error ??
      selection.issue ??
      (selection.catalog?.models.length === 0
        ? "Provider 未返回可用模型"
        : selection.notice));
  return text ? (
    <small
      className="model-settings-status"
      role="status"
      aria-label="模型设置状态"
      aria-atomic="true"
    >
      {text}
      {!selection.loading &&
        (selection.error || selection.catalog?.models.length === 0) && (
          <button
            type="button"
            onClick={selection.retry}
            disabled={!selection.canRetry}
          >
            重新读取模型
          </button>
        )}
    </small>
  ) : null;
}
