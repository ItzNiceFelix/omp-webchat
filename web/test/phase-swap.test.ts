/**
 * The skip-to-latest contract.
 *
 * The user's requirement, verbatim: "if the status changes very fast, still animate, but skip
 * the statuses left behind and jump straight to the newest, so you do not render unnecessary
 * work." These tests pin exactly that, without a DOM or a timer.
 *
 * Run: node --test test/phase-swap.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialSwap, nextSwap, settleSwap, SWAP_MS, type SwapState } from "../src/phase-swap.ts";

/**
 * Drive a burst through the scheduler the way the hook does, and record what gets painted.
 * Returns only the paints the burst *caused*: the phase already on screen before the burst
 * is not a render, it was there already.
 */
function runBurst(phases: string[], gapMs: number): string[] {
	let state = initialSwap(phases[0] ?? "idle");
	const painted: string[] = [];
	let elapsed = 0;
	let timerAt: number | null = null;

	// Record the value that is on screen after this step, whenever it changed.
	const paint = (next: SwapState) => {
		const changed = next.shown !== state.shown;
		state = next;
		if (changed) painted.push(next.shown);
	};

	for (const phase of phases.slice(1)) {
		elapsed += gapMs;

		// A swap timer that came due before this phase arrived settles first.
		if (timerAt !== null && elapsed >= timerAt) {
			paint(settleSwap(state));
			timerAt = null;
		}

		const before = state;
		const step = nextSwap(before, phase);
		state = step.state;
		if (step.startTimer) {
			if (before.shown !== state.shown) painted.push(state.shown);
			timerAt = elapsed + SWAP_MS;
		}
	}

	if (timerAt !== null) paint(settleSwap(state));
	return painted;
}

test("a burst faster than the swap window collapses to two renders", () => {
	// `think` is already painted before the burst starts; the burst then delivers five more
	// phases 12ms apart. Only the first of those can paint, plus the last after the timer.
	// `think` is already on screen; the burst delivers five more phases 12ms apart.
	const painted = runBurst(["think", "tool", "retry", "tool", "write", "done"], 12);
	assert.equal(painted.length, 2, `expected 2 renders, got ${painted.length}: ${painted.join(",")}`);
	assert.equal(painted[0], "tool", "only the first phase of the burst can paint");
	assert.equal(painted[painted.length - 1], "done", "the newest phase wins the slot");
});

test("a burst of twelve renders two, not twelve", () => {
	const phases = ["think", "tool", "write", "think", "tool", "write", "retry", "tool", "compact", "think", "write", "done"];
	const painted = runBurst(phases, 10);
	assert.equal(painted.length, 2, `expected 2 renders, got ${painted.length}: ${painted.join(",")}`);
	assert.equal(painted[painted.length - 1], "done", "the newest phase always wins");
});

test("phases slower than the swap window all render, in order", () => {
	// `think` is the phase already on screen; each later phase gets its own swap window,
	// so nothing is superseded and every one of them paints.
	const phases = ["think", "tool", "write", "done"];
	const painted = runBurst(phases, SWAP_MS + 40);
	assert.deepEqual(painted, ["tool", "write", "done"]);
});

test("a repeated phase while idle does not repaint", () => {
	const state: SwapState = initialSwap("think");
	const step = nextSwap(state, "think");
	assert.equal(step.startTimer, false);
	assert.deepEqual(step.state, state);
});

test("the running timer is never restarted by a newer phase", () => {
	let state = initialSwap("idle");
	const first = nextSwap(state, "think");
	assert.equal(first.startTimer, true, "the first phase starts the timer");
	state = first.state;

	const second = nextSwap(state, "tool");
	assert.equal(second.startTimer, false, "a phase arriving mid-swap must not restart the timer");
	assert.equal(second.state.pending, "tool");

	const third = nextSwap(second.state, "write");
	assert.equal(third.startTimer, false);
	assert.equal(third.state.pending, "write", "the newest pending phase wins");
});

test("settling paints the newest pending phase and clears the queue", () => {
	let state = nextSwap(initialSwap("idle"), "think").state;
	state = nextSwap(state, "tool").state;
	state = nextSwap(state, "done").state;

	const settled = settleSwap(state);
	assert.equal(settled.shown, "done");
	assert.equal(settled.pending, null);
	assert.equal(settled.swapping, false);
});

test("settling with nothing pending just clears the swap flag", () => {
	const state = nextSwap(initialSwap("idle"), "think").state;
	const settled = settleSwap(state);
	assert.equal(settled.shown, "think");
	assert.equal(settled.swapping, false);
});

test("the next phase after a settle starts a fresh swap", () => {
	let state = settleSwap(nextSwap(initialSwap("idle"), "think").state);
	const step = nextSwap(state, "tool");
	assert.equal(step.startTimer, true);
	assert.equal(step.state.shown, "tool");
});
