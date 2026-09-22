import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

type ReadingPosition = { top: number; following: boolean };

/** Reading state belongs to a conversation/agent, independently of new output. */
export function useConversationScroll(
  containerRef: RefObject<HTMLElement | null>,
  readingKey: string,
  active: boolean,
) {
  const positions = useRef(new Map<string, ReadingPosition>());
  const current = useRef<ReadingPosition>({ top: 0, following: true });
  const [following, setFollowing] = useState(true);

  const followLatest = useCallback(() => {
    current.current.following = true;
    setFollowing(true);
    const element = containerRef.current;
    if (element)
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
  }, [containerRef]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!active || !element) return;
    current.current = {
      ...(positions.current.get(readingKey) ?? { top: 0, following: true }),
    };
    setFollowing(current.current.following);
    element.scrollTo({
      top: current.current.following
        ? element.scrollHeight
        : current.current.top,
      behavior: "instant",
    });
    let frame = 0;
    const resize = new ResizeObserver(() => scheduleLayout());
    const observeChildren = () => {
      resize.observe(element);
      for (const child of element.children) resize.observe(child);
    };
    function scheduleLayout() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (current.current.following)
          element!.scrollTo({
            top: element!.scrollHeight,
            behavior: "instant",
          });
        observeChildren();
      });
    }
    const onScroll = () => {
      const atBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
      current.current = { top: element.scrollTop, following: atBottom };
      setFollowing(atBottom);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    const mutation = new MutationObserver(scheduleLayout);
    mutation.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observeChildren();
    return () => {
      positions.current.set(readingKey, {
        top: element.scrollTop,
        following: current.current.following,
      });
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, [active, containerRef, readingKey]);

  return { following, followLatest };
}
