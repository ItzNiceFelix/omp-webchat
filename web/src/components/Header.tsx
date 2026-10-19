import { Bell, BrainCircuit, Menu, Users } from "lucide-react";
import { asRecord, asString } from "../frames";
import { store } from "../store";
import { useStore } from "../useStore";
import { useUi } from "../ui";

const STATUS_LABEL: Record<string, string> = {
	connected: "the bridge and the omp child process are live",
	"omp starting": "the bridge is up, the omp child is starting",
	connecting: "connecting to the webchat bridge",
	"omp exited": "the omp child exited — the bridge respawns it on the next prompt",
	disconnected: "the bridge socket is closed; reconnecting",
};

function statusText(conn: string, child: string): string {
	if (conn === "running") return "connected";
	if (conn === "starting") return "omp starting";
	if (conn === "connecting") return "connecting";
	return child === "exited" ? "omp exited" : "disconnected";
}

/** Header: connection state, the two runtime settings worth reaching anywhere, agents. */
export function Header() {
	const conn = useStore((select) => select.conn);
	const child = useStore((select) => select.childStatus);
	const session = useStore((select) => select.session);
	const agentCount = useStore((select) => select.subagents.size);
	const liveActive = useStore((select) => select.liveActive());
	const notifyPermission = useStore((select) => select.notifyPermission);
	const ui = useUi();

	const label = statusText(conn, child);
	const fullId = asString(asRecord(session?.model)?.id) ?? "model";
	const modelProvider = asString(asRecord(session?.model)?.provider) ?? "";
	// The runtime reports provider-qualified ids; the pill only has room for the model itself.
	const modelId = fullId.split("/").pop() ?? fullId;
	const window = session?.contextUsage?.contextWindow;
	const windowLabel = window ? (window >= 1_000_000 ? `${Math.round(window / 1_000_000)}M` : `${Math.round(window / 1000)}k`) : null;

	return (
		<header>
			<button type="button" className="icon sm mobile-only" aria-label="open chats" onClick={() => ui.setSidebarOpen(true)}>
				<Menu size={17} />
			</button>
			<span className="brand">
				<span className="brand-mark" aria-hidden="true">
					<BrainCircuit size={15} />
				</span>
				omp<span> webchat</span>
			</span>
			{/* Real connection state: the bridge socket plus the child process it drives. */}
			<span className={`conn-pill ${conn}`} title={STATUS_LABEL[label] ?? label}>
				<span className={`conn ${conn}`} />
				<span className="conn-label">{label}</span>
			</span>
			<span className="header-spacer" />
			{liveActive && <span className="conn-pill live">live voice</span>}
			<button type="button" className="model-pill" onClick={() => ui.openModal("models")} title={modelProvider ? `${modelProvider}/${fullId}` : fullId}>
				<span className="dot" />
				<span className="model-name">{modelId}</span>
				{windowLabel && <span className="pill-badge">{windowLabel}</span>}
			</button>
			<button type="button" className="thinking-pill" onClick={() => ui.openModal("thinking")} title="Thinking level">
				<BrainCircuit size={12} />
				{session?.thinkingLevel ?? "thinking"}
			</button>
			<button type="button" className="session" onClick={() => ui.openModal("sessions")} title="Switch session">
				{session?.sessionName || "new chat"}
			</button>
			{notifyPermission !== "unsupported" && (
				<button
					type="button"
					className={`icon sm${notifyPermission === "granted" ? " active" : ""}`}
					title={notifyPermission === "granted" ? "Desktop notifications are on" : "Enable desktop notifications for finished turns"}
					onClick={() =>
						void store.requestNotifications().then((permission) => store.toast(`notifications: ${permission}`, permission === "granted" ? "info" : "warn"))
					}
				>
					<Bell size={15} />
				</button>
			)}
			<button
				type="button"
				className={`agents-toggle${ui.agentsOpen ? " active" : ""}`}
				aria-expanded={ui.agentsOpen}
				title="Subagents and their live transcripts"
				onClick={() => ui.setAgentsOpen(!ui.agentsOpen)}
			>
				<Users size={14} /> {agentCount}
			</button>
		</header>
	);
}
