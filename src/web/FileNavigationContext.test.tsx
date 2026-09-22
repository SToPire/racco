import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FileNavigationContext,
  FileReferenceScope,
} from "./FileNavigationContext";
import { MarkdownContent } from "./components/MarkdownContent";
import { FileChanges } from "./components/FileChanges";

function renderActor(baseDirectory: string | undefined) {
  return renderToStaticMarkup(
    <FileNavigationContext.Provider
      value={{
        projectRoot: "/work/app",
        baseDirectory: "/work/app",
        available: true,
        onOpenFile: () => undefined,
      }}
    >
      <FileReferenceScope baseDirectory={baseDirectory}>
        <MarkdownContent text="[Actor file](README.md#L2)" />
        <FileChanges
          changes={[
            { path: "source.ts", kind: { type: "add" }, diff: "+value" },
          ]}
        />
      </FileReferenceScope>
    </FileNavigationContext.Provider>,
  );
}

test("actor scopes change both Markdown and tool paths without changing the project root", () => {
  const html = renderActor("/work/app/packages");
  assert.match(html, /title="在文件侧栏打开 packages\/README.md，第 2 行"/);
  assert.match(html, /title="在文件侧栏打开 packages\/source.ts"/);
});

test("unknown and outside actor directories leave local references unavailable", () => {
  for (const baseDirectory of [undefined, "/work/other"]) {
    const html = renderActor(baseDirectory);
    assert.equal(html.match(/aria-disabled="true"/g)?.length, 2);
    assert.doesNotMatch(html, /<button/);
  }
});
