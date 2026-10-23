import { useEffect, useState } from "react";
import { PULSE_MS } from "./phase-core";
import { store } from "./store";
import { useStore } from "./useStore";
import type { Phase } from "./phase-core";

/**
 * The turn phase, re-rendered when a transient phase expires.
 *
 * `phase()` compares `Date.now()` against the pulse stamp, so nothing in the store changes when
 * that pulse goes stale. A short timer covers exactly that window and stops as soon as the pulse
 * is gone — no permanent interval per subscriber.
 */
export function usePhase(): Phase {
	const phase = useStore((select) => select.phase());
	const pulse = useStore((select) => select.pulse);
	const [, tick] = useState(0);

	useEffect(() => {
		if (!pulse) return;
		const timer = setInterval(() => {
			if (!store.pulse || Date.now() - store.pulse.at >= PULSE_MS) clearInterval(timer);
			tick((count) => count + 1);
		}, 200);
		return () => clearInterval(timer);
	}, [pulse]);

	return phase;
}
