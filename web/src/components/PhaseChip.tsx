import { useEffect, useRef, useState } from "react";
import { Block, CheckDraw, CrossDraw, Dash, Dot, Ring, Spark, Wave } from "../icons";
import type { Phase } from "../phase-core";
import { usePhase } from "../phase";
import { initialSwap, nextSwap, settleSwap, SWAP_MS } from "../phase-swap";
import { useStore } from "../useStore";

const LABEL: Record<Phase, string> = {
	idle: "ready",
	think: "thinking",
	tool: "tool",
	write: "writing",
	retry: "retrying",
	compact: "compacting",
	error: "failed",
	done: "done",
};

/** The eight phases in glyph order; one slot each, cross-faded by `data-on`. */
const GLYPH_ORDER: Phase[] = ["idle", "think", "tool", "write", "retry", "compact", "error", "done"];

/** Only a running phase has a meaningful elapsed time; idle/done/error show none. */
const TIMED: Record<Phase, boolean> = {
	idle: false,
	think: true,
	tool: true,
	write: true,
	retry: true,
	compact: true,
	error: false,
	done: false,
};

/**
 * The newest requested phase wins.
 *
 * All of the decision-making lives in `phase-swap.ts`, which is pure and covered by
 * `test/phase-swap.test.ts`. This hook is only the timer and the React state around it.
 *
 * A phase that arrives while a swap is running overwrites `pending` instead of queueing, so a
 * burst renders the first phase of the burst and the last, and nothing in between. A tool that
 * starts and finishes inside 40ms therefore never flashes "tool" on its way to "writing".
 */
function useSkippingPhase(phase: Phase): Phase {
	const [swap, setSwap] = useState(() => initialSwap(phase));
	const swapRef = useRef(swap);
	swapRef.current = swap;
	const timer = useRef<number | null>(null);

	useEffect(() => {
		const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (reduced) {
			// No swap window: paint synchronously so the chip is never behind the runtime.
			setSwap(initialSwap(phase));
			return;
		}

		const step = nextSwap(swapRef.current, phase);
		if (step.state !== swapRef.current) setSwap(step.state);
		if (!step.startTimer) return;

		timer.current = window.setTimeout(() => {
			setSwap((current) => settleSwap(current));
		}, SWAP_MS);
	}, [phase]);

	useEffect(() => () => window.clearTimeout(timer.current ?? undefined), []);

	return swap.shown as Phase;
}

/** One glyph per phase. All eight animate; none is allowed to sit still while visible. */
function Glyph({ phase }: { phase: Phase }) {
	switch (phase) {
		case "idle":
			return <Dot />;
		case "think":
			return <Spark />;
		case "tool":
			return <Block />;
		case "write":
			return <Wave />;
		case "retry":
			return <Ring />;
		case "compact":
			return <Dash />;
		case "error":
			return <CrossDraw />;
		case "done":
			return <CheckDraw />;
	}
}

/** Ticking elapsed time; mounted only while a phase is timed, so idle chats run no timer. */
function Elapsed({ since }: { since: number | null }) {
	const [, tick] = useState(0);
	useEffect(() => {
		if (since === null) return;
		const timer = setInterval(() => tick((count) => count + 1), 250);
		return () => clearInterval(timer);
	}, [since]);
	if (since === null) return null;
	return <span className="pt">{((Date.now() - since) / 1000).toFixed(1)}s</span>;
}

/**
 * "What omp is doing" as one chip: phase glyph, word and elapsed time.
 *
 * The word and the colour come from `store.phase()`; a running tool names itself as
 * `tool · name`. Tapping it jumps to that tool's card, which is the one thing a scrolled-away
 * reader wants next.
 *
 * The glyph slot holds all eight glyphs at once and cross-fades between them. Rendering only
 * the active one would unmount the previous glyph, which is what made the old chip pop instead
 * of transition.
 */
export function PhaseChip() {
	const phase = usePhase();
	const shown = useSkippingPhase(phase);
	const since = useStore((select) => select.phaseSince());
	const tool = useStore((select) => select.runningTool());
	const queued = useStore((select) => select.queue.steering.length + select.queue.followUp.length);
	const label = shown === "tool" && tool?.name ? `tool · ${tool.name}` : LABEL[shown];

	const jump = () => {
		if (!tool) return;
		document.querySelector(`[data-tool-id="${CSS.escape(tool.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
	};

	return (
		<button
			type="button"
			className="quick-pill phase"
			data-phase={shown}
			onClick={jump}
			disabled={!tool}
			title={tool ? `Running ${tool.name}, tap to jump to its card` : `Phase: ${LABEL[shown]}`}
		>
			<span className="pi" aria-hidden="true">
				{GLYPH_ORDER.map((name) => (
					<span className="pi-g" data-on={name === shown ? "" : undefined} data-glyph={name} key={name}>
						<Glyph phase={name} />
					</span>
				))}
			</span>
			<span className="pl">{label}</span>
			{/* A frozen "0.0s" next to "ready" is noise, so the slot is absent, not empty. */}
			{TIMED[shown] && <Elapsed since={since} />}
			{queued > 0 && <span className="pq">· {queued} queued</span>}
		</button>
	);
}
