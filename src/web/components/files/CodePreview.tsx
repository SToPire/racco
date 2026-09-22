import { useEffect, useRef, useState } from "react";

export function CodePreview({
  path,
  content,
  line,
  locationRequestId,
}: {
  path: string;
  content: string;
  line?: number;
  locationRequestId?: number;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const targetLine = useRef<HTMLSpanElement>(null);
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
  useEffect(() => {
    const container = scroll.current;
    const target = targetLine.current;
    if (container === null || target === null) return;
    container.scrollTop +=
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      container.clientHeight / 3;
    container.focus({ preventScroll: true });
  }, [path, content, line, locationRequestId]);
  return (
    <div
      className="file-code-scroll"
      ref={scroll}
      tabIndex={0}
      aria-label={`文件内容 ${path}`}
    >
      <div className="file-code-grid">
        <div className="file-line-numbers" aria-hidden="true">
          {Array.from({ length: lines }, (_, index) => (
            <span
              key={index}
              data-line={index + 1}
              className={
                index + 1 === line ? "file-line-number-selected" : undefined
              }
              ref={index + 1 === line ? targetLine : undefined}
            >
              {index + 1}
            </span>
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
