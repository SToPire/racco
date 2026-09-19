import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import cpp from "highlight.js/lib/languages/cpp";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({
  javascript,
  typescript,
  json,
  bash,
  python,
  css,
  xml,
  markdown,
  cpp,
  rust,
  go,
  yaml,
})) {
  hljs.registerLanguage(name, language);
}
const extensions: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  css: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  mdx: "markdown",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  rs: "rust",
  go: "go",
  yml: "yaml",
  yaml: "yaml",
};

export function highlightFile(
  path: string,
  content: string,
): { html: string; language: string } | undefined {
  const language = extensions[path.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!language || content.length > 100_000) return undefined;
  return {
    html: hljs.highlight(content, { language, ignoreIllegals: true }).value,
    language,
  };
}
