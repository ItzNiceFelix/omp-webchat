# omp-webchat

Native chat UI for omp sessions, served on localhost and opened in a browser.

It is a thin bridge: the server hosts one `omp --mode rpc-ui` process and pipes its JSONL
frames to the browser over WebSocket, so the UI speaks **the runtime's own command
surface** — prompts, every slash command, dialogs, todos, subagents, models, sessions —
instead of a re-implementation of it.

```
browser  ──ws──▶  server.ts  ──stdio JSONL──▶  omp --mode rpc-ui
                     │
                     ├─ host tools (webchat_card, webchat_open_url)
                     ├─ webchat:// scratch files
                     └─ session list / rename / delete over the runtime's session store
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
omp plugin install /path/to/omp-webchat        # or: omp plugin link /path/to/omp-webchat
```

Then inside any omp session:

```
/webchat                # start on the default port and open the browser
/webchat 7800           # custom port
/webchat continue       # extra tokens are forwarded to omp (--continue here)
```

## Chats (history)

The transcript store is the **runtime's own session store** — `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`,
the same files `omp --continue`/`--resume` use. Nothing is duplicated into the plugin folder, so a
chat opened in the browser is a chat the CLI can resume, and vice versa.

The sidebar groups chats by age (today / yesterday / previous 7 days / older) and supports search,
rename (`set_session_name`), delete (removes the `.jsonl` plus its artifact folder, with confirmation,
never the active chat), and **＋ new chat** (`new_session`).

Resuming replays context **inside the runtime** (`switch_session`); the browser never re-sends a
transcript to the model. Convention reference: [Open WebUI](https://docs.openwebui.com/reference/database-schema)
groups conversations by time period and generates titles with a background model;
[ChatGPT](https://help.openai.com/en/articles/8809935-how-to-delete-and-archive-chats-in-chatgpt)
and [Claude](https://support.claude.com/en/articles/8230524-delete-or-rename-a-conversation) both
support rename/delete from the sidebar. A label is taken from the session title slot when present,
otherwise from the first user message.

## UI

- **Transcript** — user/assistant turns, streamed thinking, markdown with code fences, usage per turn.
- **Tool cards** — args (collapsible), live status (`running`/`ok`/`failed`), partial output while running, full result after; failed calls are tinted red.
- **Todos** — sidebar card from the session's todo state (phases, per-task status marks, counts).
- **Agents** — sidebar roster plus an inline card under the spawning `task` call; per agent: status, model, tokens, elapsed, task; actions *transcript* (tail its JSONL), *steer*, *kill*.
- **Queue** — steering/follow-up chips with promote (`↑`) and remove (`×`).
- **Composer** — `Enter` sends, `Shift+Enter` newline, `Esc` aborts (`abort_and_restore_queue`, queued text comes back), `steer while busy` chooses steer vs follow-up, `/` opens the command palette (builtins + extension commands + skills + templates), image paste/drop attaches images.
- **Header** — session name, model picker (`get_available_models`), thinking level, fast/slow tier toggles, auto-compaction toggle, cache-warming cycle, context/tokens, commands modal, `/btw`, live voice, stop.
- **Dialogs** — the `ask` tool, tool approvals, and any `select`/`confirm`/`input`/`editor` request render as modals; `notify` shows a toast, `setStatus`/`setWidget`/`set_editor_text`/`open_url` are honored.

### Answering the agent

`--mode rpc-ui` (what this server spawns) mounts the tool-UI context, so the `ask` tool is
available and its questions land in the browser as a modal — options plus a free-text field per
question — and the answers go back as an `ask` response. Tool approvals render as a
`select` dialog (`Approve` / `Approve for this session` / `Deny`). In plain `--mode rpc`
the `ask` tool is not mounted at all, which is why the server uses `rpc-ui`.

### Live voice

The header `live` chip starts/stops a live voice session (`live_start`/`live_stop`, `mute` for
`live_mute`) and the sidebar panel renders `live_phase`, `live_levels` (mic/output meters) and
`live_transcript` turns. **Audio never crosses RPC**: the realtime model listens and speaks through
the microphone and speakers of the machine running omp; the browser only shows state. It needs a
realtime-capable credential (e.g. Codex OAuth) — without one the panel shows the runtime's error.

### Host tools and `webchat://`

The server registers two host-owned tools with `set_host_tools` and answers their calls itself:

| Tool | Effect |
| --- | --- |
| `webchat_card` | renders a card (title + markdown) into the transcript |
| `webchat_open_url` | opens a URL in the default browser of the webchat host (http/https only) |

It also registers the host URI scheme `webchat://`, which reads and writes text files under
`~/.omp/plugins/data/omp-webchat/` (path traversal rejected), so the agent can `write`/`read`
scratch artifacts that survive the session.

## Notes and limits

- The browser session is **its own omp process** (`--continue` / `--resume` to attach it to an existing transcript). It is not a mirror of a TUI running in the terminal; two processes writing one session file concurrently is not supported.
- **One child process per server, shared by every open tab.** Each tab's commands carry a `clientId:seq` id; the server routes each response back to the tab that asked, and broadcasts events to all tabs — so two tabs see the same chat and both can prompt. Start a second server on another port for a second independent session.
- Protocol v2 (`rpc_chunk`) framing is reassembled, so oversized frames (large transcripts, big tool results) survive intact.
- Cards pushed by `webchat_card` are UI-only: they are not part of the durable transcript and disappear on reload.
- **Some omp built-ins are interactive-TUI only** (`/vibe`, `/theme`, `/status`, `/help`, `/hotkeys`, …). The runtime does not dispatch them over RPC and does not list them in `available_commands` (93 advertised here vs. the full TUI set); an unknown spelling falls through to the model as ordinary prompt text. The composer refuses to send an unrecognized `/command`, writes the reason into the transcript, and offers "send as message" instead — so this can never happen silently. Use the commands modal to see exactly what this session will dispatch.
- `predict_word` ghost text is intentionally not implemented.
- `--approval-mode=always-ask` (forwarded via `--`) turns every tool call into a browser approval dialog if you want that gate.

## Files

- `src/server.ts` — HTTP + WebSocket bridge, `omp --mode rpc-ui` child, host tools/URIs, session store scanner.
- `src/public/{index.html,app.js,app.css}` — the browser client (no build step; asset URLs are stamped with their mtime).
- `src/extension.ts` — `/webchat` slash command.
