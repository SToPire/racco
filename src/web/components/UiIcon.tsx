type IconName =
  | "close"
  | "refresh"
  | "chevron-right"
  | "chevron-down"
  | "back"
  | "panel-close"
  | "copy"
  | "enter"
  | "up"
  | "search"
  | "message"
  | "terminal"
  | "agents"
  | "folder"
  | "plus";

const paths: Record<IconName, string> = {
  folder: "M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.5Z",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M18 6 6 18",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 19 8l1 4M4 12l1 4a8 8 0 0 0 12.9 1.9",
  "chevron-right": "m9 6 6 6-6 6",
  "chevron-down": "m6 9 6 6 6-6",
  back: "m14 6-6 6 6 6",
  "panel-close": "M4 4h16v16H4zM15 4v16m-6-12 4 4-4 4",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  enter: "M19 5v9H5m5-5-5 5 5 5",
  up: "M12 20V4m-6 6 6-6 6 6",
  message: "M4 4h16v12H9l-5 4V4Z",
  terminal: "m5 6 5 6-5 6m8 0h6",
  agents:
    "M9 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm12 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM2 20v-3a4 4 0 0 1 8 0v3m4 0v-3a4 4 0 0 1 8 0v3",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1.8 4.2L20 20",
};

export function UiIcon({ name }: { name: IconName }) {
  return (
    <svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24">
      <path d={paths[name]} />
    </svg>
  );
}
