// src/lib/utils/markdown.ts — render block-doc markdown to sanitized HTML.
// Block docs are authored by one user and rendered read-only to others
// (published/global blocks are visible across tenants), so the marked() output
// is passed through DOMPurify to strip any embedded scripting (stored XSS).
import { Marked, marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(value: string | null | undefined): string {
	const raw = marked.parse(value ?? '', { async: false }) as string;
	return DOMPurify.sanitize(raw);
}

const escapeHtml = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Markdown for the assistant's chat replies. The prod walk (2026-10-16) showed `**bold**` and
 * backticks as raw text in the panel. A model reply is untrusted text: raw HTML inside it is shown
 * AS TEXT (never parsed), and the result still goes through DOMPurify. A separate `Marked`
 * instance, so block docs keep their own (HTML-allowing) behaviour.
 */
const chatMarked = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		html({ text }) {
			return escapeHtml(text);
		}
	}
});

// DOMPurify hooks are global, so the link hardening runs only while a CHAT reply is being sanitised
// (sanitize is synchronous; block docs rendered by renderMarkdown are untouched).
let hardenLinks = false;
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	if (!hardenLinks || node.nodeName !== 'A' || !node.hasAttribute('href')) return;
	node.setAttribute('target', '_blank');
	node.setAttribute('rel', 'noopener noreferrer nofollow');
});

export function renderChatMarkdown(value: string | null | undefined): string {
	const raw = chatMarked.parse(value ?? '', { async: false }) as string;
	hardenLinks = true;
	try {
		return DOMPurify.sanitize(raw, { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input'] });
	} finally {
		hardenLinks = false;
	}
}
