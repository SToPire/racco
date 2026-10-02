import type { UserInput } from "../../shared/user-input";
import { useComposerDraft } from "./useComposerDraft";

export function useImageDraft(scope: string) {
  const { drafts, draft } = useComposerDraft(scope);
  function content(text: string): UserInput {
    return [
      ...(text.trim() ? [{ type: "text" as const, text: text.trim() }] : []),
      ...draft.images.map((image) => image.content),
    ];
  }
  return {
    images: draft.images,
    preparing: draft.preparing,
    error: draft.error,
    add: (files: File[]) => drafts.addImages(scope, files),
    remove: (id: string) => drafts.removeImage(scope, id),
    clear: () => drafts.clearImages(scope),
    content,
  };
}
