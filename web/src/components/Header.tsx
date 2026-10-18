import { Bell, Menu, Power, RefreshCw, Users } from "lucide-react";
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

/** Header: connection state, session, agents, live voice, process controls. */
export function Header() {
	const conn = useStore((select) => select.conn);
	const child = useStore((select) => select.childStatus);
	const sessionName = useStore((select) => select.session?.sessionName);
	const context = useStore((select) => select.session?.contextUsage);
	const agentCount = useStore((select) => select.subagents.size);
	const liveActive = useStore((select) => select.liveActive());
	const notifyPermission = useStore((select) => select.notifyPermission);
	const ui = useUi();

	const label = statusText(conn, child);
	const restart = async (full: boolean) => {
		const response = await fetch(`/api/restart${full ? "?full=1" : ""}`, { method: "POST" }).catch(() => null);
		if (!response?.ok) store.toast("restart request failed", "error");
	};

	return (
		<header>
			<button type="button" className="icon sm mobile-only" aria-label="open chats" onClick={() => ui.setSidebarOpen(true)}>
				<Menu size={17} />
			</button>
			<span className="brand">
				omp<span> webchat</span>
			</span>
			{/* Real connection state: the bridge socket plus the child process it drives. */}
			<span className={`conn-pill ${conn}`} title={STATUS_LABEL[label] ?? label}>
				<span className={`conn ${conn}`} />
				{label}
			</span>
			<button type="button" className="session" onClick={() => ui.openModal("sessions")} title="Switch session">
				{sessionName || "new chat"}
			</button>
			<span className="header-spacer" />
			{context?.tokens !== undefined && (
				<span className="context" title={`${context.tokens} of ${context.contextWindow ?? "?"} tokens`}>
					{Math.round(context.tokens / 1000)}k / {Math.round((context.contextWindow ?? 0) / 1000)}k tok
					{typeof context.percent === "number" ? ` · ${context.percent.toFixed(0)}%` : ""}
				</span>
			)}
			{liveActive && <span className="conn-pill live">live voice</span>}
			{notifyPermission !== "unsupported" && (
				<button
					type="button"
					className={`icon sm${notifyPermission === "granted" ? " active" : ""}`}
					title={notifyPermission === "granted" ? "Desktop notifications are on" : "Enable desktop notifications for finished turns"}
					onClick={() =>
						void store.requestNotifications().then((permission) => store.toast(`notifications: ${permission}`, permission === "granted" ? "info" : "warn"))
					}
				>
					<Bell size={16} />
				</button>
			)}
			<button
				type="button"
				className={`agents-toggle${ui.agentsOpen ? " active" : ""}`}
				aria-expanded={ui.agentsOpen}
				title="Subagents and their live transcripts"
				onClick={() => ui.setAgentsOpen(!ui.agentsOpen)}
			>
				<Users size={15} /> {agentCount} agent{agentCount === 1 ? "" : "s"}
			</button>
			<button type="button" className="icon sm restart" title="Restart the omp child process" onClick={() => void restart(false)}>
				<RefreshCw size={16} />
			</button>
			<button type="button" className="icon sm restart" title="Restart the whole server" onClick={() => void restart(true)}>
				<Power size={16} />
			</button>
		</header>
	);
}
