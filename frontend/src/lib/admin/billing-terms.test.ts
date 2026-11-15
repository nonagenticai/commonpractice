import { describe, expect, it } from 'vitest';
import { parseTermsDraft, planFixedByo, termsToDraft } from './billing-terms';

describe('planFixedByo', () => {
	it('local-llm → local_allowed, byo → byo_required, anything else is free', () => {
		expect(planFixedByo('local-llm')).toBe('local_allowed');
		expect(planFixedByo('byo')).toBe('byo_required');
		expect(planFixedByo('standard')).toBeNull();
		expect(planFixedByo('')).toBeNull();
	});
});

describe('parseTermsDraft', () => {
	it('all empty = no terms stated', () => {
		expect(parseTermsDraft({ platformFee: '', seatFee: ' ', markup: '' })).toEqual({ ok: true, terms: null });
	});
	it('zeros are legal and kept as zeros', () => {
		expect(parseTermsDraft({ platformFee: '0', seatFee: '0', markup: '0' })).toEqual({
			ok: true,
			terms: { platformFeeUsd: 0, seatFeeUsd: 0, markupPct: 0 }
		});
	});
	it('parses decimals in either convention and a trailing %', () => {
		expect(parseTermsDraft({ platformFee: '250', seatFee: '12,50', markup: '20%' })).toEqual({
			ok: true,
			terms: { platformFeeUsd: 250, seatFeeUsd: 12.5, markupPct: 20 }
		});
	});
	it('a half-filled form is refused, never read as 0', () => {
		expect(parseTermsDraft({ platformFee: '250', seatFee: '', markup: '20' })).toEqual({ ok: false });
	});
	it('a negative or garbage value is refused', () => {
		expect(parseTermsDraft({ platformFee: '-1', seatFee: '1', markup: '1' })).toEqual({ ok: false });
		expect(parseTermsDraft({ platformFee: 'abc', seatFee: '1', markup: '1' })).toEqual({ ok: false });
	});
	it('round-trips a billing view', () => {
		const d = termsToDraft({ platformFeeUsd: 5000, seatFeeUsd: 25, markupPct: 20 });
		expect(parseTermsDraft(d)).toEqual({ ok: true, terms: { platformFeeUsd: 5000, seatFeeUsd: 25, markupPct: 20 } });
	});
});
