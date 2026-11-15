import { describe, expect, it } from 'vitest';
import { addBundleKeys, failedBundleKeys, MAX_BUNDLES } from './licence-bundles';

describe('addBundleKeys', () => {
	it('adds comma / space separated keys, case-folded, without duplicates', () => {
		expect(addBundleKeys(['w2v'], 'N8n-Nodes, w2v  book-fulfillment')).toEqual({
			keys: ['w2v', 'n8n-nodes', 'book-fulfillment'],
			invalid: null,
			tooMany: false
		});
	});
	it('refuses a token that is not a bundle key and adds nothing', () => {
		for (const bad of ['n8n_nodes', '-w2v', 'w2v-', 'a--b', 'x'.repeat(65)]) {
			expect(addBundleKeys(['w2v'], `merqi ${bad}`)).toEqual({ keys: ['w2v'], invalid: bad, tooMany: false });
		}
	});
	it('refuses going past the maximum and adds nothing', () => {
		const full = Array.from({ length: MAX_BUNDLES }, (_, i) => `b${i}`);
		expect(addBundleKeys(full, 'one-more')).toEqual({ keys: full, invalid: null, tooMany: true });
		expect(addBundleKeys(full, 'b0').tooMany).toBe(false);
	});
	it('an empty input changes nothing', () => {
		expect(addBundleKeys(['w2v'], '  , ')).toEqual({ keys: ['w2v'], invalid: null, tooMany: false });
	});
});

describe('failedBundleKeys', () => {
	it('lists only failed bundles', () => {
		expect(
			failedBundleKeys([
				{ bundle: 'w2v', status: 'ok' },
				{ bundle: 'n8n-nodes', status: 'failed' },
				{ bundle: 'x', status: 'skipped' }
			])
		).toEqual(['n8n-nodes']);
		expect(failedBundleKeys(undefined)).toEqual([]);
	});
});
