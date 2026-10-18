# omp-webchat

Native chat UI for omp sessions, served on localhost and opened in a browser.

It is a thin bridge: the server hosts one `omp --mode rpc-ui` process and pipes its JSONL
frames to the browser over WebSocket, so the UI speaks **the runtime's own command
surface** — prompts, every slash command, dialogs, todos, subagents, models, sessions —
instead of a re-implementation of it.

```
browser  ──ws──▶  server.ts  ──stdio JSONL──▶  omp --mode rpc-ui
                     │
                     ├─ host tools (webchat_card, webchat_copy, webchat_open_url, webchat_present_file)
                     ├─ webchat:// scratch files
                     └─ session list / rename / delete over the runtime's session store
```

## Run

```bash
# from this directory
bun run src/server.ts --cwd /path/to/project --open      # or: BUN_BE_BUN=1 omp run src/server.ts

# once, to build the browser client — the server serves web/dist as-is and never builds it
cd web && npm install && npm run build
```

Without `web/dist/index.html` the server answers `GET /` (and any other request for the unbuilt
`index.html`) with a `503` that says to run that build; the WebSocket/API surface is unaffected.

Flags:

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | project the agent session runs in (default: current directory) |
| `--port <n>` | listen port (default 7788, env `OMP_WEBCHAT_PORT`) |
| `--host <h>` | bind address (default 127.0.0.1) |
| `--omp <path>` | omp binary (default: `omp` on PATH) |
| `--open` | open the default browser |
| `--selftest` | print resolved config and exit |
| `--no-defaults` | do not apply the bundled settings overlay (`src/defaults.yml`) |
| `-- <args…>` | everything after `--` is forwarded to `omp`, e.g. `-- --continue --approval-mode=always-ask` |

The bundled overlay disables `eval.tools.enabled`, which otherwise advertises the task tool's
`tools` field ("named tools already defined in the parent's eval kernel"). A browser chat has no
eval kernel, so models pass names like `["read"]` and the spawn dies with
`Unknown eval tool(s)`. Bring your own `--config` (or `--no-defaults`) to opt out.

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

Renaming the *live* session goes through `set_session_name`; any other transcript in the store is
renamed with `PATCH /api/sessions?path=<abs .jsonl>` and a `{"name":"…"}` body (see
[HTTP surface](#http-surface)). The server rewrites line 1 in place — `title`, `source:"manual"`,
`updatedAt` — and refills the line's `pad` string so the header keeps its exact byte length, which is
what keeps every later offset (artifact paths, `fromByte` tails) valid. A first line that is not a
`{"type":"title",…}` header is refused with `400`.

Resuming replays context **inside the runtime** (`switch_session`); the browser never re-sends a
transcript to the model. Convention reference: [Open WebUI](https://docs.openwebui.com/reference/database-schema)
groups conversations by time period and generates titles with a background model;
[ChatGPT](https://help.openai.com/en/articles/8809935-how-to-delete-and-archive-chats-in-chatgpt)
and [Claude](https://support.claude.com/en/articles/8230524-delete-or-rename-a-conversation) both
support rename/delete from the sidebar. A label is taken from the session title slot when present,
otherwise from the first user message.

## UI

The client is a **React app in `web/`** (vite + TypeScript, no framework beyond React), built to
`web/dist` and served from there by the bridge as static files — `index.html` and anything else
unhashed is sent `cache-control: no-store`, while `assets/*` keeps vite's content hash and is cached
`immutable` for a year. Build it with `npm install && npm run build` in `web/` (CI does the same, see
[CI](#ci)). `npm run dev` there serves the app standalone for component work: the client talks to
`/api/*` and `/ws` on its own origin, so a full session needs the bridge (`web/dist` behind
`server.ts`), not vite's port.

Dark developer-console theme (tokens from the ui-ux-pro-max "Dark Mode (OLED)" palette, IBM Plex
Sans + JetBrains Mono, 8px rhythm, subset of Lucide-style inline SVG icons — no emoji), laid out as
header / sidebar / chat / agents drawer.

- **Layout** — only the chat scrolls: the composer and the sidebar never move, and the page itself
  has no scrollbar (`min-height: 0` grid tracks, `overflow: hidden` shell).
- **Transcript** — user bubbles right-aligned, assistant turns with streamed thinking, markdown with
  colored code (comments/strings/numbers/keywords/calls), colored inline spans (code, `/commands`,
  `@mentions`, file paths, links) and per-turn usage.
- **Tool cards** — args (collapsible), live status pill, spinner + pulsing outline while running,
  partial output during the run, full result after; failures tinted red.
- **Motion** — indeterminate top bar while the agent works, shimmer on streaming thinking, blinking
  caret mid-stream, rise-in for new rows; all compositor-only (`transform`/`opacity`) and disabled
  under `prefers-reduced-motion`.
- **Composer** — single rounded box with the standard AI-chat toolbar: attach image, live voice,
  model picker, reasoning effort, command palette, steer toggle, stop, send. `Enter` sends,
  `Shift+Enter` newline, `Esc` stops (`abort_and_restore_queue` hands queued text back), `/` opens
  the palette (arrows + `Tab` to pick), images can be pasted or dropped.
- **Header** — connection dot, session name, context/tokens, agents counter, notification bell, and a
  "more" menu (fast, slow, auto-compaction, cache warming, `/btw`, export transcript, restart).
- **Chats sidebar** — grouped by age (today / yesterday / previous 7 days / older), search, rename,
  delete (with confirmation, never the active chat), **＋ new chat**, active-chat marker. Below it:
  session facts, todo card (`0/3 done` count announced via `role="status"`), queued chips with
  promote/remove, goal, live-voice meters, extension widgets.
- **Agents drawer** — roster with status, agent, model, tokens, elapsed, current assignment; click a
  row (or the inline card under its `task` call) to tail that agent's JSONL transcript in place
  (`get_subagent_messages` with `fromByte`), plus steer/kill and a live-tail toggle.
- **Dialogs** — the `ask` tool, tool approvals, and any `select`/`confirm`/`input`/`editor` request
  render as modals; `notify` shows a toast, `setStatus`/`setWidget`/`set_editor_text`/`open_url` are honored.
- **Responsive** — under 900px the sidebar and agents drawer become slide-over sheets with a
  backdrop (`Esc` closes), header meta collapses, chat rows and icon buttons grow to ≥40px, and the
  composer respects `env(safe-area-inset-bottom)`.
- **Scrollbars** — thin, dark, borderless thumbs that brighten on hover (`scrollbar-width`/`::-webkit-scrollbar`).

### Notifications

The bell toggles alerts (persisted in `localStorage`). When enabled, omp pings you — system
notification + chime + `●` tab title — only while the page is hidden or unfocused, for: a finished
turn, a failed turn, an `ask`/approval dialog waiting on you. Desktop banners need browser
permission (asked on the first toggle); the in-page toast, chime and title flash work regardless.

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

The server registers four host-owned tools with `set_host_tools` and answers their calls itself
(they are listed in `GET /api/info` as `hostTools`):

| Tool | Effect |
| --- | --- |
| `webchat_card` | renders a card (title + markdown) into the transcript |
| `webchat_copy` | broadcasts `wx:copy`, so the browser that is connected puts `text` on the clipboard |
| `webchat_open_url` | opens a URL in the default browser of the webchat host (http/https only) |
| `webchat_present_file` | sends a file as a `wx:file` frame: a row with a download button in the transcript |

`webchat_present_file` takes a `path` under the same data root (the `webchat://` guard applies, so
escapes are an error result rather than a throw) and an optional `name` that defaults to the file's
basename. It reads the bytes, base64s them into one frame, and types the download from the
extension (`json`, `md`, `txt`, `html`, `csv`, `png`, `jpg`, `svg`, `pdf`, `zip`, else
`application/octet-stream`). Files over 8 MiB are refused with an error result instead of a frame
that would choke the socket.

It also registers the host URI scheme `webchat://`, which reads and writes text files under
`~/.omp/plugins/data/omp-webchat/` (path traversal rejected), so the agent can `write`/`read`
scratch artifacts that survive the session.

## HTTP surface

Everything the client needs is served by the bridge itself:

| Route | Meaning |
| --- | --- |
| `GET /` and real files under `web/dist` | the client bundle (hashed `assets/*` are `immutable`, everything else `no-store`) |
| `GET /api/info` | resolved config: cwd, omp binary, child status, session/data roots, registered `hostTools`, bucket |
| `GET /api/sessions?limit=<n>` | session list from the runtime's store, newest first |
| `PATCH /api/sessions?path=<abs .jsonl>` | rename a stored session: body `{"name":"…"}`, 1–120 chars after trimming and stripping control chars; `400` if the file's first line is not a title header |
| `DELETE /api/sessions?path=<abs .jsonl>` | delete a stored session and its artifact folder |
| `POST /api/restart[?full=1]` | respawn the omp child, or relaunch the server itself |
| `/ws` | the JSONL pipe: one omp child, every connected tab shares it |

**Host and origin checks.** `/ws` and every `/api/*` route are loopback-only, because a page on any
other site can still open a socket to `127.0.0.1` (DNS rebinding, cross-site WebSocket hijacking):

- the `Host` header must name loopback (`localhost`, `127.0.0.1`, `::1`, `[::1]`) or exactly the
  configured `--host` — otherwise `403 {"ok":false,"error":"host not allowed"}`;
- a present `Origin` must pass the same hostname rule and carry no port or the listening port —
  otherwise `403 {"ok":false,"error":"origin not allowed"}`;
- requests without `Origin` (curl, same-origin navigation) are allowed once `Host` checks out.

Static files carry no session data, so only the socket and the API are gated.

## CI

`.github/workflows/web.yml` builds the client on `workflow_dispatch` and on pushes/PRs that touch
`web/**` (or the workflow itself): Node 20, `npm ci` and `npm run build` in `web/`, then `web/dist`
is uploaded as the `omp-webchat-web-dist` artifact. `.github/workflows/android.yml` packages the
Capacitor APK the same way.

## Notes and limits

- The browser session is **its own omp process** (`--continue` / `--resume` to attach it to an existing transcript). It is not a mirror of a TUI running in the terminal; two processes writing one session file concurrently is not supported.
- **One child process per server, shared by every open tab.** Each tab's commands carry a `clientId:seq` id; the server routes each response back to the tab that asked, and broadcasts events to all tabs — so two tabs see the same chat and both can prompt. Start a second server on another port for a second independent session.
- Protocol v2 (`rpc_chunk`) framing is reassembled, so oversized frames (large transcripts, big tool results) survive intact.
- Cards pushed by `webchat_card` are UI-only: they are not part of the durable transcript and disappear on reload.
- **Some omp built-ins are interactive-TUI only** (`/vibe`, `/theme`, `/status`, `/help`, `/hotkeys`, …). The runtime does not dispatch them over RPC and does not list them in `available_commands` (93 advertised here vs. the full TUI set); an unknown spelling falls through to the model as ordinary prompt text. The composer refuses to send an unrecognized `/command`, writes the reason into the transcript, and offers "send as message" instead — so this can never happen silently. Use the commands modal to see exactly what this session will dispatch.
- `predict_word` ghost text is intentionally not implemented.
- `--approval-mode=always-ask` (forwarded via `--`) turns every tool call into a browser approval dialog if you want that gate.

## Files

- `src/server.ts` — HTTP + WebSocket bridge, `omp --mode rpc-ui` child, host tools/URIs, static serving of `web/dist`, session store scanner.
- `web/` — the React client (vite + TypeScript); `npm run build` emits `web/dist`, which is the only client the bridge serves.
- `src/extension.ts` — `/webchat` slash command.
- `.github/workflows/web.yml` — builds `web/` and uploads the bundle; `.github/workflows/android.yml` builds the Capacitor APK.
