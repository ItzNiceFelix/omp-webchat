import { useEffect } from "react";
import { useStore } from "./useStore";
import { UiProvider, useUi } from "./ui";
import { AgentsPanel } from "./components/AgentsPanel";
import { Composer } from "./components/Composer";
import { DialogHost } from "./components/DialogHost";
import { Header } from "./components/Header";
import { Modals } from "./components/Modals";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { Transcript } from "./components/Transcript";

export function App() {
	return (
		<UiProvider>
			<Shell />
		</UiProvider>
	);
}

function Shell() {
	const ui = useUi();
	const busy = useStore((select) => select.busy);
	const statusLine = useStore((select) => select.statusLine);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				ui.openModal("commands");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [ui]);

	return (
		<div className="app" data-agents={ui.agentsOpen ? "open" : "closed"}>
			<Header />
			<div className={`side-wrap${ui.sidebarOpen ? " open" : ""}`}>
				<Sidebar />
			</div>
			{ui.sidebarOpen && <div className="sheet-backdrop" role="presentation" onClick={() => ui.setSidebarOpen(false)} />}
			<main>
				<div className={`busy${busy ? " on" : ""}`} role="progressbar" aria-label="agent is working" />
				<Transcript />
				{statusLine && <div className="status-line">{statusLine}</div>}
				<Composer />
			</main>
			<AgentsPanel />
			{ui.agentsOpen && <div className="sheet-backdrop agents" role="presentation" onClick={() => ui.setAgentsOpen(false)} />}
			<Modals />
			<DialogHost />
			<Toasts />
		</div>
	);
}
