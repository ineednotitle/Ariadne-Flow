/* Emoji-as-images (Twemoji, CC-BY 4.0 by Twitter/X). Same flat look on every OS; falls back to the OS glyph offline. */
const TWEMOJI_BASE = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/";

/** Unicode emoji -> Twemoji SVG code (drops VS16, keeps ZWJ). Null when not mappable. */
export function twemojiCode(char: string): string | null {
	const cps: string[] = [];
	for (const ch of char) {
		const cp = (ch.codePointAt(0) ?? 0).toString(16);
		if (cp === "fe0f") continue; // variation selector: not part of Twemoji file names
		cps.push(cp);
	}
	if (!cps.length) return null;
	return cps.join("-");
}

export function twemojiUrl(char: string): string | null {
	const code = twemojiCode(char);
	return code ? `${TWEMOJI_BASE}${code}.svg` : null;
}

/** Fill an element with an emoji: flat Twemoji image when enabled, OS glyph otherwise (or offline). */
export function renderEmoji(el: HTMLElement, char: string, useImages: boolean): void {
	el.empty();
	if (!useImages) { el.setText(char); return; }
	const url = twemojiUrl(char);
	if (!url) { el.setText(char); return; }
	const img = document.createElement("img");
	img.addClass("nlf-emoji-img");
	img.setAttribute("src", url);
	img.setAttribute("alt", char);
	img.setAttribute("draggable", "false");
	img.setAttribute("loading", "lazy");
	img.onerror = () => { img.replaceWith(document.createTextNode(char)); };
	el.appendChild(img);
}
