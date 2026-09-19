import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  NativeSession,
  ProjectEntry,
  Provider,
  SessionSummary,
} from "../../shared/protocol";
import { listNativeSessions } from "../api";
import { ProviderLogo } from "./ProviderLogo";
import { UiIcon } from "./UiIcon";

type Props = {
  project: ProjectEntry;
  enabled: boolean;
  controls: ReactNode;
  sessions: SessionSummary[];
  onImport: (
    provider: Provider,
    nativeId: string,
    projectId: string,
  ) => Promise<SessionSummary>;
  onDeleteNative: (
    provider: Provider,
    nativeId: string,
    projectId: string,
  ) => Promise<void>;
  onOpen: (session: SessionSummary) => void;
};

export function ProjectSessions(props: Props) {
  const [provider, setProvider] = useState<Provider>("codex");
  return (
    <>
      <header className="file-dock-tabs-row">
        <span className="dock-panel-title">
          <UiIcon name="message" />
          会话
        </span>
        {props.controls}
      </header>
      <div className="project-sessions">
        <div className="native-session-toolbar">
          <div className="provider-switch" role="group" aria-label="会话来源">
            {(["codex", "claude"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={provider === value}
                className={provider === value ? "active" : ""}
                onClick={() => setProvider(value)}
              >
                <ProviderLogo provider={value} decorative />
                {value === "codex" ? "Codex" : "Claude"}
              </button>
            ))}
          </div>
        </div>
        <NativeSessionList key={provider} {...props} provider={provider} />
      </div>
    </>
  );
}

function NativeSessionList({
  project,
  enabled,
  provider,
  sessions,
  onImport,
  onDeleteNative,
  onOpen,
}: Props & { provider: Provider }) {
  const [items, setItems] = useState<NativeSession[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const pendingImport = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const alive = useRef(false);
  const visible = useRef(enabled);
  visible.current = enabled;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);

  async function load(cursor?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(undefined);
    if (cursor === undefined) {
      setItems([]);
      setNextCursor(null);
    }
    try {
      const page = await listNativeSessions(
        project.projectId,
        provider,
        cursor,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (cursor !== undefined && cursor === page.nextCursor)
        throw new Error("会话列表分页异常，请刷新重试");
      setItems((current) => [
        ...new Map(
          [...(cursor === undefined ? [] : current), ...page.sessions].map(
            (item) => [item.providerSessionId, item],
          ),
        ).values(),
      ]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (enabled && project.available) void load();
    return () => request.current?.abort();
    // This component is keyed by project and provider; opening refreshes metadata.
  }, [enabled, project.available]);

  async function open(item: NativeSession) {
    if (pendingImport.current) return;
    const managed = sessions.find(
      (session) => session.sessionId === item.managedSessionId,
    );
    if (managed) {
      onOpen(managed);
      return;
    }
    pendingImport.current = true;
    setImporting(item.providerSessionId);
    setError(undefined);
    try {
      const session = await onImport(
        provider,
        item.providerSessionId,
        project.projectId,
      );
      if (!alive.current) return;
      setItems((current) =>
        current.map((row) =>
          row.providerSessionId === item.providerSessionId
            ? { ...row, managedSessionId: session.sessionId }
            : row,
        ),
      );
      if (visible.current) onOpen(session);
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pendingImport.current = false;
      if (alive.current) setImporting(undefined);
    }
  }

  async function remove(item: NativeSession) {
    if (importing !== undefined || deleting !== undefined) return;
    const managed = sessions.some(
      (session) => session.sessionId === item.managedSessionId,
    );
    const title = item.title?.trim() || "未命名会话";
    const message = managed
      ? `彻底删除「${title}」？将删除 Provider 磁盘上的会话记录，并从 Racco 移除该对话，无法恢复。`
      : `彻底删除「${title}」？将删除 Provider 磁盘上的会话记录，无法恢复。`;
    if (!window.confirm(message)) return;
    setDeleting(item.providerSessionId);
    setError(undefined);
    try {
      await onDeleteNative(provider, item.providerSessionId, project.projectId);
      if (!alive.current) return;
      // Deletion invalidates offset-based provider cursors. Reload from the
      // beginning and abort any older page request through load().
      await load();
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) setDeleting(undefined);
    }
  }

  const query = filter.trim().toLocaleLowerCase();
  const shown = items.filter((item) =>
    `${item.title ?? ""} ${item.providerSessionId}`
      .toLocaleLowerCase()
      .includes(query),
  );
  return (
    <>
      <div className="native-session-search">
        <label>
          <UiIcon name="search" />
          <input
            type="search"
            aria-label="筛选已加载会话"
            placeholder="筛选已加载会话…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新会话列表"
          title="刷新会话列表"
          disabled={loading || !project.available}
          onClick={() => void load()}
        >
          <UiIcon name="refresh" />
        </button>
      </div>
      <div className="native-session-scroll" aria-busy={loading}>
        {!project.available ? (
          <p className="native-session-empty">项目目录不可用。</p>
        ) : (
          <>
            {error && (
              <div className="native-session-error" role="alert">
                <p>{error}</p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void load()}
                >
                  重试
                </button>
              </div>
            )}
            {shown.length > 0 && (
              <ul className="native-session-list" aria-label="项目已有会话">
                {shown.map((item) => {
                  const managed = sessions.some(
                    (session) => session.sessionId === item.managedSessionId,
                  );
                  const title = item.title?.trim() || "未命名会话";
                  return (
                    <li key={item.providerSessionId}>
                      <div className="native-session-copy">
                        <strong title={title}>{title}</strong>
                        <span>
                          <time dateTime={item.updatedAt}>
                            {new Date(item.updatedAt).toLocaleString("zh-CN", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                          {managed && <small>已导入</small>}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="row-delete-button"
                        aria-label={`彻底删除 ${title}`}
                        disabled={
                          importing !== undefined || deleting !== undefined
                        }
                        onClick={() => void remove(item)}
                        title="彻底删除会话文件"
                      >
                        {deleting === item.providerSessionId ? (
                          <span className="button-spinner" />
                        ) : (
                          <svg aria-hidden="true" viewBox="0 0 24 24">
                            <path d="M4.5 6.5h15M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className="native-session-action"
                        aria-label={`${managed ? "打开" : "导入并打开"} ${title}`}
                        disabled={
                          importing !== undefined || deleting !== undefined
                        }
                        onClick={() => void open(item)}
                      >
                        {importing === item.providerSessionId ? (
                          <span className="button-spinner" />
                        ) : managed ? (
                          "打开"
                        ) : (
                          "导入并打开"
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {loading && (
              <p className="native-session-empty" role="status">
                <span className="button-spinner" />
                正在读取会话…
              </p>
            )}
            {!loading && !error && shown.length === 0 && (
              <p className="native-session-empty">
                {query
                  ? "已加载会话中没有匹配项。"
                  : nextCursor
                    ? "本页没有可导入的主会话，可继续加载。"
                    : "当前项目没有可导入的会话。"}
              </p>
            )}
            {nextCursor !== null && (
              <button
                type="button"
                className="native-session-more"
                disabled={loading}
                onClick={() => void load(nextCursor)}
              >
                加载更多会话
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
