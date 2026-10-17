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
import { readdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Frames on the wire are opaque JSON objects; only the routing keys are validated. */
type Frame = Record<string, unknown> & { type?: unknown; id?: unknown };
type Socket = ServerWebSocket<{ id: string }>;

const argv = Bun.argv.slice(2);
const BOOL_FLAGS: Record<string, true> = { open: true, selftest: true };
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
const PUBLIC_DIR = join(import.meta.dir, "public");
const SESSIONS_ROOT = join(Bun.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "sessions");

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
	if (child) child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
	if (child) child.stdin.flush();
	else {
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
	let frame: Frame;
	try {
		frame = JSON.parse(line) as Frame;
	} catch {
		broadcast({ type: "wx:log", level: "warn", text: `unparsable frame (${line.length} bytes)` });
		return;
	}
	if (frame.type === "rpc_chunk") reassembleChunk(frame);
	else handleObject(frame);
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
	const cmd = [OMP_BIN, "--mode", "rpc", ...ompArgs];
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
}

// ---------------------------------------------------------------- session listing

/** Canonical-cwd bucket: `-<relative>` under home, `-tmp-<relative>` under the temp root, `--<encoded>--` otherwise. */
function bucketFor(cwd: string) {
	const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "");
	const enc = (p: string) => p.replace(/[\\/:]/g, "-");
	const c = norm(cwd).toLowerCase();
	const h = norm(homedir()).toLowerCase();
	const tmp = norm(Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp").toLowerCase();
	if (c.startsWith(`${h}\\`) || c.startsWith(`${h}/`)) return `-${enc(norm(cwd).slice(norm(homedir()).length + 1))}`;
	if (c.startsWith(tmp)) return `-tmp-${enc(norm(cwd).slice(norm(Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp").length + 1))}`;
	return `--${enc(norm(cwd))}--`;
}

async function readSessionHead(path: string) {
	const handle = await open(path, "r");
	try {
		const buf = Buffer.alloc(4096);
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
		let head: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(lines[0] ?? "");
			if (parsed && typeof parsed === "object") head = parsed as Record<string, unknown>;
		} catch {
			// header slot is a fixed-width title field in some versions; label falls back to text
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
				// partial line at the 4 KiB boundary
			}
		}
		return { head, firstUser };
	} finally {
		await handle.close();
	}
}

async function listSessions(limit: number) {
	let dir = join(SESSIONS_ROOT, bucketFor(CWD));
	let names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl"));
	if (names.length === 0) {
		// Fallback: this platform's bucket spelling may differ; adopt the bucket whose newest
		// session header records our cwd.
		for (const candidate of (await readdir(SESSIONS_ROOT).catch(() => [] as string[])).reverse()) {
			const probe = join(SESSIONS_ROOT, candidate);
			const files = (await readdir(probe).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl")).sort().reverse();
			if (files.length === 0) continue;
			const { head } = await readSessionHead(join(probe, files[0])).catch(() => ({ head: {}, firstUser: "" }));
			if (typeof head.cwd === "string" && resolve(head.cwd) === CWD) {
				dir = probe;
				names = files;
				break;
			}
		}
	}
	const rows = await Promise.all(
		names.map(async (name) => {
			const path = join(dir, name);
			try {
				const info = await stat(path);
				const { head, firstUser } = await readSessionHead(path);
				const title = typeof head.title === "string" ? head.title : "";
				const label = title || firstUser.split("\n")[0] || "Untitled";
				return {
					path,
					id: typeof head.id === "string" ? head.id : name,
					name: label.replace(/[\u0000-\u001f]/g, "").slice(0, 120),
					titled: Boolean(title),
					bytes: info.size,
					mtime: info.mtimeMs,
				};
			} catch {
				return null;
			}
		}),
	);
	return rows.filter((row) => row !== null).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// ---------------------------------------------------------------- http + ws

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

function serverFile(pathname: string) {
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	if (rel.includes("..")) return null;
	const full = join(PUBLIC_DIR, rel);
	return full.startsWith(PUBLIC_DIR) ? full : null;
}

const server = Bun.serve<{ id: string }>({
	hostname: HOST,
	port: PORT,
	idleTimeout: 255, // matches the harness gateway: long model turns must not idle out
	async fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			const id = `c${Date.now().toString(36)}${clients.size}`;
			if (srv.upgrade(req, { data: { id } })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		}
		if (url.pathname === "/api/info") {
			return Response.json({
				cwd: CWD,
				omp: OMP_BIN,
				args: ["--mode", "rpc", ...ompArgs],
				child: child ? { status: "running", pid: child.pid } : { status: "stopped" },
				sessionsRoot: SESSIONS_ROOT,
				bucket: bucketFor(CWD),
			});
		}
		if (url.pathname === "/api/sessions") {
			return Response.json({ sessions: await listSessions(Number(url.searchParams.get("limit") ?? 40)) });
		}
		if (url.pathname === "/api/restart" && req.method === "POST") {
			child?.kill();
			setTimeout(spawnOmp, 200);
			return Response.json({ ok: true });
		}
		const file = serverFile(url.pathname);
		if (!file) return new Response("not found", { status: 404 });
		const blob = Bun.file(file);
		if (!(await blob.exists())) return new Response("not found", { status: 404 });
		if (file.endsWith("index.html")) {
			// Stamp asset URLs with their mtime so an edited client is never served stale.
			const stamps = await Promise.all([stat(join(PUBLIC_DIR, "app.js")), stat(join(PUBLIC_DIR, "app.css"))]);
			const version = String(Math.max(...stamps.map((s) => s.mtimeMs)));
			return new Response((await blob.text()).replaceAll("__V__", version), {
				headers: { "content-type": MIME[".html"], "cache-control": "no-store" },
			});
		}
		return new Response(blob, {
			headers: {
				"content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
				// the client is edited in place: never let the browser serve a stale UI
				"cache-control": "no-store",
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
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			child.stdin.flush();
		},
	},
});

if (opts.selftest) {
	console.log(JSON.stringify({ cwd: CWD, omp: OMP_BIN, bucket: bucketFor(CWD), sessions: (await listSessions(3)).length }, null, 2));
	server.stop(true);
	process.exit(0);
}

console.log(`omp-webchat  http://${HOST}:${PORT}   cwd=${CWD}`);
console.log(`  omp: ${OMP_BIN} --mode rpc ${ompArgs.join(" ")}`.trimEnd());
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
