import { useStore } from "../useStore";

/** "omp is working" indicator: an aurora strip that sweeps while the turn runs, fading in. */
export function WorkingBar() {
	const busy = useStore((select) => select.busy);
	return (
		<div className={`working${busy ? " on" : ""}`} aria-hidden={!busy} role={busy ? "progressbar" : undefined} aria-label={busy ? "omp is working" : undefined}>
			<span className="sweep" />
		</div>
	);
}
