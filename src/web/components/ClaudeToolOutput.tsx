import type { ClaudeToolResultView } from "../claude-tool-result";
import { FileChanges } from "./FileChanges";

export function ClaudeToolOutput({
  view,
  output,
  revealOriginal,
}: {
  view: ClaudeToolResultView;
  output: string;
  revealOriginal: boolean;
}) {
  return (
    <div className="inspector-structured-output">
      {view.missingStructuredResult && (
        <p className="inspector-empty">
          此记录未包含结构化工具结果，按原始输出显示。
        </p>
      )}
      {view.kind === "bash" && view.stderr && (
        <section>
          <h3>标准错误 · stderr</h3>
          <pre data-tool-stderr>{view.stderr}</pre>
        </section>
      )}
      {view.fields.length > 0 && (
        <dl className="inspector-properties">
          {view.fields.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view.kind === "bash" && (
        <>
          {view.stdout && (
            <section>
              <h3>标准输出 · stdout</h3>
              <pre data-tool-stdout>{view.stdout}</pre>
            </section>
          )}
          {!view.stderr && !view.stdout && view.attachments.length === 0 && (
            <p className="inspector-empty">没有 stdout 或 stderr 输出</p>
          )}
        </>
      )}
      {view.change !== undefined &&
        (view.emptyPatch ? (
          <p className="inspector-empty">
            {view.change.path}：结果未包含差异片段。
          </p>
        ) : (
          <FileChanges changes={[view.change]} />
        ))}
      {view.attachments.length > 0 && (
        <section>
          <h3>输出附件</h3>
          <ul className="inspector-output-attachments">
            {view.attachments.map((attachment, index) => (
              <li key={index}>
                {attachment.label}
                {attachment.mediaType && <code>{attachment.mediaType}</code>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {output.length > 0 &&
        (view.kind === "generic" ? (
          <pre data-tool-output>{output}</pre>
        ) : (
          <details
            className="inspector-original-output"
            open={revealOriginal || undefined}
          >
            <summary>模型收到的输出</summary>
            <pre data-tool-output>{output}</pre>
          </details>
        ))}
    </div>
  );
}
