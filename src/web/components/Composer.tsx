import { type FormEvent, type ReactNode, useState } from "react";
import type { ModelSettings } from "../../shared/protocol";
import { submitOnEnter } from "../composer-keyboard";
import {
  ModelSettingsControls,
  ModelSettingsStatus,
  type ModelSelection,
} from "./ModelSettingsControls";

type ComposerProps = {
  inputDisabled: boolean;
  sendDisabled: boolean;
  sending: boolean;
  onSend: (text: string, settings: ModelSettings) => Promise<boolean>;
  selection: ModelSelection;
  contextControls?: ReactNode;
  compacting?: boolean;
};

export function Composer({
  inputDisabled,
  sendDisabled,
  sending,
  onSend,
  selection,
  contextControls,
  compacting = false,
}: ComposerProps) {
  const [text, setText] = useState("");
  const editingDisabled = inputDisabled || sending || compacting;
  const submissionDisabled = sendDisabled || editingDisabled;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (
      value.length === 0 ||
      submissionDisabled ||
      !selection.valid ||
      !selection.draft
    )
      return;
    if (await onSend(value, selection.draft)) setText("");
  }

  return (
    <form
      className={`composer${compacting ? " composer-compacting" : ""}`}
      onSubmit={submit}
      aria-busy={compacting}
    >
      <textarea
        aria-label="发送给 Racco"
        disabled={editingDisabled}
        onKeyDown={submitOnEnter}
        onChange={(event) => setText(event.target.value)}
        placeholder={
          compacting
            ? "正在压缩上下文，请稍候…"
            : sending
              ? "正在发送，请稍候…"
              : inputDisabled
                ? "当前暂不可编辑"
                : sendDisabled
                  ? "可先准备草稿，任务结束后发送"
                  : "给 Agent 发消息"
        }
        rows={1}
        value={text}
      />
      <div className="composer-toolbar">
        <ModelSettingsControls
          selection={selection}
          disabled={submissionDisabled}
        />
        <button
          className="round-send-button"
          aria-label={sending ? "发送中" : "发送"}
          disabled={
            submissionDisabled || !selection.valid || text.trim().length === 0
          }
          title="发送"
          type="submit"
        >
          {sending ? (
            <span className="button-spinner" aria-hidden="true" />
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 19V5m0 0-6 6m6-6 6 6" />
            </svg>
          )}
        </button>
      </div>
      {contextControls}
      <ModelSettingsStatus selection={selection} />
    </form>
  );
}
