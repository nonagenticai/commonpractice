// @vitest-environment jsdom
// Security regression guard for the block-doc markdown preview: renderMarkdown()
// must strip embedded scripting (stored XSS) while preserving benign markdown.
// Runs under jsdom (DOMPurify needs a DOM); the global vitest env stays node.
import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderChatMarkdown } from './markdown';

// The chat renderer's safety rests on DOMPurify: marked itself passes `javascript:` / `data:` hrefs
// through. REVERT THAT TURNS THIS RED: drop the DOMPurify.sanitize call in renderChatMarkdown.
describe('renderChatMarkdown', () => {
	it('strips javascript: links', () => {
		expect(renderChatMarkdown('[x](javascript:alert(1))').toLowerCase()).not.toContain('javascript:');
	});

	it('strips data: links', () => {
		const out = renderChatMarkdown('[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)');
		expect(out.toLowerCase()).not.toContain('data:');
	});

	it('never emits an <img> or an onerror handler', () => {
		const out = renderChatMarkdown('<img src=x onerror="alert(1)"> ![a](https://e.x/i.png)').toLowerCase();
		expect(out).not.toContain('<img');
		expect(out).not.toMatch(/<[^>]*\sonerror=/);
	});

	it('external links open in a new tab with rel=noopener noreferrer nofollow', () => {
		const out = renderChatMarkdown('[docs](https://example.com)');
		expect(out).toContain('href="https://example.com"');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer nofollow"');
	});

	it('the link hook does not leak into block-doc rendering', () => {
		expect(renderMarkdown('[docs](https://example.com)')).not.toContain('target="_blank"');
	});
});

describe('renderMarkdown', () => {
	it('strips <script> tags', () => {
		const out = renderMarkdown('hello <script>window.__pwned=1</script> world');
		expect(out).not.toContain('<script');
		expect(out).not.toContain('__pwned');
	});

	it('strips event-handler attributes (onerror)', () => {
		const out = renderMarkdown('<img src=x onerror="window.__pwned=1">');
		// The <img> survives but the onerror handler attribute is removed.
		expect(out).toContain('<img');
		expect(out.toLowerCase()).not.toContain('onerror');
		expect(out).not.toContain('__pwned');
	});

	it('strips javascript: URLs', () => {
		const out = renderMarkdown('[click](javascript:alert(1))');
		expect(out.toLowerCase()).not.toContain('javascript:');
	});

	it('preserves benign markdown (headings, bold, code, links)', () => {
		const out = renderMarkdown('# Title\n\n**bold** and `code` and [link](https://example.com)');
		expect(out).toContain('<h1');
		expect(out).toContain('<strong>bold</strong>');
		expect(out).toContain('<code>code</code>');
		expect(out).toContain('href="https://example.com"');
	});

	it('handles null/undefined safely', () => {
		expect(renderMarkdown(null)).toBe('');
		expect(renderMarkdown(undefined)).toBe('');
	});
});
