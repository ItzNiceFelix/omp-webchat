import { useStore } from "../useStore";
import { store } from "../store";

/** Live voice: phase, mic/speaker levels and the last few transcribed turns. */
export function LiveCard() {
	const live = useStore((select) => select.live);
	const active = useStore((select) => select.liveActive());
	if (!active && live.turns.size === 0) return null;
	const turns = [...live.turns.values()].slice(-12);

	return (
		<div className="side-card live">
			<h4>
				live voice <span>{live.phase || "idle"}</span>
			</h4>
			<Level label="mic" value={live.input} />
			<Level label="out" value={live.output} />
			{turns.map((turn) => (
				<div className={`live-turn ${turn.role}`} key={`${turn.role}:${turn.turn ?? 0}`}>
					<div className="who">
						{turn.role}
						{turn.final ? "" : " …"}
					</div>
					<div>{turn.text ?? ""}</div>
				</div>
			))}
			<div className="live-actions">
				<button type="button" onClick={() => void store.muteLive()}>
					mute
				</button>
				<button type="button" className="danger" onClick={() => void store.toggleLive()}>
					stop
				</button>
			</div>
		</div>
	);
}

function Level({ label, value }: { label: string; value: number }) {
	return (
		<div className="live-row">
			<span className="lbl">{label}</span>
			<div className="live-bar">
				<i style={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} />
			</div>
		</div>
	);
}
