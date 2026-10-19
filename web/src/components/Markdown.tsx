import { memo, type MouseEvent } from "react";
import { store } from "../store";
import { renderMarkdown } from "../markdown";

/**
 * Rendered once per distinct source text: React's memo skips the render when `text` is
 * unchanged (finished blocks), and `renderMarkdown`'s LRU means a forced re-render of an
 * unchanged block still never re-parses it.
 *
 * The copy button on a fenced block is delegated: the HTML comes from `dangerouslySetInnerHTML`,
 * so no React handler can be attached to it directly.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		const button = (event.target as HTMLElement).closest(".code-copy");
		if (!button) return;
		const code = button.closest(".code-block")?.querySelector("pre")?.textContent ?? "";
		void store.copy(code).then(() => {
			button.textContent = "copied";
			setTimeout(() => {
				button.textContent = "copy";
			}, 1400);
		});
	};
	return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});
