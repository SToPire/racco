import { UiIcon } from "./UiIcon";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type {
  HealthResponse,
  ProjectEntry,
  Provider,
  ModelSettings,
  WorktreeEntry,
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
  /** All projects' worktrees; the view filters by the selected project. */
  worktrees: WorktreeEntry[];
  projectId: string;
  /** Selected worktree path; empty means the project's primary one. */
  worktreePath: string;
  creating: boolean;
  connected: boolean;
  error?: string;
  /** Per-project worktree failure, shown next to the worktree picker. */
  worktreeError?: string;
  busyWorktree: boolean;
  onBack: () => void;
  onCreate: (
    provider: Provider,
    projectId: string,
    path: string,
    prompt: string,
    modelSettings: ModelSettings,
  ) => Promise<boolean>;
  onImportProject: () => void;
  onProjectChange: (projectId: string) => void;
  onWorktreeChange: (path: string) => void;
  onCreateWorktree: (
    projectId: string,
    name: string,
  ) => Promise<WorktreeEntry | undefined>;
};

export function NewSessionView({
  active,
  health,
  projects,
  worktrees,
  projectId,
  worktreePath,
  creating,
  connected,
  error,
  worktreeError,
  busyWorktree,
  onBack,
  onCreate,
  onImportProject,
  onProjectChange,
  onWorktreeChange,
  onCreateWorktree,
}: NewSessionViewProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<Provider>("codex");
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [newWorktreeName, setNewWorktreeName] = useState("");
  const [newWorktreeError, setNewWorktreeError] = useState<string>();
  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);
  const selectedProject = projects.find(
    (project) => project.projectId === projectId,
  );
  const projectAvailable = selectedProject?.available === true;
  const projectWorktrees = worktrees.filter(
    (worktree) => worktree.projectId === projectId,
  );
  // An empty selection means the primary worktree. It is resolved to the
  // derived entry rather than to the project path so that the availability the
  // server reported for that directory is the one that gates sending.
  const selectedWorktree =
    worktreePath === ""
      ? projectWorktrees.find((worktree) => worktree.kind === "primary")
      : projectWorktrees.find((worktree) => worktree.path === worktreePath);
  const targetPath = selectedWorktree?.path ?? selectedProject?.path ?? "";
  const targetAvailable =
    projectAvailable && (selectedWorktree?.available ?? false);
  const selection = useModelSelection(
    provider,
    targetPath,
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
  // A path from a previous project would silently point at a worktree that is
  // not in the current one; fall back to the primary as soon as that happens.
  useEffect(() => {
    if (projectId === "" || worktreePath === "") return;
    if (projectWorktrees.some((worktree) => worktree.path === worktreePath))
      return;
    onWorktreeChange("");
  }, [projectId, worktreePath, projectWorktrees, onWorktreeChange]);

  async function submitNewWorktree() {
    const name = newWorktreeName.trim();
    if (name === "" || busyWorktree) return;
    setNewWorktreeError(undefined);
    const created = await onCreateWorktree(projectId, name);
    if (created === undefined) return;
    setCreatingWorktree(false);
    setNewWorktreeName("");
    onWorktreeChange(created.path);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (
      !targetAvailable ||
      !providerAvailable ||
      text.length === 0 ||
      creating ||
      !connected ||
      !selection.valid ||
      !selection.draft
    )
      return;
    void onCreate(provider, projectId, targetPath, text, selection.draft);
  }

  const providerAvailable = health?.providers[provider] === "ready";

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
          <SelectionMenu
            label="Worktree"
            value={selectedWorktree?.path ?? null}
            options={projectWorktrees.map((worktree) => ({
              value: worktree.path,
              label: `${worktree.name}${
                worktree.kind === "primary"
                  ? "（主工作区）"
                  : worktree.branch === null
                    ? "（detached）"
                    : `（${worktree.branch}）`
              }${worktree.available ? "" : "（目录不可用）"}`,
              disabled: !worktree.available,
            }))}
            disabled={creating}
            icon={<UiIcon name="branch" />}
            placeholder={
              projectId === ""
                ? "请先选择项目"
                : projectWorktrees.length === 0
                  ? "暂无 Worktree"
                  : "请选择 Worktree"
            }
            placement="below-start"
            onChange={onWorktreeChange}
          />
          {projectId !== "" && !creatingWorktree && (
            <button
              className="new-session-link-button"
              disabled={busyWorktree || !projectAvailable}
              onClick={() => {
                setCreatingWorktree(true);
                setNewWorktreeError(undefined);
              }}
              title="在当前项目下创建新的 Worktree"
              type="button"
            >
              <UiIcon name="plus" />
              新建 Worktree…
            </button>
          )}
          {creatingWorktree && (
            <div className="new-session-worktree-form">
              <input
                aria-label="新 Worktree 名称"
                autoFocus
                disabled={busyWorktree}
                onChange={(event) => setNewWorktreeName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitNewWorktree();
                  } else if (event.key === "Escape") {
                    setCreatingWorktree(false);
                    setNewWorktreeName("");
                    setNewWorktreeError(undefined);
                  }
                }}
                placeholder="分支名，例如 feature/login"
                value={newWorktreeName}
              />
              <button
                disabled={busyWorktree || newWorktreeName.trim() === ""}
                onClick={() => void submitNewWorktree()}
                type="button"
              >
                {busyWorktree ? <span className="button-spinner" /> : "创建"}
              </button>
              <button
                disabled={busyWorktree}
                onClick={() => {
                  setCreatingWorktree(false);
                  setNewWorktreeName("");
                  setNewWorktreeError(undefined);
                }}
                type="button"
              >
                取消
              </button>
            </div>
          )}
          {(newWorktreeError ?? worktreeError) && (
            <small className="new-session-warning">
              {newWorktreeError ?? worktreeError}
            </small>
          )}
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
                  !targetAvailable ||
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
          ) : targetAvailable ? (
            <small className="new-session-target" title={targetPath}>
              将在 {selectedWorktree?.name ?? selectedProject?.name} 中创建
            </small>
          ) : (
            <small>所选 Worktree 目录不可用，请重新选择。</small>
          )}
        </form>
      </div>
    </section>
  );
}
