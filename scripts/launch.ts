/**
 * Detach the bridge from its terminal so closing the shortcut's console does not kill it.
 *
 * The launcher prints the child PID and exits immediately; the server keeps running with its
 * own stdio pointed at the log files in `.run/`.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const port = process.env.OMP_WEBCHAT_PORT ?? "7788";
const cwd = process.env.OMP_WEBCHAT_CWD ?? root;
const runDir = resolve(root, ".run");
mkdirSync(runDir, { recursive: true });

const out = openSync(resolve(runDir, "webchat.log"), "a");
const err = openSync(resolve(runDir, "webchat.err.log"), "a");
const child = spawn(process.execPath, ["run", resolve(root, "src/server.ts"), "--port", port, "--cwd", cwd], {
	cwd: root,
	detached: true,
	windowsHide: true,
	stdio: ["ignore", out, err],
});
child.unref();
closeSync(out);
closeSync(err);

console.log(child.pid);
