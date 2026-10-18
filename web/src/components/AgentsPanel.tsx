import { RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { store } from "../store";
import { useStore } from "../useStore";
import { useUi } from "../ui";
import type { SubagentRow } from "../types";

/**
 * Subagent panel: every subagent the runtime reports, with steer/kill and a transcript that
 * is tailed with `get_subagent_messages` (`fromByte` cursor) instead of being re-fetched
 * whole on every poll.
 */
export function AgentsPanel() {
	const agents = useStore((select) => select.subagents);
	const drawer = useStore((select) => select.drawer);
	const ui = useUi();
	const rows = [...agents.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

	if (!ui.agentsOpen) return null;

	return (
		<div className="agents-wrap">
			<aside className="agents">
				<div className="side-head">
					<span>agents ({rows.length})</span>
					<div>
						<button type="button" aria-label="refresh agents" title="Refresh agents" onClick={() => void store.refreshSubagents()}>
							<RefreshCw size={15} />
						</button>
						<button type="button" aria-label="close agents" onClick={() => ui.setAgentsOpen(false)}>
							<X size={15} />
						</button>
					</div>
				</div>
				{rows.length === 0 && <div className="dim">No subagents yet. Agents spawned by the task tool appear here with their transcripts.</div>}
				{rows.map((row) => (
					<AgentRow key={row.id} row={row} selected={drawer.selected === row.id} />
				))}
			</aside>
			{drawer.open && drawer.selected && <AgentTranscript />}
		</div>
	);
}

function AgentRow({ row, selected }: { row: SubagentRow; selected: boolean }) {
	const [steering, setSteering] = useState(false);
	const [message, setMessage] = useState("");
	const status = row.status ?? row.progress?.phase ?? "running";
	return (
		<div className={`agent${selected ? " selected" : ""}`}>
			<div className="agent-top">
				<span className={`agent-dot ${status === "done" || status === "completed" ? "done" : ""}`} />
				<b>{row.id}</b>
				<span className={`status ${status}`}>{status}</span>
			</div>
			{row.progress?.text && <p>{row.progress.text}</p>}
			{row.task && !row.progress?.text && <p>{row.task}</p>}
			<small>
				{row.progress?.tokens !== undefined ? `${row.progress.tokens} tokens · ` : ""}
				{row.progress?.elapsedMs !== undefined ? `${(row.progress.elapsedMs / 1000).toFixed(1)}s` : row.kind ?? ""}
			</small>
			<div className="agent-actions">
				<button type="button" onClick={() => setSteering(!steering)}>
					Steer
				</button>
				<button type="button" className="danger" onClick={() => void store.cancelSubagent(row.id)}>
					Kill
				</button>
				<button type="button" className="transcript" onClick={() => store.openAgentTranscript(row)}>
					View transcript
				</button>
			</div>
			{steering && (
				<div className="steer-box">
					<textarea value={message} placeholder={`message for ${row.id}…`} onChange={(event) => setMessage(event.target.value)} />
					<button
						type="button"
						className="primary"
						onClick={() => {
							void store.steerSubagent(row.id, message.trim()).then(() => {
								setMessage("");
								setSteering(false);
							});
						}}
					>
						send
					</button>
				</div>
			)}
		</div>
	);
}

function AgentTranscript() {
	const drawer = useStore((select) => select.drawer);
	const box = useRef<HTMLPreElement>(null);

	useEffect(() => {
		const node = box.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [drawer.transcript]);

	return (
		<section className="agent-transcript">
			<div className="side-head">
				<span>transcript · {drawer.selected}</span>
				<button type="button" aria-label="close transcript" onClick={() => store.closeAgentTranscript()}>
					<X size={15} />
				</button>
			</div>
			{drawer.error && <div className="error-line">{drawer.error}</div>}
			<pre ref={box}>{drawer.transcript || "loading…"}</pre>
			<div className="dim">tailing with the runtime's byte cursor · every 2.5 s</div>
		</section>
	);
}
