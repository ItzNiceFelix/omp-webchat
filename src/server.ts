#!/usr/bin/env bun
/**
 * omp-webchat server.
 *
 * Dumb by design: it spawns `omp --mode rpc` (JSONL over stdio), pipes every frame to
 * browser clients over WebSocket, pipes client commands back to stdin, and serves the UI.
 * All session logic lives in the browser client and in the runtime's own RPC projections.
 *
 * ponytail: one child process = one omp session shared by every connected tab.
 * Upgrade path: a process pool keyed by session dir, if multi-session tabs are ever needed.
 */
import type { ServerWebSocket } from "bun";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Frames on the wire are opaque JSON objects; only the routing keys are validated. */
type Frame = Record<string, unknown> & { type?: unknown; id?: unknown };
type Socket = ServerWebSocket<{ id: string }>;

const argv = Bun.argv.slice(2);
const BOOL_FLAGS: Record<string, true> = { open: true, selftest: true, "no-defaults": true };
const VALUE_FLAGS: Record<string, true> = { cwd: true, port: true, host: true, omp: true };
const opts: Record<string, string | true> = {};
const ompArgs: string[] = [];

for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--") {
		ompArgs.push(...argv.slice(i + 1));
		break;
	}
	if (!arg.startsWith("--")) {
		ompArgs.push(arg);
		continue;
	}
	const eq = arg.indexOf("=");
	const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
	let value: string | true = true;
	if (eq >= 0) value = arg.slice(eq + 1);
	else if (VALUE_FLAGS[name] && i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
	if (BOOL_FLAGS[name] || VALUE_FLAGS[name]) opts[name] = value;
	else ompArgs.push(arg);
}

const CWD = resolve(String(opts.cwd ?? process.cwd()));
const PORT = Number(opts.port ?? Bun.env.OMP_WEBCHAT_PORT ?? 7788);
const HOST = String(opts.host ?? "127.0.0.1");
const OMP_BIN = String(opts.omp ?? Bun.which("omp") ?? "omp");
/** Vite build output of `web/` (`npm run build` there); the server never builds it itself. */
const WEB_DIR = join(import.meta.dir, "..", "web", "dist");
const INDEX_FILE = join(WEB_DIR, "index.html");
/** Settings overlay applied to the child unless the caller brings their own --config. */
const DEFAULT_CONFIG = join(import.meta.dir, "defaults.yml");
const SESSIONS_ROOT = join(Bun.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "sessions");
/** Scratch root for `webchat://` reads/writes: plugin-owned, outside node_modules. */
const DATA_DIR = join(Bun.env.PI_CONFIG_DIR ?? join(homedir(), ".omp"), "plugins", "data", "omp-webchat");

// ---------------------------------------------------------------- child process

const clients = new Map<string, Socket>();
const waiters = new Map<string, (frame: Frame) => void>();
let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
let childSeq = 0;
let shuttingDown = false;
let respawnDelay = 1000;

function send(ws: Socket, frame: Frame) {
	try {
		ws.send(JSON.stringify(frame));
	} catch {
		// socket already gone
	}
}

function broadcast(frame: Frame) {
	const text = JSON.stringify(frame);
	for (const ws of clients.values()) {
		try {
			ws.send(text);
		} catch {
			// socket already gone
		}
	}
}

function writeRpc(frame: Frame) {
	if (!child) return false;
	child.stdin.write(`${JSON.stringify(frame)}\n`);
	child.stdin.flush();
	return true;
}

function rpc(command: Frame & { type: string }, timeoutMs = 60_000): Promise<Frame> {
	const id = `wx:${++childSeq}`;
	const { promise, resolve: settle, reject } = Promise.withResolvers<Frame>();
	const timer = setTimeout(() => {
		waiters.delete(id);
		reject(new Error(`rpc timeout: ${command.type}`));
	}, timeoutMs);
	waiters.set(id, (frame) => {
		clearTimeout(timer);
		settle(frame);
	});
	if (!writeRpc({ id, ...command })) {
		clearTimeout(timer);
		waiters.delete(id);
		reject(new Error("omp child is not running"));
	}
	return promise;
}

// Lossless protocol v2 framing: oversized logical frames arrive as `rpc_chunk` sequences.
const chunkSets = new Map<string, { count: number; parts: string[]; got: number }>();

function handleObject(frame: Frame) {
	if (frame.type === "ready") respawnDelay = 1000;
	if (frame.type === "host_tool_call") {
		try {
			onHostToolCall(frame);
		} catch (err) {
			completeHostTool(frame.id, `host tool failed: ${String(err)}`, true);
		}
		return;
	}
	if (frame.type === "host_uri_request") {
		void onHostUriRequest(frame).catch((err) => {
			writeRpc({ type: "host_uri_result", id: frame.id, isError: true, error: String(err) });
		});
		return;
	}
	if (frame.type === "host_tool_cancel" || frame.type === "host_uri_cancel") return;
	if (typeof frame.id !== "string") {
		broadcast(frame);
		return;
	}
	const waiter = waiters.get(frame.id);
	if (waiter) {
		waiters.delete(frame.id);
		waiter(frame);
		return;
	}
	const owner = clients.get(frame.id.split(":")[0]);
	if (owner) send(owner, frame);
	else broadcast(frame);
}

function reassembleChunk(frame: Frame) {
	const id = String(frame.chunkId);
	const count = Number(frame.count);
	const index = Number(frame.index);
	let set = chunkSets.get(id);
	if (!set || set.count !== count) {
		set = { count, parts: new Array(count), got: 0 };
		chunkSets.set(id, set);
	}
	if (!Number.isInteger(index) || index < 0 || index >= count || typeof frame.data !== "string") {
		chunkSets.delete(id);
		broadcast({ type: "wx:log", level: "error", text: `malformed rpc_chunk for ${id}` });
		return;
	}
	set.parts[index] = frame.data;
	set.got++;
	if (set.got < count) return;
	chunkSets.delete(id);
	try {
		const bytes = Buffer.from(set.parts.join(""), "base64");
		handleObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	} catch (err) {
		broadcast({ type: "wx:log", level: "error", text: `chunk reassembly failed: ${String(err)}` });
	}
}

function handleLine(line: string) {
	if (!line.trim()) return;
	try {
		const frame = JSON.parse(line) as Frame;
		if (frame.type === "rpc_chunk") reassembleChunk(frame);
		else handleObject(frame);
	} catch (err) {
		// A bridge must survive a handler bug: report it and keep the session alive.
		broadcast({ type: "wx:log", level: "error", text: `frame handling failed: ${String(err)}` });
	}
}

async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void) {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		onText(decoder.decode(value, { stream: true }));
	}
}

function spawnOmp() {
	if (shuttingDown || child) return;
	// rpc-ui = extension UI *and* tool UI: tool dialogs, approvals, and the `ask` tool are
	// mounted only in this mode (`--mode rpc` mounts 11 tools, `rpc-ui` mounts ask as well).
	const extra: string[] = [];
	const hasConfig = ompArgs.some((a) => a === "--config" || a.startsWith("--config="));
	if (!opts["no-defaults"] && !hasConfig && existsSync(DEFAULT_CONFIG)) extra.push("--config", DEFAULT_CONFIG);
	const cmd = [OMP_BIN, "--mode", "rpc-ui", ...extra, ...ompArgs];
	// This server may itself run under `BUN_BE_BUN=1 omp`; the child must be a real omp, not bun.
	const env = { ...Bun.env };
	delete env.BUN_BE_BUN;
	const proc = Bun.spawn(cmd, { cwd: CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
	child = proc;
	broadcast({ type: "wx:child", status: "starting", bin: OMP_BIN, args: cmd.slice(1), cwd: CWD });

	let outBuffer = "";
	void pump(proc.stdout, (text) => {
		outBuffer += text;
		let nl = outBuffer.indexOf("\n");
		while (nl >= 0) {
			handleLine(outBuffer.slice(0, nl));
			outBuffer = outBuffer.slice(nl + 1);
			nl = outBuffer.indexOf("\n");
		}
	});

	const errDecoder = new TextDecoder();
	void pump(proc.stderr, (text) => {
		const combined = `${errDecoder.decode()}${text}`;
		if (combined.trim()) broadcast({ type: "wx:log", level: "stderr", text: combined.trimEnd().slice(-2000) });
	});

	void proc.exited.then((code) => {
		if (child !== proc) return;
		child = null;
		outBuffer = "";
		chunkSets.clear();
		for (const [id, waiter] of waiters) {
			waiters.delete(id);
			waiter({ type: "wx:dead" });
		}
		broadcast({ type: "wx:child", status: "exited", code });
		if (!shuttingDown && clients.size > 0) {
			respawnDelay = Math.min(respawnDelay * 2, 10_000);
			setTimeout(spawnOmp, respawnDelay);
		}
	});

	void rpc({ type: "negotiate_protocol", protocolVersion: 2 }, 10_000).catch(() => {});
	void rpc({ type: "set_subagent_subscription", level: "events" }, 10_000).catch(() => {});
	void rpc({ type: "set_ask_dialog", enabled: true }, 10_000).catch(() => {});
	void rpc({ type: "set_host_tools", tools: HOST_TOOLS }, 10_000).catch(() => {});
	void rpc(
		{
			type: "set_host_uri_schemes",
			schemes: [{ scheme: "webchat", description: "webchat scratch files (text, under the plugin data dir)", writable: true, immutable: false }],
		},
		10_000,
	).catch(() => {});
}

// ---------------------------------------------------------------- host-owned tools + URIs

/**
 * Tools the browser side answers. Registered with `set_host_tools`; the runtime calls back
 * here (not into the browser), so results are ordinary tool results for the model.
 */
const HOST_TOOLS = [
	{
		name: "webchat_card",
		label: "Render Card",
		description: "Render a card (title + markdown body) in the user's webchat transcript. Use for plans, comparisons, tables, or diagrams the user should read as a card rather than prose.",
		parameters: {
			type: "object",
			properties: { title: { type: "string" }, body: { type: "string", description: "markdown" } },
			required: ["title", "body"],
			additionalProperties: false,
		},
	},
	{
		name: "webchat_open_url",
		label: "Open In Browser",
		description: "Open a URL in the user's default browser (the machine running webchat).",
		parameters: {
			type: "object",
			properties: { url: { type: "string" } },
			required: ["url"],
			additionalProperties: false,
		},
	},
	{
		name: "webchat_copy",
		label: "Copy To Clipboard",
		description: "Put text on the user's clipboard (the browser running webchat). Use for snippets the user would otherwise have to select by hand.",
		parameters: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
			additionalProperties: false,
		},
	},
	{
		name: "webchat_present_file",
		label: "Present File",
		description: "Show a file as a downloadable row in the webchat transcript. The path is relative to the webchat data dir (same root as `webchat://`), e.g. a report the agent just wrote there.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "file under the webchat data dir" },
				name: { type: "string", description: "download name (default: the file's basename)" },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
] as const;

/** Raw bytes cross the wire as base64 inside one frame: keep them small enough to be lossless. */
const MAX_PRESENT_BYTES = 8 * 1024 * 1024;

const FILE_MIME: Record<string, string> = {
	".json": "application/json",
	".md": "text/markdown",
	".txt": "text/plain",
	".html": "text/html",
	".csv": "text/csv",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".zip": "application/zip",
};

function mimeFor(name: string) {
	const dot = name.lastIndexOf(".");
	return (dot > 0 ? FILE_MIME[name.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
}

function completeHostTool(id: unknown, text: string, isError = false) {
	if (typeof id !== "string") return;
	writeRpc({ type: "host_tool_result", id, isError, result: { content: [{ type: "text", text }] } });
}

function onHostToolCall(frame: Frame) {
	const name = String(frame.toolName ?? "");
	const args = (frame.arguments ?? {}) as Record<string, unknown>;
	if (name === "webchat_card") {
		const title = String(args.title ?? "card");
		const body = String(args.body ?? "");
		broadcast({ type: "wx:card", title, body });
		completeHostTool(frame.id, `card "${title}" rendered in the webchat transcript`);
		return;
	}
	if (name === "webchat_open_url") {
		const url = String(args.url ?? "");
		if (!/^https?:\/\//i.test(url)) {
			completeHostTool(frame.id, `refusing to open non-http(s) url: ${url}`, true);
			return;
		}
		const opener =
			process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: process.platform === "darwin"
					? ["open", url]
					: ["xdg-open", url];
		Bun.spawn(opener, { stdio: ["ignore", "ignore", "ignore"] }).unref();
		completeHostTool(frame.id, `opened ${url} in the default browser`);
		return;
	}
	if (name === "webchat_copy") {
		const text = String(args.text ?? "");
		broadcast({ type: "wx:copy", text });
		completeHostTool(frame.id, `copied ${text.length} characters into the browser clipboard`);
		return;
	}
	if (name === "webchat_present_file") {
		void presentFile(frame.id, args).catch((err) => completeHostTool(frame.id, `host tool failed: ${String(err)}`, true));
		return;
	}
	completeHostTool(frame.id, `unknown host tool: ${name}`, true);
}

/** `webchat_present_file`: hand the browser raw bytes; it renders a download row in the transcript. */
async function presentFile(id: unknown, args: Record<string, unknown>) {
	const rel = typeof args.path === "string" ? args.path : "";
	const full = dataPath(rel);
	if (!full) {
		completeHostTool(id, `path escapes the webchat data dir: ${rel}`, true);
		return;
	}
	const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : basename(full);
	try {
		const info = await stat(full);
		if (!info.isFile()) {
			completeHostTool(id, `not a file: ${rel}`, true);
			return;
		}
		if (info.size > MAX_PRESENT_BYTES) {
			completeHostTool(id, `refusing to present ${name}: ${Math.round(info.size / 1024)} KiB is over the 8 MiB limit`, true);
			return;
		}
		const bytes = await readFile(full);
		broadcast({ type: "wx:file", name, mimeType: mimeFor(name), bytes: bytes.byteLength, data: bytes.toString("base64") });
		completeHostTool(id, `file "${name}" (${Math.round(bytes.byteLength / 1024)} KiB) presented in the webchat transcript with a download button`);
	} catch (err) {
		completeHostTool(id, `cannot present ${rel}: ${String(err)}`, true);
	}
}

/** `webchat://<path>` reads and writes text files under the plugin's data root. */
function dataPath(rel: string) {
	const full = resolve(join(DATA_DIR, rel));
	return full.startsWith(DATA_DIR + sep) ? full : null;
}

async function onHostUriRequest(frame: Frame) {
	const id = frame.id;
	const url = String(frame.url ?? "");
	const rel = url.replace(/^webchat:\/\//i, "").replace(/^\/+/, "");
	const full = dataPath(rel) ?? "";
	if (!full) {
		writeRpc({ type: "host_uri_result", id, isError: true, error: `path escapes webchat:// root: ${url}` });
		return;
	}
	if (frame.operation === "write") {
		try {
			await mkdir(dirname(full), { recursive: true });
			await writeFile(full, String(frame.content ?? ""), "utf8");
			writeRpc({ type: "host_uri_result", id });
		} catch (err) {
			writeRpc({ type: "host_uri_result", id, isError: true, error: String(err) });
		}
		return;
	}
	try {
		const text = await readFile(full, "utf8");
		const contentType = full.endsWith(".json") ? "application/json" : full.endsWith(".md") ? "text/markdown" : "text/plain";
		writeRpc({ type: "host_uri_result", id, content: text, contentType });
	} catch (err) {
		writeRpc({ type: "host_uri_result", id, isError: true, error: `cannot read ${url}: ${String(err)}` });
	}
}

// ---------------------------------------------------------------- session listing

/**
 * Canonical-cwd bucket, spelled exactly like the runtime spells it: `-<relative>` under home
 * (`-` for home itself), `-tmp` for the temp root and `-tmp-<relative>` below it, and
 * `--<encoded>--` for anything else. The separator is only added when there IS a relative
 * part: `-tmp-` sent `/tmp` to a directory that never exists, which is what made the session
 * list empty for a checkout under the temp root.
 */
function bucketFor(cwd: string) {
	const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "");
	const enc = (p: string) => p.replace(/[\\/:]/g, "-");
	const home = norm(homedir());
	const temp = norm(Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp");
	const c = norm(cwd).toLowerCase();
	const rel = (root: string) => {
		const tail = norm(cwd).slice(root.length).replace(/^[\\/]+/, "");
		return tail ? `-${enc(tail)}` : "";
	};
	if (c === home.toLowerCase() || c.startsWith(`${home.toLowerCase()}/`) || c.startsWith(`${home.toLowerCase()}\\`)) return `-${enc(norm(cwd).slice(home.length))}`;
	if (c === temp.toLowerCase()) return `-tmp`;
	if (c.startsWith(`${temp.toLowerCase()}/`) || c.startsWith(`${temp.toLowerCase()}\\`)) return `-tmp${rel(temp)}`;
	return `--${enc(norm(cwd))}--`;
}

/** The two header lines the runtime writes, plus the first user prompt as a label fallback. */
interface SessionHead {
	title: string;
	id: string;
	cwd: string;
	firstUser: string;
}

/**
 * Line 1 is the padded title slot, line 2 the `type: "session"` header that records id and
 * cwd. The cwd lookup in `listSessions` reads this header — reading it from the title line
 * always came back empty, so the fallback could never adopt a differently spelled bucket.
 */
async function readSessionHead(path: string): Promise<SessionHead> {
	const handle = await open(path, "r");
	try {
		const buf = Buffer.alloc(16_384);
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
		const head: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(lines[0] ?? "");
			if (parsed && typeof parsed === "object") Object.assign(head, parsed as Record<string, unknown>);
		} catch {
			// header slot is a fixed-width title field in some versions; label falls back to text
		}
		for (const line of lines.slice(1, 8)) {
			if (!line.startsWith('{"type":"session"')) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (parsed && typeof parsed === "object") Object.assign(head, parsed as Record<string, unknown>);
			} catch {
				// partial line at the read boundary
			}
			break;
		}
		let firstUser = "";
		for (const line of lines) {
			if (!line.includes('"role":"user"')) continue;
			try {
				const entry = JSON.parse(line) as { message?: { content?: Array<{ type?: string; text?: string }> } };
				const block = entry.message?.content?.find((b) => b?.type === "text" && b.text);
				if (block?.text) {
					firstUser = block.text;
					break;
				}
			} catch {
				// partial line at the read boundary
			}
		}
		return {
			title: typeof head.title === "string" ? head.title : "",
			id: typeof head.id === "string" ? head.id : "",
			cwd: typeof head.cwd === "string" ? head.cwd : "",
			firstUser,
		};
	} finally {
		await handle.close();
	}
}

/** `.jsonl` names in one bucket directory; a missing or unreadable directory is simply empty. */
async function jsonlNames(dir: string) {
	return (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl"));
}

/** A sidebar row: the runtime's store fields plus the bucket `scope=all` clients group by. */
interface SessionRow {
	path: string;
	id: string;
	name: string;
	firstUser: string;
	titled: boolean;
	bytes: number;
	mtime: number;
	/** the bucket directory the file lives in, spelled as the runtime spells it */
	bucket: string;
	/** cwd recorded in the session header — the project the chat belongs to */
	project: string;
	/** short label for the bucket: `-tmp` → `tmp`, a homedir-relative path shows as-is */
	folder: string;
}

/** One session file → a sidebar row. Unreadable and vanished files come back null and are skipped. */
async function sessionRow(dir: string, name: string): Promise<SessionRow | null> {
	const path = join(dir, name);
	try {
		const info = await stat(path);
		const head = await readSessionHead(path);
		const label = head.title || head.firstUser.split("\n")[0] || "Untitled";
		const bucket = basename(dir);
		// the encoding replaces `/\:` with `-` and is not reversible, so only the marker goes;
		// `-` on its own is the home directory, which has no relative path to show
		const folder = bucket.replace(/^-+|-+$/g, "") || "~";
		return {
			path,
			id: head.id || name.replace(/\.jsonl$/, ""),
			name: label.replace(/[\u0000-\u001f]/g, "").slice(0, 120),
			firstUser: head.firstUser.slice(0, 300),
			titled: Boolean(head.title),
			bytes: info.size,
			mtime: info.mtimeMs,
			bucket,
			project: head.cwd,
			folder,
		};
	} catch {
		return null;
	}
}

/** Every session row of one bucket directory, newest first, unreadable files dropped. */
async function bucketRows(bucket: string) {
	const dir = join(SESSIONS_ROOT, bucket);
	const names = await jsonlNames(dir);
	const rows = await Promise.all(names.map((name) => sessionRow(dir, name)));
	return rows.filter((row) => row !== null).sort((a, b) => b.mtime - a.mtime);
}

async function listSessions(limit: number) {
	let dir = join(SESSIONS_ROOT, bucketFor(CWD));
	let names = await jsonlNames(dir);
	if (names.length === 0) {
		// Fallback: a platform spelling this build does not predict (Windows temp root, a
		// relocated home): adopt the bucket whose newest session header records our cwd.
		for (const candidate of (await readdir(SESSIONS_ROOT).catch(() => [] as string[])).reverse()) {
			const probe = join(SESSIONS_ROOT, candidate);
			const files = (await jsonlNames(probe)).sort().reverse();
			if (files.length === 0) continue;
			const head = await readSessionHead(join(probe, files[0])).catch(() => null);
			if (head?.cwd && resolve(head.cwd) === CWD) {
				dir = probe;
				names = files;
				break;
			}
		}
	}
	const rows = await Promise.all(names.map((name) => sessionRow(dir, name)));
	return rows.filter((row) => row !== null).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** `scope=all`: every bucket under the sessions root, not just this cwd's, merged newest first. */
async function listAllSessions(limit: number) {
	const buckets = await readdir(SESSIONS_ROOT).catch(() => [] as string[]);
	return (await Promise.all(buckets.map(bucketRows))).flat().sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** A malformed title header is the caller's fault (400); I/O failures are ours (500). */
class SessionHeaderError extends Error {}

/**
 * Rewrite the fixed-width title header in place. Line 1 is padded to a constant byte width and
 * every later offset (artifact paths, `fromByte` tails) depends on it, so the rewrite refills the
 * `pad` string to the identical length — and shortens the title when it no longer fits.
 */
async function renameSession(path: string, name: string) {
	const handle = await open(path, "r+");
	try {
		const head = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(head, 0, head.length, 0);
		const nl = head.subarray(0, bytesRead).indexOf(0x0a);
		if (nl < 0) throw new SessionHeaderError("session file has no header line");
		const width = nl + 1; // the trailing newline is part of the fixed width we must reproduce
		let header: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(head.subarray(0, nl).toString("utf8"));
			header = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		} catch {
			throw new SessionHeaderError("first line is not a JSON header");
		}
		if (header.type !== "title") throw new SessionHeaderError("first line is not a title header");
		// spread keeps the original key order, so only the values change on disk
		const base = { ...header, title: name, source: "manual", updatedAt: new Date().toISOString(), pad: "" };
		const json = (title: string) => JSON.stringify({ ...base, title });
		const target = width - 1; // bytes of JSON text the line has room for
		let title = name;
		// pad is spaces, so a dropped title char buys exactly one pad char back
		while (title && Buffer.byteLength(json(title)) > target) title = title.slice(0, -1);
		if (!title) throw new SessionHeaderError("header line is too small for a title");
		const line = `${JSON.stringify({ ...base, title, pad: " ".repeat(target - Buffer.byteLength(json(title))) })}\n`;
		if (Buffer.byteLength(line) !== width) throw new Error("rename would resize the header line");
		await handle.write(line, 0, "utf8");
		return title;
	} finally {
		await handle.close();
	}
}

// ---------------------------------------------------------------- uploads

/** Upload bodies sit in memory, so the cap is also what a single request may cost the server. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/**
 * A client-supplied `name` → one safe basename. Both separators are cut (a Windows-shaped
 * `..\..\evil` must not survive as a single segment), control characters go, and a name over the
 * 120-char cap keeps its extension so the type of the stored file still reads off its name.
 */
function uploadName(raw: string) {
	const base = (raw.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop() ?? "").trim();
	if (!base || /^\.+$/.test(base)) return "";
	if (base.length <= 120) return base;
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 && base.length - dot <= 32 ? base.slice(dot) : "";
	return (ext ? base.slice(0, dot) : base).slice(0, 120 - ext.length) + ext;
}

/** The client's `content-type` only counts when it is a media type; else sniff the extension. */
function uploadMime(hint: string | null, name: string) {
	const type = (hint ?? "").split(";")[0].trim().toLowerCase();
	return /^[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : mimeFor(name);
}

/**
 * `POST /api/upload?name=<file name>`: raw body → `uploads/<yyyyMMdd-HHmmss>-<name>` under the
 * data root. That tree is what `webchat://` resolves against, so the URI handed back is readable
 * by the agent (and by `webchat_present_file`) with no further registration.
 */
async function saveUpload(req: Request, url: URL) {
	const name = uploadName(url.searchParams.get("name") ?? "");
	if (!name) return Response.json({ ok: false, error: "name must be a file name" }, { status: 400 });
	// the declared length is checked first, so an oversized body is refused without buffering it
	const declared = Number(req.headers.get("content-length") ?? 0);
	if (declared > MAX_UPLOAD_BYTES) return Response.json({ ok: false, error: "file is larger than 16 MiB" }, { status: 413 });
	let body: Uint8Array;
	try {
		body = new Uint8Array(await req.arrayBuffer());
	} catch (err) {
		return Response.json({ ok: false, error: String(err) }, { status: 500 });
	}
	// a chunked upload declares no length, so the bytes in hand are the authority
	if (body.byteLength > MAX_UPLOAD_BYTES) return Response.json({ ok: false, error: "file is larger than 16 MiB" }, { status: 413 });
	if (body.byteLength === 0) return Response.json({ ok: false, error: "empty body" }, { status: 400 });
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const file = `${stamp}-${name}`;
	const dest = dataPath(join("uploads", file));
	if (!dest) return Response.json({ ok: false, error: `name escapes the uploads dir: ${name}` }, { status: 400 });
	try {
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, body);
	} catch (err) {
		return Response.json({ ok: false, error: String(err) }, { status: 500 });
	}
	return Response.json({ ok: true, uri: `webchat://uploads/${file}`, name, bytes: body.byteLength, mimeType: uploadMime(req.headers.get("content-type"), name) });
}

// ---------------------------------------------------------------- http + ws

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".wasm": "application/wasm",
};

/** `web/dist` is a build output: a missing bundle is an operator problem, not a 404. */
const MISSING_UI = `<!doctype html>
<meta charset="utf-8">
<title>omp-webchat: web/dist is missing</title>
<body style="font:15px/1.6 system-ui,sans-serif;margin:12vh auto;max-width:34rem;color:#e2e8f0;background:#0f172a">
<h1 style="font-size:1.15rem">web/dist is missing</h1>
<p>The browser client is not built. From the plugin directory run:</p>
<pre>cd web &amp;&amp; npm install &amp;&amp; npm run build</pre>
<p>then reload this page.</p>
</body>
`;

/** Map a URL path to a file under `web/dist`; only `/` and real files, no SPA catch-all. */
function serverFile(pathname: string) {
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	if (!rel || rel.includes("..")) return null;
	const full = resolve(join(WEB_DIR, rel));
	return full.startsWith(WEB_DIR + sep) ? full : null;
}

/** DNS-rebinding + cross-site-WebSocket defence for `/ws` and `/api/*`. */
function guardCaller(req: Request) {
	const { host } = splitAuthority(req.headers.get("host") ?? "");
	if (!sameHostname(host)) return Response.json({ ok: false, error: "host not allowed" }, { status: 403 });
	const origin = req.headers.get("origin");
	if (!origin) return null; // no-Origin (curl, same-origin navigation) is fine when Host checks out
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return Response.json({ ok: false, error: "origin not allowed" }, { status: 403 });
	}
	if (!sameHostname(parsed.hostname) || (parsed.port && parsed.port !== String(PORT)))
		return Response.json({ ok: false, error: "origin not allowed" }, { status: 403 });
	return null;
}

function sameHostname(host: string) {
	const name = host.toLowerCase();
	// HOST is whatever we bound to (127.0.0.1 by default); loopback aliases are always allowed
	return name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "[::1]" || name === HOST.toLowerCase();
}

/** Split an authority (Host header, or URL host) into hostname and port; IPv6 literals keep their brackets. */
function splitAuthority(value: string) {
	const v = value.trim();
	if (v.startsWith("[")) {
		const end = v.indexOf("]");
		if (end < 0) return { host: "", port: "" };
		return { host: v.slice(0, end + 1), port: v.slice(end + 1).replace(/^:/, "") };
	}
	const first = v.indexOf(":");
	const last = v.lastIndexOf(":");
	// a colon that is not the sole one is a bare IPv6 literal, not a port separator
	if (last < 0 || first !== last) return { host: v, port: "" };
	return { host: v.slice(0, last), port: v.slice(last + 1) };
}

// A full restart relaunches this process while the old one still holds the port.
const bootDelay = Number(Bun.env.OMP_WEBCHAT_BOOT_DELAY ?? 0);
if (bootDelay > 0) await Bun.sleep(bootDelay);

const server = Bun.serve<{ id: string }>({
	hostname: HOST,
	port: PORT,
	idleTimeout: 255, // matches the harness gateway: long model turns must not idle out
	async fetch(req, srv) {
		const url = new URL(req.url);
		// Browsers send Origin for cross-site fetches and WebSocket upgrades; the API is loopback-only.
		if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
			const denied = guardCaller(req);
			if (denied) return denied;
		}
		if (url.pathname === "/ws") {
			const id = `c${Date.now().toString(36)}${clients.size}`;
			if (srv.upgrade(req, { data: { id } })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		}
		if (url.pathname === "/api/info") {
			return Response.json({
				cwd: CWD,
				omp: OMP_BIN,
				args: ["--mode", "rpc-ui", ...ompArgs],
				child: child ? { status: "running", pid: child.pid } : { status: "stopped" },
				sessionsRoot: SESSIONS_ROOT,
				dataDir: DATA_DIR,
				hostTools: HOST_TOOLS.map((tool) => tool.name),
				bucket: bucketFor(CWD),
			});
		}
		if (url.pathname === "/api/sessions") {
			if (req.method === "PATCH") {
				const target = resolve(url.searchParams.get("path") ?? "");
				if (!target.startsWith(`${SESSIONS_ROOT}${sep}`) || !target.endsWith(".jsonl"))
					return Response.json({ ok: false, error: "path is outside the session store" }, { status: 400 });
				if (!(await stat(target).catch(() => null))?.isFile())
					return Response.json({ ok: false, error: "no such session file" }, { status: 404 });
				const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
				if (typeof body?.name !== "string") return Response.json({ ok: false, error: "name must be a string" }, { status: 400 });
				// control chars would break the JSONL framing and the sidebar rendering
				const name = body.name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
				if (!name) return Response.json({ ok: false, error: "name must not be empty" }, { status: 400 });
				if (name.length > 120) return Response.json({ ok: false, error: "name must be at most 120 characters" }, { status: 400 });
				try {
					return Response.json({ ok: true, name: await renameSession(target, name) });
				} catch (err) {
					const status = err instanceof SessionHeaderError ? 400 : 500;
					return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status });
				}
			}
			if (req.method === "DELETE") {
				const target = resolve(url.searchParams.get("path") ?? "");
				if (!target.startsWith(`${SESSIONS_ROOT}${sep}`) || !target.endsWith(".jsonl"))
					return Response.json({ ok: false, error: "path is outside the session store" }, { status: 400 });
				const info = await stat(target).catch(() => null);
				if (!info?.isFile()) return Response.json({ ok: false, error: "no such session file" }, { status: 404 });
				try {
					await unlink(target);
					const artifacts = target.slice(0, -".jsonl".length);
					if ((await stat(artifacts).catch(() => null))?.isDirectory()) await rm(artifacts, { recursive: true, force: true });
				} catch (err) {
					return Response.json({ ok: false, error: String(err) }, { status: 500 });
				}
				return Response.json({ ok: true, deleted: target });
			}
			// `scope=all` crosses project folders; anything else keeps the cwd-bucket surface
			const raw = url.searchParams.get("limit");
			if (url.searchParams.get("scope") !== "all") return Response.json({ sessions: await listSessions(Number(raw ?? 40)) });
			const given = raw === null || raw.trim() === "" ? NaN : Number(raw);
			// absent or unparsable means the documented 200; a given limit is clamped to 1..500
			const limit = Number.isFinite(given) ? Math.min(Math.max(Math.trunc(given), 1), 500) : 200;
			return Response.json({ sessions: await listAllSessions(limit) });
		}
		if (url.pathname === "/api/upload" && req.method === "POST") return saveUpload(req, url);
		if (url.pathname === "/api/restart" && req.method === "POST") {
			if (url.searchParams.get("full") === "1") {
				// Relaunch this exact server (argv preserved) after the port is released.
				const self = Bun.spawn([process.execPath, ...Bun.argv.slice(1)], {
					cwd: process.cwd(),
					env: { ...Bun.env, OMP_WEBCHAT_BOOT_DELAY: "900" },
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
					windowsHide: true,
				});
				self.unref();
				shuttingDown = true;
				child?.kill();
				setTimeout(() => process.exit(0), 250);
				return Response.json({ ok: true, restarting: "server", pid: self.pid });
			}
			child?.kill();
			setTimeout(spawnOmp, 200);
			return Response.json({ ok: true, restarting: "omp" });
		}
		const file = serverFile(url.pathname);
		if (!file) return new Response("not found", { status: 404 });
		const blob = Bun.file(file);
		if (!(await blob.exists()))
			return file === INDEX_FILE
				? new Response(MISSING_UI, { status: 503, headers: { "content-type": MIME[".html"], "cache-control": "no-store" } })
				: new Response("not found", { status: 404 });
		return new Response(blob, {
			headers: {
				"content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
				// vite content-hashes everything it emits under assets/, so those may be cached forever
				"cache-control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
			},
		});
	},
	websocket: {
		open(ws) {
			clients.set(ws.data.id, ws);
			if (!child) spawnOmp();
			send(ws, { type: "wx:hello", clientId: ws.data.id, cwd: CWD, omp: OMP_BIN, args: ompArgs, child: child ? "running" : "stopped" });
		},
		close(ws) {
			clients.delete(ws.data.id);
		},
		message(ws, raw) {
			let frame: Frame;
			try {
				frame = JSON.parse(String(raw)) as Frame;
			} catch {
				return;
			}
			if (frame.type === "wx:ping") return send(ws, { type: "wx:pong" });
			if (frame.type === "wx:restart") {
				child?.kill();
				setTimeout(spawnOmp, 200);
				return;
			}
			if (!child) return;
			writeRpc(frame);
		},
	},
});

if (opts.selftest) {
	console.log(JSON.stringify({ cwd: CWD, omp: OMP_BIN, bucket: bucketFor(CWD), sessions: (await listSessions(3)).length }, null, 2));
	server.stop(true);
	process.exit(0);
}

console.log(`omp-webchat  http://${HOST}:${PORT}   cwd=${CWD}`);
console.log(`  omp: ${OMP_BIN} --mode rpc-ui ${ompArgs.join(" ")}`.trimEnd());
if (opts.open) {
	const url = `http://${HOST}:${PORT}`;
	const opener =
		process.platform === "win32"
			? ["cmd", "/c", "start", "", url]
			: process.platform === "darwin"
				? ["open", url]
				: ["xdg-open", url];
	Bun.spawn(opener, { stdio: ["ignore", "ignore", "ignore"] }).unref();
}
spawnOmp();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		shuttingDown = true;
		child?.kill();
		server.stop(true);
		process.exit(0);
	});
}
