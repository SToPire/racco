import { useImageDraft } from "../hooks/useImageDraft";
import {
  AttachImageButton,
  ImageAttachments,
  imagePaste,
  imageDrop,
  imageDragOver,
} from "./ImageAttachments";
import type { UserInput } from "../../shared/user-input";
import { type FormEvent, type ReactNode } from "react";
import { useDraftText } from "../hooks/useComposerDraft";
import type { ModelSettings } from "../../shared/protocol";
import { submitOnEnter } from "../composer-keyboard";
import {
  ModelSettingsControls,
  ModelSettingsStatus,
  type ModelSelection,
} from "./ModelSettingsControls";

type ComposerProps = {
  scope: string;
  inputDisabled: boolean;
  sendDisabled: boolean;
  sending: boolean;
  onSend: (content: UserInput, settings: ModelSettings) => Promise<boolean>;
  selection: ModelSelection;
  contextControls?: ReactNode;
  compacting?: boolean;
};

export function Composer({
  scope,
  inputDisabled,
  sendDisabled,
  sending,
  onSend,
  selection,
  contextControls,
  compacting = false,
}: ComposerProps) {
  const [text, setText] = useDraftText(scope);
  const images = useImageDraft(scope);
  const unsupported =
    selection.catalog?.models.find(
      (model) => model.id === selection.draft?.modelId,
    )?.imageInput === "unsupported";
  const editingDisabled = inputDisabled || sending || compacting;
  const submissionDisabled = sendDisabled || editingDisabled;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (
      (value.length === 0 && images.images.length === 0) ||
      images.preparing ||
      (unsupported && images.images.length > 0) ||
      submissionDisabled ||
      !selection.valid ||
      !selection.draft
    )
      return;
    if (await onSend(images.content(value), selection.draft)) {
      setText("");
      images.clear();
    }
  }

  return (
    <form
      className={`composer${compacting ? " composer-compacting" : ""}`}
      onSubmit={submit}
      onPaste={(event) =>
        imagePaste(event, images, editingDisabled || unsupported)
      }
      onDragOver={imageDragOver}
      onDrop={(event) =>
        imageDrop(event, images, editingDisabled || unsupported)
      }
      aria-busy={compacting}
    >
      <ImageAttachments
        draft={images}
        disabled={editingDisabled}
        unsupported={unsupported}
      />
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
        <div className="composer-input-tools">
          <AttachImageButton
            draft={images}
            disabled={editingDisabled || unsupported}
          />
          <ModelSettingsControls
            selection={selection}
            disabled={submissionDisabled}
          />
        </div>
        <button
          className="round-send-button"
          aria-label={sending ? "发送中" : "发送"}
          disabled={
            submissionDisabled ||
            !selection.valid ||
            images.preparing ||
            (unsupported && images.images.length > 0) ||
            (text.trim().length === 0 && images.images.length === 0)
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
