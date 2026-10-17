# omp-webchat

Native chat UI for omp sessions, served on localhost and opened in a browser.

It is a thin bridge: the server hosts one `omp --mode rpc` process and pipes its JSONL
frames to the browser over WebSocket, so the UI speaks **the runtime's own command
surface** — prompts, every slash command, dialogs, todos, subagents, models, sessions —
instead of a re-implementation of it.

```
browser  ──ws──▶  server.ts  ──stdio JSONL──▶  omp --mode rpc
```

## Run

```bash
# from this directory
bun run src/server.ts --cwd /path/to/project --open      # or: BUN_BE_BUN=1 omp run src/server.ts
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | project the agent session runs in (default: current directory) |
| `--port <n>` | listen port (default 7788, env `OMP_WEBCHAT_PORT`) |
| `--host <h>` | bind address (default 127.0.0.1) |
| `--omp <path>` | omp binary (default: `omp` on PATH) |
| `--open` | open the default browser |
| `--selftest` | print resolved config and exit |
| `-- <args…>` | everything after `--` is forwarded to `omp`, e.g. `-- --continue --approval-mode=always-ask` |

## Install as an omp plugin

```bash
omp plugin install /path/to/omp-webchat        # or: omp plugin link /path/to/omp-webchat --local
```

Then inside any omp session:

```
/webchat                # start on the default port and open the browser
/webchat 7800           # custom port
/webchat continue       # extra tokens are forwarded to omp (--continue here)
```

## UI

- **Transcript** — user/assistant turns, streamed thinking, markdown with code fences, usage per turn.
- **Tool cards** — args (collapsible), live status (`running`/`ok`/`failed`), partial output while running, full result after; failed calls are tinted red.
- **Todos** — sidebar card from the session's todo state (phases, per-task status marks, counts).
- **Agents** — sidebar roster plus an inline card under the spawning `task` call; per agent: status, model, tokens, elapsed, task; actions *transcript* (tail its JSONL), *steer*, *kill*.
- **Queue** — steering/follow-up chips with promote (`↑`) and remove (`×`).
- **Composer** — `Enter` sends, `Shift+Enter` newline, `Esc` aborts (`abort_and_restore_queue`, queued text comes back), `steer while busy` chooses steer vs follow-up, `/` opens the command palette (builtins + extension commands + skills + templates), image paste/drop attaches images.
- **Header** — session name, model picker (`get_available_models`), thinking level, fast/slow tier toggles, auto-compaction toggle, cache-warming cycle, context/tokens, commands modal, `/btw`, stop.
- **Dialogs** — tool approvals and any `select`/`confirm`/`input`/`editor`/`ask` request render as modals; `notify` shows a toast, `setStatus`/`setWidget`/`set_editor_text`/`open_url` are honored.
- **Sessions** — "session" opens the on-disk session list for this directory: open one (`switch_session`), or start a new one (`new_session`).

## Notes and limits

- The browser session is **its own omp process** (`--continue` / `--resume` to attach it to an existing transcript). It is not a mirror of a TUI running in the terminal; two processes writing one session file concurrently is not supported.
- One child process per server, shared by every connected tab; client commands are correlated by `clientId:seq` and responses routed back to their tab.
- Protocol v2 (`rpc_chunk`) framing is reassembled, so oversized frames (large transcripts, big tool results) survive intact.
- Live voice frames (`live_*`), the host-tool/host-URI sub-protocols, and `predict_word` ghost text are not surfaced.
- The agent's `ask` tool is not mounted in this mode; use the approval/select dialogs it does emit.
- `--approval-mode=always-ask` (forwarded via `--`) turns every tool call into a browser approval dialog if you want that gate.

## Files

- `src/server.ts` — HTTP + WebSocket bridge, `omp --mode rpc` child, session-directory scanner.
- `src/public/{index.html,app.js,app.css}` — the browser client (no build step; asset URLs are stamped with their mtime).
- `src/extension.ts` — `/webchat` slash command.
