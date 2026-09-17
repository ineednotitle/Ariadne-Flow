---
icon: ✦
cover: gradient-purple
---

# Notion-like Flow — Demo

> Hover any block and you'll see the `+` / `⠿` handle. Type `/` anywhere for the slash menu.

## Slash menu — try these

Type `/` then keep typing:

- `/toggle` → collapsible toggle block
- `/blue` → Notion blue callout
- `/table` → simple table
- `/divider`, `/code`, `/todo`, `/math`

## Toggle block

> [!toggle]+ ▶ Click me — I'm a Notion toggle
> This content hides and shows when you click the title.
> It works in **Live Preview** and **Reading view**.

> [!toggle]- Started collapsed (uses `-`)
> You can nest anything here:
> - bullets
> - more toggles!

## Notion color callouts

> [!n-gray] ⬜ Gray — neutral asides and metadata.
> [!n-blue] 🟦 Blue — info, links, references.
> [!n-red] 🟥 Red — important / don't skip this.
> [!n-green] 🟩 Green — done, success, resolved.
> [!n-yellow] 🟨 Yellow — warning / needs attention.
> [!n-purple] 🟪 Purple — pro tips and ideas.

## Blocks you can hover, drag & turn

- Bullet one — hover me → `⠿` → **Move down**
- Bullet two — try **Turn into: To-do**
- Bullet three
  - Nested child moves with its parent

1. Numbered Athena — drag the `⠿` grip to reorder me
2. Numbered Blake
3. Numbered Casey

- [ ] To-do: press `+` on the handle to insert below
- [x] To-do: done looks like Notion ✓

### A heading (hover → Turn into → Quote?)

A plain paragraph. Select the handle menu → **Copy block link** to get a `[[Demo#^nlf-xxxx]]` link.

> A quote block. Turn it into a callout from the `⠿` menu.

---

| Column 1 | Column 2 | Column 3 |
| --- | --- | --- |
| Notion | style | tables |
| with | rounded | borders |

```ts
// code blocks get softer Notion corners
const vibe = "notion-like";
console.log(vibe);
```

$$
E = mc^2
$$

## Page header (this demo's frontmatter)

```yaml
icon: ✦
cover: gradient-purple
```

Change it via Command palette → **Set page icon…** / **Set page cover…**, or edit the frontmatter:

- `cover:` accepts image URLs, `#hex`, `[[image.png]]`, vault paths, or `gradient-*` presets.

---

*Status bar shows `✦ words · min`. Ribbon ✦ toggles focus mode. Settings → Notion-like Flow for all toggles.*
