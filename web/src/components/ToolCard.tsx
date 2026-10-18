import { Check, ChevronDown, ChevronRight, CircleAlert, Loader, Terminal } from "lucide-react";
import { memo, useState } from "react";
import { store } from "../useStore";
import type { ToolEntry } from "../types";

function duration(entry: ToolEntry): string {
	const end = entry.end ?? Date.now();
	const ms = end - entry.start;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Tool card, collapsed by default: the header carries name, intent and status, the body is
 * only mounted when the reader opens it. A running card shows its live preview line and a
 * failed card shows the first error line while collapsed.
 */
export const ToolCard = memo(function ToolCard({ entry }: { entry: ToolEntry }) {
	const [open, setOpen] = useState(false);
	const status = entry.status;
	const body = entry.output ?? entry.preview ?? "";

	return (
		<div className={`tool ${status}`}>
			<button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="tool-icon">
					<Terminal size={14} />
				</span>
				<b>{entry.name}</b>
				{entry.intent && <span className="tool-intent">{entry.intent}</span>}
				<span className={`status ${status}`}>
					{status === "running" ? <Loader size={13} /> : status === "ok" ? <Check size={13} /> : <CircleAlert size={13} />}
					{status}
				</span>
				<span className="mono">{duration(entry)}</span>
				{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
			</button>
			{status === "running" && entry.preview && <div className="live-line">{firstLine(entry.preview)}</div>}
			{status === "error" && !open && <div className="error-line">{firstLine(body) || "tool failed"}</div>}
			{open && (
				<div className="tool-body">
					{entry.args !== undefined && <pre className="tool-args">{JSON.stringify(entry.args, null, 2)}</pre>}
					<pre>{body || "(no output)"}</pre>
					{body && (
						<button type="button" className="show-full" onClick={() => void store.copy(body)}>
							copy output
						</button>
					)}
				</div>
			)}
		</div>
	);
});

function firstLine(text: string): string {
	const line = text.split("\n").find((row) => row.trim());
	return (line ?? "").slice(0, 240);
}
