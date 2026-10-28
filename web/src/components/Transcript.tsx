import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { store } from "../store";
import { useStore } from "../useStore";
import type { Message } from "../types";
import { MessageRow } from "./MessageRow";

const BOTTOM_SLACK = 120;

/**
 * What kind of row this is, for the spine node colour and the birth animation.
 * Kept presentational: it reads only fields MessageRow already branches on.
 */
function rowKind(message: Message): string {
	if (message.local === "error") return "error";
	// Runtime notices are not part of the turn timeline; the spine skips them entirely.
	if (message.local === "notice" || message.role === "custom") return "system";
	if (message.role === "user") return "user";
	const blocks = Array.isArray(message.content) ? message.content : [];
	const hasTool = blocks.some((block) => block?.type === "toolCall");
	if (hasTool) return "tool";
	const hasThinking = blocks.some((block) => block?.type === "thinking");
	if (hasThinking) return "think";
	return "text";
}

/** Stable row identity: survives "load earlier" so the anchor element can be found again. */
function rowKey(message: Message): string {
	return message.localId ?? `${message.role}|${message.timestamp ?? 0}|${message.toolCallId ?? ""}`;
}

/**
 * Transcript with scroll anchoring.
 *
 * - While the reader is at the bottom, new rows and stream deltas keep it pinned (instant: a
 *   smooth scroll per frame fights the stream and jitters on a phone).
 * - An animated scroll only happens when the reader asked for it — the "N new" pill, or their
 *   own message being sent.
 * - "load earlier" prepends rows and restores the reading position by measuring one row that
 *   stays on screen, because scroll-height deltas are not exact when fonts/images settle.
 */
export function Transcript() {
	const messages = useStore((select) => select.messages);
	const streaming = useStore((select) => select.streaming);
	const start = useStore((select) => select.visibleStart());
	const pendingNew = useStore((select) => select.pendingNew);
	const note = useStore((select) => select.transcriptNote);
	const bottomNonce = useStore((select) => select.bottomNonce);
	const smoothNonce = useStore((select) => select.smoothNonce);

	const box = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const anchor = useRef<{ key: string; offset: number } | null>(null);
	const lastSmooth = useRef(smoothNonce);
	const frame = useRef(0);

	useEffect(() => {
		const node = box.current;
		if (!node) return;
		// The scroll handler only updates the store once per frame: reading layout on every
		// scroll event is what makes a long transcript stutter on a phone.
		const onScroll = () => {
			if (frame.current) return;
			frame.current = requestAnimationFrame(() => {
				frame.current = 0;
				store.setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_SLACK);
			});
		};
		node.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			node.removeEventListener("scroll", onScroll);
			if (frame.current) cancelAnimationFrame(frame.current);
		};
	}, []);

	/**
	 * Content that grows without a new message still needs to stay pinned: a tool card that
	 * flips to `done` and shows its output, a markdown block finishing, an image settling.
	 * React commits that growth after the layout effect above has run, and the message object
	 * did not change, so nothing scrolled and the transcript stopped a screen short of the
	 * bottom. The observer sees the height, not the data.
	 */
	useEffect(() => {
		const node = box.current;
		const inner = content.current;
		if (!node || !inner) return;
		const observer = new ResizeObserver(() => {
			if (!store.atBottom) return;
			const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
			if (gap <= 0) return;
			// A settling card is a visible jump, so it glides. A stream delta is a line or two,
			// and animating that fights the next delta, so it pins instead.
			node.scrollTo({ top: node.scrollHeight, behavior: gap > 48 ? "smooth" : "auto" });
		});
		observer.observe(inner);
		return () => observer.disconnect();
	}, []);

	useLayoutEffect(() => {
		const node = box.current;
		if (!node) return;
		const held = anchor.current;
		if (held) {
			const row = node.querySelector<HTMLElement>(`[data-row="${CSS.escape(held.key)}"]`);
			if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - held.offset;
			anchor.current = null;
			return;
		}
		if (smoothNonce !== lastSmooth.current) {
			lastSmooth.current = smoothNonce;
			node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
			return;
		}
		if (store.atBottom) node.scrollTop = node.scrollHeight;
	}, [messages, streaming, start, bottomNonce, smoothNonce]);

	const loadEarlier = () => {
		const node = box.current;
		const row = node?.querySelector<HTMLElement>("[data-row]");
		if (node && row) anchor.current = { key: row.dataset.row ?? "", offset: row.getBoundingClientRect().top - node.getBoundingClientRect().top };
		store.showEarlier();
	};

	const hidden = start;

	return (
		<div className="scroll" ref={box}>
			{hidden > 0 && (
				<button type="button" className="load-earlier" onClick={loadEarlier}>
					load earlier · {hidden} hidden
				</button>
			)}
			{note && <div className="message system">{note}</div>}
			{/* Observed by the transcript's ResizeObserver: rows grow after commit (tool output,
			    markdown, images), and that growth has no message change to hang a scroll on. */}
			<div className="scroll-body" ref={content}>
				{messages.slice(start).map((message, index) => {
					const key = rowKey(message);
					// --i drives the card-birth stagger in styles.css. It is capped so a long backlog
					// does not make the newest row wait seconds before it can appear.
					return (
						<div className="row" data-row={key} data-kind={rowKind(message)} style={{ "--i": Math.min(index, 6) } as CSSProperties} key={key}>
							<MessageRow message={message} />
						</div>
					);
				})}
				{streaming && (
					<div
						className="row"
						data-row="streaming"
						data-kind="text"
						style={{ "--i": Math.min(messages.length - start, 6) } as CSSProperties}
						key="streaming"
					>
						<MessageRow message={streaming} streaming />
					</div>
				)}
				{!messages.length && !streaming && (
					<div className="welcome">
						<h3>omp webchat</h3>
						<p>
							This tab drives the runtime directly: streaming turns, tool cards, dialogs, slash commands, subagents and live voice all come from{" "}
							<code>omp --mode rpc-ui</code>. Type a message, or <kbd>/</kbd> for the command palette.
						</p>
						<ul>
							<li>
								<kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
							</li>
							<li>
								<kbd>Esc</kbd> abort the running turn
							</li>
							<li>
								<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> command palette
							</li>
						</ul>
					</div>
				)}
			</div>
			{pendingNew > 0 && (
				<button type="button" className="new-pill" onClick={() => store.markRead()}>
					{pendingNew} new
				</button>
			)}
		</div>
	);
}
