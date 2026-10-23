import { Check, ChevronRight, CircleAlert, Loader, Terminal } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { store } from "../store";
import type { ToolEntry } from "../types";

function duration(entry: ToolEntry): string {
	const end = entry.end ?? Date.now();
	const ms = end - entry.start;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function firstLine(text: string): string {
	const line = text.split("\n").find((row) => row.trim());
	return (line ?? "").slice(0, 240);
}

/**
 * Elapsed time that ticks while the call runs. A 40 s tool otherwise shows a frozen duration
 * between frames; mounted only while running so finished cards keep no timer.
 */
function Elapsed({ entry }: { entry: ToolEntry }) {
	const [, tick] = useState(0);
	useEffect(() => {
		if (entry.status !== "running") return;
		const timer = setInterval(() => tick((count) => count + 1), 250);
		return () => clearInterval(timer);
	}, [entry.status, entry.start]);
	return <span className="mono">{duration(entry)}</span>;
}

/**
 * Tool card, collapsed by default and animated: the card rises in when the call starts, the
 * chevron turns, and the body expands on a grid-rows transition (lazily mounted on first open,
 * then kept mounted so the close animation has something to run on).
 */
export const ToolCard = memo(function ToolCard({ entry }: { entry: ToolEntry }) {
	const [open, setOpen] = useState(false);
	const [mounted, setMounted] = useState(false);
	const status = entry.status;
	const body = entry.output ?? entry.preview ?? "";

	// One-shot flash on the transition that matters: the card just finished. `prev` survives
	// re-renders without causing one; the class clears itself on a timer.
	const prev = useRef(status);
	const [flash, setFlash] = useState<"" | "flash-ok" | "flash-err">("");
	useEffect(() => {
		const before = prev.current;
		prev.current = status;
		if (before === "running" && status !== "running") {
			setFlash(status === "ok" ? "flash-ok" : "flash-err");
			const timer = setTimeout(() => setFlash(""), 650);
			return () => clearTimeout(timer);
		}
	}, [status]);

	const toggle = () => {
		setMounted(true);
		setOpen((previous) => !previous);
	};

	return (
		<div className={`tool ${status}${flash ? ` ${flash}` : ""} rise`} data-tool-id={entry.id}>
			<button type="button" className="tool-head" aria-expanded={open} onClick={toggle}>
				<span className="tool-icon">
					<Terminal size={14} />
				</span>
				<b>{entry.name}</b>
				{entry.intent && <span className="tool-intent">{entry.intent}</span>}
				<span className={`status ${status}`}>
					{status === "running" ? <Loader size={13} className="spin" /> : status === "ok" ? <Check size={13} /> : <CircleAlert size={13} />}
					{status === "running" ? "running" : status === "ok" ? "done" : "failed"}
					{status !== "running" && <span className="sep">·</span>}
					{status !== "running" && duration(entry)}
				</span>
				{status === "running" && <Elapsed entry={entry} />}
				<ChevronRight size={15} className={`chev${open ? " open" : ""}`} />
			</button>
			{status === "running" && entry.preview && <div className="live-line">{firstLine(entry.preview)}</div>}
			{status === "error" && !open && <div className="error-line">{firstLine(body) || "tool failed"}</div>}
			{mounted && (
				<div className={`disclosure${open ? " open" : ""}`}>
					<div className="disclosure-inner">
						<div className="tool-body">
							<div className="tool-cols">
								{entry.args !== undefined && (
									<div>
										<div className="col-label">arguments</div>
										<pre className="tool-args">{JSON.stringify(entry.args, null, 2)}</pre>
									</div>
								)}
								<div>
									<div className="col-label">{status === "running" ? "stream" : "output"}</div>
									<pre>{body || "(no output)"}</pre>
								</div>
							</div>
							{body && (
								<button type="button" className="show-full" onClick={() => void store.copy(body)}>
									copy output
								</button>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
});
