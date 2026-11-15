// src/lib/agent/locate.test.ts — the DOM locators must be SSR/no-DOM safe: with no
// `document` they return null, which is exactly the signal the driver uses to fall
// back to an instant store edit. (Pure node test — the full puppeteering path is
// browser-only and is verified by the live Playwright drive.)
import { test, expect } from 'vitest';
import * as locate from './locate';

test('every locator returns null when there is no DOM (drives instant-apply fallback)', () => {
	expect(typeof document).toBe('undefined');
	expect(locate.paletteTile('ai-summarize')).toBeNull();
	expect(locate.canvas()).toBeNull();
	expect(locate.nodeEl('n_123')).toBeNull();
	expect(locate.handleEl('n_123', 'out', 'source')).toBeNull();
	expect(locate.handleEl('n_123', 'in', 'target')).toBeNull();
	expect(locate.configField('threshold')).toBeNull();
});
