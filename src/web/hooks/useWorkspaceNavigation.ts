import { useCallback, useEffect, useState } from "react";
import type { SessionRef } from "../../shared/protocol";

function parseLocation(): SessionRef | undefined {
  const match = /^\/session\/(.+)$/.exec(window.location.pathname);
  if (!match) return undefined;
  try {
    return { sessionId: decodeURIComponent(match[1]) };
  } catch {
    return undefined;
  }
}

function readHistoryOpen(): boolean {
  return (
    window.location.pathname === "/" &&
    window.history.state?.historyOpen === true
  );
}

export function useWorkspaceNavigation() {
  const [activeRef, setActiveRef] = useState<SessionRef | undefined>(
    parseLocation,
  );
  const [historyOpen, setHistoryOpen] = useState(readHistoryOpen);
  const [newSessionProjectId, setNewSessionProjectId] = useState("");
  useEffect(() => {
    const onPopState = () => {
      setActiveRef(parseLocation());
      setHistoryOpen(readHistoryOpen());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const openSession = useCallback((ref: SessionRef) => {
    window.history.pushState(
      { historyOpen: false },
      "",
      `/session/${encodeURIComponent(ref.sessionId)}`,
    );
    setActiveRef(ref);
    setHistoryOpen(false);
  }, []);
  const showHistory = useCallback(() => {
    window.history.pushState({ historyOpen: true }, "", "/");
    setActiveRef(undefined);
    setHistoryOpen(true);
  }, []);
  const startNewSession = useCallback((projectId: string) => {
    window.history.pushState({ historyOpen: false }, "", "/");
    setActiveRef(undefined);
    setNewSessionProjectId(projectId);
    setHistoryOpen(false);
  }, []);
  return {
    activeRef,
    historyOpen,
    newSessionProjectId,
    setNewSessionProjectId,
    openSession,
    showHistory,
    startNewSession,
  };
}
