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
  const activeRef = useRef(active);
  activeRef.current = active;
  const [following, setFollowing] = useState(true);
  const navigationHold = useRef(false);

  const pauseFollowing = useCallback(() => {
    navigationHold.current = true;
    current.current.following = false;
    setFollowing(false);
  }, []);

  const followLatest = useCallback(() => {
    navigationHold.current = false;
    current.current.following = true;
    setFollowing(true);
    const element = containerRef.current;
    if (element)
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    if (element) current.current.top = element.scrollTop;
  }, [containerRef]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!active || !element) return;
    current.current = {
      ...(positions.current.get(readingKey) ?? { top: 0, following: true }),
    };
    setFollowing(current.current.following);
    navigationHold.current = !current.current.following;
    element.scrollTo({
      top: current.current.following
        ? element.scrollHeight
        : current.current.top,
      behavior: "instant",
    });
    current.current.top = element.scrollTop;
    let frame = 0;
    let restoring = true;
    let restoreFrame = requestAnimationFrame(() => {
      restoreFrame = requestAnimationFrame(() => {
        if (!activeRef.current) return;
        element.scrollTo({
          top: current.current.following
            ? element.scrollHeight
            : current.current.top,
          behavior: "instant",
        });
        current.current.top = element.scrollTop;
        restoring = false;
      });
    });
    const resize = new ResizeObserver(() => scheduleLayout());
    const observeChildren = () => {
      resize.observe(element);
      for (const child of element.children) resize.observe(child);
    };
    function scheduleLayout() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!activeRef.current) return;
        if (current.current.following)
          element!.scrollTo({
            top: element!.scrollHeight,
            behavior: "instant",
          });
        if (current.current.following) current.current.top = element!.scrollTop;
        observeChildren();
      });
    }
    const onScroll = () => {
      if (!activeRef.current || restoring) return;
      const atBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
      const resume = atBottom && !navigationHold.current;
      current.current = { top: element.scrollTop, following: resume };
      setFollowing(resume);
    };
    const userScroll = () => {
      navigationHold.current = false;
    };
    const scrollbarPointer = (event: PointerEvent) => {
      if (event.target === element) userScroll();
    };
    const scrollKey = (event: KeyboardEvent) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        userScroll();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", userScroll, { passive: true });
    element.addEventListener("touchmove", userScroll, { passive: true });
    element.addEventListener("keydown", scrollKey);
    element.addEventListener("pointerdown", scrollbarPointer);
    const mutation = new MutationObserver(scheduleLayout);
    mutation.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observeChildren();
    return () => {
      positions.current.set(readingKey, {
        // A removed scroll container already reports zero during cleanup.
        top: current.current.top,
        following: current.current.following,
      });
      if (frame) cancelAnimationFrame(frame);
      cancelAnimationFrame(restoreFrame);
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", userScroll);
      element.removeEventListener("touchmove", userScroll);
      element.removeEventListener("keydown", scrollKey);
      element.removeEventListener("pointerdown", scrollbarPointer);
    };
  }, [active, containerRef, readingKey]);

  return { following, followLatest, pauseFollowing };
}
