import { useEffect, useRef, useState, type ReactNode } from "react";
import type { WorktreeEntry } from "../../shared/protocol";
import type {
  GitChangeDiff,
  GitChangeEntry,
  GitChanges,
  GitChangeGroup,
} from "../../shared/git-changes";
import { parseUnifiedDiff } from "../../shared/file-diff";
import { GitApiError, listGitChanges, readGitDiff } from "../git-changes-api";
import { DiffBlock } from "./FileChanges";
import { UiIcon } from "./UiIcon";

const labels: Record<GitChangeGroup, string> = {
  conflict: "冲突",
  unstaged: "未暂存",
  staged: "已暂存",
  untracked: "未跟踪",
};
const groups: GitChangeGroup[] = [
  "conflict",
  "unstaged",
  "staged",
  "untracked",
];
function identity(entry: GitChangeEntry) {
  return JSON.stringify([entry.group, entry.path, entry.oldPath]);
}

export function ProjectChanges({
  worktree,
  enabled,
  controls,
  onOpenFile,
}: {
  worktree: WorktreeEntry;
  enabled: boolean;
  controls: ReactNode;
  onOpenFile: (path: string, file: string) => void;
}) {
  const [listing, setListing] = useState<GitChanges>();
  const [selected, setSelected] = useState<GitChangeEntry>();
  const [detail, setDetail] = useState<GitChangeDiff>();
  const [listError, setListError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [listBusy, setListBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const listLoading = useRef(false);
  const deferredDetail = useRef(false);
  const detailBody = useRef<HTMLDivElement>(null);
  const selection = selected ? identity(selected) : "";

  // Navigation and the refresh button are the only list refresh triggers.
  useEffect(() => {
    if (!enabled) {
      setListBusy(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    listLoading.current = true;
    setListBusy(true);
    setListError(undefined);
    async function load() {
      try {
        const next = await listGitChanges(worktree.path, controller.signal);
        if (disposed) return;
        listLoading.current = false;
        setListing(next);
        setSelected((current) =>
          current
            ? next.entries.find(
                (entry) =>
                  entry.path === current.path && entry.group === current.group,
              )
            : undefined,
        );
      } catch (failure) {
        if (disposed || controller.signal.aborted) return;
        setListError(failure instanceof Error ? failure.message : "读取失败。");
        if (
          failure instanceof GitApiError &&
          (failure.status === 403 || failure.status === 404)
        ) {
          setListing(undefined);
          setSelected(undefined);
          setDetail(undefined);
        }
      } finally {
        if (!disposed) {
          listLoading.current = false;
          setListBusy(false);
          if (deferredDetail.current) {
            deferredDetail.current = false;
            setDetailRevision((value) => value + 1);
          }
        }
      }
    }
    void load();
    return () => {
      disposed = true;
      listLoading.current = false;
      deferredDetail.current = false;
      controller.abort();
    };
  }, [enabled, worktree.path, refresh]);

  // Choosing a file reads only its patch; a successful list refresh re-reads it.
  useEffect(() => {
    if (!selected) {
      setDetail(undefined);
      setDetailError(undefined);
      setDetailBusy(false);
      return;
    }
    if (!enabled || listLoading.current) {
      setDetailBusy(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    setDetailBusy(true);
    setDetailError(undefined);
    async function load() {
      try {
        const diff = await readGitDiff(
          worktree.path,
          selected!.path,
          selected!.group,
          controller.signal,
        );
        if (disposed) return;
        if (diff.oldPath !== selected!.oldPath) {
          setDetailError("修改条目已变化，请手动刷新 Git 修改。");
          return;
        }
        setDetail(diff);
      } catch (failure) {
        if (disposed || controller.signal.aborted) return;
        setDetailError(
          failure instanceof Error ? failure.message : "读取失败。",
        );
        if (
          failure instanceof GitApiError &&
          (failure.status === 403 || failure.status === 404)
        ) {
          setDetail(undefined);
        }
      } finally {
        if (!disposed) setDetailBusy(false);
      }
    }
    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [enabled, worktree.path, selection, listing, detailRevision]);

  const error = listError ?? detailError;
  const busy = listBusy || detailBusy;

  const visibleDetail =
    detail &&
    selected &&
    detail.file === selected.path &&
    detail.group === selected.group &&
    detail.oldPath === selected.oldPath
      ? detail
      : undefined;
  const rows =
    visibleDetail?.kind === "text" ? parseUnifiedDiff(visibleDetail.diff) : [];
  const select = (entry: GitChangeEntry) => {
    if (identity(entry) === selection) return;
    // Keep a user selection pending until the current list attempt settles.
    deferredDetail.current = listLoading.current;
    setSelected(entry);
    setDetail(undefined);
    setDetailError(undefined);
    if (detailBody.current) detailBody.current.scrollTop = 0;
  };
  return (
    <>
      <header className="file-dock-tabs-row">
        <span className="dock-panel-title">
          <UiIcon name="branch" />
          Git 修改
        </span>
        <button
          className="icon-button"
          type="button"
          aria-label="刷新 Git 修改"
          title="刷新 Git 修改"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <UiIcon name="refresh" />
        </button>
        {controls}
      </header>
      <div className="git-changes-body">
        <div className="git-changes-summary">
          <strong>
            {listing?.branch ??
              (listing?.head
                ? `Detached ${listing.head.slice(0, 8)}`
                : "Git 修改")}
          </strong>
          <code title={worktree.path}>{worktree.path}</code>
          <span role="status">
            {error
              ? `读取失败，结果可能已过期：${error}`
              : busy
                ? "更新中…"
                : listing
                  ? `${listing.entries.length} 项修改 · ${new Date(listing.readAt).toLocaleTimeString()}`
                  : "打开后读取当前未提交修改。"}
          </span>
          {error && listing && (
            <small>
              上次成功读取：{new Date(listing.readAt).toLocaleTimeString()}
            </small>
          )}
        </div>
        <div className="git-change-list" aria-label="Git 修改文件">
          {!listing && <p>{error ?? "正在读取 Git 修改…"}</p>}
          {listing?.entries.length === 0 && (
            <p>
              {error
                ? "上次读取时无修改；当前状态未确认。"
                : "工作区干净，没有未提交修改。"}
            </p>
          )}
          {groups.map((group) => {
            const entries =
              listing?.entries.filter((entry) => entry.group === group) ?? [];
            return (
              entries.length > 0 && (
                <section key={group} aria-label={labels[group]}>
                  <h3>
                    {labels[group]} <span>{entries.length}</span>
                  </h3>
                  {entries.map((entry) => (
                    <button
                      type="button"
                      key={identity(entry)}
                      className={`git-change-row${identity(entry) === selection ? " selected" : ""}`}
                      aria-pressed={identity(entry) === selection}
                      aria-label={`${labels[group]} ${entry.path}`}
                      title={
                        entry.oldPath
                          ? `${entry.oldPath} → ${entry.path}`
                          : entry.path
                      }
                      onClick={() => select(entry)}
                    >
                      <span className="git-change-status">{entry.status}</span>
                      <span>
                        {entry.oldPath && (
                          <>
                            <span className="git-old-path">
                              {entry.oldPath}
                            </span>{" "}
                            →{" "}
                          </>
                        )}
                        {entry.path}
                      </span>
                      {entry.submodule && <small>子模块</small>}
                    </button>
                  ))}
                </section>
              )
            );
          })}
        </div>
        <div
          className="git-change-detail"
          ref={detailBody}
          aria-label="Git 文件差异"
        >
          {selected && (
            <>
              <div className="git-detail-toolbar">
                <strong title={selected.path}>{selected.path}</strong>
                <span>{labels[selected.group]}</span>
                <button
                  type="button"
                  disabled={!visibleDetail?.currentFileAvailable || !!error}
                  onClick={() => onOpenFile(worktree.path, selected.path)}
                >
                  打开当前文件
                </button>
              </div>
              {selected.oldPath && (
                <p className="git-detail-note">
                  重命名：{selected.oldPath} → {selected.path}
                </p>
              )}
              {visibleDetail ? (
                <>
                  {visibleDetail.reason && (
                    <p className="git-detail-note">{visibleDetail.reason}</p>
                  )}
                  {visibleDetail.kind === "text" && (
                    <p className="git-diff-count">
                      <span>
                        +{rows.filter((row) => row.kind === "added").length}
                      </span>{" "}
                      <span>
                        −{rows.filter((row) => row.kind === "removed").length}
                      </span>
                    </p>
                  )}
                  {visibleDetail.diff && (
                    <DiffBlock text={visibleDetail.diff} />
                  )}
                </>
              ) : (
                <p className="git-detail-note">
                  {error ? "当前差异未能读取，请重试。" : "正在读取差异…"}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
