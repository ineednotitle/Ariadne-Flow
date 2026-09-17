# Notion-like Flow — Obsidian plugin

Makes Obsidian feel like **Notion / AFFiNE** in both **Live Preview** and **Reading view**:

- **`/` slash menu** — 44 commands with SF-style line icons: text formats (bold, italic, strikethrough, highlight, code, comment, math), page mentions, web/image links, tags, footnotes, headings, lists, to-dos, toggles, quotes, callouts (6 Notion colors), code, mermaid, math, tables, dividers, embeds, dates, templates, page icon/cover shortcuts
- **Block gutter handle (`+` / `⠿`)** — hover any block to insert below, duplicate, delete, move up/down, copy text/link, **Turn into…**, and **drag to reorder**
- **Notion toggles** — `> [!toggle]+ Title` renders as a clickable `▸` toggle
- **Page icons + covers + breadcrumbs** — via frontmatter (`icon:`, `cover:`), with pickers and hover actions
- **Word count + reading time** in the status bar
- **Full-width toggle + Focus mode** (hides sidebars, dims inactive blocks)
- **Notion typography** — cleaner fonts, spacing, dividers, checkboxes, tables

No dependencies at runtime. No network calls. Your notes stay plain Markdown.

---

## 1. Install (ready-to-use build)

1. In your vault, create the folder:
   `.obsidian/plugins/notion-like-flow/`
2. Copy these 3 files from this project into it:
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. In Obsidian: **Settings → Community plugins → turn off Safe mode → enable “Notion-like Flow”**.
4. Done — type `/` in any note.

> Updating: replace the same 3 files and press **Reload** (or restart Obsidian).

## 2. Build from source

Requirements: Node 18+.

```bash
cd notion-like-flow
npm install
npm run build     # → produces main.js (production, minified)
# or: npm run dev # watch mode while developing
```

Type-check only: `npx tsc -noEmit -skipLibCheck`

## 3. Quick tour

| Want… | Do… |
|---|---|
| Slash menu | Type `/` anywhere (e.g. `/bold`, `/highlight`, `/mention`, `/template`, `/blue`) |
| Block menu | Hover a block → click `⠿` → Duplicate / Delete / Move / Turn into / Copy link |
| Insert fast | Hover a block → click `+` (inserts `/` below so you can keep typing) |
| Drag reorder | Drag the `⠿` grip — ghost + blue insertion line, auto-scrolls near edges (mobile: long-press then drag) |
| Toggle | `/toggle` or type `> [!toggle]+ My title` + `> body` lines |
| Colored callout | `/blue` (gray/red/green/yellow/purple too) or `> [!n-blue] text` |
| Page icon | Command palette → “Set page icon…” — or frontmatter `icon: 🎯` |
| Page cover | Command palette → “Set page cover…” — or frontmatter (see below) |
| Full width | Command palette → “Toggle full width” (or Settings) |
| Focus mode | Ribbon ✦ button, or Command palette → “Toggle focus mode” |
| Word count | Bottom status bar: `✦ 1,234 words · 6 min` |
| New note in folder | Explorer **+** (or palette command) — created inside the folder you last clicked |

Try it on the included demo: `demo/Notion-like Flow Demo.md` (copy it into your vault).

## 4. Frontmatter reference

```yaml
---
icon: 🎯                 # any emoji — big icon above the note
cover: gradient-blue     # URL, #hex, [[image.png]], vault path, or one of:
                         # gradient-beige | gradient-blue | gradient-purple |
                         # gradient-pink | gradient-orange | gradient-green |
                         # gradient-slate | gradient-dark
cover_position: center   # top | center | bottom (for image covers)
---
```

Examples:

```yaml
cover: https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=1600
cover: "#3b82f6"
cover: "[[my-banner.png]]"
cover: attachments/cover.jpg
```

**Built-in photo search:** open “Set page cover…” → the **Unsplash** / **Pexels** tabs let you search and one-click any photo as your cover (blank search = curated feed, “Load more” paginates). Both need a free API key: paste it once in the modal or under Settings → Notion-like Flow → Cover search (Unsplash: unsplash.com/developers, Pexels: pexels.com/api). Keys never leave your device. Photographer credit shows on hover in the picker.

## 5. Toggle syntax

```markdown
> [!toggle]+ Click me
> Hidden content line 1
> Hidden content line 2
```

- `+` = starts expanded, `-` = starts collapsed.
- Click the title to fold/unfold (works in Live Preview + Reading).
- Turn any block into a toggle: hover → `⠿` → **Turn into: Toggle**.

## 6. Color callouts

```markdown
> [!n-gray] Neutral note
> [!n-blue] Info
> [!n-red] Danger / important
> [!n-green] Success
> [!n-yellow] Warning
> [!n-purple] Tip / pro
```

These are plain callouts, so they sync and export like normal Markdown.

## 7. Commands (palette)

- Open slash menu · Insert toggle block · Insert divider · Insert simple table
- Turn into: Text / H1 / H2 / H3 / Bullet / Numbered / To-do / Toggle / Quote / Code
- New note in selected folder · Duplicate current block · Set page icon… · Set page cover…
- Toggle full width · Toggle focus mode

## 8. Settings

Settings → **Notion-like Flow**: slash menu on/off, drag handle on/off, color emoji, covers, breadcrumb, word count, Notion typography, full width, focus mode (+ dim)., plus new-note location., Unsplash/Pexels keys.

## 9. Notes & limits

- The gutter handle positions itself from the hovered block; in very long notes with many embeds it falls back to the cursor line.
- In Reading view, Duplicate/Delete/Move/Turn-into edit the underlying Markdown by mapping visual order → source blocks (blank-line separated). It handles lists, quotes/callouts, tables, fences and paragraphs; exotic nesting may map approximately — undo (`Ctrl/Cmd+Z`) always works.
- Covers inside Live Preview are injected above the editor (`contenteditable=false`), the same technique popular banner plugins use.
- Block links append a `^nlf-xxxx` id (Obsidian-native block ids).
- Safe-move guards: drag, move, duplicate, delete and turn-into refuse with a notice when a block can't be mapped exactly, or the edit would split a code block or frontmatter. Repeat the identical action within 8 seconds to force it (manual undo is the net).
- Mobile: long-press any block for its menu, or long-press then drag to reorder. Desktop hover handles work with trackpads too.

## 10. File map

```
notion-like-flow/
├── manifest.json        # plugin id / version
├── main.js              # built bundle (copy to .obsidian/plugins/)
├── styles.css           # Notion styling (copy alongside main.js)
├── src/main.ts          # all source (slash, handles, headers, commands)
├── esbuild.config.mjs
├── tsconfig.json
├── package.json
└── demo/Notion-like Flow Demo.md
```

## 11. Changelog

- **1.0.15** — Mobile compat pass: no keyboard-pop on modal open, block menu gains Insert-below (long-press reachable), input rows wrap on narrow screens.
- **1.0.14** — Flat 2D emoji only: removed all Fluent 3D art, Twemoji everywhere with system fallback.
- **1.0.13** — Full 3,773-emoji catalog (Unicode 15.1 + aliases + infinite scroll); Fluent 3D art for 1,910, Twemoji/system fallback for the rest.
- **1.0.12** — Emoji picker flattened (no category tabs — all 170 in one searchable grid); page icons now glossy Fluent 3D art (MIT) with Twemoji + system fallback.
- **1.0.11** — Page icons + emoji picker drawn with Twemoji color images (same look on every OS, offline fallback to system emoji; toggle in settings).
- **1.0.10** — Slash menu icons redrawn as SF/iOS-style line icons (Lucide/ISC, bundled offline, theme-adaptive).
- **1.0.9** — Handle no longer blinks away (300ms hover grace); full slash menu on all platforms with a complete scrollable list; new Underline, Attach file and New page commands (44 total).
- **1.0.8** — Slash formats now desktop-only (mobile keeps basic blocks; optional override in settings). Handle/drag UI fix: gutter-anchored +/grip hugging the line start, 6-dot grip restored, full-width drop line, capped ghost size.
- **1.0.7** — Complete slash menu (41 commands): bold/italic/strikethrough/highlight/code via Obsidian's native toggles, comment, inline math, page mentions, web/image links, tags, footnotes, heading links, mermaid, page properties, current time, template insert.
- **1.0.6** — Mobile support (long-press block menu, press-and-drag reorder, responsive pickers) + perf pass (rAF-throttled handle, cached headers, debounced word count, correct multi-pane targeting).
- **1.0.5** — 190-emoji picker with search + recents; Unsplash & Pexels cover search built into the cover modal.
- **1.0.4** — Fixed false ‘would split a code block’ blocks below fenced code (closer/opener bug); repeat any blocked move within 8s to force it.
- **1.0.3** — Safe-move engine: verified block mapping, code-block/frontmatter guards, and an undo safety net — bad drops are refused instead of applied.
- **1.0.2** — Rebuilt drag & drop (pointer ghost + insertion line, auto-scroll) and AFFiNE-style new notes in the selected folder.
- **1.0.1** — Smoother feel: per-line hover highlight that clears instantly, soft handle pop-in, animated toggle open/close with eased arrow.
- **1.0.0** — Initial release.

MIT — do what you want with it. Enjoy the flow ✦

## 12. Credits

- Slash menu icons: Lucide (ISC licence, (c) Lucide contributors) — bundled offline in `src/icons.ts`.
- Page-icon emoji art: Twemoji (CC-BY 4.0, (c) Twitter/X contributors) — loaded from CDN at runtime with system-emoji fallback.
- Emoji catalog: Unicode emoji-test 15.1 + iamcal short-name aliases.
