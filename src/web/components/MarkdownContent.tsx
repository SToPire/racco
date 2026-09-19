import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";

type MarkdownContentProps = {
  text: string;
};

export function MarkdownContent({ text }: MarkdownContentProps) {
  return (
    <Markdown
      rehypePlugins={[[rehypeKatex, { strict: "ignore", throwOnError: false }]]}
      remarkPlugins={[
        remarkGfm,
        [remarkMath, { backslashDelimiters: true, singleDollarTextMath: true }],
      ]}
      skipHtml
    >
      {text}
    </Markdown>
  );
}
