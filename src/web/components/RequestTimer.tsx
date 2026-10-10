import { memo, useEffect, useReducer } from "react";
import type { SocketStatus } from "../socket";
import {
  formatRequestElapsed,
  requestElapsedMs,
  type RequestClock,
} from "../request-clock";

export const RequestTimer = memo(function RequestTimer({
  clock,
  active,
  connection,
  waiting,
  showMainAgent,
}: {
  clock: RequestClock;
  active: boolean;
  connection: SocketStatus;
  waiting: boolean;
  showMainAgent: boolean;
}) {
  const [, tick] = useReducer((value: number) => value + 1, 0);
  const live = connection === "open" && !clock.stale;

  useEffect(() => {
    if (!active || !live) return;
    let interval: number | undefined;
    const updateVisibility = () => {
      window.clearInterval(interval);
      if (!document.hidden) {
        tick();
        interval = window.setInterval(tick, 1000);
      }
    };
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [active, live]);

  const status = !live
    ? connection === "open"
      ? "正在同步"
      : "连接中断"
    : waiting
      ? "等待你回答"
      : undefined;
  const elapsed = live
    ? requestElapsedMs(clock, performance.now())
    : clock.sampleElapsedMs;

  return (
    <div className="request-timer">
      {showMainAgent && <span>Main Agent ·</span>}
      {status && <span>{status} ·</span>}
      <span role="timer" aria-live="off" aria-label="当前请求耗时">
        {live ? "请求已用时" : "最后确认用时"}{" "}
        <span className="request-timer-value">
          {formatRequestElapsed(elapsed)}
        </span>
      </span>
    </div>
  );
});
