import { useLayoutEffect, useRef } from "react";
import type { TimelineRow } from "../store";

/** Preserve each agent's reading position; first opens and bottom readers follow new output. */
export function useConversationScroll(
  active: boolean,
  loaded: boolean,
  scope: string,
  rows: TimelineRow[],
) {
  const ref = useRef<HTMLElement>(null);
  const positions = useRef(new Map<string, { top: number; bottom: boolean }>());
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !loaded || element === null) return;
    const position = positions.current.get(scope);
    element.scrollTop =
      position?.bottom === false ? position.top : element.scrollHeight;
    positions.current.set(scope, {
      top: element.scrollTop,
      bottom: position?.bottom ?? true,
    });
    const observer = new ResizeObserver(() => {
      if (positions.current.get(scope)?.bottom)
        element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    if (element.firstElementChild !== null)
      observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [active, loaded, scope, rows]);

  function onScroll() {
    const element = ref.current;
    if (!active || !loaded || element === null) return;
    positions.current.set(scope, {
      top: element.scrollTop,
      bottom:
        element.scrollHeight - element.clientHeight - element.scrollTop < 48,
    });
  }
  return { ref, onScroll };
}
