import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { WorktreeEntry } from "../../../shared/protocol";
import { FileTabs, fileTabId } from "./FileTabs";
import { FileTree } from "./FileTree";
import { FilePreview } from "./FilePreview";
import type {
  FileOpenRequest,
  ProjectFileLocation,
} from "../../file-navigation";

export function ProjectFiles({
  worktree,
  enabled,
  controls,
  fileRequest,
  onFileOpened,
}: {
  worktree: WorktreeEntry;
  enabled: boolean;
  controls: ReactNode;
  fileRequest?: FileOpenRequest;
  onFileOpened: (requestId: number) => void;
}) {
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<
    ProjectFileLocation & { requestId?: number }
  >();
  const activePath = activeFile?.path;
  const openFile = useCallback(
    (path: string, line?: number, requestId?: number) => {
      setTabs((current) =>
        current.includes(path) ? current : [...current, path],
      );
      setActiveFile({ path, line, requestId });
      requestAnimationFrame(() =>
        document.getElementById(fileTabId(path))?.focus(),
      );
    },
    [],
  );
  useEffect(() => {
    if (!enabled || fileRequest === undefined) return;
    openFile(fileRequest.path, fileRequest.line, fileRequest.requestId);
    onFileOpened(fileRequest.requestId);
  }, [enabled, fileRequest, openFile, onFileOpened]);
  function selectFile(path: string | undefined) {
    setActiveFile(path === undefined ? undefined : { path });
  }
  function closeFile(path: string) {
    const next = tabs.filter((tab) => tab !== path);
    const nextActive =
      activePath === path
        ? next[Math.min(tabs.indexOf(path), next.length - 1)]
        : activePath;
    setTabs(next);
    if (activePath === path) selectFile(nextActive);
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
