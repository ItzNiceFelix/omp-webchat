# omp-webchat web client

React client for the webchat bridge. It speaks the runtime's own RPC dialect over the bridge's
WebSocket, so everything the terminal can do — streaming turns, tool cards, dialogs, slash
commands, subagents, live voice — is driven by the same `omp --mode rpc-ui` process.

## Build

```bash
npm install
npm run build      # tsc --noEmit && vite build → dist/
npm test           # node --test test/*.test.ts (phase derivation)
npm run dev        # vite dev server, proxying /ws and /api to a bridge on 127.0.0.1:7788
```

The bridge serves `dist/` itself (`src/server.ts` in the repo root), so a built `dist/` is what
ships with the plugin. GitHub Actions rebuilds it on every change under `web/`.

## Layout

| file | role |
| --- | --- |
| `src/client.ts` | WebSocket transport: reconnect with backoff, command/response correlation by `id` |
| `src/frames.ts` | boundary parsers for runtime frames — the only place dynamic JSON is trusted |
| `src/store.ts` | the whole client state (transcript, tools, subagents, queue, dialogs, toasts) |
| `src/useStore.ts` | `useSyncExternalStore` binding; components subscribe to one slice |
| `src/markdown.ts` | `marked` → DOMPurify, plus an LRU so an unchanged block is never re-parsed |
| `src/components/` | header, sidebar, transcript, message rows, tool cards, composer, palette, agents, dialogs, modals, live voice, toasts |
| `src/styles.css` | the design system (one dark matte palette row, one radius) and the responsive layout |
| `src/fonts.ts` | bundled IBM Plex Sans and JetBrains Mono (woff2) |

## Mobile first

The shell is built for a phone and widened for a desktop (`@media (min-width: 1100px)` turns the
side panels into grid columns):

- **No glass** — there is no `backdrop-filter` anywhere. Surfaces are opaque and separated by a
  1px border plus the card/bg step, which is both the matte look and the cheaper scroll path.
- **Motion** — sheets slide up (from the right for agents), disclosure chevrons rotate, the
  tool/thinking body expands on a `grid-template-rows` transition (lazily mounted, then kept so
  closing animates too), and the streaming caret is drawn by CSS on the last block. Rows are not
  faded in as a group: each one is born from the timeline (spine, node, stub, then a clip-path
  card wipe) at a delay derived from its own index. Everything is transform/opacity/clip-path
  only and collapses under `prefers-reduced-motion`, pseudo-elements included.
- **Working indicator** — a 1px accent rail that draws across the composer's top edge while a
  turn runs, driven by `data-phase`. It is a `scaleX` on one pseudo-element, so it costs the
  compositor nothing to keep running.
- **Turn phase** — one derived primitive, `store.phase()`, answers "what is omp doing" for every
  surface at once: the composer's phase chip (word + elapsed + queue count), the root
  `data-phase` attribute and the composer rail.
  Order: `retry` → `compact` → `tool` → `think`/`write` (block type, only while `busy`) →
  `done`/`error` pulse (1.9 s) → `idle`. Everything comes from frames the store already routes;
  the bridge needs no new frame. `compacting` is tracked from `auto_compaction_start/end`
  because `session.isCompacting` only arrives with the *next* `get_state`. The derivation is
  pure (`phase-core.ts`) and covered by `npm test`.
- **Context usage** — a ring + percentage beside the send button; tap for tokens, window,
  remaining and throughput. The header shows the model and thinking pills, and the composer's quick
  strip shows the free context buffer.
- **Keyboard** — `interactive-widget=resizes-content` in the viewport meta, the Capacitor Keyboard
  plugin (`setResizeMode("native")`) in the APK, and a `--kb` inset measured from `visualViewport`
  (0 when the native resize already happened) that shrinks the shell so the composer is never
  covered. `font-size: 16px` on the composer and modal inputs stops Android's focus zoom.
- **Touch** — `data-touch` on the app root (from `pointer: coarse` or `maxTouchPoints`, since some
  WebViews report neither media query) raises every control to a 40 px target, chat rename/delete
  stay visible where `:hover` never fires, and `touch-action: manipulation` removes tap delay.
- **Attachments** — any file type. Images go to the model as vision content; every other file is
  uploaded to the bridge (`POST /api/upload`) and referenced in the prompt by its `webchat://`
  URI, which the agent's `read` tool resolves.

## Notes that are easy to get wrong

- **Streaming.** `message_update` frames carry either a whole partial message or one changed
  block; both land in `store.streaming`, a slot outside `messages`, so a token delta re-renders
  one row instead of allocating a new transcript array.
- **Tool cards** are collapsed by default: the header carries name, intent, status and duration;
  the body (args + output) is only mounted when opened.
- **Markdown is sanitized** before it reaches `dangerouslySetInnerHTML`: no scripts, no inline
  styles, no SVG, no forms, remote images dropped, links forced to `target="_blank"` with
  `rel="noopener noreferrer nofollow"`.
- **Transcript paging.** `get_messages_page` is walked with its cursor and falls back to
  `get_messages` while the session is busy. Only the last `windowSize` rows render; "load
  earlier" grows the window and restores the reading position with an element anchor (scroll
  height deltas are estimates under `content-visibility`).
- **Subagent transcripts** are tailed with `get_subagent_messages` + `fromByte`, not re-fetched.
- **Renaming** the running session goes through `set_session_name`; any other chat is renamed by
  the bridge, which rewrites the title header of its transcript file in place.
