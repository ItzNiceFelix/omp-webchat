import { Mic, Paperclip, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { asRecord, asString } from "../frames";
import { store } from "../store";
import type { SlashCommand } from "../types";
import { useStore } from "../useStore";
import { useUi } from "../ui";
import { Modal } from "./Modal";
import { Palette } from "./Palette";

const PALETTE_LIMIT = 60;

/** Composer: autosizing textarea, image attachments, slash palette, steer/queue while busy. */
export function Composer() {
	const draft = useStore((select) => select.draft);
	const images = useStore((select) => select.draftImages);
	const busy = useStore((select) => select.busy);
	const commands = useStore((select) => select.commands);
	const liveActive = useStore((select) => select.liveActive());
	const ui = useUi();

	const [paletteIndex, setPaletteIndex] = useState(0);
	const [steer, setSteer] = useState(false);
	const [unknown, setUnknown] = useState<string | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);

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

	const addFiles = (files: FileList | null) => {
		if (!files) return;
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			const reader = new FileReader();
			reader.addEventListener("load", () => {
				const url = String(reader.result);
				store.addDraftImages([{ type: "image", mimeType: file.type, data: url.slice(url.indexOf(",") + 1) }]);
			});
			reader.readAsDataURL(file);
		}
	};

	const send = async (skipCommandCheck = false) => {
		const value = draft.trim();
		if (!value && !images.length) return;
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
		const payload = images;
		store.clearDraft();
		await store.sendPrompt(value, payload, busy ? (steer ? "steer" : "followUp") : undefined);
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
			{images.length > 0 && (
				<div className="attachments">
					{images.map((image, index) => (
						<div className="att" key={`${image.mimeType}:${index}`}>
							<img src={`data:${image.mimeType};base64,${image.data}`} alt={`attachment ${index + 1}`} />
							<button type="button" aria-label={`remove attachment ${index + 1}`} onClick={() => store.removeDraftImage(index)}>
								×
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
						<button type="button" className="icon sm" aria-label="attach images" title="Attach images" onClick={() => picker.current?.click()}>
							<Paperclip size={16} />
						</button>
						<input ref={picker} className="hidden-file" type="file" accept="image/*" multiple onChange={(event) => addFiles(event.target.files)} />
						<button
							type="button"
							className={`icon sm${liveActive ? " active" : ""}`}
							aria-label="live voice"
							title="Live voice (mic and speakers on the omp host)"
							onClick={() => void store.toggleLive()}
						>
							<Mic size={16} />
						</button>
						<button type="button" className="picker" onClick={() => ui.openModal("models")}>
							{modelLabel(store.session)}
						</button>
						<button type="button" className="picker" onClick={() => ui.openModal("thinking")}>
							{store.session?.thinkingLevel ?? "thinking"}
						</button>
						{busy && (
							<label className="steer" title="Send now instead of after the current turn">
								<input type="checkbox" checked={steer} onChange={(event) => setSteer(event.target.checked)} /> steer
							</label>
						)}
					</div>
					<div>
						{busy ? (
							<>
								<button type="button" className="icon sm" aria-label="stop" title="Stop (Esc)" onClick={() => void store.abort()}>
									<Square size={15} />
								</button>
								<button type="button" className="send" aria-label="queue message" title="Queue message" onClick={() => void send()}>
									<Send size={16} />
								</button>
							</>
						) : (
							<button type="button" className="send" aria-label="send" title="Send (Enter)" onClick={() => void send()}>
								<Send size={16} />
							</button>
						)}
					</div>
				</div>
			</div>
			<div className="hint">
				global steer ({store.session?.isSettled === false ? "session busy" : "session settled"}) · output tokens stream per frame ·{" "}
				{store.commands.length} commands advertised
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

function modelLabel(session: { model?: { provider?: string; id?: string } } | null): string {
	const provider = asString(asRecord(session?.model)?.provider);
	const id = asString(asRecord(session?.model)?.id);
	if (!id) return "model";
	return provider ? `${provider}/${id}` : id;
}
