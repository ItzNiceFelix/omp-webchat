import { ChevronUp, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { store, taskMark } from "../store";
import { useStore } from "../useStore";
import { useUi } from "../ui";
import type { ChatRow } from "../types";
import { LiveCard } from "./LiveCard";

const DAY_MS = 86_400_000;

function groupLabel(ms: number): string {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (ms >= startOfToday) return "today";
	if (ms >= startOfToday - DAY_MS) return "yesterday";
	if (ms >= startOfToday - 6 * DAY_MS) return "previous 7 days";
	return "older";
}

function timeAgo(ms: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86_400)}d`;
}

export function Sidebar() {
	const chats = useStore((select) => select.chats);
	const query = useStore((select) => select.chatQuery);
	const activePath = useStore((select) => select.session?.sessionFile);
	const session = useStore((select) => select.session);
	const cwd = useStore((select) => select.cwd);
	const ompBin = useStore((select) => select.ompBin);
	const queue = useStore((select) => select.queue);
	const widgets = useStore((select) => select.widgets);
	const files = useStore((select) => select.files);
	const ui = useUi();

	const filter = query.trim().toLowerCase();
	const rows = chats.filter((chat) => !filter || `${chat.name} ${chat.firstUser ?? ""} ${chat.id}`.toLowerCase().includes(filter));
	// A brand-new session has no file on disk until its first entry lands: show it anyway.
	if (activePath && !filter && !rows.some((chat) => chat.path === activePath))
		rows.unshift({ path: activePath, id: "", name: session?.sessionName || "new chat", firstUser: "", mtime: Date.now(), synthetic: true });

	const todoPhases = session?.todoPhases ?? [];
	const openTasks = todoPhases.flatMap((phase) => phase.tasks).filter((task) => task.status !== "completed" && task.status !== "abandoned").length;
	const totalTasks = todoPhases.flatMap((phase) => phase.tasks).length;

	return (
		<aside className="sidebar">
			<div className="side-head">
				<span>chats</span>
				<div>
					<button type="button" aria-label="new chat" title="New chat" onClick={() => void store.newChat()}>
						<Plus size={16} />
					</button>
					<button type="button" aria-label="reload chats" title="Reload chats" onClick={() => void store.loadChats()}>
						<RefreshCw size={15} />
					</button>
					<button type="button" className="mobile-only" aria-label="close chats" onClick={() => ui.setSidebarOpen(false)}>
						<X size={16} />
					</button>
				</div>
			</div>
			<label className="search">
				<Search size={14} />
				<input value={query} placeholder="search chats…" onChange={(event) => store.setChatQuery(event.target.value)} />
			</label>
			{rows.length === 0 && <div className="dim">{filter ? "no match" : "no chats in this folder yet"}</div>}
			{rows.map((chat, index) => (
				<ChatRowView key={chat.path} chat={chat} active={chat.path === activePath} newGroup={index === 0 || groupLabel(rows[index - 1].mtime) !== groupLabel(chat.mtime)} />
			))}

			<div className="side-card">
				<h4>
					session <span>{session?.sessionId?.slice(0, 8) ?? "—"}</span>
				</h4>
				<dl>
					<dt>cwd</dt>
					<dd title={cwd}>{cwd || "—"}</dd>
					<dt>model</dt>
					<dd>
						{session?.model?.provider ? `${session.model.provider}/` : ""}
						{session?.model?.id ?? "—"}
					</dd>
					<dt>thinking</dt>
					<dd>{session?.thinkingLevel ?? "—"}</dd>
					<dt>turns</dt>
					<dd>{session?.messageCount ?? 0}</dd>
					<dt>omp</dt>
					<dd title={ompBin}>{ompBin.split("/").pop() ?? "—"}</dd>
					<dt>session</dt>
					<dd title={session?.sessionFile ?? ""}>{session?.sessionFile?.split("/").pop() ?? "not persisted yet"}</dd>
				</dl>
			</div>

			{todoPhases.length > 0 && (
				<div className="side-card">
					<h4>
						todos <span>{totalTasks - openTasks}/{totalTasks} done</span>
					</h4>
					{todoPhases.map((phase) => (
						<div key={phase.name}>
							<div className="phase">
								{phase.name} · {phase.tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length}/{phase.tasks.length}
							</div>
							{phase.tasks.map((task) => (
								<div className={`task ${task.status}`} key={task.content}>
									<span className="mark">{taskMark(task.status)}</span>
									<span className="txt">
										{task.content}
										{task.blocker ? ` — ${task.blocker}` : ""}
									</span>
								</div>
							))}
						</div>
					))}
				</div>
			)}

			{(queue.steering.length > 0 || queue.followUp.length > 0) && (
				<div className="side-card">
					<h4>
						queue <span>{queue.steering.length + queue.followUp.length} waiting</span>
					</h4>
					{queue.steering.map((text) => (
						<QueuedRow key={`s:${text}`} text={text} queue="steering" />
					))}
					{queue.followUp.map((text) => (
						<QueuedRow key={`f:${text}`} text={text} queue="followUp" />
					))}
				</div>
			)}

			{widgets.size > 0 && (
				<div className="side-card">
					<h4>status</h4>
					{[...widgets.entries()].map(([key, text]) => (
						<p key={key}>{text || key}</p>
					))}
				</div>
			)}

			{files.length > 0 && (
				<div className="side-card">
					<h4>
						files <span>{files.length}</span>
					</h4>
					{files.map((file) => (
						<div className="file-card" key={file.id}>
							<div>
								<b>{file.name}</b>
								<span>
									{(file.bytes / 1024).toFixed(1)} KiB · {file.mimeType}
								</span>
							</div>
							<button
								type="button"
								onClick={() => {
									const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
									const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
									const anchor = document.createElement("a");
									anchor.href = url;
									anchor.download = file.name;
									anchor.click();
									setTimeout(() => URL.revokeObjectURL(url), 5000);
								}}
							>
								download
							</button>
						</div>
					))}
				</div>
			)}

			<LiveCard />
		</aside>
	);
}

function ChatRowView({ chat, active, newGroup }: { chat: ChatRow; active: boolean; newGroup: boolean }) {
	const ui = useUi();
	return (
		<>
			{newGroup && <div className="group">{groupLabel(chat.mtime)}</div>}
			<div
				className={`chat-row${active ? " selected" : ""}`}
				title={`${chat.name}\n${chat.synthetic ? "not persisted yet" : chat.path}`}
				onClick={() => (chat.synthetic ? undefined : void store.switchChat(chat.path))}
			>
				<span>{chat.name}</span>
				<div className="chat-actions">
					<button
						type="button"
						aria-label={`Rename ${chat.name}`}
						title="Rename chat"
						onClick={(event) => {
							event.stopPropagation();
							ui.openRename({ path: chat.path, name: chat.name });
						}}
					>
						<Pencil size={13} />
					</button>
					{!active && (
						<button
							type="button"
							className="del"
							aria-label={`Delete ${chat.name}`}
							title="Delete chat"
							onClick={(event) => {
								event.stopPropagation();
								ui.openDelete({ path: chat.path, name: chat.name });
							}}
						>
							<Trash2 size={13} />
						</button>
					)}
				</div>
				<small>{timeAgo(chat.mtime)}</small>
			</div>
		</>
	);
}

function QueuedRow({ text, queue }: { text: string; queue: "steering" | "followUp" }) {
	return (
		<div className="queued">
			<span className="txt">{text}</span>
			<button type="button" title="Send next (promote to steering)" aria-label="Promote queued message" onClick={() => void store.promoteQueued(text)}>
				<ChevronUp size={13} />
			</button>
			<button
				type="button"
				title="Remove from queue and restore the draft"
				aria-label="Remove queued message"
				onClick={() =>
					void store.removeQueued(text, queue).then((images) => {
						store.setDraft(text);
						store.addDraftImages(images);
					})
				}
			>
				<X size={13} />
			</button>
		</div>
	);
}
