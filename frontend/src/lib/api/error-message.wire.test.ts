// src/lib/api/error-message.wire.test.ts — the localized refusal must survive THE REAL CLIENT.
//
// ⛔ THE DEFECT, MEASURED IN A REAL BROWSER. /ontology → "Entiteit toevoegen" → two attributes both
// named `auteur` → Opslaan rendered `Attribute 'auteur' is listed more than once` — in English, to a
// Dutch tenant — while the frontend suite was 2054 pass / 0 fail.
//
// About twenty `VALIDATION_MESSAGES` entries (./error-message) interpolate a value the backend puts
// on the wire in `details`: `{attribute}`, `{slug}`, `{sourceType}`, `{reason}`, `{limitMb}`.
// `writeErrorText` lifts it with `detailsOf(e)`. But `ApiError` HAD NO `details` FIELD, and every
// `unwrap` in this directory read `body.error` + `body.message` and dropped `body.details` on the
// floor. So `detailsOf()` was always `undefined`, every name-requiring entry took its `null` branch
// (correctly — it could not name the offender), and all twenty sentences fell through to the
// backend's English. The wire carried the value, the catalog asked for it, the class in between
// silently dropped it.
//
// ⛔ WHY 2054 GREEN TESTS SAW NONE OF IT, WHICH IS THE HALF THAT MATTERS HERE. `error-message.test.ts`
// proves the CATALOG's arithmetic by handing `writeErrorText` a hand-built object literal —
// `{ status: 400, code: 'duplicate_attribute', details: { attribute: 'auteur' } }` — a shape the real
// client could not produce. Those tests were green precisely BECAUSE they manufactured the field the
// product was dropping. A test that builds its own input cannot discover that nothing builds it.
//
// ⛔ SO THIS FILE NEVER CONSTRUCTS AN ERROR. Every case starts from a real `Response` with a real JSON
// body, pushes it through the REAL exported api method — hence through that module's own private
// `unwrap` — catches what the product actually throws, and hands THAT to `writeErrorText`. The only
// thing stubbed is `authFetch`, the one browser-only import in the chain.
//
// Four codes through four modules, chosen because their `unwrap`s differ STRUCTURALLY — a fix
// applied to one and not the rest has to red here:
//   · ontology.ts  → the shared one-line `unwrap`, `ApiError` imported from ./blocks (13 modules)
//   · blocks.ts    → the canonical class's OWN `unwrap`, the one where `details` sits at position 4
//                    and `findings` had to move to 5 (a positional slip lands the bag in `findings`)
//   · datasets.ts  → the shared one-line `unwrap` again, but a 400 whose value is not a name
//   · delivery.ts  → a SEPARATE `ApiError` class + `byReason`, which needs `details` TWICE (once to
//                    pick the sentence, once to fill it) — an empty bag there loses the whole choice
// The source scan at the bottom then closes the remaining sites exhaustively, so this stays honest
// when the twenty-first client is added.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ⛔ The ALIAS id `$lib/api/auth-fetch`, never a relative specifier — `mock-specifiers.test.ts`
// enforces it, and the relative form silently fails to apply (see llm-settings.test.ts's header).
// `authFetch` is the one browser-only import in these modules' chain; nothing else is stubbed,
// because everything else is what is being tested.
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as m from '$lib/paraglide/messages';
import { stripComments } from '$lib/test/source-scan';
import { writeErrorText } from './error-message';
import { ontologyApi } from './ontology';
import { blocksApi, ApiError } from './blocks';
import { templatesApi } from './templates';
import { datasetsApi } from './datasets';
import { deliveryApi } from './delivery';
import { llmSettingsApi } from './llm-settings';
import { adminApi } from './admin';

/**
 * ⛔ THE REAL CATALOG, NOT SENTINELS, AND THAT IS THE POINT OF THIS FILE.
 * `error-message.test.ts` mocks `$lib/paraglide/messages` so it can assert the MAPPING. Here the
 * expectation is built by CALLING the same catalog function the product calls, so the assertion is
 * "the product produced the catalog's sentence, with this value in it" — locale-independent, and
 * impossible to satisfy with an English fallback. `blocks.stream-tests-terminal.test.ts` uses the
 * real catalog the same way.
 */

/** `error-message.ts`'s `iso` — U+2068 FSI … U+2069 PDI around every foreign value. */
const iso = (v: string): string => `⁨${v}⁩`;

/** The caller's per-operation fallback. If it ever comes back, the error never reached the catalog. */
const FALLBACK = '__CALLER_FALLBACK__';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/**
 * Run a real api call that MUST reject, and return what it threw.
 *
 * ⚠️ The `throw` on the resolve path is not padding: if a future `unwrap` stopped throwing, every
 * `expect` below would be skipped and this file would go green having proved nothing.
 */
async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
	try {
		await call();
	} catch (e) {
		return e;
	}
	throw new Error('the api call RESOLVED — it must reject for this case to assert anything');
}

interface WireCase {
	/** The api module whose private `unwrap` this case drives. */
	module: string;
	/** The backend's `error` code. */
	code: string;
	status: number;
	/** The `details` bag exactly as the backend route emits it. */
	details: Record<string, unknown>;
	/** The one value out of that bag the localized sentence has to end up carrying. */
	value: string;
	/** The backend's English `message` — what a Dutch reader was getting instead. */
	english: string;
	/** The localized sentence, built by calling the catalog the product calls. */
	localized: () => string;
	/** The REAL exported api method, driven through its module's REAL `unwrap`. */
	call: () => Promise<unknown>;
}

const CASES: WireCase[] = [
	{
		// ontology-service.ts:722. THE ONE PROVEN IN THE BROWSER.
		module: 'ontology.ts',
		code: 'duplicate_attribute',
		status: 400,
		details: { attribute: 'auteur' },
		value: 'auteur',
		english: "Attribute 'auteur' is listed more than once",
		localized: () => m.error_duplicate_attribute({ attribute: iso('auteur') }),
		call: () =>
			ontologyApi.createEntity({
				scope: 'generic',
				name: 'boek',
				label: 'Boek',
				attributes: [
					{ name: 'auteur', type: 'string', synonyms: [], pii: false, description: null },
					{ name: 'auteur', type: 'string', synonyms: [], pii: false, description: null }
				]
			})
	},
	{
		// blocks/authoring-service.ts:165/:174 — a 409, so this also drives `writeErrorText`'s SECOND
		// catalog lookup (the conflict branch), not just the 400/422 one.
		module: 'blocks.ts',
		code: 'slug_taken',
		status: 409,
		details: { slug: 'pdf-parser' },
		value: 'pdf-parser',
		english: "A block with slug 'pdf-parser' already exists",
		localized: () => m.error_slug_taken({ slug: iso('pdf-parser') }),
		call: () => blocksApi.create({ slug: 'pdf-parser', name: 'PDF Parser', category: 'data' })
	},
	{
		// parse/index.ts:68.
		module: 'datasets.ts',
		code: 'unknown_source_type',
		status: 400,
		details: { sourceType: 'parquet' },
		value: 'parquet',
		english: "unknown source type 'parquet'",
		localized: () => m.error_unknown_source_type({ sourceType: iso('parquet') }),
		call: () => datasetsApi.paste({ name: 'Boeken', sourceType: 'csv', content: 'a,b\n1,2' })
	},
	{
		// datasets/connectors/index.ts:168 — `byReason`. `details` is read TWICE here: `reason` picks
		// the sentence, `field` fills it. With an empty bag `byReason` returns null on the FIRST read,
		// so this case cannot pass by accident on a half-forwarded bag.
		module: 'delivery.ts',
		code: 'bad_config',
		status: 400,
		details: { reason: 'required', field: 'baseUrl' },
		value: 'baseUrl',
		english: "baseUrl is required",
		localized: () => m.bad_config_required({ field: iso('baseUrl') }),
		call: () => deliveryApi.create({ kind: 'jira', name: 'Jira' })
	}
	// (The `licences_tenant_exists` case left with adoption — A2: CP registers its own licences
	// tenant, so that refusal no longer exists.)
];

beforeEach(() => {
	authFetch.mockReset();
});

describe('a refusal localized through the REAL client, not a hand-built error', () => {
	for (const c of CASES) {
		it(`${c.module}: \`${c.code}\` reaches the catalog with its interpolated value`, async () => {
			authFetch.mockResolvedValue(
				jsonResponse(c.status, { error: c.code, message: c.english, details: c.details })
			);

			const err = await thrownBy(c.call);
			const text = writeErrorText(err, FALLBACK);

			// The whole defect in one line: the localized sentence, carrying the value off the wire.
			expect(text).toBe(c.localized());
			// And the three ways it used to come out wrong instead.
			expect(text).not.toBe(c.english);
			expect(text).not.toBe(FALLBACK);
			// The value itself, bidi-isolated, really is inside the rendered sentence.
			expect(text).toContain(iso(c.value));
		});

		it(`${c.module}: \`${c.code}\` on an OLD POD (no \`details\`) still lands on the backend sentence`, async () => {
			// ⛔ THE MID-ROLL HALF, AND IT MUST KEEP WORKING. The browser reaches the API through the
			// Service, so a new bundle really is answered by an old pod that ships the code with NO
			// details bag. `ValidationCopy`'s `null` contract sends that reader to the English
			// sentence — which still NAMES the offender — rather than to an anonymous localized one or
			// to the caller's generic fallback. A "fix" that localized anonymously would pass the test
			// above and fail this one.
			authFetch.mockResolvedValue(jsonResponse(c.status, { error: c.code, message: c.english }));

			const err = await thrownBy(c.call);
			const text = writeErrorText(err, FALLBACK);

			expect(text).toBe(c.english);
			expect(text).not.toBe(c.localized());
			expect(text).not.toBe(FALLBACK);
		});
	}
});

describe('the `details` guard: only a real bag is forwarded', () => {
	// ⚠️ A 4xx body is whatever the far end sent. `error-message.ts`'s `detailStr` INDEXES the bag by
	// field name, so a `details` that is a STRING would answer `details['0']` with a character and an
	// ARRAY answers every numeric key — neither is a details bag, and forwarding either would put
	// junk inside a Dutch sentence. `detailsFrom` (./parse) rejects both, which lands the reader on
	// the English sentence: the same honest degradation as the old-pod case.
	for (const [label, bad] of [
		['a string', 'auteur'],
		['an array', ['auteur']],
		['null', null],
		['a number', 7]
	] as const) {
		it(`${label} \`details\` is refused, and the reader gets the backend sentence`, async () => {
			const english = "Attribute 'auteur' is listed more than once";
			authFetch.mockResolvedValue(
				jsonResponse(400, { error: 'duplicate_attribute', message: english, details: bad })
			);

			const err = await thrownBy(() =>
				ontologyApi.createEntity({ scope: 'generic', name: 'boek', label: 'Boek' })
			);

			expect((err as { details?: unknown }).details).toBeUndefined();
			expect(writeErrorText(err, FALLBACK)).toBe(english);
		});
	}
});

describe('every client in this directory forwards `details` — exhaustively', () => {
	// ⛔ FOUR SAMPLED MODULES CANNOT PROVE TWENTY. The defect's shape was "N near-identical private
	// `unwrap`s, each its own copy", so the failure mode of the FIX is exactly the failure mode of the
	// original: one of them not updated, or a twenty-first client added later from an old template.
	// The cases above prove the mechanism end to end on four; this proves the population.
	//
	// ⚠️ COMMENTS ARE STRIPPED FIRST (`source-scan.ts`) — this file and ./blocks both QUOTE
	// `new ApiError(` in prose, and a raw-text scan would count those and then demand a `detailsFrom`
	// inside a sentence. See that module's header for the five measured evasions this closes.
	const API_DIR = fileURLToPath(new URL('.', import.meta.url));

	/**
	 * The construction sites that legitimately forward NO bag, keyed by a literal unique to the call.
	 *
	 * ⛔ AN ENTRY HERE IS A CLAIM, NOT A PARKING SPACE — the same rule `NOT_LOCALIZED_CODES` states in
	 * ./error-message. Both are cases where there IS no body to lift a bag from, which is a different
	 * fact from "we did not get to it yet".
	 */
	const EXEMPT: { needle: string; why: string }[] = [
		{
			needle: "'invalid_json'",
			why: 'admin.ts: this branch fires BECAUSE the 2xx body did not parse — there is no bag.'
		},
		{
			needle: "'tool-result failed (no response)'",
			why: 'agent.ts: every attempt failed at the network layer — there was no response at all.'
		}
	];

	/** Every `new …ApiError(…)` call in a source file, comments stripped, paren-balanced. */
	function errorConstructions(src: string): string[] {
		const stripped = stripComments(src);
		const out: string[] = [];
		const re = /new [A-Za-z]*ApiError\(/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(stripped)) !== null) {
			let depth = 0;
			let i = match.index + match[0].length - 1;
			for (; i < stripped.length; i++) {
				if (stripped[i] === '(') depth++;
				else if (stripped[i] === ')' && --depth === 0) break;
			}
			out.push(stripped.slice(match.index, i + 1));
		}
		return out;
	}

	const files = readdirSync(API_DIR)
		.filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
		.sort();

	it('finds the client modules it means to scan (the scan is not vacuously empty)', () => {
		// A typo'd directory or a stricter filter would make every assertion below pass over nothing.
		const withErrors = files.filter((f) => errorConstructions(readFileSync(join(API_DIR, f), 'utf8')).length > 0);
		expect(withErrors).toContain('ontology.ts');
		expect(withErrors).toContain('blocks.ts');
		expect(withErrors).toContain('agent.ts');
		expect(withErrors.length).toBeGreaterThanOrEqual(20);
	});

	it('constructs no ApiError that drops the `details` bag', () => {
		const offenders: string[] = [];
		for (const file of files) {
			const src = readFileSync(join(API_DIR, file), 'utf8');
			for (const call of errorConstructions(src)) {
				if (EXEMPT.some((e) => call.includes(e.needle))) continue;
				// `detailsFrom(body)` is the shared guard; runs.ts/solutions.ts merge `body?.details`
				// into their own typed bags, and `details,` is agent.ts's destructured forward.
				const forwards =
					call.includes('detailsFrom(') || call.includes('body?.details') || /\bdetails,?\s*\)/.test(call);
				if (!forwards) offenders.push(`${file}: ${call.split('\n')[0].trim()}…`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * ⛔ THE `findings` HALF, AND IT IS PINNED AS AN EXACT SET RATHER THAN A UNIVERSAL RULE.
	 *
	 * `templates.ts` constructed the canonical `ApiError` (imported from ./blocks, which declares
	 * `findings` at position 5) with only FOUR arguments, so `err.findings` was permanently
	 * `undefined` on that client. The `details` check above cannot see it — it asks a different
	 * question — and every render test `vi.mock`s `$lib/api/templates`, so nothing drove that
	 * `unwrap` at all. Removing the argument left 1083 tests green.
	 *
	 * ⚠️ WHY NOT "EVERY ApiError MUST FORWARD findings", WHICH IS WHAT THE `details` RULE ABOVE DOES.
	 * Because it would assert something this scan cannot see. `details` is universal — every route
	 * can carry a bag — but `findings` is emitted by exactly two backend throws (`lint_failed` in
	 * blocks/source-gate.ts:75 + blocks/authoring-service.ts:345, and `derived_lint_failed` in
	 * ontology/data-block-derivation.ts:147). Whether a given client can RECEIVE one is a property of
	 * the backend routes its methods call, and this scraper reads frontend text only — it has no way
	 * to compute that. Demanding the argument from all eighteen constructions would make sixteen
	 * files carry a forward for a payload their routes provably never send: cargo-cult, and a rule
	 * that is false is worse than no rule. Hand-listing the two would be the register antipattern.
	 *
	 * So the invariant is the SET ITSELF. Any drift — a third client starting to forward findings, or
	 * either of these two dropping it — changes the set and reds here, which forces a human to
	 * re-derive the mapping instead of letting it rot silently. Same technique as the pinned counts in
	 * `connection-test-label.test.ts`.
	 */
	it('⛔ exactly the two findings-bearing clients forward `body?.findings`', () => {
		const forwarding = files
			.filter((f) => errorConstructions(readFileSync(join(API_DIR, f), 'utf8'))
				.some((call) => /\bbody\?\.findings\b/.test(call)))
			.sort();
		expect(
			forwarding,
			'The set of api clients forwarding `body?.findings` into ApiError changed.\n' +
				'· A file DISAPPEARED → that client silently drops the lint/scan payload, exactly the ' +
				'defect this test was written for. `err.findings` is now permanently undefined there ' +
				'and no render test can see it, because they all vi.mock the client.\n' +
				'· A file APPEARED → fine, but say WHY here: which backend throw sends it findings? ' +
				'Only lint_failed (blocks/source-gate.ts:75, blocks/authoring-service.ts:345) and ' +
				'derived_lint_failed (ontology/data-block-derivation.ts:147) carry them.'
		).toEqual(['blocks.ts', 'templates.ts']);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `findings`: the FIFTH argument, through the real client.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// ⛔ WHY THIS DRIVES THE REAL `unwrap` AND NEVER HAND-BUILDS AN `ApiError`. That is the whole lesson
// of this file's header: a test that constructs its own input cannot discover that nothing
// constructs it. `new ApiError(422, 'lint_failed', msg, {}, findings)` would pass with `templates.ts`
// still dropping the argument, because the test would be supplying the very field the product omits.
//
// ⚠️ THE BODY SHAPE IS THE BACKEND'S, NOT AN INVENTED ONE. `utils/http.ts:161-168` answers an
// `HttpError` with `{ error, message, details: err.details ?? {}, ...(err.details ?? {}) }` — the bag
// is nested under `details` AND spread at top level for backwards compatibility. `blocks.ts:83` reads
// the TOP-LEVEL `body?.findings`; `error-message.ts:397` reads the NESTED `details.findings`. Both
// are present here because both are on the wire, and a fixture carrying only one would let a client
// that reads the other look correct.
describe('the lint `findings` payload survives the real client', () => {
	const FINDINGS = [
		{ source: 'scan', rule: 'banned-import', message: "import of 'node:fs' is not allowed", line: 3, spec: 'node:fs' },
		{ source: 'scan', rule: 'no-require', message: 'require() is not available', line: 11 }
	];

	/** Exactly what `unprocessable('lint_failed', …, { findings })` puts on the wire. */
	const lintBody = {
		error: 'lint_failed',
		message: 'Block failed lint',
		details: { findings: FINDINGS },
		findings: FINDINGS
	};

	it('⛔ templates.ts — save-as-template keeps `err.findings` (it was dropping the 5th argument)', async () => {
		// `templatesApi.create` → POST /api/templates → routes/templates.ts:70 `createRoute` →
		// templates-service.ts:186 `assertBlockSourceSafe(input.source_ts ?? '')`, BEFORE the insert.
		// So a lint refusal on this exact call is real, not hypothetical.
		authFetch.mockResolvedValue(jsonResponse(422, lintBody));

		const err = await thrownBy(() =>
			templatesApi.create({
				name: 'pdf-parser',
				label: 'PDF Parser',
				category: 'data',
				source_ts: "import 'node:fs';"
			} as never)
		);

		expect(err).toBeInstanceOf(ApiError);
		const e = err as InstanceType<typeof ApiError>;
		expect(e.status).toBe(422);
		expect(e.code).toBe('lint_failed');
		// ⛔ THE LINE THAT REDS WHEN THE 5TH ARGUMENT IS REMOVED.
		expect(e.findings, 'templates.ts dropped the 5th `findings` argument').toBeDefined();
		expect(e.findings).toHaveLength(2);
		expect(e.findings![0]!.rule).toBe('banned-import');
		expect(e.findings![1]!.rule).toBe('no-require');
		// `details` is a SEPARATE field and must not be cannibalised by the new argument — the
		// positional-slip failure the ApiError docblock warns about (details at 4, findings at 5).
		expect(e.details).toEqual({ findings: FINDINGS });
	});

	it('blocks.ts — the reference client behaves identically, so the two cannot diverge', async () => {
		// The pattern `templates.ts` was supposed to copy (blocks.ts:83). Asserted here so "fix
		// templates by matching blocks" stays a true statement in both directions.
		authFetch.mockResolvedValue(jsonResponse(422, lintBody));

		const err = await thrownBy(() =>
			blocksApi.create({ slug: 'pdf-parser', name: 'PDF Parser', category: 'data' })
		);

		const e = err as InstanceType<typeof ApiError>;
		expect(e.findings).toBeDefined();
		expect(e.findings).toHaveLength(2);
		expect(e.findings![0]!.rule).toBe('banned-import');
	});

	it('⚠️ MID-ROLL — an old pod with no `findings` leaves the field undefined, never throws', async () => {
		// The consumer guards on `&& e.findings` (routes/block-edit/+page.svelte:580/:614/:687), so
		// `undefined` is the contract for "this pod did not send them", not a bug. A forward that
		// invented `[]` would make that guard take the wrong branch and show an empty findings panel.
		authFetch.mockResolvedValue(
			jsonResponse(422, { error: 'lint_failed', message: 'Block failed lint' })
		);

		const err = await thrownBy(() =>
			templatesApi.create({ name: 'x', label: 'X', category: 'data' } as never)
		);

		const e = err as InstanceType<typeof ApiError>;
		expect(e.code).toBe('lint_failed');
		expect(e.findings).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DISCRIMINATED HALF: one code, several sentences, chosen by the bag.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// ⛔ THE CASES ABOVE CANNOT CATCH THE DEFECT THIS BLOCK IS FOR. They prove a bag reaches the catalog
// and a value lands in the sentence. The tenant-admin lane's codes fail differently: `code` alone is
// COARSER than the English it replaces — `delivery_target_incomplete` is five backend sentences and
// `delivery_target_credentials_invalid` is six, all re-thrown by the same
// `unprocessable(err.code, err.message)` — so an implementation that ignored the bag entirely and
// returned one generic localized sentence would pass a `toBe(localized())` assertion written against
// that generic sentence, look green, and ship a strict DOWNGRADE from the English. What has to be
// asserted is that DIFFERENT bags produce DIFFERENT sentences, and the arms below are compared
// against each other for exactly that.
//
// ⛔ AND THE THIRD BRANCH, WHICH IS WHERE THE HONESTY IS. The bag is new; the pods are not. Each case
// also runs with NO `details` at all (an old pod mid-roll) and with an UNRECOGNISED `kind` (a fourth
// connector shipped backend-first), and both must land on the backend's English sentence — never on
// an anonymous localized one, and never on `deliveryKindLabel`'s Jira default, which would tell an
// Azure DevOps admin their ATLASSIAN JIRA connector is broken.

interface DiscriminatedCase {
	module: string;
	code: string;
	status: number;
	/** The backend's English `message` — one of the several this code carries. */
	english: string;
	/** The REAL exported api method, driven through its module's REAL `unwrap`. */
	call: () => Promise<unknown>;
	/** Each wire bag and the sentence it must select. Compared against each other for distinctness. */
	arms: { details: Record<string, unknown>; localized: () => string }[];
	/** Bags that must NOT resolve to any localized sentence (unknown discriminator, foreign kind). */
	unrecognised?: Record<string, unknown>[];
}

const JIRA = () => m.delivery_kind_jira();
const ADO = () => m.delivery_kind_azure_devops();
const FR = () => m.delivery_kind_fr();

const forward = () => deliveryApi.forward('11111111-1111-1111-1111-111111111111', 'tgt-1');
const retry = () => deliveryApi.retry('11111111-1111-1111-1111-111111111111', 'del-1');

const DISCRIMINATED: DiscriminatedCase[] = [
	{
		// host/delivery/{jira.ts:133,136, azure-devops.ts:149,155, fr.ts:93} → routes/delivery.ts:428.
		// FIVE English sentences behind one code; `field` is what picks between the two the reader can
		// act on, and it names the CONNECTOR FORM's box, not the vendor's noun (ADO's "organization
		// URL" is the same `base_url` input labelled "Base URL").
		module: 'delivery.ts',
		code: 'delivery_target_incomplete',
		status: 422,
		english: 'This Azure DevOps connector is missing its organization URL',
		call: forward,
		arms: [
			{
				details: { kind: 'jira', field: 'base_url' },
				localized: () => m.delivery_error_incomplete_base_url({ tool: JIRA() })
			},
			{
				details: { kind: 'jira', field: 'project_key' },
				localized: () => m.delivery_error_incomplete_project_key({ tool: JIRA() })
			},
			{
				details: { kind: 'azure_devops', field: 'base_url' },
				localized: () => m.delivery_error_incomplete_base_url({ tool: ADO() })
			},
			{
				// ⚠️ NO `field`, WHICH IS NOT THE SAME ABSENCE AS NO BAG. A pod that carries `kind` but
				// not `field` still lets the browser name the TOOL, so it gets the code-granular
				// sentence the delivery-ledger column has always used — better than English, worse than
				// the arms above, and the exact middle branch `deliveryRefusalCopy` documents.
				details: { kind: 'fr' },
				localized: () => m.delivery_error_target_incomplete({ tool: FR() })
			}
		],
		unrecognised: [{ kind: 'gitlab', field: 'base_url' }, { field: 'base_url' }]
	},
	{
		// host/delivery/{jira.ts:108,116, azure-devops.ts:123,130, fr.ts:70,77}. SIX English sentences,
		// two causes: the ciphertext would not decrypt, or it decrypted to the wrong shape.
		module: 'delivery.ts',
		code: 'delivery_target_credentials_invalid',
		status: 422,
		english: 'Jira credentials must include a non-empty {email, apiToken}',
		call: retry,
		arms: [
			{
				details: { kind: 'jira', reason: 'undecryptable' },
				localized: () => m.delivery_error_credentials_undecryptable({ tool: JIRA() })
			},
			{
				details: { kind: 'jira', reason: 'malformed' },
				localized: () => m.delivery_error_credentials_malformed({ tool: JIRA() })
			},
			{
				details: { kind: 'azure_devops', reason: 'undecryptable' },
				localized: () => m.delivery_error_credentials_undecryptable({ tool: ADO() })
			},
			{
				details: { kind: 'fr' },
				localized: () => m.delivery_error_credentials_invalid({ tool: FR() })
			}
		],
		unrecognised: [{ kind: 'gitlab', reason: 'malformed' }, { reason: 'malformed' }]
	},
	{
		// jira.ts:99, azure-devops.ts:114, fr.ts:61 — one sentence per KIND and nothing finer to say.
		module: 'delivery.ts',
		code: 'delivery_target_credentials_missing',
		status: 422,
		english: 'This fr connector has no stored license token',
		call: forward,
		arms: [
			{ details: { kind: 'jira' }, localized: () => m.delivery_error_credentials_missing({ tool: JIRA() }) },
			{ details: { kind: 'azure_devops' }, localized: () => m.delivery_error_credentials_missing({ tool: ADO() }) },
			{ details: { kind: 'fr' }, localized: () => m.delivery_error_credentials_missing({ tool: FR() }) }
		],
		unrecognised: [{ kind: 'gitlab' }]
	},
	{
		// host/egress-guard.ts → routes/delivery.ts:452, where `{ kind: target.kind }` is added because
		// the guard itself is shared with the connector-refresh path and knows nothing about connectors.
		module: 'delivery.ts',
		code: 'egress_bad_target',
		status: 422,
		english: 'not a valid egress target',
		call: forward,
		arms: [
			{ details: { kind: 'azure_devops' }, localized: () => m.delivery_error_egress_bad_target({ tool: ADO() }) },
			{ details: { kind: 'fr' }, localized: () => m.delivery_error_egress_bad_target({ tool: FR() }) }
		],
		unrecognised: [{ kind: 'gitlab' }]
	},
	{
		// routes/llm-settings.ts:152 — TWO sentences, and they are not paraphrases: `vendor_changed`
		// means a key IS stored and is being deliberately refused for this vendor.
		module: 'llm-settings.ts',
		code: 'api_key_required',
		status: 400,
		english: "Provider 'OpenAI' requires an API token.",
		call: () => llmSettingsApi.update({ provider: 'openai', model: 'gpt-5' }),
		arms: [
			{
				details: { provider: 'OpenAI', reason: 'missing' },
				localized: () => m.error_api_key_required({ provider: iso('OpenAI') })
			},
			{
				details: { provider: 'OpenAI', reason: 'vendor_changed' },
				localized: () => m.error_api_key_required_vendor_changed({ provider: iso('OpenAI') })
			}
		],
		// A `reason` this build has never heard of, and a bag with the reason but no provider to name.
		unrecognised: [{ provider: 'OpenAI', reason: 'revoked' }, { reason: 'missing' }]
	},
	{
		// routes/llm-settings.ts:91 — BOTH fields or nothing: "does not offer the model" with either
		// side missing names no problem at all.
		module: 'llm-settings.ts',
		code: 'invalid_model',
		status: 400,
		english: "Model 'gpt-9' is not offered by provider 'Anthropic'.",
		call: () => llmSettingsApi.update({ provider: 'anthropic', model: 'gpt-9' }),
		arms: [
			{
				details: { model: 'gpt-9', provider: 'Anthropic' },
				localized: () => m.error_invalid_model({ model: iso('gpt-9'), provider: iso('Anthropic') })
			}
		],
		unrecognised: [{ model: 'gpt-9' }, { provider: 'Anthropic' }]
	}
];

describe('a code with SEVERAL backend sentences picks the right one off the bag', () => {
	for (const c of DISCRIMINATED) {
		it(`${c.module}: \`${c.code}\` — each bag selects its own sentence, and they differ`, async () => {
			const rendered: string[] = [];
			for (const arm of c.arms) {
				authFetch.mockResolvedValue(
					jsonResponse(c.status, { error: c.code, message: c.english, details: arm.details })
				);
				const text = writeErrorText(await thrownBy(c.call), FALLBACK);
				expect(text, `bag ${JSON.stringify(arm.details)}`).toBe(arm.localized());
				expect(text).not.toBe(c.english);
				expect(text).not.toBe(FALLBACK);
				rendered.push(text);
			}
			// ⛔ THE ASSERTION THAT KILLS THE "ONE GENERIC SENTENCE" IMPLEMENTATION. Every arm above
			// would still pass individually if the catalog collapsed them; only this sees it.
			expect(new Set(rendered).size, `arms collapsed onto the same sentence: ${rendered.join(' | ')}`).toBe(
				c.arms.length
			);
		});

		it(`${c.module}: \`${c.code}\` on an OLD POD (no bag) falls back to the backend sentence`, async () => {
			authFetch.mockResolvedValue(jsonResponse(c.status, { error: c.code, message: c.english }));
			const text = writeErrorText(await thrownBy(c.call), FALLBACK);
			expect(text).toBe(c.english);
			expect(text).not.toBe(FALLBACK);
			for (const arm of c.arms) expect(text).not.toBe(arm.localized());
		});

		it(`${c.module}: \`${c.code}\` with an UNRECOGNISED discriminator falls back too`, async () => {
			for (const details of c.unrecognised ?? []) {
				authFetch.mockResolvedValue(
					jsonResponse(c.status, { error: c.code, message: c.english, details })
				);
				const text = writeErrorText(await thrownBy(c.call), FALLBACK);
				expect(text, `bag ${JSON.stringify(details)}`).toBe(c.english);
				for (const arm of c.arms)
					expect(text, `bag ${JSON.stringify(details)} must not resolve to an arm`).not.toBe(arm.localized());
			}
		});
	}

	it('⛔ the case list really covers the delivery family (the loop is not vacuous)', () => {
		// A `DISCRIMINATED` that lost its delivery entries would leave every assertion above passing
		// over the two llm/admin cases and prove nothing about the bag this lane added to the backend.
		const codes = DISCRIMINATED.map((c) => c.code);
		for (const required of [
			'delivery_target_incomplete',
			'delivery_target_credentials_invalid',
			'delivery_target_credentials_missing',
			'egress_bad_target'
		])
			expect(codes, `${required} has no wire case`).toContain(required);
		expect(DISCRIMINATED.flatMap((c) => c.arms).length).toBeGreaterThanOrEqual(16);
	});
});
