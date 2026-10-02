import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import type { ComposerDrafts } from "../composer-drafts";

export const ComposerDraftContext = createContext<ComposerDrafts | undefined>(
  undefined,
);

export function useComposerDraft(scope: string) {
  const drafts = useContext(ComposerDraftContext);
  if (drafts === undefined) throw new Error("Missing composer draft owner");
  const subscribe = useCallback(
    (listener: () => void) => drafts.subscribe(scope, listener),
    [drafts, scope],
  );
  const get = useCallback(() => drafts.get(scope), [drafts, scope]);
  return { drafts, draft: useSyncExternalStore(subscribe, get, get) };
}

export function useDraftText(scope: string) {
  const { drafts, draft } = useComposerDraft(scope);
  return [draft.text, (text: string) => drafts.setText(scope, text)] as const;
}
