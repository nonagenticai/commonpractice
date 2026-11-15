import { describe, it, expect } from 'vitest';
import { shouldCommitTopHit } from './topbar-search';

describe('shouldCommitTopHit (A7 locale-switch search guard)', () => {
	it('commits the top hit when Enter is pressed in the focused search box with hits', () => {
		expect(shouldCommitTopHit('Enter', true, 3)).toBe(true);
	});

	it('does NOT commit when the search input is not focused (stray Enter, e.g. locale <select>)', () => {
		expect(shouldCommitTopHit('Enter', false, 3)).toBe(false);
	});

	it('does NOT commit when there are no hits', () => {
		expect(shouldCommitTopHit('Enter', true, 0)).toBe(false);
	});

	it('ignores non-Enter keys', () => {
		expect(shouldCommitTopHit('Tab', true, 3)).toBe(false);
	});
});
