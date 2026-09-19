import { UiIcon } from "./UiIcon";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type {
  HealthResponse,
  ProjectEntry,
  Provider,
  ModelSettings,
} from "../../shared/protocol";
import { ProviderLogo } from "./ProviderLogo";
import { RaccoLogo } from "./RaccoLogo";
import { SelectionMenu } from "./SelectionMenu";
import { useModelSelection } from "../hooks/useModelSelection";
import { submitOnEnter } from "../composer-keyboard";
import {
  ModelSettingsControls,
  ModelSettingsStatus,
} from "./ModelSettingsControls";

type NewSessionViewProps = {
  active: boolean;
  health?: HealthResponse;
  projects: ProjectEntry[];
  projectId: string;
  creating: boolean;
  connected: boolean;
  error?: string;
  onBack: () => void;
  onCreate: (
    provider: Provider,
    projectId: string,
    prompt: string,
    modelSettings: ModelSettings,
  ) => Promise<boolean>;
  onImportProject: () => void;
  onProjectChange: (projectId: string) => void;
};

export function NewSessionView({
  active,
  health,
  projects,
  projectId,
  creating,
  connected,
  error,
  onBack,
  onCreate,
  onImportProject,
  onProjectChange,
}: NewSessionViewProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<Provider>("codex");
  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);
  const selection = useModelSelection(
    provider,
    projectId,
    null,
    true,
    connected,
  );
  useEffect(() => {
    if (projectId !== "") return;
    const availableProject = projects.find((project) => project.available);
    if (availableProject !== undefined)
      onProjectChange(availableProject.projectId);
  }, [projectId, projects, onProjectChange]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (
      !projectAvailable ||
      !providerAvailable ||
      text.length === 0 ||
      creating ||
      !connected ||
      !selection.valid ||
      !selection.draft
    )
      return;
    void onCreate(provider, projectId, text, selection.draft);
  }

  const providerAvailable = health?.providers[provider] === "ready";
  const selectedProject = projects.find(
    (project) => project.projectId === projectId,
  );
  const projectAvailable = selectedProject?.available === true;

  return (
    <section className="new-session-view">
      <header className="pane-header new-session-header">
        <button
          aria-label="返回对话历史"
          className="mobile-back-button icon-button"
          onClick={onBack}
          type="button"
        >
          <UiIcon name="back" />
        </button>
        <strong>新建对话</strong>
      </header>

      <div className="new-session-content">
        <div className="new-session-brand">
          <h1>
            <RaccoLogo />
          </h1>
        </div>
        <div className="new-session-context">
          <SelectionMenu
            label="项目"
            value={selectedProject?.projectId ?? null}
            options={projects.map((project) => ({
              value: project.projectId,
              label: `${project.name}${project.available ? "" : "（路径不可用）"}`,
              disabled: !project.available,
            }))}
            disabled={creating}
            icon={<UiIcon name="folder" />}
            placeholder={projects.length === 0 ? "请先导入项目" : "请选择项目"}
            placement="below-start"
            onChange={onProjectChange}
            footerAction={{
              label: "导入项目…",
              icon: <UiIcon name="plus" />,
              onClick: onImportProject,
            }}
          />
        </div>
        <form className="new-session-composer" onSubmit={submit}>
          {error && <p className="error-banner">{error}</p>}
          <textarea
            ref={input}
            aria-label="首条任务"
            onKeyDown={submitOnEnter}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            placeholder="给 Agent 发消息"
            value={prompt}
            disabled={creating}
          />
          <div className="new-session-toolbar">
            <div className="provider-switch" aria-label="选择 Agent">
              {(["codex", "claude"] as const).map((candidate) => (
                <button
                  aria-pressed={provider === candidate}
                  className={provider === candidate ? "active" : undefined}
                  onClick={() => setProvider(candidate)}
                  type="button"
                  disabled={creating || !connected}
                  key={candidate}
                >
                  <ProviderLogo decorative provider={candidate} />
                  {candidate === "codex" ? "Codex" : "Claude"}
                </button>
              ))}
            </div>

            <div className="new-session-actions">
              <ModelSettingsControls
                selection={selection}
                disabled={creating || !connected}
              />

              <button
                aria-label="新建并发送"
                className="round-send-button"
                disabled={
                  !providerAvailable ||
                  !projectAvailable ||
                  prompt.trim().length === 0 ||
                  creating ||
                  !connected ||
                  !selection.valid
                }
                type="submit"
              >
                {creating ? (
                  <span className="button-spinner" aria-hidden="true" />
                ) : (
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M12 19V5m0 0-6 6m6-6 6 6" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <ModelSettingsStatus selection={selection} />
          {!providerAvailable && (
            <small>
              {provider === "codex" ? "Codex" : "Claude"} 当前不可用
            </small>
          )}
          {projectId !== "" && !projectAvailable ? (
            <small>所选项目已删除或路径不可用，请重新选择项目。</small>
          ) : (
            providerAvailable &&
            !projectAvailable && <small>请先选择或导入一个项目</small>
          )}
        </form>
      </div>
    </section>
  );
}
