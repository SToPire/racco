import { type ReactNode, useCallback, useEffect } from "react";
import type { WorktreeEntry } from "../../../shared/protocol";
import { FileTabs, fileTabId } from "./FileTabs";
import { FileTree } from "./FileTree";
import { FilePreview } from "./FilePreview";
import type {
  FileOpenRequest,
  ProjectFileLocation,
} from "../../file-navigation";

export type ProjectFileState = {
  tabs: string[];
  activeFile?: ProjectFileLocation & { requestId?: number };
};
export const emptyFileState: ProjectFileState = { tabs: [] };

export function ProjectFiles({
  worktree,
  enabled,
  controls,
  fileRequest,
  onFileOpened,
  state,
  onStateChange,
}: {
  worktree: WorktreeEntry;
  enabled: boolean;
  controls: ReactNode;
  fileRequest?: FileOpenRequest;
  onFileOpened: (requestId: number) => void;
  state: ProjectFileState;
  onStateChange: (
    update: (current: ProjectFileState) => ProjectFileState,
  ) => void;
}) {
  const { tabs, activeFile } = state;
  const activePath = activeFile?.path;
  const openFile = useCallback(
    (path: string, line?: number, requestId?: number) => {
      onStateChange((current) => ({
        tabs: current.tabs.includes(path)
          ? current.tabs
          : [...current.tabs, path],
        activeFile: { path, line, requestId },
      }));
      requestAnimationFrame(() =>
        document.getElementById(fileTabId(path))?.focus(),
      );
    },
    [onStateChange],
  );
  useEffect(() => {
    if (!enabled || fileRequest === undefined) return;
    openFile(fileRequest.path, fileRequest.line, fileRequest.requestId);
    onFileOpened(fileRequest.requestId);
  }, [enabled, fileRequest, openFile, onFileOpened]);
  function selectFile(path: string | undefined) {
    onStateChange((current) => ({
      ...current,
      activeFile: path === undefined ? undefined : { path },
    }));
  }
  function closeFile(path: string) {
    const next = tabs.filter((tab) => tab !== path);
    const nextActive =
      activePath === path
        ? next[Math.min(tabs.indexOf(path), next.length - 1)]
        : activePath;
    onStateChange((current) => ({
      tabs: next,
      activeFile:
        activePath === path
          ? nextActive === undefined
            ? undefined
            : { path: nextActive }
          : current.activeFile,
    }));
    requestAnimationFrame(() =>
      document.getElementById(fileTabId(nextActive))?.focus(),
    );
  }
  return (
    <>
      <div className="file-dock-tabs-row">
        <FileTabs
          tabs={tabs}
          activePath={activePath}
          enabled={enabled}
          onSelect={selectFile}
          onClose={closeFile}
        />
        {controls}
      </div>
      <div className="file-dock-body">
        <FileTree
          worktree={worktree}
          enabled={enabled}
          activePath={activePath}
          onOpenFile={openFile}
        />
        <FilePreview
          worktree={worktree}
          enabled={enabled}
          activePath={activePath}
          line={activeFile?.line}
          locationRequestId={activeFile?.requestId}
        />
      </div>
    </>
  );
}
