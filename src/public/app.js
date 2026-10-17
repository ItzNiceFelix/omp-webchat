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
};

// ---------------------------------------------------------------- helpers

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

function inline(s) {
	return s
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
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
				return `<pre class="code"${lang ? ` data-lang="${lang}"` : ""}><code>${code}</code></pre>`;
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
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);

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

ws.addEventListener("open", () => {
	state.connected = true;
	$("conn").className = "dot mid";
});
ws.addEventListener("close", () => {
	state.connected = false;
	$("conn").className = "dot";
	appendSystemRow("websocket closed — reload to reconnect", "error");
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
			if (frame.status === "error") notify(`turn error: ${frame.error?.message ?? "unknown"}`, "error");
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
		node.innerHTML = md(block.text ?? "");
	} else if (block.type === "thinking") {
		node.querySelector(".body").textContent = block.thinking ?? "";
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
	const box = transcript();
	box.scrollTop = box.scrollHeight;
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
	scrollDown();
}

function userBubble(msg) {
	const node = el("div", "msg user");
	node.append(el("div", "who", "you"));
	const body = el("div", "blocks");
	blocksToNodes(msg.content, body);
	node.append(body);
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

function pushOptimistic(text) {
	const node = el("div", "msg user dim");
	node.dataset.optimistic = text;
	node.append(el("div", "who", "you"));
	node.append(el("div", "blocks", text));
	transcript().append(node);
	scrollDown();
}

function dropOptimistic(msg) {
	const text = contentText(msg.content);
	for (const node of transcript().querySelectorAll("[data-optimistic]")) {
		if (node.dataset.optimistic === text) node.remove();
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
	status.className = `status pill ${entry.status === "running" ? "running" : entry.isError ? "error" : entry.status ? "ok" : ""}`;
	status.textContent =
		entry.status === "running"
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
	$("sessionBtn").textContent = s.sessionName ? s.sessionName.slice(0, 24) : "session";
	$("modelBtn").textContent = s.model?.id ? String(s.model.id).slice(0, 30) : "model";
	$("thinkingBtn").textContent = `think:${s.thinkingLevel ?? "?"}`;
	$("fastBtn").className = `chip ${s.fastModeActive ? "active" : ""}`;
	$("slowBtn").className = `chip ${s.slowModeEnabled && s.slowModeSupported ? "active" : ""}`;
	$("compactBtn").className = `chip ${s.autoCompactionEnabled ? "active" : ""}`;
	$("ctx").textContent = s.contextUsage ? `ctx ${s.contextUsage.percent?.toFixed?.(1) ?? "?"}% (${s.contextUsage.tokens}/${s.contextUsage.contextWindow})` : "ctx –";
	$("tps").textContent = s.tokensPerSecond ? `${Number(s.tokensPerSecond).toFixed(1)} tok/s` : "";
	$("stopBtn").disabled = !state.busy;
	$("sendBtn").textContent = state.busy ? ($("steerBox").checked ? "steer" : "queue") : "send";
	$("hint").textContent = state.busy ? "agent busy" : s.isSettled === false ? "background work pending" : "";
	const meta = $("sessionMeta");
	meta.replaceChildren();
	const rows = [
		["cwd", state.cwd],
		["session", s.sessionFile ? s.sessionFile.split(/[\\/]/).pop() : "–"],
		["messages", String(s.messageCount ?? state.messages.length)],
		["model", s.model?.id ?? "–"],
		["thinking", `${s.thinkingLevel ?? "?"}${s.fastModeActive ? " · fast" : ""}${s.slowModeSupported && s.slowModeEnabled ? " · slow" : ""}`],
	];
	if (state.stats) rows.push(["tokens", `${state.stats.tokens?.total ?? 0} · $${Number(state.stats.cost ?? 0).toFixed(4)}`]);
	if (s.usageLimit) rows.push(["limit", `${s.usageLimit.stage}${s.usageLimit.resetsAtSec ? ` · resets ${new Date(s.usageLimit.resetsAtSec * 1000).toLocaleTimeString()}` : ""}`]);
	for (const [k, v] of rows) {
		meta.append(el("dt", null, k));
		meta.append(el("dd", null, String(v)));
	}
	$("statusLine").textContent = state.status;
	renderPalette();
}

function renderTodos() {
	const phases = state.session?.todoPhases;
	const card = $("todoCard");
	if (!phases?.length) return card.classList.add("hidden");
	card.classList.remove("hidden");
	const body = $("todoBody");
	body.replaceChildren();
	for (const phase of phases) {
		const open = phase.tasks.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked").length;
		body.append(el("div", "phase", `${phase.name} · ${phase.tasks.length - open}/${phase.tasks.length}`));
		for (const task of phase.tasks) {
			const cls = task.status === "completed" ? "done" : task.status === "in_progress" ? "active" : task.status === "blocked" ? "blocked" : "";
			const row = el("div", `task ${cls}`);
			const mark = { pending: "•", in_progress: "▶", completed: "✓", abandoned: "✕", blocked: "!" }[task.status] ?? "?";
			row.append(el("span", "mark", mark));
			row.append(el("span", null, `${task.content}${task.blocker ? ` — ${task.blocker}` : ""}`));
			body.append(row);
		}
	}
}

function renderQueue() {
	const { steering, followUp } = state.queue;
	const card = $("queueCard");
	if (!steering.length && !followUp.length) return card.classList.add("hidden");
	card.classList.remove("hidden");
	const body = $("queueBody");
	body.replaceChildren();
	const row = (text, queue) => {
		const item = el("div", "queued");
		item.append(el("span", "txt", text));
		const promote = el("button", null, "↑");
		promote.title = "promote to steering";
		promote.addEventListener("click", async () => {
			try {
				await must({ type: "promote_queued_message", message: text });
			} catch (err) {
				notify(String(err.message ?? err));
			}
		});
		const remove = el("button", null, "×");
		remove.title = "remove";
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
	const box = el("div", "agent");
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
	if (row.task ?? row.activity) box.append(el("div", "sub", String(row.task ?? row.activity).replace(/\s+/g, " ").slice(0, 200)));
	const acts = el("div", "acts");
	const view = el("button", null, "transcript");
	view.addEventListener("click", () => void showSubagentTranscript(row));
	acts.append(view);
	if (row.status === "running") {
		const steer = el("button", null, "steer");
		steer.addEventListener("click", async () => {
			const text = prompt(`steer ${row.id}:`);
			if (!text) return;
			try {
				await must({ type: "steer_subagent", subagentId: row.id, message: text });
				toast(`steered ${row.id}`, "info");
			} catch (err) {
				notify(String(err.message ?? err));
			}
		});
		const kill = el("button", null, "kill");
		kill.addEventListener("click", async () => {
			if (!confirm(`kill ${row.id}?`)) return;
			try {
				await must({ type: "cancel_subagent", subagentId: row.id });
			} catch (err) {
				notify(String(err.message ?? err));
			}
		});
		acts.append(steer, kill);
	}
	box.append(acts);
	return box;
}

function renderAgents() {
	const card = $("agentsCard");
	const rows = [...state.subagents.values()];
	$("agentCount").textContent = rows.length ? `(${rows.length})` : "";
	if (!rows.length) return card.classList.add("hidden");
	card.classList.remove("hidden");
	const body = $("agentsBody");
	body.replaceChildren();
	for (const row of rows) body.append(agentRowNode(row));
	for (const callId of state.agentSlots.keys()) renderAgentSlot(callId);
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
			try {
				await must({ type: "switch_session", sessionPath: item.value.path });
				closeModal();
				await bootstrap();
			} catch (err) {
				notify(String(err.message ?? err));
			}
		};
		newBtn.addEventListener("click", async () => {
			try {
				await must({ type: "new_session" });
				closeModal();
				await bootstrap();
			} catch (err) {
				notify(String(err.message ?? err));
			}
		});
		refreshBtn.addEventListener("click", () => void load());
		await load();
	});
}

async function showSubagentTranscript(row) {
	openModal(`agent ${row.id}`, (box) => {
		const pre = el("pre", "pre", "loading…");
		box.append(pre);
	});
	try {
		const data = await must({ type: "get_subagent_messages", subagentId: row.id });
		const lines = (data?.messages ?? []).map((m) => {
			const who = m.role === "assistant" ? "omp" : m.role === "user" ? "→agent" : m.role === "toolResult" ? `[${m.toolName}]` : m.role;
			return `── ${who}\n${contentText(m.content)}`;
		});
		$("modal").querySelector("pre").textContent = lines.join("\n\n") || "(no messages yet)";
	} catch (err) {
		$("modal").querySelector("pre").textContent = String(err.message ?? err);
	}
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

async function submit() {
	const input = $("input");
	const text = input.value.trim();
	if (!text && !state.images.length) return;
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
	$("input").style.height = "auto";
	$("input").style.height = `${Math.min($("input").scrollHeight, window.innerHeight * 0.4)}px`;
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
	if (ev.key === "Escape") {
		if (!$("modalWrap").classList.contains("hidden")) {
			ev.preventDefault();
			closeModal();
			return;
		}
		if (document.activeElement !== $("input")) {
			ev.preventDefault();
			void abort();
		}
	}
});

$("sendBtn").addEventListener("click", () => void submit());
$("stopBtn").addEventListener("click", () => void abort());
$("commandsBtn").addEventListener("click", () => showCommands());
$("btwBtn").addEventListener("click", () => showBtw());
$("modelBtn").addEventListener("click", () => showModels());
$("thinkingBtn").addEventListener("click", () => showThinking());
$("sessionBtn").addEventListener("click", () => showSessions());
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (ev) => addFiles(ev.target.files ?? []));
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
		$("warmingBtn").textContent = `warm:${data?.mode ?? next}`;
	} catch (err) {
		notify(String(err.message ?? err));
	}
});

renderHeader();
