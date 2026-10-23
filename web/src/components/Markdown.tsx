import { memo, useLayoutEffect, useRef, type MouseEvent } from "react";
import { store } from "../store";
import { renderMarkdown } from "../markdown";

/**
 * Wrap everything past the first `from` characters of visible text in `.fw` spans. The markdown
 * HTML is replaced wholesale on every delta, so words that were already shown are plain text
 * again; only the characters this delta added get a span, and the span is what fades in. That
 * gives per-word streaming without keeping React nodes for rendered markdown.
 */
function fadeFrom(root: HTMLElement, from: number) {
	const nodes: Text[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
	let at = 0;
	for (const node of nodes) {
		const length = node.data.length;
		const parent = node.parentNode;
		if (at + length > from && parent && !(parent as HTMLElement).closest?.(".code-copy")) {
			const piece = at >= from ? node : node.splitText(from - at);
			const span = document.createElement("span");
			span.className = "fw";
			parent.insertBefore(span, piece);
			span.appendChild(piece);
		}
		at += length;
	}
}

/**
 * Rendered once per distinct source text: React's memo skips the render when `text` is
 * unchanged (finished blocks), and `renderMarkdown`'s LRU means a forced re-render of an
 * unchanged block still never re-parses it.
 *
 * `live` marks the block the model is writing right now: new characters fade in. The first
 * render of a live block only records its length, so a block that mounts mid-stream (reconnect,
 * scroll) does not flash as one piece.
 *
 * The copy button on a fenced block is delegated: the HTML comes from `dangerouslySetInnerHTML`,
 * so no React handler can be attached to it directly.
 */
export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	const seen = useRef<number | null>(null);
	const html = renderMarkdown(text);

	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const total = root.textContent?.length ?? 0;
		if (live && seen.current !== null && total > seen.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			fadeFrom(root, seen.current);
		}
		seen.current = live ? total : null;
	}, [html, live]);

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
	return <div className="markdown" ref={ref} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
