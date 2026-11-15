// Global vitest setup — a fail-loud network stub.
//
// Nothing in this suite should ever reach the real network. When a `vi.mock()` silently fails to
// apply (the relative-specifier trap — see the header comment in `src/lib/api/llm-settings.test.ts`),
// the REAL api client runs and calls `fetch` with a relative URL. Node's undici answers that with
// `TypeError: fetch() URL is invalid`, which names neither the request nor the cause, and cost two
// sessions to attribute. This stub makes that failure say what it actually is.
//
// Tests that need their own fetch stub install one with `vi.stubGlobal('fetch', …)`; a later stub
// wins over this one, so this is a backstop, never a constraint.
import { vi } from 'vitest';

vi.stubGlobal(
	'fetch',
	vi.fn(async (input: unknown): Promise<never> => {
		const url =
			typeof input === 'string'
				? input
				: String((input as { url?: string } | null)?.url ?? input);
		throw new Error(
			`[test] unmocked network fetch to "${url}" — a vi.mock() almost certainly did not apply. ` +
				'Mock modules by their $lib alias id, never by a relative path.'
		);
	})
);
