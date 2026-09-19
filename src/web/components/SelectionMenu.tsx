import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type Option = {
  value: string;
  label: string;
  disabled?: boolean;
};

type Selection = {
  label: string;
  value: string | null;
  options: Option[];
  onChange: (value: string) => void;
  icon?: ReactNode;
};

export function SelectionMenu({
  label,
  value,
  options,
  disabled,
  onChange,
  secondary,
  icon,
  placeholder,
  placement = "above-end",
  footerAction,
}: Selection & {
  disabled: boolean;
  secondary?: Selection;
  placeholder?: string;
  placement?: "above-end" | "below-start";
  footerAction?: { label: string; icon: ReactNode; onClick: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const [view, setView] = useState<"primary" | "secondary">("primary");
  const [availableHeight, setAvailableHeight] = useState<number>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const footer = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value);
  const inSecondary = view === "secondary" && secondary !== undefined;
  const active = inSecondary
    ? secondary
    : { label, value, options, onChange, icon };
  const activeIndex = Math.min(focused, active.options.length - 1);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      setAvailableHeight(
        Math.max(
          0,
          (placement === "below-start"
            ? window.innerHeight - bounds.bottom
            : bounds.top) - 18,
        ),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, placement]);
  useEffect(() => {
    if (open && !disabled) {
      if (activeIndex >= 0) items.current[activeIndex]?.focus();
      else footer.current?.focus();
    }
  }, [open, activeIndex, disabled, inSecondary]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  function choose(option: Option) {
    if (option.disabled) return;
    active.onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  }
  function showPrimary() {
    setView("primary");
    setFocused(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
  }
  return (
    <div
      className={`selection-menu selection-menu-${placement}`}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <button
        className="selection-trigger"
        type="button"
        ref={trigger}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open && !disabled}
        disabled={disabled}
        title={selected?.label ?? value ?? placeholder ?? `选择${label}`}
        onClick={() => {
          showPrimary();
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            showPrimary();
            setOpen(true);
          }
        }}
      >
        {icon}
        <span className="selection-trigger-label">
          {selected?.label ?? value ?? placeholder ?? `选择${label}`}
        </span>
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && !disabled && (
        <div
          className="selection-popover"
          style={
            availableHeight === undefined
              ? undefined
              : ({
                  "--selection-space": `${availableHeight}px`,
                } as CSSProperties)
          }
          role="dialog"
          aria-label={`${label}设置`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (inSecondary) showPrimary();
              else {
                setOpen(false);
                trigger.current?.focus();
              }
            }
          }}
        >
          {inSecondary && (
            <button
              type="button"
              className="selection-back"
              aria-label={`返回${label}列表`}
              onClick={showPrimary}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="m10 4-4 4 4 4" />
              </svg>
              {active.label}
            </button>
          )}
          {active.options.length > 0 && (
            <div
              className="selection-options"
              role="listbox"
              aria-label={active.label}
              onKeyDown={(event) => {
                if (
                  ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  setFocused(
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? active.options.length - 1
                        : (activeIndex +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            active.options.length) %
                          active.options.length,
                  );
                }
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  const option = active.options[activeIndex];
                  if (option) choose(option);
                }
              }}
            >
              {active.options.map((option, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={active.value === option.value}
                  aria-disabled={option.disabled || undefined}
                  tabIndex={index === activeIndex ? 0 : -1}
                  key={option.value}
                  ref={(element) => {
                    items.current[index] = element;
                  }}
                  onFocus={() => setFocused(index)}
                  onClick={() => choose(option)}
                >
                  {active.icon && (
                    <span className="selection-option-icon" aria-hidden="true">
                      {active.icon}
                    </span>
                  )}
                  <span className="selection-option-label">
                    {option.label}
                    {active.value === option.value && (
                      <span aria-hidden="true">✓</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          {!inSecondary && secondary && (
            <button
              type="button"
              className="selection-submenu-trigger"
              aria-label={secondary.label}
              aria-haspopup="listbox"
              onClick={() => {
                setView("secondary");
                setFocused(
                  Math.max(
                    0,
                    secondary.options.findIndex(
                      (option) => option.value === secondary.value,
                    ),
                  ),
                );
              }}
            >
              <span>{secondary.label}</span>
              <span className="selection-submenu-value">
                {secondary.value ?? "未选择"}
              </span>
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="m6 4 4 4-4 4" />
              </svg>
            </button>
          )}
          {!inSecondary && footerAction && (
            <button
              ref={footer}
              type="button"
              className="selection-footer-action"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                footerAction.onClick();
              }}
            >
              {footerAction.icon}
              <span>{footerAction.label}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
