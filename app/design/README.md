# Red Echo — design system

Ported from the Echo 2 project (cyberpunk SOC terminal aesthetic). Ultra-dark, brutalist (`border-radius: 0`), monospace, red accent `#c0392b`, CRT scanlines overlay, terminal prompt prefixes (`>`, `[`, `]`, `//`).

## File layout

```
app/design/
├── README.md            ← this file
├── tokens.css           ← :root CSS variables (palette, spacing, font stack)
├── base.css             ← reset, html/body, CRT scanlines, scrollbar, selection
├── typography.css       ← headings, .dash-title, .page-title, .section-title, .input-label
├── components.css       ← .btn variants, .input, .textarea, .badge, .tile, checkboxes
├── layout.css           ← .app, .header, .topbar, .main, .page, .section
└── animations.css       ← @keyframes (cursor-blink, glow-pulse, fade-in, pulse, shimmer)
```

All six are `@import`-ed from `app/globals.css`, which is itself imported once by `app/layout.tsx`.

## Palette

| Token | Value | Usage |
|---|---|---|
| `--bg` | `#0a0a0a` | Page background |
| `--bg-deep` | `#060606` | Header bar, input fills |
| `--surface` | `#0e0e0e` | Cards, tiles, panels |
| `--surface-hover` | `#141414` | Card hover state |
| `--border` | `#1e1e1e` | Default border |
| `--border-strong` | `#2e2e2e` | Stronger border (buttons, inputs) |
| `--border-hover` | `#3a3a3a` | Border on hover |
| `--ink` | `#e4e4e4` | Bright headings |
| `--text` | `#c4c4c4` | Primary body |
| `--text-dim` | `#9a9a9a` | Dim secondary |
| `--muted` | `#6a6a6a` | Very muted |
| `--accent` | `#c0392b` | Red accent |
| `--accent-hover` | `#e74c3c` | Red hover |
| `--accent-light` | `#ff6b5c` | Links, bright red |
| `--good` | `#3fd67c` | Success, ok status |
| `--warn` | `#ffb347` | Warning |
| `--bad` | `#ff5a4e` | Error |

## Typography

- **Font stack**: `JetBrains Mono` (loaded via `next/font/google` in `app/layout.tsx`) → Consolas → Monaco → monospace.
- **Body**: 13 px / 1.5 line-height / tracking 0.
- **Headings**: uppercase, letter-spacing 1–2 px, font-weight 800–900.
- **Titles** carry a red `>` prompt prefix (`::before`) and often a cursor block (`::after`) with blink animation.
- **Section titles** are wrapped in brackets: `[ SECTION ]` via `::before` / `::after`.
- **Input labels** use `> ` prefix with the red accent.

## Geometry

- Radius: `0` everywhere (brutalist).
- Gap: `12 px` base between grid items.
- Padding: `14 px` base tile padding, `24 px` page padding.
- Header height: `48 px`.

## Scanlines + vignette

`body::before` draws a subtle horizontal scanline pattern (2 px stripe repeating), `body::after` draws a radial vignette. Both `pointer-events: none` and `z-index` high enough to sit above content but below modals. Non-interactive ambient CRT vibe.

## How to use

```tsx
// A primary action button
<button className="btn btn-primary">Sync</button>

// A title with terminal prompt + cursor
<h1 className="dash-title">Bookmarks</h1>

// An input with label
<label className="input-label" htmlFor="url">URL</label>
<input className="input" id="url" type="text" />

// A status badge
<span className="badge badge-running">running</span>

// A tile card
<div className="tile">
  <h3 className="tile-title">Title</h3>
  <p className="tile-body">Body</p>
</div>
```

## Porting notes

- Ported from Echo 2's `frontend/src/index.css`, which is Tailwind v4 based but does not actually use Tailwind utilities — only the `@import "tailwindcss"` pull and all hand-written classes. We strip the Tailwind import and keep everything in plain CSS modules.
- Focus-visible outline is red (`1px solid var(--accent)` + `offset 2px`).
- Selection highlight uses the red accent with white text.
- Scrollbars are 8 px wide, thumb fades to red on hover.
