import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/** Overlay layouts use the browser's modal focus/inert behavior; docked layouts remain complementary. */
export function ResponsivePanel({
  children,
  className,
  label,
  query,
  onClose,
  open = true,
  panelRef,
}: {
  children: ReactNode;
  className: string;
  label: string;
  query: string;
  onClose: () => void;
  open?: boolean;
  panelRef?: RefObject<HTMLElement | null>;
}) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  const dialog = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const modal = narrow && open;
  useLayoutEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const internalFocus = element.contains(focused) ? focused : null;
    const closing = wasOpen.current && !open;
    if (open && !wasOpen.current) opener.current = focused;
    wasOpen.current = open;

    if (element.matches(":modal") !== modal) element.close();
    if (!element.open) {
      if (modal) element.showModal();
      // Nonmodal panels and the collapsed Dock rail must not move focus merely
      // by becoming visible. Keep the same element and children in both modes.
      else element.open = true;
    }
    if (closing) opener.current?.focus({ preventScroll: true });
    else if (internalFocus?.isConnected)
      internalFocus.focus({ preventScroll: true });
  }, [modal, open]);
  useLayoutEffect(() => {
    const element = dialog.current;
    return () => {
      const restore = element?.contains(document.activeElement);
      element?.close();
      if (restore && opener.current?.isConnected)
        opener.current.focus({ preventScroll: true });
    };
  }, []);
  const ref = (element: HTMLDialogElement | null) => {
    dialog.current = element;
    if (panelRef) panelRef.current = element;
  };
  return (
    <dialog
      ref={ref}
      className={`${className} responsive-panel${modal ? " responsive-panel-modal" : ""}`}
      role={modal ? "dialog" : "complementary"}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open && !modal) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </dialog>
  );
}
