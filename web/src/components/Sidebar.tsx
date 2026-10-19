import { BrainCircuit, ChevronUp, Pencil, Plus, Power, RefreshCw, Search, Trash2, X } from "lucide-react";
import { store, taskMark } from "../store";
import { useStore } from "../useStore";
import { useUi } from "../ui";
import type { ChatRow } from "../types";
import { LiveCard } from "./LiveCard";

const DAY_MS = 86_400_000;

/** Same two endpoints the header used to carry; they live beside the process they restart. */
async function restart(full: boolean) {
	const response = await fetch(`/api/restart${full ? "?full=1" : ""}`, { method: "POST" }).catch(() => null);
	if (!response?.ok) store.toast("restart request failed", "error");
}

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
	const scope = useStore((select) => select.sessionScope);
	const loading = useStore((select) => select.chatsLoading);
	const activePath = useStore((select) => select.session?.sessionFile);
	const cwd = useStore((select) => select.cwd);
	const session = useStore((select) => select.session);
	const ompBin = useStore((select) => select.ompBin);
	const queue = useStore((select) => select.queue);
	const widgets = useStore((select) => select.widgets);
	const files = useStore((select) => select.files);
	const ui = useUi();

	const filter = query.trim().toLowerCase();
	const rows = chats.filter((chat) => !filter || `${chat.name} ${chat.firstUser ?? ""} ${chat.id} ${chat.folder ?? ""}`.toLowerCase().includes(filter));
	// A brand-new session has no file on disk until its first entry lands: show it anyway.
	if (activePath && !filter && !rows.some((chat) => chat.path === activePath))
		rows.unshift({ path: activePath, id: "", name: session?.sessionName || "new chat", firstUser: "", mtime: Date.now(), synthetic: true });

	const todoPhases = session?.todoPhases ?? [];
	const openTasks = todoPhases.flatMap((phase) => phase.tasks).filter((task) => task.status !== "completed" && task.status !== "abandoned").length;
	const totalTasks = todoPhases.flatMap((phase) => phase.tasks).length;

	return (
		<aside className="sidebar">
			<div className="side-brand">
				<span className="brand-mark" aria-hidden="true">
					<BrainCircuit size={14} />
				</span>
				omp webchat
				<small>RPC</small>
			</div>
			<button type="button" className="new-chat" onClick={() => void store.newChat()}>
				<Plus size={15} /> New chat
				<kbd>⌘N</kbd>
			</button>
			<div className="side-head">
				<span>chats</span>
				<div>
					<button type="button" aria-label="reload chats" title="Reload chats" onClick={() => void store.loadChats()}>
						<RefreshCw size={15} className={loading ? "spin" : undefined} />
					</button>
					<button type="button" className="mobile-only" aria-label="close chats" onClick={() => ui.setSidebarOpen(false)}>
						<X size={16} />
					</button>
				</div>
			</div>

			{/* The bucket for the server's cwd is often empty (a fresh project dir): the list is
			    most useful across every folder, so that is the default. */}
			<div className="segmented" role="tablist" aria-label="session scope">
				<button type="button" role="tab" aria-selected={scope === "all"} className={scope === "all" ? "on" : ""} onClick={() => store.setSessionScope("all")}>
					all folders
				</button>
				<button type="button" role="tab" aria-selected={scope === "folder"} className={scope === "folder" ? "on" : ""} onClick={() => store.setSessionScope("folder")}>
					this folder
				</button>
			</div>

			<label className="search">
				<Search size={14} />
				<input value={query} placeholder="search chats…" onChange={(event) => store.setChatQuery(event.target.value)} />
			</label>

			{loading && !rows.length && (
				<div className="skeleton" aria-hidden="true">
					<i />
					<i />
					<i />
					<i />
				</div>
			)}
			{!loading && !rows.length && <div className="dim">{filter ? "no match" : "no chats in this scope yet"}</div>}

			{rows.map((chat, index) => (
				<ChatRowView
					key={chat.path}
					chat={chat}
					active={chat.path === activePath}
					showFolder={scope === "all"}
					newGroup={index === 0 || groupLabel(rows[index - 1].mtime) !== groupLabel(chat.mtime)}
				/>
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
				<div className="side-actions">
					<button type="button" onClick={() => void restart(false)} title="Restart the omp child process">
						<RefreshCw size={12} /> omp
					</button>
					<button type="button" onClick={() => void restart(true)} title="Restart the whole server">
						<Power size={12} /> server
					</button>
				</div>
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

function ChatRowView({ chat, active, newGroup, showFolder }: { chat: ChatRow; active: boolean; newGroup: boolean; showFolder: boolean }) {
	const ui = useUi();
	return (
		<>
			{newGroup && <div className="group">{groupLabel(chat.mtime)}</div>}
			<div
				className={`chat-row${active ? " selected" : ""}`}
				title={`${chat.name}\n${chat.synthetic ? "not persisted yet" : chat.path}`}
				onClick={() => (chat.synthetic ? undefined : void store.switchChat(chat.path))}
			>
				<span className="chat-name">
					{chat.name}
					{showFolder && chat.folder && <small className="folder">{chat.folder}</small>}
				</span>
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
						<Pencil size={14} />
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
							<Trash2 size={14} />
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
				<ChevronUp size={14} />
			</button>
			<button
				type="button"
				title="Remove from queue and restore the draft"
				aria-label="Remove queued message"
				onClick={() =>
					void store.removeQueued(text, queue).then((images) => {
						store.setDraft(text);
						store.addDraftAttachments(
							images.map((image, index) => ({
								id: `queued-${Date.now()}-${index}`,
								name: `queued-${index + 1}.png`,
								size: Math.round((image.data.length * 3) / 4),
								mimeType: image.mimeType,
								image,
							})),
						);
					})
				}
			>
				<X size={14} />
			</button>
		</div>
	);
}
