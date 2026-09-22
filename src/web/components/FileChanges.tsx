import type { FileChange } from "../../shared/protocol";
import { FileReference } from "../FileNavigationContext";

export function DiffBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="file-diff">
      {lines.map((line, index) => {
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "added"
            : line.startsWith("-") && !line.startsWith("---")
              ? "removed"
              : line.startsWith("@@")
                ? "hunk"
                : "context";
        return (
          <span className={`diff-line diff-line-${kind}`} key={index}>
            {line}
          </span>
        );
      })}
    </pre>
  );
}

export function FileChanges({ changes }: { changes: FileChange[] }) {
  return (
    <div className="file-changes">
      {changes.map(({ path, kind, diff }) => (
        <article className="file-change" key={path}>
          <header>
            <FileReference reference={path} literalPath>
              <code title={path}>{path}</code>
            </FileReference>
            <span className={`file-change-kind file-change-kind-${kind.type}`}>
              {kind.type}
            </span>
          </header>
          {kind.type === "update" && kind.move_path !== null && (
            <p>
              Moved to{" "}
              <FileReference reference={kind.move_path} literalPath>
                <code>{kind.move_path}</code>
              </FileReference>
            </p>
          )}
          <DiffBlock text={diff} />
        </article>
      ))}
    </div>
  );
}
