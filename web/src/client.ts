/**
 * WebSocket transport for the webchat bridge.
 *
 * The bridge is a dumb pipe: commands go up as JSON objects with an `id`, everything the
 * runtime emits comes down on the same socket. `wx:*` frames are the bridge's own; every
 * other frame is a verbatim runtime frame.
 */
import type { Frame } from "./types";

export type ConnStatus = "connecting" | "running" | "starting" | "exited";

interface ClientHandlers {
	/** Every frame that is not a command response. */
	onFrame(frame: Frame): void;
	onStatus(status: ConnStatus): void;
	/** Fired for each (re)connect after the bridge greeted us. */
	onHello(frame: Frame): void;
	onLost(reason: string): void;
}

const RECONNECT_MS = 1500;

export class RpcClient {
	private ws: WebSocket | null = null;
	/** Browsers return a numeric handle from setTimeout; keep the domain type explicit. */
	private reconnectTimer: number | undefined;
	private waiters = new Map<string, (frame: Frame) => void>();
	private seq = 0;
	private closed = false;
	clientId: string | null = null;

	constructor(private handlers: ClientHandlers) {}

	connect() {
		this.closed = false;
		clearTimeout(this.reconnectTimer);
		const proto = location.protocol === "https:" ? "wss" : "ws";
		this.handlers.onStatus("connecting");
		const ws = new WebSocket(`${proto}://${location.host}/ws`);
		this.ws = ws;
		ws.addEventListener("open", () => this.handlers.onStatus("starting"));
		ws.addEventListener("error", () => {
			// the close handler owns recovery
		});
		ws.addEventListener("message", (ev) => {
			let frame: Frame;
			try {
				frame = JSON.parse(String(ev.data)) as Frame;
			} catch {
				return;
			}
			this.dispatch(frame);
		});
		ws.addEventListener("close", () => {
			const wasConnected = this.clientId !== null;
			this.clientId = null;
			this.ws = null;
			this.handlers.onStatus("exited");
			for (const [id, waiter] of this.waiters) {
				this.waiters.delete(id);
				waiter({ type: "wx:dead" });
			}
			if (wasConnected) this.handlers.onLost("connection to the webchat server lost");
			if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
		});
	}

	close() {
		this.closed = true;
		clearTimeout(this.reconnectTimer);
		this.ws?.close();
	}

	private dispatch(frame: Frame) {
		if (typeof frame.id === "string") {
			const waiter = this.waiters.get(frame.id);
			if (waiter) {
				this.waiters.delete(frame.id);
				waiter(frame);
				return;
			}
		}
		if (frame.type === "wx:hello") {
			this.clientId = String(frame.clientId ?? "");
			this.handlers.onHello(frame);
			return;
		}
		this.handlers.onFrame(frame);
	}

	/** Send a command and resolve with its response frame. */
	cmd(command: Frame & { type: string }, timeoutMs = 120_000): Promise<Frame> {
		const id = `${this.clientId ?? "boot"}:${++this.seq}`;
		const payload = { id, ...command };
		return new Promise<Frame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				reject(new Error(`timeout: ${command.type}`));
			}, timeoutMs);
			this.waiters.set(id, (frame) => {
				clearTimeout(timer);
				if (frame.type === "wx:dead") reject(new Error("omp process is gone"));
				else resolve(frame);
			});
			const ws = this.ws;
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				clearTimeout(timer);
				this.waiters.delete(id);
				reject(new Error("not connected"));
				return;
			}
			ws.send(JSON.stringify(payload));
		});
	}

	/** Command + `data` payload, throwing on `success: false`. */
	async must<T = Record<string, unknown>>(command: Frame & { type: string }, timeoutMs = 120_000): Promise<T> {
		const frame = await this.cmd(command, timeoutMs);
		if (frame.success === false) throw new Error(String(frame.error ?? `${command.type} failed`));
		return (frame.data ?? {}) as T;
	}

	/** Fire-and-forget send, used for extension UI responses. */
	send(frame: Frame) {
		const ws = this.ws;
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
	}
}
