// src/lib/i18n/delivery-error-label.test.ts — the switch itself, driven against the REAL compiled
// catalog, plus the contract with the backend that produces the codes.
//
// ⛔ WHY THE REAL CATALOG AND NOT A KEY→KEY STUB. The render spec beside this
// (`routes/solutions/solution-detail.delivery-error.render.test.ts`) already proves WHICH key each
// code chooses; if this file stubbed the catalog too, nothing anywhere would notice that a key was
// added to `en.json` and to the switch but never actually resolves — which is exactly what a
// mistyped key name looks like at runtime (paraglide compiles one function per key, so a typo is a
// `TypeError: m.delivery_error_timout is not a function`). Driving the compiled functions is what
// makes "the code maps to a sentence" mean a sentence exists.
//
// ⛔ AND THE SECOND HALF IS THE ONE THAT ROTS. `backend/` and `frontend/` are two separate Bun
// projects — no workspace, no shared package, no codegen — so the ONLY thing tying this switch to
// the taxonomy it claims to enumerate is a test that walks backend source text. Add a fifth
// `DeliveryConfigError` code in an adapter and, without the scan below, every delivery carrying it
// silently reverts to the English sentence with every test in both projects still green. Same
// technique, same reason, as `policy-label.backend-contract.test.ts` and
// `data-finding-label.backend-contract.test.ts`.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deliveryErrorLabel, deliveryKindLabel } from './delivery-error-label';
import type { DeliveryErrorView } from './delivery-error-label';

const ENGLISH = 'Azure DevOps request timed out — verify in Azure DevOps before retrying';

const view = (over: Partial<DeliveryErrorView> = {}): DeliveryErrorView => ({
	targetKind: 'azure_devops',
	error: ENGLISH,
	errorCode: null,
	errorStatus: null,
	...over
});

// ────────────────────────────────────────────────────────────── the switch

describe('every code the backend can persist becomes a sentence, not a token', () => {
	// ⛔ EVERY code, listed here as DATA so the loop below cannot silently shrink. The two
	// parameterised ones are asserted individually further down.
	const CODES = [
		'delivery_target_incomplete',
		'delivery_target_credentials_missing',
		'delivery_target_credentials_invalid',
		'target_http_error',
		'timeout',
		'transport',
		'egress_disabled',
		'egress_host_not_allowlisted',
		'egress_ssrf_blocked',
		'egress_bad_target',
		'delivery_ledger_update_failed'
	];

	for (const code of CODES) {
		it(`${code} → a real sentence, and NEVER the stored English`, () => {
			const out = deliveryErrorLabel(
				view({ errorCode: code, errorStatus: code === 'target_http_error' ? 503 : null })
			);
			// ⛔ THE THREE THINGS THAT GO WRONG, each asserted rather than implied:
			//  · the key does not resolve at all → `''` or a thrown TypeError;
			//  · the switch falls through → the English sentence comes back;
			//  · someone "localizes" by returning the code → a bare snake_case token on screen.
			expect(out.length, `${code} produced nothing`).toBeGreaterThan(0);
			expect(out, `${code} fell through to the stored English`).not.toBe(ENGLISH);
			expect(out, `${code} rendered its own machine token`).not.toContain(code);
		});
	}

	it('⛔ NON-VACUITY — the loop really ran, and the sentences are DISTINCT', () => {
		// Eleven codes collapsing onto one generic "delivery failed" would pass every assertion
		// above and be a worse product than the English it replaced.
		const sentences = CODES.map((code) =>
			deliveryErrorLabel(view({ errorCode: code, errorStatus: 503 }))
		);
		expect(new Set(sentences).size).toBe(CODES.length);
	});

	it('target_http_error interpolates the status the target answered with', () => {
		expect(deliveryErrorLabel(view({ errorCode: 'target_http_error', errorStatus: 503 }))).toContain(
			'503'
		);
	});

	it('⛔ target_http_error with NO status falls back rather than printing "HTTP undefined"', () => {
		// A pod one deploy behind persists `_cp_code` without `_cp_status`. Interpolating the absence
		// would produce a localized sentence that says LESS than the English one it replaced. `0` is
		// not a status either — the backend uses it to mean "no response at all".
		expect(deliveryErrorLabel(view({ errorCode: 'target_http_error', errorStatus: null }))).toBe(
			ENGLISH
		);
		expect(deliveryErrorLabel(view({ errorCode: 'target_http_error', errorStatus: 0 }))).toBe(
			ENGLISH
		);
	});

	it('names the right tool — the sentence and the product name are both the reader’s', () => {
		expect(deliveryErrorLabel(view({ errorCode: 'timeout', targetKind: 'jira' }))).toContain(
			deliveryKindLabel('jira')
		);
		expect(deliveryErrorLabel(view({ errorCode: 'timeout', targetKind: 'fr' }))).toContain(
			deliveryKindLabel('fr')
		);
		// …and the three kinds really are three different names, so the assertion above is not
		// comparing a string to itself.
		expect(new Set(['jira', 'azure_devops', 'fr'].map(deliveryKindLabel)).size).toBe(3);
	});
});

describe('the fallback is the documented one — an English sentence beats nothing', () => {
	it('⛔ a HISTORICAL row (no code, never migrated) renders its stored sentence', () => {
		expect(deliveryErrorLabel(view({ errorCode: null }))).toBe(ENGLISH);
	});

	it('⛔ a code shipped BACKEND-FIRST renders the sentence, not a bare token', () => {
		const out = deliveryErrorLabel(view({ errorCode: 'some_future_adapter_code' }));
		expect(out).toBe(ENGLISH);
		expect(out).not.toContain('some_future_adapter_code');
	});

	it('a row with neither a code nor prose renders `""` — the caller’s old `?? ""` behaviour', () => {
		expect(deliveryErrorLabel(view({ errorCode: null, error: null }))).toBe('');
		// ⚠️ AND SO DOES AN UNKNOWN CODE WITH NO PROSE. There is genuinely nothing to say; inventing
		// a sentence here would claim knowledge the row does not carry.
		expect(deliveryErrorLabel(view({ errorCode: 'unknown_x', error: null }))).toBe('');
	});
});

// ────────────────────────────────────────────────── the contract with the backend

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const DELIVERY_DIR = join(BACKEND, 'src', 'host', 'delivery');
const EGRESS = join(BACKEND, 'src', 'host', 'egress-guard.ts');

/**
 * Every code a `DeliveryConfigError` / `DeliveryDispatchError` is constructed with, across the
 * adapters.
 *
 * ⛔ IT READS THE WHOLE FIRST ARGUMENT, NOT "the string literal right after the paren". The first
 * version of this function did the latter and quietly missed TWO of the six codes, because
 * `azure-devops.ts`, `jira.ts` and `fr.ts` all write the transport branch as a TERNARY:
 *
 *     throw new DeliveryDispatchError(
 *       timeout ? 'timeout' : 'transport',
 *
 * — the shape the scan then reported as a four-code taxonomy. That is the "a scan that reads
 * nothing passes everything" failure this repo keeps catching, one notch smaller: it read
 * something, just not all of it. The pinned expected set below is what caught it.
 */
function backendTypedCodes(): Set<string> {
	const out = new Set<string>();
	for (const f of readdirSync(DELIVERY_DIR).filter((n) => n.endsWith('.ts'))) {
		const src = readFileSync(join(DELIVERY_DIR, f), 'utf8');
		for (const mtch of src.matchAll(/new\s+Delivery(?:Config|Dispatch)Error\(/g)) {
			// The first argument: from the open paren to the first comma at nesting depth 0.
			const from = mtch.index! + mtch[0].length;
			let depth = 0;
			let end = from;
			for (; end < src.length; end++) {
				const c = src[end];
				if (c === '(' || c === '[' || c === '{') depth++;
				else if (c === ')' || c === ']' || c === '}') {
					if (depth === 0) break;
					depth--;
				} else if (c === ',' && depth === 0) break;
			}
			for (const lit of src.slice(from, end).matchAll(/'([a-z_]+)'/g)) out.add(lit[1]!);
		}
	}
	return out;
}

/** The `EgressBlockedError` code union, read off its declaration rather than its call sites. */
function backendEgressCodes(): Set<string> {
	const src = readFileSync(EGRESS, 'utf8');
	const at = src.indexOf('readonly code:');
	if (at === -1) throw new Error('EgressBlockedError.code declaration not found');
	const body = src.slice(at, src.indexOf('message: string', at));
	return new Set([...body.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!));
}

/** The `case '…':` labels this module actually handles. */
function handledCodes(): Set<string> {
	const src = readFileSync(new URL('./delivery-error-label.ts', import.meta.url), 'utf8');
	// Comments are stripped first: this repo has measured a guard being defeated by a code sample
	// inside a comment block.
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	return new Set([...code.matchAll(/case '([a-z_]+)':/g)].map((x) => x[1]!));
}

describe('the switch enumerates the backend taxonomy, not a snapshot of it', () => {
	it('⛔ the scan is not vacuous — it really read the adapters and the egress guard', () => {
		// Pinned to the exact sets, not a floor: a SIXTH typed code the frontend has never heard of is
		// as much a break as a missing one, and a regex that silently matched nothing would make every
		// assertion below pass against an empty set — the failure mode this repo keeps catching.
		expect([...backendTypedCodes()].sort()).toEqual([
			'delivery_target_credentials_invalid',
			'delivery_target_credentials_missing',
			'delivery_target_incomplete',
			'target_http_error',
			'timeout',
			'transport'
		]);
		expect([...backendEgressCodes()].sort()).toEqual([
			'egress_bad_target',
			'egress_disabled',
			'egress_host_not_allowlisted',
			'egress_ssrf_blocked'
		]);
	});

	it('⛔ every code the backend can persist has a case here', () => {
		const handled = handledCodes();
		const missing = [...backendTypedCodes(), ...backendEgressCodes()].filter(
			(c) => !handled.has(c)
		);
		expect(
			missing,
			'a delivery failure code exists in backend/src/host that this switch does not handle — ' +
				'deliveries carrying it silently revert to the adapter’s English sentence'
		).toEqual([]);
	});

	it('⚠️ and no case here names a code the backend cannot produce', () => {
		// The other direction. `delivery_ledger_update_failed` is the one code this switch handles
		// that no adapter throws: `routes/delivery.ts` synthesises it for the "the ticket exists but
		// our ledger write failed" branch, so it is declared here rather than scanned for.
		const SYNTHESISED = new Set(['delivery_ledger_update_failed']);
		const backend = new Set([...backendTypedCodes(), ...backendEgressCodes()]);
		const stale = [...handledCodes()].filter((c) => !backend.has(c) && !SYNTHESISED.has(c));
		expect(stale, 'this switch handles a code no backend site can emit any more').toEqual([]);
	});

	it('⛔ the synthesised code really is written by the route — not a name this file invented', () => {
		const routeSrc = readFileSync(join(BACKEND, 'src', 'routes', 'delivery.ts'), 'utf8');
		expect(routeSrc).toContain("'delivery_ledger_update_failed'");
		// …and the field it rides in is the one the projection reads back.
		expect(routeSrc).toContain('_cp_code');
		expect(routeSrc).toContain('_cp_status');
	});
});
