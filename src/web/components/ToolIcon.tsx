import { UiIcon, type IconName } from "./UiIcon";

const icons = new Map<string, IconName>([
  ["command", "terminal"],
  ["Bash", "terminal"],
  ["Read", "file"],
  ["read_file", "file"],
  ["Edit", "edit"],
  ["Write", "edit"],
  ["MultiEdit", "edit"],
  ["fileChange", "edit"],
  ["Grep", "search"],
  ["Glob", "search"],
  ["WebSearch", "search"],
  ["webSearch", "search"],
  ["WebFetch", "globe"],
  ["Agent", "agents"],
  ["Task", "agents"],
  ["backgroundTask", "clock"],
  ["TaskStop", "stop"],
  ["TodoWrite", "checklist"],
  ["EnterPlanMode", "checklist"],
  ["ExitPlanMode", "checklist"],
  ["AskUserQuestion", "message"],
  ["SendMessage", "message"],
  ["Context injection", "message"],
]);

export function ToolIcon({ tool }: { tool: string }) {
  return <UiIcon name={icons.get(tool) ?? "wrench"} />;
}
