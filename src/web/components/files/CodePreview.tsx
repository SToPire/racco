import { useEffect, useState } from "react";

export function CodePreview({
  path,
  content,
}: {
  path: string;
  content: string;
}) {
  const [highlighted, setHighlighted] = useState<{
    path: string;
    content: string;
    html: string;
    language: string;
  }>();
  useEffect(() => {
    let current = true;
    if (content.length <= 100_000) {
      void import("../../file-highlight")
        .then(({ highlightFile }) => {
          const result = highlightFile(path, content);
          if (current && result) setHighlighted({ path, content, ...result });
        })
        .catch(() => {
          // File contents remain readable when the optional highlighting chunk cannot load.
        });
    }
    return () => {
      current = false;
    };
  }, [path, content]);
  const html =
    highlighted?.path === path && highlighted.content === content
      ? highlighted.html
      : undefined;
  const lines = content.split("\n").length;
  return (
    <div
      className="file-code-scroll"
      tabIndex={0}
      aria-label={`文件内容 ${path}`}
    >
      <div className="file-code-grid">
        <div className="file-line-numbers" aria-hidden="true">
          {Array.from({ length: lines }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <pre>
          {html === undefined ? (
            <code>{content || " "}</code>
          ) : (
            <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </pre>
      </div>
    </div>
  );
}
