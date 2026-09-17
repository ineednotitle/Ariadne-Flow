import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Platform,
	Setting,
	TFile,
	requestUrl,
} from "obsidian";
import { NLF_ICONS } from "./icons";
import { renderEmoji } from "./emoji";
import { EMOJI_ALL } from "./emoji-data";

/* ============================================================
   Notion-like Flow — settings
   ============================================================ */

interface NLFSettings {
	showSlashMenu: boolean;
	colorEmoji: boolean;
	showDragHandle: boolean;
	showWordCount: boolean;
	showBreadcrumb: boolean;
	enableCovers: boolean;
	enableFocusDim: boolean;
	fullWidth: boolean;
	focusMode: boolean;
	notionFonts: boolean;
	hijackNewNote: boolean;
	newNoteMode: "selected" | "current" | "root";
	unsplashKey: string;
	pexelsKey: string;
	recentIcons: string[];
}

const DEFAULT_SETTINGS: NLFSettings = {
	showSlashMenu: true,
	colorEmoji: true,
	showDragHandle: true,
	showWordCount: true,
	showBreadcrumb: true,
	enableCovers: true,
	enableFocusDim: true,
	fullWidth: false,
	focusMode: false,
	notionFonts: true,
	hijackNewNote: true,
	newNoteMode: "selected",
	unsplashKey: "",
	pexelsKey: "",
	recentIcons: [],
};

/* ============================================================
   Small helpers
   ============================================================ */

type TurnKind =
	| "paragraph"
	| "h1" | "h2" | "h3"
	| "bullet" | "numbered" | "check"
	| "toggle" | "quote"
	| "callout-gray" | "callout-blue" | "callout-red" | "callout-green" | "callout-yellow" | "callout-purple"
	| "code" | "divider";

function stripMarkdownPrefix(line: string): string {
	let t = line.trim();
	// headings
	t = t.replace(/^#{1,6}\s+/, "");
	// blockquote / callout
	t = t.replace(/^>\s*(\[!.+?\][+-]?)?\s?/, "");
	// lists: - , *, +, 1. , - [ ] , - [x]
	t = t.replace(/^(\s*)([*+-]\s+\[[ xX]\]\s+|[*+-]\s+|\d+[.)]\s+)/, "");
	// inline code fence single line
	t = t.replace(/^```.*$/, "");
	return t;
}

function turnLineInto(line: string, kind: TurnKind): string {
	const content = stripMarkdownPrefix(line) || "Untitled";
	switch (kind) {
		case "paragraph": return content;
		case "h1": return `# ${content}`;
		case "h2": return `## ${content}`;
		case "h3": return `### ${content}`;
		case "bullet": return `- ${content}`;
		case "numbered": return `1. ${content}`;
		case "check": return `- [ ] ${content}`;
		case "toggle": return `> [!toggle]+ ${content}\n> `;
		case "quote": return `> ${content}`;
		case "callout-gray": return `> [!n-gray] ${content}`;
		case "callout-blue": return `> [!n-blue] ${content}`;
		case "callout-red": return `> [!n-red] ${content}`;
		case "callout-green": return `> [!n-green] ${content}`;
		case "callout-yellow": return `> [!n-yellow] ${content}`;
		case "callout-purple": return `> [!n-purple] ${content}`;
		case "code": return "```\n" + content + "\n```";
		case "divider": return "---";
		default: return content;
	}
}

function isFenceLine(line: string): boolean {
	return /^\s*(```|~~~)/.test(line);
}

function isTableLine(line: string): boolean {
	return /^\s*\|.*\|\s*$/.test(line);
}

function isHrLine(line: string): boolean {
	return /^\s*(---|\*\*\*|___)\s*$/.test(line);
}

function isQuoteLine(line: string): boolean {
	return /^\s*>/.test(line);
}

function listIndent(line: string): number | null {
	const m = line.match(/^(\s*)([*+-]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/);
	if (!m) return null;
	return m[1].replace(/\t/g, "    ").length;
}

function isSpecialStart(line: string): boolean {
	const t = line.trim();
	if (t === "") return true;
	if (/^#{1,6}\s/.test(t)) return true;
	if (isFenceLine(line)) return true;
	if (isQuoteLine(line)) return true;
	if (isTableLine(line)) return true;
	if (isHrLine(line)) return true;
	if (listIndent(line) !== null) return true;
	if (/^\$\$/.test(t)) return true;
	return false;
}

interface BlockRange { startLine: number; endLine: number; }

/** Expand a single source line into its Notion-like logical block (lists+children, quotes, fences, tables, paragraphs). */
function getLogicalBlockRange(editor: Editor, line: number): BlockRange {
	const count = editor.lineCount();
	if (line < 0) line = 0;
	if (line >= count) line = count - 1;
	const text = editor.getLine(line);

	// fenced code: expand to full fence
	if (isFenceLine(text)) {
		// if this is an opening fence, scan forward
		for (let i = line + 1; i < count; i++) {
			if (isFenceLine(editor.getLine(i))) return { startLine: line, endLine: i };
		}
		return { startLine: line, endLine: line };
	}
	// inside fenced block? correct parity check (a fence CLOSER above us does not mean inside)
	{
		let nearbyMarker = false;
		for (let i = line - 1; i >= Math.max(0, line - 200); i--) {
			if (isFenceLine(editor.getLine(i))) { nearbyMarker = true; break; }
		}
		if (nearbyMarker) {
			// count markers from doc start (after frontmatter): odd => inside a fence
			let countFrom = 0;
			try {
				if (editor.getLine(0) === "---") {
					for (let i = 1; i < line && i < count; i++) {
						if (editor.getLine(i) === "---") { countFrom = i + 1; break; }
					}
				}
			} catch { /* ignore */ }
			let markersBefore = 0;
			for (let i = countFrom; i < line; i++) {
				if (isFenceLine(editor.getLine(i))) markersBefore++;
			}
			if (markersBefore % 2 === 1) {
				// inside: nearest marker above is the opener
				let opener = -1;
				for (let i = line - 1; i >= countFrom; i--) {
					if (isFenceLine(editor.getLine(i))) { opener = i; break; }
				}
				if (opener >= 0) {
					for (let i = line + 1; i < count; i++) {
						if (isFenceLine(editor.getLine(i))) return { startLine: opener, endLine: i };
					}
					return { startLine: opener, endLine: line };
				}
			}
		}
	}

	// table block
	if (isTableLine(text)) {
		let s = line, e = line;
		while (s > 0 && isTableLine(editor.getLine(s - 1))) s--;
		while (e + 1 < count && isTableLine(editor.getLine(e + 1))) e++;
		return { startLine: s, endLine: e };
	}

	// quote / callout block
	if (isQuoteLine(text)) {
		let s = line, e = line;
		while (s > 0 && isQuoteLine(editor.getLine(s - 1))) s--;
		while (e + 1 < count && isQuoteLine(editor.getLine(e + 1))) e++;
		return { startLine: s, endLine: e };
	}

	// list block + indented children
	const indent = listIndent(text);
	if (indent !== null) {
		let e = line;
		for (let i = line + 1; i < count; i++) {
			const l = editor.getLine(i);
			if (l.trim() === "") {
				// include blank line only if next non-blank is deeper-indented
				const nxt = i + 1 < count ? editor.getLine(i + 1) : "";
				const ni = listIndent(nxt);
				const rawIndent = nxt.match(/^(\s*)/)?.[1].replace(/\t/g, "    ").length ?? 0;
				if ((ni !== null && ni > indent) || (nxt.trim() !== "" && rawIndent > indent)) {
					e = i + 1;
					i++;
					continue;
				}
				break;
			}
			const li = listIndent(l);
			const rawIndent = (l.match(/^(\s*)/)?.[1] ?? "").replace(/\t/g, "    ").length;
			if (li !== null) {
				if (li > indent) { e = i; continue; }
				break;
			}
			if (rawIndent > indent) { e = i; continue; }
			break;
		}
		return { startLine: line, endLine: e };
	}

	// blank line
	if (text.trim() === "") return { startLine: line, endLine: line };

	// hr, heading, math single
	if (isHrLine(text) || /^#{1,6}\s/.test(text.trim()) || /^\$\$/.test(text.trim())) {
		return { startLine: line, endLine: line };
	}

	// paragraph: expand over consecutive non-special lines
	let s = line, e = line;
	while (s > 0) {
		const p = editor.getLine(s - 1);
		if (p.trim() === "" || isSpecialStart(p)) break;
		s--;
	}
	while (e + 1 < count) {
		const n = editor.getLine(e + 1);
		if (n.trim() === "" || isSpecialStart(n)) break;
		e++;
	}
	return { startLine: s, endLine: e };
}

function getBlockText(editor: Editor, r: BlockRange): string {
	const parts: string[] = [];
	for (let i = r.startLine; i <= r.endLine; i++) parts.push(editor.getLine(i));
	return parts.join("\n");
}

/** Split full source into logical block ranges (used for Reading-view mapping). */
function splitSourceBlocks(lines: string[]): BlockRange[] {
	const ranges: BlockRange[] = [];
	let i = 0;
	const n = lines.length;
	// skip frontmatter
	if (lines[0] === "---") {
		let j = 1;
		while (j < n && lines[j] !== "---") j++;
		i = Math.min(n, j + 1);
	}
	while (i < n) {
		if (lines[i].trim() === "") { i++; continue; }
		const fake = {
			lineCount: () => n,
			getLine: (k: number) => lines[k] ?? "",
		} as Editor;
		const r = getLogicalBlockRange(fake, i);
		ranges.push(r);
		i = r.endLine + 1;
	}
	return ranges;
}

function countWords(text: string): { words: number; chars: number } {
	const stripped = text
		.replace(/^---[\s\S]*?---\n/, "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[#>*_`~\-+|:$]/g, " ");
	const words = stripped.trim() === "" ? 0 : stripped.trim().split(/\s+/).length;
	return { words, chars: text.length };
}

/* ============================================================
   Slash menu — block definitions
   ============================================================ */

interface BlockDef {
	id: string;
	title: string;
	icon: string;
	desc: string;
	keywords: string;
	run: (editor: Editor, ctx: EditorSuggestContext, plugin: NotionLikeFlowPlugin) => void;
}

function replaceTrigger(editor: Editor, ctx: EditorSuggestContext, text: string, placeCursor?: EditorPosition | { lineOffset: number; ch: number }) {
	editor.replaceRange(text, ctx.start, ctx.end);
	if (placeCursor) {
		if ("line" in placeCursor && "ch" in placeCursor && !("lineOffset" in placeCursor)) {
			editor.setCursor(placeCursor as EditorPosition);
		}
	}
	// default: cursor lands at end of inserted text
	if (placeCursor && "lineOffset" in (placeCursor as any)) {
		const p = placeCursor as { lineOffset: number; ch: number };
		const startLine = ctx.start.line + p.lineOffset;
		editor.setCursor({ line: startLine, ch: p.ch });
	} else if (!placeCursor) {
		const lines = text.split("\n");
		if (lines.length === 1) {
			editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + text.length });
		} else {
			editor.setCursor({ line: ctx.start.line + lines.length - 1, ch: lines[lines.length - 1].length });
		}
	}
}

function removeTrigger(editor: Editor, ctx: EditorSuggestContext) {
	editor.replaceRange("", ctx.start, ctx.end);
	editor.setCursor(ctx.start);
}

function tryNative(plugin: NotionLikeFlowPlugin, cmdId: string): boolean {
	try {
		return (plugin.app as any).commands.executeCommandById(cmdId) === true;
	} catch { /* older Obsidian without this command — caller falls back */ }
	return false;
}

function wrapSelection(editor: Editor, before: string, after: string, placeholder = "text") {
	const sel = editor.getSelection();
	if (sel && sel.length > 0) {
		editor.replaceSelection(before + sel + after);
	} else {
		const cur = editor.getCursor();
		editor.replaceRange(before + placeholder + after, cur);
		editor.setSelection(
			{ line: cur.line, ch: cur.ch + before.length },
			{ line: cur.line, ch: cur.ch + before.length + placeholder.length }
		);
	}
}

function buildBlocks(): BlockDef[] {
	return [
		{ id: "text", title: "Text", icon: "📝", desc: "Plain paragraph block", keywords: "text paragraph plain p",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "") },
		{ id: "h1", title: "Heading 1", icon: "🔠", desc: "Large section heading", keywords: "h1 heading title header big",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "# ", { lineOffset: 0, ch: 2 }) },
		{ id: "h2", title: "Heading 2", icon: "🔡", desc: "Medium section heading", keywords: "h2 heading subtitle header",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "## ", { lineOffset: 0, ch: 3 }) },
		{ id: "h3", title: "Heading 3", icon: "🔤", desc: "Small section heading", keywords: "h3 heading small header",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "### ", { lineOffset: 0, ch: 4 }) },
		{ id: "bullet", title: "Bulleted list", icon: "•", desc: "Simple bullet point", keywords: "bullet ul list point dash",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "- ", { lineOffset: 0, ch: 2 }) },
		{ id: "numbered", title: "Numbered list", icon: "1️⃣", desc: "Ordered list with numbers", keywords: "numbered ordered ol list 1.",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "1. ", { lineOffset: 0, ch: 3 }) },
		{ id: "check", title: "To-do list", icon: "☑️", desc: "Checkbox task list", keywords: "todo check task checkbox done",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "- [ ] ", { lineOffset: 0, ch: 6 }) },
		{ id: "toggle", title: "Toggle block", icon: "▶️", desc: "Collapsible Notion-style toggle", keywords: "toggle fold collapse accordion details",
			run: (ed, ctx) => {
				replaceTrigger(ed, ctx, "> [!toggle]+ Toggle title\n> Content goes here…", { lineOffset: 0, ch: 15 });
			} },
		{ id: "quote", title: "Quote", icon: "💬", desc: "Blockquote citation", keywords: "quote cite blockquote",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "> ", { lineOffset: 0, ch: 2 }) },
		{ id: "callout", title: "Callout", icon: "💡", desc: "Highlighted info box", keywords: "callout info note tip box admonition",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "> [!note] ", { lineOffset: 0, ch: 10 }) },
		{ id: "callout-blue", title: "Callout · Blue", icon: "🟦", desc: "Notion-style blue background", keywords: "callout blue color info",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "> [!n-blue] ", { lineOffset: 0, ch: 12 }) },
		{ id: "callout-gray", title: "Callout · Gray", icon: "⬜", desc: "Notion-style gray background", keywords: "callout gray grey color",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "> [!n-gray] ", { lineOffset: 0, ch: 12 }) },
		{ id: "callout-red", title: "Callout · Red", icon: "🟥", desc: "Notion-style red background", keywords: "callout red danger color",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "> [!n-red] ", { lineOffset: 0, ch: 11 }) },
		{ id: "callout-green", title: "Callout · Green", icon: "🟩", desc: "Notion-style green background", keywords: "callout green success color",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "> [!n-green] ", { lineOffset: 0, ch: 13 }) },
		{ id: "callout-yellow", title: "Callout · Yellow", icon: "🟨", desc: "Notion-style yellow background", keywords: "callout yellow warning color",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "> [!n-yellow] ", { lineOffset: 0, ch: 14 }) },
		{ id: "divider", title: "Divider", icon: "➖", desc: "Horizontal rule separator", keywords: "divider hr rule separator line ---",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "\n---\n") },
		{ id: "code", title: "Code block", icon: "💻", desc: "Fenced code with syntax highlight", keywords: "code snippet fence pre",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "```\n\n```", { lineOffset: 1, ch: 0 }) },
		{ id: "math", title: "Math equation", icon: "∑", desc: "LaTeX math block", keywords: "math latex equation formula",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "$$\n\n$$", { lineOffset: 1, ch: 0 }) },
		{ id: "table", title: "Table", icon: "📊", desc: "Simple 3-column markdown table", keywords: "table grid database simple",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |", { lineOffset: 2, ch: 2 }) },
		{ id: "link", title: "Page mention", icon: "@", desc: "Mention or link another note (opens search)", keywords: "mention link wikilink page @ [[ note reference",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "[[", { lineOffset: 0, ch: 2 }) },
		{ id: "embed", title: "Embed", icon: "🖼️", desc: "Embed a note, image or file", keywords: "embed transclude image file !",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "![[", { lineOffset: 0, ch: 3 }) },
		{ id: "date", title: "Current date", icon: "📅", desc: "Insert today's date", keywords: "date today time calendar",
			run: (ed, ctx) => {
				const d = new Date();
				const s = d.toISOString().slice(0, 10);
				replaceTrigger(ed, ctx, s);
			} },
		{ id: "toc", title: "Table of contents", icon: "📑", desc: "Auto TOC from headings (needs Outline)", keywords: "toc outline contents",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "```toc\n```", { lineOffset: 1, ch: 0 }) },
		{ id: "cover", title: "Page cover…", icon: "🌄", desc: "Set this page's banner cover", keywords: "cover banner header image gradient",
			run: (ed, ctx, plugin) => {
				replaceTrigger(ed, ctx, "");
				plugin.openCoverModal();
			} },
		{ id: "icon", title: "Page icon…", icon: "😀", desc: "Set this page's emoji icon", keywords: "icon emoji page",
			run: (ed, ctx, plugin) => {
				replaceTrigger(ed, ctx, "");
				plugin.openIconModal();
			} },
		{ id: "bold", title: "Bold", icon: "B", desc: "Bold **text** (same as mobile toolbar)", keywords: "bold strong ** b",
			run: (ed, ctx, plugin) => { removeTrigger(ed, ctx); if (!tryNative(plugin, "editor:toggle-bold")) wrapSelection(ed, "**", "**"); } },
		{ id: "italic", title: "Italic", icon: "I", desc: "Italic *text* (same as mobile toolbar)", keywords: "italic emphasis * i slanted",
			run: (ed, ctx, plugin) => { removeTrigger(ed, ctx); if (!tryNative(plugin, "editor:toggle-italics")) wrapSelection(ed, "*", "*"); } },
		{ id: "strike", title: "Strikethrough", icon: "S", desc: "Crossed-out ~~text~~", keywords: "strikethrough strike through ~~ s crossed deleted",
			run: (ed, ctx, plugin) => { removeTrigger(ed, ctx); if (!tryNative(plugin, "editor:toggle-strikethrough")) wrapSelection(ed, "~~", "~~"); } },
		{ id: "highlight", title: "Highlight", icon: "🖍️", desc: "Marked ==text==", keywords: "highlight mark == yellow h marker",
			run: (ed, ctx, plugin) => { removeTrigger(ed, ctx); if (!tryNative(plugin, "editor:toggle-highlight")) wrapSelection(ed, "==", "=="); } },
		{ id: "inline-code", title: "Inline code", icon: "</>", desc: "Monospace `code`", keywords: "inline code ` backtick mono snippet",
			run: (ed, ctx, plugin) => { removeTrigger(ed, ctx); if (!tryNative(plugin, "editor:toggle-code")) wrapSelection(ed, "`", "`", "code"); } },
		{ id: "comment", title: "Comment", icon: "💭", desc: "Hidden %%note%% (invisible in preview)", keywords: "comment %% hidden invisible note",
			run: (ed, ctx) => { removeTrigger(ed, ctx); wrapSelection(ed, "%%", "%%", "note"); } },
		{ id: "inline-math", title: "Inline math", icon: "$", desc: "Math $x$ inside a sentence", keywords: "inline math $ latex formula symbol",
			run: (ed, ctx) => { removeTrigger(ed, ctx); wrapSelection(ed, "$", "$", "x"); } },
		{ id: "web-link", title: "Web link", icon: "🔗", desc: "External [text](url) link", keywords: "link url web external http https []()",
			run: (ed, ctx) => {
				removeTrigger(ed, ctx);
				const cur = ed.getCursor();
				ed.replaceRange("[text](url)", cur);
				ed.setSelection({ line: cur.line, ch: cur.ch + 1 }, { line: cur.line, ch: cur.ch + 5 });
			} },
		{ id: "image-url", title: "Image from link", icon: "📷", desc: "Embed an image by URL", keywords: "image picture photo url ![]() media",
			run: (ed, ctx) => {
				removeTrigger(ed, ctx);
				const cur = ed.getCursor();
				ed.replaceRange("![alt](url)", cur);
				ed.setSelection({ line: cur.line, ch: cur.ch + 7 }, { line: cur.line, ch: cur.ch + 10 });
			} },
		{ id: "footnote", title: "Footnote", icon: "¹", desc: "Numbered [^1] reference note", keywords: "footnote ^ reference cite note number",
			run: (ed, ctx) => {
				removeTrigger(ed, ctx);
				let n = 0;
				ed.getValue().replace(/\[\^(\d+)\]/g, (_m, d) => { n = Math.max(n, parseInt(d, 10)); return _m; });
				n += 1;
				const ref = "[^" + n + "]";
				const cur = ed.getCursor();
				ed.replaceRange(ref, cur);
				const last = ed.lastLine();
				ed.replaceRange("\n\n" + ref + ": ", { line: last, ch: ed.getLine(last).length });
				ed.setCursor({ line: cur.line, ch: cur.ch + ref.length });
			} },
		{ id: "tag", title: "Tag", icon: "#", desc: "#tag label (suggestions pop up)", keywords: "tag # label hashtag topic",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "#", { lineOffset: 0, ch: 1 }) },
		{ id: "heading-link", title: "Link to heading", icon: "🔖", desc: "Jump link to a section in this note", keywords: "heading link section anchor [[# jump",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "[[#", { lineOffset: 0, ch: 3 }) },
		{ id: "props", title: "Page properties", icon: "⚙ FE0F", desc: "Frontmatter metadata at the top", keywords: "properties frontmatter metadata yaml --- settings",
			run: (ed, ctx) => {
				removeTrigger(ed, ctx);
				if (/^---\n/.test(ed.getValue())) { new Notice("This note already has properties"); return; }
				ed.replaceRange("---\n\n---\n", { line: 0, ch: 0 });
				ed.setCursor({ line: 1, ch: 0 });
			} },
		{ id: "mermaid", title: "Mermaid diagram", icon: "🧜", desc: "Flowchart drawn from text", keywords: "mermaid diagram flowchart graph chart",
			run: (ed, ctx) => replaceTrigger(ed, ctx, "```mermaid\ngraph TD;\n    A-->B;\n```", { lineOffset: 2, ch: 4 }) },
		{ id: "time", title: "Current time", icon: "🕐", desc: "Insert the time right now", keywords: "time clock now hour minute",
			run: (ed, ctx) => {
				const d = new Date();
				const s = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
				replaceTrigger(ed, ctx, s);
			} },
		{ id: "template", title: "Insert template…", icon: "📄", desc: "Insert from the Templates plugin", keywords: "template insert snippet boilerplate reuse",
			run: (ed, ctx, plugin) => {
				removeTrigger(ed, ctx);
				if (!tryNative(plugin, "templates:insert-template")) new Notice("Enable the Templates core plugin first (Settings \u2192 Core plugins)");
			} },
		{ id: "underline", title: "Underline", icon: "U", desc: "Underlined <u>text</u>", keywords: "underline under u line",
			run: (ed, ctx) => { removeTrigger(ed, ctx); wrapSelection(ed, "<u>", "</u>"); } },
		{ id: "attach", title: "Attach file…", icon: "📎", desc: "Attach a file from your vault", keywords: "attach attachment file upload paperclip image",
			run: (ed, ctx, plugin) => {
				removeTrigger(ed, ctx);
				if (!tryNative(plugin, "editor:insert-attachment")) {
					const cur = ed.getCursor();
					ed.replaceRange("![[", cur);
					ed.setCursor({ line: cur.line, ch: cur.ch + 3 });
				}
			} },
		{ id: "new-page", title: "New page", icon: "📃", desc: "Create + open a new note", keywords: "new page create note untitled",
			run: (ed, ctx, plugin) => {
				removeTrigger(ed, ctx);
				void (async () => {
					try {
						const app = plugin.app;
						let dir = "";
						try {
							const vc = app.vault as any;
							const loc = typeof vc.getConfig === "function" ? vc.getConfig("newFileLocation") : "root";
							if (loc === "folder") dir = vc.getConfig("newFileFolderPath") || "";
							else if (loc === "current") dir = app.workspace.getActiveFile()?.parent?.path ?? "";
							if (dir === "/") dir = "";
						} catch { dir = ""; }
						const base = (dir ? dir + "/" : "") + "Untitled";
						let path = base + ".md";
						let i = 1;
						while (app.vault.getAbstractFileByPath(path)) { i += 1; path = base + " " + i + ".md"; }
						await app.vault.create(path, "");
						await app.workspace.openLinkText(path.replace(/\.md$/, ""), "", true);
					} catch { new Notice("Could not create the new page"); }
				})();
			} },
	];
}


class SlashSuggest extends EditorSuggest<BlockDef> {
	plugin: NotionLikeFlowPlugin;
	blocks: BlockDef[];

	constructor(app: App, plugin: NotionLikeFlowPlugin) {
		super(app);
		this.plugin = plugin;
		this.blocks = buildBlocks();
		// style the suggest box
		this.setInstructions([{ command: "↑↓", purpose: "navigate" }, { command: "↵", purpose: "insert" }, { command: "esc", purpose: "dismiss" }]);
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		if (!this.plugin.settings.showSlashMenu) return null;
		const line = editor.getLine(cursor.line);
		const before = line.slice(0, cursor.ch);
		const m = before.match(/(^|\s)\/([A-Za-z0-9_-]*)$/);
		if (!m || m.index === undefined) return null;
		// don't trigger inside fenced code
		try {
			let fences = 0;
			for (let i = 0; i < cursor.line; i++) {
				if (isFenceLine(editor.getLine(i))) fences++;
			}
			if (fences % 2 === 1) return null;
		} catch { /* ignore */ }
		const startCh = m.index + m[1].length;
		return {
			start: { line: cursor.line, ch: startCh },
			end: cursor,
			query: m[2] ?? "",
		};
	}

	getSuggestions(ctx: EditorSuggestContext): BlockDef[] {
		const q = (ctx.query ?? "").toLowerCase().trim();
		if (!q) return this.blocks;
		return this.blocks.filter((b) =>
			b.title.toLowerCase().contains(q) ||
			b.keywords.contains(q) ||
			b.id.contains(q)
		);
	}

	renderSuggestion(value: BlockDef, el: HTMLElement) {
		el.addClass("nlf-slash-item");
		const icon = el.createDiv({ cls: "nlf-slash-icon" });
		const svg = NLF_ICONS[value.id];
		if (svg) icon.innerHTML = svg;
		else icon.setText(value.icon);
		const col = el.createDiv({ cls: "nlf-slash-col" });
		col.createDiv({ cls: "nlf-slash-title", text: value.title });
		col.createDiv({ cls: "nlf-slash-desc", text: value.desc });
	}

	selectSuggestion(value: BlockDef, _evt: MouseEvent | KeyboardEvent): void {
		const ctx = this.context;
		if (!ctx) return;
		try {
			value.run(ctx.editor, ctx, this.plugin);
		} catch (e) {
			console.error("Notion-like Flow: slash insert failed", e);
			new Notice("Slash insert failed — see console");
		}
	}
}

/* ============================================================
   Modals — page icon & cover
   ============================================================ */

const COVER_PRESETS: { name: string; value: string; css: string }[] = [
	{ name: "Notion beige", value: "gradient-beige", css: "linear-gradient(135deg,#f7f3ec,#ece5d8)" },
	{ name: "Blue", value: "gradient-blue", css: "linear-gradient(135deg,#dbeafe,#3b82f6)" },
	{ name: "Purple", value: "gradient-purple", css: "linear-gradient(135deg,#ede9fe,#8b5cf6)" },
	{ name: "Pink", value: "gradient-pink", css: "linear-gradient(135deg,#fce7f3,#ec4899)" },
	{ name: "Orange", value: "gradient-orange", css: "linear-gradient(135deg,#ffedd5,#f97316)" },
	{ name: "Green", value: "gradient-green", css: "linear-gradient(135deg,#dcfce7,#22c55e)" },
	{ name: "Slate", value: "gradient-slate", css: "linear-gradient(135deg,#f1f5f9,#64748b)" },
	{ name: "Dark", value: "gradient-dark", css: "linear-gradient(135deg,#1e293b,#020617)" },
];

function coverToCss(app: App, file: TFile, cover: string): string {
	const c = cover.trim();
	if (c.startsWith("http://") || c.startsWith("https://") || c.startsWith("data:")) {
		return `url("${c}")`;
	}
	if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
	const preset = COVER_PRESETS.find((p) => p.value === c);
	if (preset) return preset.css;
	// [[wikilink image]]
	const wiki = c.match(/^\[\[(.+?)\]\]$/);
	if (wiki) {
		try {
			const dest = app.metadataCache.getFirstLinkpathDest(wiki[1].split("|")[0].trim(), file.path);
			if (dest && dest instanceof TFile) {
				const url = app.vault.adapter.getResourcePath(dest.path);
				return `url("${url}")`;
			}
		} catch { /* ignore */ }
	}
	// vault-relative path
	if (c.match(/\.(png|jpe?g|gif|webp|svg|avif)$/i)) {
		try {
			const url = app.vault.adapter.getResourcePath(c.replace(/^\//, ""));
			return `url("${url}")`;
		} catch { /* ignore */ }
	}
	// raw CSS fallback
	return c;
}


/* "emoji keywords..." — parsed by splitting on the first space */

class IconModal extends Modal {
	plugin: NotionLikeFlowPlugin;
	private query = "";
	private gridItems: string[] = [];
	private gridShown = 0;
	constructor(app: App, plugin: NotionLikeFlowPlugin) {
		super(app);
		this.plugin = plugin;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("nlf-modal", "nlf-icon-modal");
		contentEl.createEl("h2", { text: "Set page icon" });
		const search = contentEl.createEl("input", { cls: "nlf-input", attr: { placeholder: "Search emoji…  (try: cat, rocket, coffee)" } });
		search.oninput = () => { this.query = search.value.trim().toLowerCase(); this.renderGrid(); };
		const wrap = contentEl.createDiv({ cls: "nlf-emoji-wrap" });
		wrap.createDiv({ cls: "nlf-emoji-count" });
		wrap.createDiv({ cls: "nlf-emoji-grid" });
		this.renderGrid();
		const row = contentEl.createDiv({ cls: "nlf-input-row" });
		const rnd = row.createEl("button", { text: "🎲 Random" });
		rnd.onclick = () => {
			const pick = EMOJI_ALL[Math.floor(Math.random() * EMOJI_ALL.length)].split(" ")[0];
			void this.plugin.setPageIcon(pick);
			this.close();
		};
		const input = row.createEl("input", { cls: "nlf-input", attr: { placeholder: "Or paste any emoji…", maxlength: "8" } });
		const save = row.createEl("button", { text: "Set", cls: "mod-cta" });
		save.onclick = () => { void this.plugin.setPageIcon(input.value.trim()); this.close(); };
		const clear = contentEl.createEl("button", { text: "Remove icon", cls: "nlf-link-btn" });
		clear.onclick = () => { void this.plugin.setPageIcon(null); this.close(); };
		if (!Platform.isMobile) setTimeout(() => search.focus(), 50);
	}
	private currentItems(): string[] {
		if (!this.query) return EMOJI_ALL;
		const q = this.query;
		return EMOJI_ALL.filter((s) => s.toLowerCase().includes(q));
	}
	private renderGrid() {
		const grid = this.contentEl.querySelector(".nlf-emoji-grid") as HTMLElement | null;
		const count = this.contentEl.querySelector(".nlf-emoji-count") as HTMLElement | null;
		if (!grid) return;
		grid.empty();
		grid.scrollTop = 0;
		this.gridItems = this.currentItems();
		this.gridShown = 0;
		if (count) count.setText(this.query ? `${this.gridItems.length} result${this.gridItems.length === 1 ? "" : "s"}` : `${this.gridItems.length} emoji — scroll, or type to search`);
		this.appendGridChunk(grid);
		grid.onscroll = () => {
			if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 240) this.appendGridChunk(grid);
		};
	}

	private appendGridChunk(grid: HTMLElement) {
		const slice = this.gridItems.slice(this.gridShown, this.gridShown + 240);
		for (const s of slice) {
			const sp = s.indexOf(" ");
			const emoji = sp < 0 ? s : s.slice(0, sp);
			const name = sp < 0 ? "" : s.slice(sp + 1);
			const b = grid.createEl("button", { cls: "nlf-emoji-btn", attr: { title: name } });
			renderEmoji(b, emoji, this.plugin.settings.colorEmoji);
			b.onclick = () => { void this.plugin.setPageIcon(emoji); this.close(); };
		}
		this.gridShown += slice.length;
	}
	onClose() {
		this.contentEl.empty();
	}
}

interface CoverPhoto { thumb: string; full: string; by: string; page: string; dl?: string; }

class CoverModal extends Modal {
	plugin: NotionLikeFlowPlugin;
	private tab: "gradients" | "unsplash" | "pexels" | "link" = "gradients";
	private uQuery = "";
	private uPage = 1;
	private uResults: CoverPhoto[] = [];
	private uDone = false;
	private pQuery = "";
	private pPage = 1;
	private pResults: CoverPhoto[] = [];
	private pDone = false;
	private busy = false;
	constructor(app: App, plugin: NotionLikeFlowPlugin) {
		super(app);
		this.plugin = plugin;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("nlf-modal", "nlf-cover-modal");
		contentEl.createEl("h2", { text: "Set page cover" });
		const tabs = contentEl.createDiv({ cls: "nlf-tabs" });
		const body = contentEl.createDiv({ cls: "nlf-cover-body" });
		this.renderTabs(tabs, body);
		this.renderBody(body);
	}
	private renderTabs(tabs: HTMLElement, body: HTMLElement) {
		tabs.empty();
		const defs: { id: typeof this.tab; label: string }[] = [
			{ id: "gradients", label: "Gradients" },
			{ id: "unsplash", label: "Unsplash" },
			{ id: "pexels", label: "Pexels" },
			{ id: "link", label: "Link" },
		];
		for (const d of defs) {
			const b = tabs.createEl("button", { text: d.label, cls: "nlf-tab" + (this.tab === d.id ? " is-active" : "") });
			b.onclick = () => { this.tab = d.id; this.renderTabs(tabs, body); this.renderBody(body); };
		}
	}
	private renderBody(body: HTMLElement) {
		body.empty();
		if (this.tab === "gradients") this.renderGradients(body);
		else if (this.tab === "link") this.renderLink(body);
		else if (this.tab === "unsplash") this.renderProvider(body, "unsplash");
		else this.renderProvider(body, "pexels");
	}
	private renderGradients(body: HTMLElement) {
		const grid = body.createDiv({ cls: "nlf-cover-grid" });
		COVER_PRESETS.forEach((p) => {
			const b = grid.createEl("button", { cls: "nlf-cover-swatch", attr: { title: p.name } });
			b.style.background = p.css;
			const label = b.createDiv({ cls: "nlf-cover-label" });
			label.setText(p.name);
			b.onclick = () => { void this.plugin.setPageCover(p.value); this.close(); };
		});
		const clear = body.createEl("button", { text: "Remove cover", cls: "nlf-link-btn" });
		clear.onclick = () => { void this.plugin.setPageCover(null); this.close(); };
	}
	private renderLink(body: HTMLElement) {
		body.createEl("p", { text: "Paste an image URL, a #hex color, a vault image path, or a gradient name.", cls: "nlf-muted" });
		const inputWrap = body.createDiv({ cls: "nlf-input-row" });
		const input = inputWrap.createEl("input", { cls: "nlf-input", attr: { placeholder: "https://… or #aabbcc or [[image.png]]" } });
		const save = inputWrap.createEl("button", { text: "Save", cls: "mod-cta" });
		save.onclick = () => { void this.plugin.setPageCover(input.value.trim()); this.close(); };
		const clear = body.createEl("button", { text: "Remove cover", cls: "nlf-link-btn" });
		clear.onclick = () => { void this.plugin.setPageCover(null); this.close(); };
		if (!Platform.isMobile) setTimeout(() => input.focus(), 50);
	}
	private renderProvider(body: HTMLElement, which: "unsplash" | "pexels") {
		const key = which === "unsplash" ? this.plugin.settings.unsplashKey : this.plugin.settings.pexelsKey;
		if (!key) {
			const box = body.createDiv({ cls: "nlf-hint-box" });
			box.createEl("strong", { text: "Add your free API key to search " + (which === "unsplash" ? "Unsplash" : "Pexels") });
			const steps = box.createEl("ol", { cls: "nlf-steps" });
			if (which === "unsplash") {
				steps.createEl("li", { text: "Go to unsplash.com/developers and create a free app" });
				steps.createEl("li", { text: "Copy the Access Key" });
			} else {
				steps.createEl("li", { text: "Go to pexels.com/api and request a free key" });
				steps.createEl("li", { text: "Copy the API key" });
			}
			steps.createEl("li", { text: "Paste it below — it stays on this device" });
			const row = box.createDiv({ cls: "nlf-input-row" });
			const input = row.createEl("input", { cls: "nlf-input", attr: { placeholder: "Paste API key…", type: "password" } });
			const save = row.createEl("button", { text: "Save & search", cls: "mod-cta" });
			save.onclick = async () => {
				const v = input.value.trim();
				if (!v) return;
				if (which === "unsplash") this.plugin.settings.unsplashKey = v;
				else this.plugin.settings.pexelsKey = v;
				await this.plugin.saveSettings();
				this.renderBody(body);
			};
			return;
		}
		const row = body.createDiv({ cls: "nlf-search-row" });
		const input = row.createEl("input", { cls: "nlf-input", attr: { placeholder: which === "unsplash" ? "Search Unsplash… (blank = curated)" : "Search Pexels… (blank = curated)" } });
		input.value = which === "unsplash" ? this.uQuery : this.pQuery;
		const go = row.createEl("button", { text: "Search", cls: "mod-cta" });
		const grid = body.createDiv({ cls: "nlf-photo-grid" });
		const more = body.createEl("button", { text: "Load more", cls: "nlf-load-more" });
		more.hide();
		const status = body.createDiv({ cls: "nlf-muted nlf-status" });
		const runSearch = (fresh: boolean) => { void this.providerSearch(which, input.value.trim(), grid, more, status, fresh); };
		go.onclick = () => runSearch(true);
		input.onkeydown = (e) => { if (e.key === "Enter") runSearch(true); };
		more.onclick = () => runSearch(false);
		const cached = which === "unsplash" ? this.uResults : this.pResults;
		if (cached.length > 0) {
			this.paintPhotos(grid, more, cached, which);
			status.setText(`${cached.length} photos — click one to use it`);
		} else {
			runSearch(true);
		}
	}
	private paintPhotos(grid: HTMLElement, more: HTMLElement, photos: CoverPhoto[], which: "unsplash" | "pexels") {
		grid.empty();
		for (const p of photos) {
			const b = grid.createEl("button", { cls: "nlf-photo", attr: { title: "Photo by " + p.by + " — click to use as cover" } });
			b.createEl("img", { attr: { src: p.thumb, loading: "lazy", alt: "Photo by " + p.by } });
			b.onclick = () => {
				if (which === "unsplash" && p.dl) {
					const key = this.plugin.settings.unsplashKey;
					void requestUrl({ url: p.dl + "&client_id=" + encodeURIComponent(key), method: "GET" }).catch(() => undefined);
				}
				void this.plugin.setPageCover(p.full);
				this.close();
			};
		}
		if (photos.length > 0) more.show();
		else more.hide();
	}
	private async providerSearch(which: "unsplash" | "pexels", query: string, grid: HTMLElement, more: HTMLElement, status: HTMLElement, fresh: boolean) {
		if (this.busy) return;
		this.busy = true;
		status.setText("Searching…");
		try {
			if (which === "unsplash") {
				const key = this.plugin.settings.unsplashKey;
				if (fresh) { this.uQuery = query; this.uPage = 1; this.uResults = []; this.uDone = false; }
				if (this.uDone) { status.setText("No more results"); return; }
				const url = query === ""
					? `https://api.unsplash.com/photos?per_page=18&page=${this.uPage}&orientation=landscape&client_id=${encodeURIComponent(key)}`
					: `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=18&page=${this.uPage}&orientation=landscape&client_id=${encodeURIComponent(key)}`;
				const res = await requestUrl({ url, method: "GET" });
				const data = res.json as { results?: any[] } | any[];
				const list: any[] = Array.isArray(data) ? data : (data.results ?? []);
				if (list.length === 0) this.uDone = true;
				for (const p of list) {
					this.uResults.push({
						thumb: p.urls?.small ?? p.urls?.thumb ?? "",
						full: (p.urls?.raw ?? p.urls?.regular ?? "") + "?auto=format&fit=crop&w=1600&q=70&utm_source=notion-like-flow&utm_medium=referral",
						by: p.user?.name ?? "Unsplash",
						page: p.links?.html ?? "",
						dl: p.links?.download_location ?? "",
					});
				}
				if (this.uResults.length >= 120) this.uDone = true;
				this.uPage++;
				this.paintPhotos(grid, more, this.uResults, which);
				status.setText(this.uResults.length === 0 ? "No results — try another search" : `${this.uResults.length} photos — click one to use it`);
			} else {
				const key = this.plugin.settings.pexelsKey;
				if (fresh) { this.pQuery = query; this.pPage = 1; this.pResults = []; this.pDone = false; }
				if (this.pDone) { status.setText("No more results"); return; }
				const url = query === ""
					? `https://api.pexels.com/v1/curated?per_page=18&page=${this.pPage}&orientation=landscape`
					: `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=18&page=${this.pPage}&orientation=landscape`;
				const res = await requestUrl({ url, method: "GET", headers: { Authorization: key } });
				const data = res.json as { photos?: any[] };
				const list: any[] = data.photos ?? [];
				if (list.length === 0) this.pDone = true;
				for (const p of list) {
					this.pResults.push({
						thumb: p.src?.medium ?? p.src?.small ?? "",
						full: (p.src?.original ?? p.src?.large2x ?? "") + "?auto=compress&cs=tinysrgb&w=1600",
						by: p.photographer ?? "Pexels",
						page: p.url ?? "",
					});
				}
				if (this.pResults.length >= 120) this.pDone = true;
				this.pPage++;
				this.paintPhotos(grid, more, this.pResults, which);
				status.setText(this.pResults.length === 0 ? "No results — try another search" : `${this.pResults.length} photos — click one to use it`);
			}
		} catch (err) {
			const st = (err as { status?: number })?.status ?? 0;
			if (st === 401 || st === 403) status.setText("API key rejected (401/403) — check the key in Settings → Notion-like Flow");
			else if (st === 429) status.setText("Rate limited — wait a minute and try again");
			else status.setText("Search failed (network?) — try again");
			console.error("Notion-like Flow: photo search failed", err);
		} finally {
			this.busy = false;
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ============================================================
   Settings tab
   ============================================================ */

class NLFSettingTab extends PluginSettingTab {
	plugin: NotionLikeFlowPlugin;
	constructor(app: App, plugin: NotionLikeFlowPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("nlf-settings");
		containerEl.createEl("h2", { text: "Notion-like Flow" });
		containerEl.createEl("p", { text: "Make Obsidian feel like Notion / AFFiNE. Type / for the slash menu, hover any block for the ⠿⠿ handle.", cls: "nlf-muted" });

		new Setting(containerEl).setName("Slash menu ( / )").setDesc("Show the Notion-style slash command menu while typing.")
			.addToggle((t) => t.setValue(this.plugin.settings.showSlashMenu).onChange(async (v) => { this.plugin.settings.showSlashMenu = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("Block drag handle").setDesc("Show the ⠿⠿ + menu handle when hovering blocks (Live Preview + Reading).")
			.addToggle((t) => t.setValue(this.plugin.settings.showDragHandle).onChange(async (v) => { this.plugin.settings.showDragHandle = v; await this.plugin.saveSettings(); this.plugin.hideHandle(); }));
		new Setting(containerEl).setName("Page covers & icons").setDesc("Render `icon:` and `cover:` frontmatter as a Notion page header.")
			.addToggle((t) => t.setValue(this.plugin.settings.enableCovers).onChange(async (v) => { this.plugin.settings.enableCovers = v; await this.plugin.saveSettings(); this.plugin.refreshPageHeaders(); }));
		new Setting(containerEl).setName("Color emoji images").setDesc("Draw page icons + picker with Twemoji images (same look on every device). Off = system emoji.")
			.addToggle((t) => t.setValue(this.plugin.settings.colorEmoji).onChange(async (v) => { this.plugin.settings.colorEmoji = v; await this.plugin.saveSettings(); this.plugin.refreshPageHeaders(); }));
		new Setting(containerEl).setName("Breadcrumb").setDesc("Show vault › folder › note path above the note.")
			.addToggle((t) => t.setValue(this.plugin.settings.showBreadcrumb).onChange(async (v) => { this.plugin.settings.showBreadcrumb = v; await this.plugin.saveSettings(); this.plugin.refreshPageHeaders(); }));
		new Setting(containerEl).setName("Word count in status bar").setDesc("Show words + reading time at the bottom.")
			.addToggle((t) => t.setValue(this.plugin.settings.showWordCount).onChange(async (v) => { this.plugin.settings.showWordCount = v; await this.plugin.saveSettings(); this.plugin.updateWordCount(); }));
		new Setting(containerEl).setName("Notion typography").setDesc("Cleaner fonts, spacing, callouts, tables and checkboxes.")
			.addToggle((t) => t.setValue(this.plugin.settings.notionFonts).onChange(async (v) => { this.plugin.settings.notionFonts = v; await this.plugin.saveSettings(); this.plugin.applyBodyClasses(); }));
		new Setting(containerEl).setName("Full width").setDesc("Use the full editor width like Notion.")
			.addToggle((t) => t.setValue(this.plugin.settings.fullWidth).onChange(async (v) => { this.plugin.settings.fullWidth = v; await this.plugin.saveSettings(); this.plugin.applyBodyClasses(); }));
		new Setting(containerEl).setName("Focus mode").setDesc("Hide sidebars and dim inactive blocks.")
			.addToggle((t) => t.setValue(this.plugin.settings.focusMode).onChange(async (v) => { this.plugin.settings.focusMode = v; await this.plugin.saveSettings(); this.plugin.applyBodyClasses(); }));
		new Setting(containerEl).setName("Dim inactive blocks in focus").setDesc("Only applies when focus mode is on.")
			.addToggle((t) => t.setValue(this.plugin.settings.enableFocusDim).onChange(async (v) => { this.plugin.settings.enableFocusDim = v; await this.plugin.saveSettings(); this.plugin.applyBodyClasses(); }));

		containerEl.createEl("h3", { text: "New notes (AFFiNE / Capacities style)" });
		new Setting(containerEl).setName("New-note button uses selected folder").setDesc("The + button in the file explorer creates the note inside the folder you last clicked (or that holds the highlighted file).")
			.addToggle((t) => t.setValue(this.plugin.settings.hijackNewNote).onChange(async (v) => { this.plugin.settings.hijackNewNote = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("Where new notes go").setDesc("Selected folder falls back to the open note's folder, then the vault root.")
			.addDropdown((d) => d
				.addOption("selected", "Selected folder in explorer")
				.addOption("current", "Same folder as open note")
				.addOption("root", "Vault root")
				.setValue(this.plugin.settings.newNoteMode)
				.onChange(async (v) => { this.plugin.settings.newNoteMode = v as "selected" | "current" | "root"; await this.plugin.saveSettings(); }));

		containerEl.createEl("h3", { text: "Cover search: Unsplash & Pexels" });
		containerEl.createEl("p", { text: "Free API keys unlock one-click cover photos in the cover picker. Keys stay on this device.", cls: "nlf-muted" });
		new Setting(containerEl).setName("Unsplash access key").setDesc("Create a free app at unsplash.com/developers and paste its Access Key here.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.placeholder = "Unsplash access key";
				t.setValue(this.plugin.settings.unsplashKey).onChange(async (v) => { this.plugin.settings.unsplashKey = v.trim(); await this.plugin.saveSettings(); });
			});
		new Setting(containerEl).setName("Pexels API key").setDesc("Request a free key at pexels.com/api and paste it here.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.placeholder = "Pexels API key";
				t.setValue(this.plugin.settings.pexelsKey).onChange(async (v) => { this.plugin.settings.pexelsKey = v.trim(); await this.plugin.saveSettings(); });
			});

		containerEl.createEl("h3", { text: "Page header" });
		new Setting(containerEl).setName("Set page icon").setDesc("Emoji stored as `icon:` in this note's frontmatter.")
			.addButton((b) => b.setButtonText("Choose…").onClick(() => this.plugin.openIconModal()));
		new Setting(containerEl).setName("Set page cover").setDesc("URL / gradient / color stored as `cover:` in frontmatter.")
			.addButton((b) => b.setButtonText("Choose…").onClick(() => this.plugin.openCoverModal()));
	}
}

/* ============================================================
   Main plugin
   ============================================================ */

interface HoverState {
	mode: "live" | "reading";
	view: MarkdownView;
	blockEl: HTMLElement;
	visualEl: HTMLElement; // innermost hovered line — highlight + handle anchor
	line: number;          // live: source line guess · reading: DOM block index
	sourceRange: BlockRange | null;
}

export default class NotionLikeFlowPlugin extends Plugin {
	settings: NLFSettings = DEFAULT_SETTINGS;
	statusEl: HTMLElement | null = null;
	handleEl: HTMLElement | null = null;
	hover: HoverState | null = null;
	private highlightEl: HTMLElement | null = null;
	private headerDebounce = 0;
	private headerSigs = new Map<string, string>();
	private observer: MutationObserver | null = null;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new NLFSettingTab(this.app, this));

		// slash menu
		this.registerEditorSuggest(new SlashSuggest(this.app, this));

		// ribbon (desktop only — mobile uses commands)
		if (!Platform.isMobile) {
			this.addRibbonIcon("sparkles", "Toggle Notion focus mode", () => { void this.toggleFocus(); });
		}

		// status bar (desktop only)
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("nlf-wordcount");
		}

		this.registerCommands();
		this.registerPostProcessors();
		this.setupBlockHandles();
		this.setupNewNoteInterception();
		this.setupTouchBlocks();
		this.setupHeaderRefresh();
		this.applyBodyClasses();
		this.updateWordCount();

		// refresh headers shortly after layout is ready
		this.app.workspace.onLayoutReady(() => {
			this.refreshPageHeaders();
			this.updateWordCount();
		});

		new Notice("Notion-like Flow loaded — type / anywhere ✦");
	}

	onunload() {
		this.hideHandle();
		this.handleEl?.remove();
		this.handleEl = null;
		this.dragGhost?.remove();
		this.dragGhost = null;
		this.dragLine?.remove();
		this.dragLine = null;
		this.clearTouchTimer();
		document.body.classList.remove("nlf-full-width", "nlf-focus", "nlf-focus-dim", "nlf-notion-type");
		document.querySelectorAll(".nlf-page-header").forEach((e) => e.remove());
		if (this.observer) { this.observer.disconnect(); this.observer = null; }
		if (this.headerDebounce) window.clearTimeout(this.headerDebounce);
		if (this.wcTimer) window.clearTimeout(this.wcTimer);
		if (this.hideTimer) window.clearTimeout(this.hideTimer);
	}

	/* ---------- settings ---------- */

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	applyBodyClasses() {
		document.body.classList.toggle("nlf-full-width", this.settings.fullWidth);
		document.body.classList.toggle("nlf-focus", this.settings.focusMode);
		document.body.classList.toggle("nlf-focus-dim", this.settings.focusMode && this.settings.enableFocusDim);
		document.body.classList.toggle("nlf-notion-type", this.settings.notionFonts);
	}

	/* ---------- commands ---------- */

	private registerCommands() {
		this.addCommand({
			id: "open-slash-menu", name: "Open slash menu",
			editorCallback: (editor: Editor) => {
				editor.replaceSelection("/");
			},
		});
		this.addCommand({
			id: "new-note-selected-folder", name: "New note in selected folder",
			callback: () => { void this.createNoteInFolder(this.resolveTargetFolder()); },
		});
		this.addCommand({
			id: "toggle-full-width", name: "Toggle full width",
			callback: () => { void this.toggleFullWidth(); },
		});
		this.addCommand({
			id: "toggle-focus-mode", name: "Toggle focus mode",
			callback: () => { void this.toggleFocus(); },
		});
		this.addCommand({
			id: "set-page-icon", name: "Set page icon…",
			callback: () => this.openIconModal(),
		});
		this.addCommand({
			id: "set-page-cover", name: "Set page cover…",
			callback: () => this.openCoverModal(),
		});
		this.addCommand({
			id: "insert-toggle", name: "Insert toggle block",
			editorCallback: (editor: Editor) => {
				const cur = editor.getCursor();
				editor.replaceRange("> [!toggle]+ Toggle title\n> ", cur);
				editor.setCursor({ line: cur.line, ch: 15 });
			},
		});
		this.addCommand({
			id: "insert-divider", name: "Insert divider",
			editorCallback: (editor: Editor) => {
				const cur = editor.getCursor();
				editor.replaceRange("\n---\n", cur);
			},
		});
		this.addCommand({
			id: "insert-table", name: "Insert simple table",
			editorCallback: (editor: Editor) => {
				const cur = editor.getCursor();
				editor.replaceRange("| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n", cur);
			},
		});
		const turns: { id: string; name: string; kind: TurnKind }[] = [
			{ id: "turn-paragraph", name: "Turn into: Text", kind: "paragraph" },
			{ id: "turn-h1", name: "Turn into: Heading 1", kind: "h1" },
			{ id: "turn-h2", name: "Turn into: Heading 2", kind: "h2" },
			{ id: "turn-h3", name: "Turn into: Heading 3", kind: "h3" },
			{ id: "turn-bullet", name: "Turn into: Bullet", kind: "bullet" },
			{ id: "turn-numbered", name: "Turn into: Numbered", kind: "numbered" },
			{ id: "turn-check", name: "Turn into: To-do", kind: "check" },
			{ id: "turn-toggle", name: "Turn into: Toggle", kind: "toggle" },
			{ id: "turn-quote", name: "Turn into: Quote", kind: "quote" },
			{ id: "turn-code", name: "Turn into: Code block", kind: "code" },
		];
		for (const t of turns) {
			this.addCommand({
				id: t.id, name: t.name,
				editorCallback: (editor: Editor) => this.turnCurrentBlock(editor, t.kind),
			});
		}
		this.addCommand({
			id: "duplicate-block", name: "Duplicate current block",
			editorCallback: (editor: Editor) => {
				const cur = editor.getCursor();
				const r = getLogicalBlockRange(editor, cur.line);
				const dupLines = editor.getValue().split("\n");
				if (this.fenceOverlapKind(this.getFenceRangesFromLines(dupLines), r.startLine, r.endLine) === "partial") {
					if (!this.blockOrForce("dup:" + r.startLine + "-" + r.endLine, "That would split a code block")) return;
				}
				const text = getBlockText(editor, r);
				const end = { line: r.endLine, ch: editor.getLine(r.endLine).length } as EditorPosition;
				editor.replaceRange("\n" + text, end);
			},
		});
	}

	private turnCurrentBlock(editor: Editor, kind: TurnKind) {
		const cur = editor.getCursor();
		const r = getLogicalBlockRange(editor, cur.line);
		const allLines = editor.getValue().split("\n");
		if (this.fenceOverlapKind(this.getFenceRangesFromLines(allLines), r.startLine, r.endLine) !== "none") {
			if (!this.blockOrForce("turn:" + r.startLine + "-" + r.endLine, "Can't reformat a code block this way")) return;
		}
		const first = editor.getLine(r.startLine);
		const turned = turnLineInto(first, kind);
		editor.replaceRange(
			turned,
			{ line: r.startLine, ch: 0 },
			{ line: r.endLine, ch: editor.getLine(r.endLine).length }
		);
		editor.setCursor({ line: r.startLine, ch: Math.min(turned.length, 64) });
	}

	async toggleFullWidth() {
		this.settings.fullWidth = !this.settings.fullWidth;
		await this.saveSettings();
		this.applyBodyClasses();
	}

	async toggleFocus() {
		this.settings.focusMode = !this.settings.focusMode;
		await this.saveSettings();
		this.applyBodyClasses();
		new Notice(this.settings.focusMode ? "Focus mode on — distractions hidden" : "Focus mode off");
	}

	/* ---------- markdown post-processing (Reading + Live embeds) ---------- */

	private registerPostProcessors() {
		this.registerMarkdownPostProcessor((el: HTMLElement) => {
			// Notion-style toggles: > [!toggle]
			el.querySelectorAll('.callout[data-callout="toggle"]').forEach((c) => {
				const call = c as HTMLElement;
				call.addClass("nlf-toggle");
				const title = call.querySelector(".callout-title") as HTMLElement | null;
				if (title && !title.hasClass("nlf-toggle-bound")) {
					title.addClass("nlf-toggle-bound");
					// capture + stopImmediatePropagation so Obsidian's native
					// callout fold can't double-toggle underneath us
					title.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						e.stopImmediatePropagation();
						const content = call.querySelector(".callout-content") as HTMLElement | null;
						const isOpen = !call.classList.contains("is-collapsed");
						if (!content) {
							call.classList.toggle("is-collapsed");
							return;
						}
						if (isOpen) {
							// smooth collapse: pin current height, then animate to 0
							content.style.maxHeight = content.scrollHeight + "px";
							void content.offsetHeight; // force reflow so the transition runs
							call.classList.add("is-collapsed");
						} else {
							// smooth expand: animate 0 → measured height, then release
							call.classList.remove("is-collapsed");
							content.style.maxHeight = content.scrollHeight + "px";
							content.style.opacity = "1";
							window.setTimeout(() => {
								if (!call.classList.contains("is-collapsed")) {
									content.style.maxHeight = "";
									content.style.opacity = "";
								}
							}, 230);
						}
					}, { capture: true });
				}
			});
			// Notion color callouts
			el.querySelectorAll(".callout").forEach((c) => {
				const call = c as HTMLElement;
				const kind = call.getAttribute("data-callout") ?? "";
				if (kind.startsWith("n-")) call.addClass("nlf-color-callout");
			});
			// wrap tables for nicer scroll like Notion
			el.querySelectorAll("table").forEach((t) => {
				const table = t as HTMLElement;
				if (!table.parentElement?.hasClass("nlf-table-wrap")) {
					const wrap = document.createElement("div");
					wrap.addClass("nlf-table-wrap");
					table.parentElement?.insertBefore(wrap, table);
					wrap.appendChild(table);
				}
			});
		});
	}

	/* ---------- block gutter handle ---------- */

	private setupBlockHandles() {
		// floating handle element
		const handle = document.createElement("div");
		handle.addClass("nlf-gutter-handle");
		handle.hide();
		const plus = document.createElement("button");
		plus.addClass("nlf-handle-btn");
		plus.setAttribute("title", "Insert block below (click) — type / for menu");
		plus.setText("+");
		plus.onmousedown = (e) => e.preventDefault();
		plus.onclick = (e) => { e.stopPropagation(); this.insertBelowHover(); };
		const grip = document.createElement("button");
		grip.addClass("nlf-handle-btn", "nlf-grip");
		grip.setAttribute("title", "Block menu — drag to move");
		grip.innerHTML = "⠿⠿";
		grip.onmousedown = (e) => e.preventDefault();
		grip.onclick = (e) => {
			e.stopPropagation();
			this.flushHover();
			if (Date.now() < this.suppressClickUntil) return; // was a drag, not a click
			this.showBlockMenu(e);
		};
		grip.onpointerdown = (e) => this.onGripPointerDown(e);
		handle.appendChild(plus);
		handle.appendChild(grip);
		document.body.appendChild(handle);
		this.handleEl = handle;

		this.registerDomEvent(document, "mouseover", (evt: MouseEvent) => {
			if (!this.settings.showDragHandle) { this.hideHandle(); return; }
			const t = evt.target as HTMLElement | null;
			if (!t || !(t instanceof HTMLElement)) return;
			if (t.closest(".nlf-gutter-handle,.menu,.modal,.suggestion-container,.prompt,.notice")) { this.clearHideTimer(); return; }
			if (this.hoverFromTarget(t)) this.clearHideTimer(); else this.scheduleHide();
		});

		this.registerDomEvent(document, "scroll", () => this.hideHandle(), { capture: true });
		this.registerDomEvent(document, "keydown", () => this.hideHandle());
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			const t = evt.target as HTMLElement | null;
			if (t && t.closest && t.closest(".nlf-gutter-handle")) return;
			this.hideHandle();
		});
		// pointer-based drag reorder (reliable inside Electron, no HTML5 DnD quirks)
		this.registerDomEvent(window, "pointermove", (evt: Event) => this.onDragMove(evt));
		this.registerDomEvent(window, "pointerup", (evt: Event) => { void this.finishDrag(evt); });
		this.registerDomEvent(window, "pointercancel", () => this.cancelDrag());
		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			if (evt.key === "Escape" && this.dragging) this.cancelDrag();
		});
	}

	private liveLineFromDom(view: MarkdownView, blockEl: HTMLElement): number {
		const editor = view.editor;
		if (!editor) return -1;
		// cached mapping (verified against current text, so edits can't go stale)
		if (!blockEl.hasClass("cm-embed-block")) {
			const cached = this.lineCache.get(blockEl);
			if (cached !== undefined && cached >= 0 && cached < editor.lineCount()
				&& this.domLineMatchesSource(editor, blockEl, cached)) {
				return cached;
			}
		}
		const line = this.mapDomToLineExact(editor, blockEl);
		if (line >= 0 && !blockEl.hasClass("cm-embed-block")) this.lineCache.set(blockEl, line);
		return line;
	}

	/** Exact DOM -> source-line mapping with verification. Returns -1 when uncertain (caller must abort). */
	private mapDomToLineExact(editor: Editor, blockEl: HTMLElement): number {
		// 1) CodeMirror exact position (widget-aware)
		try {
			const cm = (editor as unknown as { cm?: { posAtDOM?: (n: Node, o?: number) => number } }).cm;
			if (cm && typeof cm.posAtDOM === "function") {
				const pos = cm.posAtDOM(blockEl, 0);
				if (typeof pos === "number" && isFinite(pos) && pos >= 0) {
					const line = editor.offsetToPos(pos).line;
					if (line >= 0 && line < editor.lineCount() && this.domLineMatchesSource(editor, blockEl, line)) {
						return line;
					}
				}
			}
		} catch { /* fall through to text anchoring */ }
		// 2) fenced-code widgets: match rendered code against fence contents
		if (blockEl.hasClass("cm-embed-block")) {
			const code = (blockEl.innerText ?? "").replace(/\s+/g, " ").trim().toLowerCase();
			if (code.length >= 8) {
				const wlines = editor.getValue().split("\n");
				const fences = this.getFenceRangesFromLines(wlines);
				const head = code.slice(0, 120);
				const hits: number[] = [];
				for (const r of fences) {
					const body = wlines.slice(r.startLine + 1, r.endLine).join("\n")
						.replace(/\s+/g, " ").trim().toLowerCase();
					if (body && (body.includes(head) || code.includes(body.slice(0, 120)))) hits.push(r.startLine);
				}
				if (hits.length === 1) return hits[0];
			}
			return -1; // widgets must never be guessed
		}
		// 3) text-anchored search (requires a unique match)
		return this.findSourceLineByText(editor, blockEl);
	}

	private normSourceText(line: string): string {
		return stripMarkdownPrefix(line)
			.replace(/\^[A-Za-z0-9-]+$/, "")
			.replace(/[*_`~]/g, "")
			.replace(/%%.*?%%/g, "")
			.replace(/\|/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
	}

	private normDomText(blockEl: HTMLElement): string {
		let t = (blockEl.innerText ?? "").replace(/[\u200b]/g, "");
		// strip rendered bullets / numbers / checkboxes / quote + heading markers
		t = t.replace(/^\s*[\u2022\u25e6\u25aa]\s*/, "");
		t = t.replace(/^\s*\d+[.)]\s*/, "");
		t = t.replace(/^[\u2610\u2611\u2612\u2713\u2714]\s*/, "");
		t = t.replace(/^\s*>\s*/, "");
		t = t.replace(/^\s*#{1,6}\s*/, "");
		return t.replace(/\|/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
	}

	private domLineMatchesSource(editor: Editor, blockEl: HTMLElement, line: number): boolean {
		if (blockEl.hasClass("cm-embed-block")) return true; // widgets verified by move guards instead
		const dom = this.normDomText(blockEl);
		const src = this.normSourceText(editor.getLine(line));
		if (!dom && !src) return true;
		if (!dom || !src) return false;
		if (dom === src) return true;
		// containment fallback for decorated lines (links, highlights)
		if (dom.length >= 12 && src.length >= 12 && (dom.includes(src) || src.includes(dom))) return true;
		return false;
	}

	private findSourceLineByText(editor: Editor, blockEl: HTMLElement): number {
		if (blockEl.hasClass("cm-embed-block")) return -1; // widgets need CM mapping; never guess
		const dom = this.normDomText(blockEl);
		if (!dom) return -1; // blank/unknown line: refuse to guess
		const count = editor.lineCount();
		const fmEnd = this.frontmatterEndLine(editor);
		const strict: number[] = [];
		const loose: number[] = [];
		for (let i = 0; i < count; i++) {
			if (i <= fmEnd) continue; // never map into frontmatter
			const src = this.normSourceText(editor.getLine(i));
			if (!src) continue;
			if (src === dom) strict.push(i);
			else if (src.length >= 10 && dom.length >= 10 && (src.includes(dom) || dom.includes(src))) loose.push(i);
		}
		if (strict.length === 1) return strict[0];
		if (strict.length === 0 && loose.length === 1) return loose[0];
		return -1; // zero or ambiguous matches: refuse
	}

	private frontmatterEndLine(editor: Editor): number {
		try {
			if (editor.getLine(0) !== "---") return -1;
				for (let i = 1; i < editor.lineCount(); i++) {
				if (editor.getLine(i) === "---") return i;
			}
		} catch { /* ignore */ }
		return -1;
	}

	private frontmatterEndInLines(lines: string[]): number {
		if (lines.length === 0 || lines[0] !== "---") return -1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i] === "---") return i;
		}
		return -1;
	}

	private getFenceRangesFromLines(lines: string[]): BlockRange[] {
		const ranges: BlockRange[] = [];
		let open = -1;
		let marker = "";
		const skipTo = this.frontmatterEndInLines(lines);
		for (let i = skipTo + 1; i < lines.length; i++) {
			const m = lines[i].match(/^\s*(```+|~~~+)/);
			if (!m) continue;
			const mk = m[1].charAt(0); // ` or ~
			if (open < 0) { open = i; marker = mk; }
			else if (mk === marker) { ranges.push({ startLine: open, endLine: i }); open = -1; }
		}
		return ranges;
	}

	private countFenceMarkers(lines: string[]): number {
		let n = 0;
		for (const l of lines) {
			if (/^\s*(```+|~~~+)/.test(l)) n++;
		}
		return n;
	}

	/** How a [start,end] span relates to fenced code blocks. */
	private fenceOverlapKind(ranges: BlockRange[], start: number, end: number): "none" | "inside" | "contains" | "partial" {
		let inside = false;
		let contains = false;
		for (const r of ranges) {
			if (start <= r.startLine && end >= r.endLine) contains = true;
			else if (start >= r.startLine && end <= r.endLine) inside = true;
			else if (start <= r.endLine && end >= r.startLine) return "partial";
		}
		if (contains) return "contains";
		if (inside) return "inside";
		return "none";
	}

	private isIndexInsideFence(ranges: BlockRange[], index: number): boolean {
		for (const r of ranges) {
			if (index > r.startLine && index <= r.endLine) return true;
		}
		return false;
	}

	/**
	 * Soft-block with a force override: the first attempt shows a notice and refuses;
	 * repeating the IDENTICAL action within 8s forces it through (manual undo is the net).
	 * Returns true when the op may proceed.
	 */
	private blockOrForce(key: string, reason: string): boolean {
		const now = Date.now();
		if (this.lastBlock && this.lastBlock.key === key && now - this.lastBlock.time < 8000) {
			this.lastBlock = null;
			new Notice("Forced: " + reason);
			return true;
		}
		this.lastBlock = { key, time: now };
		new Notice(reason + " — no changes made (try again to force it)");
		return false;
	}

	/** Resolve + validate the hovered live block. Null = refuse (with notice). */
	private resolveLiveBlock(editor: Editor, line: number): BlockRange | null {
		if (line < 0 || line >= editor.lineCount()) {
			new Notice("Couldn't map this block safely — no changes made");
			return null;
		}
		const lines = editor.getValue().split("\n");
		const fmEnd = this.frontmatterEndInLines(lines);
		if (line <= fmEnd) {
			new Notice("That block is frontmatter — no changes made");
			return null;
		}
		const range = getLogicalBlockRange(editor, line);
		const fences = this.getFenceRangesFromLines(lines);
		const kind = this.fenceOverlapKind(fences, range.startLine, range.endLine);
		const forceKey = "block:" + range.startLine + "-" + range.endLine;
		if (kind === "partial") {
			if (!this.blockOrForce(forceKey, "That would split a code block")) return null;
		} else if (kind === "inside") {
			if (!this.blockOrForce(forceKey, "Inside a code block")) return null;
		}
		return range;
	}

	private readingBlockFromTarget(section: HTMLElement, t: HTMLElement): HTMLElement | null {
		let node: HTMLElement | null = t;
		while (node && node.parentElement !== section) {
			node = node.parentElement;
			if (!node) return null;
			if (node.hasClass("nlf-page-header")) return null;
		}
		if (!node || node === section) return null;
		return node;
	}

	/** Innermost hovered line (li, p, heading…) for precise per-line highlight + handle placement. */
	private readingVisualFromTarget(blockEl: HTMLElement, t: HTMLElement): HTMLElement {
		const inner = t.closest("li, p, h1, h2, h3, h4, h5, h6, pre, table, hr, .callout, blockquote") as HTMLElement | null;
		if (inner && inner !== blockEl && blockEl.contains(inner)) return inner;
		return blockEl;
	}

	private hoverQueued: HoverState | null = null;
	private hoverRaf = 0;

	private showHandleFor(h: HoverState) {
		// same block: skip redundant work (also prevents handle flicker)
		if (this.hover && this.hover.visualEl === h.visualEl && this.hover.mode === h.mode) return;
		// coalesce: at most one positioning pass per animation frame
		this.hoverQueued = h;
		if (this.hoverRaf) return;
		this.hoverRaf = requestAnimationFrame(() => {
			this.hoverRaf = 0;
			const q = this.hoverQueued;
			this.hoverQueued = null;
			if (q) this.positionHandle(q);
		});
	}

	/** Run any queued hover positioning immediately (before menu/drag reads this.hover). */
	private flushHover() {
		if (this.hoverRaf) { cancelAnimationFrame(this.hoverRaf); this.hoverRaf = 0; }
		const q = this.hoverQueued;
		this.hoverQueued = null;
		if (q) this.positionHandle(q);
	}

	private setHighlight(el: HTMLElement | null) {
		if (this.highlightEl === el) return;
		this.highlightEl?.removeClass("nlf-hover-block");
		this.highlightEl = el;
		el?.addClass("nlf-hover-block");
	}

	private positionHandle(h: HoverState) {
		if (!this.handleEl) return;
		this.clearHideTimer();
		this.hover = h;
		const anchor = h.visualEl ?? h.blockEl;
		const rect = anchor.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return;
		const handle = this.handleEl;
		handle.show();
		// gutter-anchored: hug the content's left edge (line start), not the
		// hovered element's own edge (nested items/cells would push it mid-line)
		const content = anchor.closest(".cm-content, .markdown-preview-section") as HTMLElement | null;
		const gutterLeft = content ? content.getBoundingClientRect().left : rect.left;
		const w = handle.offsetWidth || 64;
		let left = gutterLeft - w - 6;
		if (left < 8) left = gutterLeft + 4; // narrow pane: overlay just inside the start
		handle.style.top = `${Math.max(4, rect.top - 2)}px`;
		handle.style.left = `${left}px`;
		// highlight follows the hover precisely — cleared the instant you move away
		this.setHighlight(anchor);
	}

	private hideTimer = 0;

	/** Cancel a pending auto-hide. */
	private clearHideTimer() {
		if (this.hideTimer) { window.clearTimeout(this.hideTimer); this.hideTimer = 0; }
	}

	/** Hide the handle after a short delay — moving toward it cancels. */
	private scheduleHide(ms = 300) {
		this.clearHideTimer();
		this.hideTimer = window.setTimeout(() => { this.hideTimer = 0; this.hideHandle(); }, ms);
	}

	hideHandle() {
		this.clearHideTimer();
		this.hoverQueued = null;
		if (this.hoverRaf) { cancelAnimationFrame(this.hoverRaf); this.hoverRaf = 0; }
		this.handleEl?.hide();
		this.hover = null;
		this.setHighlight(null);
	}

	/* ----- block menu actions ----- */

	private showBlockMenu(evt: MouseEvent) {
		const h = this.hover;
		if (!h) return;
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Duplicate block").setIcon("copy").onClick(() => { void this.duplicateHover(); }));
		menu.addItem((item) => item.setTitle("Delete block").setIcon("trash-2").onClick(() => { void this.deleteHover(); }));
		menu.addItem((item) => item.setTitle("Insert block below").setIcon("plus").onClick(() => { this.insertBelowHover(); }));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Move up").setIcon("arrow-up").onClick(() => { void this.moveHover(-1); }));
		menu.addItem((item) => item.setTitle("Move down").setIcon("arrow-down").onClick(() => { void this.moveHover(1); }));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Copy block text").setIcon("clipboard").onClick(() => { void this.copyHoverText(); }));
		menu.addItem((item) => item.setTitle("Copy block link").setIcon("link").onClick(() => { void this.copyHoverLink(); }));
		menu.addSeparator();
		const turns: { label: string; kind: TurnKind }[] = [
			{ label: "Turn into: Text", kind: "paragraph" },
			{ label: "Turn into: Heading 1", kind: "h1" },
			{ label: "Turn into: Heading 2", kind: "h2" },
			{ label: "Turn into: Heading 3", kind: "h3" },
			{ label: "Turn into: Bullet", kind: "bullet" },
			{ label: "Turn into: Numbered", kind: "numbered" },
			{ label: "Turn into: To-do", kind: "check" },
			{ label: "Turn into: Toggle", kind: "toggle" },
			{ label: "Turn into: Quote", kind: "quote" },
			{ label: "Turn into: Code block", kind: "code" },
		];
		for (const t of turns) {
			menu.addItem((item) => item.setTitle(t.label).setIcon("text").onClick(() => { void this.turnHover(t.kind); }));
		}
		menu.showAtMouseEvent(evt);
	}

	private async liveRange(): Promise<{ editor: Editor; range: BlockRange } | null> {
		const h = this.hover;
		if (!h) return null;
		if (h.mode === "live") {
			const editor = h.view.editor;
			if (!editor) return null;
			const range = this.resolveLiveBlock(editor, h.line);
			if (!range) return null;
			return { editor, range };
		}
		return null;
	}

	private async readingSource(): Promise<{ file: TFile; lines: string[]; ranges: BlockRange[]; domIndex: number } | null> {
		const h = this.hover;
		if (!h || h.mode !== "reading") return null;
		const file = h.view.file;
		if (!file) return null;
		const src = await this.app.vault.read(file);
		const lines = src.split("\n");
		const ranges = splitSourceBlocks(lines);
		// map DOM index → source range index (header occupies index 0 when present)
		const section = h.blockEl.parentElement;
		let domKids = section ? Array.from(section.children).filter((c) => !c.hasClass("nlf-page-header")) : [];
		const domIndex = domKids.indexOf(h.blockEl);
		return { file, lines, ranges, domIndex: Math.max(0, domIndex) };
	}

	private async duplicateHover() {
		const h = this.hover;
		if (!h) return;
		if (h.mode === "live") {
			const lr = await this.liveRange();
			if (!lr) return;
			const text = getBlockText(lr.editor, lr.range);
			const end = { line: lr.range.endLine, ch: lr.editor.getLine(lr.range.endLine).length };
			lr.editor.replaceRange("\n" + text, end);
			new Notice("Block duplicated");
		} else {
			const rs = await this.readingSource();
			if (!rs || rs.ranges.length === 0) return;
			const ri = Math.min(rs.domIndex, rs.ranges.length - 1);
			const r = rs.ranges[ri];
			const chunk = rs.lines.slice(r.startLine, r.endLine + 1).join("\n");
			rs.lines.splice(r.endLine + 1, 0, chunk);
			await this.app.vault.modify(rs.file, rs.lines.join("\n"));
			new Notice("Block duplicated");
		}
		this.hideHandle();
	}

	private async deleteHover() {
		const h = this.hover;
		if (!h) return;
		if (h.mode === "live") {
			const lr = await this.liveRange();
			if (!lr) return;
			const from = { line: lr.range.startLine, ch: 0 };
			const endLine = lr.range.endLine;
			const to = endLine + 1 < lr.editor.lineCount()
				? { line: endLine + 1, ch: 0 }
				: { line: endLine, ch: lr.editor.getLine(endLine).length };
			lr.editor.replaceRange("", from, to);
			new Notice("Block deleted");
		} else {
			const rs = await this.readingSource();
			if (!rs || rs.ranges.length === 0) return;
			const ri = Math.min(rs.domIndex, rs.ranges.length - 1);
			const r = rs.ranges[ri];
			rs.lines.splice(r.startLine, r.endLine - r.startLine + 1);
			await this.app.vault.modify(rs.file, rs.lines.join("\n"));
			new Notice("Block deleted");
		}
		this.hideHandle();
	}

	private async moveHover(dir: -1 | 1) {
		const h = this.hover;
		if (!h) return;
		if (h.mode === "live") {
			const editor = h.view.editor;
			if (!editor) return;
			const r = this.resolveLiveBlock(editor, h.line);
			if (!r) { this.hideHandle(); return; }
			const count = editor.lineCount();
			if (dir === -1 && r.startLine === 0) return;
			if (dir === 1 && r.endLine >= count - 1) return;
			if (dir === -1) {
				const prev = getLogicalBlockRange(editor, r.startLine - 1);
				if (this.moveLiveBlock(editor, r.startLine, prev.startLine, false)) {
					this.hover = { ...h, line: r.startLine - (prev.endLine - prev.startLine + 1) };
				}
			} else {
				const next = getLogicalBlockRange(editor, r.endLine + 1);
				if (this.moveLiveBlock(editor, r.startLine, next.endLine, true)) {
					this.hover = { ...h, line: r.startLine + (next.endLine - next.startLine + 1) };
				}
			}
		} else {
			const rs = await this.readingSource();
			if (!rs || rs.ranges.length < 2) return;
			const ri = Math.min(rs.domIndex, rs.ranges.length - 1);
			const ni = ri + dir;
			if (ni < 0 || ni >= rs.ranges.length) return;
			const a = rs.ranges[Math.min(ri, ni)];
			const b = rs.ranges[Math.max(ri, ni)];
			const chunkA = rs.lines.slice(a.startLine, a.endLine + 1);
			const chunkB = rs.lines.slice(b.startLine, b.endLine + 1);
			const middle = rs.lines.slice(a.endLine + 1, b.startLine);
			const merged = [...chunkB, ...middle, ...chunkA];
			rs.lines.splice(a.startLine, b.endLine - a.startLine + 1, ...merged);
			await this.app.vault.modify(rs.file, rs.lines.join("\n"));
		}
		this.hideHandle();
	}

	private async turnHover(kind: TurnKind) {
		const h = this.hover;
		if (!h) return;
		if (h.mode === "live") {
			const lr = await this.liveRange();
			if (!lr) return;
			const liveLines = lr.editor.getValue().split("\n");
			const liveFences = this.getFenceRangesFromLines(liveLines);
			if (this.fenceOverlapKind(liveFences, lr.range.startLine, lr.range.endLine) !== "none") {
				if (!this.blockOrForce("turn:" + lr.range.startLine + "-" + lr.range.endLine, "Can't reformat a code block this way")) {
					this.hideHandle();
					return;
				}
			}
			const first = lr.editor.getLine(lr.range.startLine);
			const turned = turnLineInto(first, kind);
			lr.editor.replaceRange(
				turned,
				{ line: lr.range.startLine, ch: 0 },
				{ line: lr.range.endLine, ch: lr.editor.getLine(lr.range.endLine).length }
			);
		} else {
			const rs = await this.readingSource();
			if (!rs || rs.ranges.length === 0) return;
			const ri = Math.min(rs.domIndex, rs.ranges.length - 1);
			const r = rs.ranges[ri];
			const turned = turnLineInto(rs.lines[r.startLine] ?? "", kind);
			rs.lines.splice(r.startLine, r.endLine - r.startLine + 1, ...turned.split("\n"));
			await this.app.vault.modify(rs.file, rs.lines.join("\n"));
		}
		this.hideHandle();
	}

	private async copyHoverText() {
		const h = this.hover;
		if (!h) return;
		let text = "";
		if (h.mode === "live") {
			const lr = await this.liveRange();
			if (!lr) return;
			text = getBlockText(lr.editor, lr.range);
		} else {
			const rs = await this.readingSource();
			if (rs && rs.ranges.length > 0) {
				const ri = Math.min(rs.domIndex, rs.ranges.length - 1);
				const r = rs.ranges[ri];
				text = rs.lines.slice(r.startLine, r.endLine + 1).join("\n");
			} else {
				text = h.visualEl.innerText ?? "";
			}
		}
		try {
			await navigator.clipboard.writeText(text);
			new Notice("Block text copied");
		} catch {
			new Notice("Copy failed — clipboard blocked");
		}
		this.hideHandle();
	}

	private async copyHoverLink() {
		const h = this.hover;
		if (!h) return;
		const file = h.view.file;
		if (!file) return;
		const id = "^nlf-" + Math.random().toString(36).slice(2, 8);
		if (h.mode === "live") {
			const lr = await this.liveRange();
			if (!lr) return;
			const endLine = lr.range.endLine;
			const lineText = lr.editor.getLine(endLine);
			if (!/\^[A-Za-z0-9-]+$/.test(lineText.trim())) {
				lr.editor.replaceRange(lineText + " " + id, { line: endLine, ch: 0 }, { line: endLine, ch: lineText.length });
			}
		}
		const link = `[[${file.basename}#${id}]]`;
		try {
			await navigator.clipboard.writeText(link);
			new Notice("Block link copied");
		} catch {
			new Notice(link);
		}
		this.hideHandle();
	}

	private insertBelowHover() {
		const h = this.hover;
		if (!h || h.mode !== "live") {
			new Notice("Switch to Live Preview to insert here — or just press / anywhere");
			return;
		}
		const editor = h.view.editor;
		if (!editor) return;
		const r = this.resolveLiveBlock(editor, h.line);
		if (!r) { this.hideHandle(); return; }
		const end = { line: r.endLine, ch: editor.getLine(r.endLine).length };
		editor.replaceRange("\n/", end);
		editor.setCursor({ line: r.endLine + 1, ch: 1 });
		this.hideHandle();
	}

	/* ---------- hover resolution (shared by mouse + touch) ---------- */

	/** Find the MarkdownView that actually owns a DOM node (multi-pane safe). */
	private markdownViewFromEl(el: HTMLElement): MarkdownView | null {
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.containerEl.contains(el)) return v;
		}
		return null;
	}

	/** Resolve a DOM target to a block and queue the handle. Returns false when nothing hoverable. */
	private hoverFromTarget(t: HTMLElement): boolean {
		if (t.closest(".nlf-gutter-handle,.menu,.modal,.suggestion-container,.prompt,.notice")) return false;
		// live preview?
		const cmLine = t.closest(".cm-line") as HTMLElement | null;
		const embedBlock = t.closest(".cm-embed-block") as HTMLElement | null;
		if (cmLine || embedBlock) {
			const view = this.markdownViewFromEl(t);
			if (!view || !view.editor) return false;
			const blockEl = (embedBlock ?? cmLine) as HTMLElement;
			const line = this.liveLineFromDom(view, blockEl);
			this.showHandleFor({ mode: "live", view, blockEl, visualEl: blockEl, line, sourceRange: null });
			return true;
		}
		// reading view?
		const preview = t.closest(".markdown-preview-view") as HTMLElement | null;
		if (preview) {
			const view = this.markdownViewFromEl(t);
			if (!view || !view.file) return false;
			const section = t.closest(".markdown-preview-section") as HTMLElement | null;
			if (!section) return false;
			const blockEl = this.readingBlockFromTarget(section, t);
			if (!blockEl) return false;
			const visualEl = this.readingVisualFromTarget(blockEl, t);
			const idx = Array.from(section.children).indexOf(blockEl);
			this.showHandleFor({ mode: "reading", view, blockEl, visualEl, line: idx, sourceRange: null });
			return true;
		}
		return false;
	}

	/* ---------- touch support: long-press menu + press-drag (mobile) ---------- */

	private touchStart: { x: number; y: number; time: number; target: HTMLElement } | null = null;
	private touchTimer = 0;
	private touchArmed = false;
	private touchDragging = false;
	private suppressNextContextMenu = false;

	private setupTouchBlocks() {
		this.registerDomEvent(document, "touchstart", (evt: TouchEvent) => {
			if (evt.touches.length !== 1 || !this.settings.showDragHandle) return;
			const t = evt.target as HTMLElement | null;
			if (!t || !(t instanceof HTMLElement)) return;
			if (t.closest(".nlf-gutter-handle,.menu,.modal,.suggestion-container,.prompt,.notice,.nlf-photo-grid")) return;
			if (!t.closest(".cm-line,.cm-embed-block,.markdown-preview-view")) return;
			const touch = evt.touches[0];
			this.touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now(), target: t };
			this.touchArmed = false;
			this.touchDragging = false;
			this.clearTouchTimer();
			this.touchTimer = window.setTimeout(() => this.onTouchHold(), 450);
		}, { passive: true });
		this.registerDomEvent(document, "touchmove", (evt: TouchEvent) => {
			if (!this.touchStart) return;
			const touch = evt.touches[0];
			if (!touch) return;
			const dx = touch.clientX - this.touchStart.x;
			const dy = touch.clientY - this.touchStart.y;
			if (!this.touchArmed) {
				if (Math.hypot(dx, dy) > 12) this.clearTouchTimer(); // it is a scroll
				return;
			}
			// armed + moving: press-drag, feed synthetic moves into the drag engine
			if (!this.touchDragging) {
				if (Math.hypot(dx, dy) < 8) return;
				if (!this.hover) { this.clearTouchTimer(); return; }
				this.touchDragging = true;
				this.suppressNextContextMenu = true;
			}
			this.emitDragPointer("pointermove", touch.clientX, touch.clientY);
		}, { passive: true });
		const endTouch = (evt: TouchEvent) => {
			const wasArmed = this.touchArmed;
			const wasDragging = this.touchDragging;
			const start = this.touchStart;
			this.clearTouchTimer();
			this.touchStart = null;
			this.touchArmed = false;
			this.touchDragging = false;
			if (wasDragging) {
				const touch = (evt.changedTouches && evt.changedTouches[0]) || null;
				this.emitDragPointer("pointerup", touch ? touch.clientX : 0, touch ? touch.clientY : 0);
				return;
			}
			if (wasArmed && start && this.hover) {
				// long-press without movement: open the block menu at the finger
				this.suppressNextContextMenu = true;
				this.showBlockMenuAt(start.x, start.y);
			}
		};
		this.registerDomEvent(document, "touchend", endTouch);
		this.registerDomEvent(document, "touchcancel", () => {
			const wasDragging = this.touchDragging;
			this.clearTouchTimer();
			this.touchStart = null;
			this.touchArmed = false;
			this.touchDragging = false;
			if (wasDragging) this.cancelDrag();
		});
		this.registerDomEvent(document, "contextmenu", (evt: MouseEvent) => {
			if (this.suppressNextContextMenu) {
				this.suppressNextContextMenu = false;
				evt.preventDefault();
				evt.stopPropagation();
			}
		}, { capture: true });
	}

	private clearTouchTimer() {
		if (this.touchTimer) { window.clearTimeout(this.touchTimer); this.touchTimer = 0; }
	}

	private onTouchHold() {
		this.touchTimer = 0;
		const s = this.touchStart;
		if (!s) return;
		// reuse the hover pipeline to resolve + highlight the block, then arm menu/drag
		this.hoverFromTarget(s.target);
		this.flushHover();
		if (!this.hover) return;
		this.touchArmed = true;
		try { navigator.vibrate(12); } catch { /* ignore */ }
	}

	private emitDragPointer(type: "pointermove" | "pointerup", x: number, y: number) {
		if (type === "pointermove") {
			if (!this.dragPayload && this.hover) {
				// arm the drag engine the way a grip press would
				this.dragPayload = { mode: this.hover.mode, view: this.hover.view, line: this.hover.line };
				this.dragging = false;
				this.dragStartX = this.touchStart ? this.touchStart.x : x;
				this.dragStartY = this.touchStart ? this.touchStart.y : y;
				this.dragDest = null;
			}
			this.onDragMove(new PointerEvent("pointermove", { clientX: x, clientY: y, buttons: 1, bubbles: true }));
		} else {
			this.finishDrag(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true }));
		}
	}

	private showBlockMenuAt(x: number, y: number) {
		this.showBlockMenu(new MouseEvent("contextmenu", { clientX: x, clientY: y, bubbles: true }));
	}

	/* ----- pointer-based drag reorder (Notion-style ghost + insertion line) ----- */

	private dragPayload: { mode: "live" | "reading"; view: MarkdownView; line: number } | null = null;
	private dragging = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private dragGhost: HTMLElement | null = null;
	private dragLine: HTMLElement | null = null;
	private dragDest: { mode: "live" | "reading"; line: number; after: boolean } | null = null;
	private suppressClickUntil = 0;
	private lastBlock: { key: string; time: number } | null = null;

	private onGripPointerDown(e: PointerEvent) {
		this.flushHover();
		const h = this.hover;
		if (!h || e.button !== 0) return;
		// arm a potential drag; a plain click still opens the menu
		this.dragPayload = { mode: h.mode, view: h.view, line: h.line };
		this.dragging = false;
		this.dragStartX = e.clientX;
		this.dragStartY = e.clientY;
		this.dragDest = null;
	}

	private onDragMove(raw: Event) {
		if (!this.dragPayload) return;
		const e = raw as PointerEvent;
		if ((e.buttons & 1) === 0) return; // no button held
		const dx = e.clientX - this.dragStartX;
		const dy = e.clientY - this.dragStartY;
		if (!this.dragging) {
			if (Math.hypot(dx, dy) < 6) return;
			this.beginDrag(e);
		}
		this.positionGhost(e.clientX, e.clientY);
		this.autoScroll(e.clientY);
		const dest = this.findDropTarget(e.clientX, e.clientY);
		this.dragDest = dest ? { mode: dest.mode, line: dest.line, after: dest.after } : null;
		if (dest) this.showDropLine(dest.el, dest.after);
		else this.hideDropLine();
	}

	private async finishDrag(_raw: Event) {
		const payload = this.dragPayload;
		const wasDragging = this.dragging;
		const dest = this.dragDest;
		this.dragPayload = null;
		this.dragging = false;
		this.dragDest = null;
		this.clearDragUI();
		if (!payload || !wasDragging) return; // plain click, menu opens via click handler
		this.suppressClickUntil = Date.now() + 350; // swallow the click that follows a drag
		this.hideHandle();
		if (!dest || dest.mode !== payload.mode) return;
		try {
			if (payload.mode === "live") {
				const editor = payload.view.editor;
				if (!editor) return;
				if (this.moveLiveBlock(editor, payload.line, dest.line, dest.after)) new Notice("Block moved");
			} else {
				if (await this.moveReadingBlock(payload.view, payload.line, dest.line, dest.after)) new Notice("Block moved");
			}
		} catch (err) {
			console.error("Notion-like Flow: drag move failed", err);
			new Notice("Couldn't move block");
		}
	}

	private cancelDrag() {
		this.dragPayload = null;
		this.dragging = false;
		this.dragDest = null;
		this.clearDragUI();
		this.hideHandle();
	}

	private beginDrag(e: PointerEvent) {
		const h = this.hover;
		this.dragging = true;
		this.handleEl?.hide();
		this.setHighlight(null);
		// ghost = lightweight clone of the dragged line that follows the cursor
		if (h) {
			const src = h.visualEl ?? h.blockEl;
			const rect = src.getBoundingClientRect();
			const ghost = src.cloneNode(true) as HTMLElement;
			ghost.addClass("nlf-drag-ghost");
			ghost.removeAttribute("id");
			ghost.style.width = `${Math.min(Math.max(rect.width, 200), 640)}px`;
			document.body.appendChild(ghost);
			this.dragGhost = ghost;
			this.positionGhost(e.clientX, e.clientY);
			document.body.addClass("nlf-dragging");
		}
	}

	private positionGhost(x: number, y: number) {
		if (!this.dragGhost) return;
		this.dragGhost.style.left = `${x + 14}px`;
		this.dragGhost.style.top = `${y - 22}px`;
	}

	private clearDragUI() {
		this.dragGhost?.remove();
		this.dragGhost = null;
		this.hideDropLine();
		document.body.removeClass("nlf-dragging");
	}

	private showDropLine(el: HTMLElement, after: boolean) {
		const rect = el.getBoundingClientRect();
		// span the content column (line start → end), not the nested element
		const content = el.closest(".cm-content, .markdown-preview-section") as HTMLElement | null;
		const span = content ? content.getBoundingClientRect() : rect;
		let line = this.dragLine;
		if (!line) {
			line = document.createElement("div");
			line.addClass("nlf-drop-line");
			document.body.appendChild(line);
			this.dragLine = line;
		}
		const y = after ? rect.bottom - 1 : rect.top - 1;
		line.style.top = `${y}px`;
		line.style.left = `${span.left}px`;
		line.style.width = `${Math.max(span.width, 40)}px`;
		line.show();
	}

	private hideDropLine() {
		this.dragLine?.hide();
	}

	private findDropTarget(x: number, y: number): { mode: "live" | "reading"; el: HTMLElement; line: number; after: boolean } | null {
		const payload = this.dragPayload;
		if (!payload) return null;
		const under = document.elementFromPoint(x, y) as HTMLElement | null;
		if (!under) return null;
		if (payload.mode === "live") {
			const line = under.closest(".cm-line,.cm-embed-block") as HTMLElement | null;
			if (!line || !payload.view.containerEl.contains(line)) return null;
			const view = payload.view;
			if (!view.editor) return null;
			const destLine = this.liveLineFromDom(view, line);
			if (destLine < 0) return null; // unmappable drop position: show no indicator
			const rect = line.getBoundingClientRect();
			return { mode: "live", el: line, line: destLine, after: y > rect.top + rect.height / 2 };
		}
		const section = under.closest(".markdown-preview-section") as HTMLElement | null;
		if (!section || !payload.view.containerEl.contains(section)) return null;
		const blockEl = this.readingBlockFromTarget(section, under);
		if (!blockEl) return null;
		const kids = Array.from(section.children).filter((c) => !c.hasClass("nlf-page-header"));
		const idx = kids.indexOf(blockEl);
		if (idx < 0) return null;
		const rect = blockEl.getBoundingClientRect();
		return { mode: "reading", el: blockEl, line: idx, after: y > rect.top + rect.height / 2 };
	}

	private autoScroll(clientY: number) {
		const payload = this.dragPayload;
		if (!payload) return;
		const scroller = payload.view.containerEl.querySelector(".cm-scroller,.markdown-preview-view") as HTMLElement | null;
		if (!scroller) return;
		const r = scroller.getBoundingClientRect();
		const margin = 72;
		const step = 16;
		if (clientY < r.top + margin) scroller.scrollTop -= step;
		else if (clientY > r.bottom - margin) scroller.scrollTop += step;
	}

	/** Move a logical source block with corruption guards + undo net. Returns true when moved. */
	private moveLiveBlock(editor: Editor, srcLine: number, destLine: number, after: boolean): boolean {
		const src = this.resolveLiveBlock(editor, srcLine);
		if (!src) return false;
		if (destLine < 0 || destLine >= editor.lineCount()) {
			new Notice("Couldn't map the drop position — no changes made");
			return false;
		}
		const before = editor.getValue().split("\n");
		const fenceCountBefore = this.countFenceMarkers(before);
		const dest = getLogicalBlockRange(editor, destLine);
		if (dest.startLine >= src.startLine && dest.endLine <= src.endLine) return false; // onto self
		// simulate the move on a copy and verify integrity first
		const sim = before.slice();
		const chunk = sim.slice(src.startLine, src.endLine + 1);
		sim.splice(src.startLine, src.endLine - src.startLine + 1);
		const shift = src.endLine - src.startLine + 1;
		let dStart = dest.startLine;
		let dEnd = dest.endLine;
		if (dest.startLine > src.endLine) { dStart -= shift; dEnd -= shift; }
		let floor = 0;
		if (sim.length > 1 && sim[0] === "---") {
			for (let i = 1; i < sim.length; i++) {
				if (sim[i] === "---") { floor = Math.min(i + 1, sim.length - 1); break; }
			}
		}
		dStart = Math.max(floor, Math.min(sim.length - 1, dStart));
		dEnd = Math.max(floor, Math.min(sim.length - 1, dEnd));
		const insertAt = !after ? dStart : (dEnd + 1 <= sim.length - 1 ? dEnd + 1 : sim.length);
		const moveKey = "move:" + src.startLine + "-" + src.endLine + ">" + dStart + "-" + dEnd + ":" + (after ? "a" : "b");
		let forced = false;
		const simFences = this.getFenceRangesFromLines(sim);
		if (this.isIndexInsideFence(simFences, insertAt)) {
			if (!this.blockOrForce(moveKey, "Can't drop inside a code block")) return false;
			forced = true;
		}
		sim.splice(insertAt, 0, ...chunk);
		if (this.countFenceMarkers(sim) !== fenceCountBefore) {
			if (!this.blockOrForce(moveKey, "That move would break a code block")) return false;
			forced = true;
		}
		if (before.length > 0 && before[0] === "---" && sim[0] !== "---") {
			new Notice("That move would break frontmatter — no changes made");
			return false;
		}
		// apply for real (same indices as the simulation)
		const from = { line: src.startLine, ch: 0 };
		const count = editor.lineCount();
		const to = src.endLine + 1 < count
			? { line: src.endLine + 1, ch: 0 }
			: { line: src.endLine, ch: editor.getLine(src.endLine).length };
		editor.replaceRange("", from, to);
		if (!after) {
			const cur = editor.getLine(dStart);
			editor.replaceRange(chunk.join("\n") + "\n" + cur, { line: dStart, ch: 0 }, { line: dStart, ch: cur.length });
		} else if (dEnd + 1 < editor.lineCount()) {
			const cur = editor.getLine(dEnd + 1);
			editor.replaceRange(chunk.join("\n") + "\n" + cur, { line: dEnd + 1, ch: 0 }, { line: dEnd + 1, ch: cur.length });
		} else {
			const cur = editor.getLine(dEnd);
			editor.replaceRange(cur + "\n" + chunk.join("\n"), { line: dEnd, ch: 0 }, { line: dEnd, ch: cur.length });
		}
		// post-verify + undo net (skipped when the user forced it — manual undo is the net)
		if (!forced) {
			const fenceCountAfter = this.countFenceMarkers(editor.getValue().split("\n"));
			if (fenceCountAfter !== fenceCountBefore) {
				try { editor.undo(); } catch { /* ignore */ }
				new Notice("Move looked unsafe and was undone");
				return false;
			}
		}
		return true;
	}

	private async moveReadingBlock(view: MarkdownView, srcIdx: number, destIdx: number, after: boolean): Promise<boolean> {
		const file = view.file;
		if (!file) return false;
		const srcText = await this.app.vault.read(file);
		const lines = srcText.split("\n");
		const fenceCountBefore = this.countFenceMarkers(lines);
		const ranges = splitSourceBlocks(lines);
		if (ranges.length < 2) return false;
		const s = Math.max(0, Math.min(ranges.length - 1, srcIdx));
		let d = Math.max(0, Math.min(ranges.length - 1, destIdx));
		if (s === d) return false;
		const moved = ranges[s];
		const rmoveKey = "rmove:" + moved.startLine + "-" + moved.endLine + ">" + destIdx + ":" + (after ? "a" : "b");
		const overlap = this.fenceOverlapKind(this.getFenceRangesFromLines(lines), moved.startLine, moved.endLine);
		if (overlap === "partial" || overlap === "inside") {
			if (!this.blockOrForce(rmoveKey, "That would split a code block")) return false;
		}
		const chunk = lines.slice(moved.startLine, moved.endLine + 1);
		lines.splice(moved.startLine, moved.endLine - moved.startLine + 1);
		const fresh = splitSourceBlocks(lines);
		if (s < d) d -= 1;
		d = Math.max(0, Math.min(fresh.length - 1, d));
		const anchor = fresh[d];
		const at = after ? anchor.endLine + 1 : anchor.startLine;
		const atClamped = Math.max(0, Math.min(lines.length, at));
		if (this.isIndexInsideFence(this.getFenceRangesFromLines(lines), atClamped)) {
			if (!this.blockOrForce(rmoveKey, "Can't drop inside a code block")) return false;
		}
		lines.splice(atClamped, 0, ...chunk);
		if (this.countFenceMarkers(lines) !== fenceCountBefore) {
			if (!this.blockOrForce(rmoveKey, "That move would break a code block")) return false;
		}
		await this.app.vault.modify(file, lines.join("\n"));
		return true;
	}

	/* ---------- page headers: icon + cover + breadcrumb ---------- */

	private setupHeaderRefresh() {
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			this.scheduleHeaderRefresh();
			this.updateWordCount();
		}));
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			this.scheduleHeaderRefresh();
		}));
		this.registerEvent(this.app.metadataCache.on("changed", () => {
			this.scheduleHeaderRefresh();
		}));
		this.registerEvent(this.app.vault.on("modify", () => {
			this.scheduleHeaderRefresh(600);
			this.scheduleWordCount();
		}));
		this.registerEvent(this.app.workspace.on("editor-change", () => {
			this.scheduleWordCount();
		}));
		// fallback observer: re-inject if a header vanished (ignore text-only typing noise)
		this.observer = new MutationObserver((muts) => {
			for (const m of muts) {
				if (m.type !== "childList") continue;
				let elementChanged = false;
				m.addedNodes.forEach((n) => { if (n.nodeType === 1) elementChanged = true; });
				m.removedNodes.forEach((n) => { if (n.nodeType === 1) elementChanged = true; });
				if (elementChanged) { this.scheduleHeaderRefresh(400); return; }
			}
		});
		const target = document.querySelector(".workspace-split.mod-vertical.mod-root");
		if (target) this.observer.observe(target, { childList: true, subtree: true });
	}

	private scheduleHeaderRefresh(ms = 120) {
		if (this.headerDebounce) window.clearTimeout(this.headerDebounce);
		this.headerDebounce = window.setTimeout(() => this.refreshPageHeaders(), ms);
	}

	refreshPageHeaders() {
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView) this.injectHeader(view);
		}
	}

	private injectHeader(view: MarkdownView) {
		const file = view.file;
		const container = view.containerEl;
		if (!file) {
			container.querySelectorAll(".nlf-page-header").forEach((e) => e.remove());
			return;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const front = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		const icon = (front["icon"] ?? front["emoji"] ?? null) as string | null;
		const cover = (front["cover"] ?? front["banner"] ?? front["image"] ?? null) as string | null;
		const coverPos = ((front["cover_position"] ?? front["coverPosition"] ?? "center") as string) || "center";

		const wantHeader = (this.settings.enableCovers && (icon || cover)) || this.settings.showBreadcrumb;
		const sig = wantHeader ? [icon ?? "", cover ?? "", coverPos, file.path, this.settings.showBreadcrumb, this.settings.enableCovers].join("|") : "";
		const prev = this.headerSigs.get(file.path);
		const hasHeader = container.querySelector(".nlf-page-header") !== null;
		if (prev === sig && (hasHeader || !wantHeader)) return; // unchanged: skip DOM churn
		container.querySelectorAll(".nlf-page-header").forEach((e) => e.remove());
		this.headerSigs.set(file.path, sig);
		if (!wantHeader) return;

		const build = (): HTMLElement => {
			const header = document.createElement("div");
			header.addClass("nlf-page-header");
			header.setAttribute("contenteditable", "false");
			if (this.settings.enableCovers && cover) {
				const cov = document.createElement("div");
				cov.addClass("nlf-cover");
				const bg = coverToCss(this.app, file, String(cover));
				if (bg.startsWith("url(")) {
					cov.style.backgroundImage = bg;
					cov.style.backgroundSize = "cover";
					cov.style.backgroundPosition = `center ${coverPos}`;
				} else {
					cov.style.background = bg;
				}
				const actions = document.createElement("div");
				actions.addClass("nlf-cover-actions");
				const change = document.createElement("button");
				change.setText("Change cover");
				change.onclick = (e) => { e.stopPropagation(); this.openCoverModal(); };
				const remove = document.createElement("button");
				remove.setText("Remove");
				remove.onclick = (e) => { e.stopPropagation(); void this.setPageCover(null); };
				actions.appendChild(change);
				actions.appendChild(remove);
				cov.appendChild(actions);
				header.appendChild(cov);
			}
			const row = document.createElement("div");
			row.addClass("nlf-title-row");
			if (this.settings.enableCovers && icon) {
				const ic = document.createElement("div");
				ic.addClass("nlf-icon");
				renderEmoji(ic, String(icon), this.settings.colorEmoji);
				ic.setAttribute("title", "Click to change icon");
				ic.onclick = (e) => { e.stopPropagation(); this.openIconModal(); };
				row.appendChild(ic);
			} else if (this.settings.enableCovers) {
				const addIcon = document.createElement("button");
				addIcon.addClass("nlf-add-meta");
				addIcon.setText("＋ Add icon");
				addIcon.onclick = (e) => { e.stopPropagation(); this.openIconModal(); };
				row.appendChild(addIcon);
			}
			if (this.settings.showBreadcrumb) {
				const crumb = document.createElement("div");
				crumb.addClass("nlf-breadcrumb");
				const parts = file.path.split("/");
				parts.pop();
				const trail = [...parts, file.basename].filter(Boolean);
				crumb.setText(trail.join("  ›  "));
				crumb.setAttribute("title", file.path);
				row.appendChild(crumb);
			}
			if (!this.settings.enableCovers || !cover) {
				if (this.settings.enableCovers) {
					const addCover = document.createElement("button");
					addCover.addClass("nlf-add-meta");
					addCover.setText("＋ Add cover");
					addCover.onclick = (e) => { e.stopPropagation(); this.openCoverModal(); };
					row.appendChild(addCover);
				}
			}
			header.appendChild(row);
			return header;
		};

		// Reading view sizer
		const readSizer = container.querySelector(".markdown-preview-sizer") as HTMLElement | null;
		if (readSizer) {
			const h = build();
			readSizer.insertBefore(h, readSizer.firstChild);
		}
		// Live preview sizer (CodeMirror) — banner plugins use this; contenteditable=false keeps CM happy
		const cmSizer = container.querySelector(".cm-sizer") as HTMLElement | null;
		if (cmSizer && !cmSizer.querySelector(":scope > .nlf-page-header")) {
			const h = build();
			h.addClass("nlf-in-cmsizer");
			cmSizer.insertBefore(h, cmSizer.firstChild);
		}
	}

	openIconModal() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) {
			new Notice("Open a note first, then set its icon");
			return;
		}
		new IconModal(this.app, this).open();
	}

	openCoverModal() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) {
			new Notice("Open a note first, then set its cover");
			return;
		}
		new CoverModal(this.app, this).open();
	}

	private async setFrontmatter(file: TFile, key: string, value: string | null) {
		const fm = this.app.fileManager as unknown as { processFrontMatter?: (f: TFile, fn: (o: Record<string, unknown>) => void) => Promise<void> };
		if (typeof fm.processFrontMatter === "function") {
			await fm.processFrontMatter(file, (o) => {
				if (value === null || value === "") delete o[key];
				else o[key] = value;
			});
			return;
		}
		// fallback: manual frontmatter edit
		const src = await this.app.vault.read(file);
		const lines = src.split("\n");
		if (lines[0] !== "---") {
			if (value === null || value === "") return;
			await this.app.vault.modify(file, `---\n${key}: ${JSON.stringify(value)}\n---\n${src}`);
			return;
		}
		let end = 1;
		while (end < lines.length && lines[end] !== "---") end++;
		const body = lines.slice(1, end);
		const idx = body.findIndex((l) => l.match(new RegExp(`^${key}\\s*:`)));
		if (value === null || value === "") {
			if (idx >= 0) body.splice(idx, 1);
		} else {
			const row = `${key}: ${JSON.stringify(value)}`;
			if (idx >= 0) body[idx] = row;
			else body.push(row);
		}
		lines.splice(1, end - 1, ...body);
		await this.app.vault.modify(file, lines.join("\n"));
	}

	async setPageIcon(icon: string | null) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!file) { new Notice("No active note"); return; }
		const v = icon && icon.trim() ? icon.trim() : null;
		await this.setFrontmatter(file, "icon", v);
		if (v) {
			this.settings.recentIcons = [v, ...this.settings.recentIcons.filter((e) => e !== v)].slice(0, 12);
			await this.saveSettings();
		}
		this.refreshPageHeaders();
		if (v) new Notice(`Page icon set to ${v}`);
	}

	async setPageCover(cover: string | null) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!file) { new Notice("No active note"); return; }
		await this.setFrontmatter(file, "cover", cover && cover.trim() ? cover.trim() : null);
		this.refreshPageHeaders();
		new Notice(cover ? "Cover updated" : "Cover removed");
	}

	/* ---------- new notes in the selected folder (AFFiNE / Capacities style) ---------- */

	private lastNavFolder: string | null = null;

	private setupNewNoteInterception() {
		// 1) hijack the file-explorer "New note" (+) button
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			if (!this.settings.hijackNewNote) return;
			const t = evt.target as HTMLElement | null;
			if (!t || !(t instanceof HTMLElement)) return;
			const btn = t.closest(".clickable-icon") as HTMLElement | null;
			if (!btn || btn.getAttribute("aria-label") !== "New note") return;
			if (!btn.closest('.workspace-leaf-content[data-type="file-explorer"]')) return;
			evt.preventDefault();
			evt.stopPropagation();
			void this.createNoteInFolder(this.resolveTargetFolder());
		}, { capture: true });

		// 2) remember the last folder / file clicked in the explorer (data-path tracking)
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			const t = evt.target as HTMLElement | null;
			if (!t || !(t instanceof HTMLElement)) return;
			if (!t.closest('.workspace-leaf-content[data-type="file-explorer"]')) return;
			const folderTitle = t.closest(".nav-folder-title") as HTMLElement | null;
			if (folderTitle) {
				const p = folderTitle.getAttribute("data-path")
					?? folderTitle.parentElement?.getAttribute("data-path")
					?? null;
				if (p !== null) { this.lastNavFolder = p === "/" ? "" : p; return; }
			}
			const fileTitle = t.closest(".nav-file-title") as HTMLElement | null;
			if (fileTitle) {
				const p = fileTitle.getAttribute("data-path")
					?? fileTitle.parentElement?.getAttribute("data-path")
					?? "";
				if (p) {
					const parts = p.split("/");
					parts.pop();
					this.lastNavFolder = parts.join("/");
				}
			}
		});
	}

	/** Layered resolution: highlighted nav item, last clicked, open note's folder, root. */
	private resolveTargetFolder(): string {
		const mode = this.settings.newNoteMode;
		if (mode === "root") return "";
		if (mode === "current") return this.activeFileFolder();
		try {
			const explorer = document.querySelector('.workspace-leaf-content[data-type="file-explorer"]');
			const activeFolder = explorer?.querySelector(".nav-folder-title.is-active") as HTMLElement | null;
			if (activeFolder) {
				const p = activeFolder.getAttribute("data-path")
					?? activeFolder.parentElement?.getAttribute("data-path")
					?? "";
				const norm = p === "/" ? "" : p;
				if (norm === "" || this.app.vault.getAbstractFileByPath(norm)) return norm;
			}
			const activeFile = explorer?.querySelector(".nav-file-title.is-active") as HTMLElement | null;
			if (activeFile) {
				const p = activeFile.getAttribute("data-path")
					?? activeFile.parentElement?.getAttribute("data-path")
					?? "";
				if (p) {
					const parts = p.split("/");
					parts.pop();
					return parts.join("/");
				}
			}
		} catch { /* fall through to click tracking */ }
		if (this.lastNavFolder !== null) {
			if (this.lastNavFolder === "" || this.app.vault.getAbstractFileByPath(this.lastNavFolder)) {
				return this.lastNavFolder;
			}
		}
		return this.activeFileFolder();
	}

	private activeFileFolder(): string {
		const f = this.app.workspace.getActiveFile();
		if (f && f.parent && f.parent.path !== "/") return f.parent.path;
		return "";
	}

	private uniqueNotePath(folder: string): string {
		const base = folder === "" ? "" : folder + "/";
		let name = "Untitled";
		let i = 0;
		while (this.app.vault.getAbstractFileByPath(`${base}${name}.md`)) {
			i++;
			name = `Untitled ${i}`;
			}
		return `${base}${name}.md`;
	}

	private async createNoteInFolder(folder: string) {
		const target = folder === "/" ? "" : folder;
		try {
			if (target !== "" && !this.app.vault.getAbstractFileByPath(target)) {
				await this.app.vault.createFolder(target);
			}
			const file = await this.app.vault.create(this.uniqueNotePath(target), "");
			await this.app.workspace.getLeaf(false).openFile(file);
			new Notice(target === "" ? "New note in vault root" : `New note in ${target}`);
		} catch (err) {
			console.error("Notion-like Flow: create note failed", err);
			new Notice("Could not create note");
		}
	}

	/* ---------- word count ---------- */

	private wcTimer = 0;
	private lineCache = new WeakMap<HTMLElement, number>();

	private scheduleWordCount(ms = 400) {
		if (!this.statusEl) return;
		if (this.wcTimer) window.clearTimeout(this.wcTimer);
		this.wcTimer = window.setTimeout(() => { this.wcTimer = 0; this.updateWordCount(); }, ms);
	}

	updateWordCount() {
		if (!this.statusEl) return;
		if (!this.settings.showWordCount) {
			this.statusEl.hide();
			return;
		}
		this.statusEl.show();
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.statusEl.setText("✦ — words");
			return;
		}
		let text = "";
		try {
			text = view.editor?.getValue() ?? "";
		} catch {
			text = "";
		}
		if (!text && view.file) {
			const cached = this.app.metadataCache.getFileCache(view.file);
			void cached;
		}
		const { words } = countWords(text || view.containerEl.innerText || "");
		const mins = Math.max(1, Math.round(words / 200));
		this.statusEl.setText(words === 0 ? "✦ — words" : `✦ ${words.toLocaleString()} words · ${mins} min`);
		this.statusEl.setAttribute("title", "Notion-like Flow word count");
	}
}
