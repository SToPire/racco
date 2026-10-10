import { useEffect, useRef, useState } from "react";
import type {
  GitCommitDetail,
  GitCommitDiff,
  GitCommitSummary,
} from "../../shared/git-history";
import {
  GitPatchCache,
  readGitCommit,
  readGitCommitDiff,
} from "../git-history-api";
import { GitApiError } from "../git-request";
import { DiffBlock } from "./FileChanges";

export function GitCommitDetails({
  path,
  snapshotId,
  commit,
  enabled,
  cache,
  onBack,
  onInvalid,
}: {
  path: string;
  snapshotId: string;
  commit: GitCommitSummary;
  enabled: boolean;
  cache: GitPatchCache<GitCommitDiff>;
  onBack: () => void;
  onInvalid: (failure: GitApiError) => void;
}) {
  const [parent, setParent] = useState(commit.parents[0] ?? "root");
  const [detail, setDetail] = useState<GitCommitDetail>();
  const [file, setFile] = useState<string>();
  const [patch, setPatch] = useState<GitCommitDiff>();
  const [error, setError] = useState<string>();
  const [canRetry, setCanRetry] = useState(true);
  const [detailBusy, setDetailBusy] = useState(false);
  const [patchBusy, setPatchBusy] = useState(false);
  const busy = detailBusy || patchBusy;
  const [revision, setRevision] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const invalid = useRef(onInvalid);
  invalid.current = onInvalid;
  const key = JSON.stringify([path, snapshotId, commit.oid, parent, file]);
  const visibleDetail =
    detail?.baseOid === (parent === "root" ? null : parent)
      ? detail
      : undefined;
  const visiblePatch =
    patch?.baseOid === (parent === "root" ? null : parent) &&
    patch?.file === file
      ? patch
      : undefined;

  useEffect(() => {
    if (!enabled || visibleDetail) {
      setDetailBusy(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    setDetailBusy(true);
    setError(undefined);
    void readGitCommit(path, snapshotId, commit.oid, parent, controller.signal)
      .then((next) => {
        if (!disposed) setDetail(next);
      })
      .catch((failure: unknown) => {
        if (disposed || controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : "提交读取失败。");
        const terminal =
          failure instanceof GitApiError &&
          (failure.status === 403 ||
            failure.status === 404 ||
            failure.status === 410 ||
            failure.status === 413 ||
            failure.code === "HISTORY_EXPIRED" ||
            failure.code === "HISTORY_LIMIT");
        setCanRetry(!terminal);
        if (failure instanceof GitApiError) invalid.current(failure);
      })
      .finally(() => {
        if (!disposed) setDetailBusy(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [path, snapshotId, commit.oid, parent, enabled, revision, visibleDetail]);

  useEffect(() => {
    if (!enabled || !file || !visibleDetail) {
      setPatchBusy(false);
      return;
    }
    const cached = cache.get(key);
    if (cached) {
      setPatch(cached);
      setPatchBusy(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    setPatchBusy(true);
    setError(undefined);
    void readGitCommitDiff(
      path,
      snapshotId,
      commit.oid,
      parent,
      file,
      controller.signal,
    )
      .then((next) => {
        if (disposed) return;
        cache.set(key, next);
        setPatch(next);
      })
      .catch((failure: unknown) => {
        if (disposed || controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : "差异读取失败。");
        const terminal =
          failure instanceof GitApiError &&
          (failure.status === 403 ||
            failure.status === 404 ||
            failure.status === 410 ||
            failure.status === 413 ||
            failure.code === "HISTORY_EXPIRED" ||
            failure.code === "HISTORY_LIMIT");
        setCanRetry(!terminal);
        if (failure instanceof GitApiError) invalid.current(failure);
      })
      .finally(() => {
        if (!disposed) setPatchBusy(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [
    path,
    snapshotId,
    commit.oid,
    parent,
    file,
    enabled,
    visibleDetail,
    key,
    cache,
    revision,
  ]);

  const backToFiles = () => {
    setFile(undefined);
    setPatch(undefined);
    setError(undefined);
    if (body.current) body.current.scrollTop = 0;
  };
  return (
    <div
      className="git-commit-detail"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (file) backToFiles();
        else onBack();
      }}
    >
      <div className="git-detail-toolbar">
        <button type="button" onClick={onBack}>
          返回提交历史
        </button>
        {file && (
          <button type="button" onClick={backToFiles}>
            返回提交文件
          </button>
        )}
      </div>
      <div className="git-commit-detail-body" ref={body}>
        {!file && (
          <>
            <div className="git-commit-metadata">
              <strong>
                {commit.subject ||
                  (commit.textUnavailableReason
                    ? "提交说明不可显示"
                    : "（无提交标题）")}
              </strong>
              {visibleDetail && (
                <span>
                  {visibleDetail.commit.committer.name} ·{" "}
                  <time dateTime={commit.committedAt}>
                    {new Date(commit.committedAt).toLocaleString()}
                  </time>
                </span>
              )}
            </div>
            {commit.textUnavailableReason && (
              <p className="git-detail-note" role="note">
                {commit.textUnavailableReason}
              </p>
            )}
            {commit.parents.length > 1 && (
              <div className="git-detail-toolbar">
                <label>
                  比较父提交{" "}
                  <select
                    aria-label="比较父提交"
                    value={parent}
                    onChange={(event) => {
                      setParent(event.target.value);
                      setDetail(undefined);
                      setFile(undefined);
                      setPatch(undefined);
                      setError(undefined);
                    }}
                  >
                    {commit.parents.map((oid, index) => (
                      <option value={oid} key={oid}>
                        {index + 1} · {oid.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {visibleDetail?.unavailableReason && (
              <p className="git-detail-note">
                {visibleDetail.unavailableReason}
              </p>
            )}
            {visibleDetail &&
              !visibleDetail.unavailableReason &&
              visibleDetail.files.length === 0 && (
                <p className="git-detail-note">
                  此比较没有文件修改（空提交）。
                </p>
              )}
            <div aria-label="提交修改文件">
              {visibleDetail?.files.map((entry) => (
                <button
                  type="button"
                  className="git-change-row"
                  key={entry.path}
                  aria-label={`提交文件 ${entry.status} ${entry.path}`}
                  onClick={() => {
                    setFile(entry.path);
                    setPatch(undefined);
                    setError(undefined);
                    if (body.current) body.current.scrollTop = 0;
                  }}
                >
                  <span className="git-change-status">{entry.status}</span>
                  <span>
                    {entry.oldPath ? `${entry.oldPath} → ` : ""}
                    {entry.path}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {file && (
          <div className="git-commit-diff" aria-label="提交文件差异">
            <div className="git-detail-toolbar">
              <strong>{file}</strong>
              <span>
                基线 {parent === "root" ? "空树" : parent.slice(0, 8)}
              </span>
            </div>
            {visiblePatch?.oldPath && (
              <p className="git-detail-note">
                重命名：{visiblePatch.oldPath} → {file}
              </p>
            )}
            {visiblePatch?.reason && (
              <p className="git-detail-note">{visiblePatch.reason}</p>
            )}
            {visiblePatch?.diff && <DiffBlock text={visiblePatch.diff} />}
          </div>
        )}
        {busy && (
          <p className="git-detail-note" role="status">
            正在读取{file ? "提交差异" : "提交详情"}…
          </p>
        )}
        {error && (
          <div className="git-history-message" role="status">
            <span>读取失败：{error}</span>
            {canRetry && (
              <button
                type="button"
                onClick={() => setRevision((value) => value + 1)}
              >
                重试读取
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
