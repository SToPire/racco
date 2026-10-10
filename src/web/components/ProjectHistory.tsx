import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  GIT_HISTORY_MAX_BYTES,
  GIT_HISTORY_MAX_COMMITS,
  type GitCommitDiff,
  type GitCommitSummary,
  type GitHistoryPage,
  type GitHistoryScope,
} from "../../shared/git-history";
import { GitPatchCache, jsonBytes, listGitHistory } from "../git-history-api";
import { GitApiError } from "../git-request";
import { layoutCommitGraph } from "../commit-graph";
import { CommitGraph } from "./CommitGraph";
import { GitCommitDetails } from "./GitCommitDetails";
import { UiIcon } from "./UiIcon";

const ROW_HEIGHT = 32;
const REFS_HEIGHT = 28;

function rowIndexAt(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}
type Listing = Omit<GitHistoryPage, "commits"> & {
  commits: GitCommitSummary[];
  bytes: number;
  capped: boolean;
};
type Failure = {
  message: string;
  expired: boolean;
  replace: boolean;
  limited: boolean;
};

function CommitIdButton({ oid, tabIndex }: { oid: string; tabIndex: number }) {
  const [feedback, setFeedback] = useState<"Copied" | "Failed">();
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(undefined), 2000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copy() {
    setFeedback(undefined);
    try {
      await navigator.clipboard.writeText(oid);
      setFeedback("Copied");
    } catch {
      setFeedback("Failed");
    }
  }

  return (
    <button
      type="button"
      className="git-history-row-id"
      tabIndex={tabIndex}
      aria-label={`Copy full commit ID ${oid.slice(0, 8)}`}
      title={
        feedback === "Failed"
          ? "Copy failed. Click to try again."
          : `Copy full commit ID\n${oid}`
      }
      onClick={() => void copy()}
    >
      <code role="status">{feedback ?? oid.slice(0, 8)}</code>
    </button>
  );
}

export function ProjectHistory({
  path,
  enabled,
  expanded,
  onToggle,
}: {
  path: string;
  enabled: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [scope, setScope] = useState<GitHistoryScope>("current");
  const [listing, setListing] = useState<Listing>();
  const [failure, setFailure] = useState<Failure>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<GitCommitSummary>();
  const [inDetail, setInDetail] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(300);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const listRef = useRef(listing);
  const initialFill = useRef(0);
  const position = useRef(0);
  const patchCache = useRef(new GitPatchCache<GitCommitDiff>());
  const identity = useRef({ path, scope });
  identity.current = { path, scope };
  listRef.current = listing;
  const available = enabled && expanded;
  const graph = useMemo(
    () => layoutCommitGraph(listing?.commits ?? []),
    [listing?.commits],
  );
  const rowOffsets = useMemo(() => {
    const offsets = [0];
    for (const commit of listing?.commits ?? []) {
      offsets.push(
        offsets[offsets.length - 1] +
          ROW_HEIGHT +
          (commit.refs.length > 0 ? REFS_HEIGHT : 0),
      );
    }
    return offsets;
  }, [listing?.commits]);
  const totalHeight = rowOffsets[rowOffsets.length - 1];
  const contentHeight = useRef(totalHeight);
  contentHeight.current = totalHeight;

  function cancelList() {
    request.current?.abort();
    request.current = undefined;
    setBusy(false);
  }
  function invalid(fail: GitApiError, replace = true) {
    if (fail.status === 403 || fail.status === 404) {
      cancelList();
      setListing(undefined);
      listRef.current = undefined;
      setSelected(undefined);
      setInDetail(false);
      patchCache.current.clear();
    }
    if (
      fail.status === 403 ||
      fail.status === 404 ||
      fail.status === 410 ||
      fail.code === "HISTORY_EXPIRED"
    ) {
      setFailure({
        message: fail.message,
        expired: fail.status === 410 || fail.code === "HISTORY_EXPIRED",
        replace,
        limited: false,
      });
      initialFill.current = 0;
    }
  }

  async function load(replace: boolean) {
    if (!available || request.current || (!replace && inDetail)) return;
    const current = listRef.current;
    if (!replace && (!current?.nextCursor || current.capped)) return;
    const controller = new AbortController();
    request.current = controller;
    const requestPath = path;
    const requestScope = scope;
    const cursor = replace ? undefined : current!.nextCursor!;
    setBusy(true);
    setFailure(undefined);
    try {
      const page = await listGitHistory(path, scope, controller.signal, cursor);
      if (
        controller.signal.aborted ||
        request.current !== controller ||
        identity.current.path !== requestPath ||
        identity.current.scope !== requestScope
      )
        return;
      if (!replace && page.snapshotId !== current!.snapshotId)
        throw new Error("历史快照已变化，请刷新提交历史。");
      const commits = replace ? [] : [...current!.commits];
      let bytes = replace
        ? jsonBytes({ ...page, commits: [] })
        : current!.bytes;
      let capped = false;
      const known = new Set(commits.map((commit) => commit.oid));
      for (const commit of page.commits) {
        if (known.has(commit.oid))
          throw new Error("历史分页包含重复提交，请刷新提交历史。");
        const size = jsonBytes(commit);
        if (
          commits.length >= GIT_HISTORY_MAX_COMMITS ||
          bytes + size > GIT_HISTORY_MAX_BYTES
        ) {
          capped = true;
          break;
        }
        commits.push(commit);
        known.add(commit.oid);
        bytes += size;
      }
      capped ||=
        commits.length >= GIT_HISTORY_MAX_COMMITS && page.nextCursor !== null;
      const next = { ...page, commits, bytes, capped };
      listRef.current = next;
      setListing(next);
      if (replace) {
        setSelected(undefined);
        setInDetail(false);
        setFocusedIndex(0);
        setScrollTop(0);
        position.current = 0;
        if (scroller.current) scroller.current.scrollTop = 0;
        patchCache.current.clear();
        initialFill.current = 3;
      }
    } catch (fail) {
      if (controller.signal.aborted || request.current !== controller) return;
      setFailure({
        message: fail instanceof Error ? fail.message : "提交历史读取失败。",
        expired:
          fail instanceof GitApiError &&
          (fail.status === 410 || fail.code === "HISTORY_EXPIRED"),
        replace,
        limited:
          fail instanceof GitApiError &&
          (fail.status === 413 || fail.code === "HISTORY_LIMIT"),
      });
      initialFill.current = 0;
      if (fail instanceof GitApiError) invalid(fail, replace);
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }
  const loadLatest = useRef(load);
  loadLatest.current = load;

  // A first expansion reads once. Reopening a populated view only restores it.
  useEffect(() => {
    if (!available || inDetail) {
      request.current?.abort();
      request.current = undefined;
      setBusy(false);
      initialFill.current = 0;
    } else if (!listRef.current && !failure) {
      void loadLatest.current(true);
    }
    return () => {
      request.current?.abort();
      request.current = undefined;
    };
  }, [available, inDetail, scope, revision]);

  useLayoutEffect(() => {
    if (available && !inDetail && scroller.current) {
      scroller.current.scrollTop = position.current;
    }
  }, [available, inDetail]);

  useEffect(() => {
    const element = scroller.current;
    if (!element || !available || inDetail) return;
    // The first measurement belongs to restoring this visible view. Only a
    // later, real enlargement can grant another bounded fill attempt.
    let measuredHeight: number | undefined;
    const update = () => {
      const nextHeight = element.clientHeight;
      if (
        measuredHeight !== undefined &&
        nextHeight > measuredHeight + 1 &&
        listRef.current &&
        contentHeight.current <= nextHeight
      ) {
        initialFill.current = 3;
      }
      measuredHeight = nextHeight;
      setViewportHeight(nextHeight);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [available, inDetail]);

  // Fresh data and a visible viewport enlargement may fill a short viewport,
  // with a finite budget. Restoring a view never grants a prefetch budget.
  useEffect(() => {
    if (
      !available ||
      inDetail ||
      busy ||
      failure ||
      !listing ||
      initialFill.current <= 0
    )
      return;
    const element = scroller.current;
    if (!element || element.clientHeight <= 0) return;
    if (
      totalHeight > element.clientHeight ||
      !listing.nextCursor ||
      listing.capped
    ) {
      initialFill.current = 0;
      return;
    }
    initialFill.current -= 1;
    void loadLatest.current(false);
  }, [
    listing,
    busy,
    available,
    inDetail,
    failure,
    viewportHeight,
    totalHeight,
  ]);

  useEffect(
    () => () => {
      request.current?.abort();
      patchCache.current.clear();
    },
    [],
  );

  function back() {
    setInDetail(false);
    initialFill.current = 0;
    requestAnimationFrame(() => {
      scroller.current
        ?.querySelector<HTMLButtonElement>(
          `[data-commit-oid="${selected?.oid}"]`,
        )
        ?.focus({ preventScroll: true });
    });
  }
  const indices = new Set<number>();
  const count = listing?.commits.length ?? 0;
  const start = Math.max(0, rowIndexAt(rowOffsets, scrollTop) - 5);
  const end = Math.min(
    count,
    rowIndexAt(rowOffsets, scrollTop + viewportHeight) + 6,
  );
  for (let index = start; index < end; index++) indices.add(index);
  if (focusedIndex < count) indices.add(focusedIndex);
  const selectedIndex =
    listing?.commits.findIndex((commit) => commit.oid === selected?.oid) ?? -1;
  if (selectedIndex >= 0) indices.add(selectedIndex);

  return (
    <section
      className="git-history-region"
      aria-label="提交历史"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !expanded) return;
        event.preventDefault();
        event.stopPropagation();
        if (inDetail) back();
        else {
          onToggle();
          toggle.current?.focus();
        }
      }}
    >
      <header className="git-history-header">
        <button
          type="button"
          ref={toggle}
          className="git-history-toggle"
          aria-label={expanded ? "折叠提交历史" : "展开提交历史"}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? "▾" : "▸"} 提交历史
        </button>
        {expanded && (
          <>
            <select
              aria-label="提交历史范围"
              value={scope}
              onChange={(event) => {
                cancelList();
                setScope(event.target.value as GitHistoryScope);
                setListing(undefined);
                listRef.current = undefined;
                setFailure(undefined);
                setSelected(undefined);
                setInDetail(false);
                setFocusedIndex(0);
                position.current = 0;
                setScrollTop(0);
                if (scroller.current) scroller.current.scrollTop = 0;
                initialFill.current = 0;
                patchCache.current.clear();
              }}
            >
              <option value="current">当前分支</option>
              <option value="all">全部分支</option>
            </select>
            <button
              type="button"
              className="icon-button"
              aria-label="刷新提交历史"
              title="刷新提交历史"
              disabled={busy}
              onClick={() => {
                cancelList();
                void load(true);
              }}
            >
              <UiIcon name="refresh" />
            </button>
          </>
        )}
      </header>
      <div className="git-history-content" hidden={!expanded}>
        {failure && (
          <div className="git-history-message" role="status">
            <span>
              {failure.limited
                ? `${failure.replace ? (listing ? "刷新提交历史达到容量限制，保留上次结果。" : "提交历史达到容量限制，未能读取列表。") : "已达到提交历史容量限制，保留已加载内容。"}${failure.message}`
                : `${listing ? "结果可能已过期。" : ""}${failure.expired ? "历史快照已失效，请刷新提交历史。" : `读取失败：${failure.message}`}`}
            </span>
            {!failure.expired && !failure.limited && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!listing) {
                    setFailure(undefined);
                    setRevision((value) => value + 1);
                  } else void load(failure.replace);
                }}
              >
                重试
              </button>
            )}
          </div>
        )}
        {!inDetail && (listing?.shallow || graph.limit !== null) && (
          <div className="git-history-message" role="status">
            {listing?.shallow && <span>浅克隆：缺失的父提交无法比较。</span>}
            {graph.limit !== null && (
              <span>提交图过密，暂不绘制连线；仍可浏览提交与差异。</span>
            )}
          </div>
        )}
        <div
          ref={scroller}
          className="git-history-list"
          aria-label="提交历史列表"
          tabIndex={0}
          hidden={inDetail}
          onScroll={(event) => {
            if (!available || inDetail) return;
            const element = event.currentTarget;
            const top = element.scrollTop;
            const down = top > position.current;
            position.current = top;
            setScrollTop(top);
            if (
              down &&
              available &&
              !inDetail &&
              !failure &&
              !busy &&
              element.scrollHeight - top - element.clientHeight < 160
            ) {
              initialFill.current = 0;
              void load(false);
            }
          }}
          onKeyDown={(event) => {
            if (
              !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
              count === 0
            )
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? count - 1
                  : Math.max(
                      0,
                      Math.min(
                        count - 1,
                        focusedIndex + (event.key === "ArrowDown" ? 1 : -1),
                      ),
                    );
            setFocusedIndex(next);
            const element = scroller.current;
            if (element) {
              if (rowOffsets[next] < element.scrollTop)
                element.scrollTop = rowOffsets[next];
              else if (
                rowOffsets[next + 1] >
                element.scrollTop + element.clientHeight
              )
                element.scrollTop = rowOffsets[next + 1] - element.clientHeight;
            }
            requestAnimationFrame(() =>
              scroller.current
                ?.querySelector<HTMLButtonElement>(
                  `[data-commit-index="${next}"]`,
                )
                ?.focus({ preventScroll: true }),
            );
          }}
        >
          <div
            className="git-history-rows"
            role="list"
            aria-label="历史提交"
            style={{
              height: totalHeight,
              minWidth: Math.max(280, graph.laneCount * 14 + 250),
            }}
          >
            {[...indices]
              .sort((a, b) => a - b)
              .map((index) => {
                const commit = listing!.commits[index];
                const title =
                  commit.subject ||
                  (commit.textUnavailableReason
                    ? "提交说明不可显示"
                    : "（无提交标题）");
                const details = [
                  title,
                  `Commit: ${commit.oid}`,
                  `Author: ${commit.author.name}${commit.author.email ? ` <${commit.author.email}>` : ""}`,
                  `Author Date: ${new Date(commit.authoredAt).toLocaleString()}`,
                  `Commit Date: ${new Date(commit.committedAt).toLocaleString()}`,
                  commit.textUnavailableReason,
                ]
                  .filter(Boolean)
                  .join("\n");
                return (
                  <div
                    key={commit.oid}
                    role="listitem"
                    aria-posinset={index + 1}
                    aria-setsize={count}
                    className={`git-history-row${selected?.oid === commit.oid ? " selected" : ""}`}
                    style={{
                      top: rowOffsets[index],
                      height: rowOffsets[index + 1] - rowOffsets[index],
                      gridTemplateRows:
                        commit.refs.length > 0
                          ? `${ROW_HEIGHT}px ${REFS_HEIGHT}px`
                          : `${ROW_HEIGHT}px`,
                    }}
                    title={details}
                    onFocus={() => setFocusedIndex(index)}
                  >
                    <CommitGraph
                      graph={graph}
                      rowIndex={index}
                      height={rowOffsets[index + 1] - rowOffsets[index]}
                      nodeY={ROW_HEIGHT / 2}
                    />
                    <button
                      type="button"
                      className="git-history-row-open"
                      data-commit-index={index}
                      data-commit-oid={commit.oid}
                      aria-label={`提交 ${commit.oid.slice(0, 8)} ${title}`}
                      aria-pressed={selected?.oid === commit.oid}
                      tabIndex={index === focusedIndex ? 0 : -1}
                      onClick={() => {
                        cancelList();
                        initialFill.current = 0;
                        setSelected(commit);
                        setInDetail(true);
                      }}
                    >
                      <span className="git-history-row-title">{title}</span>
                    </button>
                    <CommitIdButton
                      oid={commit.oid}
                      tabIndex={index === focusedIndex ? 0 : -1}
                    />
                    {commit.refs.length > 0 && (
                      <div
                        className="git-history-row-refs"
                        aria-label="Refs"
                        tabIndex={index === focusedIndex ? 0 : -1}
                      >
                        {commit.refs.map((ref) => (
                          <span
                            key={`${ref.kind}:${ref.name}`}
                            className={`git-history-ref ${ref.kind}`}
                            title={ref.name}
                          >
                            {ref.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
          <div className="git-history-tail" role="status">
            {busy
              ? "正在加载提交…"
              : failure?.limited
                ? "已停止加载：提交历史容量限制。"
                : listing?.capped
                  ? "已达到浏览上限（5000 条或 8 MiB）。"
                  : listing && !listing.nextCursor
                    ? count === 0
                      ? "暂无提交历史。"
                      : "已到历史末尾"
                    : listing && !failure
                      ? "向下滚动加载更多"
                      : ""}
          </div>
        </div>
        {inDetail && selected && listing && (
          <GitCommitDetails
            key={`${listing.snapshotId}:${selected.oid}`}
            path={path}
            snapshotId={listing.snapshotId}
            commit={selected}
            enabled={available && !failure?.expired}
            cache={patchCache.current}
            onBack={back}
            onInvalid={invalid}
          />
        )}
      </div>
    </section>
  );
}
