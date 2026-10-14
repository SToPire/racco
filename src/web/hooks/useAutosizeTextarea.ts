import { useLayoutEffect, type RefObject } from "react";

function resize(element: HTMLTextAreaElement) {
  if (element.getBoundingClientRect().width === 0) return;
  const top = element.scrollTop;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
  element.scrollTop = top;
}

/** Grow to the content while CSS bounds the space reserved for the composer. */
export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  useLayoutEffect(() => {
    if (ref.current) resize(ref.current);
  }, [ref, value]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let width = 0;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      resize(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
}
