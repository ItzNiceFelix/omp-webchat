// omp-webchat browser client. No framework, no build step: talks the runtime's own RPC dialect.
const $ = (id) => document.getElementById(id);
const state = {
	clientId: null,
	connected: false,
	cwd: "",
	info: null,
	session: null, // last get_state payload
	commands: [],
	models: [],
	levels: [],
	stats: null,
	messages: [],
	keys: [],
	chats: [],
	live: { active: false, phase: "", input: 0, output: 0, turns: new Map() },
	tools: new Map(),
	cards: new Map(),
	agentSlots: new Map(),
	subagents: new Map(),
	queue: { steering: [], followUp: [] },
	widgets: new Map(),
	status: "",
	busy: false,
	images: [],
	btw: new Map(),
	lastSentText: "",
	notify: { enabled: false, permission: "default", sound: true },
	drawer: { open: false, selected: null, tail: true, byte: 0, file: null, timer: null },
	welcomeDismissed: false,
};

// ---------------------------------------------------------------- helpers

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Inline SVG from the sprite; decorative by default. */
function icon(name, cls = "ic", label) {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", cls);
	if (label) {
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", label);
	} else {
		svg.setAttribute("aria-hidden", "true");
	}
	const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
	use.setAttribute("href", `#i-${name}`);
	svg.append(use);
	return svg;
}

const KEYWORDS =
	/\b(const|let|var|function|return|if|else|for|while|await|async|import|from|export|class|new|try|catch|throw|type|interface|extends|implements|public|private|readonly|def|end|do|then|fi|esac|in|of|not|null|true|false|None|True|False)\b/g;

/** Small language-agnostic highlighter: comments, strings, numbers, keywords, calls. */
function highlightCode(code) {
	return code
		.replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, (m) => `\u0000c${m}\u0000`)
		.replace(/('[^'\n]*'|"[^"\n]*"|`[^`]*`)/g, (m) => `\u0000s${m}\u0000`)
		.replace(/\b(\d+(?:\.\d+)?)\b/g, "\u0000n$1\u0000")
		.replace(KEYWORDS, "\u0000k$1\u0000")
		.replace(/\b([A-Za-z_$][\w$]*)(?=\()/g, "\u0000f$1\u0000")
		.replace(/\u0000([csknf])([\s\S]*?)\u0000/g, (_m, kind, text) => {
			const cls = { c: "tok-com", s: "tok-str", k: "tok-key", n: "tok-num", f: "tok-fn" }[kind];
			return `<span class="${cls}">${text}</span>`;
		});
}

/** Colored inline spans: code, commands, mentions, paths, links. */
function inline(s) {
	return s
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(
			/(^|[\s([])(\/(?:[a-z][\w-]*(?::[\w-]+)?))(?=[\s.,)\]]|$)/g,
			'$1<span class="slashref">$2</span>',
		)
		.replace(/(^|[\s(])(@[\w./-]+)/g, '$1<span class="mention">$2</span>')
		.replace(
			/(^|[\s([])((?:\.{0,2}[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+\.\w{1,6})(?=[\s.,)\]]|$)/g,
			'$1<span class="path">$2</span>',
		)
		.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function md(src) {
	const escaped = String(src ?? "").replace(/[&<>]/g, (c) => ESCAPES[c]);
	return escaped
		.split("```")
		.map((part, i) => {
			if (i % 2 === 1) {
				const nl = part.indexOf("\n");
				const lang = nl >= 0 ? part.slice(0, nl).trim() : "";
				const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, "");
				return `<pre class="code"${lang ? ` data-lang="${lang}"` : ""}><code>${highlightCode(code)}</code></pre>`;
			}
			return part
				.split(/\n{2,}/)
				.map((par) => {
					const lines = par.split("\n").filter((l) => l.trim());
					if (lines.length && lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l)))
						return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`).join("")}</ul>`;
					return `<p>${lines.map(inline).join("<br>")}</p>`;
				})
				.join("");
		})
		.join("");
}

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;
	return node;
}

function blocksToNodes(blocks, container) {
	for (const [i, block] of (blocks ?? []).entries()) container.append(blockNode(block, i));
}

/** Three animated bars, used wherever the agent is visibly working. */
function typingDots() {
	const box = el("span", "typing");
	box.setAttribute("aria-hidden", "true");
	box.append(el("i"), el("i"), el("i"));
	return box;
}

/**
 * Streamed assistant text: markdown is re-rendered at most once per frame, with a timer
 * fallback because `requestAnimationFrame` is paused in background/hidden tabs — streaming
 * must keep landing even when nobody is looking at the page.
 */
function streamText(node, text) {
	node.dataset.streamText = text;
	if (node.dataset.streamQueued) return;
	node.dataset.streamQueued = "1";
	const flush = () => {
		if (!node.dataset.streamQueued) return;
		delete node.dataset.streamQueued;
		clearTimeout(Number(node.dataset.streamTimer || 0));
		delete node.dataset.streamTimer;
		node.innerHTML = `${md(node.dataset.streamText ?? "")}<span class="caret" aria-hidden="true"></span>`;
	};
	node.dataset.streamTimer = String(setTimeout(flush, 120));
	requestAnimationFrame(flush);
}

function blockNode(block, index) {
	if (block?.type === "text") {
		const div = el("div");
		div.innerHTML = md(block.text);
		return div;
	}
	if (block?.type === "thinking") {
		const det = el("details", "thinking");
		det.append(el("summary", null, block.summary ? "thinking (summary)" : "thinking"));
		det.append(el("div", "body", block.thinking ?? ""));
		return det;
	}
	if (block?.type === "image") {
		const img = el("img");
		img.src = block.data?.startsWith?.("data:") ? block.data : `data:${block.mimeType ?? "image/png"};base64,${block.data}`;
		return img;
	}
	if (block?.type === "toolCall") return toolCard(block);
	const div = el("div", "dim");
	div.textContent = `[${block?.type ?? `block ${index}`}]`;
	return div;
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			if (b?.type === "text") return b.text ?? "";
			if (b?.type === "image") return "[image]";
			if (b?.type === "toolResult") return contentText(b.content);
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function pill(text, kind) {
	return el("span", `pill ${kind ?? ""}`, text);
}

function toast(message, level = "info", url) {
	const box = el("div", `toast ${level}`);
	box.textContent = message;
	if (url) {
		box.append(document.createTextNode(" "));
		const link = el("a", null, url);
		link.href = url;
		link.target = "_blank";
		box.append(link);
	}
	$("toasts").append(box);
	setTimeout(() => box.remove(), level === "error" ? 15000 : 7000);
}

function timeAgo(ms) {
	const s = Math.max(0, (Date.now() - ms) / 1000);
	if (s < 60) return `${s.toFixed(0)}s`;
	if (s < 3600) return `${(s / 60).toFixed(0)}m`;
	return `${(s / 3600).toFixed(1)}h`;
}

// ---------------------------------------------------------------- transport

const waiters = new Map();
let seq = 0;
let ws = null;
let reconnectTimer = null; // reconnect attempts are tracked on the socket (see connectSocket)

function cmd(command, timeoutMs = 120000) {
	const id = `${state.clientId}:${++seq}`;
	const payload = { id, ...command };
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			waiters.delete(id);
			reject(new Error(`timeout: ${command.type}`));
		}, timeoutMs);
		waiters.set(id, (frame) => {
			clearTimeout(timer);
			if (frame.type === "wx:dead") reject(new Error("omp process is gone"));
			else resolve(frame);
		});
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			clearTimeout(timer);
			waiters.delete(id);
			reject(new Error("not connected"));
			return;
		}
		ws.send(JSON.stringify(payload));
	});
}

/** Command + throw on `success: false`. */
async function must(command) {
	const frame = await cmd(command);
	if (frame?.success === false) throw new Error(frame.error ?? `${command.type} failed`);
	return frame?.data;
}

function notify(message, level = "error") {
	toast(String(message), level);
	appendSystemRow(String(message), level === "error" ? "error" : "system");
}

/** Survives a bridge restart: reconnect with backoff and re-bootstrap on `wx:hello`. */
function connectSocket() {
	clearTimeout(reconnectTimer);
	ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
	ws.addEventListener("open", () => {
		state.connected = true;
		setConn("starting");
	});
	ws.addEventListener("close", () => {
		const wasConnected = state.connected;
		state.connected = false;
		state.clientId = null;
		setConn("exited");
		for (const [id, waiter] of waiters) {
			waiters.delete(id);
			waiter({ type: "wx:dead" });
		}
		if (wasConnected) appendSystemRow("connection to the webchat server lost — reconnecting…", "system");
		reconnectTimer = setTimeout(connectSocket, 1500);
	});
	ws.addEventListener("error", () => {
		// the close handler owns recovery
	});
	ws.addEventListener("message", (ev) => {
		let frame;
		try {
			frame = JSON.parse(ev.data);
		} catch {
			return;
		}
		onFrame(frame);
	});
}

function setConn(status) {
	$("conn").className = `dot ${status === "running" ? "on" : status === "starting" ? "mid" : ""}`;
}

function onFrame(frame) {
	if (typeof frame.id === "string") {
		const waiter = waiters.get(frame.id);
		if (waiter) {
			waiters.delete(frame.id);
			waiter(frame);
			return;
		}
	}
	if (frame.type?.startsWith?.("wx:")) return onServerFrame(frame);
	onRpcFrame(frame);
}

function onServerFrame(frame) {
	if (frame.type === "wx:hello") {
		state.clientId = frame.clientId;
		state.cwd = frame.cwd;
		setConn(frame.child);
		void bootstrap();
		return;
	}
	if (frame.type === "wx:child") {
		setConn(frame.status === "exited" ? "exited" : frame.status);
		if (frame.status === "exited") appendSystemRow(`omp process exited (code ${frame.code})`, "error");
		return;
	}
	if (frame.type === "wx:card") {
		appendCard(frame.title, frame.body);
		return;
	}
	if (frame.type === "wx:log") {
		if (frame.level === "stderr") appendSystemRow(frame.text, "system");
		else toast(frame.text, "warn");
	}
}

// ---------------------------------------------------------------- RPC frames

let cur = null; // streaming assistant bubble {node, blocks: Map, index}

function onRpcFrame(frame) {
	switch (frame.type) {
		case "ready":
		case "wx:ready":
			return;
		case "available_commands_update":
			state.commands = frame.commands ?? [];
			return;
		case "agent_start":
			state.busy = true;
			renderHeader();
			return;
		case "agent_end": {
			state.busy = false;
			cur = null;
			if (frame.yielded === false) appendSystemRow("agent yielded for retry/compaction — continuing", "system");
			// agent_end.messages may be a partial batch (the runtime drops messages already
			// streamed); only fall back to a full reload when our transcript looks short.
			const expected = typeof frame.messageCount === "number" ? frame.messageCount : 0;
			if (state.messages.length < 2 || expected > state.messages.length) void refreshTranscript();
			void refreshState();
			void loadChats();
			if (frame.yielded !== false) {
				const last = [...state.messages].reverse().find((m) => m.role === "assistant");
				ping("done", "omp finished", contentText(last?.content).replace(/\s+/g, " ").slice(0, 160) || "the turn completed");
			}
			renderWelcome();
			return;
		}
		case "session_settled":
			state.busy = false;
			renderHeader();
			return;
		case "turn_start":
			cur = null;
			return;
		case "message_start":
			onMessageStart(frame);
			return;
		case "message_update":
			onMessageUpdate(frame);
			return;
		case "message_end":
			onMessageEnd(frame);
			return;
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			onToolEvent(frame);
			return;
		case "queue_update":
			state.queue = { steering: frame.steering ?? [], followUp: frame.followUp ?? [] };
			renderQueue();
			return;
		case "todo_reminder":
		case "todo_auto_clear":
		case "goal_updated":
		case "session_info_update":
		case "config_update":
		case "model_changed":
		case "thinking_level_changed":
			void refreshState();
			return;
		case "notice":
			appendSystemRow(`[${frame.source ?? "notice"}] ${frame.message ?? ""}`, frame.level === "error" ? "error" : "system");
			return;
		case "command_output":
			appendSystemRow(String(frame.text ?? frame.output ?? frame.message ?? JSON.stringify(frame)), "system");
			return;
		case "extension_error":
			appendSystemRow(`extension error (${frame.extensionPath ?? "?"}): ${frame.error ?? ""}`, "error");
			return;
		case "rpc_frame_error":
			appendSystemRow(`frame too large: ${frame.message ?? JSON.stringify(frame)}`, "error");
			return;
		case "auto_compaction_start":
			appendSystemRow("auto-compaction started…", "system");
			return;
		case "auto_compaction_end":
			appendSystemRow("auto-compaction finished", "system");
			void refreshState();
			return;
		case "auto_retry_start":
			state.retrying = true;
			appendSystemRow(`retrying (attempt ${frame.attempt ?? "?"}): ${frame.errorMessage ?? ""}`, "system");
			return;
		case "auto_retry_end":
			state.retrying = false;
			return;
		case "retry_fallback_applied":
		case "retry_fallback_succeeded":
			appendSystemRow(`${frame.type} ${JSON.stringify({ from: frame.from, to: frame.to, model: frame.model })}`, "system");
			return;
		case "prompt_result":
			state.busy = false;
			renderHeader();
			if (frame.status === "error") {
				notify(`turn error: ${frame.error?.message ?? "unknown"}`, "error");
				ping("error", "omp turn failed", frame.error?.message ?? "unknown error");
			}
			return;
		case "irc_message":
			appendSystemRow(`[irc] ${frame.text ?? JSON.stringify(frame)}`, "system");
			return;
		case "subagent_lifecycle":
		case "subagent_progress":
			onSubagent(frame.payload?.progress ?? frame.payload);
			return;
		case "subagent_event":
			return;
		case "btw_record":
			onBtwRecord(frame.record);
			return;
		case "btw_delta":
			onBtwDelta(frame);
			return;
		case "extension_ui_request":
			onUIRequest(frame);
			return;
		case "live_phase":
		case "live_levels":
		case "live_transcript":
		case "live_end":
			onLiveFrame(frame);
			return;
		case "tool_stream_update":
			return;
		default:
			return;
	}
}

function messageKey(frame, msg) {
	return frame.messageId ?? msg.toolCallId ?? `${msg.role}:${msg.timestamp}`;
}

/** Merge a message into the transcript; returns false when it was already known. */
function upsertMessage(key, msg) {
	const index = state.keys.indexOf(key);
	if (index >= 0) {
		state.messages[index] = msg;
		return false;
	}
	state.keys.push(key);
	state.messages.push(msg);
	return true;
}

function setTranscript(messages) {
	state.messages = messages;
	state.keys = messages.map((m) => `${m.role}:${m.timestamp ?? ""}:${m.toolCallId ?? ""}`);
}

function onMessageStart(frame) {
	const msg = frame.message;
	if (!msg) return;
	if (msg.role === "assistant") {
		cur = { node: assistantBubble(), blocks: new Map() };
		transcript().append(cur.node);
		scrollDown();
		return;
	}
	const fresh = upsertMessage(messageKey(frame, msg), msg);
	if (msg.role === "user" && fresh) {
		dropOptimistic(msg);
		transcript().append(userBubble(msg));
		scrollDown();
	}
	if (msg.role === "toolResult") applyToolResult(msg);
}

function onMessageUpdate(frame) {
	const ev = frame.assistantMessageEvent;
	if (!ev) return;
	if (!cur) cur = { node: assistantBubble(), blocks: new Map() };
	const index = ev.contentIndex ?? 0;
	const block = ev.partial?.content?.[index] ?? ev.toolCall ?? ev.message?.content?.[index];
	if (!block) return;
	let node = cur.blocks.get(index);
	if (!node || ev.type.endsWith("_start")) {
		node?.remove();
		node = blockNode(block, index);
		cur.blocks.set(index, node);
		cur.node.querySelector(".blocks").append(node);
	} else if (block.type === "text") {
		streamText(node, block.text ?? "");
	} else if (block.type === "thinking") {
		const body = node.querySelector(".body");
		body.textContent = block.thinking ?? "";
		node.classList.add("streaming");
		const summary = node.querySelector("summary");
		if (!summary.querySelector(".typing")) summary.append(typingDots());
	} else if (block.type === "toolCall") {
		const partial = block.partialArgs ?? (block.arguments ? JSON.stringify(block.arguments, null, 2) : "");
		if (partial) node.querySelector(".args").textContent = partial;
		if (block.intent) node.querySelector(".tintent").textContent = block.intent;
	}
	scrollDown();
}

function onMessageEnd(frame) {
	const msg = frame.message;
	if (!msg) return;
	if (msg.role !== "assistant") {
		upsertMessage(messageKey(frame, msg), msg);
		if (msg.role === "toolResult") applyToolResult(msg);
		return;
	}
	upsertMessage(messageKey(frame, msg), msg);
	const node = cur?.node ?? assistantBubble();
	if (!cur) transcript().append(node);
	const blocks = node.querySelector(".blocks");
	blocks.replaceChildren();
	blocksToNodes(msg.content, blocks);
	for (const det of node.querySelectorAll("details.streaming")) det.classList.remove("streaming");
	applyUsage(node, msg);
	cur = null;
	scrollDown();
}

function onToolEvent(frame) {
	const id = frame.toolCallId;
	const entry = state.tools.get(id) ?? { status: "running", start: Date.now() };
	if (frame.type === "tool_execution_start") {
		entry.status = "running";
		entry.name = frame.toolName;
		entry.intent = frame.intent;
		entry.args = frame.args;
		entry.start = Date.now();
	} else if (frame.type === "tool_execution_update") {
		entry.preview = contentText(frame.partialResult?.content) || entry.preview;
	} else {
		entry.status = frame.isError ? "error" : "ok";
		entry.end = Date.now();
		entry.isError = Boolean(frame.isError);
	}
	state.tools.set(id, entry);
	const card = state.cards.get(id);
	if (card) updateCard(card, id);
	renderHeader();
}

function applyToolResult(msg) {
	const card = state.cards.get(msg.toolCallId);
	const entry = state.tools.get(msg.toolCallId) ?? {};
	entry.status = msg.isError ? "error" : "ok";
	entry.isError = Boolean(msg.isError);
	entry.end ??= Date.now();
	state.tools.set(msg.toolCallId, entry);
	if (card) updateCard(card, msg.toolCallId, msg);
}

function onSubagent(row) {
	if (!row?.id) return;
	const prev = state.subagents.get(row.id) ?? {};
	state.subagents.set(row.id, { ...prev, ...row });
	renderAgents();
}

// ---------------------------------------------------------------- transcript rendering

function transcript() {
	return $("transcript");
}

function scrollDown() {
	const box = $("scroll");
	box.scrollTop = box.scrollHeight;
}

function atBottom() {
	const box = $("scroll");
	return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function clearTranscript() {
	state.cards.clear();
	state.agentSlots.clear();
	state.btw.clear();
	cur = null;
	transcript().replaceChildren();
}

function renderTranscript() {
	clearTranscript();
	const toolResults = new Map();
	for (const msg of state.messages) if (msg.role === "toolResult") toolResults.set(msg.toolCallId, msg);
	for (const msg of state.messages) {
		if (msg.role === "user") transcript().append(userBubble(msg));
		else if (msg.role === "assistant") {
			const node = assistantBubble();
			blocksToNodes(msg.content, node.querySelector(".blocks"));
			applyUsage(node, msg);
			transcript().append(node);
		}
	}
	for (const result of toolResults.values()) applyToolResult(result);
	renderWelcome();
	scrollDown();
}

function userBubble(msg) {
	const node = el("div", "msg user");
	const bubble = el("div", "bubble");
	const body = el("div", "blocks");
	blocksToNodes(msg.content, body);
	bubble.append(body);
	node.append(bubble);
	return node;
}

function assistantBubble() {
	const node = el("div", "msg turn");
	node.append(el("div", "who", "omp"));
	node.append(el("div", "blocks"));
	node.append(el("div", "usage dim"));
	return node;
}

function applyUsage(node, msg) {
	const usage = msg.usage;
	const line = node.querySelector(".usage");
	if (!line) return;
	const parts = [];
	if (usage?.input) parts.push(`in ${usage.input}`);
	if (usage?.output) parts.push(`out ${usage.output}`);
	if (usage?.cost?.total) parts.push(`$${Number(usage.cost.total).toFixed(4)}`);
	if (msg.duration) parts.push(`${(msg.duration / 1000).toFixed(1)}s`);
	line.textContent = parts.join(" · ");
}

function appendSystemRow(text, kind) {
	const node = el("div", `msg ${kind}`, text);
	transcript().append(node);
	scrollDown();
	return node;
}

/** A card pushed by the `webchat_card` host tool (or any host that broadcasts `wx:card`). */
function appendCard(title, body) {
	const node = el("div", "msg card");
	node.append(el("h4", null, title ?? "card"));
	const content = el("div", "blocks");
	content.innerHTML = md(body ?? "");
	node.append(content);
	transcript().append(node);
	scrollDown();
	return node;
}

function pushOptimistic(text) {
	const node = el("div", "msg user");
	const bubble = el("div", "bubble dim");
	bubble.dataset.optimistic = text;
	bubble.append(el("div", "blocks", text));
	node.append(bubble);
	transcript().append(node);
	scrollDown();
}

function dropOptimistic(msg) {
	const text = contentText(msg.content);
	for (const node of transcript().querySelectorAll("[data-optimistic]")) {
		if (node.dataset.optimistic === text) node.closest(".msg")?.remove();
	}
}

// ---------------------------------------------------------------- tool cards

function toolCard(call) {
	const wrap = el("div", "toolWrap");
	const card = el("div", "tool");
	card.dataset.call = call.id;
	const head = el("div", "head");
	head.append(el("span", "tname", call.name ?? "tool"));
	head.append(el("span", "tintent", call.intent ?? ""));
	head.append(el("span", "status pill"));
	const toggle = el("button", "toggle", "args");
	head.append(toggle);
	card.append(head);
	const body = el("div", "body");
	const args = el("pre", "args");
	body.append(args, el("pre", "res"));
	card.append(body);
	if (call.arguments) body.classList.add("collapsed");
	toggle.addEventListener("click", () => body.classList.toggle("collapsed"));
	wrap.append(card);
	const agents = el("div", "card-inline");
	agents.dataset.agentsFor = call.id;
	wrap.append(agents);
	state.agentSlots.set(call.id, agents);
	state.cards.set(call.id, card);
	updateCard(card, call.id, undefined, call.arguments);
	renderAgentSlot(call.id);
	return wrap;
}

function renderAgentSlot(callId) {
	const box = state.agentSlots.get(callId);
	if (!box) return;
	box.replaceChildren();
	for (const row of state.subagents.values()) {
		if (row.parentToolCallId !== callId) continue;
		box.append(agentRowNode(row));
	}
}

function updateCard(card, callId, resultMsg, args) {
	const entry = state.tools.get(callId) ?? {};
	const status = card.querySelector(".status");
	const running = entry.status === "running";
	card.classList.toggle("running", running);
	const head = card.querySelector(".head");
	const existing = head.querySelector(".spin");
	if (running && !existing) head.prepend(el("span", "spin"));
	if (!running && existing) existing.remove();
	status.className = `status pill ${running ? "running" : entry.isError ? "error" : entry.status ? "ok" : ""}`;
	status.textContent = running
		? `running${entry.start ? ` ${timeAgo(entry.start)}` : ""}`
		: entry.status === "error"
			? "failed"
			: entry.status === "ok"
				? "ok"
				: "queued";
	if (args) card.querySelector(".args").textContent = JSON.stringify(args, null, 2);
	const res = card.querySelector(".res");
	const blocks = resultMsg?.content;
	const text = blocks ? contentText(blocks) : entry.preview;
	if (!text) {
		res.classList.add("hidden");
		return;
	}
	res.classList.remove("hidden");
	res.textContent = text.length > 8000 ? `${text.slice(0, 8000)}\n… (${text.length} chars)` : text;
	res.classList.toggle("err", Boolean(entry.isError));
	if (Array.isArray(blocks) && !res.dataset.imagesAdded) {
		res.dataset.imagesAdded = "1";
		for (const b of blocks.filter((x) => x?.type === "image")) {
			const img = el("img");
			img.src = b.data?.startsWith?.("data:") ? b.data : `data:${b.mimeType ?? "image/png"};base64,${b.data}`;
			res.after(img);
		}
	}
}

// ---------------------------------------------------------------- panels

function renderHeader() {
	const s = state.session ?? {};
	$("sessionLabel").textContent = s.sessionName ? s.sessionName.slice(0, 28) : "session";
	$("modelLabel").textContent = s.model?.id ? String(s.model.id).slice(0, 30) : "model";
	$("thinkingLabel").textContent = `effort:${s.thinkingLevel ?? "auto"}`;
	const menu = [
		["fastBtn", Boolean(s.fastModeActive)],
		["slowBtn", Boolean(s.slowModeSupported && s.slowModeEnabled)],
		["compactBtn", Boolean(s.autoCompactionEnabled)],
	];
	for (const [id, on] of menu) {
		const node = $(id);
		node.setAttribute("aria-checked", String(on));
		node.querySelector(".state").textContent = on ? "on" : "off";
	}
	$("warmingBtn").querySelector(".state").textContent = $("warmingBtn").dataset.mode ?? "off";
	$("ctx").textContent = s.contextUsage
		? `ctx ${s.contextUsage.percent?.toFixed?.(1) ?? "?"}% · ${s.contextUsage.tokens}/${s.contextUsage.contextWindow}`
		: "ctx –";
	$("tps").textContent = s.tokensPerSecond ? `${Number(s.tokensPerSecond).toFixed(1)} tok/s` : "";
	$("stopBtn").disabled = !state.busy;
	$("main").classList.toggle("busy", state.busy);
	$("sendBtn").setAttribute("aria-label", state.busy && $("steerBox").checked ? "Steer the running turn" : state.busy ? "Queue message" : "Send message");
	const hint = $("hint");
	hint.replaceChildren();
	const busyText = state.busy
		? `${$("steerBox").checked ? "steering" : "queueing"} · Esc to stop`
		: s.isSettled === false
			? "background work pending"
			: "";
	if (state.busy) hint.append(typingDots(), document.createTextNode(busyText));
	else hint.textContent = busyText;
	const meta = $("sessionMeta");
	meta.replaceChildren();
	const rows = [
		["cwd", state.cwd],
		["session", s.sessionFile ? s.sessionFile.split(/[\\/]/).pop() : "–"],
		["messages", String(s.messageCount ?? state.messages.length)],
		["model", s.model?.id ?? "–"],
		["effort", `${s.thinkingLevel ?? "auto"}${s.fastModeActive ? " · fast" : ""}${s.slowModeSupported && s.slowModeEnabled ? " · slow" : ""}`],
	];
	if (state.stats) rows.push(["tokens", `${state.stats.tokens?.total ?? 0} · $${Number(state.stats.cost ?? 0).toFixed(4)}`]);
	if (s.usageLimit)
		rows.push([
			"limit",
			`${s.usageLimit.stage}${s.usageLimit.resetsAtSec ? ` · resets ${new Date(s.usageLimit.resetsAtSec * 1000).toLocaleTimeString()}` : ""}`,
		]);
	for (const [k, v] of rows) {
		meta.append(el("dt", null, k));
		meta.append(el("dd", null, String(v)));
	}
	$("statusLine").textContent = state.status;
	renderPalette();
}

/** Welcome/empty state so a fresh chat does not look broken. */
function renderWelcome() {
	const existing = transcript().querySelector(".welcome");
	const empty = state.messages.length === 0 && !cur;
	if (!empty) {
		existing?.remove();
		return;
	}
	if (existing) return;
	const box = el("div", "msg welcome");
	box.append(el("div", "who", "omp webchat"));
	box.append(
		el(
			"div",
			"blocks",
			"Ask anything. `/` lists the commands this session can dispatch, `@path` attaches files, images can be pasted, Esc stops a turn.",
		),
	);
	const hints = el("div", "sub dim");
	hints.textContent = "Streamed from `omp --mode rpc-ui` — same commands, todos, agents and sessions as the CLI.";
	box.append(hints);
	transcript().append(box);
}

function renderTodos() {
	const phases = state.session?.todoPhases;
	const card = $("todoCard");
	if (!phases?.length) {
		card.classList.add("hidden");
		$("todoCount").textContent = "";
		return;
	}
	card.classList.remove("hidden");
	const body = $("todoBody");
	body.replaceChildren();
	let openTotal = 0;
	let total = 0;
	for (const phase of phases) {
		const open = phase.tasks.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked").length;
		openTotal += open;
		total += phase.tasks.length;
		body.append(el("div", "phase", `${phase.name} · ${phase.tasks.length - open}/${phase.tasks.length}`));
		for (const task of phase.tasks) {
			const cls = task.status === "completed" ? "done" : task.status === "in_progress" ? "active" : task.status === "blocked" ? "blocked" : "";
			const row = el("div", `task ${cls}`);
			const mark = { pending: "•", in_progress: "▶", completed: "✓", abandoned: "✕", blocked: "!" }[task.status] ?? "?";
			row.append(el("span", "mark", mark));
			row.append(el("span", "txt", `${task.content}${task.blocker ? ` — ${task.blocker}` : ""}`));
			body.append(row);
		}
	}
	$("todoCount").textContent = `${total - openTotal}/${total} done`;
}

function renderQueue() {
	const { steering, followUp } = state.queue;
	const card = $("queueCard");
	const total = steering.length + followUp.length;
	$("queueCount").textContent = total ? `${total} waiting` : "";
	if (!total) return card.classList.add("hidden");
	card.classList.remove("hidden");
	const body = $("queueBody");
	body.replaceChildren();
	const row = (text, queue) => {
		const item = el("div", "queued");
		item.append(el("span", "txt", text));
		const promote = el("button", "icon-btn sm", null);
		promote.title = "Send next (promote to steering)";
		promote.setAttribute("aria-label", "Promote queued message");
		promote.append(icon("chevron"));
		promote.addEventListener("click", async () => {
			try {
				await must({ type: "promote_queued_message", message: text });
			} catch (err) {
				notify(String(err.message ?? err));
			}
		});
		const remove = el("button", "icon-btn sm", null);
		remove.title = "Remove from queue";
		remove.setAttribute("aria-label", "Remove queued message");
		remove.append(icon("x"));
		remove.addEventListener("click", async () => {
			try {
				const data = await must({ type: "remove_queued_message", message: text, queue });
				if (data?.images?.length) state.images.push(...data.images);
				renderAttachments();
			} catch (err) {
				notify(String(err.message ?? err));
			}
		});
		item.append(promote, remove);
		body.append(item);
	};
	for (const text of steering) row(text, "steering");
	for (const text of followUp) row(text, "followUp");
}

function agentRowNode(row) {
	const box = el("div", `agent${state.drawer.selected === row.id ? " selected" : ""}`);
	box.tabIndex = 0;
	const top = el("div", "top");
	top.append(el("span", "name", `${row.id ?? row.name ?? "agent"}`));
	top.append(pill(row.status ?? "?", row.status));
	top.append(el("span", "dim", row.agent ?? ""));
	box.append(top);
	const bits = [];
	if (row.model) bits.push(typeof row.model === "string" ? row.model : (row.model.id ?? ""));
	if (row.tokens?.total ?? row.tokens) bits.push(`${row.tokens?.total ?? row.tokens} tok`);
	if (row.cost) bits.push(`$${Number(row.cost).toFixed?.(4) ?? row.cost}`);
	if (row.toolCalls) bits.push(`${row.toolCalls} tools`);
	if (row.elapsedMs) bits.push(`${(row.elapsedMs / 1000).toFixed(0)}s`);
	else if (row.lastActivityAt) bits.push(`active ${timeAgo(row.lastActivityAt)} ago`);
	if (bits.filter(Boolean).length) box.append(el("div", "sub", bits.filter(Boolean).join(" · ")));
	const activity = row.task ?? row.activity ?? row.currentTool;
	if (activity) box.append(el("div", "sub", String(activity).replace(/\s+/g, " ").slice(0, 220)));
	const acts = el("div", "acts");
	const view = el("button", "icon-btn sm");
	view.title = "Open transcript";
	view.setAttribute("aria-label", `Open transcript for ${row.id}`);
	view.append(icon("terminal"));
	view.addEventListener("click", (ev) => {
		ev.stopPropagation();
		void openAgentTranscript(row);
	});
	acts.append(view);
	if (row.status === "running") {
		const steer = el("button", "icon-btn sm");
		steer.title = "Steer this agent";
		steer.setAttribute("aria-label", `Steer ${row.id}`);
		steer.append(icon("send"));
		steer.addEventListener("click", (ev) => {
			ev.stopPropagation();
			steerAgent(row);
		});
		const kill = el("button", "icon-btn sm");
		kill.title = "Kill this agent";
		kill.setAttribute("aria-label", `Kill ${row.id}`);
		kill.append(icon("x"));
		kill.addEventListener("click", (ev) => {
			ev.stopPropagation();
			killAgent(row);
		});
		acts.append(steer, kill);
	}
	box.append(acts);
	const select = () => void openAgentTranscript(row);
	box.addEventListener("click", select);
	box.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			select();
		}
	});
	return box;
}

function renderAgents() {
	const rows = [...state.subagents.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	$("agentsCount").textContent = `${rows.length} agent${rows.length === 1 ? "" : "s"}`;
	$("agentsBtn").classList.toggle("active", state.drawer.open && rows.length > 0);
	const body = $("agentsBody");
	body.replaceChildren();
	if (!rows.length) {
		body.append(el("div", "dim", "No agents yet. Subagents spawned by the task tool appear here with their transcripts."));
	} else {
		for (const row of rows) body.append(agentRowNode(row));
	}
	for (const callId of state.agentSlots.keys()) renderAgentSlot(callId);
}

// ---------------------------------------------------------------- agent transcripts

function formatAgentMessage(msg) {
	const who = msg.role === "assistant" ? "omp" : msg.role === "user" ? "→ agent" : msg.role === "toolResult" ? `[${msg.toolName ?? "tool"}]` : msg.role;
	return `── ${who}\n${contentText(msg.content)}`;
}

async function pullAgentTranscript(subagentId) {
	const body = $("agentTranscriptBody");
	let data;
	try {
		data = await must({ type: "get_subagent_messages", subagentId, fromByte: state.drawer.byte });
	} catch (err) {
		body.textContent = `transcript unavailable: ${err.message ?? err}`;
		return;
	}
	if (data?.reset) {
		body.textContent = "";
		state.drawer.byte = 0;
	}
	const chunk = (data?.messages ?? []).map(formatAgentMessage).join("\n\n");
	if (chunk) body.append(`${chunk}\n\n`);
	if (typeof data?.nextByte === "number") state.drawer.byte = data.nextByte;
	body.scrollTop = body.scrollHeight;
}

function scheduleAgentTail() {
	clearInterval(state.drawer.timer);
	state.drawer.timer = setInterval(() => {
		if (!state.drawer.open || !state.drawer.selected || document.hidden) return;
		void pullAgentTranscript(state.drawer.selected);
	}, 2500);
}

async function openAgentTranscript(row) {
	state.drawer.selected = row?.id ?? null;
	$("agentTranscript").classList.remove("hidden");
	$("agentTranscriptTitle").textContent = row?.id ? `transcript · ${row.id}` : "transcript";
	$("agentTranscriptBody").textContent = row?.id ? "loading…" : "select an agent";
	state.drawer.byte = 0;
	if (row?.id) await pullAgentTranscript(row.id);
	scheduleAgentTail();
	renderAgents();
	openDrawer();
}

function closeAgentTranscript() {
	state.drawer.selected = null;
	$("agentTranscript").classList.add("hidden");
	clearInterval(state.drawer.timer);
	state.drawer.timer = null;
	renderAgents();
}

function agentControlModal(row, kind) {
	const steer = kind === "steer";
	openModal(`${steer ? "steer" : "kill"} ${row.id}`, (box) => {
		box.append(el("div", "pre", steer ? `Message is sent to ${row.id} as its user, at its next step boundary.` : `This cancels ${row.id}'s running turn and tombstones it; it cannot be revived.`));
		const input = steer ? el("textarea") : null;
		if (input) input.placeholder = "message…";
		if (input) box.append(input);
		const foot = el("div", "foot");
		const cancel = el("button", "ghost", "cancel");
		const go = el("button", "primary", steer ? "send" : "kill");
		cancel.addEventListener("click", closeModal);
		go.addEventListener("click", async () => {
			try {
				if (steer) {
					const message = input.value.trim();
					if (!message) return;
					await must({ type: "steer_subagent", subagentId: row.id, message });
					toast(`steered ${row.id}`, "info");
				} else {
					await must({ type: "cancel_subagent", subagentId: row.id });
					toast(`killed ${row.id}`, "warn");
				}
				closeModal();
				await refreshSubagents();
			} catch (err) {
				notify(`${kind} failed: ${err.message ?? err}`);
			}
		});
		foot.append(cancel, go);
		box.append(foot);
		if (input) input.focus();
	});
}

function steerAgent(row) {
	agentControlModal(row, "steer");
}

function killAgent(row) {
	agentControlModal(row, "kill");
}

// ---------------------------------------------------------------- drawers (responsive)

function backdrop(on) {
	$("backdrop").hidden = !on;
}

function openDrawer() {
	state.drawer.open = true;
	$("app").classList.add("agents-open");
	$("agentsDrawer").setAttribute("aria-hidden", "false");
	$("agentsBtn").setAttribute("aria-expanded", "true");
	backdrop(true);
	renderAgents();
}

function closeDrawer() {
	state.drawer.open = false;
	$("app").classList.remove("agents-open");
	$("agentsDrawer").setAttribute("aria-hidden", "true");
	$("agentsBtn").setAttribute("aria-expanded", "false");
	backdrop(false);
	renderAgents();
}

function toggleSidebar(force) {
	const open = force ?? !$("app").classList.contains("side-open");
	$("app").classList.toggle("side-open", open);
	$("sidebarToggle").setAttribute("aria-expanded", String(open));
	backdrop(open);
}

function renderGoal() {
	const goal = state.session?.goal;
	const card = $("goalCard");
	if (!goal) return card.classList.add("hidden");
	card.classList.remove("hidden");
	$("goalBody").textContent = `${goal.status ?? ""} ${goal.objective ?? ""} ${goal.tokensUsed ? `(${goal.tokensUsed} tok)` : ""}`.trim();
}

function renderWidgets() {
	const card = $("widgetCard");
	if (!state.widgets.size) return card.classList.add("hidden");
	card.classList.remove("hidden");
	const body = $("widgetBody");
	body.replaceChildren();
	for (const [key, value] of state.widgets) {
		if (!value) continue;
		body.append(el("div", "phase", key));
		body.append(el("div", null, Array.isArray(value) ? value.join("\n") : String(value)));
	}
}

// ---------------------------------------------------------------- chat history

function groupLabel(ms) {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (ms >= startOfToday) return "today";
	if (ms >= startOfToday - 86_400_000) return "yesterday";
	if (ms >= startOfToday - 6 * 86_400_000) return "previous 7 days";
	return "older";
}

async function loadChats() {
	try {
		const res = await fetch(`/api/sessions?limit=100`).then((r) => r.json());
		state.chats = res.sessions ?? [];
		renderChats();
	} catch (err) {
		toast(`chat list failed: ${err.message ?? err}`, "warn");
	}
}

function renderChats() {
	const list = $("chatList");
	if (!list) return;
	const filter = $("chatSearch").value.trim().toLowerCase();
	const rows = state.chats.filter((c) => !filter || `${c.name} ${c.firstUser ?? ""} ${c.id}`.toLowerCase().includes(filter));
	const active = state.session?.sessionFile;
	// A brand-new session has no file on disk until its first entry lands: show it anyway.
	if (active && !filter && !rows.some((c) => c.path === active))
		rows.unshift({ path: active, id: "", name: state.session?.sessionName || "new chat", firstUser: "", mtime: Date.now(), synthetic: true });
	list.replaceChildren();
	if (!rows.length) {
		list.append(el("div", "dim", filter ? "no match" : "no chats yet"));
		return;
	}
	let group = "";
	for (const chat of rows) {
		const label = groupLabel(chat.mtime);
		if (label !== group) {
			group = label;
			list.append(el("div", "chatGroup", label));
		}
		const row = el("div", `chatRow${chat.path === active ? " active" : ""}`);
		row.append(el("span", "title", chat.name));
		const acts = el("div", "acts");
		const rename = el("button", "icon-btn sm");
		rename.title = "Rename chat";
		rename.setAttribute("aria-label", `Rename ${chat.name}`);
		rename.append(icon("pencil"));
		rename.addEventListener("click", (ev) => {
			ev.stopPropagation();
			renameChat(chat);
		});
		acts.append(rename);
		if (chat.path !== active) {
			const del = el("button", "icon-btn sm del");
			del.title = "Delete chat";
			del.setAttribute("aria-label", `Delete ${chat.name}`);
			del.append(icon("trash"));
			del.addEventListener("click", (ev) => {
				ev.stopPropagation();
				deleteChat(chat);
			});
			acts.append(del);
		}
		row.append(acts);
		row.append(el("span", "time", timeAgo(chat.mtime)));
		row.title = `${chat.name}\n${chat.path}`;
		row.addEventListener("click", () => void switchChat(chat.path));
		list.append(row);
	}
}

async function switchChat(sessionPath) {
	try {
		await must({ type: "switch_session", sessionPath });
		closeModal();
		await bootstrap();
		await loadChats();
		toast("chat resumed — the runtime replays its context", "info");
	} catch (err) {
		notify(`switch failed: ${err.message ?? err}`);
	}
}

async function newChat() {
	try {
		await must({ type: "new_session" });
		closeModal();
		await bootstrap();
		await loadChats();
		$("input").focus();
	} catch (err) {
		notify(`new chat failed: ${err.message ?? err}`);
	}
}

function renameChat(chat) {
	openModal("rename chat", (box) => {
		const input = el("input");
		input.type = "text";
		input.value = chat.name;
		box.append(input);
		const foot = el("div", "foot");
		const ok = el("button", "primary", "save");
		const cancel = el("button", "ghost", "cancel");
		cancel.addEventListener("click", closeModal);
		ok.addEventListener("click", async () => {
			const name = input.value.trim();
			if (!name) return;
			try {
				await must({ type: "set_session_name", name });
				closeModal();
				await refreshState();
				await loadChats();
			} catch (err) {
				notify(`rename failed: ${err.message ?? err}`);
			}
		});
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") ok.click();
		});
		foot.append(cancel, ok);
		box.append(foot);
		input.focus();
		input.select();
	});
}

function deleteChat(chat) {
	openModal(`delete “${chat.name}”?`, (box) => {
		box.append(el("div", "pre", `${chat.path}\n\nDeletes this chat's transcript file from disk. Cannot be undone.`));
		const foot = el("div", "foot");
		const cancel = el("button", "ghost", "cancel");
		const del = el("button", "primary", "delete");
		cancel.addEventListener("click", closeModal);
		del.addEventListener("click", async () => {
			try {
				const res = await fetch(`/api/sessions?path=${encodeURIComponent(chat.path)}`, { method: "DELETE" }).then((r) => r.json());
				if (!res.ok) throw new Error(res.error ?? "delete failed");
				closeModal();
				await loadChats();
				toast(`deleted ${chat.name}`, "warn");
			} catch (err) {
				notify(`delete failed: ${err.message ?? err}`);
			}
		});
		foot.append(cancel, del);
		box.append(foot);
	});
}

// ---------------------------------------------------------------- live voice

function onLiveFrame(frame) {
	if (frame.type === "live_phase") {
		state.live.phase = frame.phase ?? "";
		if (frame.phase === "error") toast("live session error", "error");
	} else if (frame.type === "live_levels") {
		state.live.input = Number(frame.input ?? 0);
		state.live.output = Number(frame.output ?? 0);
	} else if (frame.type === "live_transcript") {
		state.live.turns.set(`${frame.role}:${frame.turn ?? 0}`, frame);
	} else if (frame.type === "live_end") {
		state.live.active = false;
		state.live.phase = "ended";
		state.live.input = 0;
		state.live.output = 0;
		if (frame.error) toast(`live ended: ${frame.error}`, "error");
	}
	renderLive();
}

function renderLive() {
	const active = state.live.active || state.live.phase === "listening" || state.live.phase === "working" || state.live.phase === "speaking";
	const btn = $("liveBtn");
	btn.classList.toggle("active", active);
	btn.setAttribute("aria-pressed", String(active));
	btn.setAttribute("aria-label", active ? `Live voice: ${state.live.phase || "on"} (click to stop)` : "Start live voice session");
	btn.title = active ? `live: ${state.live.phase || "on"}` : "Live voice (mic/speakers on the omp host)";
	btn.replaceChildren(icon(state.live.phase === "muted" ? "mic-off" : "mic"));
	const card = $("liveCard");
	card.classList.toggle("hidden", !active && state.live.turns.size === 0);
	const body = $("liveBody");
	body.replaceChildren();
	const bar = (label, value) => {
		const row = el("div", "liveRow");
		row.append(el("span", "lbl", label));
		const track = el("div", "liveBar");
		const fill = el("i");
		fill.style.transform = `scaleX(${Math.max(0, Math.min(1, value))})`;
		track.append(fill);
		row.append(track);
		return row;
	};
	body.append(bar("mic", state.live.input), bar("out", state.live.output));
	for (const turn of [...state.live.turns.values()].slice(-12)) {
		const node = el("div", `liveTurn ${turn.role}`);
		node.append(el("div", "who", `${turn.role}${turn.final ? "" : " …"}`));
		node.append(el("div", null, turn.text ?? ""));
		body.append(node);
	}
}

async function toggleLive() {
	const active = state.live.active || state.live.phase === "listening";
	if (active) {
		try {
			await cmd({ type: "live_stop" });
		} catch (err) {
			notify(`live stop failed: ${err.message ?? err}`);
		}
		state.live.active = false;
		renderLive();
		return;
	}
	state.live.active = true;
	state.live.phase = "connecting";
	state.live.turns.clear();
	renderLive();
	try {
		const frame = await cmd({ type: "live_start" }, 180000);
		if (frame?.success === false) throw new Error(frame.error ?? "live_start failed");
		toast(`live session started (voice ${frame?.data?.voice ?? "default"}); audio runs on the omp host`, "info");
	} catch (err) {
		state.live.active = false;
		state.live.phase = "";
		renderLive();
		notify(`live start failed: ${err.message ?? err}`);
	}
}

// ---------------------------------------------------------------- data refresh

async function refreshState() {
	try {
		const [s, stats] = await Promise.all([must({ type: "get_state" }), must({ type: "get_session_stats" }).catch(() => null)]);
		state.session = s;
		state.stats = stats;
		state.queue = { steering: s.queuedMessages?.steering ?? [], followUp: s.queuedMessages?.followUp ?? [] };
		state.busy = Boolean(s.isStreaming || s.isCompacting);
		renderHeader();
		renderTodos();
		renderQueue();
		renderGoal();
		renderWidgets();
		renderChats();
	} catch (err) {
		notify(`state refresh failed: ${err.message ?? err}`);
	}
}

async function refreshTranscript() {
	try {
		const data = await must({ type: "get_messages" });
		if (Array.isArray(data?.messages)) {
			setTranscript(data.messages);
			renderTranscript();
		}
	} catch (err) {
		notify(`transcript load failed: ${err.message ?? err}`);
	}
}

async function refreshSubagents() {
	try {
		const data = await must({ type: "get_subagents" });
		state.subagents = new Map((data?.subagents ?? []).map((row) => [row.id, row]));
		renderAgents();
	} catch {
		// subagent roster is optional
	}
}

async function bootstrap() {
	state.status = "loading session…";
	state.tools.clear();
	renderHeader();
	await Promise.all([
		refreshState(),
		refreshTranscript(),
		refreshSubagents(),
		loadChats(),
		must({ type: "get_available_commands" })
			.then((d) => {
				state.commands = d?.commands ?? [];
			})
			.catch(() => {}),
		must({ type: "get_available_models" })
			.then((d) => {
				state.models = d?.models ?? [];
			})
			.catch(() => {}),
		must({ type: "get_available_thinking_levels" })
			.then((d) => {
				state.levels = d?.levels ?? [];
			})
			.catch(() => {}),
	]);
	state.status = "";
	renderHeader();
}

// ---------------------------------------------------------------- modal + dialogs

function closeModal() {
	$("modalWrap").classList.add("hidden");
	$("modal").replaceChildren();
	modalOnClose?.();
	modalOnClose = null;
}

let modalOnClose = null;

function openModal(title, build, onClose) {
	const box = $("modal");
	box.replaceChildren();
	box.append(el("h2", null, title));
	build(box);
	modalOnClose = onClose ?? null;
	$("modalWrap").classList.remove("hidden");
	return box;
}

function modalList(items, onPick) {
	const list = el("div", "list");
	for (const item of items) {
		const row = el("div", "opt");
		row.append(el("span", null, item.label));
		if (item.sub) row.append(el("span", "sub", item.sub));
		if (item.hint) row.append(el("span", "sub", item.hint));
		row.addEventListener("click", () => onPick(item));
		list.append(row);
	}
	return list;
}

function withSearch(box, placeholder, repaint) {
	const input = el("input");
	input.type = "text";
	input.placeholder = placeholder;
	const holder = el("div");
	box.append(input, holder);
	repaint(holder, "");
	input.addEventListener("input", () => repaint(holder, input.value.toLowerCase()));
	input.focus();
}

function showModels() {
	openModal("model", (box) => {
		const paint = (holder, filter) => {
			holder.replaceChildren(
				modalList(
					state.models
						.filter((m) => !filter || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(filter))
						.slice(0, 400)
						.map((m) => ({ label: m.id, sub: m.name ?? "", hint: m.provider, value: m })),
					async (item) => {
						try {
							await must({ type: "set_model", provider: item.value.provider, modelId: item.value.id });
							closeModal();
							await refreshState();
						} catch (err) {
							notify(String(err.message ?? err));
						}
					},
				),
			);
		};
		withSearch(box, "filter models", paint);
	});
}

function showThinking() {
	openModal("thinking level", (box) => {
		box.append(
			modalList(
				(state.levels.length ? state.levels : ["off", "minimal", "low", "medium", "high", "xhigh", "max"]).map((l) => ({ label: l, value: l })),
				async (item) => {
					try {
						await must({ type: "set_thinking_level", level: item.value });
						closeModal();
						await refreshState();
					} catch (err) {
						notify(String(err.message ?? err));
					}
				},
			),
		);
	});
}

function showCommands(prefill) {
	openModal("commands", (box) => {
		box.append(
			el(
				"div",
				"pre",
				`Every command this session advertises (${state.commands.length}). Interactive-TUI-only built-ins such as /vibe are not dispatched over RPC and are not listed here.`,
			),
		);
		const paint = (holder, filter) => {
			holder.replaceChildren(
				modalList(
					state.commands
						.filter((c) => !filter || `${c.name} ${c.description ?? ""}`.toLowerCase().includes(filter))
						.map((c) => ({
							label: `/${c.name}`,
							sub: c.description ?? "",
							hint: c.input?.hint ?? (c.subcommands?.length ? `${c.subcommands.length} subcommands` : ""),
							value: c,
						})),
					async (item) => {
						closeModal();
						$("input").value = `/${item.value.name} `;
						$("input").focus();
					},
				),
			);
		};
		withSearch(box, `filter commands${prefill ? ` (${prefill})` : ""}`, paint);
	});
}

function showSessions() {
	openModal("sessions", async (box) => {
		const body = el("div");
		box.append(body);
		const foot = el("div", "foot");
		const newBtn = el("button", "primary", "new session");
		const refreshBtn = el("button", "ghost", "refresh");
		foot.append(refreshBtn, newBtn);
		box.append(foot);
		const load = async () => {
			body.replaceChildren(el("div", "dim", "loading…"));
			const res = await fetch("/api/sessions?limit=60").then((r) => r.json());
			const items = (res.sessions ?? []).map((s) => ({
				label: s.name,
				sub: `${new Date(s.mtime).toLocaleString()} · ${(s.bytes / 1024).toFixed(0)} KiB`,
				hint: s.path.endsWith(".jsonl") ? s.id.slice(0, 8) : "",
				value: s,
			}));
			body.replaceChildren(items.length ? modalList(items, pick) : el("div", "dim", "no sessions in this folder"));
		};
		const pick = async (item) => {
			await switchChat(item.value.path);
		};
		newBtn.addEventListener("click", async () => {
			await newChat();
		});
		refreshBtn.addEventListener("click", () => void load());
		await load();
	});
}

function showBtw() {
	openModal("/btw side question", (box) => {
		const input = el("textarea");
		input.placeholder = "ask beside the main turn (not added to history)";
		box.append(input);
		const foot = el("div", "foot");
		const send = el("button", "primary", "ask");
		foot.append(send);
		box.append(foot);
		input.focus();
		send.addEventListener("click", async () => {
			const question = input.value.trim();
			if (!question) return;
			closeModal();
			try {
				await must({ type: "btw", question });
			} catch (err) {
				notify(`btw failed: ${err.message ?? err}`);
			}
		});
	});
}

function onBtwRecord(record) {
	if (!record?.id) return;
	const prev = state.btw.get(record.id);
	let node = prev?.node;
	if (!node) {
		node = el("div", "msg system");
		node.append(el("div", "who", "btw"));
		node.append(el("div", "body"));
		node.append(el("div", "dim"));
		transcript().append(node);
	}
	const answer = (record.followUps?.length ? record.followUps.at(-1) : record) ?? record;
	node.querySelector(".body").textContent = `${record.question}\n${answer.answer ?? ""}`;
	node.querySelector(".dim").textContent = `status: ${answer.status ?? record.status}`;
	state.btw.set(record.id, { node, record });
	scrollDown();
}

function onBtwDelta(frame) {
	const entry = state.btw.get(frame.recordId);
	if (!entry) return;
	entry.node.querySelector(".body").textContent += frame.delta ?? "";
	scrollDown();
}

// ---------------------------------------------------------------- extension UI requests

const uiQueue = [];

function onUIRequest(req) {
	switch (req.method) {
		case "notify":
			toast(`${req.message ?? ""}`, req.level === "error" ? "error" : req.level === "warning" ? "warn" : "info");
			return;
		case "setStatus":
			state.status = req.status ?? "";
			renderHeader();
			return;
		case "setWidget":
			state.widgets.set(req.widgetKey, req.text ?? req.lines ?? null);
			renderWidgets();
			return;
		case "setTitle":
			document.title = req.title ?? "omp webchat";
			return;
		case "set_editor_text":
			$("input").value = req.text ?? "";
			return;
		case "open_url":
			toast(req.instructions ?? "open this URL", "info", req.launchUrl ?? req.url);
			return;
		case "cancel":
			for (const pending of [...uiQueue]) if (pending.req.id === req.targetId) pending.cancel();
			return;
		default:
			uiQueue.push({ req, cancel: () => closeModal() });
			ping("ask", "omp needs your answer", `${req.method}: ${req.title ?? req.message ?? ""}`.slice(0, 160));
			if (uiQueue.length === 1) presentNextUIRequest();
	}
}

function uiRespond(frame) {
	ws.send(JSON.stringify({ type: "extension_ui_response", ...frame }));
}

function presentNextUIRequest() {
	const head = uiQueue[0];
	if (!head) return;
	const { req } = head;
	let timer = null;
	const done = (response) => {
		uiRespond({ id: req.id, ...response });
		clearTimeout(timer);
		uiQueue.shift();
		closeModal();
		if (uiQueue.length) setTimeout(presentNextUIRequest, 50);
	};
	head.cancel = () => done({ cancelled: true });
	if (req.timeout) timer = setTimeout(() => done({ cancelled: true, timedOut: true }), req.timeout);

	if (req.method === "ask") {
		openModal(req.title ?? "agent question", (box) => {
			const answers = new Map();
			for (const q of req.questions ?? []) {
				const wrap = el("div", "q");
				wrap.append(el("div", null, `${q.header ? `${q.header}: ` : ""}${q.question}`));
				const list = el("div", "list");
				const selected = new Set();
				for (const [i, opt] of (q.options ?? []).entries()) {
					const row = el("div", "opt");
					row.append(el("span", null, opt.label));
					if (opt.description) row.append(el("span", "sub", opt.description));
					row.addEventListener("click", () => {
						if (q.multi) {
							if (selected.has(opt.label)) selected.delete(opt.label);
							else selected.add(opt.label);
							row.style.borderLeft = selected.has(opt.label) ? "2px solid var(--accent)" : "";
						} else {
							selected.clear();
							selected.add(opt.label);
							for (const other of list.children) other.style.borderLeft = "";
							row.style.borderLeft = "2px solid var(--accent)";
						}
						answers.set(q.id, { id: q.id, selectedOptions: [...selected] });
					});
					list.append(row);
				}
				wrap.append(list);
				const custom = el("input");
				custom.type = "text";
				custom.placeholder = "or type your own answer";
				custom.addEventListener("input", () => answers.set(q.id, { id: q.id, selectedOptions: [...selected], customInput: custom.value }));
				wrap.append(custom);
				box.append(wrap);
			}
			const foot = el("div", "foot");
			const ok = el("button", "primary", "submit");
			ok.addEventListener("click", () =>
				done({ answers: (req.questions ?? []).map((q) => answers.get(q.id) ?? { id: q.id, selectedOptions: [] }) }),
			);
			foot.append(ok);
			box.append(foot);
		});
		return;
	}

	if (req.method === "select") {
		openModal(req.title ?? "select", (box) => {
			if (req.message) box.append(el("div", "pre", req.message));
			box.append(
				modalList(
					(req.options ?? []).map((label, i) => ({ label, sub: req.optionDetails?.[i]?.description ?? "", value: label })),
					(item) => done({ value: item.value }),
				),
			);
			const foot = el("div", "foot");
			const cancel = el("button", "ghost", "cancel");
			cancel.addEventListener("click", () => done({ cancelled: true }));
			foot.append(cancel);
			box.append(foot);
		});
		return;
	}

	if (req.method === "confirm") {
		openModal(req.title ?? "confirm", (box) => {
			box.append(el("div", "pre", req.message ?? ""));
			const foot = el("div", "foot");
			const no = el("button", "ghost", "no");
			const yes = el("button", "primary", "yes");
			no.addEventListener("click", () => done({ confirmed: false }));
			yes.addEventListener("click", () => done({ confirmed: true }));
			foot.append(no, yes);
			box.append(foot);
		});
		return;
	}

	openModal(req.title ?? req.method, (box) => {
		box.append(el("div", "pre", req.message ?? req.placeholder ?? ""));
		const input = req.method === "editor" ? el("textarea") : el("input");
		if (input.tagName === "INPUT") input.type = "text";
		if (req.placeholder) input.placeholder = req.placeholder;
		box.append(input);
		input.focus();
		const foot = el("div", "foot");
		const cancel = el("button", "ghost", "cancel");
		const ok = el("button", "primary", "ok");
		cancel.addEventListener("click", () => done({ cancelled: true }));
		ok.addEventListener("click", () => done({ value: input.value }));
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" && input.tagName === "INPUT") done({ value: input.value });
		});
		foot.append(cancel, ok);
		box.append(foot);
	});
}

// ---------------------------------------------------------------- popovers

let popoverAnchor = null;
let popoverWidth = 380;
const TOUCH_ONLY = () => matchMedia("(hover: none) and (pointer: coarse)").matches;

function closePopover() {
	const box = $("popover");
	if (box.classList.contains("hidden")) return;
	box.classList.add("hidden");
	box.replaceChildren();
	popoverAnchor?.setAttribute("aria-expanded", "false");
	popoverAnchor = null;
}

/** Keep an open picker anchored to its trigger across keyboard/viewport resizes. */
function positionPopover() {
	const box = $("popover");
	if (!popoverAnchor || box.classList.contains("hidden")) return;
	const vv = window.visualViewport;
	const viewW = vv?.width ?? window.innerWidth;
	const viewH = vv?.height ?? window.innerHeight;
	const offX = vv?.offsetLeft ?? 0;
	const offY = vv?.offsetTop ?? 0;
	const width = Math.max(200, Math.min(popoverWidth, viewW - 16));
	box.style.width = `${width}px`;
	const anchor = popoverAnchor.getBoundingClientRect();
	const spaceAbove = anchor.top - offY - 12;
	const spaceBelow = offY + viewH - anchor.bottom - 12;
	// Prefer opening upward (composer sits at the bottom), but never off-screen.
	const placeAbove = spaceAbove >= Math.min(260, Math.max(spaceBelow, 0));
	const available = Math.max(160, Math.min(placeAbove ? spaceAbove : spaceBelow, viewH - 24));
	box.style.maxHeight = `${available}px`;
	const height = box.offsetHeight;
	const left = Math.min(Math.max(offX + 8, anchor.left), offX + viewW - width - 8);
	const top = placeAbove ? anchor.top - height - 10 : anchor.bottom + 10;
	box.style.left = `${left}px`;
	box.style.top = `${Math.max(offY + 8, Math.min(top, offY + viewH - height - 8))}px`;
}

/** Anchored picker above its trigger (the composer row sits at the bottom of the viewport). */
function openPickerPopover(anchor, { title, placeholder, items, onPick, width }) {
	closePopover();
	const box = $("popover");
	const head = el("div", "menu-head", title);
	const field = el("div", "field");
	field.append(icon("search"));
	const input = el("input");
	input.type = "text";
	input.placeholder = placeholder ?? "filter…";
	input.setAttribute("aria-label", placeholder ?? title);
	field.append(input);
	const list = el("div", "list");
	box.append(head, field, list);
	const paint = (filter) => {
		list.replaceChildren();
		const rows = items.filter((it) => !filter || `${it.label} ${it.sub ?? ""} ${it.hint ?? ""}`.toLowerCase().includes(filter)).slice(0, 400);
		if (!rows.length) list.append(el("div", "opt dim", items.length ? "no match" : "loading…"));
		for (const it of rows) {
			const row = el("div", "opt");
			row.append(el("span", null, it.label));
			if (it.sub) row.append(el("span", "sub", it.sub));
			if (it.hint) row.append(el("span", "count", it.hint));
			row.addEventListener("click", () => {
				closePopover();
				onPick(it);
			});
			list.append(row);
		}
	};
	input.addEventListener("input", () => paint(input.value.toLowerCase()));
	paint("");
	box.classList.remove("hidden");
	popoverWidth = width ?? 380;
	positionPopover();
	// Second pass after layout/scrollbar settle: the first measurement can be pre-layout.
	requestAnimationFrame(() => positionPopover());
	anchor.setAttribute("aria-expanded", "true");
	popoverAnchor = anchor;
	// On narrow/touch screens never summon the soft keyboard: it would reflow the picker.
	if (!TOUCH_ONLY() && window.innerWidth > 900) input.focus();
	else list.querySelector(".opt")?.scrollIntoView({ block: "nearest" });
}

async function showModelPicker(anchor) {
	const open = () =>
		openPickerPopover(anchor, {
			title: "model",
			placeholder: "filter models…",
			width: 460,
			items: state.models.map((m) => ({ label: m.id, sub: m.name ?? "", hint: m.provider, value: m })),
			onPick: async (item) => {
				try {
					await must({ type: "set_model", provider: item.value.provider, modelId: item.value.id });
					await refreshState();
					toast(`model → ${item.value.id}`, "info");
				} catch (err) {
					notify(`model switch failed: ${err.message ?? err}`);
				}
			},
		});
	if (state.models.length) {
		open();
		return;
	}
	// First tap before discovery finished: show the picker immediately, then fill it in.
	open();
	try {
		const data = await must({ type: "get_available_models" });
		state.models = data?.models ?? [];
	} catch (err) {
		notify(`model list failed: ${err.message ?? err}`);
	}
	if (popoverAnchor === anchor) open();
}

function showEffortPicker(anchor) {
	const levels = state.levels.length ? state.levels : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	openPickerPopover(anchor, {
		title: "reasoning effort",
		placeholder: "filter…",
		width: 280,
		items: levels.map((l) => ({ label: l, hint: l === state.session?.thinkingLevel ? "current" : "", value: l })),
		onPick: async (item) => {
			try {
				await must({ type: "set_thinking_level", level: item.value });
				await refreshState();
			} catch (err) {
				notify(`effort switch failed: ${err.message ?? err}`);
			}
		},
	});
}

// ---------------------------------------------------------------- notifications

const NOTIFY_KEY = "omp-webchat.notify";

function loadNotifyPrefs() {
	try {
		const raw = localStorage.getItem(NOTIFY_KEY);
		if (raw) state.notify = { ...state.notify, ...JSON.parse(raw) };
	} catch {
		// storage unavailable: keep defaults
	}
	state.notify.permission = "Notification" in window ? Notification.permission : "unsupported";
	renderBell();
}

function saveNotifyPrefs() {
	try {
		localStorage.setItem(NOTIFY_KEY, JSON.stringify({ enabled: state.notify.enabled, sound: state.notify.sound }));
	} catch {
		// storage unavailable: preference is session-only
	}
}

function renderBell() {
	const btn = $("bellBtn");
	const on = state.notify.enabled && state.notify.permission !== "unsupported";
	btn.setAttribute("aria-pressed", String(on));
	const label = state.notify.permission === "unsupported" ? "Desktop notifications unavailable" : `Desktop notifications: ${on ? "on" : "off"}`;
	btn.setAttribute("aria-label", label);
	btn.title = state.notify.permission === "denied" ? "Notifications blocked in the browser" : label;
	btn.replaceChildren(icon(state.notify.enabled ? "bell" : "bell-off"));
}

async function toggleNotifications() {
	if (!("Notification" in window)) {
		toast("this browser has no Notification API", "warn");
		return;
	}
	state.notify.enabled = !state.notify.enabled;
	state.notify.permission = Notification.permission;
	if (state.notify.enabled && state.notify.permission === "default") {
		// Do not block the toggle on the prompt: some contexts never resolve it.
		void Notification.requestPermission().then((permission) => {
			state.notify.permission = permission;
			renderBell();
			if (permission !== "granted") toast("desktop notifications are blocked — in-page alerts and the chime still work", "warn");
		});
	}
	saveNotifyPrefs();
	renderBell();
	toast(
		state.notify.enabled
			? state.notify.permission === "granted"
				? "notifications on — finished turns, questions and approvals will ping you"
				: "notifications on for this page; desktop banners await browser permission"
			: "notifications off",
		state.notify.enabled ? "info" : "warn",
	);
	if (state.notify.enabled) ping("test", "omp webchat", "notifications are on");
}

let titleTimer = null;
const BASE_TITLE = document.title;

function flashTitle(text) {
	if (!document.hidden) return;
	document.title = `● ${text}`;
	clearTimeout(titleTimer);
	titleTimer = setTimeout(() => {
		document.title = BASE_TITLE;
	}, 15000);
}

function chime(kind) {
	try {
		const Ctx = window.AudioContext ?? window.webkitAudioContext;
		if (!Ctx) return;
		const ctx = new Ctx();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		const notes = { done: [660, 990], ask: [520, 780], error: [400, 300], test: [880, 880] };
		const [a, b] = notes[kind] ?? notes.done;
		osc.type = "sine";
		osc.frequency.setValueAtTime(a, ctx.currentTime);
		osc.frequency.setValueAtTime(b, ctx.currentTime + 0.12);
		gain.gain.setValueAtTime(0.0001, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
		osc.connect(gain).connect(ctx.destination);
		osc.start();
		osc.stop(ctx.currentTime + 0.4);
		osc.addEventListener("ended", () => void ctx.close());
	} catch {
		// audio unavailable: silently skip
	}
}

/** Alert for something the user must act on (finished turn, question, approval, error). */
function ping(kind, title, body) {
	if (!state.notify.enabled) return;
	const away = document.hidden || !document.hasFocus();
	if (kind !== "test" && !away) return;
	if (away && state.notify.permission === "granted") {
		try {
			const n = new Notification(title, { body, tag: `omp-webchat-${kind}`, silent: true });
			n.addEventListener("click", () => {
				window.focus();
				n.close();
			});
		} catch {
			// notification constructor unavailable (e.g. some mobile browsers)
		}
	}
	if (state.notify.sound) chime(kind);
	if (away) flashTitle(title);
}

// ---------------------------------------------------------------- composer

function renderAttachments() {
	const box = $("attachments");
	box.replaceChildren();
	state.images.forEach((img, i) => {
		const wrap = el("div", "att");
		const node = el("img");
		node.src = `data:${img.mimeType};base64,${img.data}`;
		wrap.append(node);
		const del = el("button", null, "×");
		del.addEventListener("click", () => {
			state.images.splice(i, 1);
			renderAttachments();
		});
		wrap.append(del);
		box.append(wrap);
	});
}

function addFiles(files) {
	for (const file of files) {
		if (!file.type.startsWith("image/")) continue;
		const reader = new FileReader();
		reader.addEventListener("load", () => {
			const url = String(reader.result);
			state.images.push({ type: "image", mimeType: file.type, data: url.slice(url.indexOf(",") + 1) });
			renderAttachments();
		});
		reader.readAsDataURL(file);
	}
}

/** The runtime advertises every command it can actually dispatch; anything else falls through as prose. */
function unknownCommand(text) {
	if (state.commands.length === 0) return null;
	const match = /^\/([^\s/]+)/.exec(text);
	if (!match) return null;
	const name = match[1];
	const known = state.commands.some((c) => c.name === name || (c.aliases ?? []).includes(name));
	return known ? null : name;
}

function promptUnknownCommand(text, name) {
	openModal(`/${name} is not a command here`, (box) => {
		box.append(
			el(
				"div",
				"pre",
				`This session advertises ${state.commands.length} commands and /${name} is not one of them.\n\n` +
					"Some omp built-ins are interactive-TUI only (for example /vibe, /theme, /hotkeys). The runtime does not conceal " +
					"them from RPC — an unknown spelling falls through as ordinary prompt text, which the model then reads as a message.",
			),
		);
		const foot = el("div", "foot");
		const cancel = el("button", "ghost", "cancel");
		const send = el("button", "primary", "send as message");
		cancel.addEventListener("click", () => {
			closeModal();
			$("input").focus();
		});
		send.addEventListener("click", () => {
			closeModal();
			void submit(true);
		});
		foot.append(cancel, send);
		box.append(foot);
	});
}

async function submit(skipCommandCheck = false) {
	const input = $("input");
	const text = input.value.trim();
	if (!text && !state.images.length) return;
	if (!skipCommandCheck) {
		if (state.commands.length === 0) {
			// A prompt typed before bootstrap finished must still be checked against the real list.
			const data = await must({ type: "get_available_commands" }).catch(() => null);
			if (data?.commands) state.commands = data.commands;
		}
		const unknown = unknownCommand(text);
		if (unknown) {
			appendSystemRow(`/${unknown} is not an available command in this session (TUI-only commands are not dispatched over RPC)`, "system");
			promptUnknownCommand(text, unknown);
			return;
		}
	}
	const images = state.images.length ? [...state.images] : undefined;
	const command = { type: "prompt", message: text };
	if (images) command.images = images;
	if (state.busy) command.streamingBehavior = $("steerBox").checked ? "steer" : "followUp";
	state.lastSentText = text;
	input.value = "";
	state.images = [];
	renderAttachments();
	renderPalette();
	if (!state.busy && text) pushOptimistic(text);
	try {
		let frame = await cmd(command);
		if (frame?.success === false && /already processing/i.test(String(frame.error))) {
			// Admission raced our stale busy flag: queue explicitly instead of failing.
			frame = await cmd({ ...command, streamingBehavior: $("steerBox").checked ? "steer" : "followUp" });
			state.busy = true;
		}
		if (frame?.success === false) notify(`prompt rejected: ${frame.error}`);
		else if (frame?.data?.agentInvoked === false) void refreshState();
	} catch (err) {
		notify(`prompt failed: ${err.message ?? err}`);
	}
}

async function abort() {
	try {
		if (state.retrying) await cmd({ type: "abort_retry" }).catch(() => {});
		const data = await must({ type: "abort_and_restore_queue" });
		const restored = [...(data?.steering ?? []), ...(data?.followUp ?? [])];
		if (restored.length) {
			$("input").value = restored.map((m) => m.text).join("\n");
			state.images.push(...restored.flatMap((m) => m.images ?? []));
			renderAttachments();
		}
		toast(`aborted${restored.length ? `, restored ${restored.length} queued message(s)` : ""}`, "warn");
	} catch (err) {
		notify(`abort failed: ${err.message ?? err}`);
	}
}

function renderPalette() {
	const box = $("palette");
	const value = $("input").value;
	const match = /^\/(\S*)$/.exec(value.trimStart());
	if (!match) return box.classList.add("hidden");
	const filter = match[1].toLowerCase();
	const items = state.commands.filter((c) => !filter || c.name.toLowerCase().includes(filter)).slice(0, 60);
	if (!items.length) return box.classList.add("hidden");
	box.replaceChildren();
	box.dataset.index = "0";
	items.forEach((c, i) => {
		const row = el("div", `item ${i === 0 ? "sel" : ""}`);
		row.append(el("span", "n", `/${c.name}`));
		row.append(el("span", "d", c.description ?? ""));
		row.append(el("span", "s", c.input?.hint ?? c.source ?? ""));
		row.addEventListener("click", () => {
			$("input").value = `/${c.name} `;
			box.classList.add("hidden");
			$("input").focus();
		});
		box.append(row);
	});
	box.classList.remove("hidden");
}

function paletteMove(delta) {
	const box = $("palette");
	if (box.classList.contains("hidden")) return;
	const rows = [...box.children];
	const index = Math.max(0, Math.min(rows.length - 1, Number(box.dataset.index ?? 0) + delta));
	box.dataset.index = String(index);
	rows.forEach((row, i) => row.classList.toggle("sel", i === index));
	rows[index].scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- wiring

$("input").addEventListener("input", () => {
	renderPalette();
	const node = $("input");
	node.style.height = "auto";
	node.style.height = `${Math.min(node.scrollHeight, window.innerHeight * 0.4)}px`;
});

$("input").addEventListener("keydown", (ev) => {
	if (ev.key === "Enter" && !ev.shiftKey) {
		ev.preventDefault();
		void submit();
		return;
	}
	if (ev.key === "Escape") {
		ev.preventDefault();
		void abort();
		return;
	}
	if (ev.key === "Tab" && !$("palette").classList.contains("hidden")) {
		ev.preventDefault();
		$("palette").querySelector(".item.sel")?.click();
		return;
	}
	if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
		if (!$("palette").classList.contains("hidden")) {
			ev.preventDefault();
			paletteMove(ev.key === "ArrowDown" ? 1 : -1);
		}
	}
});

document.addEventListener("keydown", (ev) => {
	if (ev.key !== "Escape") return;
	if (!$("popover").classList.contains("hidden")) {
		ev.preventDefault();
		closePopover();
		return;
	}
	if (!$("modalWrap").classList.contains("hidden")) {
		ev.preventDefault();
		closeModal();
		return;
	}
	if ($("app").classList.contains("side-open")) {
		toggleSidebar(false);
		return;
	}
	if (state.drawer.open) {
		closeDrawer();
		return;
	}
	if (document.activeElement !== $("input")) {
		ev.preventDefault();
		void abort();
	}
});

// Viewport/keyboard changes reposition an open picker instead of dismissing it.
const onViewportChange = () => {
	if (popoverAnchor) positionPopover();
	if (window.innerWidth > 900) {
		toggleSidebar(false);
		backdrop(state.drawer.open);
	}
};
window.addEventListener("resize", onViewportChange);
window.addEventListener("orientationchange", onViewportChange);
window.visualViewport?.addEventListener("resize", onViewportChange);
window.visualViewport?.addEventListener("scroll", onViewportChange);

$("sendBtn").addEventListener("click", () => void submit());
$("stopBtn").addEventListener("click", () => void abort());
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (ev) => addFiles(ev.target.files ?? []));
$("newChatBtn").addEventListener("click", () => void newChat());
$("refreshChatsBtn").addEventListener("click", () => void loadChats());
$("chatSearch").addEventListener("input", () => renderChats());
$("sessionBtn").addEventListener("click", () => showSessions());
$("commandsBtn").addEventListener("click", () => showCommands());
$("modelBtn").addEventListener("click", (ev) => {
	if (popoverAnchor === ev.currentTarget) {
		closePopover();
		return;
	}
	showModelPicker(ev.currentTarget);
});
$("thinkingBtn").addEventListener("click", (ev) => {
	if (popoverAnchor === ev.currentTarget) {
		closePopover();
		return;
	}
	showEffortPicker(ev.currentTarget);
});
$("btwBtn").addEventListener("click", () => {
	closePopover();
	showBtw();
});
$("bellBtn").addEventListener("click", () => void toggleNotifications());
$("moreBtn").addEventListener("click", (ev) => {
	const menu = $("moreMenu");
	const open = menu.classList.contains("hidden");
	menu.classList.toggle("hidden", !open);
	$("moreBtn").setAttribute("aria-expanded", String(open));
	if (open) ev.stopPropagation();
});
$("moreMenu").addEventListener("click", (ev) => {
	const row = ev.target.closest(".menu-row");
	if (row && row.id !== "btwBtn") ev.stopPropagation();
});
$("exportBtn").addEventListener("click", async () => {
	closePopover();
	$("moreMenu").classList.add("hidden");
	try {
		const text = state.messages
			.map((m) => `${m.role === "assistant" ? "omp" : m.role}\n${contentText(m.content)}`)
			.join("\n\n―――――\n\n");
		await navigator.clipboard.writeText(text);
		toast("transcript copied to clipboard", "info");
	} catch (err) {
		notify(`copy failed: ${err.message ?? err}`);
	}
});
$("restartBtn").addEventListener("click", async () => {
	$("moreMenu").classList.add("hidden");
	await fetch("/api/restart", { method: "POST" }).catch(() => {});
	toast("restarting omp…", "warn");
});
$("restartServerBtn").addEventListener("click", async () => {
	$("moreMenu").classList.add("hidden");
	await fetch("/api/restart?full=1", { method: "POST" }).catch(() => {});
	toast("webchat server restarting — the page reconnects in a moment", "warn");
	let back = false;
	for (let i = 0; i < 20 && !back; i++) {
		await new Promise((resolve) => setTimeout(resolve, 700));
		back = await fetch("/api/info", { cache: "no-store" })
			.then((r) => r.ok)
			.catch(() => false);
	}
	if (back) location.reload();
	else toast("server did not come back — start it again manually", "error");
});
document.addEventListener("click", (ev) => {
	const menu = $("moreMenu");
	if (!menu.classList.contains("hidden") && !menu.contains(ev.target) && !$("moreBtn").contains(ev.target)) {
		menu.classList.add("hidden");
		$("moreBtn").setAttribute("aria-expanded", "false");
	}
	const pop = $("popover");
	if (!pop.classList.contains("hidden") && !pop.contains(ev.target) && !popoverAnchor?.contains(ev.target)) closePopover();
});
$("scroll").addEventListener("scroll", () => closePopover(), { passive: true });
// Tapping the anchor again closes; a tap inside the popover (or on the filter input) must not.
document.addEventListener("pointerdown", (ev) => {
	const pop = $("popover");
	if (pop.classList.contains("hidden")) return;
	if (pop.contains(ev.target) || popoverAnchor?.contains(ev.target)) return;
	closePopover();
});

$("sidebarToggle").addEventListener("click", () => toggleSidebar());
$("backdrop").addEventListener("click", () => {
	toggleSidebar(false);
	if (state.drawer.open) closeDrawer();
});
$("agentsBtn").addEventListener("click", () => (state.drawer.open ? closeDrawer() : openDrawer()));
$("agentsCloseBtn").addEventListener("click", () => closeDrawer());
$("agentsRefreshBtn").addEventListener("click", () => void refreshSubagents());
$("agentTranscriptClose").addEventListener("click", () => closeAgentTranscript());
$("agentTailBtn").addEventListener("click", (ev) => {
	state.drawer.tail = !state.drawer.tail;
	ev.currentTarget.setAttribute("aria-pressed", String(state.drawer.tail));
});
$("liveBtn").addEventListener("click", () => void toggleLive());
$("liveMuteBtn").addEventListener("click", async () => {
	try {
		const frame = await cmd({ type: "live_mute" });
		if (frame?.success === false) throw new Error(frame.error);
		const muted = Boolean(frame?.data?.muted);
		const btn = $("liveMuteBtn");
		btn.replaceChildren(icon(muted ? "mic-off" : "mic"));
		btn.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
		toast(`microphone ${muted ? "muted" : "unmuted"}`, "info");
	} catch (err) {
		notify(`live mute failed: ${err.message ?? err}`);
	}
});
$("modalWrap").addEventListener("click", (ev) => {
	if (ev.target === $("modalWrap")) closeModal();
});
$("input").addEventListener("paste", (ev) => {
	const files = [...(ev.clipboardData?.items ?? [])]
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter(Boolean);
	if (files.length) {
		ev.preventDefault();
		addFiles(files);
	}
});
$("input").addEventListener("dragover", (ev) => ev.preventDefault());
$("input").addEventListener("drop", (ev) => {
	ev.preventDefault();
	addFiles(ev.dataTransfer?.files ?? []);
});

$("fastBtn").addEventListener("click", async () => {
	try {
		await must({ type: "set_fast_mode", enabled: !state.session?.fastModeEnabled });
		await refreshState();
	} catch (err) {
		notify(String(err.message ?? err));
	}
});
$("slowBtn").addEventListener("click", async () => {
	try {
		await must({ type: "set_slow_mode", enabled: !state.session?.slowModeEnabled });
		await refreshState();
	} catch (err) {
		notify(String(err.message ?? err));
	}
});
$("compactBtn").addEventListener("click", async () => {
	try {
		await must({ type: "set_auto_compaction", enabled: !state.session?.autoCompactionEnabled });
		await refreshState();
	} catch (err) {
		notify(String(err.message ?? err));
	}
});
$("warmingBtn").addEventListener("click", async () => {
	const modes = ["off", "streaming", "idle"];
	const next = modes[(modes.indexOf($("warmingBtn").dataset.mode ?? "off") + 1) % modes.length];
	try {
		const data = await must({ type: "set_cache_warming", mode: next });
		$("warmingBtn").dataset.mode = data?.mode ?? next;
		renderHeader();
	} catch (err) {
		notify(String(err.message ?? err));
	}
});

loadNotifyPrefs();
renderHeader();
renderWelcome();
connectSocket();
