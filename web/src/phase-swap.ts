/**
 * Which phase is actually on screen, given the phase the runtime reports.
 *
 * The runtime can move through phases faster than the chip can show them: a tool that starts
 * and finishes inside 40ms, a retry that resolves before the swap finishes. Rendering every
 * one of those is wasted work and reads as a flicker, so this is a "newest wins" scheduler:
 * a phase that arrives while a swap is running overwrites the pending one instead of queueing.
 *
 * Pure on purpose. The hook in PhaseChip is a thin timer around these two functions, which
 * makes the contract testable without a DOM or a clock.
 */

/** How long the outgoing glyph takes to fade out before the incoming one takes the slot. */
export const SWAP_MS = 160;

export interface SwapState {
	/** The phase currently painted. */
	shown: string;
	/** The newest phase waiting to paint, or null when nothing is queued. */
	pending: string | null;
	/** True while a swap timer is running. */
	swapping: boolean;
}

export function initialSwap(phase: string): SwapState {
	return { shown: phase, pending: null, swapping: false };
}

export interface SwapStep {
	state: SwapState;
	/** True when the caller must start a timer for `SWAP_MS`. */
	startTimer: boolean;
}

/**
 * Feed a newly reported phase into the scheduler.
 *
 * The contract is "paint now, then hold the slot for SWAP_MS so the outgoing glyph can fade".
 * So the first phase of a burst paints immediately and starts the timer; every phase arriving
 * while that timer runs only overwrites `pending`. When the timer fires, the newest pending
 * phase paints. That is what makes a 6-phase burst render 2 and not 6.
 *
 * - Same phase as `shown` while idle: no-op.
 * - A swap is running: overwrite `pending`, never restart the timer.
 */
export function nextSwap(state: SwapState, phase: string): SwapStep {
	if (state.swapping) {
		if (phase === state.pending || phase === state.shown) return { state, startTimer: false };
		return { state: { ...state, pending: phase }, startTimer: false };
	}

	if (phase === state.shown) return { state, startTimer: false };

	return { state: { shown: phase, pending: null, swapping: true }, startTimer: true };
}

/**
 * The swap timer fired: paint the pending phase if there is one.
 * `swapping` clears either way, so the next phase starts a fresh swap.
 */
export function settleSwap(state: SwapState): SwapState {
	if (state.pending === null) return { ...state, swapping: false };
	return { shown: state.pending, pending: null, swapping: false };
}
