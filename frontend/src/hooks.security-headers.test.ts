// src/hooks.security-headers.test.ts — pins the browser-security headers `handle` stamps on the shell.
//
// ⛔ WHAT THIS TEST IS FOR. The headers under test are INVISIBLE in every other way we look at this
// app: nothing renders differently, no page breaks, no console warning fires if they silently stop
// being sent. The defect they fix was found by COMPARING two origins in production, and a regression
// would be found the same way — i.e. by nobody, until it mattered. This file is the only mechanism
// that notices. It therefore asserts EXACT VALUES rather than mere presence: `x-frame-options` set
// to something is not the property we want, `SAMEORIGIN` is, and `cross-origin-opener-policy`
// silently drifting from `same-origin-allow-popups` to bare `same-origin` would break the
// popup-based auth flow while leaving a test that only checked presence perfectly green.
//
// ⚠️ THE FAKES ARE THE PLATFORM ONLY. As in `hooks.server.negotiation.test.ts`, `handle` itself is
// real; only `event` and `resolve` are stood up, and `resolve` returns a REAL `Response` so the
// header assertions exercise real `Headers` `has`/`set`/`append` semantics rather than a stub's.
import { describe, it, expect } from 'vitest';
import { handle } from './hooks.server';

/** The shape `handle` is actually called with, so the fakes below can be cast once and named here. */
type HandleArg = Parameters<typeof handle>[0];

/**
 * The contract, spelled out here rather than imported from `hooks.server.ts`.
 *
 * ⛔ DELIBERATELY A SECOND COPY. Importing `SECURITY_HEADERS` and asserting the response matches it
 * would be a test that cannot fail: edit the table to `x-frame-options: nonsense` and the test
 * follows it and stays green, because both sides moved together. Restating the expected values
 * independently is what makes an edit to the table show up as a RED test that a human then has to
 * agree with. If you change one, you must change the other on purpose.
 */
const EXPECTED = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'x-frame-options': 'SAMEORIGIN',
	'cross-origin-opener-policy': 'same-origin-allow-popups'
} as const;

/**
 * Drive the real `handle` with a fake `event`/`resolve` and return both the response it produced and
 * the `transformPageChunk` it handed to SvelteKit.
 *
 * `preset` lets a caller seed the resolved response with headers that were "already there", which is
 * how the do-not-clobber case below is expressed.
 */
async function driveHandle(preset: Record<string, string> = {}) {
	let transform: ((chunk: { html: string; done: boolean }) => string) | undefined;
	const event = {
		cookies: { get: () => null },
		request: { headers: { get: () => null } }
	};
	const resolve = (
		_event: unknown,
		opts?: { transformPageChunk?: (chunk: { html: string; done: boolean }) => string }
	) => {
		transform = opts?.transformPageChunk;
		// ⚠️ A REAL `Response`, not `{ status: 200 }`. `handle` calls `.append` and `.has`/`.set` on
		// these headers, so a fake without a real `Headers` dies on `undefined.append` and reports as
		// a broken hook rather than a broken fake.
		return new Response(null, { status: 200, headers: preset });
	};
	const response = (await handle({ event, resolve } as unknown as HandleArg)) as Response;

	// ⛔ NON-VACUITY, FIRST AND BEFORE ANY HEADER IS READ. Every assertion in this file is of the
	// form `response.headers.get(x)`. If `handle` ever returned `undefined` — or this harness stopped
	// awaiting it — that expression would throw a TypeError, or worse, a `?? ''` somewhere would turn
	// the whole suite into assertions about nothing. Proving a real `Response` with real `Headers`
	// came back is what stops "the headers are correct" from being a claim about an empty object.
	expect(response, 'handle() did not return a response at all').toBeInstanceOf(Response);
	expect(response.headers, 'the returned response carries no Headers').toBeInstanceOf(Headers);

	return { response, transform };
}

describe('handle sets the browser-security headers the app was serving none of', () => {
	// Table-driven so that adding a fifth header to `SECURITY_HEADERS` without adding it to
	// `EXPECTED` is a visible omission rather than an untested one.
	for (const [name, value] of Object.entries(EXPECTED)) {
		it(`⛔ sets ${name}: ${value}`, async () => {
			const { response } = await driveHandle();
			expect(response.headers.get(name), `${name} is missing or wrong on the shell`).toBe(value);
		});
	}

	it('⚠️ cross-origin-opener-policy is the -allow-popups variant, NOT bare same-origin', async () => {
		// Stated as its own discriminating case because this is the one value in the table where the
		// "obviously stricter" alternative is a FUNCTIONAL REGRESSION, not a tightening: bare
		// `same-origin` severs `window.opener`, which is the channel a popup-based Keycloak flow uses
		// to return its result to the opener. A presence-only check would not catch that edit.
		const { response } = await driveHandle();
		expect(response.headers.get('cross-origin-opener-policy')).not.toBe('same-origin');
		expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
	});

	it('⛔ does not clobber a stricter header that is already present', async () => {
		// The table is a FLOOR, not an override. A route or an upstream that has deliberately set
		// `x-frame-options: DENY` must keep it; a `set` without the `has` guard would silently
		// downgrade that to SAMEORIGIN. The un-preset header in the same response proves the guard
		// did not simply skip the whole loop.
		const { response } = await driveHandle({ 'x-frame-options': 'DENY' });
		expect(response.headers.get('x-frame-options'), 'a stricter upstream value was overwritten').toBe(
			'DENY'
		);
		expect(response.headers.get('x-content-type-options'), 'the loop skipped everything').toBe(
			'nosniff'
		);
	});
});

describe('handle still does the job it already had', () => {
	it('⛔ returns the transformed body, not a bare response', async () => {
		// The headers are stamped on the SAME response object that carries the locale stamping. This
		// asserts the two did not become mutually exclusive — an early return added for the header
		// path would leave `%cp.lang%` literals in a served document, a worse bug than the one the
		// headers fix.
		const { transform } = await driveHandle();
		expect(transform, 'handle() did not pass a transformPageChunk to resolve()').toBeTypeOf(
			'function'
		);
		expect(transform!({ html: '<html lang="%cp.lang%" dir="%cp.dir%">', done: true })).toBe(
			'<html lang="en" dir="ltr">'
		);
	});

	it('⚠️ still varies the shell on Cookie and Accept-Language', async () => {
		// Regression guard on the interaction, not a duplicate of the negotiation suite: `Vary` is
		// `append`ed while the security headers are `set`, and this proves adding the second loop did
		// not disturb the first.
		const { response } = await driveHandle();
		expect(response.headers.get('Vary') ?? '').toMatch(/Cookie/i);
		expect(response.headers.get('Vary') ?? '').toMatch(/Accept-Language/i);
	});
});

describe('Content-Security-Policy is deliberately absent', () => {
	it('⛔ no CSP is set — and this test failing means someone added one, which needs a review', async () => {
		// ⚠️ READ THE COMMENT IN `hooks.server.ts` BEFORE "FIXING" THIS. CSP is the highest-value
		// header on the list and the one that cannot be added blind: a wrong `script-src`/`connect-src`
		// does not degrade this SPA, it white-pages it. It needs a policy derived from the app's real
		// origins (self, `auth.nonagentic.ai`, any CDN/font host, whatever a PRODUCTION Vite build
		// actually emits) and a report-only soak before enforcement.
		//
		// This assertion exists so that absence is a RECORDED DECISION rather than an oversight
		// somebody silently corrects. It is not an argument against ever shipping CSP — when the
		// derivation and the report-only pass are done, DELETE this block in the same change.
		const { response } = await driveHandle();
		expect(response.headers.get('content-security-policy')).toBeNull();
		expect(response.headers.get('content-security-policy-report-only')).toBeNull();
	});
});
