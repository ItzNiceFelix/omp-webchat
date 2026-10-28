import { BrainCircuit, FileText, Loader, Mic, Paperclip, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { store } from "../store";
import type { DraftAttachment, SlashCommand } from "../types";
import { useUi } from "../ui";
import { useStore } from "../useStore";
import { ContextMeter } from "./ContextMeter";
import { Modal } from "./Modal";
import { Palette } from "./Palette";
import { PhaseChip } from "./PhaseChip";

const PALETTE_LIMIT = 60;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * The prompt a non-image attachment becomes. The runtime's `prompt` command only accepts image
 * content, so anything else is uploaded to the bridge's data dir and referenced by the
 * `webchat://` host URI the agent's `read` tool can already resolve.
 */
function attachmentBlock(attachments: DraftAttachment[], uris: string[]): string {
	const lines = attachments.map((attachment, index) => `${uris[index]} (${formatBytes(attachment.size)}, ${attachment.mimeType})`);
	return `[attached files — read them with the read tool]\n${lines.join("\n")}`;
}

export function Composer() {
	const draft = useStore((select) => select.draft);
	const attachments = useStore((select) => select.draftAttachments);
	const busy = useStore((select) => select.busy);
	const commands = useStore((select) => select.commands);
	const liveActive = useStore((select) => select.liveActive());
	const queued = useStore((select) => select.queue.steering.length + select.queue.followUp.length);

	const [paletteIndex, setPaletteIndex] = useState(0);
	const [steer, setSteer] = useState(false);
	const [unknown, setUnknown] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const area = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const usage = useStore((select) => select.session?.contextUsage);
	const level = useStore((select) => select.session?.thinkingLevel);
	const autoCompaction = useStore((select) => select.session?.autoCompactionEnabled);
	const ui = useUi();
	const buffer =
		usage?.contextWindow && typeof usage.tokens === "number" ? `${Math.max(0, Math.round((usage.contextWindow - usage.tokens) / 1000))}k` : null;
	// Busy with nothing typed: the one thing left to do is stop. With a draft, send queues it.
	const stopping = busy && !draft.trim() && attachments.length === 0;

	const paletteMatch = /^\/(\S*)$/.exec(draft.trimStart());
	const paletteItems = paletteMatch
		? commands.filter((command) => !paletteMatch[1] || command.name.toLowerCase().includes(paletteMatch[1].toLowerCase())).slice(0, PALETTE_LIMIT)
		: [];

	useEffect(() => {
		setPaletteIndex(0);
	}, [paletteMatch?.[1]]);

	// Autosize: the draft drives the height, capped at 40% of the viewport.
	useEffect(() => {
		const node = area.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${Math.min(node.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
	}, [draft]);

	const pickCommand = (command: SlashCommand) => {
		store.setDraft(`/${command.name} `);
		area.current?.focus();
	};

	const addFiles = (files: FileList | File[]) => {
		const plain: DraftAttachment[] = [];
		for (const file of files) {
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			if (file.type.startsWith("image/")) {
				const reader = new FileReader();
				reader.addEventListener("load", () => {
					const url = String(reader.result);
					store.addDraftAttachments([
						{
							id,
							name: file.name || "image.png",
							size: file.size,
							mimeType: file.type || "image/png",
							image: { type: "image", mimeType: file.type || "image/png", data: url.slice(url.indexOf(",") + 1) },
						},
					]);
				});
				reader.readAsDataURL(file);
				continue;
			}
			plain.push({ id, name: file.name || "file", size: file.size, mimeType: file.type || "application/octet-stream", file });
		}
		if (plain.length) store.addDraftAttachments(plain);
	};

	const send = async (skipCommandCheck = false) => {
		if (sending) return;
		const value = draft.trim();
		const images = attachments.flatMap((attachment) => (attachment.image ? [attachment.image] : []));
		const files = attachments.filter((attachment) => attachment.file);
		if (!value && !images.length && !files.length) return;
		if (!skipCommandCheck) {
			if (!commands.length) await store.loadCommands();
			const match = /^\/([^\s/]+)/.exec(value);
			const name = match?.[1];
			const known = name && store.commands.some((command) => command.name === name || (command.aliases ?? []).includes(name));
			if (name && !known) {
				store.notice(`/${name} is not a command this session advertises — it would be sent to the model as ordinary text`);
				setUnknown(name);
				return;
			}
		}
		setSending(true);
		try {
			const uris: string[] = [];
			for (const attachment of files) uris.push(await store.uploadAttachment(attachment));
			const body = uris.length ? `${attachmentBlock(files, uris)}\n\n${value}`.trim() : value;
			store.clearDraft();
			await store.sendPrompt(body, images, busy ? (steer ? "steer" : "followUp") : undefined);
		} catch (err) {
			store.toast(`attachment failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		} finally {
			setSending(false);
		}
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (paletteItems.length) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setPaletteIndex((index) => Math.min(paletteItems.length - 1, index + 1));
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setPaletteIndex((index) => Math.max(0, index - 1));
				return;
			}
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
				event.preventDefault();
				pickCommand(paletteItems[paletteIndex] ?? paletteItems[0]);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void send();
			return;
		}
		if (event.key === "Escape" && busy) {
			event.preventDefault();
			void store.abort();
		}
	};

	return (
		<div
			className="composer"
			onDragOver={(event) => event.preventDefault()}
			onDrop={(event) => {
				event.preventDefault();
				addFiles(event.dataTransfer.files);
			}}
		>
			<div className="quick">
				<PhaseChip />
				{buffer && (
					<span className="quick-pill buffer" title="Tokens still free in the model's context window">
						buffer · {buffer}
					</span>
				)}
				{/* The header pill is hidden below 1100px, so the composer carries the same entry. */}
				<button type="button" className="quick-pill reasoning" onClick={() => ui.openModal("thinking")} title="Reasoning level and auto-compaction">
					<BrainCircuit size={11} />
					{level ?? "thinking"}
					{autoCompaction === false && <span className="off-tag">no compact</span>}
				</button>
				{/* Queue depth and live voice are appended, never inserted: a pill that appears at
				    the front would push everything after it sideways mid-turn. */}
				{queued > 0 && <span className="quick-pill queue">{queued} queued</span>}
				{liveActive && <span className="quick-pill thinking">live voice</span>}
			</div>
			{attachments.length > 0 && (
				<div className="attachments">
					{attachments.map((attachment) => (
						<div className={`att${attachment.image ? " image" : " file"}`} key={attachment.id}>
							{attachment.image ? (
								<img src={`data:${attachment.image.mimeType};base64,${attachment.image.data}`} alt={attachment.name} />
							) : (
								<span className="att-icon">
									<FileText size={16} />
								</span>
							)}
							<span className="att-meta">
								<b>{attachment.name}</b>
								<span>{formatBytes(attachment.size)}</span>
							</span>
							<button type="button" aria-label={`remove ${attachment.name}`} onClick={() => store.removeDraftAttachment(attachment.id)}>
								<X size={13} />
							</button>
						</div>
					))}
				</div>
			)}
			<div className="composer-box">
				{paletteItems.length > 0 && <Palette items={paletteItems} index={paletteIndex} onPick={pickCommand} />}
				<textarea
					ref={area}
					value={draft}
					placeholder={busy ? "steer or queue a follow-up…" : "message omp…   (/ for commands)"}
					rows={1}
					enterKeyHint="send"
					onChange={(event) => store.setDraft(event.target.value)}
					onKeyDown={onKeyDown}
					onPaste={(event) => {
						const files = [...event.clipboardData.files];
						if (files.length) {
							event.preventDefault();
							addFiles(event.clipboardData.files);
						}
					}}
				/>
				<div className="composer-tools">
					<div>
						<button type="button" className="icon" aria-label="attach files" title="Attach files (any type)" onClick={() => picker.current?.click()}>
							<Paperclip size={17} />
						</button>
						<input ref={picker} className="hidden-file" type="file" multiple onChange={(event) => addFiles(event.target.files ?? [])} />
						<button
							type="button"
							className={`icon${liveActive ? " active" : ""}`}
							aria-label="live voice"
							title="Live voice (mic and speakers on the omp host)"
							onClick={() => void store.toggleLive()}
						>
							<Mic size={17} />
						</button>
						{busy && (
							<label className="steer" title="Send now instead of waiting for the current turn">
								<input type="checkbox" checked={steer} onChange={(event) => setSteer(event.target.checked)} /> steer
							</label>
						)}
					</div>
					<div>
						<ContextMeter />
						{/* One control: stop while a turn runs and the draft is empty, otherwise send
						    (which queues a steer/follow-up on a busy turn). */}
						<button
							type="button"
							className={`send${stopping ? " stop" : ""}`}
							aria-label={stopping ? "stop" : "send"}
							title={stopping ? "Stop (Esc)" : busy ? "Queue for this turn (Enter)" : "Send (Enter)"}
							disabled={sending}
							onClick={() => (stopping ? void store.abort() : void send())}
						>
							{stopping ? <Square size={12} fill="currentColor" strokeWidth={0} /> : sending ? <Loader size={16} className="spin" /> : <Send size={16} />}
						</button>
					</div>
				</div>
			</div>
			<div className="hint">
				{busy ? "omp is working — steer to interrupt, ■ to stop" : "streams per frame · markdown sanitized · attachments: images straight to the model, other files by uri"}
			</div>
			{unknown && (
				<Modal
					title={`/${unknown} is not a command here`}
					onClose={() => setUnknown(null)}
					footer={
						<>
							<button type="button" className="ghost" onClick={() => setUnknown(null)}>
								cancel
							</button>
							<button
								type="button"
								className="primary"
								onClick={() => {
									setUnknown(null);
									void send(true);
								}}
							>
								send as message
							</button>
						</>
					}
				>
					<div className="pre">
						This session advertises {store.commands.length} commands and /{unknown} is not one of them. Some omp built-ins are interactive-TUI
						only (for example /vibe, /theme, /hotkeys); the runtime does not hide them from RPC, so an unknown spelling falls through as ordinary
						prompt text that the model then reads as a message.
					</div>
				</Modal>
			)}
		</div>
	);
}
