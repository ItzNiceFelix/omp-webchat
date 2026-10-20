import { useEffect, useState } from "react";
import { store } from "../store";
import { useStore } from "../useStore";
import { useUi } from "../ui";
import { Modal, OptionList } from "./Modal";

/** Every picker that is not driven by the runtime: sessions, models, thinking, commands, btw. */
export function Modals() {
	const ui = useUi();
	if (ui.modal === "sessions") return <SessionsModal />;
	if (ui.modal === "models") return <ModelsModal />;
	if (ui.modal === "thinking") return <ThinkingModal />;
	if (ui.modal === "commands") return <CommandsModal />;
	if (ui.modal === "btw") return <BtwModal />;
	if (ui.rename) return <RenameDialog />;
	if (ui.remove) return <DeleteDialog />;
	return null;
}

function SessionsModal() {
	const ui = useUi();
	const chats = useStore((select) => select.chats);
	const active = useStore((select) => select.session?.sessionFile);
	const [filter, setFilter] = useState("");
	const rows = chats.filter((chat) => !filter || `${chat.name} ${chat.firstUser ?? ""} ${chat.id}`.toLowerCase().includes(filter.toLowerCase()));

	return (
		<Modal
			title="sessions"
			onClose={ui.closeModal}
			footer={
				<>
					<button type="button" className="ghost" onClick={() => void store.loadChats()}>
						refresh
					</button>
					<button
						type="button"
						className="primary"
						onClick={() => {
							ui.closeModal();
							void store.newChat();
						}}
					>
						new session
					</button>
				</>
			}
		>
			<input type="text" autoFocus placeholder="filter sessions" value={filter} onChange={(event) => setFilter(event.target.value)} />
			{rows.length === 0 && <div className="dim">{filter ? "no match" : "no sessions in this folder"}</div>}
			<OptionList
				items={rows.map((chat) => ({
					label: chat.name,
					sub: `${new Date(chat.mtime).toLocaleString()} · ${((chat.bytes ?? 0) / 1024).toFixed(0)} KiB`,
					hint: chat.path === active ? "current" : chat.id.slice(0, 8),
					value: chat,
				}))}
				selected={(item) => item.value.path === active}
				onPick={(item) => {
					ui.closeModal();
					if (item.value.path !== active) void store.switchChat(item.value.path).catch((err: Error) => store.toast(`switch failed: ${err.message}`, "error"));
				}}
			/>
		</Modal>
	);
}

function ModelsModal() {
	const ui = useUi();
	const models = useStore((select) => select.models);
	const current = useStore((select) => select.session?.model);
	const [filter, setFilter] = useState("");

	useEffect(() => {
		void store.loadModels();
	}, []);

	const rows = models
		.filter((model) => !filter || `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(filter.toLowerCase()))
		.slice(0, 400);

	return (
		<Modal title="model" onClose={ui.closeModal}>
			<input type="text" autoFocus placeholder="filter models" value={filter} onChange={(event) => setFilter(event.target.value)} />
			{!models.length && <div className="dim">loading the model catalog…</div>}
			<OptionList
				items={rows.map((model) => ({ label: model.id, sub: model.name, hint: model.provider, value: model }))}
				selected={(item) => item.value.provider === current?.provider && item.value.id === current?.id}
				onPick={(item) => {
					ui.closeModal();
					void store.setModel(item.value.provider, item.value.id).catch((err: Error) => store.toast(`model switch failed: ${err.message}`, "error"));
				}}
			/>
		</Modal>
	);
}

const FALLBACK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function ThinkingModal() {
	const ui = useUi();
	const levels = useStore((select) => select.levels);
	const current = useStore((select) => select.session?.thinkingLevel);
	const auto = useStore((select) => select.session?.autoCompactionEnabled);
	const [pending, setPending] = useState(false);

	useEffect(() => {
		void store.loadLevels();
	}, []);

	// Older runtimes omit the field: the switch stays hidden rather than lying about the state.
	const known = typeof auto === "boolean";

	const toggleAuto = () => {
		if (!known || pending) return;
		setPending(true);
		void store
			.setAutoCompaction(!auto)
			.catch((err: Error) => store.toast(`auto-compaction failed: ${err.message}`, "error"))
			.finally(() => setPending(false));
	};

	return (
		<Modal title="reasoning" onClose={ui.closeModal}>
			<OptionList
				items={(levels.length ? levels : FALLBACK_LEVELS).map((level) => ({ label: level, value: level }))}
				selected={(item) => item.value === current}
				onPick={(item) => {
					ui.closeModal();
					void store.setThinkingLevel(item.value).catch((err: Error) => store.toast(`thinking level failed: ${err.message}`, "error"));
				}}
			/>
			{known && (
				<button type="button" className="switch-row" role="switch" aria-checked={auto} disabled={pending} onClick={toggleAuto}>
					<span>
						<b>auto-compaction</b>
						<small>summarize older history when the context fills up</small>
					</span>
					<span className={`switch${auto ? " on" : ""}`} aria-hidden="true">
						<i />
					</span>
				</button>
			)}
		</Modal>
	);
}

function CommandsModal() {
	const ui = useUi();
	const commands = useStore((select) => select.commands);
	const [filter, setFilter] = useState("");
	const rows = commands.filter((command) => !filter || `${command.name} ${command.description ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

	return (
		<Modal title="commands" onClose={ui.closeModal}>
			<div className="pre">
				Every command this session advertises ({commands.length}). Interactive-TUI-only built-ins such as /vibe are not dispatched over RPC and are
				not listed here.
			</div>
			<input type="text" autoFocus placeholder="filter commands" value={filter} onChange={(event) => setFilter(event.target.value)} />
			<OptionList
				items={rows.map((command) => ({
					label: `/${command.name}`,
					sub: command.description,
					hint: command.input?.hint ?? (command.subcommands?.length ? `${command.subcommands.length} subcommands` : command.source),
					value: command,
				}))}
				onPick={(item) => {
					store.setDraft(`/${item.value.name} `);
					ui.closeModal();
				}}
			/>
		</Modal>
	);
}

function BtwModal() {
	const ui = useUi();
	const [question, setQuestion] = useState("");
	return (
		<Modal
			title="/btw side question"
			onClose={ui.closeModal}
			footer={
				<button
					type="button"
					className="primary"
					onClick={() => {
						const value = question.trim();
						if (!value) return;
						ui.closeModal();
						void store.btw(value).catch((err: Error) => store.toast(`btw failed: ${err.message}`, "error"));
					}}
				>
					ask
				</button>
			}
		>
			<textarea autoFocus placeholder="ask beside the main turn (not added to history)" value={question} onChange={(event) => setQuestion(event.target.value)} />
		</Modal>
	);
}

function RenameDialog() {
	const ui = useUi();
	const request = ui.rename;
	const active = useStore((select) => select.session?.sessionFile);
	const [name, setName] = useState(request?.name ?? "");
	if (!request) return null;
	const rename = async () => {
		const value = name.trim();
		if (!value) return;
		ui.closeConfirm();
		try {
			await store.renameChat(request.path, value, request.path === active);
			store.toast(`renamed to ${value}`, "info");
		} catch (err) {
			store.toast(`rename failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	};
	return (
		<Modal
			title="rename chat"
			onClose={ui.closeConfirm}
			footer={
				<>
					<button type="button" className="ghost" onClick={ui.closeConfirm}>
						cancel
					</button>
					<button type="button" className="primary" onClick={() => void rename()}>
						save
					</button>
				</>
			}
		>
			<input type="text" autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void rename()} />
			<div className="dim">
				{request.path === active ? "The running session renames itself through the runtime." : "This chat's title header is rewritten in its transcript file."}
			</div>
		</Modal>
	);
}

function DeleteDialog() {
	const ui = useUi();
	const request = ui.remove;
	if (!request) return null;
	return (
		<Modal
			title={`delete “${request.name}”?`}
			onClose={ui.closeConfirm}
			footer={
				<>
					<button type="button" className="ghost" onClick={ui.closeConfirm}>
						cancel
					</button>
					<button
						type="button"
						className="primary"
						onClick={() => {
							ui.closeConfirm();
							void store
								.deleteChat(request.path)
								.then(() => store.toast(`deleted ${request.name}`, "warn"))
								.catch((err: Error) => store.toast(`delete failed: ${err.message}`, "error"));
						}}
					>
						delete
					</button>
				</>
			}
		>
			<div className="pre">{request.path}{"\n\n"}Deletes this chat's transcript file from disk. It cannot be undone.</div>
		</Modal>
	);
}
