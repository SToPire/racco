import { memo, useContext } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import { FileNavigationContext, FileReference } from "../FileNavigationContext";
import { resolveFileReference } from "../file-navigation";

type MarkdownContentProps = {
  text: string;
};

export const MarkdownContent = memo(function MarkdownContent({
  text,
}: MarkdownContentProps) {
  const navigation = useContext(FileNavigationContext);
  return (
    <Markdown
      components={{
        a: ({ href, children, title }) => (
          <FileReference reference={href ?? ""} externalLink title={title}>
            {children}
          </FileReference>
        ),
      }}
      urlTransform={(url, key) =>
        key === "href" &&
        navigation &&
        resolveFileReference(
          url,
          navigation.projectRoot,
          navigation.baseDirectory,
        ).kind !== "external"
          ? url
          : defaultUrlTransform(url)
      }
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
});
