export function SessionLoadState({
  status,
  error,
  onRetry,
  onBack,
}: {
  status: "loading" | "error" | "not-found";
  error?: string;
  onRetry(): void;
  onBack(): void;
}) {
  return (
    <div className="conversation-loading">
      <button type="button" onClick={onBack}>
        返回项目
      </button>
      {status === "loading" ? (
        <div role="status">
          <span className="button-spinner" />
          <p>正在读取对话…</p>
        </div>
      ) : (
        <>
          <div role="alert">
            <h2>
              {status === "not-found" ? "会话不存在或已删除" : "无法读取对话"}
            </h2>
            {error && <p>{error}</p>}
          </div>
          <button type="button" onClick={onRetry}>
            重试读取
          </button>
        </>
      )}
    </div>
  );
}
