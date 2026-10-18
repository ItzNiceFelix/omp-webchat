import { memo } from "react";
import { renderMarkdown } from "../markdown";

/**
 * Rendered once per distinct source text: React's memo skips the render when `text` is
 * unchanged (finished blocks), and `renderMarkdown`'s LRU means a forced re-render of an
 * unchanged block still never re-parses it.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});
