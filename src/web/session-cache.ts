import type { InteractionRequest, SessionSummary } from "../shared/protocol";
import type { TimelineRow } from "./store";
import { receiveRequestClock, type RequestClock } from "./request-clock";

export type SessionContent = {
  session: SessionSummary;
  rows: TimelineRow[];
  interactions: InteractionRequest[];
  loaded: boolean;
  requestClock: RequestClock | null;
};
export type SessionCache = Map<string, SessionContent>;
export const SESSION_CACHE_LIMIT = 8;

/** Recently visited views stay mounted; old views are evicted to bound memory. */
export function visitSession(
  current: SessionCache,
  session: SessionSummary,
): SessionCache {
  if (
    current.has(session.sessionId) &&
    [...current.keys()].at(-1) === session.sessionId
  )
    return current;
  const next = new Map(current);
  const content = next.get(session.sessionId) ?? {
    session,
    rows: [],
    interactions: [],
    loaded: false,
    requestClock: null,
  };
  next.delete(session.sessionId);
  next.set(session.sessionId, content);
  while (next.size > SESSION_CACHE_LIMIT)
    next.delete(next.keys().next().value!);
  return next;
}

export function receiveSessionSummary(
  content: SessionContent,
  session: SessionSummary,
  receivedAt: number,
): SessionContent {
  return {
    ...content,
    session,
    requestClock: receiveRequestClock(
      content.requestClock,
      session.activeRequest,
      receivedAt,
    ),
  };
}

export function staleSessionClocks(current: SessionCache): SessionCache {
  return new Map(
    [...current].map(([id, content]) => [
      id,
      content.requestClock === null || content.requestClock.stale
        ? content
        : {
            ...content,
            requestClock: { ...content.requestClock, stale: true },
          },
    ]),
  );
}

export function updateSessionContent(
  current: SessionCache,
  sessionId: string,
  update: (content: SessionContent) => SessionContent,
): SessionCache {
  const content = current.get(sessionId);
  if (content === undefined) return current;
  const next = new Map(current);
  next.set(sessionId, update(content));
  return next;
}

export function forgetSessionContent(
  current: SessionCache,
  remove: (content: SessionContent) => boolean,
): SessionCache {
  const next = new Map([...current].filter(([, content]) => !remove(content)));
  return next.size === current.size ? current : next;
}
