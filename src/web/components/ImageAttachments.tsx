import { useRef, type ClipboardEvent, type DragEvent } from "react";
import type { useImageDraft } from "../hooks/useImageDraft";

export type ImageDraft = ReturnType<typeof useImageDraft>;

export function imagePaste(
  event: ClipboardEvent,
  draft: ImageDraft,
  disabled: boolean,
) {
  const files = [...event.clipboardData.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (files.length === 0) return;
  event.preventDefault();
  if (!disabled) void draft.add(files);
}
export function imageDrop(
  event: DragEvent,
  draft: ImageDraft,
  disabled: boolean,
) {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  if (!disabled) void draft.add([...event.dataTransfer.files]);
}
export function imageDragOver(event: DragEvent) {
  if (event.dataTransfer.types.includes("Files")) event.preventDefault();
}

export function AttachImageButton({
  draft,
  disabled,
}: {
  draft: ImageDraft;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        aria-label="选择图片文件"
        disabled={disabled || draft.preparing}
        onChange={(event) => {
          if (event.target.files) void draft.add([...event.target.files]);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="attach-image-button"
        aria-label="添加图片"
        title="添加图片，也可粘贴或拖拽"
        disabled={disabled || draft.preparing}
        onClick={() => input.current?.click()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="8" cy="8" r="1.5" />
          <path d="m4 17 5-5 4 4 3-3 5 5" />
        </svg>
      </button>
    </>
  );
}

export function ImageAttachments({
  draft,
  disabled,
  unsupported,
}: {
  draft: ImageDraft;
  disabled: boolean;
  unsupported: boolean;
}) {
  return (
    <>
      {draft.images.length > 0 && (
        <div className="image-attachments" aria-label="待发送图片">
          {draft.images.map((image, index) => (
            <div className="image-attachment" key={image.id}>
              <a
                href={image.url}
                target="_blank"
                rel="noreferrer"
                title={`预览 ${image.name}`}
              >
                <img src={image.url} alt={`图片 ${index + 1}：${image.name}`} />
              </a>
              <button
                type="button"
                aria-label={`移除图片 ${index + 1}`}
                disabled={disabled || draft.preparing}
                onClick={() => draft.remove(image.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {draft.preparing && (
        <small className="image-input-status" role="status">
          正在读取图片…
        </small>
      )}
      {(draft.error || (unsupported && draft.images.length > 0)) && (
        <small className="image-input-error" role="alert">
          {draft.error ?? "所选模型不支持图片，请选择其他模型"}
        </small>
      )}
    </>
  );
}
