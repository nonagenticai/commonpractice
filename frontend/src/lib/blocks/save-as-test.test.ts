// src/lib/blocks/save-as-test.test.ts — Phase 3 map: a simulate run → a test body.
import { describe, it, expect } from 'vitest';
import { simulateResultToTestBody, hasPinnableOutput } from './save-as-test';
import type { SimulateResult } from '$lib/types/blocks';

const base: Omit<SimulateResult, 'status' | 'outputs' | 'error'> = {
	logs: [],
	cost: { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 },
	durationMs: 5,
	inputs: { amount: 100, condition: true }
};

const okResult: SimulateResult = {
	...base,
	status: 'ok',
	outputs: { result: 'approved' },
	error: null
};

describe('simulateResultToTestBody', () => {
	it('pins observed outputs as expected for a successful run', () => {
		const body = simulateResultToTestBody(okResult, { name: '  approves valid  ', assertMode: 'subset' });
		expect(body).toEqual({
			name: 'approves valid', // trimmed
			description: undefined,
			inputs: { amount: 100, condition: true }, // from result.inputs, not the form
			expected: { result: 'approved' },
			assert_mode: 'subset',
			expect_error: false,
			expected_error_kind: null
		});
	});

	it('honours the chosen assert_mode and trims the description', () => {
		const body = simulateResultToTestBody(okResult, {
			name: 'exact match',
			description: '  checks the exact shape  ',
			assertMode: 'exact'
		});
		expect(body.assert_mode).toBe('exact');
		expect(body.description).toBe('checks the exact shape');
	});

	it('falls back to a smoke test when a success produced no structured output', () => {
		const noOut: SimulateResult = { ...okResult, outputs: null };
		const body = simulateResultToTestBody(noOut, { name: 'just runs', assertMode: 'subset' });
		expect(body.expect_error).toBe(false);
		expect(body.expected).toBeNull(); // runner only asserts no error
	});

	it('captures an error run as an expect-error test pinned to the kind', () => {
		const errResult: SimulateResult = {
			...base,
			status: 'error',
			outputs: null,
			error: { kind: 'validation', message: "missing required input 'text'" }
		};
		const body = simulateResultToTestBody(errResult, { name: 'rejects empty', assertMode: 'subset' });
		expect(body.expect_error).toBe(true);
		expect(body.expected_error_kind).toBe('validation');
		expect(body.expected).toBeNull();
		expect(body.inputs).toEqual({ amount: 100, condition: true });
	});

	it('empty description collapses to undefined', () => {
		const body = simulateResultToTestBody(okResult, { name: 'x', description: '   ', assertMode: 'subset' });
		expect(body.description).toBeUndefined();
	});
});

describe('hasPinnableOutput', () => {
	it('true only for a success with an object output', () => {
		expect(hasPinnableOutput(okResult)).toBe(true);
		expect(hasPinnableOutput({ ...okResult, outputs: null })).toBe(false);
		expect(hasPinnableOutput({ ...okResult, status: 'error', outputs: null, error: { kind: 'internal', message: 'x' } })).toBe(false);
	});
});
