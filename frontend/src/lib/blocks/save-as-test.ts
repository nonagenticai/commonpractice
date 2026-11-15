// src/lib/blocks/save-as-test.ts — Phase 3 (test synthesis): map a one-off
// simulate run into a CreateBlockTestBody so a satisfying run can be pinned as a
// regression test in one click. Pure + framework-free so it is unit-tested directly.
import type { AssertMode, CreateBlockTestBody, SimulateResult } from '$lib/types/blocks';

export interface SaveAsTestOpts {
	/** Test name (required, unique per block — the caller surfaces the 409). */
	name: string;
	/** Optional human description. */
	description?: string;
	/** Output-match mode for success runs; ignored for error/smoke tests. */
	assertMode: AssertMode;
}

/** True when a successful run produced a structured (object) output worth pinning. */
export function hasPinnableOutput(result: SimulateResult): boolean {
	return (
		result.status === 'ok' && result.outputs !== null && typeof result.outputs === 'object'
	);
}

/**
 * Build the create-test body from a simulate result + the developer's choices.
 *
 * - **success with outputs** → pin the observed outputs as `expected` (subset|exact).
 * - **success with no structured output** → smoke test (`expected: null` → the runner
 *   only asserts the block ran without error).
 * - **error run** → an expect-error test pinned to the observed `error.kind`.
 *
 * `inputs` are taken from `result.inputs` (the merged inputs the run actually used,
 * echoed by the simulate endpoint), so the saved test reproduces the same run.
 */
export function simulateResultToTestBody(
	result: SimulateResult,
	opts: SaveAsTestOpts
): CreateBlockTestBody {
	const isError = result.status === 'error';
	const pin = hasPinnableOutput(result);
	return {
		name: opts.name.trim(),
		description: opts.description?.trim() || undefined,
		inputs: result.inputs ?? {},
		expected: pin ? (result.outputs as Record<string, unknown>) : null,
		assert_mode: opts.assertMode,
		expect_error: isError,
		expected_error_kind: isError ? (result.error?.kind ?? null) : null
	};
}
