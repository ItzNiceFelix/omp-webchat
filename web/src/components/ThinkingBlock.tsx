import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Only the newest stretch of reasoning is split into fading words; the rest stays plain text,
 *  so a long block costs a bounded number of nodes per delta. */
const TAIL = 600;

/** Words keyed by absolute offset: a word that is already on screen keeps its node (and its
 *  finished animation), only the words a delta adds mount, and mounting is what fades them in. */
function Words({ text, base }: { text: string; base: number }) {
	let at = base;
	return (
		<>
			{text.split(/(\s+)/).map((part) => {
				const key = at;
				at += part.length;
				return /^\s*$/.test(part) ? (
					part
				) : (
					<span key={key} className="fw">
						{part}
					</span>
				);
			})}
		</>
	);
}

function FadeText({ text }: { text: string }) {
	if (text.length <= TAIL) return <Words text={text} base={0} />;
	// Snap the cut to whitespace so a word is never half plain text, half span.
	const rest = text.slice(text.length - TAIL).search(/\s/);
	const cut = rest === -1 ? text.length : text.length - TAIL + rest;
	return (
		<>
			{text.slice(0, cut)}
			<Words text={text.slice(cut)} base={cut} />
		</>
	);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Thinking block. `streaming` means *this block is still being written* (the caller passes
 * false once the model moves on to a tool call or the answer), so the block settles the moment
 * reasoning ends: the duration freezes, the label stops sweeping and, half a second later, it
 * folds to "Thought for 3.1s". The runtime does not report how long it thought, so the time is
 * measured here; a reloaded transcript shows the plain label without a fabricated duration.
 */
export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
	const [open, setOpen] = useState(streaming);
	const [mounted, setMounted] = useState(streaming);
	const [ms, setMs] = useState<number | null>(null);
	const start = useRef(Date.now());
	const was = useRef(false);
	const body = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (streaming) {
			if (!was.current) start.current = Date.now();
			was.current = true;
			setOpen(true);
			setMounted(true);
			setMs(Date.now() - start.current);
			const timer = setInterval(() => setMs(Date.now() - start.current), 100);
			return () => clearInterval(timer);
		}
		if (was.current) {
			was.current = false;
			setMs(Date.now() - start.current);
			const fold = setTimeout(() => setOpen(false), 500);
			return () => clearTimeout(fold);
		}
	}, [streaming]);

	// Follow the newest line while the block streams (the body is clipped to a few lines).
	useEffect(() => {
		if (streaming && body.current) body.current.scrollTop = body.current.scrollHeight;
	}, [text, streaming]);

	const label = streaming
		? `Thinking${ms === null ? "" : ` · ${seconds(ms)}`}`
		: ms === null
			? "Thought"
			: ms < 1000
				? "Thought for under a second"
				: `Thought for ${seconds(ms)}`;

	return (
		<div className={`thinking${streaming ? " streaming" : ""}`}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => {
					setMounted(true);
					setOpen(!open);
				}}
			>
				<span className="marker" />
				<span className="lbl">{label}</span>
				<ChevronRight size={13} className={`chev${open ? " open" : ""}`} />
			</button>
			{mounted && (
				<div className={`disclosure${open ? " open" : ""}`}>
					<div className="disclosure-inner">
						<div className="thinking-body" ref={body}>
							{streaming ? <FadeText text={text} /> : text}
							{streaming && <span className="caret" />}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
