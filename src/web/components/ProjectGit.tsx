import { useRef, useState, type ReactNode } from "react";
import type { WorktreeEntry } from "../../shared/protocol";
import { ProjectChanges } from "./ProjectChanges";
import { ProjectHistory } from "./ProjectHistory";

export function ProjectGit({
  worktree,
  enabled,
  controls,
  onOpenFile,
}: {
  worktree: WorktreeEntry;
  enabled: boolean;
  controls: ReactNode;
  onOpenFile: (path: string, file: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(34);
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; height: number; total: number } | undefined>(
    undefined,
  );
  const resize = (value: number) =>
    setHeight(Math.max(20, Math.min(70, value)));
  return (
    <div className="project-git" ref={container}>
      <div className="project-git-current">
        <ProjectChanges
          worktree={worktree}
          enabled={enabled}
          controls={controls}
          onOpenFile={onOpenFile}
        />
      </div>
      {expanded && (
        <div
          className="git-history-resizer"
          role="separator"
          aria-label="调整提交历史高度"
          aria-orientation="horizontal"
          aria-valuemin={20}
          aria-valuemax={70}
          aria-valuenow={Math.round(height)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = {
              y: event.clientY,
              height,
              total: container.current?.clientHeight ?? 1,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (drag.current)
              resize(
                drag.current.height +
                  ((drag.current.y - event.clientY) / drag.current.total) * 100,
              );
          }}
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onLostPointerCapture={() => {
            drag.current = undefined;
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              resize(height + (event.key === "ArrowUp" ? 5 : -5));
            }
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              resize(event.key === "Home" ? 20 : 70);
            }
          }}
        />
      )}
      <div
        className={`project-git-history${expanded ? " expanded" : ""}`}
        style={expanded ? { flexBasis: `${height}%` } : undefined}
      >
        <ProjectHistory
          path={worktree.path}
          enabled={enabled}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      </div>
    </div>
  );
}
