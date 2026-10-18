import { useEffect, useLayoutEffect, useRef } from "react";
import { store } from "../store";
import { useStore } from "../useStore";
import type { Message } from "../types";
import { MessageRow } from "./MessageRow";

const BOTTOM_SLACK = 120;

/** Stable row identity: survives "load earlier" so the anchor element can be found again. */
function rowKey(message: Message): string {
	return message.localId ?? `${message.role}|${message.timestamp ?? 0}|${message.toolCallId ?? ""}`;
}

/**
 * Transcript with scroll anchoring.
 *
 * - While the reader is at the bottom, new rows and stream deltas keep it pinned there.
 * - "load earlier" prepends rows and restores the reading position by measuring one row that
 *   stays on screen (`content-visibility` makes scroll-height deltas an estimate, so an
 *   element anchor is exact where arithmetic is not).
 * - Rows arriving while the reader is scrolled away are counted in the store and surfaced as a
 *   real "N new" pill.
 */
export function Transcript() {
	const messages = useStore((select) => select.messages);
	const streaming = useStore((select) => select.streaming);
	const start = useStore((select) => select.visibleStart());
	const pendingNew = useStore((select) => select.pendingNew);
	const note = useStore((select) => select.transcriptNote);
	const bottomNonce = useStore((select) => select.bottomNonce);

	const box = useRef<HTMLDivElement>(null);
	const anchor = useRef<{ key: string; offset: number } | null>(null);

	useEffect(() => {
		const node = box.current;
		if (!node) return;
		const onScroll = () => store.setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_SLACK);
		node.addEventListener("scroll", onScroll, { passive: true });
		return () => node.removeEventListener("scroll", onScroll);
	}, []);

	// Runs before paint: prepends cannot flash, and following the stream stays smooth.
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
		if (store.atBottom) node.scrollTop = node.scrollHeight;
	}, [messages, streaming, start, bottomNonce]);

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
			{messages.slice(start).map((message) => {
				const key = rowKey(message);
				return (
					<div className="row" data-row={key} key={key}>
						<MessageRow message={message} />
					</div>
				);
			})}
			{streaming && (
				<div className="row" data-row="streaming" key="streaming">
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
			{pendingNew > 0 && (
				<button type="button" className="new-pill" onClick={() => store.markRead()}>
					{pendingNew} new
				</button>
			)}
		</div>
	);
}
