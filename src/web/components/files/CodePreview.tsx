import { useEffect, useRef, useState } from "react";

export function CodePreview({
  path,
  lines,
  line,
  locationRequestId,
}: {
  path: string;
  lines: string[];
  line?: number;
  locationRequestId?: number;
}) {
  const pageSize = 400;
  const [page, setPage] = useState(0);
  const pages = Math.ceil(lines.length / pageSize);
  const currentPage = Math.min(page, pages - 1);
  const start = currentPage * pageSize;
  const visibleLines = lines.slice(start, start + pageSize);
  const content = visibleLines.join("\n");
  useEffect(() => {
    setPage(
      line !== undefined && line <= lines.length
        ? Math.floor((line - 1) / pageSize)
        : 0,
    );
  }, [lines, line, locationRequestId]);
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
    if (pages === 1 && content.length <= 100_000) {
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
  }, [path, content, pages]);
  const html =
    highlighted?.path === path && highlighted.content === content
      ? highlighted.html
      : undefined;
  useEffect(() => {
    const container = scroll.current;
    const target = targetLine.current;
    if (container === null) return;
    if (target === null) {
      container.scrollTop = 0;
      return;
    }
    container.scrollTop +=
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      container.clientHeight / 3;
    container.focus({ preventScroll: true });
  }, [path, content, line, locationRequestId]);
  return (
    <div className="file-code-preview">
      {pages > 1 && (
        <nav className="file-pagination" aria-label="文件分页">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </button>
          <label>
            页{" "}
            <input
              aria-label="文件页码"
              type="number"
              min={1}
              max={pages}
              value={currentPage + 1}
              onChange={(event) => {
                const next = event.target.valueAsNumber;
                if (Number.isInteger(next))
                  setPage(Math.max(0, Math.min(pages - 1, next - 1)));
              }}
            />{" "}
            / {pages}
          </label>
          <button
            type="button"
            disabled={currentPage === pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </button>
          <span role="status">
            第 {start + 1}–{start + visibleLines.length} 行，共 {lines.length}{" "}
            行
          </span>
        </nav>
      )}
      <div
        className="file-code-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label={`文件内容 ${path}`}
      >
        <div className="file-code-grid">
          <div className="file-line-numbers" aria-hidden="true">
            {visibleLines
              .map((_, offset) => start + offset)
              .map((index) => (
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
              <code
                className="hljs"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
          </pre>
        </div>
      </div>
    </div>
  );
}
