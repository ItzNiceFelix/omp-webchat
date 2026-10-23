import { ChevronRight, Terminal } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { CheckDraw, CrossDraw, Dots, Ring } from "../icons";
import { store } from "../store";
import type { ToolEntry } from "../types";

function duration(entry: ToolEntry): string {
	const end = entry.end ?? Date.now();
	const ms = end - entry.start;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function compact(args: unknown): string {
	if (args === undefined) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

/** Non-empty output lines, absolute-indexed by the caller so only a *new* line mounts (and fades in). */
function outputLines(text: string): string[] {
	return text
		.split("\n")
		.map((row) => row.trimEnd())
		.filter((row) => row.trim());
}

const calmMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Types `target` in. Arguments that stream (`partialArgs`) just grow and the effect follows
 * them; arguments that arrive whole get the same typed-in feel, but only on a card that
 * started moments ago: a card mounted later (scroll, reload) snaps to its text.
 */
function useTyped(target: string, fresh: boolean): string {
	const [shown, setShown] = useState(fresh ? "" : target);
	useEffect(() => {
		if (shown === target) return;
		if (calmMotion() || !target.startsWith(shown)) {
			setShown(target);
			return;
		}
		const step = Math.max(2, Math.ceil((target.length - shown.length) / 30));
		const timer = setTimeout(() => setShown(target.slice(0, shown.length + step)), 16);
		return () => clearTimeout(timer);
	}, [target, shown]);
	return shown;
}

/**
 * Elapsed time that ticks while the call runs. A 40 s tool otherwise shows a frozen duration
 * between frames; mounted only while running so finished cards keep no timer.
 */
function Elapsed({ entry }: { entry: ToolEntry }) {
	const [, tick] = useState(0);
	useEffect(() => {
		if (entry.status !== "running") return;
		const timer = setInterval(() => tick((count) => count + 1), 100);
		return () => clearInterval(timer);
	}, [entry.status, entry.start]);
	return <span className="mono">{duration(entry)}</span>;
}

/**
 * Tool card. Without opening it you see what the mockup shows: the arguments typed in, a ring
 * (or bouncing dots while the arguments are still being prepared) with a ticking timer, the
 * last few output lines fading in, then a drawn tick (or a shaken cross) on settle. The chevron
 * still opens the full arguments and output on a grid-rows transition (lazily mounted on first
 * open, then kept mounted so the close animation has something to run on).
 */
export const ToolCard = memo(function ToolCard({ entry }: { entry: ToolEntry }) {
	const [open, setOpen] = useState(false);
	const [mounted, setMounted] = useState(false);
	const status = entry.status;
	const running = status === "running";
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

	const argsText = entry.args !== undefined ? compact(entry.args) : (entry.partialArgs ?? "");
	const fresh = useRef(running && Date.now() - entry.start < 2500).current;
	const typed = useTyped(argsText, fresh);

	const lines = outputLines(body);
	const visible = lines.slice(-4);
	const offset = lines.length - visible.length;

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
					{running ? argsText ? <Ring /> : <Dots /> : status === "ok" ? <CheckDraw /> : <CrossDraw />}
					{running ? (argsText ? "running" : "preparing") : status === "ok" ? "done" : "failed"}
					{running ? (
						<Elapsed entry={entry} />
					) : (
						<>
							<span className="sep">·</span>
							{duration(entry)}
						</>
					)}
				</span>
				<ChevronRight size={15} className={`chev${open ? " open" : ""}`} />
			</button>
			{typed && <pre className="tool-args-line">{typed}</pre>}
			<div className={`tool-out${visible.length ? " has" : ""}${status === "error" ? " err" : ""}`}>
				{visible.map((row, index) => (
					<div key={offset + index}>{row}</div>
				))}
			</div>
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
									<div className="col-label">{running ? "stream" : "output"}</div>
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
