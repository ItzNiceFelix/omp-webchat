import { useEffect, useState } from "react";
import { CheckDraw, CrossDraw, Ring, Spark, Wave } from "../icons";
import type { Phase } from "../phase-core";
import { usePhase } from "../phase";
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

/** The mockup's glyph per phase: sparkle (thinking), ring (tool/retry/compact), waveform
 *  (writing), drawn tick/cross (done/failed). All tinted by `--ph` through currentColor. */
function Icon({ phase }: { phase: Phase }) {
	switch (phase) {
		case "think":
			return <Spark />;
		case "tool":
		case "retry":
		case "compact":
			return <Ring />;
		case "write":
			return <Wave />;
		case "error":
			return <CrossDraw />;
		case "done":
			return <CheckDraw />;
		default:
			return null;
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
 * "What omp is doing" as one chip: phase icon, word and elapsed time.
 *
 * The word and the colour come from `store.phase()`; a running tool names itself as
 * `tool · name`. Tapping it jumps to that tool's card, which is the one thing a scrolled-away
 * reader wants next.
 */
export function PhaseChip() {
	const phase = usePhase();
	const since = useStore((select) => select.phaseSince());
	const tool = useStore((select) => select.runningTool());
	const queued = useStore((select) => select.queue.steering.length + select.queue.followUp.length);
	const label = phase === "tool" && tool?.name ? `tool · ${tool.name}` : LABEL[phase];

	const jump = () => {
		if (!tool) return;
		document.querySelector(`[data-tool-id="${CSS.escape(tool.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
	};

	return (
		<button
			type="button"
			className="quick-pill phase"
			data-phase={phase}
			onClick={jump}
			disabled={!tool}
			title={tool ? `Running ${tool.name} — tap to jump to its card` : `Phase: ${LABEL[phase]}`}
		>
			<span className="pi" key={phase}>
				<Icon phase={phase} />
			</span>
			<span className="pl" key={label}>
				{label}
			</span>
			<Elapsed since={since} />
			{queued > 0 && <span className="pq">· {queued} queued</span>}
		</button>
	);
}
