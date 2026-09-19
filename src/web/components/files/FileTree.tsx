import { type CSSProperties, useEffect, useRef, useState } from "react";
import type {
  ProjectEntry,
  ProjectFileEntry,
  ProjectTreeListing,
} from "../../../shared/protocol";
import { listProjectFiles } from "../../api";
import { FileIcon } from "./FileIcon";
import { UiIcon } from "../UiIcon";
import { fileTabId } from "./FileTabs";

type TreeState = {
  listing?: ProjectTreeListing;
  loading?: boolean;
  error?: string;
};
export function FileTree({
  project,
  enabled,
  activePath,
  onOpenFile,
}: {
  project: ProjectEntry;
  enabled: boolean;
  activePath?: string;
  onOpenFile: (path: string) => void;
}) {
  const [directories, setDirectories] = useState<Record<string, TreeState>>({});
  const [expanded, setExpanded] = useState(new Set([""]));
  const controllers = useRef(new Map<string, AbortController>());
  function loadDirectory(path: string) {
    controllers.current.get(path)?.abort();
    const controller = new AbortController();
    controllers.current.set(path, controller);
    setDirectories((current) => ({ ...current, [path]: { loading: true } }));
    void listProjectFiles(project.projectId, path, controller.signal)
      .then(
        (listing) => {
          if (!controller.signal.aborted)
            setDirectories((current) => ({ ...current, [path]: { listing } }));
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setDirectories((current) => ({
              ...current,
              [path]: {
                error: error instanceof Error ? error.message : String(error),
              },
            }));
        },
      )
      .finally(() => {
        if (controllers.current.get(path) === controller)
          controllers.current.delete(path);
      });
  }

  useEffect(() => {
    if (enabled && directories[""] === undefined) loadDirectory("");
  }, [enabled]);
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
    },
    [],
  );
  function refreshTree() {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    setDirectories({});
    setExpanded(new Set([""]));
    loadDirectory("");
  }
  function toggleDirectory(path: string) {
    if (!expanded.has(path) && !directories[path]) loadDirectory(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function directoryChildren(path: string, depth: number): React.ReactNode {
    const state = directories[path];
    if (!state || state.loading)
      return (
        <li className="file-tree-note" role="status">
          读取中…
        </li>
      );
    if (state.error)
      return (
        <li className="file-tree-note file-error" role="alert">
          {state.error}
          <button type="button" onClick={() => loadDirectory(path)}>
            重试
          </button>
        </li>
      );
    const entries = state.listing?.entries ?? [];
    return (
      <>
        {entries.length === 0 && <li className="file-tree-note">空目录</li>}
        {entries.map((entry) => treeEntry(entry, depth))}
        {state.listing?.truncated && (
          <li className="file-tree-note">仅显示前 1000 项</li>
        )}
      </>
    );
  }
  function treeEntry(entry: ProjectFileEntry, depth: number): React.ReactNode {
    const isDirectory = entry.kind === "directory";
    const isExpanded = expanded.has(entry.path);
    return (
      <li key={entry.path}>
        <button
          type="button"
          className={`file-tree-entry${activePath === entry.path ? " active" : ""}`}
          style={{ "--tree-depth": depth } as CSSProperties}
          aria-expanded={isDirectory ? isExpanded : undefined}
          aria-current={
            !isDirectory && activePath === entry.path ? "page" : undefined
          }
          aria-label={`${isDirectory ? "目录" : "文件"} ${entry.path}`}
          disabled={entry.kind === "unavailable"}
          title={entry.reason ?? entry.path}
          onClick={() =>
            isDirectory ? toggleDirectory(entry.path) : onOpenFile(entry.path)
          }
          onKeyDown={(event) => {
            if (
              isDirectory &&
              ((event.key === "ArrowRight" && !isExpanded) ||
                (event.key === "ArrowLeft" && isExpanded))
            ) {
              event.preventDefault();
              toggleDirectory(entry.path);
            }
          }}
        >
          <span className={`file-tree-chevron${isExpanded ? " expanded" : ""}`}>
            {isDirectory && <UiIcon name="chevron-right" />}
          </span>
          <FileIcon folder={isDirectory} open={isExpanded} />
          <span className="file-tree-name">{entry.name}</span>
          {entry.symlink && <small title="符号链接">↗</small>}
        </button>
        {isDirectory && isExpanded && (
          <ul>{directoryChildren(entry.path, depth + 1)}</ul>
        )}
      </li>
    );
  }

  return (
    <section
      id="project-file-tree"
      className="file-tree"
      role="tabpanel"
      aria-labelledby={fileTabId()}
      hidden={activePath !== undefined}
    >
      <div className="file-tree-toolbar">
        <button
          aria-expanded={expanded.has("")}
          onClick={() => toggleDirectory("")}
          title={project.path}
          type="button"
        >
          <span
            className={`file-root-chevron${expanded.has("") ? " expanded" : ""}`}
          >
            <UiIcon name="chevron-right" />
          </span>
          <strong>{project.name}</strong>
        </button>
        <button
          className="icon-button"
          aria-label="刷新目录树"
          title="刷新目录树"
          onClick={refreshTree}
          type="button"
        >
          <UiIcon name="refresh" />
        </button>
      </div>
      {expanded.has("") && <ul>{directoryChildren("", 0)}</ul>}
    </section>
  );
}
