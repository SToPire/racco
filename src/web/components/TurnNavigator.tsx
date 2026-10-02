import { useEffect, useRef, useState, type RefObject } from "react";
import type { TimelineRow } from "../store";
import {
  userRequestAnchorId,
  userRequestPreview,
} from "../timeline-navigation";

type UserRequestRow = Extract<TimelineRow, { type: "user.message" }>;

type TurnNavigatorProps = {
  sessionId: string;
  requests: UserRequestRow[];
  scrollContainerRef: RefObject<HTMLElement | null>;
};

export function TurnNavigator({
  sessionId,
  requests,
  scrollContainerRef,
}: TurnNavigatorProps) {
  const rootRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>(requests[0]?.id);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container === null || requests.length === 0) return;
    let frame: number | undefined;

    const updateActiveRequest = () => {
      frame = undefined;
      const activationLine =
        container.getBoundingClientRect().top +
        Math.min(container.clientHeight * 0.28, 180);
      let nextId = requests[0]?.id;
      for (const request of requests) {
        const target = document.getElementById(
          userRequestAnchorId(sessionId, request.id),
        );
        if (
          target === null ||
          target.getBoundingClientRect().top > activationLine
        ) {
          break;
        }
        nextId = request.id;
      }
      setActiveId(nextId);
    };

    const scheduleUpdate = () => {
      if (frame === undefined)
        frame = requestAnimationFrame(updateActiveRequest);
    };

    scheduleUpdate();
    container.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      container.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [sessionId, requests, scrollContainerRef]);

  useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(
        ".turn-navigator-menu button[aria-current=true]",
      )
      ?.focus();
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        rootRef.current
          ?.querySelector<HTMLButtonElement>(".turn-navigator-trigger")
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const activeIndex = Math.max(
    0,
    requests.findIndex((request) => request.id === activeId),
  );

  function jumpTo(request: UserRequestRow) {
    document
      .getElementById(userRequestAnchorId(sessionId, request.id))
      ?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
    setActiveId(request.id);
    setOpen(false);
    rootRef.current
      ?.querySelector<HTMLButtonElement>(".turn-navigator-trigger")
      ?.focus();
  }

  return (
    <nav
      className={`turn-navigator${open ? " open" : ""}`}
      aria-label="用户请求导航"
      ref={rootRef}
    >
      <button
        aria-expanded={open}
        className="turn-navigator-trigger"
        onClick={() => setOpen((current) => !current)}
        title="跳转到用户请求"
        type="button"
      >
        <span aria-hidden="true">↕</span>
        <span>
          {activeIndex + 1} / {requests.length}
        </span>
      </button>

      {open && (
        <div className="turn-navigator-menu">
          {requests.map((request, index) => (
            <button
              aria-current={request.id === activeId ? "true" : undefined}
              className={request.id === activeId ? "active" : ""}
              key={request.id}
              onClick={() => jumpTo(request)}
              title={request.text}
              type="button"
            >
              <span>{index + 1}</span>
              <strong>
                {userRequestPreview(
                  request.text ||
                    (request.imageCount > 0
                      ? `[图片*${request.imageCount}]`
                      : ""),
                )}
              </strong>
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}
