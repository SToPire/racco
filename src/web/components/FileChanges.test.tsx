import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileNavigationContext } from "../FileNavigationContext";
import { FileChanges } from "./FileChanges";

test("file changes expose literal project paths without turning filename characters into URL locations", () => {
  const html = renderToStaticMarkup(
    <FileNavigationContext.Provider
      value={{
        projectRoot: "/work/app",
        baseDirectory: "/work/app",
        available: true,
        onOpenFile: () => undefined,
      }}
    >
      <FileChanges
        changes={[
          {
            path: "/work/app/src/a%20b#L2:5.ts",
            kind: { type: "update", move_path: "src/new.ts" },
            diff: "@@ -1 +1 @@\n-old\n+new",
          },
          {
            path: "/work/other/secret",
            kind: { type: "delete" },
            diff: "-secret",
          },
        ]}
      />
    </FileNavigationContext.Provider>,
  );
  assert.match(html, /title="在文件侧栏打开 src\/a%20b#L2:5.ts"/);
  assert.match(html, /title="在文件侧栏打开 src\/new.ts"/);
  assert.match(html, /aria-disabled="true" title="文件不在当前项目内"/);
  assert.match(html, /diff-line-added/);
});
