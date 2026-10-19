/**
 * Markdown → HTML, sanitized.
 *
 * Model output and text the agent read from the web both reach this function, so every
 * rendered string is sanitized with DOMPurify: no scripts, no inline styles, no forms, no
 * embedded SVG, and every link is forced to `target="_blank" rel="noopener noreferrer nofollow"`.
 *
 * Parsing is memoized by source text with a small LRU: a finished block keeps the same `text`
 * prop, so React's memo skips it and the cache means even a re-render never re-parses it.
 * Only the block currently streaming is parsed per frame.
 */
import DOMPurify from "dompurify";
import { marked } from "marked";

const CACHE_MAX = 240;
const cache = new Map<string, string>();

const ALLOWED_TAGS = [
	"a", "b", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6",
	"hr", "i", "img", "input", "kbd", "li", "ol", "p", "pre", "s", "span", "strong", "sub", "summary", "sup", "table", "tbody",
	"td", "tfoot", "th", "thead", "tr", "ul",
];

const ALLOWED_ATTR = ["class", "href", "title", "alt", "src", "type", "checked", "disabled", "start", "align", "colspan", "rowspan"];

const TOKEN =
	/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\d._]*\b|\b(?:await|async|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|null|of|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|yield)\b)/g;

/** Cheap keyword/string/number colouring for fenced blocks, as text nodes only. */
function highlightCode(fragment: DocumentFragment) {
	for (const code of fragment.querySelectorAll("pre > code")) {
		const text = code.textContent ?? "";
		TOKEN.lastIndex = 0;
		if (!TOKEN.test(text)) continue;
		TOKEN.lastIndex = 0;
		const parts: (string | Node)[] = [];
		let last = 0;
		for (let match = TOKEN.exec(text); match; match = TOKEN.exec(text)) {
			if (match.index > last) parts.push(document.createTextNode(text.slice(last, match.index)));
			const token = match[0];
			const span = document.createElement("span");
			span.className = /^\/\//.test(token) || /^\/\*/.test(token) ? "tok-com" : /^["'`]/.test(token) ? "tok-str" : /^\d/.test(token) ? "tok-num" : "tok-key";
			span.textContent = token;
			parts.push(span);
			last = match.index + token.length;
		}
		if (last < text.length) parts.push(document.createTextNode(text.slice(last)));
		code.replaceChildren(...parts);
	}
}

function harden(html: string): string {
	const template = document.createElement("template");
	template.innerHTML = html;
	for (const anchor of template.content.querySelectorAll("a")) {
		anchor.setAttribute("target", "_blank");
		anchor.setAttribute("rel", "noopener noreferrer nofollow");
	}
	// Colour is applied by walking text nodes: no string is ever re-parsed as HTML.
	highlightCode(template.content);
	for (const pre of template.content.querySelectorAll("pre")) {
		const shell = document.createElement("div");
		shell.className = "code-block";
		const head = document.createElement("div");
		head.className = "code-head";
		const copy = document.createElement("button");
		copy.type = "button";
		copy.className = "code-copy";
		copy.textContent = "copy";
		head.append(copy);
		pre.replaceWith(shell);
		shell.append(head, pre);
	}
	for (const image of template.content.querySelectorAll("img")) {
		const src = image.getAttribute("src") ?? "";
		// Remote images leak the reader's IP to whoever wrote the markdown; keep data: only.
		if (!/^data:image\//i.test(src)) image.remove();
		else image.setAttribute("loading", "lazy");
	}
	return template.innerHTML;
}

export function renderMarkdown(text: string): string {
	const cached = cache.get(text);
	if (cached !== undefined) {
		cache.delete(text);
		cache.set(text, cached);
		return cached;
	}
	const parsed = marked.parse(text, { async: false, gfm: true, breaks: false });
	const clean = harden(
		DOMPurify.sanitize(typeof parsed === "string" ? parsed : "", {
			ALLOWED_TAGS,
			ALLOWED_ATTR,
			ALLOW_DATA_ATTR: false,
			FORBID_TAGS: ["style", "iframe", "form", "button", "video", "audio", "source", "svg", "math", "script"],
			FORBID_ATTR: ["style", "srcset", "formaction", "xlink:href"],
			KEEP_CONTENT: true,
		}),
	);
	cache.set(text, clean);
	if (cache.size > CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return clean;
}

/** Markdown source for a transcript entry, used by "copy as markdown". */
export function toMarkdown(blocks: string[]): string {
	return blocks.filter(Boolean).join("\n\n");
}
