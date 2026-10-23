/**
 * Single source of truth for the chat client.
 *
 * Ported from the previous vanilla client's frame handling, which is the proven behaviour:
 * same frame routing, same upsert keys, same tool/queue/subagent semantics. React reads it
 * through `useStore`, so every slice is replaced (never mutated in place) when it changes and
 * components can subscribe to exactly one slice.
 *
 * The streaming assistant message lives in its own slot (`streaming`) instead of inside
 * `messages`: a token delta would otherwise allocate a new transcript array on every frame and
 * re-render every message in the list.
 */
import { RpcClient, type ConnStatus } from "./client";
import { derivePhase, PULSE_MS, type Phase } from "./phase-core";
import {
	asAssistantEvent,
	asBtwRecord,
	asChatRows,
	asCommands,
	asContent,
	asMessage,
	asNumber,
	asRecord,
	asString,
	asSubagent,
	asUIRequest,
} from "./frames";
import type {
	BtwRecord,
	ChatRow,
	DraftAttachment,
	ContentBlock,
	Frame,
	ImageContent,
	LiveTurn,
	Message,
	ModelInfo,
	PresentedFile,
	SessionState,
	SlashCommand,
	SubagentRow,
	Toast,
	TodoPhase,
	ToolEntry,
	UIRequest,
} from "./types";

const MESSAGE_PAGE_LIMIT = 256;
const MESSAGE_PAGE_MAX = 40;
const WINDOW_INITIAL = 60;
const WINDOW_STEP = 60;
const AGENT_TAIL_MS = 2500;
const TOOL_PREVIEW_LIMIT = 4000;

const TASK_MARK: Record<string, string> = {
	pending: "•",
	in_progress: "▶",
	completed: "✓",
	abandoned: "✕",
	blocked: "!",
};

export function taskMark(status: string): string {
	return TASK_MARK[status] ?? "?";
}

/** `content` blocks → flat text, matching how the runtime renders a result. */
export function contentText(content: ContentBlock[] | string | undefined): string {
	if (typeof content === "string") return content;
	if (!content) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = asRecord(block);
		if (!record) continue;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
		else if (record.type === "image") parts.push("[image]");
		else if (record.type === "toolResult") parts.push(contentText(asContent(record)));
	}
	return parts.join("\n");
}

export class Store {
	readonly client: RpcClient;

	// ---- reactive slices -------------------------------------------------
	conn: ConnStatus = "connecting";
	cwd = "";
	ompBin = "";
	childStatus = "stopped";

	session: SessionState | null = null;
	commands: SlashCommand[] = [];
	models: ModelInfo[] = [];
	levels: string[] = [];
	queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
	subagents = new Map<string, SubagentRow>();
	widgets = new Map<string, string>();
	statusLine = "";
	busy = false;
	retrying = false;
	/** Set by the compaction frames; `session.isCompacting` lags until the next `get_state`. */
	compacting = false;
	/** Transient turn-end tint (mockup's "done"/"error" ambient), expired by wall clock. */
	pulse: { kind: "done" | "error"; at: number } | null = null;
	/** When the current turn began; a failed tool after this point marks the turn as failed. */
	turnStartedAt = 0;

	messages: Message[] = [];
	streaming: Message | null = null;
	tools = new Map<string, ToolEntry>();
	files: PresentedFile[] = [];

	chats: ChatRow[] = [];
	chatQuery = "";

	uiQueue: UIRequest[] = [];
	toasts: Toast[] = [];
	live = { active: false, phase: "", input: 0, output: 0, turns: new Map<string, LiveTurn>() };
	drawer = { open: false, selected: null as string | null, transcript: "", byte: 0, error: "" };

	/** How many trailing transcript entries the view renders; "load earlier" grows it. */
	windowSize = WINDOW_INITIAL;
	transcriptNote = "";
	/** Rows appended while the reader is scrolled away from the bottom ("N new"). */
	pendingNew = 0;
	/** Bumped when the reader asks to jump to the bottom, so the view can scroll without new rows. */
	bottomNonce = 0;
	/** Bumped when the jump should be animated (pill tap, sending a message) rather than pinned. */
	smoothNonce = 0;
	chatsLoading = false;
	atBottom = true;
	/** Composer draft. Lives here so the runtime (`set_editor_text`) and an abort can fill it. */
	draft = "";
	draftAttachments: DraftAttachment[] = [];
	/** Which sessions the sidebar lists: only this folder's bucket, or every bucket. */
	sessionScope: "folder" | "all" = "all";
	/**
	 * Folded/unfolded chat groups, keyed by the age label the sidebar shows. Only groups the
	 * reader actually touched live here: an absent key means "use the default", which is folded
	 * for every group except the one holding the open session. Keeping it in the store rather
	 * than component state is load-bearing — the sidebar unmounts whenever it is closed under
	 * 1100px, and `loadChats` re-runs on a timer, so local state would spring every group open
	 * again on its own.
	 */
	groupOpen: Record<string, boolean> = {};
	notifyPermission = "default";

	// ---- internals -------------------------------------------------------
	private keys: string[] = [];
	private agentTail: number | undefined;
	private toastSeq = 0;
	private fileSeq = 0;
	private localSeq = 0;
	private notifier = new Notifier();
	private subscribers = new Set<() => void>();
	private version = 0;

	constructor() {
		this.client = new RpcClient({
			onFrame: (frame) => this.onFrame(frame),
			onStatus: (status) => {
				this.conn = status;
				this.emit();
			},
			onHello: (frame) => this.onHello(frame),
			onLost: (reason) => this.notice(`${reason} — reconnecting…`),
		});
		this.notifyPermission = this.notifier.permission;
	}

	// ---- React glue ------------------------------------------------------

	subscribe = (listener: () => void) => {
		this.subscribers.add(listener);
		return () => {
			this.subscribers.delete(listener);
		};
	};

	getSnapshot = () => this.version;

	emit() {
		this.version++;
		for (const listener of this.subscribers) listener();
	}

	start() {
		this.client.connect();
	}

	// ---- frame routing ---------------------------------------------------

	private onHello(frame: Frame) {
		this.cwd = asString(frame.cwd) ?? "";
		this.ompBin = asString(frame.omp) ?? "";
		this.childStatus = asString(frame.child) ?? "stopped";
		this.conn = this.childStatus === "running" ? "running" : "starting";
		this.emit();
		void this.bootstrap();
	}

	private onFrame(frame: Frame) {
		const type = asString(frame.type) ?? "";
		if (type.startsWith("wx:")) this.onBridgeFrame(frame, type);
		else this.onRuntimeFrame(frame, type);
	}

	private onBridgeFrame(frame: Frame, type: string) {
		switch (type) {
			case "wx:child":
				this.childStatus = asString(frame.status) ?? "stopped";
				this.conn = this.childStatus === "running" ? "running" : this.childStatus === "starting" ? "starting" : "exited";
				if (this.childStatus === "exited") this.notice(`omp process exited (code ${asNumber(frame.code) ?? "?"})`, "error");
				this.emit();
				return;
			case "wx:card":
				this.appendRow({
					role: "assistant",
					local: "card",
					toolName: asString(frame.title) ?? "card",
					content: [{ type: "text", text: asString(frame.body) ?? "" }],
					timestamp: Date.now(),
				});
				return;
			case "wx:log":
				if (frame.level === "stderr") this.notice(asString(frame.text) ?? "");
				else this.toast(asString(frame.text) ?? "", "warn");
				return;
			case "wx:copy": {
				const text = asString(frame.text) ?? "";
				void this.copy(text);
				return;
			}
			case "wx:file": {
				const file: PresentedFile = {
					id: `f${++this.fileSeq}`,
					name: asString(frame.name) ?? "file",
					mimeType: asString(frame.mimeType) ?? "application/octet-stream",
					bytes: asNumber(frame.bytes) ?? 0,
					data: asString(frame.data) ?? "",
				};
				this.files = [file, ...this.files].slice(0, 20);
				this.emit();
				this.toast(`file ready: ${file.name}`, "info");
				return;
			}
			default:
				return;
		}
	}

	private onRuntimeFrame(frame: Frame, type: string) {
		switch (type) {
			case "available_commands_update":
				this.commands = asCommands(frame.commands);
				this.emit();
				return;
			case "agent_start":
				this.busy = true;
				this.pulse = null;
				this.turnStartedAt = Date.now();
				this.emit();
				return;
			case "agent_end": {
				this.busy = false;
				if (frame.yielded === false) this.notice("agent yielded for retry/compaction — continuing");
				else this.settlePulse(false);
				void this.refreshState();
				void this.loadChats();
				const expected = asNumber(frame.messageCount) ?? 0;
				if (expected > this.messages.length + (this.streaming ? 1 : 0)) void this.refreshTranscript("merge");
				const last = this.lastAssistantText();
				if (last && frame.yielded !== false) this.notifier.ping("done", "omp finished", last.slice(0, 160));
				this.emit();
				return;
			}
			case "session_settled":
			case "turn_end":
				this.busy = false;
				this.settlePulse(false);
				this.emit();
				void this.refreshState();
				return;
			case "message_start":
				this.onMessageStart(frame);
				return;
			case "message_update":
				this.onMessageUpdate(frame);
				return;
			case "message_end":
				this.onMessageEnd(frame);
				return;
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
				this.onToolEvent(frame, type);
				return;
			case "queue_update":
				this.queue = { steering: asStringArray(frame.steering), followUp: asStringArray(frame.followUp) };
				this.emit();
				return;
			case "todo_reminder":
			case "todo_auto_clear":
			case "goal_updated":
			case "session_info_update":
			case "config_update":
			case "model_changed":
			case "thinking_level_changed":
				void this.refreshState();
				return;
			case "notice":
				this.notice(`[${asString(frame.source) ?? "notice"}] ${asString(frame.message) ?? ""}`, frame.level === "error" ? "error" : undefined);
				return;
			case "command_output":
				this.notice(asString(frame.text) ?? asString(frame.output) ?? asString(frame.message) ?? JSON.stringify(frame));
				return;
			case "extension_error":
				this.notice(`extension error (${asString(frame.extensionPath) ?? "?"}): ${asString(frame.error) ?? ""}`, "error");
				return;
			case "rpc_frame_error":
				this.notice(`frame too large: ${asString(frame.message) ?? JSON.stringify(frame)}`, "error");
				return;
			case "auto_compaction_start":
				// `isCompacting` only arrives on the next `get_state`, which is after the work
				// is done; the frame itself is the only signal while it runs.
				this.compacting = true;
				this.notice("auto-compaction started…");
				this.emit();
				return;
			case "auto_compaction_end":
				this.compacting = false;
				this.notice("auto-compaction finished");
				this.emit();
				void this.refreshState();
				return;
			case "auto_retry_start":
				this.retrying = true;
				this.notice(`retrying (attempt ${asNumber(frame.attempt) ?? "?"}): ${asString(frame.errorMessage) ?? ""}`);
				return;
			case "auto_retry_end":
				this.retrying = false;
				this.emit();
				return;
			case "retry_fallback_applied":
			case "retry_fallback_succeeded":
				this.notice(`${type} ${JSON.stringify({ from: frame.from, to: frame.to, model: frame.model })}`);
				return;
			case "prompt_result": {
				this.busy = false;
				this.settlePulse(frame.status === "error");
				void this.refreshState();
				if (frame.status === "error") {
					const message = asString(asRecord(frame.error)?.message) ?? "unknown error";
					this.notice(`turn failed: ${message}`, "error");
					this.notifier.ping("error", "omp turn failed", message);
				}
				this.emit();
				return;
			}
			case "irc_message":
				this.notice(`[irc] ${asString(frame.text) ?? JSON.stringify(frame)}`);
				return;
			case "subagent_lifecycle":
			case "subagent_progress": {
				const payload = asRecord(frame.payload);
				this.onSubagent(asSubagent(payload?.progress ?? frame.payload));
				return;
			}
			case "btw_record":
				this.onBtwRecord(asBtwRecord(frame.record));
				return;
			case "btw_delta":
				this.onBtwDelta(frame);
				return;
			case "extension_ui_request": {
				const request = asUIRequest(frame);
				if (request) this.onUIRequest(request);
				return;
			}
			case "live_phase":
			case "live_levels":
			case "live_transcript":
			case "live_end":
				this.onLiveFrame(frame, type);
				return;
			default:
				return;
		}
	}

	// ---- transcript ------------------------------------------------------

	private messageKey(frame: Frame, message: Message): string {
		return asString(frame.messageId) ?? message.toolCallId ?? `${message.role}:${message.timestamp ?? ""}`;
	}

	private appendRow(message: Message) {
		message = { ...message, localId: message.localId ?? `l${++this.localSeq}` };
		this.messages = [...this.messages, message];
		this.keys.push(`local:${this.messages.length}`);
		this.countIfAway();
		this.emit();
	}

	/** "N new" counts rows the reader has not seen because they scrolled away. */
	private countIfAway() {
		if (!this.atBottom) this.pendingNew++;
	}

	private replaceMessage(index: number, message: Message) {
		const next = this.messages.slice();
		next[index] = message;
		this.messages = next;
	}

	private upsertMessage(key: string, message: Message): boolean {
		const index = this.keys.indexOf(key);
		if (index >= 0) {
			this.replaceMessage(index, message);
			return false;
		}
		this.keys.push(key);
		this.messages = [...this.messages, message];
		this.countIfAway();
		return true;
	}

	/** The runtime echoes the prompt back as a user message: drop our optimistic copy. */
	private dropOptimistic(text: string) {
		const index = this.messages.findIndex((message) => message.optimistic && contentText(message.content) === text);
		if (index < 0) return;
		const next = this.messages.slice();
		next.splice(index, 1);
		this.keys.splice(index, 1);
		this.messages = next;
	}

	private onMessageStart(frame: Frame) {
		const message = asMessage(frame.message);
		if (!message) return;
		if (message.role === "assistant") {
			this.streaming = message;
			if (!this.atBottom) this.pendingNew++;
			this.emit();
			return;
		}
		if (message.role === "user") this.dropOptimistic(contentText(message.content));
		this.upsertMessage(this.messageKey(frame, message), message);
		if (message.role === "toolResult") this.applyToolResult(message);
		this.emit();
	}

	private onMessageUpdate(frame: Frame) {
		const ev = asAssistantEvent(frame.assistantMessageEvent);
		if (!ev) return;
		const partial = ev.partial ?? ev.message;
		const partialContent = Array.isArray(partial?.content) ? partial.content : undefined;
		const block = partialContent?.[ev.contentIndex] ?? ev.toolCall;
		if (!block) return;
		const base: Message = this.streaming ?? { role: "assistant", content: [], timestamp: Date.now() };
		const content = partialContent ? [...partialContent] : [...(Array.isArray(base.content) ? base.content : [])];
		// A `message_update` carries either a whole partial message (preferred) or just the
		// block that changed; both land in the same slot so the row renders once per frame.
		content[ev.contentIndex] = partialContent ? block : mergeBlock(content[ev.contentIndex], block);
		this.streaming = { ...base, ...(partial ?? {}), content, timestamp: partial?.timestamp ?? base.timestamp };
		this.emit();
	}

	private onMessageEnd(frame: Frame) {
		const message = asMessage(frame.message);
		if (!message) return;
		if (message.role !== "assistant") {
			if (message.role === "user") this.dropOptimistic(contentText(message.content));
			this.upsertMessage(this.messageKey(frame, message), message);
			if (message.role === "toolResult") this.applyToolResult(message);
			this.emit();
			return;
		}
		this.streaming = null;
		this.upsertMessage(this.messageKey(frame, message), message);
		this.emit();
	}

	private onToolEvent(frame: Frame, type: string) {
		const id = asString(frame.toolCallId);
		if (!id) return;
		const previous = this.tools.get(id);
		const entry: ToolEntry = previous ? { ...previous } : { id, name: "tool", status: "running", start: Date.now() };
		if (type === "tool_execution_start") {
			entry.status = "running";
			entry.name = asString(frame.toolName) ?? entry.name;
			entry.intent = asString(frame.intent);
			entry.args = frame.args;
			entry.start = Date.now();
			entry.end = undefined;
			entry.output = undefined;
			entry.preview = undefined;
		} else if (type === "tool_execution_update") {
			const preview = contentText(asContent(frame.partialResult));
			if (preview) entry.preview = clamp(preview);
		} else {
			entry.status = frame.isError ? "error" : "ok";
			entry.isError = frame.isError === true;
			entry.end = Date.now();
			const result = contentText(asContent(frame.result));
			entry.output = result || entry.preview;
		}
		this.tools = new Map(this.tools).set(id, entry);
		this.emit();
	}

	private applyToolResult(message: Message) {
		const id = message.toolCallId;
		if (!id) return;
		const previous = this.tools.get(id);
		const entry: ToolEntry = previous ? { ...previous } : { id, name: message.toolName ?? "tool", status: "running", start: Date.now() };
		entry.status = message.isError ? "error" : "ok";
		entry.isError = Boolean(message.isError);
		entry.end ??= Date.now();
		entry.name = message.toolName ?? entry.name;
		const text = contentText(message.content);
		if (text) entry.output = text;
		this.tools = new Map(this.tools).set(id, entry);
	}

	lastAssistantText(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "assistant") continue;
			const text = contentText(message.content).replace(/\s+/g, " ").trim();
			if (text) return text;
		}
		return "";
	}

	getTool(id: string | undefined): ToolEntry | undefined {
		return id ? this.tools.get(id) : undefined;
	}

	// ---- turn phase ------------------------------------------------------
	//
	// One derived primitive for every "what is omp doing" surface: the phase chip, the root
	// `data-phase` attribute and the ambient tint. Everything is read from frames the store
	// already handles, so no server change is involved.

	private runningCache: { map: Map<string, ToolEntry>; first: ToolEntry | null } | null = null;

	/** First running tool, cached on Map identity (the Map is replaced on every write). */
	runningTool(): ToolEntry | null {
		if (this.runningCache?.map !== this.tools) {
			let first: ToolEntry | null = null;
			for (const entry of this.tools.values()) {
				if (entry.status === "running") {
					first = entry;
					break;
				}
			}
			this.runningCache = { map: this.tools, first };
		}
		return this.runningCache.first;
	}

	phase(): Phase {
		const blocks = Array.isArray(this.streaming?.content) ? this.streaming.content : [];
		const last = blocks[blocks.length - 1];
		const lastType = last?.type;
		// `toolCall` is the only block carrying an id, but `ContentBlock` is an open union, so
		// narrow rather than assert: a custom block type must not be trusted for a field read.
		const lastId = lastType === "toolCall" && "id" in last && typeof last.id === "string" ? last.id : undefined;
		return derivePhase({
			retrying: this.retrying,
			compacting: this.compacting || Boolean(this.session?.isCompacting),
			toolRunning: this.runningTool() !== null,
			// A call the tools map has no entry for yet (awaiting start or approval) is still
			// the tool phase: the model has handed off and nothing else is happening.
			toolPending: lastId !== undefined && !this.tools.has(lastId),
			lastBlock: lastType,
			busy: this.busy,
			pulse: this.pulse,
			now: Date.now(),
		});
	}

	/** Wall-clock start of the current phase, for the elapsed counter; null when untimed. */
	phaseSince(): number | null {
		if (this.retrying || this.compacting || this.session?.isCompacting) return null;
		const tool = this.runningTool();
		if (tool) return tool.start;
		if (this.busy) return this.streaming?.timestamp ?? null;
		// Only a live pulse is timed: a stale stamp would keep counting after the tint faded.
		return this.pulse && Date.now() - this.pulse.at < PULSE_MS ? this.pulse.at : null;
	}

	/** Stamp the turn-end pulse; the phase chip re-renders it away after PULSE_MS. */
	settlePulse(failed: boolean) {
		// A turn that ended right after a failed tool is an error, not a success: the runtime
		// reports `agent_end` without a status.
		const toolFailed = [...this.tools.values()].some((entry) => entry.status === "error" && (entry.end ?? 0) >= this.turnStartedAt);
		const kind = failed || toolFailed ? "error" : "done";
		// `prompt_result` and `turn_end` both arrive for one turn: a later "done" must not
		// overwrite an error already stamped for that turn.
		if (kind === "done" && this.pulse?.kind === "error" && this.pulse.at >= this.turnStartedAt) return;
		this.pulse = { kind, at: Date.now() };
	}

	/** Oldest transcript index the view renders (cheap client-side windowing). */
	visibleStart(): number {
		return Math.max(0, this.messages.length - this.windowSize);
	}

	showEarlier() {
		this.windowSize += WINDOW_STEP;
		this.emit();
	}

	markRead() {
		this.pendingNew = 0;
		this.atBottom = true;
		this.bottomNonce++;
		this.smoothNonce++;
		this.emit();
	}

	setAtBottom(value: boolean) {
		if (this.atBottom === value) return;
		this.atBottom = value;
		if (value) this.pendingNew = 0;
		this.emit();
	}

	// ---- data refresh ----------------------------------------------------

	async bootstrap() {
		await Promise.all([this.refreshState(), this.refreshTranscript(), this.loadChats(), this.loadCommands(), this.refreshSubagents()]);
	}

	async refreshState() {
		try {
			const data = await this.client.must<SessionState & { queuedMessages?: { steering: string[]; followUp: string[] } }>({
				type: "get_state",
			});
			this.session = data;
			if (data.queuedMessages) this.queue = data.queuedMessages;
			// The runtime keeps `isStreaming` true while a tool it is awaiting (a subagent
			// `wait`, for example) still runs, so that — plus an unsettled session — is what
			// the progress indicator must follow, not the last message frame we saw.
			this.busy = Boolean(data.isStreaming) || data.isSettled === false;
			this.emit();
		} catch (err) {
			this.toast(`state unavailable: ${messageOf(err)}`, "warn");
		}
	}

	async loadCommands() {
		try {
			const data = await this.client.must<{ commands?: unknown }>({ type: "get_available_commands" });
			if (data.commands) this.commands = asCommands(data.commands);
			this.emit();
		} catch {
			// older runtimes only push `available_commands_update`
		}
	}

	async loadModels() {
		if (this.models.length) return;
		try {
			const data = await this.client.must<{ models?: unknown }>({ type: "get_available_models" }, 180_000);
			this.models = Array.isArray(data.models)
				? data.models.flatMap((item) => {
						const record = asRecord(item);
						const id = asString(record?.id);
						const provider = asString(record?.provider);
						return id && provider ? [{ id, provider, name: asString(record?.name) }] : [];
					})
				: [];
			this.emit();
		} catch (err) {
			this.toast(`models unavailable: ${messageOf(err)}`, "warn");
		}
	}

	async loadLevels() {
		try {
			const data = await this.client.must<{ levels?: unknown }>({ type: "get_available_thinking_levels" });
			this.levels = asStringArray(data.levels);
			this.emit();
		} catch {
			this.levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			this.emit();
		}
	}

	/**
	 * Full transcript, paged when the runtime supports it (a 2 000-message session does not
	 * fit in one frame) and falling back to the monolithic snapshot when paging is refused
	 * mid-stream. `windowSize` controls what is rendered, not what is kept.
	 *
	 * `replace` is for a session change, where the snapshot is authoritative. `merge` is for a
	 * mid-session refresh: a snapshot that carries fewer rows than what is already rendered is
	 * merged by key instead of replacing, so a partial paging answer can never empty the view.
	 */
	async refreshTranscript(mode: "replace" | "merge" = "replace") {
		const collected: Message[] = [];
		const keys: string[] = [];
		let cursor: string | undefined;
		let paged = true;
		for (let page = 0; page < MESSAGE_PAGE_MAX; page++) {
			let data: { messages?: unknown; nextCursor?: unknown };
			try {
				data = await this.client.must<{ messages?: unknown; nextCursor?: unknown }>(
					{ type: "get_messages_page", limit: MESSAGE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
					60_000,
				);
			} catch (err) {
				paged = false;
				if (collected.length) this.toast(`transcript truncated: ${messageOf(err)}`, "warn");
				break;
			}
			for (const message of asMessageList(data.messages)) {
				keys.push(`${message.role}:${message.timestamp ?? ""}:${message.toolCallId ?? ""}`);
				collected.push(message);
			}
			cursor = asString(data.nextCursor);
			if (!cursor) break;
			if (page === MESSAGE_PAGE_MAX - 1) paged = false;
		}
		if (!paged) {
			try {
				const data = await this.client.must<{ messages?: unknown }>({ type: "get_messages" }, 180_000);
				const snapshot = asMessageList(data.messages);
				const snapshotKeys = snapshot.map((message) => `${message.role}:${message.timestamp ?? ""}:${message.toolCallId ?? ""}`);
				if (mode === "merge" && snapshot.length < this.messages.length) {
					const at = new Map(this.keys.map((key, index) => [key, index] as const));
					const merged = this.messages.slice();
					const mergedKeys = this.keys.slice();
					snapshot.forEach((message, index) => {
						const existing = at.get(snapshotKeys[index]);
						if (existing === undefined) {
							mergedKeys.push(snapshotKeys[index]);
							merged.push(message);
							return;
						}
						merged[existing] = message;
					});
					this.messages = merged;
					this.keys = mergedKeys;
				} else {
					this.messages = snapshot;
					this.keys = snapshotKeys;
				}
				this.transcriptNote = "loaded as one snapshot (paging is unavailable while the session is busy)";
			} catch (err) {
				this.transcriptNote = `transcript unavailable: ${messageOf(err)}`;
				this.emit();
				return;
			}
		} else {
			if (mode === "replace" || collected.length >= this.messages.length) {
				this.keys = keys;
				this.messages = collected;
			} else {
				// keep what the reader already has, refresh the rows the snapshot repeats
				const at = new Map(this.keys.map((key, index) => [key, index] as const));
				const merged = this.messages.slice();
				const mergedKeys = this.keys.slice();
				collected.forEach((message, index) => {
					const key = keys[index];
					const existing = at.get(key);
					if (existing === undefined) {
						mergedKeys.push(key);
						merged.push(message);
						return;
					}
					merged[existing] = message;
				});
				this.messages = merged;
				this.keys = mergedKeys;
			}
			this.transcriptNote = "";
		}
		this.streaming = null;
		// A merge refresh keeps live tool entries (a call may still be running) and the reader's
		// unread counter; a full replace rebuilds from the snapshot.
		if (mode === "replace") {
			this.tools = new Map();
			this.pendingNew = 0;
		}
		for (const message of this.messages) if (message.role === "toolResult") this.applyToolResult(message);
		this.emit();
	}

	async loadChats() {
		this.chatsLoading = true;
		this.emit();
		try {
			const query = this.sessionScope === "all" ? "?scope=all&limit=200" : "?limit=100";
			const response = await fetch(`/api/sessions${query}`, { cache: "no-store" });
			this.chats = asChatRows(await response.json());
			this.emit();
		} catch (err) {
			this.toast(`chat list failed: ${messageOf(err)}`, "warn");
		} finally {
			this.chatsLoading = false;
			this.emit();
		}
	}

	async refreshSubagents() {
		try {
			const data = await this.client.must<{ subagents?: unknown }>({ type: "get_subagents" });
			const next = new Map<string, SubagentRow>();
			if (Array.isArray(data.subagents)) {
				for (const item of data.subagents) {
					const row = asSubagent(item);
					if (row) next.set(row.id, row);
				}
			}
			this.subagents = next;
			this.emit();
		} catch {
			// runtimes without subagent support: leave the list empty
		}
	}

	// ---- actions ---------------------------------------------------------

	async sendPrompt(text: string, images: ImageContent[], behavior?: "steer" | "followUp") {
		const command: Frame & { type: string } = { type: "prompt", message: text };
		if (images.length) command.images = images;
		if (behavior) command.streamingBehavior = behavior;
		if (!behavior && text) {
			this.appendRow({ role: "user", optimistic: true, content: [{ type: "text", text }], timestamp: Date.now() });
			this.atBottom = true;
			this.smoothNonce++;
			this.emit();
		}
		try {
			let frame = await this.client.cmd(command);
			if (frame.success === false && /already processing/i.test(String(frame.error))) {
				// admission raced a stale busy flag: queue explicitly instead of failing
				frame = await this.client.cmd({ ...command, streamingBehavior: behavior ?? "followUp" });
			}
			if (frame.success === false) this.toast(`prompt rejected: ${String(frame.error)}`, "error");
		} catch (err) {
			this.toast(`prompt failed: ${messageOf(err)}`, "error");
		}
	}

	async abort(): Promise<{ text: string; images?: ImageContent[] }[]> {
		try {
			if (this.retrying) await this.client.cmd({ type: "abort_retry" }).catch(() => undefined);
			const data = await this.client.must<{ steering?: { text: string; images?: ImageContent[] }[]; followUp?: { text: string; images?: ImageContent[] }[] }>({
				type: "abort_and_restore_queue",
			});
			const restored = [...(data.steering ?? []), ...(data.followUp ?? [])];
			if (restored.length) {
				this.draft = restored.map((message) => message.text).join("\n");
				this.addDraftAttachments(
					restored.flatMap((message) =>
						(message.images ?? []).map((image, index) => ({
							id: `restored-${Date.now()}-${index}`,
							name: `restored-${index + 1}.png`,
							size: Math.round((image.data.length * 3) / 4),
							mimeType: image.mimeType,
							image,
						})),
					),
				);
			}
			this.toast(restored.length ? `aborted, restored ${restored.length} queued message(s)` : "aborted", "warn");
			return restored;
		} catch (err) {
			this.toast(`abort failed: ${messageOf(err)}`, "error");
			return [];
		}
	}

	async newChat() {
		await this.client.must({ type: "new_session" });
		this.compacting = false;
		this.pulse = null;
		await this.bootstrap();
	}

	async switchChat(path: string) {
		await this.client.must({ type: "switch_session", sessionPath: path });
		// A compaction frame belongs to the session that sent it; the new one starts clean.
		this.compacting = false;
		this.pulse = null;
		await this.bootstrap();
		this.toast("chat resumed — the runtime replays its context", "info");
	}

	/**
	 * Renames one chat. The running session is renamed through the runtime (which owns its
	 * header); any other session file is renamed by the bridge, which rewrites the title
	 * header in place, keeping the file's byte layout intact.
	 */
	async renameChat(path: string, name: string, active: boolean) {
		if (active) {
			await this.client.must({ type: "set_session_name", name });
		} else {
			const response = await fetch(`/api/sessions?path=${encodeURIComponent(path)}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name }),
			});
			const data = asRecord(await response.json());
			if (data?.ok !== true) throw new Error(asString(data?.error) ?? "rename failed");
		}
		await Promise.all([this.refreshState(), this.loadChats()]);
	}

	async deleteChat(path: string) {
		const response = await fetch(`/api/sessions?path=${encodeURIComponent(path)}`, { method: "DELETE" });
		const data = asRecord(await response.json());
		if (data?.ok !== true) throw new Error(asString(data?.error) ?? "delete failed");
		await this.loadChats();
	}

	async setModel(provider: string, modelId: string) {
		await this.client.must({ type: "set_model", provider, modelId }, 180_000);
		await this.refreshState();
	}

	async setThinkingLevel(level: string) {
		await this.client.must({ type: "set_thinking_level", level });
		await this.refreshState();
	}

	/** `set_auto_compaction` is session-scoped: nothing is written to config.yml. */
	async setAutoCompaction(enabled: boolean) {
		await this.client.must({ type: "set_auto_compaction", enabled });
		await this.refreshState();
	}

	async btw(question: string) {
		await this.client.must({ type: "btw", question });
	}

	async promoteQueued(text: string) {
		try {
			await this.client.must({ type: "promote_queued_message", message: text });
		} catch (err) {
			this.toast(messageOf(err), "error");
		}
	}

	/** Removes a queued message; any attachments come back so the composer can restore them. */
	async removeQueued(text: string, queue: "steering" | "followUp"): Promise<ImageContent[]> {
		try {
			const data = await this.client.must<{ images?: ImageContent[] }>({ type: "remove_queued_message", message: text, queue });
			return data.images ?? [];
		} catch (err) {
			this.toast(messageOf(err), "error");
			return [];
		}
	}

	async setTodos(phases: TodoPhase[]) {
		await this.client.must({ type: "set_todos", phases });
	}

	async copy(text: string) {
		const ok = await copyText(text);
		this.toast(ok ? `copied ${text.length} characters to your clipboard` : "the browser blocked the clipboard write", ok ? "info" : "warn");
	}

	async requestNotifications(): Promise<string> {
		this.notifyPermission = await this.notifier.enable();
		this.emit();
		return this.notifyPermission;
	}

	setSound(sound: boolean) {
		this.notifier.sound = sound;
	}

	// ---- subagents -------------------------------------------------------

	private onSubagent(row: SubagentRow | undefined) {
		if (!row?.id) return;
		const previous = this.subagents.get(row.id) ?? { id: row.id };
		this.subagents = new Map(this.subagents).set(row.id, { ...previous, ...row });
		this.emit();
	}

	/** Tails a subagent transcript from the runtime's byte cursor; safe to call repeatedly. */
	async pullAgentTranscript(subagentId: string) {
		try {
			const data = await this.client.must<{ messages?: unknown; nextByte?: unknown; reset?: unknown }>(
				{ type: "get_subagent_messages", subagentId, fromByte: this.drawer.byte },
				60_000,
			);
			const reset = data.reset === true;
			const chunk = asMessageList(data.messages).map(formatAgentMessage).join("\n\n");
			const nextByte = asNumber(data.nextByte);
			this.drawer = {
				...this.drawer,
				transcript: reset ? chunk : chunk ? `${this.drawer.transcript}${chunk}\n\n` : this.drawer.transcript,
				byte: reset ? (nextByte ?? 0) : (nextByte ?? this.drawer.byte),
				error: "",
			};
		} catch (err) {
			this.drawer = { ...this.drawer, error: `transcript unavailable: ${messageOf(err)}` };
		}
		this.emit();
	}

	openAgentTranscript(row: SubagentRow) {
		this.drawer = { open: true, selected: row.id, transcript: "", byte: 0, error: "" };
		this.emit();
		void this.pullAgentTranscript(row.id);
		clearInterval(this.agentTail);
		this.agentTail = setInterval(() => {
			if (!this.drawer.open || !this.drawer.selected || document.hidden) return;
			void this.pullAgentTranscript(this.drawer.selected);
		}, AGENT_TAIL_MS);
	}

	closeAgentTranscript() {
		clearInterval(this.agentTail);
		this.agentTail = undefined;
		this.drawer = { ...this.drawer, open: false, selected: null };
		this.emit();
	}

	async steerSubagent(id: string, message: string) {
		await this.client.must({ type: "steer_subagent", subagentId: id, message });
		await this.refreshSubagents();
	}

	async cancelSubagent(id: string) {
		await this.client.must({ type: "cancel_subagent", subagentId: id });
		await this.refreshSubagents();
	}

	// ---- live voice ------------------------------------------------------

	private onLiveFrame(frame: Frame, type: string) {
		const live = { ...this.live, turns: new Map(this.live.turns) };
		if (type === "live_phase") {
			live.phase = asString(frame.phase) ?? "";
			if (frame.phase === "error") this.toast("live session error", "error");
		} else if (type === "live_levels") {
			live.input = asNumber(frame.input) ?? 0;
			live.output = asNumber(frame.output) ?? 0;
		} else if (type === "live_transcript") {
			live.turns.set(`${asString(frame.role) ?? "?"}:${asNumber(frame.turn) ?? 0}`, {
				role: asString(frame.role) ?? "?",
				turn: asNumber(frame.turn),
				text: asString(frame.text),
				final: frame.final === true,
			});
		} else {
			live.active = false;
			live.phase = "ended";
			live.input = 0;
			live.output = 0;
			const error = asString(frame.error);
			if (error) this.toast(`live ended: ${error}`, "error");
		}
		this.live = live;
		this.emit();
	}

	liveActive(): boolean {
		return this.live.active || this.live.phase === "listening" || this.live.phase === "working" || this.live.phase === "speaking";
	}

	async toggleLive() {
		if (this.liveActive()) {
			this.live = { ...this.live, active: false };
			this.emit();
			try {
				await this.client.cmd({ type: "live_stop" }, 30_000);
			} catch (err) {
				this.toast(`live stop failed: ${messageOf(err)}`, "error");
			}
			return;
		}
		this.live = { active: true, phase: "connecting", input: 0, output: 0, turns: new Map() };
		this.emit();
		try {
			const frame = await this.client.cmd({ type: "live_start" }, 180_000);
			if (frame.success === false) throw new Error(String(frame.error ?? "live_start failed"));
			const voice = asString(asRecord(frame.data)?.voice) ?? "default";
			this.toast(`live session started (voice ${voice}); audio runs on the omp host`, "info");
		} catch (err) {
			this.live = { ...this.live, active: false, phase: "" };
			this.emit();
			this.toast(`live start failed: ${messageOf(err)}`, "error");
		}
	}

	async muteLive() {
		try {
			await this.client.must({ type: "live_mute" });
		} catch (err) {
			this.toast(`live mute failed: ${messageOf(err)}`, "error");
		}
	}

	// ---- btw -------------------------------------------------------------

	private onBtwRecord(record: BtwRecord | undefined) {
		if (!record?.id) return;
		const answer = record.followUps?.length ? record.followUps[record.followUps.length - 1] : record;
		const row: Message = {
			role: "assistant",
			local: "btw",
			toolCallId: record.id,
			toolName: `status: ${answer?.status ?? record.status ?? "?"}`,
			content: [{ type: "text", text: `${record.question ?? ""}\n${answer?.answer ?? ""}`.trim() }],
			timestamp: Date.now(),
		};
		const index = this.messages.findIndex((message) => message.local === "btw" && message.toolCallId === record.id);
		if (index >= 0) this.replaceMessage(index, row);
		else this.appendRow(row);
	}

	private onBtwDelta(frame: Frame) {
		const id = asString(frame.recordId) ?? "";
		const index = this.messages.findIndex((message) => message.local === "btw" && message.toolCallId === id);
		if (index < 0) return;
		const current = this.messages[index];
		const text = `${contentText(current.content)}${asString(frame.delta) ?? ""}`;
		this.replaceMessage(index, { ...current, content: [{ type: "text", text }] });
		this.emit();
	}

	// ---- extension UI ----------------------------------------------------

	private onUIRequest(request: UIRequest) {
		switch (request.method) {
			case "notify":
				this.toast(request.message ?? "", request.level === "error" ? "error" : request.level === "warning" ? "warn" : "info");
				return;
			case "setStatus":
				this.statusLine = request.status ?? "";
				this.emit();
				return;
			case "setWidget":
				this.widgets = new Map(this.widgets).set(request.widgetKey ?? "widget", request.text ?? (request.lines ?? []).join("\n"));
				this.emit();
				return;
			case "setTitle":
				document.title = request.title ?? "omp webchat";
				return;
			case "set_editor_text":
				this.draft = request.text ?? "";
				this.emit();
				return;
			case "open_url":
				this.toast(request.instructions ?? "open this URL", "info", request.launchUrl ?? request.url);
				return;
			case "cancel":
				this.uiQueue = this.uiQueue.filter((pending) => pending.id !== request.targetId);
				this.emit();
				return;
			default:
				this.uiQueue = [...this.uiQueue, request];
				this.emit();
				this.notifier.ping("ask", "omp needs your answer", `${request.method}: ${request.title ?? request.message ?? ""}`.slice(0, 160));
		}
	}

	/** Answers the head of the UI queue and presents the next request. */
	respondUI(response: Frame) {
		const head = this.uiQueue[0];
		this.client.send({ type: "extension_ui_response", id: head?.id, ...response });
		this.uiQueue = this.uiQueue.slice(1);
		this.emit();
	}

	setChatQuery(query: string) {
		this.chatQuery = query;
		this.emit();
	}

	setDraft(text: string) {
		if (this.draft === text) return;
		this.draft = text;
		this.emit();
	}

	addDraftAttachments(attachments: DraftAttachment[]) {
		if (!attachments.length) return;
		this.draftAttachments = [...this.draftAttachments, ...attachments];
		this.emit();
	}

	removeDraftAttachment(id: string) {
		this.draftAttachments = this.draftAttachments.filter((attachment) => attachment.id !== id);
		this.emit();
	}

	clearDraft() {
		this.draft = "";
		this.draftAttachments = [];
		this.emit();
	}

	setSessionScope(scope: "folder" | "all") {
		if (this.sessionScope === scope) return;
		this.sessionScope = scope;
		this.emit();
		void this.loadChats();
	}

	/** Fold or unfold one chat group. The label is the one the sidebar prints (`today`, …). */
	toggleGroup(label: string, open: boolean) {
		this.groupOpen = { ...this.groupOpen, [label]: open };
		this.emit();
	}

	/**
	 * Uploads one attachment and returns its `webchat://` URI. The bridge stores it under the
	 * plugin data dir, which is exactly what the registered host URI scheme reads back.
	 */
	async uploadAttachment(attachment: DraftAttachment): Promise<string> {
		const file = attachment.file;
		if (!file) throw new Error(`${attachment.name} has no file data`);
		const response = await fetch(`/api/upload?name=${encodeURIComponent(attachment.name)}`, {
			method: "POST",
			headers: attachment.mimeType ? { "content-type": attachment.mimeType } : undefined,
			body: file,
		});
		const data = asRecord(await response.json().catch(() => null));
		if (data?.ok !== true) throw new Error(asString(data?.error) ?? `upload failed (${response.status})`);
		const uri = asString(data?.uri);
		if (!uri) throw new Error("upload returned no uri");
		this.draftAttachments = this.draftAttachments.map((row) => (row.id === attachment.id ? { ...row, uploadedUri: uri } : row));
		this.emit();
		return uri;
	}

	// ---- toasts / notices ------------------------------------------------

	toast(text: string, level: "info" | "warn" | "error" = "info", url?: string) {
		const toast: Toast = { id: ++this.toastSeq, text, level, url };
		this.toasts = [...this.toasts.slice(-3), toast];
		this.emit();
		setTimeout(
			() => {
				this.toasts = this.toasts.filter((row) => row.id !== toast.id);
				this.emit();
			},
			level === "info" ? 5000 : 9000,
		);
	}

	notice(text: string, level?: "error") {
		this.appendRow({
			role: "assistant",
			local: level === "error" ? "error" : "notice",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
	}
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asMessageList(value: unknown): Message[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const message = asMessage(item);
		return message ? [message] : [];
	});
}

function mergeBlock(previous: ContentBlock | undefined, next: ContentBlock): ContentBlock {
	if (!previous || previous.type !== next.type) return next;
	return { ...previous, ...next };
}

function clamp(text: string): string {
	if (text.length <= TOOL_PREVIEW_LIMIT) return text;
	return `${text.slice(0, TOOL_PREVIEW_LIMIT)}\n… (${text.length - TOOL_PREVIEW_LIMIT} more characters)`;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function formatAgentMessage(message: Message): string {
	const who =
		message.role === "assistant" ? "omp" : message.role === "user" ? "→ agent" : message.role === "toolResult" ? `[${message.toolName ?? "tool"}]` : message.role;
	return `── ${who}\n${contentText(message.content)}`;
}

export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// insecure origins have no clipboard API: fall through to the textarea path
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.append(area);
	area.select();
	const ok = document.execCommand("copy");
	area.remove();
	return ok;
}

/** Desktop notification + short chime, so a finished turn is visible from another window. */
class Notifier {
	enabled: boolean;
	sound = true;

	constructor() {
		this.enabled = typeof Notification !== "undefined" && Notification.permission === "granted";
	}

	get permission(): string {
		return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
	}

	async enable(): Promise<string> {
		if (typeof Notification === "undefined") return "unsupported";
		this.enabled = (await Notification.requestPermission()) === "granted";
		return this.permission;
	}

	ping(kind: "done" | "error" | "ask", title: string, body: string) {
		if (this.enabled) {
			try {
				new Notification(title, { body, silent: true, tag: kind });
			} catch {
				// some mobile browsers refuse the constructor
			}
		}
		if (this.sound) this.chime(kind);
		if (document.hidden) {
			const previous = document.title;
			document.title = `● ${title}`;
			setTimeout(() => {
				document.title = previous;
			}, 4000);
		}
	}

	chime(kind: string) {
		if (typeof AudioContext === "undefined") return;
		try {
			const ctx = new AudioContext();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.frequency.value = kind === "error" ? 320 : kind === "ask" ? 660 : 520;
			gain.gain.value = 0.04;
			osc.connect(gain).connect(ctx.destination);
			osc.start();
			osc.stop(ctx.currentTime + 0.12);
			setTimeout(() => void ctx.close(), 400);
		} catch {
			// audio is best-effort
		}
	}
}

/**
 * The single store instance the UI subscribes to (see useStore.ts for the hook).
 *
 * Created last on purpose: `new Store()` builds its Notifier, so every class in this module
 * must already be initialised (a `const` above its class declaration throws a TDZ error at
 * module evaluation).
 */
export const store = new Store();
