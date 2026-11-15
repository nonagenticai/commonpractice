// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTopupIntent } from './topup-intent';

const seq = () => {
	let n = 0;
	return () => `key-${++n}`;
};
afterEach(() => {
	sessionStorage.clear();
	vi.restoreAllMocks();
});

describe('createTopupIntent', () => {
	it('two submits of the SAME intent (a retry) send the SAME key — billing replays, no second charge', () => {
		const intent = createTopupIntent(() => 't-1', seq());
		expect(intent.keyFor(50)).toBe(intent.keyFor(50));
	});

	it('a different amount is a new intent: a new key', () => {
		const intent = createTopupIntent(() => 't-1', seq());
		const a = intent.keyFor(50);
		expect(intent.keyFor(75)).not.toBe(a);
	});

	it('after a CONFIRMED success the same amount is a new purchase: a new key', () => {
		const intent = createTopupIntent(() => 't-1', seq());
		const a = intent.keyFor(50);
		intent.confirmed(50);
		expect(intent.keyFor(50)).not.toBe(a);
	});

	it('⛔ the pending key SURVIVES A RELOAD (sessionStorage), per tenant', () => {
		const before = createTopupIntent(() => 't-1', seq()).keyFor(50);
		// A fresh page: a new intent object, a new key generator.
		const after = createTopupIntent(() => 't-1', () => 'fresh-key').keyFor(50);
		expect(after).toBe(before);
		expect(createTopupIntent(() => 't-2', () => 'other-tenant').keyFor(50)).toBe('other-tenant');
	});

	it('storage that throws (private window / blocked) still reuses the key within the page', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('SecurityError');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('QuotaExceededError');
		});
		const intent = createTopupIntent(() => 't-1', seq());
		expect(intent.keyFor(50)).toBe(intent.keyFor(50));
	});
});
