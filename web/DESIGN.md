# DESIGN.md — omp webchat

Visual system for the webchat UI in `web/`. Every token here is already in
`web/src/styles.css`; this file records it so a change can be checked against one source instead
of re-derived per component.

## Brand
- Name: omp webchat
- Voice: precise, technical, quiet
- Anti-patterns: gradients, glow, blur, glass, marketing copy

## Color System
Source row: colors.csv row 81 "Developer Tool / IDE" (dark matte). No other color is allowed.
- Primary: `#1e293b` — inactive surfaces, ring
- On Primary: `#ffffff`
- Secondary: `#334155` — hover on secondary controls
- On Secondary: `#ffffff`
- Accent: `#22c55e` — the one live thing: running tool, focus, send, done
- On Accent: `#0f172a`
- Background: `#0f172a` — page
- Foreground: `#f8fafc` — body text
- Card: `#1b2336` — cards, composer
- Card Foreground: `#f8fafc`
- Muted: `#272f42` — pills, dividers, quiet surfaces
- Muted Foreground: `#94a3b8` — captions, idle chip, secondary text
- Border: `#475569` — the timeline rail, card edges
- Destructive: `#ef4444` — failed tool, failed turn
- On Destructive: `#ffffff`

Dark only. There is no light theme, so no second set of tokens exists.

## Typography
- Display / body: IBM Plex Sans (400, 500, 600)
- Mono: JetBrains Mono (400, 500, 700) — labels, token counts, timings, code
- Body 13.5px / 1.55. Small and caption 11.5px. Micro labels 9.5 to 10.5px mono.
- Timings and counters use `font-variant-numeric: tabular-nums` so a ticking number does not
  reflow its box.

## Spacing
Base 4px. Scale 4, 6, 8, 12, 16, 24, 32. Column max width `720px`, message padding `0 16px`.

## Radius
One scale: `8px` for every surface and control (`--r`), `999px` for status pills, `1px` for the
timeline node. Nothing else.

## Elevation
No blur and no glow. Depth is a 1px border plus the card/bg step. The composer carries one
shadow (`0 12px 32px rgba(0,0,0,.34)`) because it floats over the transcript.

## Motion
- Entrance (card birth): 190ms spine, 120ms node, 140ms stub, 200ms card wipe, then 180ms text,
  staggered by `--i * 55ms`, capped at `--i: 6`.
- Phase glyph cross-fade: 150ms.
- Phase swap window: 160ms; a burst paints its first and its newest phase only.
- Hover: 150ms. Active: 100ms scale.
- Easing: `--ease-out` cubic-bezier(.22,1,.36,1) for entrances, `--ease-in` for exits,
  `--ease-io` for loops.
- Only transform, opacity, clip-path and color transition.
- `prefers-reduced-motion: reduce` removes every animation and transition, including on
  pseudo-elements (the spine, node and stub are pseudo-elements).

## Component rules
- Timeline: a 1px rail at the column's left edge, clamped into the 16px gutter below 760px, with
  a 7px node and a stub into each card. Runtime notices get none: they are context, not steps.
- Phase chip: fixed width, one glyph slot, word plus phase elapsed. Never resizes on a phase
  change, so its neighbours never move.
- Quick strip: phase, buffer, reasoning in that order; anything that appears mid-turn (queue
  depth) is appended so nothing before it shifts.
- Touch: `data-touch` raises every control to 40px and the two thumb targets (menu, send) to
  44px. Motion is identical to desktop; nothing is flattened on touch.

## Responsive
Breakpoints 420, 700, 760, 1100. Below 1100 the sidebar and agents panel are overlays. Below 420
the wordmark and the hint line drop; every other element keeps its desktop content, truncated
instead of hidden.

## Accessibility
- WCAG AA contrast on body text and labels.
- Visible focus ring on every interactive element.
- Touch targets 40px minimum, 44px for the two primary ones.
- Reduced motion honored globally.
