import { useStore } from "../useStore";

/**
 * "omp is working" indicator. The old version was a flat 2 px bar that snapped in and out;
 * this one fades in, sweeps a soft highlight, and carries three pulsing dots so it reads as
 * activity rather than as a broken progress bar.
 */
export function WorkingBar() {
	const busy = useStore((select) => select.busy);
	return (
		<div className={`working${busy ? " on" : ""}`} aria-hidden={!busy} role={busy ? "progressbar" : undefined} aria-label={busy ? "omp is working" : undefined}>
			<span className="sweep" />
			<span className="dots">
				<i />
				<i />
				<i />
			</span>
		</div>
	);
}
