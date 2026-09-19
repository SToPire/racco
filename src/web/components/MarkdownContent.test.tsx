import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "./MarkdownContent.js";

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
