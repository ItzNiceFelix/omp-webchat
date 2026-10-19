import { useEffect, useState } from "react";
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
import { WorkingBar } from "./components/WorkingBar";

export function App() {
	return (
		<UiProvider>
			<Shell />
		</UiProvider>
	);
}

/**
 * A media query as reactive state. `matchMedia` is what actually tells a phone apart from a
 * narrow desktop window; `innerWidth` does not.
 */
function useMedia(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const list = window.matchMedia(query);
		const update = () => setMatches(list.matches);
		update();
		list.addEventListener("change", update);
		return () => list.removeEventListener("change", update);
	}, [query]);
	return matches;
}

/**
 * The soft keyboard. Capacitor's Keyboard plugin resizes the WebView natively; when it does not
 * (older Android WebViews), the visual viewport still shrinks, so the composer is lifted by the
 * measured inset. Both cannot fight: the inset is zero once the WebView itself resized.
 */
function useKeyboardInset() {
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const apply = () => {
			const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
			document.documentElement.style.setProperty("--kb", `${Math.round(inset)}px`);
			document.documentElement.classList.toggle("keyboard-open", inset > 80);
		};
		apply();
		viewport.addEventListener("resize", apply);
		viewport.addEventListener("scroll", apply);
		return () => {
			viewport.removeEventListener("resize", apply);
			viewport.removeEventListener("scroll", apply);
		};
	}, []);
}

function Shell() {
	const ui = useUi();
	const busy = useStore((select) => select.busy);
	const statusLine = useStore((select) => select.statusLine);
	const touch = useMedia("(pointer: coarse)") || navigator.maxTouchPoints > 0;
	useKeyboardInset();

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
		<div
			className="app"
			data-agents={ui.agentsOpen ? "open" : "closed"}
			data-busy={busy ? "true" : "false"}
			// Pointer capability, not a width breakpoint: a phone-width window on a desktop still
			// wants compact rows, and the APK always wants finger-sized ones. Media queries for
			// `hover`/`pointer` are not emulated by every WebView, this is.
			data-touch={touch ? "true" : "false"}
		>
			<Header />
			<div className={`side-wrap${ui.sidebarOpen ? " open" : ""}`}>
				<Sidebar />
			</div>
			{ui.sidebarOpen && <div className="sheet-backdrop" role="presentation" onClick={() => ui.setSidebarOpen(false)} />}
			<main>
				<WorkingBar />
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
