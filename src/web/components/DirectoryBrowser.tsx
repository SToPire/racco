import { UiIcon } from "./UiIcon";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { DirectoryListing, ProjectEntry } from "../../shared/protocol";
import { listDirectories } from "../api";

type Props = {
  initialPath?: string;
  projects: ProjectEntry[];
  onClose: () => void;
  onImport: (path: string) => Promise<void>;
};

function FolderIcon({ open = false }: { open?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M3 8V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1" />
      <path d={open ? "M3 10h18l-2 9H5l-2-9Z" : "M3 8v11h18V8H3Z"} />
    </svg>
  );
}

function crumbs(path: string) {
  const result = [{ name: "文件系统", path: "/" }];
  const parts = path.split("/").filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    result.push({
      name: parts[index],
      path: `/${parts.slice(0, index + 1).join("/")}`,
    });
  }
  return result;
}

export function DirectoryBrowser({
  initialPath,
  projects,
  onClose,
  onImport,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [request, setRequest] = useState<{ path?: string }>({
    path: initialPath,
  });
  const [listing, setListing] = useState<DirectoryListing>();
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [importError, setImportError] = useState<string>();
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(undefined);
    setImportError(undefined);
    void listDirectories(request.path, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setListing(next);
        setPathInput(next.path);
        setSelectedPath(undefined);
        setLoading(false);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [request]);

  function navigate(path?: string) {
    if (importing) return;
    setLoading(true);
    setSelectedPath(undefined);
    setFilter("");
    setRequest({ path });
  }

  function jump(event: FormEvent) {
    event.preventDefault();
    if (pathInput.length > 0) navigate(pathInput);
  }

  const entries =
    listing?.entries.filter(
      (entry) =>
        (showHidden || !entry.hidden) &&
        entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) ?? [];
  const chosenPath = selectedPath ?? listing?.path;
  const pathEdited = listing !== undefined && pathInput !== listing.path;
  const canImport =
    !pathEdited &&
    chosenPath !== undefined &&
    chosenPath !== "/" &&
    !loading &&
    loadError === undefined &&
    !importing;
  const alreadyImported = projects.some(
    (project) => project.path === chosenPath,
  );

  async function confirm() {
    if (!canImport || chosenPath === undefined) return;
    setImporting(true);
    setImportError(undefined);
    try {
      await onImport(chosenPath);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  return (
    <dialog
      aria-labelledby="directory-browser-title"
      aria-describedby="directory-browser-description"
      className="directory-browser"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!importing) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !importing) onClose();
      }}
    >
      <div className="directory-browser-panel">
        <header className="directory-browser-header">
          <span className="directory-browser-mark">
            <FolderIcon open />
          </span>
          <div>
            <h2 id="directory-browser-title">导入项目</h2>
            <p id="directory-browser-description">
              选择 Racco 所在电脑上的项目文件夹
            </p>
          </div>
          <button
            aria-label="关闭目录浏览器"
            className="directory-icon-button icon-button"
            disabled={importing}
            onClick={onClose}
            type="button"
          >
            <UiIcon name="close" />
          </button>
        </header>

        <form className="directory-location" onSubmit={jump}>
          <button
            aria-label="上一级目录"
            className="directory-icon-button icon-button"
            disabled={loading || importing || listing?.parentPath == null}
            onClick={() => navigate(listing?.parentPath ?? undefined)}
            type="button"
            title="上一级目录"
          >
            <UiIcon name="up" />
          </button>
          <div className="directory-path-input">
            <FolderIcon />
            <input
              aria-label="目录路径"
              autoFocus
              autoComplete="off"
              disabled={importing}
              onChange={(event) => setPathInput(event.target.value)}
              placeholder="输入绝对目录路径，按 Enter 跳转"
              spellCheck={false}
              value={pathInput}
            />
            <button
              disabled={pathInput.length === 0 || importing}
              type="submit"
              aria-label="跳转到目录"
              title="跳转到目录"
            >
              <UiIcon name="enter" />
            </button>
          </div>
        </form>

        <div className="directory-browser-body">
          <aside className="directory-shortcuts" aria-label="常用位置">
            <span className="directory-section-label">位置</span>
            <button
              className={
                listing?.path === listing?.homePath && listing !== undefined
                  ? "active"
                  : ""
              }
              disabled={importing}
              onClick={() => navigate()}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="m3 10 9-7 9 7M5 9v11h5v-7h4v7h5V9" />
              </svg>
              主目录
            </button>
            <button
              className={listing?.path === "/" ? "active" : ""}
              disabled={importing}
              onClick={() => navigate("/")}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path d="M8 21h8m-4-5v5" />
              </svg>
              文件系统
            </button>
            {projects.length > 0 && (
              <span className="directory-section-label directory-project-label">
                已导入项目
              </span>
            )}
            {projects.slice(0, 6).map((project) => (
              <button
                key={project.projectId}
                disabled={importing || !project.available}
                className={listing?.path === project.path ? "active" : ""}
                onClick={() => navigate(project.path)}
                title={project.path}
                type="button"
              >
                <FolderIcon />
                <span>{project.name}</span>
              </button>
            ))}
          </aside>

          <section className="directory-content" aria-label="目录内容">
            <nav className="directory-breadcrumbs" aria-label="当前目录">
              {listing !== undefined &&
                crumbs(listing.path).map((crumb, index, all) => (
                  <span key={crumb.path}>
                    {index > 0 && (
                      <span
                        aria-hidden="true"
                        className="directory-crumb-separator"
                      >
                        /
                      </span>
                    )}
                    <button
                      aria-current={
                        index === all.length - 1 ? "location" : undefined
                      }
                      disabled={importing}
                      onClick={() => navigate(crumb.path)}
                      title={crumb.path}
                      type="button"
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
            </nav>
            <label className="directory-filter">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="10.5" cy="10.5" r="6" />
                <path d="m15 15 5 5" />
              </svg>
              <input
                aria-label="筛选文件夹"
                disabled={importing}
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setSelectedPath(undefined);
                }}
                placeholder="筛选当前目录的文件夹"
              />
            </label>
            <div className="directory-list" aria-busy={loading}>
              {loading ? (
                <div className="directory-empty" role="status">
                  <span className="button-spinner" />
                  正在读取目录…
                </div>
              ) : loadError ? (
                <div
                  className="directory-empty directory-load-error"
                  role="alert"
                >
                  <strong>无法打开这个文件夹</strong>
                  <span>{loadError}</span>
                  <button onClick={() => navigate(request.path)} type="button">
                    重试
                  </button>
                </div>
              ) : entries.length === 0 ? (
                <div className="directory-empty" role="status">
                  <FolderIcon open />
                  <strong>
                    {filter ? "没有匹配的文件夹" : "没有可显示的子文件夹"}
                  </strong>
                  <span>
                    {filter
                      ? "试试其他名称，或清空筛选条件。"
                      : "可以直接导入当前目录。"}
                  </span>
                </div>
              ) : (
                entries.map((entry) => (
                  <div
                    className={`directory-entry${selectedPath === entry.path ? " selected" : ""}`}
                    key={entry.path}
                  >
                    <button
                      className="directory-entry-select"
                      aria-label={`选择文件夹 ${entry.name}`}
                      aria-pressed={selectedPath === entry.path}
                      disabled={importing}
                      onClick={() => {
                        setSelectedPath(entry.path);
                        setPathInput(listing?.path ?? "");
                        setImportError(undefined);
                      }}
                      onDoubleClick={() => navigate(entry.path)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" ||
                          event.key === "ArrowRight"
                        ) {
                          event.preventDefault();
                          navigate(entry.path);
                        }
                      }}
                      type="button"
                    >
                      <FolderIcon open={selectedPath === entry.path} />
                      <span>{entry.name}</span>
                      {projects.some(
                        (project) => project.path === entry.path,
                      ) && <small>已导入</small>}
                    </button>
                    <button
                      className="directory-entry-open"
                      aria-label={`打开文件夹 ${entry.name}`}
                      disabled={importing}
                      onClick={() => navigate(entry.path)}
                      title="打开文件夹"
                      type="button"
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24">
                        <path d="m9 6 6 6-6 6" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="directory-list-footer">
              <label>
                <input
                  type="checkbox"
                  checked={showHidden}
                  disabled={importing}
                  onChange={(event) => {
                    setShowHidden(event.target.checked);
                    setSelectedPath(undefined);
                  }}
                />
                显示隐藏目录
              </label>
              {!loading && !loadError && <span>{entries.length} 个文件夹</span>}
            </div>
          </section>
        </div>

        {listing?.truncated && !loading && !loadError && (
          <p className="directory-notice">
            目录较大，仅显示部分文件夹；可输入完整路径跳转。
          </p>
        )}
        {importError && (
          <p className="directory-import-error" role="alert">
            {importError}
          </p>
        )}
        <footer className="directory-browser-footer">
          <div className="directory-selection">
            <span>所选目录</span>
            <strong title={chosenPath}>
              {loading || loadError
                ? "请选择一个可读取的文件夹"
                : pathEdited
                  ? "按 Enter 跳转到输入的目录"
                  : (chosenPath ?? "尚未选择")}
            </strong>
          </div>
          <button
            className="directory-cancel"
            disabled={importing}
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="directory-confirm"
            disabled={!canImport}
            onClick={() => void confirm()}
            type="button"
          >
            {importing ? (
              <>
                <span className="button-spinner" />
                导入中…
              </>
            ) : alreadyImported ? (
              "使用此项目"
            ) : (
              "导入项目"
            )}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
