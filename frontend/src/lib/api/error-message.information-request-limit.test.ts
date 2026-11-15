// src/lib/api/error-message.information-request-limit.test.ts — the 429 `information_request_limit`
// (backend/src/routes/information-requests.ts `assertRequestQuota`) reaches the member as a
// localized sentence that says what to do, not as the generic "could not be sent" fallback.
// Driven through the REAL information-requests client (`unwrap` lifts `details`) and the REAL
// catalog, so a missing key or a dropped `details` bag shows up here.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('$lib/paraglide/runtime', async (orig) => ({ ...(await orig()), getLocale: () => 'en' }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch: vi.fn() }));

import * as m from '$lib/paraglide/messages';
import { writeErrorText } from './error-message';
import { informationRequestsApi } from './information-requests';
import { authFetch } from '$lib/api/auth-fetch';

const FALLBACK = 'FALLBACK';

function refuse(reason: string | undefined) {
	vi.mocked(authFetch).mockResolvedValueOnce(
		new Response(
			JSON.stringify({
				error: 'information_request_limit',
				message: 'Too many open requests on this challenge',
				...(reason ? { details: { reason, limit: 5 } } : {})
			}),
			{ status: 429, headers: { 'content-type': 'application/json' } }
		)
	);
}

async function sentence(): Promise<string> {
	try {
		await informationRequestsApi.uploadRecords('c1', new File(['a\n1\n'], 'x.csv'));
	} catch (e) {
		return writeErrorText(e, FALLBACK);
	}
	throw new Error('expected a refusal');
}

afterEach(() => vi.mocked(authFetch).mockReset());

describe('429 information_request_limit', () => {
	it('reason pending → "wait for a review"', async () => {
		refuse('pending');
		const s = await sentence();
		expect(s).toBe(m.error_information_request_limit_pending());
		expect(s).not.toBe(FALLBACK);
	});

	it('reason daily → "try again tomorrow"', async () => {
		refuse('daily');
		expect(await sentence()).toBe(m.error_information_request_limit_daily());
	});

	it('no details (an old pod) still answers a localized sentence, never the fallback', async () => {
		refuse(undefined);
		expect(await sentence()).toBe(m.error_information_request_limit_daily());
	});
});
