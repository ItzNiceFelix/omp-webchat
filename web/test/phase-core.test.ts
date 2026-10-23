/**
 * Phase derivation: the precedence order is the contract every "what is omp doing" surface
 * depends on, and it is the one rule that is easy to get subtly wrong (a stale pulse outliving
 * its window, a tool call losing to the block that started it).
 *
 * Run: node --test web/src/phase-core.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePhase, PULSE_MS, type PhaseInput } from "../src/phase-core.ts";

const base: PhaseInput = { retrying: false, compacting: false, toolRunning: false, toolPending: false, lastBlock: undefined, busy: false, pulse: null, now: 10_000 };

test("idle when nothing is running", () => {
	assert.equal(derivePhase(base), "idle");
});

test("retry outranks everything else", () => {
	assert.equal(derivePhase({ ...base, retrying: true, compacting: true, toolRunning: true, lastBlock: "text", busy: true }), "retry");
});

test("compaction outranks a running tool", () => {
	assert.equal(derivePhase({ ...base, compacting: true, toolRunning: true, busy: true }), "compact");
});

test("a running tool outranks the block that started it", () => {
	assert.equal(derivePhase({ ...base, toolRunning: true, lastBlock: "text", busy: true }), "tool");
});

test("thinking and text blocks pick the streaming phase", () => {
	assert.equal(derivePhase({ ...base, busy: true, lastBlock: "thinking" }), "think");
	assert.equal(derivePhase({ ...base, busy: true, lastBlock: "text" }), "write");
});

test("busy before the first block is thinking", () => {
	assert.equal(derivePhase({ ...base, busy: true }), "think");
});

test("a tool call awaiting start is the tool phase", () => {
	assert.equal(derivePhase({ ...base, busy: true, toolPending: true, lastBlock: "toolCall" }), "tool");
});

test("a settled tool call falls back to the model composing its next step", () => {
	assert.equal(derivePhase({ ...base, busy: true, lastBlock: "toolCall" }), "think");
});

test("the pulse shows for its window and then expires", () => {
	const pulse = { kind: "done" as const, at: 10_000 };
	assert.equal(derivePhase({ ...base, pulse, now: 10_000 }), "done");
	assert.equal(derivePhase({ ...base, pulse, now: 10_000 + PULSE_MS - 1 }), "done");
	assert.equal(derivePhase({ ...base, pulse, now: 10_000 + PULSE_MS }), "idle");
});

test("an error pulse reports failure", () => {
	assert.equal(derivePhase({ ...base, pulse: { kind: "error", at: 10_000 }, now: 10_500 }), "error");
});

test("a live turn outranks a pulse from the turn before", () => {
	assert.equal(derivePhase({ ...base, busy: true, pulse: { kind: "done", at: 10_000 }, now: 10_100 }), "think");
});

test("a leftover streaming message cannot keep a settled turn writing", () => {
	// The runtime leaves `streaming` set until the next turn; only `busy` says it is live.
	assert.equal(derivePhase({ ...base, lastBlock: "text" }), "idle");
	assert.equal(derivePhase({ ...base, lastBlock: "thinking" }), "idle");
	assert.equal(derivePhase({ ...base, lastBlock: "text", pulse: { kind: "done", at: 10_000 }, now: 10_200 }), "done");
});
