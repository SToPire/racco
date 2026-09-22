import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "./MarkdownContent.js";
import { FileNavigationContext } from "../FileNavigationContext";

test("renders GFM and common LaTeX delimiters without executing raw HTML", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      text={
        "**bold**\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n" +
        "$E = mc^2$\n\nInline \\(C_L\\).\n\n\\[\ne^{i\\pi}+1=0\n\\]\n\n" +
        "`\\(literal\\)`\n\n<script>alert('no')</script>"
      }
    />,
  );

  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<table>/);
  assert.equal(html.match(/class="katex"/g)?.length, 3);
  assert.match(html, /class="katex-display"/);
  assert.equal(html.includes("<code>\\(literal\\)</code>"), true);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\(&#x27;no&#x27;\)/);
});

test("project links become file actions while external URLs stay links and unsafe URLs stay blocked", () => {
  const html = renderToStaticMarkup(
    <FileNavigationContext.Provider
      value={{
        projectRoot: "/work/app",
        baseDirectory: "/work/app",
        available: true,
        onOpenFile: () => undefined,
      }}
    >
      <MarkdownContent
        text={
          "[relative](main.ts:42) [absolute](/work/app/src/main.ts#L3) [outside](/work/other/key) [web](https://example.com/docs) [unsafe](javascript:alert(1))"
        }
      />
    </FileNavigationContext.Provider>,
  );
  assert.match(
    html,
    /<button[^>]*title="在文件侧栏打开 main.ts，第 42 行"[^>]*>relative<\/button>/,
  );
  assert.match(
    html,
    /<button[^>]*title="在文件侧栏打开 src\/main.ts，第 3 行"[^>]*>absolute<\/button>/,
  );
  assert.match(
    html,
    /aria-disabled="true" title="文件不在当前项目内">outside<\/span>/,
  );
  assert.match(html, /<a href="https:\/\/example.com\/docs">web<\/a>/);
  assert.doesNotMatch(html, /href="javascript:/);
});
