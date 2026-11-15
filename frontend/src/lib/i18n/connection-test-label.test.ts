// src/lib/i18n/connection-test-label.test.ts — the switch, driven against the REAL compiled
// catalog, plus the contract with the six backend files that produce the codes.
//
// ⛔ WHY THE REAL CATALOG. The three render specs beside this prove WHICH key each code chooses;
// if this file stubbed the catalog too, nothing anywhere would notice that a key was added to the
// switch and to `en.json` but never actually resolves — which at runtime is a hard
// `TypeError: m.llm_test_ok is not a function`, because paraglide compiles one function per key.
//
// ⛔ AND THE SECOND HALF IS THE ONE THAT ROTS. `backend/` and `frontend/` are separate Bun projects
// — no workspace, no shared package, no codegen. The ONLY thing tying this switch to the codes the
// backend can emit is a test that walks backend source text. Add a return site with a new code and,
// without the scan below, that result silently renders the English `detail` forever with every test
// in both projects green. Same technique as `policy-label.backend-contract.test.ts`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { connectionTestLabel } from './connection-test-label';
import type { ConnectionTestResult } from './connection-test-label';

const DETAIL = 'Connected — read 5 columns, 3 sample rows.';
const res = (over: Partial<ConnectionTestResult>): ConnectionTestResult => ({
	ok: true,
	detail: DETAIL,
	...over
});

/**
 * Every SENTENCE this module claims to produce, with a params bag that satisfies it.
 *
 * ⚠️ KEYED BY `name`, NOT BY `code`, since `bad_config` carries EIGHT sentences behind one code
 * (`utils/http.ts` documents why `reason` is a `details` field and not a second wire code) and
 * `unknown_connector` carries two. `name` defaults to `code` for the one-sentence codes.
 */
type Case = { code: string; name?: string; params?: Record<string, string | number> };
const nameOf = (c: Case): string => c.name ?? c.code;
const CASES: Case[] = [
	{ code: 'connector_test_ok', params: { cols: 5, rows: 3 } },
	{ code: 'connector_test_failed', params: { detail: 'connect ECONNREFUSED 10.0.0.4:5432' } },
	{ code: 'llm_test_ok', params: { provider: 'anthropic', model: 'claude-sonnet-4' } },
	{ code: 'llm_test_model_not_offered', params: { model: 'gpt-9', provider: 'Anthropic' } },
	{ code: 'llm_test_no_api_key' },
	{ code: 'llm_test_stub_only' },
	{ code: 'llm_test_failed', params: { detail: '401 invalid_api_key' } },
	{ code: 'delivery_test_unreachable', params: { kind: 'jira', detail: 'ETIMEDOUT' } },
	{ code: 'delivery_test_http', params: { kind: 'jira', status: 502 } },
	{ code: 'delivery_test_jira_ok', params: { user: 'Mary de Vries' } },
	{ code: 'delivery_test_jira_ok_anon' },
	{ code: 'delivery_test_jira_unauthorized' },
	{ code: 'delivery_test_ado_ok', params: { project: 'Claims' } },
	{ code: 'delivery_test_ado_unauthorized' },
	{ code: 'delivery_test_ado_project_not_found', params: { project: 'Claims' } },
	{ code: 'delivery_test_fr_ok', params: { base: 'https://fr.example.com' } },

	// ── the REFUSAL family, which had no case at all until this change ─────────────────────────
	// Reproduced live against main: POST /api/connectors/test with a postgres config missing `url`
	// answers HTTP 200 {ok:false, code:'bad_config', detail:"'url' is required"} — 200, so nothing
	// throws, so `errorText` never runs, so a Dutch tenant admin read `'url' is required`.
	{ code: 'bad_config', name: 'bad_config/required', params: { reason: 'required', field: 'url' } },
	{
		code: 'bad_config',
		name: 'bad_config/percent_escape',
		params: { reason: 'percent_escape', field: 'key' }
	},
	{ code: 'bad_config', name: 'bad_config/backslash', params: { reason: 'backslash', field: 'key' } },
	{
		code: 'bad_config',
		name: 'bad_config/dot_segment',
		params: { reason: 'dot_segment', field: 'bucket' }
	},
	{ code: 'bad_config', name: 'bad_config/absolute', params: { reason: 'absolute', field: 'key' } },
	{ code: 'bad_config', name: 'bad_config/postgres_scheme', params: { reason: 'postgres_scheme' } },
	{ code: 'bad_config', name: 'bad_config/http_scheme', params: { reason: 'http_scheme' } },
	{
		code: 'bad_config',
		name: 'bad_config/key_escapes_bucket',
		params: { reason: 'key_escapes_bucket', resolved: '/api/files/cp-victim/secret.csv' }
	},
	{ code: 'unknown_connector', name: 'unknown_connector/kind', params: { kind: 'sftp' } },
	// ⚠️ NO `kind` — `fetchConnector`'s default branch has a narrowed union and no string to report.
	// This is the one place an absent param must NOT fall back to `detail`; see its own test below.
	{ code: 'unknown_connector', name: 'unknown_connector/anonymous' }
];

describe('every code becomes a real sentence — never a token, never the server’s English', () => {
	for (const c of CASES) {
		it(`${nameOf(c)}`, () => {
			const out = connectionTestLabel(res({ code: c.code, params: c.params }), 'nl');
			// The four ways this goes wrong, each asserted rather than implied:
			//  · the key does not resolve            → '' (or a thrown TypeError);
			//  · the switch falls through            → the server's English comes back;
			//  · someone "localizes" with the token  → bare snake_case on screen;
			//  · the sub-discriminator leaks         → `reason` printed instead of translated.
			expect(out.length, `${nameOf(c)} produced nothing`).toBeGreaterThan(0);
			expect(out, `${nameOf(c)} fell through to the server's English`).not.toBe(DETAIL);
			expect(out, `${nameOf(c)} rendered its own machine token`).not.toContain(c.code);
			// ⚠️ ONLY THE MULTI-WORD REASONS. `backslash` is a legitimate Dutch word in
			// `bad_config_backslash` ("mag geen backslash bevatten") and `required`/`absolute` are
			// English words a translator may reasonably reach for — asserting their absence would ban
			// correct copy. A token with an underscore in it can never be prose in any of the eight.
			const reason = c.params?.reason;
			if (typeof reason === 'string' && reason.includes('_'))
				expect(out, `${nameOf(c)} rendered its raw reason token`).not.toContain(reason);
		});
	}

	it('⛔ NON-VACUITY — the loop ran and every sentence is DISTINCT', () => {
		// Twenty-six sentences collapsing onto one generic "test finished" would pass every assertion
		// above and be a worse product than the English it replaced. This is also the ONLY thing that
		// catches a copy-paste inside the `bad_config` sub-switch, where eight near-identical branches
		// sit one under the other and `m.bad_config_backslash` twice typechecks perfectly.
		const outs = CASES.map((c) => connectionTestLabel(res({ code: c.code, params: c.params }), 'nl'));
		expect(new Set(outs).size).toBe(CASES.length);
		expect(CASES.length).toBe(26);
	});

	it('⛔ THE SUCCESS PATH — the counts are grouped in the READER’S locale', () => {
		// The headline defect: HTTP 200, ok:true, and the screen read English. `rows` is the whole
		// fetched set (capped at DATASET_INJECT_ROW_CAP = 10 000), so four digits is ordinary.
		const nl = connectionTestLabel(
			res({ code: 'connector_test_ok', params: { cols: 5, rows: 10000 } }),
			'nl'
		);
		const en = connectionTestLabel(
			res({ code: 'connector_test_ok', params: { cols: 5, rows: 10000 } }),
			'en'
		);
		expect(nl).toContain('10.000');
		expect(en).toContain('10,000');
		expect(nl).not.toBe(en);
	});

	it('⛔ a count of ZERO is rendered, not treated as absent', () => {
		// A source that connected but returned no rows is a REAL, reportable result. `0` is falsy,
		// which is exactly how this class of bug ships — the guard is `=== null`, not truthiness.
		const out = connectionTestLabel(
			res({ code: 'connector_test_ok', params: { cols: 0, rows: 0 } }),
			'nl'
		);
		expect(out).not.toBe(DETAIL);
		expect(out).toContain('0');
	});

	it('an HTTP status is NEVER given a thousands separator', () => {
		const out = connectionTestLabel(
			res({ code: 'delivery_test_http', params: { kind: 'jira', status: 502 } }),
			'nl'
		);
		expect(out).toContain('502');
		expect(out).not.toContain('5.02');
	});
});

describe('the fallback never renders blank — a rolling deploy depends on it', () => {
	it('⛔ NO code at all (an old pod) → the server’s `detail`', () => {
		expect(connectionTestLabel(res({ code: undefined }), 'nl')).toBe(DETAIL);
	});

	it('⛔ an UNKNOWN code (backend-first, or a forwarded HttpError code) → `detail`', () => {
		const out = connectionTestLabel(res({ code: 'egress_host_not_allowlisted' }), 'nl');
		expect(out).toBe(DETAIL);
		expect(out).not.toContain('egress_host_not_allowlisted');
	});

	it('⛔ a known code with MISSING params → `detail`, never "undefined" in a sentence', () => {
		// The mid-roll shape that matters most: the code shipped one release before the params did.
		// Interpolating the absence produces a localized sentence that says LESS than the English.
		for (const code of [
			'connector_test_ok',
			'llm_test_ok',
			'delivery_test_ado_ok',
			'delivery_test_jira_ok',
			'delivery_test_http',
			'delivery_test_unreachable',
			'delivery_test_fr_ok'
		]) {
			const out = connectionTestLabel(res({ code, params: {} }), 'nl');
			expect(out, `${code} interpolated an absent field`).toBe(DETAIL);
			expect(out).not.toContain('undefined');
		}
	});

	it('⛔ `bad_config` with NO `reason` (an old pod) → `detail`, not a generic refusal', () => {
		// THE mid-roll shape for this family, and the one a rolling deploy really produces: the code
		// `bad_config` has been on the wire since the endpoint existed, `reason` ships with THIS
		// release. An old pod answers `{ok:false, code:'bad_config', detail:"'url' is required"}` with
		// no `params` at all — English, but the exact rule that was broken. A generic localized
		// "your configuration is invalid" would say strictly less, which is why the inner `default`
		// falls through instead of reaching for a catch-all key.
		const partials: (Record<string, string | number> | undefined)[] = [
			undefined,
			{},
			{ field: 'url' }
		];
		for (const params of partials) {
			const out = connectionTestLabel(res({ code: 'bad_config', params }), 'nl');
			expect(out, `bad_config with params=${JSON.stringify(params)} did not fall back`).toBe(DETAIL);
		}
	});

	it('⛔ a NINTH `bad_config` reason, added backend-first → `detail`, never a bare token', () => {
		// The inner switch is as open a code space as the outer one: `validateConnectorConfig` owns
		// these reasons and can grow one without this bundle. It must degrade to the English sentence,
		// not to a blank notice and not to the snake_case token.
		const out = connectionTestLabel(
			res({ code: 'bad_config', params: { reason: 'query_not_select', field: 'query' } }),
			'nl'
		);
		expect(out).toBe(DETAIL);
		expect(out).not.toContain('query_not_select');
	});

	it('⛔ each `bad_config` reason that NEEDS its value falls back without it', () => {
		// Five of the eight interpolate `{field}` and one interpolates `{resolved}`. A reason arriving
		// without its value is the code-ships-before-params half of the same roll, and a Dutch sentence
		// with an EMPTY field name in it says strictly less than the English it replaced.
		for (const reason of [
			'required',
			'percent_escape',
			'backslash',
			'dot_segment',
			'absolute',
			'key_escapes_bucket'
		]) {
			const out = connectionTestLabel(res({ code: 'bad_config', params: { reason } }), 'nl');
			expect(out, `bad_config/${reason} interpolated an absent value`).toBe(DETAIL);
			expect(out).not.toContain('undefined');
		}
	});

	it('⚠️ the two PARAMETERLESS reasons render WITHOUT any params — non-vacuity for the loop above', () => {
		// Otherwise "a reason with no value falls back" could be true because EVERY reason falls back,
		// i.e. because the sub-switch never matches anything at all.
		for (const reason of ['postgres_scheme', 'http_scheme']) {
			const out = connectionTestLabel(res({ code: 'bad_config', params: { reason } }), 'nl');
			expect(out, `bad_config/${reason} should not need a param`).not.toBe(DETAIL);
			expect(out.length).toBeGreaterThan(0);
		}
	});

	it('⛔ `unknown_connector` WITHOUT a kind is a real sentence, not a fallback', () => {
		// The one deliberate exception to "absent param → detail": `fetchConnector`'s default branch
		// has a narrowed union and no kind string to report, yet the refusal is still fully sayable.
		// Two keys, not one with an empty `{kind}`.
		const anon = connectionTestLabel(res({ code: 'unknown_connector' }), 'nl');
		const named = connectionTestLabel(res({ code: 'unknown_connector', params: { kind: 'sftp' } }), 'nl');
		expect(anon).not.toBe(DETAIL);
		expect(anon.length).toBeGreaterThan(0);
		expect(anon).not.toContain('undefined');
		expect(named).toContain('sftp');
		expect(anon).not.toBe(named);
	});
});

describe('RTL: an identifier the product does not constrain is bidi-isolated', () => {
	// ⛔ WHY THIS IS NOT DECORATION. Every value interpolated here is environment-supplied and
	// mixed-script by nature — a Jira display name, an ADO project key, an fr base URL, and above
	// all a raw driver exception with a host:port in it. Without isolation, a latin run inside an
	// Arabic or Hebrew sentence reorders on screen. U+2068/U+2069 are zero-width and are exactly
	// what `<bdi>` compiles to; returning markup instead would need `{@html}` at the render site,
	// which would inject backend strings into the DOM as HTML.
	const ISOLATED = ['⁨', '⁩'];

	// ⚠️ THE REFUSAL FAMILY BELONGS IN THIS LIST, and it is the one whose values are least
	// constrained of all: `field` is a key out of a `z.record(z.string(), z.unknown())` body,
	// `resolved` is a URL pathname the caller composed, `kind` is a raw `sourceType` string. All
	// three are attacker-supplied by construction, all three are latin-by-convention only, and all
	// three sit inside an Arabic or Hebrew sentence that reorders around them without isolation.
	const ISOLATING = [
		'connector_test_failed',
		'llm_test_ok',
		'delivery_test_jira_ok',
		'delivery_test_ado_ok',
		'delivery_test_fr_ok',
		'delivery_test_unreachable',
		'bad_config/required',
		'bad_config/percent_escape',
		'bad_config/backslash',
		'bad_config/dot_segment',
		'bad_config/absolute',
		'bad_config/key_escapes_bucket',
		'unknown_connector/kind'
	];

	for (const c of CASES.filter((x) => ISOLATING.includes(nameOf(x)))) {
		it(`${nameOf(c)} wraps its identifier`, () => {
			const out = connectionTestLabel(res({ code: c.code, params: c.params }), 'ar');
			for (const ch of ISOLATED) expect(out).toContain(ch);
		});
	}

	it('⛔ NON-VACUITY — the filter selected every case it names', () => {
		// A renamed case would silently drop out of the loop above and take its RTL proof with it —
		// the loop would still pass, on a smaller set, saying nothing about the case that changed.
		expect(CASES.filter((x) => ISOLATING.includes(nameOf(x))).map(nameOf).sort()).toEqual(
			[...ISOLATING].sort()
		);
	});

	it('⛔ NON-VACUITY — a code with NO interpolated identifier carries no isolates', () => {
		// Otherwise "contains U+2068" could be true of a catalog string that happened to have one,
		// and every assertion above would prove nothing.
		const out = connectionTestLabel(res({ code: 'llm_test_no_api_key' }), 'ar');
		for (const ch of ISOLATED) expect(out).not.toContain(ch);
	});

	it('⛔ NON-VACUITY — a parameterless `bad_config` reason carries no isolates either', () => {
		// The same proof INSIDE the new family: `postgres_scheme` and `http_scheme` interpolate
		// nothing, so if they came back isolated the marks would be coming from the catalog rather
		// than from `iso()`, and every assertion in this block would be measuring the wrong thing.
		for (const reason of ['postgres_scheme', 'http_scheme']) {
			const out = connectionTestLabel(res({ code: 'bad_config', params: { reason } }), 'ar');
			for (const ch of ISOLATED) expect(out, `bad_config/${reason}`).not.toContain(ch);
		}
	});

	it('⚠️ the HTTP status is NOT isolated — it is a number, not a foreign identifier', () => {
		const out = connectionTestLabel(
			res({ code: 'delivery_test_http', params: { kind: 'jira', status: 502 } }),
			'ar'
		);
		for (const ch of ISOLATED) expect(out).not.toContain(ch);
	});
});

// ───────────────────────────────────────────────── the contract with the backend

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const SITES = [
	join(BACKEND, 'src', 'routes', 'connectors.ts'),
	join(BACKEND, 'src', 'routes', 'llm-settings.ts'),
	join(BACKEND, 'src', 'host', 'delivery', 'jira.ts'),
	join(BACKEND, 'src', 'host', 'delivery', 'azure-devops.ts'),
	join(BACKEND, 'src', 'host', 'delivery', 'fr.ts')
];

/** Every literal `code: '…'` / `code: cond ? 'a' : 'b'` a test endpoint can answer with. */
function backendCodes(): Set<string> {
	const out = new Set<string>();
	for (const f of SITES) {
		const src = readFileSync(f, 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		// The value may be a literal or a ternary of two literals (jira's named/anonymous split), so
		// every lowercase literal up to the end of the line is taken.
		for (const line of src.split('\n')) {
			const at = line.indexOf('code:');
			if (at === -1) continue;
			for (const lit of line.slice(at).matchAll(/'([a-z_]+)'/g)) out.add(lit[1]!);
		}
	}
	return out;
}

function labelSource(): string {
	return readFileSync(new URL('./connection-test-label.ts', import.meta.url), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The OUTER `case '…':` labels — the wire `code` values this module handles.
 *
 * ⛔ ANCHORED TO THE INDENTATION, and that is load-bearing now that `bad_config` dispatches a
 * NESTED switch on `params.reason`. An unanchored `/case '…':/` swept the eight reason labels up
 * with the codes, and every assertion below then compared a code set against a code∪reason set —
 * two things that can never be equal, in a file whose whole job is to say when they diverge.
 * Outer cases sit at exactly two tabs (function → switch → case); reasons sit at four.
 */
function handledCodes(): Set<string> {
	return new Set([...labelSource().matchAll(/^\t\tcase '([a-z_]+)':/gm)].map((x) => x[1]!));
}

/** The INNER `case '…':` labels — the `bad_config` sub-discriminators, at four tabs. */
function handledReasons(): Set<string> {
	return new Set([...labelSource().matchAll(/^\t\t\t\tcase '([a-z_]+)':/gm)].map((x) => x[1]!));
}

/** Every catalog key this module actually CALLS, `m.<key>(…)`. */
function referencedKeys(): Set<string> {
	return new Set([...labelSource().matchAll(/\bm\.([a-z0-9_]+)\(/g)].map((x) => x[1]!));
}

/**
 * The two files that own the `bad_config` / `unknown_connector` code space.
 *
 * ⚠️ These codes are THROWN, not returned, so they are invisible to `backendCodes()` above — they
 * reach the wire through `routes/connectors.ts`'s `catch (e) { … code: e.code … }`, whose own
 * comment says "that code space belongs to `validateConnectorConfig` and is genuinely open".
 * Scanning the throw sites is the only way this file can tell a real code from an invented one.
 */
const THROW_SITES = [
	join(BACKEND, 'src', 'datasets', 'connectors', 'index.ts'),
	join(BACKEND, 'src', 'datasets', 'connectors', 'storage.ts'),
	// ⛔ ADDED AFTER THE BROWSER CAUGHT WHAT THIS LIST DID NOT. `assertReadOnlySelect` lives here and
	// runs INSIDE `validateConnectorConfig`, so its three refusals reach this screen through exactly
	// the same forwarding branch as `bad_config` — but the file was not scanned, so the union below
	// could not demand a case for them. Typing `delete from datasets` into the Dutch form rendered
	// `connector query must be a SELECT (or WITH … SELECT)` in English while the suite was green.
	join(BACKEND, 'src', 'datasets', 'connectors', 'postgres.ts')
];

/** Every `badRequest('…', …)` code literal in the two throw-site files. */
function thrownCodes(): Set<string> {
	const out = new Set<string>();
	for (const f of THROW_SITES) {
		for (const lit of readFileSync(f, 'utf8').matchAll(/badRequest\(\s*'([a-z_]+)'/g)) out.add(lit[1]!);
	}
	return out;
}

/** Codes this module handles that arrive by FORWARDING a thrown `HttpError.code`, not by return. */
const FORWARDED = [
	'bad_config',
	'unknown_connector',
	// The SQL guard (`assertReadOnlySelect`), forwarded through the same branch.
	'empty_query',
	'multi_statement',
	'not_select'
];

/**
 * The fr Gate-2 family — forwarded like the five above, but from a DIFFERENT branch and proven a
 * DIFFERENT way, which is exactly why it is a separate list.
 *
 * `routes/delivery.ts:249-258` (not `routes/connectors.ts`) catches the precheck's `HttpError` and
 * answers HTTP 200 `{ok:false, code: e.code, detail}`. And these codes are NOT `badRequest(...)`
 * literals — they are the values of `FR_LICENSE_CODE` in `services/fr-license.ts`, read dynamically
 * as `paymentRequired(err.code, …)`. So `thrownCodes()`, which scrapes `badRequest('…')` out of the
 * two connector files, is structurally incapable of proving them; putting them in `FORWARDED` would
 * have made that proof assert something it never checked.
 */
const FORWARDED_FR = [
	'fr_license_inactive',
	'fr_license_app_mismatch',
	'fr_license_tenant_mismatch',
	'fr_license_unavailable'
];

describe('the switch enumerates the backend’s codes, not a snapshot of them', () => {
	it('⛔ the scan is not vacuous — it really read all five backend files', () => {
		// Pinned to the EXACT set. A scan that silently matched nothing would make the comparison
		// below pass against an empty set — the failure mode this repo keeps catching. A SEVENTEENTH
		// code the frontend has never heard of is as much a break as a missing one.
		//
		// ⚠️ THE SET IS NOW A UNION, because two of the codes this module handles are never RETURNED
		// by a route — they are thrown by `validateConnectorConfig` / `fetchStorage` and forwarded by
		// `routes/connectors.ts` as `code: e.code`. `backendCodes()` scrapes `code: '<literal>'` and
		// by construction cannot see them; `FORWARDED` names them and `thrownCodes()` proves they
		// exist. The `16` stays a pin on the RETURN sites alone: if a route starts returning
		// `bad_config` as a literal, this number moves and someone re-reads this file.
		expect(backendCodes().size).toBe(16);
		expect([...new Set([...backendCodes(), ...FORWARDED, ...FORWARDED_FR])].sort()).toEqual(
			[...handledCodes()].sort()
		);
	});

	it('⛔ the fr Gate-2 codes are REAL — they are minted in services/fr-license.ts', () => {
		// The `FORWARDED_FR` counterpart of the `thrownCodes()` proof below: without it that list is
		// an assertion about itself, and an invented `fr_license_typo` would render a catalog sentence
		// for a refusal the backend cannot produce.
		const src = readFileSync(join(BACKEND, 'src', 'services', 'fr-license.ts'), 'utf8');
		expect(src.length, 'fr-license.ts read as empty — this proves nothing').toBeGreaterThan(500);
		for (const c of FORWARDED_FR) expect(src, `${c} is not minted`).toContain(`'${c}'`);
		// ⛔ AND THE COLLAPSED CODE IS GONE. One code for four reasons was the defect: the reason
		// survived only in an English sentence, which is the one thing the browser cannot localize.
		expect(
			src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''),
			'services/fr-license.ts still emits the collapsed `fr_license_required` outside a comment'
		).not.toContain('fr_license_required');
	});

	it('⛔ the delivery forwarding branch that carries the fr codes still exists', () => {
		// The premise of the test above, mirroring the `routes/connectors.ts` check below. If this
		// catch is ever changed to re-throw, the fr refusals become a 4xx that `errorText` owns and
		// these four cases become dead copy.
		const src = readFileSync(join(BACKEND, 'src', 'routes', 'delivery.ts'), 'utf8');
		expect(src).toContain('code: e.code');
		expect(src).toContain('paymentRequired(err.code');
	});

	it('⛔ the forwarded codes are REAL — they are thrown by the files this module claims', () => {
		// Without this, `FORWARDED` above is just an assertion about itself: any invented code would
		// satisfy the union and render a catalog sentence for a refusal the backend cannot produce.
		const thrown = thrownCodes();
		for (const c of FORWARDED) expect([...thrown], `${c} is not thrown anywhere`).toContain(c);
		// Non-vacuity for the scan itself: it read BOTH files and it is NOT just echoing FORWARDED.
		// `storage_format_unknown` is a third code in `storage.ts` that this module deliberately does
		// NOT handle (it is thrown from inside `fetchConnector`, so the route wraps it as
		// `connector_test_failed` with the driver text) — its presence proves the regex really ran.
		expect([...thrown]).toContain('storage_format_unknown');
	});

	it('⛔ and the forwarding branch that carries them still exists', () => {
		// The premise of the two tests above. If this catch is ever changed to re-throw, `bad_config`
		// stops being a 200-with-a-code and becomes a 4xx that `errorText` owns instead — a different
		// module, and this file's cases become dead.
		const src = readFileSync(join(BACKEND, 'src', 'routes', 'connectors.ts'), 'utf8');
		expect(src).toContain('code: e.code');
	});

	it('⛔ every `bad_config` reason this module renders is a token the backend really emits', () => {
		// ⚠️ THIS IS THE HALF THAT ROTS. `reason` is a `details` field (see `backend/src/utils/http.ts`,
		// which documents the seam and counts eight sentences behind `bad_config`) — there is no
		// codegen, no shared package and no type tying these eight spellings to the throw sites. Get
		// one wrong by a character and the sub-switch never matches: the Dutch admin reads the English
		// `detail` forever, with every test in both projects green. Matching the bare LITERAL rather
		// than a `reason:` key on purpose — however the backend chooses to attach it (inline object,
		// helper, constant), the token itself has to appear in one of these two files.
		const src = THROW_SITES.map((f) => readFileSync(f, 'utf8')).join('\n');
		const missing = [...handledReasons()].filter((r) => !src.includes(`'${r}'`));
		expect(
			missing,
			'a `bad_config` reason is rendered here but never emitted by backend/src/datasets/connectors — ' +
				'either the spelling drifted or the backend half of this contract has not landed yet'
		).toEqual([]);
		// Non-vacuity: the eight really were scraped out of the nested switch, not an empty set.
		expect([...handledReasons()].sort()).toEqual([
			'absolute',
			'backslash',
			'dot_segment',
			'http_scheme',
			'key_escapes_bucket',
			'percent_escape',
			'postgres_scheme',
			'required'
		]);
	});

	it('⛔ every code a test endpoint emits has a case here', () => {
		const handled = handledCodes();
		const missing = [...backendCodes()].filter((c) => !handled.has(c));
		expect(
			missing,
			'a connection-test code exists in backend/src that this switch does not handle — results ' +
				'carrying it silently render the server’s English sentence'
		).toEqual([]);
	});

	it('⛔ and every catalog key this module NAMES actually resolves', () => {
		// Guards the gap between "the switch names a key" and "the key exists": a typo compiles fine
		// (a paraglide input is `NonNullable<unknown>`) and dies at render with a hard
		// `TypeError: m.x is not a function`, because paraglide compiles one function per key.
		//
		// ⚠️ SCANNED FROM THE `m.<key>(` CALLS, not from the case labels. It used to assert that every
		// handled CODE was a key, which was the same thing back when one code meant one sentence — it
		// is not any more: `bad_config` has no key of its own (its eight sentences are chosen by
		// `reason`, and a generic "your config is invalid" key would say less than the English it
		// replaces), while `bad_config_percent_escape` is a key that no case label spells. Reading the
		// call sites covers both directions and is strictly stronger than the old check.
		const en = JSON.parse(
			readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
		) as Record<string, unknown>;
		const keys = Object.keys(en);
		for (const k of referencedKeys()) expect(keys, `${k} has no catalog key`).toContain(k);
		// Non-vacuity: a scan that matched nothing would iterate an empty set and pass.
		// ⚠️ 29 → 33: the four `fr_license_*` keys. MEASURED off the scan, not incremented — this is
		// the same `m.<key>(` regex the assertion above runs, so a miscount here would silently weaken
		// the non-vacuity guard rather than fail.
		expect(referencedKeys().size).toBe(33);
		// …and the sixteen one-sentence codes ARE still keyed by their own name, which is the house
		// convention the eighteen `*-label` modules beside this one all follow.
		for (const code of handledCodes()) {
			if (FORWARDED.includes(code)) continue;
			expect(keys, `${code} has no catalog key`).toContain(code);
		}
	});

	it('⛔ the 200-OK contract itself is intact — these endpoints must NOT start throwing', () => {
		// The whole reason `errorText` never runs on this path, and therefore the whole reason this
		// module exists. If a future change makes a credential failure a 4xx, this file's premise
		// changes and someone must re-read it.
		const delivery = readFileSync(join(BACKEND, 'src', 'routes', 'delivery.ts'), 'utf8');
		expect(delivery).toContain('surfaced as ok:false rather than an HTTP error');
	});
});
