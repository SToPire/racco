import { type ReactNode, useState } from "react";
import type { ProjectEntry } from "../../../shared/protocol";
import { FileTabs, fileTabId } from "./FileTabs";
import { FileTree } from "./FileTree";
import { FilePreview } from "./FilePreview";

export function ProjectFiles({
  project,
  enabled,
  controls,
}: {
  project: ProjectEntry;
  enabled: boolean;
  controls: ReactNode;
}) {
  const [tabs, setTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string>();
  function openFile(path: string) {
    setTabs((current) =>
      current.includes(path) ? current : [...current, path],
    );
    setActivePath(path);
    requestAnimationFrame(() =>
      document.getElementById(fileTabId(path))?.focus(),
    );
  }
  function closeFile(path: string) {
    const next = tabs.filter((tab) => tab !== path);
    const nextActive =
      activePath === path
        ? next[Math.min(tabs.indexOf(path), next.length - 1)]
        : activePath;
    setTabs(next);
    setActivePath(nextActive);
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
          onSelect={setActivePath}
          onClose={closeFile}
        />
        {controls}
      </div>
      <div className="file-dock-body">
        <FileTree
          project={project}
          enabled={enabled}
          activePath={activePath}
          onOpenFile={openFile}
        />
        <FilePreview
          project={project}
          enabled={enabled}
          activePath={activePath}
        />
      </div>
    </>
  );
}
