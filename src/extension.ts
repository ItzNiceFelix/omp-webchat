/**
 * `/webchat` — launch the localhost browser chat for this project.
 *
 * The UI is a thin browser client for the runtime's own RPC mode, so it speaks the same
 * command surface as the CLI (`omp --mode rpc`): prompts, slash commands, todos,
 * subagents, dialogs, models, sessions.
 *
 * ponytail: the browser session is its own omp process, not a mirror of the calling TUI.
 * Upgrade path: mirror the host session through the event bus if a single shared
 * transcript is ever needed.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 7788;
const READY_TIMEOUT_MS = 15_000;

export default function webchatExtension(pi: ExtensionAPI) {
	pi.registerCommand("webchat", {
		description: "Open the localhost browser chat for this project (`/webchat [port] [omp flags…]`)",
		async handler(args, ctx) {
			const tokens = String(args ?? "")
				.split(/\s+/)
				.filter(Boolean);
			const port = Number(tokens.find((t) => /^\d+$/.test(t))) || DEFAULT_PORT;
			const extras = tokens.filter((t) => !/^\d+$/.test(t));
			const url = `http://127.0.0.1:${port}`;

			const already = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(1500) })
				.then((res) => (res.ok ? (res.json() as Promise<{ cwd: string }>) : null))
				.catch(() => null);
			if (already) {
				ctx.ui.notify(`webchat already running for ${already.cwd}: ${url}`, "info");
				openBrowser(url);
				return;
			}

			const serverDir = fileURLToPath(new URL("./server.ts", import.meta.url));
			const bunOnPath = Bun.which("bun");
			const env: Record<string, string | undefined> = { ...process.env, OMP_WEBCHAT_PORT: String(port) };
			// Without a separate bun, the omp binary runs the script itself (same path `omp plugin` uses).
			if (!bunOnPath) env.BUN_BE_BUN = "1";
			// detached + unref so the server outlives this session on Windows too.
			const child = spawn(bunOnPath ?? process.execPath, [serverDir, "--cwd", ctx.cwd, "--port", String(port), "--open", ...extras], {
				cwd: ctx.cwd,
				env,
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			child.unref();

			await ctx.ui.notify(`webchat starting on ${url} (cwd ${ctx.cwd})…`, "info");
			const deadline = Date.now() + READY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const up = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(1000) })
					.then((res) => res.ok)
					.catch(() => false);
				if (up) {
					ctx.ui.notify(`webchat ready: ${url}  (pid ${child.pid})`, "info");
					return;
				}
				await Bun.sleep(400);
			}
			ctx.ui.notify(`webchat did not answer on ${url} within 15s — check the port`, "error");
		},
	});
}

function openBrowser(url: string) {
	const opener =
		process.platform === "win32"
			? ["cmd", "/c", "start", "", url]
			: process.platform === "darwin"
				? ["open", url]
				: ["xdg-open", url];
	Bun.spawn(opener, { stdio: ["ignore", "ignore", "ignore"] }).unref();
}
