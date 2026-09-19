import { useEffect, useState } from "react";
import type {
  ProjectEntry,
  ProjectFilePreview,
} from "../../../shared/protocol";
import { readProjectFile } from "../../api";
import { UiIcon } from "../UiIcon";
import { FileIcon } from "./FileIcon";
import { CodePreview } from "./CodePreview";
import { fileTabId } from "./FileTabs";

export function FilePreview({
  project,
  enabled,
  activePath,
}: {
  project: ProjectEntry;
  enabled: boolean;
  activePath?: string;
}) {
  const [preview, setPreview] = useState<ProjectFilePreview>();
  const [fileError, setFileError] = useState<{
    path: string;
    message: string;
  }>();
  const [fileLoading, setFileLoading] = useState(false);
  const [fileRevision, setFileRevision] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    if (!enabled || activePath === undefined) return;
    const controller = new AbortController();
    setFileLoading(true);
    setFileError(undefined);
    setCopyStatus("");
    void readProjectFile(project.projectId, activePath, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) {
          setPreview(next);
          setFileLoading(false);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setFileError({
            path: activePath,
            message: error instanceof Error ? error.message : String(error),
          });
          setFileLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [project.projectId, enabled, activePath, fileRevision]);
  const currentPreview = preview?.path === activePath ? preview : undefined;
  const currentFileError =
    fileError !== undefined && fileError.path === activePath
      ? fileError.message
      : undefined;
  async function copyFile() {
    if (currentPreview?.kind !== "text") return;
    try {
      await navigator.clipboard.writeText(currentPreview.content);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败，请手动选择文本");
    }
  }

  return (
    <section
      className="file-preview"
      id="file-preview"
      role="tabpanel"
      aria-labelledby={
        activePath === undefined ? undefined : fileTabId(activePath)
      }
      hidden={activePath === undefined}
    >
      {activePath !== undefined && (
        <>
          <div className="file-preview-toolbar">
            <span title={`${project.path}/${activePath}`}>{activePath}</span>
            <small>只读</small>
            <button
              type="button"
              className="icon-button"
              aria-label="重新读取文件"
              title="重新读取文件"
              onClick={() => setFileRevision((value) => value + 1)}
              disabled={fileLoading}
            >
              <UiIcon name="refresh" />
            </button>
            {currentPreview?.kind === "text" && (
              <button
                className="icon-button"
                aria-label="复制文件内容"
                title="复制文件内容"
                type="button"
                onClick={() => void copyFile()}
                disabled={fileLoading}
              >
                <UiIcon name="copy" />
              </button>
            )}
          </div>
          {fileLoading || (!currentPreview && !currentFileError) ? (
            <div className="file-preview-empty" role="status">
              <span className="button-spinner" />
              正在读取文件…
            </div>
          ) : currentFileError ? (
            <div className="file-preview-empty file-error" role="alert">
              <p>{currentFileError}</p>
              <button
                onClick={() => setFileRevision((value) => value + 1)}
                type="button"
              >
                重试
              </button>
            </div>
          ) : currentPreview?.kind === "text" ? (
            <CodePreview path={activePath} content={currentPreview.content} />
          ) : currentPreview?.kind === "image" ? (
            <div className="file-image-preview">
              <img src={currentPreview.dataUrl} alt={activePath} />
            </div>
          ) : (
            <div className="file-preview-empty">
              <FileIcon />
              <p>
                {currentPreview?.kind === "unavailable"
                  ? currentPreview.reason
                  : "无法预览文件"}
              </p>
            </div>
          )}
          <footer className="file-preview-status">
            <span role="status">
              {copyStatus ||
                (currentPreview?.kind === "text"
                  ? `${currentPreview.content.split("\n").length} 行 · UTF-8`
                  : "")}
            </span>
            {currentPreview && (
              <span>
                {currentPreview.size < 1024
                  ? `${currentPreview.size} B`
                  : `${(currentPreview.size / 1024).toFixed(1)} KiB`}
              </span>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
