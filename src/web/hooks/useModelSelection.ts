import { useEffect, useRef, useState } from "react";
import type {
  ModelCatalog,
  ModelSettings,
  Provider,
} from "../../shared/protocol";
import {
  modelSettingsError,
  sameModelSettings,
} from "../../shared/model-settings";
import { listModels } from "../api";
import { selectModel, suggestedSettings } from "../model-selection";

export function useModelSelection(
  provider: Provider,
  path: string,
  saved: ModelSettings | null,
  newSession = false,
  connected = true,
) {
  const scope = `${provider}:${path}`;
  const [draft, setDraft] = useState<ModelSettings | null>(saved);
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const previous = useRef({ provider, scope, saved });
  const savedRef = useRef(saved);
  savedRef.current = saved;

  useEffect(() => {
    if (!sameModelSettings(previous.current.saved, saved)) {
      const oldSaved = previous.current.saved;
      if (
        sameModelSettings(draft, oldSaved) ||
        sameModelSettings(draft, saved)
      ) {
        setDraft(saved);
        setNotice(undefined);
      } else {
        setNotice("会话配置已在其他位置更新，保留本地选择");
      }
      previous.current.saved = saved;
    }
  }, [saved, draft]);

  useEffect(() => {
    const controller = new AbortController();
    const providerChanged = previous.current.provider !== provider;
    const scopeChanged = previous.current.scope !== scope;
    previous.current.provider = provider;
    previous.current.scope = scope;
    setCatalog(undefined);
    setError(undefined);
    if (scopeChanged) {
      setNotice(undefined);
      if (providerChanged || !newSession) setDraft(savedRef.current);
    }
    if (!path || !connected) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    void listModels(provider, path, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setCatalog(result);
        if (newSession)
          setDraft((current) => current ?? suggestedSettings(result));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [provider, path, scope, newSession, connected]);

  const currentCatalog =
    catalog?.provider === provider && catalog.path === path
      ? catalog
      : undefined;
  const currentDraft = previous.current.scope === scope ? draft : null;
  const issue =
    currentCatalog && currentDraft
      ? modelSettingsError(currentCatalog, currentDraft)
      : undefined;
  return {
    catalog: currentCatalog,
    draft: currentDraft,
    loading,
    error,
    notice,
    issue,
    valid:
      currentCatalog !== undefined &&
      currentDraft !== null &&
      issue === undefined,
    chooseModel: (modelId: string) => {
      const model = currentCatalog?.models.find(
        (candidate) => candidate.id === modelId,
      );
      if (!model) return;
      const next = selectModel(model, currentDraft?.reasoningEffort ?? null);
      setDraft(next);
      setNotice(
        currentDraft && currentDraft.reasoningEffort !== next.reasoningEffort
          ? `推理强度已调整为 ${next.reasoningEffort ?? (model.reasoningEffort.status === "unsupported" ? "不支持调节" : "未选择")}`
          : undefined,
      );
    },
    chooseEffort: (reasoningEffort: string) => {
      if (currentDraft) setDraft({ ...currentDraft, reasoningEffort });
      setNotice(undefined);
    },
  };
}
