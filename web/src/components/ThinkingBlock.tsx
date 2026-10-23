import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Thinking block. The runtime does not report how long it thought, so the elapsed time is
 * measured while the block streams and frozen when the message settles — a reloaded
 * transcript shows the label without a fabricated duration.
 */
export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
	const [open, setOpen] = useState(streaming);
	const [mounted, setMounted] = useState(streaming);
	const start = useRef(Date.now());
	const [seconds, setSeconds] = useState<number | null>(null);

	useEffect(() => {
		if (!streaming) {
			setSeconds((previous) => previous ?? Math.round((Date.now() - start.current) / 1000));
			return;
		}
		setOpen(true);
		setMounted(true);
		start.current = Date.now();
		const timer = setInterval(() => setSeconds(Math.round((Date.now() - start.current) / 1000)), 1000);
		return () => clearInterval(timer);
	}, [streaming]);

	const label = streaming ? "Thinking" : seconds === null ? "Thought" : seconds < 1 ? "Thought for under a second" : `Thought for ${seconds}s`;
	const elapsed = streaming && seconds !== null ? ` ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : "";

	return (
		<div className={`thinking rise${streaming ? " streaming" : ""}`}>
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
				{elapsed && <span className="mono">{elapsed}</span>}
				<ChevronRight size={13} className={`chev${open ? " open" : ""}`} />
			</button>
			{mounted && (
				<div className={`disclosure${open ? " open" : ""}`}>
					<div className="disclosure-inner">
						<div className="thinking-body">
							{text}
							{streaming && <span className="caret" />}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
