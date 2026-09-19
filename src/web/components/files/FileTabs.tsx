import { type KeyboardEvent, useEffect, useRef } from "react";
import { FileIcon } from "./FileIcon";
import { UiIcon } from "../UiIcon";

export function fileTabId(path?: string): string {
  return path === undefined
    ? "files-tree-tab"
    : `file-tab-${encodeURIComponent(path)}`;
}

function FileTabIcon({ path }: { path: string }) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "ts" || extension === "tsx")
    return (
      <span className="file-type-badge typescript" aria-hidden="true">
        TS
      </span>
    );
  if (["js", "jsx", "mjs", "cjs"].includes(extension ?? ""))
    return (
      <span className="file-type-badge javascript" aria-hidden="true">
        JS
      </span>
    );
  return <FileIcon />;
}

export function FileTabs({
  tabs,
  activePath,
  enabled,
  onSelect,
  onClose,
}: {
  tabs: string[];
  activePath?: string;
  enabled: boolean;
  onSelect: (path: string | undefined) => void;
  onClose: (path: string) => void;
}) {
  const activeTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (enabled)
      activeTab.current?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
  }, [activePath, enabled]);
  function switchTab(event: KeyboardEvent, index: number) {
    const choices = [undefined, ...tabs];
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % choices.length;
    else if (event.key === "ArrowLeft")
      next = (index + choices.length - 1) % choices.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = choices.length - 1;
    else return;
    event.preventDefault();
    onSelect(choices[next]);
    document.getElementById(fileTabId(choices[next]))?.focus();
  }

  return (
    <div className="file-tabs" role="tablist" aria-label="文件浏览选项卡">
      <button
        className="file-tab-files"
        role="tab"
        aria-selected={activePath === undefined}
        aria-controls="project-file-tree"
        id={fileTabId()}
        tabIndex={activePath === undefined ? 0 : -1}
        ref={activePath === undefined ? activeTab : undefined}
        onClick={() => onSelect(undefined)}
        onKeyDown={(event) => switchTab(event, 0)}
        title="浏览项目目录"
        type="button"
      >
        <FileIcon folder />
        <span>Files</span>
      </button>
      {tabs.map((path, index) => (
        <div
          className={`file-tab-wrap${path === activePath ? " active" : ""}`}
          key={path}
        >
          <button
            role="tab"
            aria-selected={activePath === path}
            aria-controls="file-preview"
            id={fileTabId(path)}
            tabIndex={activePath === path ? 0 : -1}
            ref={activePath === path ? activeTab : undefined}
            onClick={() => onSelect(path)}
            onKeyDown={(event) => switchTab(event, index + 1)}
            title={path}
            type="button"
          >
            <FileTabIcon path={path} />
            <span>{path.split("/").at(-1)}</span>
          </button>
          <button
            className="file-tab-close icon-button"
            aria-label={`关闭文件 ${path}`}
            onClick={() => onClose(path)}
            type="button"
          >
            <UiIcon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
