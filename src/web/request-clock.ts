import type { SessionSummary } from "../shared/protocol";

export type RequestClock = {
  id: string;
  sampleElapsedMs: number;
  elapsedMs: number;
  receivedAt: number;
  stale: boolean;
};

export function requestElapsedMs(clock: RequestClock, now: number): number {
  return clock.elapsedMs + Math.max(0, now - clock.receivedAt);
}

/** Anchor at receipt, never at view mount; a fresh request owns a fresh clock. */
export function receiveRequestClock(
  previous: RequestClock | null,
  sample: SessionSummary["activeRequest"],
  receivedAt: number,
): RequestClock | null {
  if (sample === null) return null;
  return {
    id: sample.id,
    sampleElapsedMs: sample.elapsedMs,
    elapsedMs:
      previous?.id === sample.id && !previous.stale
        ? Math.max(sample.elapsedMs, requestElapsedMs(previous, receivedAt))
        : sample.elapsedMs,
    receivedAt,
    stale: false,
  };
}

export function formatRequestElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return minutes < 60
    ? `${String(minutes).padStart(2, "0")}:${remainder}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`;
}
