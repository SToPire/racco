import { useState } from "react";

export function ProviderRecovery({
  available,
  connected,
  onRestart,
}: {
  available: boolean;
  connected: boolean;
  onRestart: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  async function restart() {
    setBusy(true);
    setMessage(undefined);
    try {
      await onRestart();
      setMessage("Codex 已就绪，空闲会话已交还原生 CLI。任务不会自动重发。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="provider-recovery">
      <summary>Codex 连接与会话释放</summary>
      <p>
        仅重启 Codex 连接并释放它加载的所有空闲会话，Claude 不受影响。有任务或子
        Agent 运行时无法释放；不会自动重发任务。
      </p>
      <button
        type="button"
        disabled={busy || !connected}
        onClick={() => void restart()}
      >
        {busy ? "正在恢复…" : available ? "释放空闲 Codex 会话" : "恢复 Codex"}
      </button>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
