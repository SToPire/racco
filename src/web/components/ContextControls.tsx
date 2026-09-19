import { useState } from "react";
import type { ContextUsage } from "../../shared/protocol";

const tokens = new Intl.NumberFormat("en-US");

export function ContextControls({
  usage,
  compacting,
  disabled,
  onCompact,
}: {
  usage: ContextUsage | null;
  compacting: boolean;
  disabled: boolean;
  onCompact: () => Promise<boolean>;
}) {
  const [requesting, setRequesting] = useState(false);
  const busy = compacting || requesting;
  const used = usage === null ? "未知" : tokens.format(usage.usedTokens);
  const limit =
    usage?.maxTokens == null ? "未知" : tokens.format(usage.maxTokens);
  const percent =
    usage?.maxTokens == null
      ? null
      : Math.round((usage.usedTokens / usage.maxTokens) * 100);
  return (
    <div className="context-controls">
      <div
        className="context-usage"
        aria-label="主会话上下文"
        title="主会话最近报告的上下文用量与上限；不是累计消耗。数据随会话更新，未知表示尚未取得。"
      >
        {usage !== null && usage.maxTokens !== null && (
          <meter
            aria-label="主会话上下文用量"
            min={0}
            max={usage.maxTokens}
            value={Math.min(usage.usedTokens, usage.maxTokens)}
            aria-valuetext={`${used} / ${limit} tokens，${percent}%`}
            className={percent! >= 90 ? "context-meter-high" : undefined}
          />
        )}
        <span>
          上下文{" "}
          <span className="context-token-count">
            {used} / {limit}
          </span>{" "}
          tokens
        </span>
      </div>
      <button
        type="button"
        className="compact-button"
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={async () => {
          setRequesting(true);
          try {
            await onCompact();
          } finally {
            setRequesting(false);
          }
        }}
        title="压缩主会话上下文，保留关键信息以继续对话"
      >
        {busy && <span className="button-spinner" aria-hidden="true" />}
        {busy ? "正在压缩…" : "压缩上下文"}
      </button>
    </div>
  );
}
