import { useEffect, useRef, useState } from "react";
import { useStore } from "../useStore";

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function levelClass(percent: number): string {
	if (percent >= 90) return "err";
	if (percent >= 70) return "warn";
	return "ok";
}

/**
 * Context usage. The design put it in the header, which is the first thing a phone drops, so
 * it lives beside the send button instead: a ring you can read at a glance, tappable for the
 * exact numbers the runtime reports.
 */
export function ContextMeter() {
	const usage = useStore((select) => select.session?.contextUsage);
	const tokensPerSecond = useStore((select) => select.session?.tokensPerSecond);
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		window.addEventListener("pointerdown", onDown);
		return () => window.removeEventListener("pointerdown", onDown);
	}, [open]);

	// Older runtimes/omit fields: nothing to show rather than a fake number.
	if (!usage || typeof usage.tokens !== "number" || !usage.contextWindow) return null;
	const percent = typeof usage.percent === "number" ? usage.percent : (usage.tokens / usage.contextWindow) * 100;
	const level = levelClass(percent);

	return (
		<div className="ctx" ref={box}>
			<button
				type="button"
				className={`ctx-ring ${level}`}
				aria-label={`Context ${percent.toFixed(1)} percent used, ${usage.tokens} of ${usage.contextWindow} tokens`}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<circle className="track" cx="12" cy="12" r={RADIUS} />
					<circle
						className="value"
						cx="12"
						cy="12"
						r={RADIUS}
						strokeDasharray={`${(percent / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
					/>
				</svg>
				<span>{percent < 10 ? percent.toFixed(1) : Math.round(percent)}%</span>
			</button>
			{open && (
				<div className="ctx-pop" role="dialog" aria-label="context usage">
					<b>context</b>
					<dl>
						<dt>used</dt>
						<dd>{usage.tokens.toLocaleString()} tok</dd>
						<dt>window</dt>
						<dd>{usage.contextWindow.toLocaleString()} tok</dd>
						<dt>left</dt>
						<dd>{Math.max(0, usage.contextWindow - usage.tokens).toLocaleString()} tok</dd>
						{typeof tokensPerSecond === "number" && tokensPerSecond > 0 && (
							<>
								<dt>speed</dt>
								<dd>{tokensPerSecond.toFixed(1)} tok/s</dd>
							</>
						)}
					</dl>
				</div>
			)}
		</div>
	);
}
