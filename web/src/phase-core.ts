/**
 * What omp is doing, as one value.
 *
 * Pure on purpose: the store feeds it the frames it already handles, so the derivation can be
 * checked without a socket, and every surface (chip, root attribute, ambient tint) reads the
 * same answer. `now` is a parameter so a pulse expiry is testable without a timer.
 */
export type Phase = "idle" | "think" | "tool" | "write" | "retry" | "compact" | "error" | "done";

/** How long the "done"/"failed" tint lingers after a turn settles. */
export const PULSE_MS = 1900;

export interface PhaseInput {
	/** `auto_retry_start` until `auto_retry_end`. */
	retrying: boolean;
	/** `auto_compaction_start`/`end`; `session.isCompacting` lags a whole compaction behind. */
	compacting: boolean;
	/** A tool call is in flight. Outranks the block type: the model has handed off. */
	toolRunning: boolean;
	/** The last block is a `toolCall` the tools map has no entry for: awaiting start/approval. */
	toolPending: boolean;
	/** `type` of the last block in the streaming message. */
	lastBlock: string | undefined;
	/** `agent_start` until the turn settles. */
	busy: boolean;
	pulse: { kind: "done" | "error"; at: number } | null;
	now: number;
}

/** First match wins. Order is the contract: retry and compaction suspend the turn, a running
 *  tool is later than the block that started it, and a stale pulse must not outlive PULSE_MS.
 *  The block type only counts while the turn runs: a leftover `streaming` message must never
 *  keep the chip saying "writing" after the turn settled. */
export function derivePhase(input: PhaseInput): Phase {
	if (input.retrying) return "retry";
	if (input.compacting) return "compact";
	if (input.toolRunning || input.toolPending) return "tool";
	if (input.busy) {
		if (input.lastBlock === "thinking") return "think";
		if (input.lastBlock === "text") return "write";
		// A settled tool call is still the last block until the model writes again; the tool is
		// no longer running, so this is the model composing its next step.
		return "think";
	}
	if (input.pulse && input.now - input.pulse.at < PULSE_MS) return input.pulse.kind;
	return "idle";
}
