export type IconName =
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
  | "branch"
  | "plus"
  | "wrench"
  | "file"
  | "edit"
  | "globe"
  | "clock"
  | "checklist"
  | "stop";

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
  branch:
    "M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm0 0v6m0 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0 0h6a5 5 0 0 0 5-5V8m0 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  wrench:
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94L14.7 6.3Z",
  file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9L14 3Zm0 0v6h6M8 13h8M8 17h6",
  edit: "M16 3a2.12 2.12 0 0 1 3 3L7 18l-4 1 1-4L16 3ZM14 5l3 3",
  globe:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c-4 4.5-4 13.5 0 18M12 3c4 4.5 4 13.5 0 18",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2",
  checklist: "m3 6 2 2 3-4m-5 9 2 2 3-4M11 6h10M11 13h10M11 20h10M5 20h.01",
  stop: "M5 5h14v14H5z",
};

export function UiIcon({ name }: { name: IconName }) {
  return (
    <svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24">
      <path d={paths[name]} />
    </svg>
  );
}
