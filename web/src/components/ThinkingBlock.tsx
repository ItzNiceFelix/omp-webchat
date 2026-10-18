import { useEffect, useRef, useState } from "react";

/**
 * Thinking block. The runtime does not report how long it thought, so the elapsed time is
 * measured while the block streams and frozen when the message settles — a reloaded
 * transcript shows the label without a fabricated duration.
 */
export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
	const [open, setOpen] = useState(streaming);
	const start = useRef(Date.now());
	const [seconds, setSeconds] = useState<number | null>(null);

	useEffect(() => {
		if (!streaming) {
			setSeconds((previous) => previous ?? Math.round((Date.now() - start.current) / 1000));
			return;
		}
		setOpen(true);
		start.current = Date.now();
		const timer = setInterval(() => setSeconds(Math.round((Date.now() - start.current) / 1000)), 1000);
		return () => clearInterval(timer);
	}, [streaming]);

	const label = streaming ? "Thinking" : seconds === null ? "Thinking" : seconds < 1 ? "Thought for under a second" : `Thought for ${seconds}s`;
	const elapsed = streaming && seconds !== null ? ` · ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : "";

	return (
		<div className={`thinking${streaming ? " streaming" : ""}`}>
			<button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="marker" />
				{label}
				{elapsed}
			</button>
			{open && <div className="thinking-body">{text}</div>}
		</div>
	);
}
