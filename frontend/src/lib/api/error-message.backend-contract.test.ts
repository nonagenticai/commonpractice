// src/lib/api/error-message.backend-contract.test.ts — the ITEM 11 guard.
//
// `HttpError.code` is a bare `string` on the backend (backend/src/utils/http.ts); the frontend's
// `ForbiddenCode` union (error-message.ts) is a CONVENTION, not an enforced contract — nothing stops
// someone renaming/adding a 403 code on the backend without touching the frontend. Today that is a
// silent degradation: the code falls through `licenseOrPermissionMessage`'s `known` check to the
// generic "You don't have permission to do that.", with NO build failure and NO test failure. This
// test converts that into a red test.
//
// There is no monorepo/shared-types mechanism to lean on here: backend/ and frontend/ are two
// separate Bun projects (separate package.json, separate node_modules, no workspaces field, no
// codegen step between them — verified 2026-07-30, see the session handoff). Inventing a build step
// or a shared package for this one contract would be a bigger change than the problem warrants, so
// instead this test walks BACKEND SOURCE TEXT on disk (plain `fs`, no backend runtime import — this
// is a frontend vitest project and importing backend code here would drag in its own toolchain) and
// diffs the codes it finds against the frontend's `KNOWN_FORBIDDEN_CODES` runtime mirror of
// `ForbiddenCode`. It lives in the FRONTEND tree (not backend, not some third location) because
// `error-message.ts` — the thing being guarded — lives here too, and vitest's node environment can
// read `../../../../backend/src` from disk just as easily as it reads its own tree; a backend-side
// test would need the same disk-reading trick in the other direction for no added benefit.
//
// This only catches codes reached via the two ways the backend actually raises a 403
// (`forbidden(code, …)` and a direct `new HttpError(403, code, …)` — verified by grep 2026-07-30
// that no other pattern is used). A change to how 403s are raised backend-side should update the
// regexes below.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative } from 'node:path';
import {
	KNOWN_FORBIDDEN_CODES,
	KNOWN_LICENSE_CODES,
	KNOWN_SERVICE_UNAVAILABLE_CODES,
	KNOWN_SUBMIT_REFUSAL_CODES,
	NON_SUBMIT_PATH_CODES,
	NOT_LOCALIZED_CODES,
	VALIDATION_MESSAGE_CODES
} from './error-message';
import { LICENSE_BLOCK_CODES } from '$lib/stores/licenseGate.svelte';

const BACKEND_SRC = fileURLToPath(new URL('../../../../backend/src', import.meta.url));

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...listTsFiles(p));
		else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(p);
	}
	return out;
}

/**
 * TypeScript source with `//` and block comments removed (string/template literals preserved).
 *
 * ⛔ REQUIRED, NOT COSMETIC. This codebase documents wire codes by quoting the CALL that emits them
 * — `middleware/license-gate.ts`'s deploy-ordering note literally contains
 * `paymentRequired('license_unreadable', …)` in prose. A scraper that reads comments therefore
 * reports codes the backend does not emit, and the fix under pressure is always to mangle the
 * comment rather than the scraper: the guard starts editing the documentation it depends on.
 *
 * A single-pass character scanner rather than a regex, because a regex that strips `//…` cannot
 * tell a comment from the `//` inside `'https://licenses.example.com/…'` — of which there are many.
 *
 * ⚠️ NEWLINES SURVIVE, COMMENT TEXT DOES NOT. Line NUMBERS in the stripped text therefore still
 * match the file on disk, which the /build submit-path scrape below relies on to report `file:line`
 * for every code it finds — and a failure message pointing at the wrong line is worse than none.
 * (Columns do shift; nothing reads them.) The `//` branch already had this property by accident
 * because it stops AT the newline and lets the main loop append it; the block-comment branch had to
 * be taught it.
 */
function stripComments(src: string): string {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		const next = src[i + 1];
		if (c === '/' && next === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && next === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
				if (src[i] === '\n') out += '\n';
				i++;
			}
			i += 2;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			out += c;
			i++;
			while (i < src.length) {
				if (src[i] === '\\') {
					out += src[i]! + (src[i + 1] ?? '');
					i += 2;
					continue;
				}
				out += src[i];
				if (src[i] === quote) {
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * A character class matching any of the three JS quote characters.
 *
 * ⛔⛔ THE NON-SINGLE HALVES ARE A MEASURED HOLE, NOT DEFENSIVE PROGRAMMING. The 403 and 402 scrapes
 * below used to read `'([a-zA-Z0-9_]+)'` only. Measured 2026-08-16, each of these left ALL SIXTEEN
 * assertions in this file GREEN with an uncatalogued wire code shipped from the backend:
 *   • `forbidden("platform_owner_required", …)`   → degrades to the generic "no permission" copy;
 *   • `new HttpError(403, "region_locked", …)`     → same;
 *   • `paymentRequired("license_suspended", …)`    → NO BLOCK SCREEN AT ALL (see the 402 note below).
 * There is NO prettier and NO eslint config anywhere in this repo, so nothing normalises quote style
 * in `backend/` and a double-quoted literal is an ordinary thing for the next author to write. This
 * is the same hole `graph-issue-label.backend-contract.test.ts` documents on its `quotedLiterals`,
 * and the same one `literalOrUnresolved` below already closed for the 400/422/409 half.
 *
 * ⚠️ A BACKTICK IS ACCEPTED HERE ONLY BECAUSE THE CODE CLASS IS `[a-zA-Z0-9_]+`: a real template
 * literal (`` `tpl_${x}` ``) contains `$`/`{`/`}` and so cannot match, and therefore cannot be
 * mistaken for a resolved literal. `literalOrUnresolved` further down is deliberately NOT given the
 * backtick for exactly that reason — see the note there.
 */
const ANY_QUOTE = '[\'"`]';

/** The 403 codes in one chunk of comment-stripped backend source. */
function forbiddenCodesInText(text: string): string[] {
	const out: string[] = [];
	// `forbidden('code', …)` — the normal path (backend/src/utils/http.ts helper). `\s` spans the
	// multi-line calls (`forbidden(\n  'code',\n  '…',\n)`) that dot-all wouldn't be needed for.
	for (const m of text.matchAll(new RegExp(`forbidden\\(\\s*(${ANY_QUOTE})([a-zA-Z0-9_]+)\\1`, 'g')))
		out.push(m[2]!);
	// `new HttpError(403, 'code', …)` — a direct bypass of the helper. This is NOT hypothetical:
	// services/user-service.ts's `user_offboarded` check does exactly this, and it is the reason
	// this regex exists as a second pattern rather than trusting `forbidden(` alone.
	for (const m of text.matchAll(
		new RegExp(`new\\s+HttpError\\(\\s*403\\s*,\\s*(${ANY_QUOTE})([a-zA-Z0-9_]+)\\1`, 'g')
	))
		out.push(m[2]!);
	// ⛔ `super(403, 'code', …)` — A SUBCLASS OF `HttpError`, WHICH THE TWO RULES ABOVE ARE BLIND TO,
	// AND THE BLINDNESS WAS MEASURED RATHER THAN IMAGINED. `services/byo-posture.ts`'s
	// `TenantByoKeyRequiredError extends HttpError` raises `llm_byo_key_required` this way: it is
	// neither a `forbidden(` call nor a `new HttpError(403,` one, so before this rule the code
	// shipped on the wire with all sixteen assertions in this file green — the exact failure the
	// `ANY_QUOTE` note records for the double-quoted spelling, in a different disguise.
	//
	// ⚠️ THIS FILE'S OWN HEADER ALREADY ASKED FOR THIS: "A change to how 403s are raised
	// backend-side should update the regexes below." A named error class IS a change to how they
	// are raised, and it is the one shape a reader is most likely to reach for next — an error you
	// can `instanceof` is better code than a bare helper call, so the guard has to follow it there
	// rather than making the better shape the invisible one.
	//
	// ⚠️ A FALSE POSITIVE HERE IS CHEAP AND LOUD. The worst case is a class whose first two
	// constructor arguments happen to be `403, 'something'`, which would demand copy for a code
	// nothing emits — caught immediately, by a human, on the first run. The reverse (a real wire
	// code that nothing scrapes) is silent for months. That asymmetry is why the rule is broad.
	for (const m of text.matchAll(
		new RegExp(`super\\(\\s*403\\s*,\\s*(${ANY_QUOTE})([a-zA-Z0-9_]+)\\1`, 'g')
	))
		out.push(m[2]!);
	return out;
}

/** Every 403 code the backend can actually emit, scraped from source text. */
function backendForbiddenCodes(): Set<string> {
	const codes = new Set<string>();
	for (const file of listTsFiles(BACKEND_SRC)) {
		for (const c of forbiddenCodesInText(stripComments(readFileSync(file, 'utf-8')))) codes.add(c);
	}
	return codes;
}

describe('every backend 403 code has frontend localized copy', () => {
	it('is a member of KNOWN_FORBIDDEN_CODES (else it silently degrades to the generic message)', () => {
		const backendCodes = backendForbiddenCodes();
		// Sanity: the scrape itself must find something, or this test would pass vacuously if the
		// backend tree moved/renamed and the regexes stopped matching anything.
		expect(backendCodes.size).toBeGreaterThan(5);
		// ⛔ ONE NAMED ANCHOR FOR THE `super(403, …)` SHAPE, for the reason the 503 describe spells
		// out in full: a bare count cannot tell WHICH of the three rules died. Delete that rule and
		// `backendCodes.size` barely moves, while a real wire code goes uncatalogued in silence.
		// Anchored to its only site today — backend/src/services/byo-posture.ts,
		// `TenantByoKeyRequiredError`. If that class is ever deleted, delete this anchor WITH it
		// rather than loosening it to get green.
		expect(
			[...backendCodes],
			'shape 3 — super(403, …) in an HttpError subclass: backend/src/services/byo-posture.ts'
		).toContain('llm_byo_key_required');

		const known = new Set<string>(KNOWN_FORBIDDEN_CODES);
		const missing = [...backendCodes].filter((c) => !known.has(c)).sort();

		expect(
			missing,
			missing.length
				? `Backend emits 403 code(s) ${JSON.stringify(missing)} with no entry in error-message.ts's ` +
						`FORBIDDEN_MESSAGES/ForbiddenCode — they degrade to the generic "Forbidden" copy. ` +
						`Add each to ForbiddenCode + FORBIDDEN_MESSAGES (frontend/src/lib/api/error-message.ts) ` +
						`and to every locale catalog (frontend/messages/*.json).`
				: undefined
		).toEqual([]);
	});
});

// ── the 402 half, which had no guard at all ──────────────────────────────────────────────────
//
// ⛔ THE OMISSION THAT MADE A ONE-SIDED LICENCE DEPLOY LOOK SHIPPABLE.
// The scrape above covers only `forbidden(…)` and `new HttpError(403, …)`. Gate 2's 402 codes are
// raised with `paymentRequired(…)` and were scraped by NOTHING — so a backend commit could add a
// brand-new 402 code with no frontend counterpart and every test in both projects stayed green.
//
// That is strictly worse than the 403 case, because a 403 degrades to generic copy while an unknown
// 402 degrades to NO BLOCK SCREEN: `auth-fetch`'s interceptor fires only on
// `isLicenseBlockResponse` = 402 ∧ code ∈ LICENSE_BLOCK_CODES. An unrecognised code fails that test,
// `licenseGate.handleForbidden` is never called, `isBlocked` stays false — and every screen instead
// renders the 402 through `licenseOrPermissionMessage`'s `default`: "Your workspace doesn't have an
// active Common Practice license. Contact your administrator." A paying customer, accused, with no
// block screen and no way back. Measured against a real `402 {"error":"license_unreadable"}`.
//
// So the contract has TWO halves and both are asserted, separately, because they fail differently:
//   1. the code must BLOCK  → membership in LICENSE_BLOCK_CODES (licenseGate.svelte.ts)
//   2. the code must SPEAK  → membership in KNOWN_LICENSE_CODES (error-message.ts)
// This is what makes the frontend-first split safe: the backend half of `license_unreadable` cannot
// land without its SPA counterpart already being here, in the same tree, at build time.

/** The 402 codes in one chunk of comment-stripped backend source. Quote-agnostic — see `ANY_QUOTE`. */
function paymentRequiredCodesInText(text: string): string[] {
	const out: string[] = [];
	// `paymentRequired('code', …)` — the helper in backend/src/utils/http.ts. `\s` spans newlines,
	// which matters: every one of these call sites is multi-line.
	for (const m of text.matchAll(
		new RegExp(`paymentRequired\\(\\s*(${ANY_QUOTE})([a-zA-Z0-9_]+)\\1`, 'g')
	))
		out.push(m[2]!);
	// `new HttpError(402, 'code', …)` — the direct bypass, mirroring the 403 scrape above.
	for (const m of text.matchAll(
		new RegExp(`new\\s+HttpError\\(\\s*402\\s*,\\s*(${ANY_QUOTE})([a-zA-Z0-9_]+)\\1`, 'g')
	))
		out.push(m[2]!);
	return out;
}

/** Every 402 code the backend can actually emit, scraped from source text. */
function backendPaymentRequiredCodes(): Set<string> {
	const codes = new Set<string>();
	for (const file of listTsFiles(BACKEND_SRC)) {
		for (const c of paymentRequiredCodesInText(stripComments(readFileSync(file, 'utf-8')))) codes.add(c);
	}
	return codes;
}

describe('every backend 402 license code is understood by the SPA', () => {
	it('is in LICENSE_BLOCK_CODES (else the interceptor never fires and NO block screen renders)', () => {
		const backendCodes = backendPaymentRequiredCodes();
		// Sanity: the scrape must find the real ones, or this whole file passes vacuously.
		expect(backendCodes.size).toBeGreaterThanOrEqual(4);
		expect([...backendCodes]).toContain('license_required');

		const missing = [...backendCodes].filter((c) => !LICENSE_BLOCK_CODES.has(c)).sort();
		expect(
			missing,
			missing.length
				? `Backend emits 402 code(s) ${JSON.stringify(missing)} that are NOT in ` +
						`LICENSE_BLOCK_CODES (frontend/src/lib/stores/licenseGate.svelte.ts). ` +
						`isLicenseBlockResponse() returns false for them, so auth-fetch never calls ` +
						`licenseGate.handleForbidden() and the user sees NO block screen — only a generic ` +
						`"no active license" message on every screen. Ship the frontend half FIRST: add the ` +
						`code here, to LICENSE_MESSAGES + the LicenseBlocked branch, and to all 8 catalogs, ` +
						`deploy that, and only then emit it from the backend.`
				: undefined
		).toEqual([]);
	});

	it('has its own copy (or is the documented license_required default)', () => {
		const backendCodes = backendPaymentRequiredCodes();
		const known = new Set(KNOWN_LICENSE_CODES);
		const missing = [...backendCodes].filter((c) => !known.has(c)).sort();
		expect(
			missing,
			missing.length
				? `Backend emits 402 code(s) ${JSON.stringify(missing)} with no entry in ` +
						`error-message.ts's LICENSE_MESSAGES — they render the generic ` +
						`error_license_required copy ("your workspace doesn't have an active license"), ` +
						`which for an outage or an unreadable token is an accusation, not a diagnosis.`
				: undefined
		).toEqual([]);
	});
});

// ── the 503 half, which the constructor shipped without ─────────────────────────────────────
//
// ⛔ THE HELPER WAS BORN OUTSIDE THE CONTRACT AND SAID SO IN ITS OWN DOC COMMENT.
// `backend/src/utils/http.ts`'s `serviceUnavailable(code, message, details)` carries a header
// naming this exact gap: "`error-message.backend-contract.test.ts` scrapes `forbidden(`,
// `paymentRequired(`, `badRequest(`, `unprocessable(` and `conflict(` … It scrapes NEITHER
// `serviceUnavailable(` NOR `new HttpError(503,`. … A SECOND code added through this helper
// therefore ships with no copy in any of the 8 locales and the whole suite stays green — … Add the
// code to the SPA map in the same change, by hand, until that scrape learns this helper."
// This is the scrape learning it.
//
// ⛔ AND THE WARNING WAS ALREADY TRUE WHEN IT WAS WRITTEN — THIS IS NOT A PRECAUTION. The "SECOND
// code" it predicts was ALREADY IN THE TREE: `routes/onboarding.ts:129` has been refusing a full
// self-signup queue with `signup_queue_full` the whole time, and it had no copy in any of the eight
// locales while every assertion in this file was green. The first run of the scrape below is what
// found it. `tenant_status_unavailable` had been added to `SERVICE_UNAVAILABLE_MESSAGES` by hand, and
// hand is exactly what missed the other one — which is the argument for the guard, made by the guard.
//
// ⚠️ WHAT AN UNKNOWN 503 DOES, SO THE SEVERITY IS NOT OVERSTATED. It is the MILDEST of the four
// failure modes this file guards. `licenseOrPermissionMessage`'s 503 arm is a LOOKUP, not a
// `status >= 500` sweep, so an unrecognised code returns `null` and the caller's own translated
// fallback survives ("Kon niet laden"). Nobody is accused of anything and no screen goes blank —
// unlike the unknown 402, which renders NO block screen at all. What is lost is the one sentence
// that would have told a member during a database blip that the failure is transient and a retry is
// the whole repair. Mild is not zero, and invisible-mild is how 91 codes accumulated.
//
// ⚠️ ONE DIRECTION ONLY, DELIBERATELY — there is no mirror assertion here ("every catalogued 503
// code is emitted by the backend"), for the reason the 402 half above has none either: this repo
// ships the SPA half of a refusal FIRST by design, so during a frontend-first window a catalogued
// code legitimately does not appear in `backend/src` and a mirror would be red for the mechanism
// working. The `NOT_LOCALIZED_CODES` grep further down carries the same warning in full.

/** The 503 codes in one chunk of comment-stripped backend source. Quote-agnostic — see `ANY_QUOTE`. */
function serviceUnavailableCodesInText(text: string): string[] {
	const out: string[] = [];
	// `serviceUnavailable('code', …)` — the helper in backend/src/utils/http.ts. `\s` spans the
	// newline because the real call site is prettier-wrapped, as 37 of the 154 refusal sites are.
	// ⚠️ The helper's own DEFINITION (`export const serviceUnavailable = (`) has ` = ` before the
	// paren and so cannot match — the same property `refusalSlotsIn` documents having checked for
	// badRequest/unprocessable/conflict.
	for (const m of text.matchAll(
		new RegExp(`serviceUnavailable\\(\\s*(${ANY_QUOTE})([a-zA-Z0-9_]+)\\1`, 'g')
	))
		out.push(m[2]!);
	// `new HttpError(503, 'code', …)` — the direct bypass, mirroring the 403/402 scrapes above. NOT
	// hypothetical: `routes/onboarding.ts:129` refuses a self-signup with `signup_queue_full` this
	// way, and it is wrapped across FIVE lines with `503` on its own line — which is why every `\s*`
	// here has to span newlines and why that code is anchored by name below.
	for (const m of text.matchAll(
		new RegExp(`new\\s+HttpError\\(\\s*503\\s*,\\s*(${ANY_QUOTE})([a-zA-Z0-9_]+)\\1`, 'g')
	))
		out.push(m[2]!);
	return out;
}

/** Every 503 code the backend can actually emit, scraped from source text. */
function backendServiceUnavailableCodes(): Set<string> {
	const codes = new Set<string>();
	for (const file of listTsFiles(BACKEND_SRC)) {
		for (const c of serviceUnavailableCodesInText(stripComments(readFileSync(file, 'utf-8'))))
			codes.add(c);
	}
	return codes;
}

/**
 * ⛔ 3, RE-MEASURED BY RUNNING THE SCRAPE. This block read "2, MEASURED AGAINST THE TREE ON
 * 2026-08-26" and enumerated two codes; the self-signup queue's split into a total ceiling and an
 * anonymous sub-quota added a THIRD, and the paragraph is rewritten from the new measurement rather
 * than having a bullet appended to a stale count. Two SHAPES, three codes:
 *   • `serviceUnavailable('tenant_status_unavailable', …)` — middleware/tenant-status-gate.ts:207,
 *     prettier-wrapped, code on the next line;
 *   • `new HttpError(\n 503,\n 'signup_queue_full', …)` — routes/onboarding.ts, wrapped across five
 *     lines with `503` on its OWN line: the whole table is at its ceiling, nobody is admitted;
 *   • `new HttpError(\n 503,\n 'signup_queue_anonymous_full', …)` — routes/onboarding.ts, the same
 *     shape: the anonymous reserve is exhausted while matched and authenticated signups are still
 *     being served. Written as a SEPARATE literal throw rather than a computed code slot precisely
 *     so this scrape can see it — see the note beside the throws.
 * Nothing else emits a 503 with a wire code: `utils/http.ts:82` is the helper DEFINITION (its code
 * slot is the bare parameter `code`, so no quote, so no match — by construction, not by luck), and
 * `server.ts:195`/`:222` answer `/health` and `/ready` with a bare `{ ok, db }` body that carries no
 * `error` field at all and therefore has nothing to localize.
 *
 * ⛔ AND THE FLOOR IS THE WEAKEST OF THE THREE THINGS HOLDING THIS ARM UP — read the other two
 * before trusting it. (a) There is ONE NAMED ANCHOR PER SHAPE below, which is what the bare count
 * cannot do: drop the `new HttpError(503,` rule and add a code elsewhere and the count is unchanged,
 * exactly the argument `derives the whole tree and not a fraction of it` makes for its five anchors.
 * (b) The fixture describe drives BOTH shapes × all three quote styles through the identical reader
 * — the only way to test a parser without waiting for the bug, and the only proof of the quote half,
 * since both real sites are single-quoted and so cannot distinguish a quote-agnostic reader from a
 * single-quote-only one.
 *
 * ⚠️ Three of three is a floor that equals the count today, which the `REFUSAL_CODE_FLOOR` note
 * warns against (pinning the measurement reds on a legitimate deletion). It is accepted here for the
 * reason it was accepted at two: the population is three rather than 102, so any lower number is
 * satisfied by most of the tree going missing. If a 503 throw is ever legitimately deleted, drop
 * this to the number you MEASURE and delete the corresponding anchor — do not lower it to get green
 * while leaving the anchor asserting a code the backend no longer emits.
 */
const SERVICE_UNAVAILABLE_CODE_FLOOR = 3;

// ⚠️ NO THIRD ANCHOR IS ADDED FOR `signup_queue_anonymous_full`, DELIBERATELY. The anchors below are
// one per SHAPE, not one per code, and the new code is shape 2 — the shape `signup_queue_full`
// already anchors. A per-code anchor would be the pinned-measurement failure this floor's own note
// warns about: it reds on a legitimate deletion rather than on the parser breaking.

// ⚠️ THE NAME SAYS "OR HONESTLY REGISTERED" AND NOT "HAS LOCALIZED COPY", because that is what is
// actually asserted — the 400/422/409 half above learned the same lesson. A test whose name claims
// more than its assertion is how a reader comes to believe a surface is covered when it is excused.
describe('every backend 503 code is catalogued or honestly registered', () => {
	it('is a key of SERVICE_UNAVAILABLE_MESSAGES or of NOT_LOCALIZED_CODES (else silence ships)', () => {
		const backendCodes = backendServiceUnavailableCodes();
		// ── non-vacuity FIRST: the assertion below is negative and an empty scrape satisfies it ──
		expect(
			backendCodes.size,
			`Only ${backendCodes.size} 503 codes scraped from backend/src (floor ` +
				`${SERVICE_UNAVAILABLE_CODE_FLOOR}, measured 2 on 2026-08-26). Either a 503 throw was ` +
				`deleted, or — far more likely — the scrape broke: check that \`serviceUnavailable\` is ` +
				`still the helper name in backend/src/utils/http.ts, that BACKEND_SRC still resolves, and ` +
				`that every \\s* still spans the newlines of a prettier-wrapped call. Do NOT lower this ` +
				`floor to get green.`
		).toBeGreaterThanOrEqual(SERVICE_UNAVAILABLE_CODE_FLOOR);
		// ── ONE NAMED ANCHOR PER SHAPE ──────────────────────────────────────────────────────────
		// A count cannot tell which of the two rules died; these can. Each names the site it is
		// anchored to so a reader meeting the red knows where to look.
		expect(
			[...backendCodes],
			'shape 1 — serviceUnavailable(, wrapped: backend/src/middleware/tenant-status-gate.ts:207'
		).toContain('tenant_status_unavailable');
		expect(
			[...backendCodes],
			'shape 2 — new HttpError(503, wrapped with 503 on its own line: backend/src/routes/onboarding.ts:129'
		).toContain('signup_queue_full');

		// ── the contract: catalogued, or honestly registered ────────────────────────────────────
		// ⛔ THE SAME TWO-HOME RULE THE WHOLE-TREE 400/422/409 HALF USES, AND FOR THE SAME REASON.
		// "No entry" has two meanings that look identical from CI — nobody looked, or someone looked
		// and decided — and only a register can tell them apart. `NOT_LOCALIZED_CODES` is REUSED rather
		// than duplicated for 503: a second register would be a second thing to rot, and its rot-guard
		// (`NOT_LOCALIZED_CODES names only codes backend/src still emits`) already greps the whole tree
		// for every member regardless of the member's status.
		const known = new Set(KNOWN_SERVICE_UNAVAILABLE_CODES);
		const registered = new Set(NOT_LOCALIZED_CODES.keys());
		const homeless = [...backendCodes].filter((c) => !known.has(c) && !registered.has(c)).sort();
		expect(
			homeless,
			homeless.length
				? `Backend emits 503 code(s) ${JSON.stringify(homeless)} that are in NEITHER map.\n` +
						`licenseOrPermissionMessage()'s 503 arm is a LOOKUP, so an unknown code returns null ` +
						`and the screen falls back to its own generic "could not load" — the reader is never ` +
						`told the failure is transient and that retrying is the whole repair, in any of the 8 ` +
						`locales.\n` +
						`Pick ONE, in frontend/src/lib/api/error-message.ts:\n` +
						`  · a reader on a real screen meets this → add a SERVICE_UNAVAILABLE_MESSAGES entry ` +
						`saying what is retryable and what is not, and add its message key to ALL EIGHT ` +
						`catalogs (frontend/messages/*.json — catalogs.test.ts enforces key parity);\n` +
						`  · you went and read the throw site and no reader can reach the sentence → add a ` +
						`NOT_LOCALIZED_CODES entry whose reason is the MEASURED one, naming the emitting ` +
						`file:line AND the frontend call site that swallows or never renders it. That is how ` +
						`\`signup_queue_full\` is handled — its only caller is the fire-and-forget ` +
						`notifySelf() at stores/auth.svelte.ts:75, so copy for it would be copy nothing ` +
						`renders. A wrong reason here is a wrong GREEN, which is worse than the gap it ` +
						`papers over.\n` +
						`⛔ Do NOT answer this by widening the 503 arm to \`status >= 500\`: a blanket "the ` +
						`service is unavailable" flattens the one case we can name into the many we cannot — ` +
						`see the ⚠️ on SERVICE_UNAVAILABLE_MESSAGES.`
				: undefined
		).toEqual([]);
	});

	// ⛔ THE TWO HOMES MUST BE DISJOINT, OR THE CONTRACT ABOVE IS SATISFIABLE TWICE OVER — and the
	// second way it fails is the dangerous one. A code in BOTH maps claims coverage and non-coverage
	// at once; worse, it makes DELETING ITS COPY INVISIBLE. Register `tenant_status_unavailable` here
	// and the assertion above stays green with `SERVICE_UNAVAILABLE_MESSAGES` emptied out — the exact
	// "a guard's exemption is the next defect's doorway" shape this whole describe was written to
	// close, re-opened one map over.
	//
	// `error-message.test.ts` owns this property for `VALIDATION_MESSAGES` (its `⛔ NOT_LOCALIZED_CODES
	// and VALIDATION_MESSAGES are DISJOINT` case) and the whole-tree half below leans on it as a
	// precondition. NOTHING owned it for the 503 map, because the 503 map had no guard at all — so it
	// is asserted here, beside the contract that depends on it, rather than added to that file.
	it('⛔ SERVICE_UNAVAILABLE_MESSAGES and NOT_LOCALIZED_CODES are DISJOINT', () => {
		const registered = new Set(NOT_LOCALIZED_CODES.keys());
		const both = KNOWN_SERVICE_UNAVAILABLE_CODES.filter((c) => registered.has(c));
		expect(
			both,
			both.length
				? `503 code(s) ${JSON.stringify(both)} are in BOTH SERVICE_UNAVAILABLE_MESSAGES and ` +
						`NOT_LOCALIZED_CODES. The register entry makes the contract assertion above pass ` +
						`whether or not the copy still exists, so deleting the copy would go unnoticed. ` +
						`Fix: delete the NOT_LOCALIZED_CODES entry — the code HAS copy, so the register is ` +
						`making a false claim about it.`
				: undefined
		).toEqual([]);
		// POSITIVE HALVES: an empty map on either side makes the filter above pass over nothing, which
		// is also what "someone deleted the mechanism" looks like. So each of the two real 503 codes is
		// asserted to be in the home it actually belongs in — NOT merely absent from the other, which
		// would be equally true of a code with no home at all.
		//
		// ⛔ THE SECOND ASSERTION USED TO DEMAND `KNOWN_SERVICE_UNAVAILABLE_CODES` CONTAIN
		// `signup_queue_full`, AND THAT WAS THE DEAD COPY PINNED IN PLACE BY A TEST. It was written in
		// the revision that catalogued the code and wrote eight locales of `error_signup_queue_full`
		// for it. Nothing renders that sentence: the only SPA caller is
		// `void adminApi.notifySelf(…).catch(() => {})` at stores/auth.svelte.ts:75, fire-and-forget BY
		// DESIGN so a queue outage can never block a login. The copy was deleted from all eight
		// catalogs and the register entry restored, so this half now asserts the REGISTER — which is
		// where the measurement lives.
		expect(
			KNOWN_SERVICE_UNAVAILABLE_CODES,
			'the 503 copy map is empty — the disjointness check above proved nothing'
		).toContain('tenant_status_unavailable');
		expect(
			registered.has('signup_queue_full'),
			'the 503 register entry is gone. Do NOT answer this by re-adding copy: read the entry in ' +
				'error-message.ts first. It claims NOBODY reads the sentence, which is true only while ' +
				'stores/auth.svelte.ts:75 keeps swallowing it in `.catch(() => {})`. If that call site ' +
				'now surfaces the failure, the fix is a SERVICE_UNAVAILABLE_MESSAGES entry plus eight ' +
				'catalog strings AND deleting the register entry, in one change.'
		).toBe(true);
		expect(registered.size, 'the register is empty — the filter above proved nothing').toBeGreaterThan(20);
	});
});

describe('⛔ the 403/402/503 scrapes see DOUBLE-QUOTED and BACKTICK codes too (they measurably did not)', () => {
	it('reads every quote style off a synthetic source', () => {
		// ⛔ THE SCRAPERS' OWN NON-VACUITY, ON A FIXTURE. The three describes above are only as good as
		// their regexes, and until 2026-08-16 the 403/402 pair read single quotes only: three injected
		// double-quoted throws left this whole file 16/16 GREEN with uncatalogued codes on the wire.
		// Driving the parsers over a fixture is the only way to test a parser without waiting for the
		// bug — and for the 503 pair it is the ONLY quote-half proof there is, since both real sites
		// are single-quoted.
		const FIXTURE = [
			"throw forbidden('f_single', 'x');",
			'throw forbidden("f_double", \'x\');',
			'throw forbidden(`f_backtick`, \'x\');',
			'throw new HttpError(403, "f_http_double", \'x\');',
			// The `HttpError` SUBCLASS shape — see the note beside its rule. Wrapped AND single-quoted,
			// which is exactly how `services/byo-posture.ts` writes it, so a same-line-only or
			// double-quote-only rule derives nothing here.
			"class E extends HttpError { constructor() { super(\n  403,\n  'f_super',\n  'x',\n); } }",
			"throw paymentRequired('p_single', 'x');",
			'throw paymentRequired("p_double", \'x\');',
			'throw new HttpError(402, `p_http_backtick`, \'x\');',
			// ── the 503 half ────────────────────────────────────────────────────────────────────
			// ⛔ THIS IS THE ONLY PROOF OF THE 503 QUOTE HALF. BOTH real 503 sites are SINGLE quoted,
			// so the tree cannot tell a quote-agnostic reader from a single-quote-only one — the
			// identical blind spot `ANY_QUOTE` records having MEASURED on the 403/402 scrapes, where it
			// did ship uncatalogued codes with all sixteen assertions green.
			"throw serviceUnavailable('s_single', 'x');",
			'throw serviceUnavailable("s_double", \'x\');',
			'throw serviceUnavailable(`s_backtick`, \'x\');',
			'throw new HttpError(503, "s_http_double", \'x\');',
			// ⛔ AND THE WRAPPED SHAPE, WHICH IS WHAT BOTH REAL SITES ACTUALLY LOOK LIKE — neither 503
			// code in `backend/src` is written on one line, and `routes/onboarding.ts:129` puts `503`
			// on a line of its OWN. A same-line-only regex derives ZERO codes here and every negative
			// assertion in the 503 describe above goes trivially green.
			"throw serviceUnavailable(\n  's_wrapped',\n  'x'\n);",
			'throw new HttpError(\n  503,\n  `s_http_wrapped`,\n  \'x\'\n);'
		].join('\n');
		expect(forbiddenCodesInText(FIXTURE).sort()).toEqual([
			'f_backtick',
			'f_double',
			'f_http_double',
			'f_single',
			'f_super'
		]);
		expect(paymentRequiredCodesInText(FIXTURE).sort()).toEqual([
			'p_double',
			'p_http_backtick',
			'p_single'
		]);
		// ⛔ THE 503 READER, AND EVERY ENTRY HERE IS LOAD-BEARING. Six codes across two shapes, three
		// quote styles and the wrapped layout — the real tree exercises exactly ONE of those twelve
		// combinations per shape, so nothing else in this file can tell the other ten from a typo.
		expect(serviceUnavailableCodesInText(FIXTURE).sort()).toEqual([
			's_backtick',
			's_double',
			's_http_double',
			's_http_wrapped',
			's_single',
			's_wrapped'
		]);
		// A code slot that is NOT a readable literal stays invisible to ALL THREE — it must not be
		// half-resolved into a fake code. (The submit-path half below records such slots explicitly;
		// these three scrapes predate that mechanism and are only asserted not to invent anything.
		// ⚠️ For 503 that is not merely tidiness: `utils/http.ts:82` is `new HttpError(503, code, …)`,
		// the helper's own DEFINITION, and reading `code` off it would mint a phantom 503 wire code
		// named `code` that the contract below would then demand eight translations for.)
		expect(forbiddenCodesInText('throw forbidden(SOME_CONST, `x`);')).toEqual([]);
		expect(paymentRequiredCodesInText('throw paymentRequired(`tpl_${x}`, "y");')).toEqual([]);
		expect(serviceUnavailableCodesInText('export const serviceUnavailable = (\n  code: string,\n) => new HttpError(503, code, message, details);')).toEqual([]);

		// …and the REAL tree still parses the same way through the widened regexes.
		expect(backendForbiddenCodes().size).toBeGreaterThan(5);
		expect(backendPaymentRequiredCodes().size).toBeGreaterThanOrEqual(4);
		expect(backendServiceUnavailableCodes().size).toBeGreaterThanOrEqual(
			SERVICE_UNAVAILABLE_CODE_FLOOR
		);
	});
});

// ── the 400/422/409 half: the codes an author meets on the `/build` submit button ────────────
//
// ⛔ THE ASYMMETRY THAT PUT ENGLISH IN FRONT OF A DUTCH AUTHOR IN A DEMO.
// Everything above guards 402, 403 and 503 — the statuses whose copy is a closed set. 400/422/409
// had NO guard at all, by design: `writeErrorText` deliberately prefers the backend's own sentence
// for them (see `VALIDATION_MESSAGES` in error-message.ts for the full argument, and do not
// "fix" this by deleting that fall-through). The unexamined consequence was that a refusal aimed
// at an ORDINARY AUTHOR — "An archived flow cannot be submitted", "The flow is not ready to
// publish.", "Request validation failed." — shipped verbatim, in English, in all eight locales,
// and NOTHING in either project could go red about it. It reached a demo.
//
// So this half asserts the same contract from the other direction: for the ONE path where every
// 4xx is author-facing by construction (they pressed Submit on their own flow), every code the
// backend can refuse with must have localized copy.
//
// ⚠️ WHAT AN UNCATALOGUED CODE DOES, STATED ON PURPOSE: it still falls through to the backend's
// English sentence. That is the existing doctrine and it stays — it is the only thing that carries
// a developer-shaped 422's specifics, and a code nobody has got to yet showing a real sentence
// beats it showing a generic one. What changes is that the gap is no longer INVISIBLE: this test
// is what stops the fall-through being permanent. The map is not the guard; this is.

// ── deriving the set, rather than listing it ─────────────────────────────────────────────────
//
// ⛔ A HARDCODED LIST OF CODES WOULD BE WORTHLESS HERE. It would be exactly as complete as the day
// it was typed and would go quiet the moment someone adds a `throw` — which is the failure this
// test exists to catch, so a list version would be a guard that cannot fail for the reason it was
// built. The set is therefore DERIVED: seed at the route the `/build` Submit button calls, walk
// the call graph through `backend/src`, and collect every 400/422/409 code minted anywhere in it.
//
// ⚠️ RESIDUAL GAPS, NAMED. This is a text-level walk, not a type-checked one, and it is honest
// about what it cannot see:
//   • Only RELATIVE, NAMED imports are followed (`import { x } from '../y'`). A namespace import
//     (`import * as x`), a default import, or a dynamic `await import()` is invisible. None occur
//     on this path today.
//   • Calls are followed in two shapes: a direct `fn(…)`, and `obj.method(…)` where `obj` is a
//     named import (see the note beside that loop — it is the service-singleton shape, and it was
//     MISSING until a probe throw inside `KeycloakService.extractToken` left the guard green).
//     Still invisible: a handler passed as a VALUE and invoked elsewhere, and a method on a local
//     (non-imported) object.
//   • Declaration bodies are approximated by the span between consecutive TOP-LEVEL declarations,
//     which is exact for this codebase's one-declaration-per-top-level-statement style but would
//     over-attribute if a file ever nested a top-level declaration inside another construct.
//   • Statuses are read from the SPELLING of the throw (`unprocessable` ⇒ 422, `new HttpError(409`
//     ⇒ 409). A helper aliased or re-exported under another name is not recognised.
//   • The DYNAMIC-throw check below is the one place a human list survives, and it is a list of
//     UNRESOLVED SITES rather than of codes — see `KNOWN_INDIRECT_THROWS`.
//
// ⛔ WHAT IS **NOT** A GAP, BECAUSE IT USED TO BE ONE: the shape of the code argument. Every throw
// whose code slot is not a readable quoted literal — a bare `const`, a template literal, a call, a
// ternary — is RECORDED as unresolved rather than skipped. The first version of this file silently
// skipped all three of those and passed 13/13 with three uncatalogued author-facing 422s injected
// into `createSolution`. A guard that only knows one spelling is a guard you turn off by
// refactoring.
//
// Each remaining gap makes the walk find FEWER codes, never wrong ones, so the failure mode is a
// missed code rather than a false demand — and the anchor assertions below are what keep "found
// fewer" from silently becoming "found none".

/** The route the `/build` Submit button posts to (build/+page.svelte → lib/api/solutions.ts). */
const SUBMIT_METHOD = 'POST';
const SUBMIT_PATH = '/api/solutions';

/** A top-level declaration, and the source text attributed to it. */
interface BackendDecl {
	name: string;
	body: string;
	/** Offset of the declaration in its (comment-stripped) file, for line numbers in failures. */
	at: number;
}

interface BackendModule {
	/** Module path relative to `backend/src`, without the `.ts` (e.g. `routes/solutions`). */
	rel: string;
	text: string;
	decls: Map<string, BackendDecl>;
	/** Local imported name → `<module rel>#<original export name>`, relative imports only. */
	imports: Map<string, string>;
}

/**
 * Top-level declarations start at column 0 in this codebase; nested ones are indented. That single
 * property is what makes a regex sufficient here and is why the spans below are trustworthy.
 */
const TOP_LEVEL_DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

function indexBackendModules(): Map<string, BackendModule> {
	const mods = new Map<string, BackendModule>();
	for (const file of listTsFiles(BACKEND_SRC)) {
		const text = stripComments(readFileSync(file, 'utf-8'));
		const rel = relative(BACKEND_SRC, file).replace(/\.ts$/, '').split(/[\\/]/).join('/');

		const starts = [...text.matchAll(TOP_LEVEL_DECL)].map((m) => ({ name: m[1]!, at: m.index! }));
		const decls = new Map<string, BackendDecl>();
		for (let i = 0; i < starts.length; i++) {
			const start = starts[i]!;
			const end = i + 1 < starts.length ? starts[i + 1]!.at : text.length;
			// First declaration of a name wins; a re-declaration at top level is a compile error
			// anyway, so this only ever matters for the `let x` + later reassignment shape.
			if (!decls.has(start.name)) decls.set(start.name, { name: start.name, body: text.slice(start.at, end), at: start.at });
		}

		const imports = new Map<string, string>();
		// ⚠️ QUOTE-AGNOSTIC, AND NOT BECAUSE IT WAS BLIND. Measured 2026-08-16: rewriting ONE relative
		// import on the submit path to double quotes (`from "../host/run-policy"`) DID go red — three
		// assertions, because the walk lost a whole module and with it two derived codes. But it went
		// red saying `error-message.ts catalogs code(s) [...] that POST /api/solutions cannot emit`,
		// whose own advice text tells the reader to fix the walk or delete a live catalog entry. A
		// guard that fails for a reason it names wrongly costs the next reader an hour. Reading every
		// quote style makes the module resolve and the red disappear, correctly.
		for (const imp of text.matchAll(
			new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*(${ANY_QUOTE})(\\.[^'"\`]*)\\2`, 'g')
		)) {
			const target = join(rel, '..', imp[3]!).split(/[\\/]/).join('/');
			for (const raw of imp[1]!.split(',')) {
				const spec = raw.trim().replace(/^type\s+/, '');
				if (!spec) continue;
				const [orig, alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
				imports.set((alias ?? orig)!, `${target}#${orig}`);
			}
		}
		mods.set(rel, { rel, text, decls, imports });
	}
	return mods;
}

/** `<module>#<name>` → the module, tolerating a directory import that resolves to `index.ts`. */
function resolveModule(mods: Map<string, BackendModule>, rel: string): BackendModule | undefined {
	return mods.get(rel) ?? mods.get(`${rel}/index`);
}

interface SubmitPathScrape {
	/** code → `file:line` sites that mint it. */
	codes: Map<string, string[]>;
	/** `<module>#<fn>` keys the walk visited, i.e. the derived call graph. */
	visited: Set<string>;
	/**
	 * Throw sites whose code argument is NOT a string literal, as `<helper>(<expr>) in <file>` —
	 * see `KNOWN_INDIRECT_THROWS`.
	 *
	 * ⛔ KEYED WITHOUT THE LINE NUMBER, ON PURPOSE. The first version included `:473` and was
	 * therefore red for anyone who inserted a line ANYWHERE above it in solutions.ts — a guard that
	 * fails for a reason unrelated to what it guards, whose only possible fix is to bump a number.
	 * That trains a reader to edit the list without reading it, which is exactly how the list would
	 * come to hide a genuinely new indirect throw. The line still reaches the human, in
	 * `indirectThrowSites`, where nothing asserts on it.
	 */
	indirectThrows: Set<string>;
	/** The same sites WITH `file:line`, for the failure message only. */
	indirectThrowSites: string[];
	/**
	 * Quoted code slots that are NOT a plain wire code (`'not a code'`, `'has-dash'`). Empty today.
	 * They exist as a third bucket so that "the regex read a string but it did not look like a code"
	 * is a REPORTED state rather than a dropped match — the shape that let three spellings vanish.
	 */
	oddLiterals: Set<string>;
	/** The handler the router registers for the submit route, as `<module>#<fn>`. */
	seed: string;
}

/**
 * Every 400/422/409 code reachable from the submit route, by walking the backend call graph.
 *
 * The recognised code-minting forms, each of which really occurs on this path:
 *   1. `badRequest(…)` / `unprocessable(…)` / `conflict(…)` — the helpers in utils/http.ts.
 *   2. `new HttpError(400|409|422, …)` — the direct bypass (services/user-service.ts does this).
 *   3. `errorResponse({ error: 'code', … }, 400|409|422)` — `route()`'s OWN refusals, which every
 *      handler inherits by being wrapped: the ZodError 422 and the pg-22P02 400. Nothing else in
 *      the tree uses this shape, and missing it is how `validation` stayed invisible.
 *   4. `code: 'snake_case'` object properties — the INDIRECT path. `routes/solutions.ts:473` throws
 *      `unprocessable(policyViolation.code, …)`, so the literal lives in `host/run-policy.ts` as a
 *      field of the returned violation and forms 1–3 cannot see it.
 *
 * Forms 1 and 2 accept EITHER quote style and treat every other spelling of the code slot as
 * unresolved — see `literalOrUnresolved` for why that is the difference between a guard and a
 * spelling ban.
 *
 * ⚠️ Form 4 is the loosest rule by far and is scoped by the walk alone: it applies only inside
 * functions this path actually reaches (today: 74 of them, and it yields exactly the two policy
 * codes). The `_`-requiring pattern is what keeps `code: 'ok'` / `code: '22P02'` style fields out.
 * If it ever picks up something that is NOT a wire code, NARROW THIS RULE — do not add a catalog
 * entry for a code the product cannot emit.
 */
function scrapeSubmitPath(): SubmitPathScrape {
	const mods = indexBackendModules();

	// The seed is DERIVED from the router registration, not hardcoded to a function name: renaming
	// the handler must not silently empty this test, and moving the registration must break it.
	let seed: string | undefined;
	// Quote-agnostic on both arguments — a double-quoted `.add("POST", "/api/solutions", …)` would
	// otherwise throw the "could not find the router registration" error below, which is loud but
	// names the wrong cause (it reads as "the route moved").
	const registration = new RegExp(
		`\\.add\\(\\s*${ANY_QUOTE}${SUBMIT_METHOD}${ANY_QUOTE}\\s*,\\s*${ANY_QUOTE}${SUBMIT_PATH.replace(/\//g, '\\/')}${ANY_QUOTE}\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*\\)`
	);
	for (const mod of mods.values()) {
		const m = mod.text.match(registration);
		if (m) {
			seed = `${mod.rel}#${m[1]!}`;
			break;
		}
	}
	if (!seed) {
		throw new Error(
			`Could not find the router registration for ${SUBMIT_METHOD} ${SUBMIT_PATH} in backend/src. ` +
				`This test derives its whole starting point from it — if the route moved or the ` +
				`registration shape changed, update SUBMIT_METHOD/SUBMIT_PATH or the regex above. ` +
				`Do NOT hardcode a handler name to get it green.`
		);
	}

	const codes = new Map<string, string[]>();
	const indirectThrows = new Set<string>();
	const indirectThrowSites: string[] = [];
	const oddLiterals = new Set<string>();
	const visited = new Set<string>();
	const queue = [seed];

	const HELPER_STATUS: Record<string, number> = { badRequest: 400, unprocessable: 422, conflict: 409 };

	while (queue.length) {
		const key = queue.shift()!;
		if (visited.has(key)) continue;
		visited.add(key);
		const [rel, name] = key.split('#');
		const mod = resolveModule(mods, rel!);
		const decl = mod?.decls.get(name!);
		if (!mod || !decl) continue;

		const site = (offset: number) =>
			`backend/src/${mod.rel}.ts:${mod.text.slice(0, decl.at + offset).split('\n').length}`;
		const add = (code: string, offset: number) => {
			if (!codes.has(code)) codes.set(code, []);
			codes.get(code)!.push(site(offset));
		};

		/**
		 * A throw whose code slot is either a QUOTED LITERAL (captured as a code) or ANYTHING ELSE
		 * (recorded as an unresolved site). There is no third outcome, and that is the whole point.
		 *
		 * ⛔ THE ORIGINAL VERSION FAILED OPEN ON THREE ORDINARY SPELLINGS, INSIDE `createSolution`
		 * ITSELF: `unprocessable(SOME_CONST, …)`, `unprocessable(\`tpl_${x}\`, …)` and
		 * `unprocessable("double_quoted", …)` all yielded ZERO codes and ZERO recorded sites — the
		 * guard passed 13/13 with three uncatalogued author-facing 422s on the path. The literal
		 * rule only knew `'single'` quotes, and the indirect rule required a DOT
		 * (`(?:\\.[\\w$]+)+`), so `policyViolation.code` matched and a bare identifier did not.
		 *
		 * Extracting a code to a `const` — the most ordinary refactor there is — therefore switched
		 * the guard off silently. That is this repo's documented failure mode in its purest form:
		 * banning a SPELLING instead of asserting a PROPERTY. The property is "the code slot is a
		 * literal I can read"; everything else is unresolved by definition and must be recorded.
		 *
		 * ⛔ THE BACKTICK IS WITHHELD FROM `['"]` HERE ON PURPOSE, unlike the 403/402 scrapes above
		 * (see `ANY_QUOTE`). Those capture `[a-zA-Z0-9_]+` between the quotes, so a real template
		 * literal cannot match them at all. This one captures `[^'"\\\n]*`, so adding the backtick
		 * would make `` unprocessable(`tpl_${x}`, …) `` — the exact shape the paragraph above names —
		 * read as a "quoted string that does not look like a wire code" and land in `oddLiterals`
		 * instead of in `indirectThrows`, where a runtime-valued code slot belongs. It is already
		 * recorded as unresolved today, which is the correct bucket; widening would move it to the
		 * wrong one for no gain.
		 */
		const literalOrUnresolved = (prefix: string, label: string) => {
			for (const m of decl.body.matchAll(new RegExp(`${prefix}(['"])([^'"\\\\\\n]*)\\1`, 'g'))) {
				// A quoted string that is not a plain wire code (a dash, a space, an escape) is NOT a
				// code and must not be silently dropped either — it is unresolved too.
				if (/^[a-zA-Z0-9_]+$/.test(m[2]!)) add(m[2]!, m.index!);
				else oddLiterals.add(`${label}(${JSON.stringify(m[2])}) in backend/src/${mod.rel}.ts`);
			}
			// Anything whose first character is not a quote: a bare identifier, a member expression, a
			// template literal, a call, a ternary. Recorded, never resolved.
			for (const m of decl.body.matchAll(new RegExp(`${prefix}(?!['"])([^,)\\s][^,)]{0,79})`, 'g'))) {
				indirectThrows.add(`${label}(${m[1]!.trim()}) in backend/src/${mod.rel}.ts`);
				indirectThrowSites.push(`${label}(${m[1]!.trim()}) at ${site(m.index!)}`);
			}
		};

		// Forms 1 and 2 — the helper calls and the direct `new HttpError` bypass.
		for (const helper of Object.keys(HELPER_STATUS)) literalOrUnresolved(`\\b${helper}\\(\\s*`, helper);
		literalOrUnresolved(`new\\s+HttpError\\(\\s*(?:400|409|422)\\s*,\\s*`, 'new HttpError');

		// Form 3. The trailing `,?` matters: the real call sites are prettier-wrapped with a dangling
		// comma after the status, and without it this rule matches nothing and says so silently.
		// No unresolved-probe here: both sites are object literals in ONE file that the walk always
		// visits, and the `validation` anchor test below reds if this rule stops matching.
		for (const m of decl.body.matchAll(
			/errorResponse\(\s*\{\s*error:\s*(['"])([a-zA-Z0-9_]+)\1[\s\S]{0,400}?\}\s*,\s*(?:400|409|422)\s*,?\s*\)/g
		))
			add(m[2]!, m.index!);
		// Form 4.
		for (const m of decl.body.matchAll(/\bcode:\s*(['"])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\1/g)) add(m[2]!, m.index!);

		// Recurse into every directly-called identifier that resolves inside backend/src.
		for (const m of decl.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
			const callee = m[1]!;
			const imported = mod.imports.get(callee);
			if (imported) queue.push(imported);
			else if (callee !== name && mod.decls.has(callee)) queue.push(`${mod.rel}#${callee}`);
		}

		/**
		 * ⛔ METHOD CALLS ON AN IMPORTED OBJECT — `keycloak.extractToken(…)`, the normal way a named
		 * import of a service SINGLETON is used. The identifier loop above yields `extractToken`,
		 * which is neither an import binding nor a local declaration, so the whole of
		 * `services/keycloak` was never entered: a `conflict('…')` inside `KeycloakService` left this
		 * guard green. Harmless in fact (keycloak only throws 401) but not by design.
		 *
		 * Resolving it needs one hop the module index cannot do directly: `keycloak` is
		 * `export const keycloak = new KeycloakService()`, whose own span holds no throws. So the
		 * class is found through the `new X(` in that span, and its ENTIRE body is scraped — which
		 * over-attributes (methods this path never calls are included) and therefore errs toward
		 * demanding MORE coverage, never less. Measured: zero extra codes today.
		 */
		for (const m of decl.body.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
			const imported = mod.imports.get(m[1]!);
			if (!imported) continue;
			const [targetRel, targetName] = imported.split('#');
			const targetMod = resolveModule(mods, targetRel!);
			if (!targetMod) continue;
			// A module-level export reached through an object-ish binding.
			queue.push(`${targetRel}#${m[2]!}`);
			// …and the class behind a `const x = new X()` singleton.
			const instantiates = targetMod.decls.get(targetName!)?.body.match(/new\s+([A-Z][\w$]*)\s*\(/);
			if (instantiates) queue.push(`${targetRel}#${instantiates[1]!}`);
		}
	}

	return { codes, visited, indirectThrows, indirectThrowSites, oddLiterals, seed };
}

/**
 * The throw sites whose code is a runtime value, listed as SITES (not as codes) because a human has
 * to confirm the producer is reachable by the walk — form 4 above is what actually resolves this one.
 *
 * ⛔ This is the guard's one hand-maintained list and it is deliberately the shape that FAILS LOUDLY
 * rather than the shape that goes quiet: a NEW indirect throw appears here as an unexpected entry
 * and reds the test, forcing someone to check that its code literal is somewhere the scrape can see.
 * A list of CODES would have the opposite property, which is the whole reason this file does not
 * contain one.
 */
const KNOWN_INDIRECT_THROWS = [
	// Resolved by form 4: the literal is `code: 'policy_network_blocked'` / `'policy_pii_violation'`
	// on the violation object `host/run-policy.ts` returns, and the walk enters that function.
	'unprocessable(policyViolation.code) in backend/src/routes/solutions.ts',
	// Resolved BY CONSTRUCTION: this is `utils/http.ts`'s own helper factory
	// (`badRequest = (code, message) => new HttpError(400, code, message)`). Its `code` is whatever
	// the CALLER passed, and that caller's literal is already captured at the call site by form 1.
	// It is listed rather than special-cased in the scanner because an exception in the code would
	// be invisible; here a reader can see exactly which pass-through is being excused.
	'new HttpError(code) in backend/src/utils/http.ts'
];

describe('every 400/422/409 code on the /build submit path has localized copy', () => {
	const scrape = scrapeSubmitPath();
	const derived = [...scrape.codes.keys()].sort();

	// ── positive assertions FIRST: a derivation bug must not report green ────────────────────
	//
	// ⛔ EVERY ASSERTION IN THE MISSING-ENTRY TEST BELOW IS NEGATIVE (`missing` is empty), and a
	// negative assertion over an empty input is trivially true. If `indexBackendModules` stopped
	// finding declarations, or the seed regex stopped matching, or every code rule silently stopped
	// matching, that test would pass while proving nothing. These assert the derivation WORKED.
	it('derives a non-empty code set from a seed it found in the router', () => {
		expect(scrape.seed).toBe('routes/solutions#createSolution');
		// The walk must have crossed module boundaries, not just read the seed's own file.
		expect(scrape.visited.size).toBeGreaterThan(20);
		expect(derived.length).toBeGreaterThanOrEqual(15);
	});

	it('reads every quoted code slot it finds, or reports it as odd', () => {
		// ⛔ THE THIRD BUCKET MUST STAY EMPTY, AND EMPTY IS AN ASSERTION HERE, NOT AN ABSENCE. A
		// quoted string in a code slot that does not look like a wire code (`'not a code'`,
		// `'has-dash'`) is neither a code nor an unresolved expression, and the original scanner
		// dropped it on the floor — the same silence that hid three injected throws. If this ever
		// fires, the fix is to look at the site, not to widen the code pattern until it passes.
		expect([...scrape.oddLiterals]).toEqual([]);
	});

	// One anchor per extraction rule, so a rule that silently stops matching goes red on its own
	// rather than being masked by the other four still working. A bare count cannot do this: drop
	// form 3 and add two codes elsewhere and the count is unchanged.
	it.each([
		['form 1 — unprocessable(literal), in the seed itself', 'flow_archived'],
		['form 2 — new HttpError(409, literal), two modules deep via ensureUser', 'seat_limit_reached'],
		["form 3 — route()'s own ZodError 422, inherited by every handler", 'validation'],
		['form 4 — the indirect throw, code minted in host/run-policy.ts', 'policy_network_blocked'],
		['transitive recursion — host/publication-service.ts, called from the seed', 'block_archived']
	])('finds %s', (_why, code) => {
		expect(derived).toContain(code);
	});

	it('records a code slot it cannot read instead of skipping it', () => {
		// ⛔ THE ASSERTION THE ORIGINAL FILE DID NOT HAVE, AND THE ONE THAT WOULD HAVE CAUGHT ITS
		// OWN HOLE. `KNOWN_INDIRECT_THROWS` is only a safety net if the scanner actually RECORDS the
		// shapes it cannot resolve; the first version required a dot in the expression, so a bare
		// `const` was recorded nowhere and derived nothing. Non-empty is the positive claim: the
		// unresolved bucket is a working mechanism, not a permanently empty set that would make the
		// dynamic-throw test below trivially true.
		expect(scrape.indirectThrows.size).toBeGreaterThan(0);
		// …and each recorded site carries a real file, so the failure message can point somewhere.
		for (const site of scrape.indirectThrowSites) expect(site).toMatch(/ at backend\/src\/.+\.ts:\d+$/);
	});

	it('resolves every dynamic throw on the path, or names it as unresolved', () => {
		// Not "there are none" — there IS one, and pretending otherwise is how it would get lost.
		const unexpected = [...scrape.indirectThrows].filter((t) => !KNOWN_INDIRECT_THROWS.includes(t));
		expect(
			[...scrape.indirectThrows].sort(),
			unexpected.length
				? `A throw on the submit path takes its code from a runtime value, so the literal is ` +
						`NOT at the throw site and rules 1–3 above cannot see it: ` +
						`${JSON.stringify(unexpected)}.\nSites: ${scrape.indirectThrowSites.join(', ')}\n` +
						`Check where that code is minted and confirm the scrape reaches it (rule 4 covers a ` +
						`\`code: 'literal'\` property on a returned object). Then add it to ` +
						`KNOWN_INDIRECT_THROWS. Do NOT add it without checking — that is the one edit that ` +
						`turns this guard off.`
				: `An indirect throw listed in KNOWN_INDIRECT_THROWS is gone from the path. If the throw ` +
						`was removed or made literal, drop the entry.`
		).toEqual([...KNOWN_INDIRECT_THROWS].sort());
	});

	// ── the contract ─────────────────────────────────────────────────────────────────────────
	it('is in KNOWN_SUBMIT_REFUSAL_CODES (else the author reads the English wire sentence)', () => {
		const known = new Set(KNOWN_SUBMIT_REFUSAL_CODES);
		const missing = derived.filter((c) => !known.has(c));

		// ⛔ TWO CAUSES, OPPOSITE FIXES, AND THEY USED TO SHARE ONE MESSAGE. `KNOWN_SUBMIT_REFUSAL_CODES`
		// is `VALIDATION_MESSAGES` MINUS `NON_SUBMIT_PATH_CODES`, so a code can be absent from it either
		// because it has no copy at all, or because it HAS copy that was wrongly subtracted as
		// off-path. The old text asserted the first unconditionally: mutate `invalid_input` into
		// `NON_SUBMIT_PATH_CODES` and this failed saying it "has NO entry in VALIDATION_MESSAGES …
		// add each to VALIDATION_MESSAGES and add its message key to ALL EIGHT catalogs" — measured,
		// and false on every clause. Both already existed; following the instruction is a no-op and
		// the test stays red while the reader edits eight catalogs for nothing.
		const catalogued = new Set(VALIDATION_MESSAGE_CODES);
		const uncatalogued = missing.filter((c) => !catalogued.has(c));
		const wronglySubtracted = missing.filter((c) => catalogued.has(c));

		const advice = [
			uncatalogued.length
				? `NO entry in error-message.ts's VALIDATION_MESSAGES: ${JSON.stringify(uncatalogued)}\n` +
					uncatalogued
						.map((c) => `  ${c} — minted at ${scrape.codes.get(c)!.join(', ')}`)
						.join('\n') +
					`\n  Fix: add each to VALIDATION_MESSAGES with an author-facing sentence, and add its ` +
					`message key to ALL EIGHT catalogs (frontend/messages/*.json — catalogs.test.ts ` +
					`enforces key parity).`
				: '',
			wronglySubtracted.length
				? `HAS an entry in VALIDATION_MESSAGES but was subtracted as off-path: ` +
					`${JSON.stringify(wronglySubtracted)}\n` +
					wronglySubtracted
						.map((c) => `  ${c} — minted at ${scrape.codes.get(c)!.join(', ')}`)
						.join('\n') +
					`\n  Fix: REMOVE each from NON_SUBMIT_PATH_CODES in error-message.ts. Do NOT touch the ` +
					`catalogs — the copy and its 8 keys already exist. This path DOES emit the code, so ` +
					`listing it as off-path is the false claim.`
				: ''
		]
			.filter(Boolean)
			.join('\n');

		expect(
			missing,
			missing.length
				? `POST ${SUBMIT_PATH} can refuse with 400/422/409 code(s) ${JSON.stringify(missing)} ` +
						`that KNOWN_SUBMIT_REFUSAL_CODES does not contain, so writeErrorText() falls through ` +
						`to the backend's ENGLISH sentence and shows it verbatim on /build in all 8 locales.\n` +
						advice
				: undefined
		).toEqual([]);
	});

	// ⛔ THE MIRROR, AND IT IS NOT SYMMETRY FOR ITS OWN SAKE. An entry for a code this path cannot
	// emit is a claim of coverage that nothing can ever contradict — dead copy that reads as a
	// tested case. `seat_limit_reached` is the one legitimate exception: its copy lives in
	// `licenseOrPermissionMessage`, and it IS derived here (via ensureUser), so it is not an
	// exception to the reachability rule at all — only to where the copy lives.
	it('has no catalog entry for a code this path cannot emit', () => {
		const derivedSet = new Set(derived);
		const unreachable = KNOWN_SUBMIT_REFUSAL_CODES.filter((c) => !derivedSet.has(c));
		expect(
			unreachable,
			unreachable.length
				? `error-message.ts catalogs 400/422/409 code(s) ${JSON.stringify(unreachable)} that ` +
						`POST ${SUBMIT_PATH} cannot emit. THREE possible causes, and the third is the one ` +
						`this message used to omit:\n` +
						`  1. the backend throw was removed — delete the VALIDATION_MESSAGES entry and its 8 ` +
						`catalog keys;\n` +
						`  2. the walk above no longer reaches it — fix the walk, do NOT delete a live entry ` +
						`to get green;\n` +
						`  3. the code is emitted by a DIFFERENT route and never by ${SUBMIT_METHOD} ` +
						`${SUBMIT_PATH} — add it to NON_SUBMIT_PATH_CODES in error-message.ts, which ` +
						`subtracts it from this set. That is how \`delivery_already_live\` is handled. ` +
						`⛔ Only for a code you have CONFIRMED another route emits: the guard below greps ` +
						`backend/src for every member and reds if the literal is gone.`
				: undefined
		).toEqual([]);
	});

	// ── the third direction: rot in the subtraction list itself ──────────────────────────────────
	//
	// ⛔ `NON_SUBMIT_PATH_CODES` REMOVES CODES FROM A GUARDED SET, SO IT MUST ITSELF BE GUARDED.
	// Measured before this case existed: adding a code that exists NOWHERE — not in the map, not in
	// the backend — left the file 14/14 green and silent. That is the escape hatch the list's own
	// comment says it is not: anything named here vanishes from the mirror assertion, unexamined.
	//
	// Two assertions, because the two rots are different. (a) catches a code whose
	// VALIDATION_MESSAGES entry was deleted (the subtraction outlives its copy and now suppresses
	// nothing). (b) is the one-line backend grep the PR admitted was missing — nothing in CI proved
	// `delivery_already_live` was still emitted anywhere, so the entry, its 8 catalog strings and its
	// render test could all have outlived the 409 that justified them.
	//
	// ⚠️ (b) IS A GREP, NOT A CALL-GRAPH PROOF, and must not be read as one. It says the literal
	// exists in non-comment backend source; it does not say the route named in the comment still
	// reaches it. Comments are stripped first (`stripComments`) for the reason documented on that
	// helper: this repo quotes emitting calls in prose, so a comment-reading grep would confirm
	// codes the backend no longer emits — the exact false green this case exists to prevent.
	describe('NON_SUBMIT_PATH_CODES itself does not rot', () => {
		it('lists only codes that still have copy in VALIDATION_MESSAGES', () => {
			const catalogued = new Set(VALIDATION_MESSAGE_CODES);
			const orphaned = NON_SUBMIT_PATH_CODES.filter((c) => !catalogued.has(c));
			expect(
				orphaned,
				orphaned.length
					? `NON_SUBMIT_PATH_CODES names ${JSON.stringify(orphaned)}, which no longer has an ` +
							`entry in VALIDATION_MESSAGES. The subtraction has outlived the copy it was ` +
							`written to protect and now removes nothing. Fix: delete the member.`
					: undefined
			).toEqual([]);
			// POSITIVE HALF: an empty list would satisfy the assertion above trivially, and an empty
			// list is also what "someone deleted the mechanism" looks like.
			expect(
				NON_SUBMIT_PATH_CODES.length,
				'NON_SUBMIT_PATH_CODES is empty — if the off-path entry was removed from ' +
					'VALIDATION_MESSAGES too then delete this whole describe; otherwise the subtraction ' +
					'was dropped and the mirror assertion is now wrong about delivery_already_live.'
			).toBeGreaterThan(0);
		});

		// ⛔⛔ READ THIS BEFORE ACTING ON THE FAILURE MESSAGE BELOW. Its advice — "delete the entry,
		// the member here, and the catalog keys" — is correct for a code the backend STOPPED emitting
		// and catastrophic for one it has not STARTED emitting yet. Both look identical to a grep.
		//
		// This repo ships the SPA half of a refusal FIRST by design (`license_unreadable`'s note in
		// error-message.ts spells out why: an old bundle meeting a new API is the harmful direction).
		// So during a frontend-first window the members named by the newest `VALIDATION_MESSAGES`
		// entries are legitimately absent from `backend/src` and this case is RED — that is the
		// mechanism working, not rot. `tenant_offboarded` (`PATCH /api/tenants/:id`, 409) and
		// `confirm_mismatch` (`POST /api/tenants/:id/offboard`, 400) are in exactly that window while
		// `middleware/tenant-status-gate.ts` and the offboard route land in a parallel lane.
		//
		// ⚠️ THE FIX IS TO LAND THE BACKEND HALF, NEVER TO EXEMPT THE CODE HERE. An exemption list
		// would be indistinguishable from the rot this case exists to catch, and would outlive the
		// window that justified it — a guard you turn off by shipping.
		it('lists only codes the backend still emits somewhere (the grep CI was missing)', () => {
			const backendText = listTsFiles(BACKEND_SRC)
				.map((f) => stripComments(readFileSync(f, 'utf-8')))
				.join('\n');
			// ⚠️ ANY QUOTE STYLE COUNTS AS "still emitted". Measured 2026-08-16: rewriting the two real
			// `error: 'delivery_already_live'` sites in routes/delivery.ts to double quotes made this
			// case red saying `the literal does not appear anywhere in backend/src outside a comment.
			// The backend stopped emitting it … Fix: delete the entry, the member here, and the catalog
			// keys` — an instruction that would have deleted eight live catalog strings over a quote
			// style. Loud, but naming a cause it never checked.
			const gone = NON_SUBMIT_PATH_CODES.filter(
				(c) => !['"', "'", '`'].some((q) => backendText.includes(`${q}${c}${q}`))
			);
			expect(
				gone,
				gone.length
					? `NON_SUBMIT_PATH_CODES names ${JSON.stringify(gone)}, but the literal does not ` +
							`appear anywhere in backend/src outside a comment. The backend stopped emitting ` +
							`it, so its VALIDATION_MESSAGES entry, its 8 catalog strings and its render test ` +
							`are all dead copy. Fix: delete the entry, the member here, and the catalog keys.`
					: undefined
			).toEqual([]);
			// POSITIVE MARKER: prove the haystack is real. An unreadable BACKEND_SRC would make the
			// assertion above pass by finding nothing to check against nothing.
			expect(
				backendText.length,
				'backend/src read as (almost) empty — the grep above proved nothing'
			).toBeGreaterThan(100_000);
		});
	});
});

// ── the WHOLE-TREE 400/422/409 half: the honesty register, made load-bearing ─────────────────
//
// ⛔ WITHOUT THIS, `NOT_LOCALIZED_CODES` IS A COMMENT AND THE 92nd CODE SHIPS ENGLISH AGAIN.
// Everything above this line guards ONE ROUTE (`POST /api/solutions`) plus the two closed sets
// (402/403). The 400/422/409 population is neither: `writeErrorText` renders the backend's ENGLISH
// `message` verbatim for any 400/409/422 code with no `VALIDATION_MESSAGES` entry, and on `8d36692`
// that was 91 of the 102 codes `badRequest`/`unprocessable`/`conflict` emit. This branch catalogues
// 56 of them and records the rest — with a measured reason each — in `NOT_LOCALIZED_CODES`.
//
// A register of deliberate omissions is worth exactly as much as the thing that reads it. Written
// down and unread, it says "someone decided" about the codes that existed on the day it was typed
// and says NOTHING about the next one: a `badRequest('some_new_refusal', …)` added tomorrow is
// absent from both maps, falls through to English in all eight locales, and no test anywhere goes
// red. That is the identical silence that let 91 codes reach a Dutch tenant while the suite was
// green. So the register is not the guard — this is.
//
// THE CONTRACT: every string-literal code passed to `badRequest`/`unprocessable`/`conflict`
// anywhere under `backend/src` is EITHER a key of `VALIDATION_MESSAGES` (it has localized copy) OR
// a key of `NOT_LOCALIZED_CODES` (someone read the throw site and wrote down why not). Neither is
// a hole; being in NEITHER is.
//
// ⚠️ WHAT THIS DELIBERATELY DOES **NOT** COVER, so nobody reads it as wider than it is:
//   • `new HttpError(400|409|422, 'code', …)` — the direct bypass. `services/user-service.ts`'s
//     `seat_limit_reached` is one, and the submit-path walk above catches it ON THAT PATH only. A
//     tree-wide `new HttpError` scrape is available follow-on work; it is not done here, and the
//     three helpers are where 154 of the refusals actually live.
//   • `errorResponse({ error: 'code' }, 4xx)` — `route()`'s own ZodError 422 / pg-22P02 400. Same:
//     covered on the submit path, not tree-wide.
//   • REACHABILITY. This says the code is catalogued or registered, never that a browser can reach
//     it. The submit-path mirror above is the only reachability proof in this file.
//   • **503** — covered now, but by the `every backend 503 code has frontend localized copy` describe
//     FURTHER UP, not by this whole-tree helper scrape, and the split is deliberate. 503 is a CLOSED
//     set answered by its own map (`SERVICE_UNAVAILABLE_MESSAGES`), so it belongs with the 402/403
//     halves that work the same way — not here, where the contract is "catalogued in
//     `VALIDATION_MESSAGES` or registered", and `VALIDATION_MESSAGES` is a map `writeErrorText`
//     consults on 400/422/409 ONLY. Folding `serviceUnavailable` into `REFUSAL_HELPERS` would have
//     demanded copy for a 503 in a map that can never render it.
//     ⚠️ THE REGISTER IS SHARED EVEN THOUGH THE SCRAPE IS NOT. The 503 describe reads
//     `NOT_LOCALIZED_CODES` as a legitimate second home too, because a register keyed by status would
//     be a second thing to rot for no gain. No 503 is registered there today — both are catalogued —
//     which is why that describe also asserts the two maps are DISJOINT: without it, registering a
//     code would silently excuse deleting its copy.
//     This bullet used to say the 503 scrape was "NOT WRITTEN YET **ON PURPOSE**" because the
//     gate was landing in a parallel lane and a floor over an empty scrape would have been a number
//     nobody measured. The gate has landed; the floor was measured against the tree (2, one per
//     shape) rather than predicted, which is what that note asked for.
//
// ⛔ DISJOINTNESS IS NOT ASSERTED HERE — IT ALREADY EXISTS, and a second copy would be one more
// place to rot. `error-message.test.ts`'s `⛔ NOT_LOCALIZED_CODES and VALIDATION_MESSAGES are
// DISJOINT` (its `codes deliberately left OUT` describe) owns it, together with the non-vacuity
// companion that every register reason is a real one. If that case is ever deleted, a code could
// sit in both maps and satisfy the assertion below twice over — so it is a precondition of this
// guard, not an unrelated test.

/** The three helpers in `backend/src/utils/http.ts` that mint a 400/422/409 wire code. */
const REFUSAL_HELPERS = ['badRequest', 'unprocessable', 'conflict'] as const;

/**
 * `backend/src` as `[<module rel>, <comment-stripped source>]` pairs.
 *
 * ⛔ COMMENT-STRIPPED IS LOAD-BEARING HERE AND IT IS MEASURED, NOT PRECAUTIONARY. Five of the 165
 * `badRequest|unprocessable|conflict(` occurrences in the tree are PROSE, and one of them
 * (`ai/tool-rendezvous.ts:217` — ``badRequest('no_pending_tool')``) documents a code that was
 * REMOVED from the wire. A comment-reading scrape derives it as a 103rd code, finds it in neither
 * map, and reds this guard demanding copy for a refusal the product cannot emit — pointing the
 * reader at a paragraph explaining that it no longer exists. `stripComments` is what stops the guard
 * from starting an argument with the documentation it depends on. (`blocks/source-gate.ts:34,:97`
 * and `host/policy-enforcement.ts:106` quote codes that ARE still live, so they would be harmless
 * duplicates — which is exactly why this hole would have gone unnoticed but for the fifth.)
 */
function backendSources(): Array<[rel: string, text: string]> {
	return listTsFiles(BACKEND_SRC).map((file): [string, string] => [
		relative(BACKEND_SRC, file).replace(/\.ts$/, '').split(/[\\/]/).join('/'),
		stripComments(readFileSync(file, 'utf-8'))
	]);
}

interface RefusalSlots {
	/** code → `backend/src/<rel>.ts:<line>` sites that mint it. */
	codes: Map<string, string[]>;
	/** `helper("…") in backend/src/<rel>.ts` — a quoted slot that is not a plain wire code. */
	odd: Set<string>;
	/** `helper(expr) in backend/src/<rel>.ts`, DEDUPED per file — what is pinned below. */
	unresolved: Set<string>;
	/** Every unresolved SITE with `file:line`. Its LENGTH is what is pinned. */
	unresolvedSites: string[];
}

/**
 * What the code slot of one refusal call actually is: a readable literal, a readable-but-not-a-code
 * literal, or a runtime value. There is no fourth outcome and nothing is ever dropped.
 *
 * ⛔ A HAND-WRITTEN READER RATHER THAN A REGEX, FOR ONE REASON THE 403/402 SCRAPES ABOVE COULD
 * AFFORD TO IGNORE. `ANY_QUOTE` works up there because those capture `[a-zA-Z0-9_]+` between the
 * quotes, so a real template literal cannot match at all and silently self-excludes. Here the
 * requirement is the opposite: `` conflict(`tpl_${x}`, …) `` MUST be recorded, and recorded as
 * UNRESOLVED (a runtime value) rather than as an odd literal — see `literalOrUnresolved`'s note
 * above, which explains why widening its `['"]` to include the backtick would have put it in the
 * wrong bucket. Reading the quote FIRST and only then asking whether the body interpolates is the
 * only way to accept a backtick-quoted CONSTANT and reject a backtick-quoted EXPRESSION without
 * banning a spelling — which is this repo's documented way of building a guard you turn off by
 * refactoring.
 */
type SlotReading = { kind: 'code' | 'odd' | 'unresolved'; text: string };

function readCodeSlot(slot: string): SlotReading {
	const quote = slot[0];
	if (quote === "'" || quote === '"' || quote === '`') {
		let i = 1;
		let raw = '';
		while (i < slot.length && slot[i] !== quote && slot[i] !== '\n') {
			if (slot[i] === '\\') {
				raw += slot[i + 1] ?? '';
				i += 2;
				continue;
			}
			raw += slot[i];
			i++;
		}
		// An unterminated (or newline-broken) literal is not something this can read. Unresolved,
		// never guessed at.
		if (slot[i] !== quote) return { kind: 'unresolved', text: slot.split('\n')[0]!.slice(0, 80).trim() };
		if (quote === '`' && raw.includes('${')) return { kind: 'unresolved', text: `\`${raw}\`` };
		return /^[a-zA-Z0-9_]+$/.test(raw)
			? { kind: 'code', text: raw }
			: { kind: 'odd', text: JSON.stringify(raw) };
	}
	// A bare identifier, a member expression, a call, a ternary. Recorded, never resolved.
	return {
		kind: 'unresolved',
		text: (slot.match(/^[^,)\n]{0,80}/)?.[0] ?? '').trim() || '<empty>'
	};
}

/**
 * Every code slot of every `badRequest`/`unprocessable`/`conflict` call in the given sources.
 *
 * ⚠️ `\\s*` AFTER THE OPEN PAREN SPANS NEWLINES, AND THAT IS 24% OF THE INPUT, NOT AN EDGE CASE.
 * Measured on this tree: 37 of the 154 literal call sites are prettier-wrapped with the code on the
 * NEXT line. Twenty codes appear in NO other form — `challenge_closed`, `INVALID_ACTIVE_TENANT_HEADER`,
 * `missing_block_version`, `block_archived`, `xlsx_too_large`, `empty_allowlist`, `api_key_required`
 * among them — so a same-line-only regex derives 82 codes instead of 102 and quietly stops guarding
 * a fifth of the surface. `REFUSAL_CODE_FLOOR` is set at 90 specifically so that 82 reds it rather
 * than passing as "a few refusals were deleted".
 *
 * Takes its sources as an argument so the fixture test can drive the identical reader. Testing a
 * parser on a fixture is the only way to test it without waiting for the bug — the lesson the
 * quote-style describe further up paid for.
 */
function refusalSlotsIn(sources: Iterable<[string, string]>): RefusalSlots {
	const codes = new Map<string, string[]>();
	const odd = new Set<string>();
	const unresolved = new Set<string>();
	const unresolvedSites: string[] = [];
	for (const [rel, text] of sources) {
		for (const helper of REFUSAL_HELPERS) {
			// `\b` and no dot-prefix allowance is correct here and was checked: there is no
			// `http.badRequest(` anywhere in the tree, no aliased import, and no re-export under
			// another name — every consumer uses a plain named import from `utils/http`. The helper
			// DEFINITIONS are `export const badRequest = (` (a ` = ` before the paren), so they do not
			// match and need no exclusion; `utils/http.ts`'s only hits are its two real internal
			// `badRequest('invalid_json', …)` calls.
			for (const m of text.matchAll(new RegExp(`\\b${helper}\\(\\s*`, 'g'))) {
				const where = `backend/src/${rel}.ts`;
				// The CALL's line, not the literal's — for a wrapped call they differ by one, and the
				// reader is looking for the throw.
				const site = `${where}:${text.slice(0, m.index!).split('\n').length}`;
				const read = readCodeSlot(text.slice(m.index! + m[0].length, m.index! + m[0].length + 400));
				if (read.kind === 'code') {
					if (!codes.has(read.text)) codes.set(read.text, []);
					codes.get(read.text)!.push(site);
				} else if (read.kind === 'odd') {
					odd.add(`${helper}(${read.text}) in ${where}`);
				} else {
					unresolved.add(`${helper}(${read.text}) in ${where}`);
					unresolvedSites.push(`${helper}(${read.text}) at ${site}`);
				}
			}
		}
	}
	return { codes, odd, unresolved, unresolvedSites };
}

/**
 * THE SIX throw sites whose code is a runtime value, named so a SEVENTH gets a human decision
 * instead of vanishing.
 *
 * ⛔ THIS IS THE ONE HAND-MAINTAINED LIST IN THIS HALF, AND IT IS SHAPED TO FAIL LOUDLY. A code slot
 * this reader cannot resolve contributes NO code to the derived set — so a new one is, by
 * construction, a refusal that escapes the contract above in complete silence. Pinning the sites
 * (not the codes) converts that silence into a red test whose only honest fix is to go and look at
 * where the literal is minted. `KNOWN_INDIRECT_THROWS` further up does the same job for the
 * submit-path walk and is deliberately keyed the same way — WITHOUT the line number, so that
 * inserting a line above one of them cannot red a guard for a reason unrelated to what it guards.
 *
 * All six verified by hand, 2026-08-24. All six are `unprocessable`; no `badRequest` or `conflict`
 * call anywhere has a non-literal code:
 *   1. `blocks/authoring-service.ts:390` — `unprocessable(code, …)`, a `const code` hoisted out of
 *      the argument list at :386 (`noTests ? 'tests_required' : 'tests_failing'`). Both literals ARE
 *      catalogued in `VALIDATION_MESSAGES`; this reader simply cannot see them, and the hoist's own
 *      comment says so.
 *   2. `host/run-controller.ts:938` — `unprocessable(violation.code, …)`, minted as a
 *      `code: 'literal'` property on the returned violation in `host/run-policy.ts` (:74
 *      `policy_network_blocked`, :99 and :114 `policy_pii_violation`). Both catalogued.
 *   3. `routes/solutions.ts:491` — `unprocessable(policyViolation.code, …)`, the same two literals
 *      from the same file. (The submit-path walk above resolves this one via its form-4 rule.)
 *   4-6. `routes/delivery.ts:423`, `:433`, `:441` — three `unprocessable(err.code, err.message)` in
 *      `precheckTarget`, re-throwing `DeliveryConfigError` / `EgressBlockedError`. Their literals
 *      live in `host/delivery/{jira,azure-devops,fr}.ts` and `host/egress-guard.ts` and are all in
 *      `NOT_LOCALIZED_CODES` (`delivery_target_incomplete`, `delivery_target_credentials_missing`,
 *      `delivery_target_credentials_invalid`, `egress_bad_target`) — which the reverse-direction
 *      grep below is what actually keeps honest.
 *
 * ⚠️ THE THREE `delivery.ts` SITES COLLAPSE TO ONE ENTRY, because the key carries the file and not
 * the line. That is why the COUNT is asserted separately: deleting two of the three would leave this
 * list unchanged and only the count would notice.
 */
const KNOWN_UNRESOLVED_REFUSAL_SLOTS = [
	'unprocessable(code) in backend/src/blocks/authoring-service.ts',
	'unprocessable(err.code) in backend/src/routes/delivery.ts',
	'unprocessable(policyViolation.code) in backend/src/routes/solutions.ts',
	'unprocessable(violation.code) in backend/src/host/run-controller.ts',
	// Added by #316: a typo'd connector URL used to reach the bare-500 catch-all because
	// `EgressBlockedError extends Error`, not `HttpError`. It is now caught at the call site and
	// mapped to a 422. The code IS catalogued (`egress_bad_target` → `delivery_error_egress_bad_target`
	// in all 8 catalogs, mapped at error-message.ts:820) — it is only the SCRAPE that cannot see it,
	// because the literal lives on the error class rather than at the throw site.
	'unprocessable(e.code) in backend/src/routes/connectors.ts'
];
/** Sites, not entries — see the note above on why the two differ. Re-measured 2026-08-25
 *  after #316 added the connectors catch (6 → 7). */
const KNOWN_UNRESOLVED_REFUSAL_SITES = 7;

/**
 * ⛔ 90, WHILE THE TREE MEASURES 102. A floor, not a count: pinning 102 would red this guard every
 * time a refusal is legitimately deleted, and the fix under pressure is always to edit the number —
 * which trains the next reader to edit it without reading it. What it has to catch is the failure
 * this repo keeps meeting: a regex that silently matches NOTHING makes every negative assertion
 * below trivially true and the guard permanently, uselessly green. 90 also sits ABOVE the 82 a
 * same-line-only regex would derive, so losing the multi-line half reds here too.
 */
const REFUSAL_CODE_FLOOR = 90;

describe('every 400/422/409 code in backend/src is catalogued or honestly registered', () => {
	const scrape = refusalSlotsIn(backendSources());
	const derived = [...scrape.codes.keys()].sort();

	it('reads every quote style, the wrapped shape, and every unreadable slot — on a fixture', () => {
		// ⛔ THE FIXTURE IS NOT BELT-AND-BRACES HERE, IT IS THE **ONLY** PROOF OF THE QUOTE HALF.
		// Measured 2026-08-24: all 154 literal code slots in `backend/src` today use `'` single
		// quotes — ZERO double-quoted, ZERO backtick. So the real tree cannot distinguish a
		// quote-agnostic reader from a single-quote-only one, and a scrape that silently handled only
		// `'…'` would derive the same 102 codes and look perfect. There is no prettier and no eslint
		// config anywhere in this repo, so nothing normalises quote style in `backend/` and a
		// double-quoted literal is an ordinary thing for the next author to write — the exact hole
		// `ANY_QUOTE` above documents having measured on the 403/402 scrapes, where it DID ship
		// uncatalogued codes with all sixteen assertions green.
		const FIXTURE = [
			"throw badRequest('b_single', 'x');",
			'throw badRequest("b_double", \'x\');',
			'throw badRequest(`b_backtick`, \'x\');',
			"throw unprocessable('u_single', 'x');",
			'throw unprocessable("u_double", \'x\');',
			'throw unprocessable(`u_backtick`, \'x\');',
			"throw conflict('c_single', 'x');",
			'throw conflict("c_double", \'x\');',
			'throw conflict(`c_backtick`, \'x\');',
			// The prettier-wrapped shape — 37 of the 154 real sites, and 20 codes that exist in no
			// other form. See `refusalSlotsIn`.
			"throw unprocessable(\n  'u_wrapped',\n  'x'\n);",
			'throw conflict(\n\t"c_wrapped_double",\n\t\'x\'\n);',
			// ⛔ A CODE NAMED ONLY IN A COMMENT IS NOT AN EMISSION. Live example in the tree:
			// `ai/tool-rendezvous.ts:217` documents a REMOVED code.
			"// throw badRequest('b_line_commented', 'x');",
			'/* throw conflict("c_block_commented", "x"); */',
			// Unreadable code slots: each must be RECORDED, never dropped and never half-resolved.
			'throw badRequest(SOME_CONST, "x");',
			"throw unprocessable(err.code, 'x');",
			'throw conflict(`tpl_${x}`, "x");',
			'throw badRequest(noTests ? "a_yes" : "a_no", "x");',
			// A quoted slot that is not a wire code at all — the third bucket.
			"throw conflict('not a code', 'x');"
		].join('\n');

		const fixture = refusalSlotsIn([['fixture', stripComments(FIXTURE)]]);

		expect([...fixture.codes.keys()].sort()).toEqual([
			'b_backtick',
			'b_double',
			'b_single',
			'c_backtick',
			'c_double',
			'c_single',
			'c_wrapped_double',
			'u_backtick',
			'u_double',
			'u_single',
			'u_wrapped'
		]);
		// Neither a commented-out throw nor a ternary ARM may be mistaken for an emitted code. The
		// ternary is the sharper of the two: reading `"a_yes"` off it would invent a code the wire
		// carries only half the time and hide the fact that the slot is a runtime value.
		for (const ghost of ['b_line_commented', 'c_block_commented', 'a_yes', 'a_no'])
			expect([...fixture.codes.keys()], `${ghost} must not be read as an emitted code`).not.toContain(ghost);

		expect([...fixture.odd]).toEqual(['conflict("not a code") in backend/src/fixture.ts']);
		expect([...fixture.unresolved].sort()).toEqual([
			'badRequest(SOME_CONST) in backend/src/fixture.ts',
			'badRequest(noTests ? "a_yes" : "a_no") in backend/src/fixture.ts',
			'conflict(`tpl_${x}`) in backend/src/fixture.ts',
			'unprocessable(err.code) in backend/src/fixture.ts'
		]);
	});

	it('derives the whole tree and not a fraction of it', () => {
		// ⛔ THE NON-VACUITY FLOOR. Every other assertion in this describe is NEGATIVE — "no code is
		// homeless", "no register entry is dead" — and a negative assertion over an EMPTY set is
		// trivially true. A regex that stopped matching (the helpers renamed, `backend/src` moved,
		// `listTsFiles` returning nothing) would leave this whole half permanently green while
		// guarding nothing. That is not a hypothetical in this repo; it is the documented failure
		// mode this file already carries three other floors for.
		expect(
			derived.length,
			`Only ${derived.length} 400/422/409 codes scraped from backend/src (floor ${REFUSAL_CODE_FLOOR}, ` +
				`measured 102 on 2026-08-24). Either a large number of refusals were deleted, or — far ` +
				`more likely — the scrape broke: check that badRequest/unprocessable/conflict are still ` +
				`the helper names, that BACKEND_SRC still resolves, and that the multi-line \\s* still ` +
				`spans newlines. Do NOT lower this floor to get green.`
		).toBeGreaterThanOrEqual(REFUSAL_CODE_FLOOR);

		// One anchor per SHAPE, so a shape that stops matching reds on its own rather than being
		// masked by the other two still working — a bare count cannot do that.
		expect(derived, 'badRequest, same-line single quotes').toContain('csv_no_header');
		expect(derived, 'unprocessable, same-line').toContain('flow_archived');
		expect(derived, 'conflict, same-line').toContain('slug_taken');
		// ⚠️ THESE TWO EXIST **ONLY** IN THE PRETTIER-WRAPPED FORM (code on the next line), so they
		// are the anchors that die first if the newline span is lost.
		expect(derived, 'wrapped-only: middleware/admin-guards.ts:154').toContain(
			'INVALID_ACTIVE_TENANT_HEADER'
		);
		expect(derived, 'wrapped-only: routes/solutions.ts:460').toContain('challenge_closed');
	});

	it('reports a quoted slot that is not a wire code instead of dropping it', () => {
		// ⛔ EMPTY IS AN ASSERTION HERE, NOT AN ABSENCE — the same third bucket the submit-path
		// scrape keeps. Measured: zero today, all 154 literal slots are plain `snake_case` (one
		// SCREAMING_SNAKE). If this ever fires, go and look at the site; do NOT widen the wire-code
		// pattern until it passes, because the pattern is what stops a prose string being demanded a
		// translation.
		expect([...scrape.odd]).toEqual([]);
	});

	it('pins the six throw sites whose code is a runtime value', () => {
		// ⛔ AN UNRESOLVED SLOT CONTRIBUTES NO CODE, so a seventh one is a refusal that leaves the
		// contract below in silence. Both halves are asserted because they fail differently: the
		// LIST catches a new file, the COUNT catches a new site in a file already listed (the three
		// `err.code` throws in routes/delivery.ts share one entry).
		expect(
			[...scrape.unresolved].sort(),
			`A badRequest/unprocessable/conflict call takes its code from a runtime value, so the ` +
				`literal is not at the throw site and the scrape below cannot see it.\n` +
				`Sites: ${scrape.unresolvedSites.join(', ')}\n` +
				`Go and find where that code is MINTED, confirm it is a key of VALIDATION_MESSAGES or of ` +
				`NOT_LOCALIZED_CODES, and only then add the site here. Adding it without checking is the ` +
				`one edit that turns this guard off.`
		).toEqual([...KNOWN_UNRESOLVED_REFUSAL_SLOTS].sort());
		expect(
			scrape.unresolvedSites.length,
			`${scrape.unresolvedSites.length} runtime-valued code slots, expected ` +
				`${KNOWN_UNRESOLVED_REFUSAL_SITES}. A new one in an ALREADY-LISTED file does not change ` +
				`the list above — only this count sees it.\nSites: ${scrape.unresolvedSites.join(', ')}`
		).toBe(KNOWN_UNRESOLVED_REFUSAL_SITES);
		// …and every recorded site carries a real file:line, so the messages above can point somewhere.
		for (const site of scrape.unresolvedSites)
			expect(site).toMatch(/ at backend\/src\/.+\.ts:\d+$/);
	});

	// ── the contract ─────────────────────────────────────────────────────────────────────────
	it('is a key of VALIDATION_MESSAGES or of NOT_LOCALIZED_CODES (else English ships again)', () => {
		const catalogued = new Set(VALIDATION_MESSAGE_CODES);
		const registered = new Set(NOT_LOCALIZED_CODES.keys());
		const homeless = derived.filter((c) => !catalogued.has(c) && !registered.has(c));
		expect(
			homeless,
			homeless.length
				? `backend/src can refuse with 400/422/409 code(s) that are in NEITHER map, so ` +
						`writeErrorText() renders the backend's ENGLISH sentence verbatim in all 8 locales ` +
						`and nothing else in either project goes red about it:\n` +
						homeless.map((c) => `  ${c} — minted at ${scrape.codes.get(c)!.join(', ')}`).join('\n') +
						`\nPick ONE of these for each, in frontend/src/lib/api/error-message.ts:\n` +
						`  · the reader is an ordinary tenant author or admin who chose nothing and can fix ` +
						`nothing by re-reading the sentence → add a VALIDATION_MESSAGES entry with ` +
						`author-facing copy, and add its message key to ALL EIGHT catalogs ` +
						`(frontend/messages/*.json — catalogs.test.ts enforces key parity);\n` +
						`  · the sentence quotes something the reader TYPED and no static translation can ` +
						`carry it, or the path is unreachable / service-to-service → add a ` +
						`NOT_LOCALIZED_CODES entry. The reason must be the MEASURED one, naming the emitting ` +
						`file:line or the screen ("deferred: /governance, platform-admin only ` +
						`(routes/governance.ts:194)"). "n/a" is not a reason, and a wrong reason here is a ` +
						`wrong GREEN — worse than the gap it papers over.\n` +
						`⛔ Do NOT delete this assertion and do NOT widen it to "…or looks admin-only". The ` +
						`fall-through to the English sentence is deliberate and stays; what must not be ` +
						`allowed back is the gap being INVISIBLE.`
				: undefined
		).toEqual([]);
	});

	// ── the reverse direction: rot in the register itself ────────────────────────────────────
	//
	// ⛔ A STALE ENTRY IS A HOLE THAT CLAIMS TO BE A DECISION. The assertion above is satisfied by a
	// code being named in `NOT_LOCALIZED_CODES` — so an entry for a code the backend no longer emits
	// costs nothing to keep and quietly grows the excused set. Worse, the next author reads the
	// register as a survey of what the product can refuse with, and it is wrong. This is the same
	// grep, and the same argument, that `NON_SUBMIT_PATH_CODES itself does not rot` runs above; it is
	// copied deliberately rather than shared because the two lists fail for different reasons.
	//
	// ⚠️ A GREP, NOT A REACHABILITY PROOF, and it must not be read as one. It says the literal exists
	// in non-comment backend source. It does not say the screen named in the entry's reason still
	// reaches it. That is what makes the reason text — not this test — the thing a reader has to
	// check by hand.
	// ── the ratchet: the tenant-admin block does not come back ───────────────────────────────
	//
	// ⛔ THE TWO ASSERTIONS ABOVE ARE SATISFIED BY EITHER OUTCOME, WHICH IS WHY THIS EXISTS. "every
	// code is catalogued OR registered" treats a `NOT_LOCALIZED_CODES` entry as a perfectly good home
	// — that is the whole design — so re-registering `last_admin` tomorrow with a plausible reason
	// ("deferred: /(tenant)/members, tenant-admin only") would restore the English refusal on a
	// customer's own workspace screen and every test in this file would stay green. That is exactly
	// how these seventeen sat there in the first place.
	//
	// ⛔ AND THE REASON THEY DO NOT BELONG THERE IS NOT A MATTER OF TASTE. The register's test for
	// entry is WHO THE SENTENCE IS AIMED AT. `platform-admin only` is a real bound: nobody outside
	// the vendor opens /governance. `tenant-admin only` is not a bound at all — a tenant admin is an
	// ordinary paying customer configuring their OWN workspace on /(tenant)/{members,sso,
	// llm-settings,delivery}, and on /solutions/[id] pressing Forward. Seven of the eight locales
	// cannot read the English sentence they were being shown, and nl is the demo language.
	//
	// ⚠️ THIS IS A RATCHET, NOT A LAW OF NATURE. If a code below genuinely stops being reachable from
	// a tenant screen, the honest edit is to delete it from this list AND from `VALIDATION_MESSAGES`
	// AND from `NON_SUBMIT_PATH_CODES`'s consumers — not to move it back into the register. The
	// `NOT_LOCALIZED_CODES names only codes backend/src still emits` grep below is what catches the
	// case where the backend stopped emitting it altogether.
	const TENANT_ADMIN_LOCALIZED: readonly string[] = [
		// /(tenant)/members — routes/tenant-users.ts + services/provisioning.ts
		'last_tenant_admin',
		'cannot_offboard_self',
		'email_in_other_tenant',
		'already_member',
		'seats_full',
		'user_offboarded', // the 409 arm; the 403 arm stays with FORBIDDEN_MESSAGES
		// /(tenant)/sso — services/sso-service.ts
		'idp_exists',
		// /(tenant)/llm-settings — routes/llm-settings.ts
		'invalid_model',
		'model_not_allowlisted',
		'api_key_required',
		// /(tenant)/delivery + /solutions/[id] forward/retry — routes/delivery.ts + host/delivery/*
		'delivery_target_name_taken',
		'delivery_target_not_configured',
		'delivery_not_retriable',
		'delivery_target_incomplete',
		'delivery_target_credentials_missing',
		'delivery_target_credentials_invalid',
		'egress_bad_target'
	];

	it('the 17 reachable tenant-admin refusals are CATALOGUED, not registered', () => {
		const catalogued = new Set(VALIDATION_MESSAGE_CODES);
		const uncatalogued = TENANT_ADMIN_LOCALIZED.filter((c) => !catalogued.has(c));
		expect(
			uncatalogued,
			uncatalogued.length
				? `These reach an ORDINARY CUSTOMER's tenant admin on their own workspace screens and ` +
						`have no VALIDATION_MESSAGES entry, so writeErrorText renders the backend's ENGLISH ` +
						`sentence to a Dutch reader:\n  ${uncatalogued.join('\n  ')}\n` +
						`Do NOT answer this by adding a NOT_LOCALIZED_CODES entry — see the ⛔ block above.`
				: undefined
		).toEqual([]);

		const registered = [...NOT_LOCALIZED_CODES.keys()];
		const regressed = TENANT_ADMIN_LOCALIZED.filter((c) => registered.includes(c));
		expect(
			regressed,
			regressed.length
				? `${JSON.stringify(regressed)} went BACK into NOT_LOCALIZED_CODES. "tenant-admin only" ` +
						`is not the bound "platform-admin only" is — see the ⛔ block above this test.`
				: undefined
		).toEqual([]);

		// Non-vacuity, both halves: the list must be the real seventeen, and it must be measuring a
		// register that is actually populated (an empty one makes the second filter trivially true).
		// ⚠️ 15, NOT THE 17 THE BLOCK HELD. `platform_role_forbidden` and
		// `delivery_target_kind_unsupported` stayed in the register — MEASURED unreachable, not
		// deferred (the register carries the measurement). They are deliberately NOT on this list:
		// a ratchet demanding copy for a refusal the product cannot emit would force the false
		// coverage claim `VALIDATION_MESSAGES`'s doctrine bars.
		// 17 since the CP-owned tenancy change: `last_admin` → `last_tenant_admin`, `email_exists`
		// retired, and the invite refusals `email_in_other_tenant` / `already_member` / `seats_full` added.
		expect(TENANT_ADMIN_LOCALIZED).toHaveLength(17);
		expect(new Set(TENANT_ADMIN_LOCALIZED).size).toBe(17);
		expect(NOT_LOCALIZED_CODES.size).toBeGreaterThan(20);
	});

	it('…and backend/src still emits every one of them', () => {
		// ⛔ WITHOUT THIS, THE RATCHET ABOVE SURVIVES THE CODE BEING DELETED. A `VALIDATION_MESSAGES`
		// entry for a refusal the backend can no longer raise is dead copy that claims coverage — the
		// same false claim the register's own rot-guard below is written against, and the reason this
		// runs the identical grep rather than trusting the entry.
		//
		// ⚠️ FOUR ARE MINTED INDIRECTLY and would not be found by a `badRequest|unprocessable|conflict`
		// scrape at all: the three `delivery_target_*` config codes come from `DeliveryConfigError` in
		// host/delivery/{jira,azure-devops,fr}.ts and `egress_bad_target` from host/egress-guard.ts,
		// all re-thrown as `unprocessable(err.code, …)`. A plain literal grep is what sees them.
		const backendText = backendSources()
			.map(([, text]) => text)
			.join('\n');
		const gone = TENANT_ADMIN_LOCALIZED.filter(
			(c) => !['"', "'", '`'].some((q) => backendText.includes(`${q}${c}${q}`))
		);
		expect(
			gone,
			gone.length
				? `${JSON.stringify(gone)} has localized copy but the literal appears nowhere in ` +
						`backend/src outside a comment. Either the backend stopped emitting it (delete the ` +
						`VALIDATION_MESSAGES entry and its eight catalog strings) or it was renamed (rename ` +
						`both sides). Do not leave the entry as a coverage claim nothing can contradict.`
				: undefined
		).toEqual([]);
		expect(backendText.length, 'backend/src read as (almost) empty').toBeGreaterThan(100_000);
	});

	// ── the SECOND ratchet: the run path does not go back into the register ─────────────────────
	//
	// ⛔ SAME MECHANISM AS `TENANT_ADMIN_LOCALIZED` ABOVE, SAME REASON, DIFFERENT POPULATION — and it
	// is needed for exactly the argument that block makes. "Every code is catalogued OR registered"
	// treats a `NOT_LOCALIZED_CODES` entry as a perfectly good home, so re-registering `sandbox_busy`
	// tomorrow with a plausible-sounding reason would put the English sentence back in front of a
	// Dutch author and leave every other assertion in this file green. These six sat there for a whole
	// lane under reasons that ALREADY SAID they were not admin-only; the register recorded the
	// correction and nothing enforced it.
	//
	// ⛔ AND "ADMIN-ONLY" IS FALSE OF ALL SIX, MEASURED. `sandbox_busy` (host/run-controller.ts:1198)
	// fires on an ordinary DOUBLE-CLICK OF RUN. `sandbox_suspended` (:1022, :1192),
	// `data_validation_failed` (:1137), `not_resumable` and `sandbox_admin_suspended`
	// (routes/sandboxes.ts:403 / :398, `POST /api/sandboxes/me/resume`, no admin guard) all reach any
	// member. `lint_failed` (blocks/source-gate.ts:75, blocks/authoring-service.ts:345) needs
	// developer, which is the role an AUTHOR holds — not a platform operator's bound.
	//
	// ⚠️ RATCHET, NOT A LAW OF NATURE — the same escape clause the block above carries: if one of
	// these genuinely stops being reachable, delete it from this list AND from `VALIDATION_MESSAGES`.
	// Do not move it back into the register.
	//
	// ⚠️ `invalid_idempotency_key` IS DELIBERATELY NOT ON THIS LIST. It was the seventh member of the
	// same register block and it is the one that stayed — measured UNREACHABLE from the SPA
	// (frontend/src/lib/api/runs.ts:122 and :135 both send `crypto.randomUUID()`, 36 chars, against a
	// >200 guard). A ratchet demanding copy for a refusal the product cannot emit would force exactly
	// the false coverage claim `VALIDATION_MESSAGES`'s doctrine bars — the same reason
	// `platform_role_forbidden` and `delivery_target_kind_unsupported` are off the list above.
	const RUN_PATH_LOCALIZED: readonly string[] = [
		// /build + /solutions/[id] Run — host/run-controller.ts
		'sandbox_suspended',
		'sandbox_busy',
		'data_validation_failed',
		// the /build + /solutions/[id] resume banner — routes/sandboxes.ts, POST /api/sandboxes/me/resume
		'not_resumable',
		'sandbox_admin_suspended',
		// /block-edit save + publish and the /blocks + /build create paths
		'lint_failed'
	];

	it('the 6 reachable run-path refusals are CATALOGUED, not registered', () => {
		const catalogued = new Set(VALIDATION_MESSAGE_CODES);
		const uncatalogued = RUN_PATH_LOCALIZED.filter((c) => !catalogued.has(c));
		expect(
			uncatalogued,
			uncatalogued.length
				? `These reach an ORDINARY AUTHOR pressing Run or Save on their own work and have no ` +
						`VALIDATION_MESSAGES entry, so writeErrorText renders the backend's ENGLISH sentence ` +
						`to a Dutch reader:\n  ${uncatalogued.join('\n  ')}\n` +
						`Do NOT answer this by adding a NOT_LOCALIZED_CODES entry — see the ⛔ block above.`
				: undefined
		).toEqual([]);

		const registered = [...NOT_LOCALIZED_CODES.keys()];
		const regressed = RUN_PATH_LOCALIZED.filter((c) => registered.includes(c));
		expect(
			regressed,
			regressed.length
				? `${JSON.stringify(regressed)} went BACK into NOT_LOCALIZED_CODES. Every one of these ` +
						`already sat there once under a reason beginning "deferred (⚠️ NOT admin-only)" — the ` +
						`register had measured that they reach an ordinary author and the English shipped anyway.`
				: undefined
		).toEqual([]);

		// Non-vacuity, both halves — the list must be the real six, and it must be measuring a register
		// that is actually populated (an empty one makes the second filter trivially true).
		expect(RUN_PATH_LOCALIZED).toHaveLength(6);
		expect(new Set(RUN_PATH_LOCALIZED).size).toBe(6);
		expect(NOT_LOCALIZED_CODES.size).toBeGreaterThan(20);
		// …and the seventh member of that block really did stay behind, or the "six" above is a story
		// about a block that emptied completely rather than about a measured split.
		expect(NOT_LOCALIZED_CODES.has('invalid_idempotency_key')).toBe(true);
	});

	it('…and backend/src still emits every run-path code too', () => {
		// The same rot-guard the tenant-admin ratchet carries, for the same reason: a
		// `VALIDATION_MESSAGES` entry for a refusal the backend can no longer raise is dead copy that
		// claims coverage. All six are plain literals at their throw sites, so a literal grep sees them.
		const backendText = backendSources()
			.map(([, text]) => text)
			.join('\n');
		const gone = RUN_PATH_LOCALIZED.filter(
			(c) => !['"', "'", '`'].some((q) => backendText.includes(`${q}${c}${q}`))
		);
		expect(
			gone,
			gone.length
				? `${JSON.stringify(gone)} has localized copy but the literal appears nowhere in ` +
						`backend/src outside a comment. Either the backend stopped emitting it (delete the ` +
						`VALIDATION_MESSAGES entry and its eight catalog strings) or it was renamed (rename ` +
						`both sides). Do not leave the entry as a coverage claim nothing can contradict.`
				: undefined
		).toEqual([]);
		expect(backendText.length, 'backend/src read as (almost) empty').toBeGreaterThan(100_000);
	});

	it('NOT_LOCALIZED_CODES names only codes backend/src still emits', () => {
		const backendText = backendSources()
			.map(([, text]) => text)
			.join('\n');
		// ⚠️ ANY QUOTE STYLE COUNTS AS "still emitted", for the reason the sibling grep above records
		// having measured: rewriting a live literal to double quotes must not produce an instruction
		// to delete eight catalog strings over a quote style.
		const gone = [...NOT_LOCALIZED_CODES.keys()].filter(
			(c) => !['"', "'", '`'].some((q) => backendText.includes(`${q}${c}${q}`))
		);
		expect(
			gone,
			gone.length
				? `NOT_LOCALIZED_CODES names ${JSON.stringify(gone)}, but the literal does not appear ` +
						`anywhere in backend/src outside a comment. The register claims a DECISION about a ` +
						`refusal the backend no longer emits, which inflates the excused set and misleads the ` +
						`next reader about what the product can refuse with.\n` +
						`Fix: delete the entry. Do NOT re-word its reason to keep it.\n` +
						`⚠️ Four members are minted INDIRECTLY and are the ones to check first if this ` +
						`surprises you — delivery_target_incomplete / _credentials_missing / ` +
						`_credentials_invalid (host/delivery/{jira,azure-devops,fr}.ts, re-thrown as ` +
						`unprocessable(err.code) at routes/delivery.ts:423/:433) and egress_bad_target ` +
						`(host/egress-guard.ts, :441).`
				: undefined
		).toEqual([]);
		// POSITIVE HALVES: both sides of the grep must be real. An empty register satisfies the
		// filter trivially, and an unreadable BACKEND_SRC makes it compare nothing against nothing.
		// (The register's own quality — a real reason on every entry — is asserted in
		// error-message.test.ts; this is only the non-vacuity THIS grep needs.)
		// ⚠️ THE PARAGRAPH BELOW IS THE PREVIOUS LANE'S COUNT (41 → 27) and is kept for its lesson, not
		// its number. The live figure is 22 — see the block on the exact assertion further down.
		//
		// ⚠️ 41 → 27: the `── tenant-admin screens ──` block (17 entries) emptied — 15 into
		// `VALIDATION_MESSAGES`, 2 back into the register's "not deferrals at all" section as measured
		// UNREACHABLE (those 2 stay IN the Map, so they do not reduce the count) — and `no_metering_actor`
		// was ADDED by the same change: 41 − 15 + 1 = 27. The 28th is the 503 below.
		//
		// ⛔ THIS LINE SAID "41 → 26" AND THE ONE IN `error-message.ts` SAID THE SAME. Both were wrong:
		// the live Map held 27. Nothing caught it because the only assertion below was a `> 20` floor,
		// which 26, 27 and 41 all satisfy — a comment stating a number that no test reads is a claim
		// with no guard, and it drifted on the very commit that wrote it.
		//
		// So the exact size is asserted now, as well as the floor. The floor stays because it says
		// something different: it is the NON-VACUITY guard for the grep above (an empty register would
		// make that filter pass trivially), and it must survive a legitimate re-count. The exact
		// assertion is the anti-drift guard. Every figure here was measured with
		// `NOT_LOCALIZED_CODES.size`, the "before" against the same Map at the parent commit.
		// ⚠️ 27 → 21, THE RUN-PATH LANE. The `── ⚠️ NOT admin-only: the run path ──` block held SEVEN
		// entries, every one of them reasoned "deferred (⚠️ NOT admin-only)". SIX moved into
		// `VALIDATION_MESSAGES` (`sandbox_suspended`, `sandbox_busy`, `data_validation_failed`,
		// `not_resumable`, `sandbox_admin_suspended`, `lint_failed`); the seventh,
		// `invalid_idempotency_key`, STAYS in the register with a corrected reason — measured
		// unreachable from the SPA, both callers send `crypto.randomUUID()`. 27 − 6 = 21, and 21 is
		// what `NOT_LOCALIZED_CODES.size` read on THAT lane's Map, not what the subtraction predicted.
		//
		// ⛔ 27 → 28, THE TENANT-LIFECYCLE LANE, AND THE 503 WORK MOVED THIS NUMBER TWICE IN OPPOSITE
		// DIRECTIONS — do not read either step as a no-op. Teaching this file to scrape
		// `serviceUnavailable(` / `new HttpError(503,` surfaced a SECOND 503 the tree already emitted —
		// `signup_queue_full`,
		// backend/src/routes/onboarding.ts:129 — with no copy in any of the eight locales. It was
		// registered here (28). Then eight locales of `error_signup_queue_full` were written and it was
		// CATALOGUED in `SERVICE_UNAVAILABLE_MESSAGES` instead, which took it straight back out (27) —
		// and left the branch RED, because the register entry that the DISJOINT case below asserts is
		// present had been deleted. Then the copy was MEASURED to reach no reader — the only SPA caller
		// is `void adminApi.notifySelf(…).catch(() => {})` at stores/auth.svelte.ts:75, fire-and-forget
		// BY DESIGN so a queue outage can never block a login — so all eight catalog strings were
		// deleted and the register entry restored (28). A code must never sit in BOTH maps, which the
		// `SERVICE_UNAVAILABLE_MESSAGES and NOT_LOCALIZED_CODES are DISJOINT` case in the 503 describe
		// above is what enforces.
		//
		// ⛔ AND THE INTEGRATED FIGURE IS NEITHER 21 NOR 28 — IT IS 22, WHICH IS THE WHOLE REASON THIS
		// LINE CONFLICTS ON EVERY MERGE. The two lanes moved the SAME Map in OPPOSITE directions: the
		// run path took SIX entries out, the 503 work put ONE (`signup_queue_full`) back in. 21 is
		// true of the run-path lane in isolation, 28 of the tenant-lifecycle lane in isolation, and
		// both are false of the merged tree — taking either side wholesale is exactly the silent
		// revert this file's own advice text warns about. RECOUNTED by reading the entries of
		// `NOT_LOCALIZED_CODES` in error-message.ts after the rebase → 22. Never one side's number,
		// and never 21 + 1 done in my head.
		//
		// ⛔ 22 → 23, AND THE ENTRY IS THIS BRANCH'S OWN. The `?source=` filter added to GET
		// /api/connectors mints `invalid_source` (backend/src/routes/connectors.ts:623), which the
		// contract case above went red on. It is registered rather than catalogued because the page
		// MINTS the param — `sourceFromQuery` yields a member of `['postgres','storage','http']` or
		// nothing, and /connectors never reads `?source=` off its own url — so no reader can reach the
		// refusal. RECOUNTED on the live Map after the edit, not 22 + 1 in my head.
		// ⛔ 23 → 24, AND THE ENTRY IS THIS BRANCH'S OWN. Splitting the self-signup queue cap into a
		// total ceiling and an anonymous sub-quota mints a SECOND 503,
		// `signup_queue_anonymous_full` (backend/src/routes/onboarding.ts:192), which the contract
		// case above went red on. It is registered rather than catalogued for a STRONGER reason than
		// its sibling: it is thrown only to a caller who is neither authenticated nor domain-matched,
		// and the one SPA caller reaches the route through `authFetch` with a bearer token, so it sits
		// on the reserved side of the quota by construction and cannot provoke the code at all.
		// RECOUNTED on the live Map after the edit, not 23 + 1 in my head.
		// ⛔ 24 → 26, BOTH THIS BRANCH'S OWN (early-access signup, 2026-10-14). Turnstile mints two
		// 503s, `turnstile_unconfigured` and `turnstile_unavailable` (backend/src/services/turnstile.ts).
		// Registered rather than catalogued: the first is thrown only to an ANONYMOUS notify-self and
		// the second only when a token was sent — the SPA's one caller is authenticated, sends no
		// token, and swallows failures. RECOUNTED on the live Map after the edit.
		// ⛔ 26 → 27 (voting-cycle cadence, 2026-10-14): `cycle_off`, a 422 from the super_admin-only
		// POST /api/cycle/advance, which has no screen. RECOUNTED on the live Map after the edit.
		// ⛔ 27 → 28 (same branch, review fix D): `cycle_kind_mismatch`, a 400 from the same route when
		// the period key's kind is not the effective cadence. RECOUNTED on the live Map after the edit.
		// ⛔ 28 → 29 (early-access v2, 2026-10-19): `approval_in_progress`, a 409 from the platform-admin
		// onboarding approve/reject while another decider holds the claim. RECOUNTED on the live Map.
		// ⛔ 29 → 30 (approve-claim ceiling fix, 2026-10-19): `approval_claim_lost`, a 409 from the
		// platform-admin onboarding approve when its run lost the claim or hit the ceiling.
		// ⛔ 30 → 31 (reject-offboard fix, 2026-10-19): `signup_workspace_in_use`, a 409 from the
		// platform-admin onboarding reject when the workspace an aborted approve founded is in use.
		// ⛔ 31 → 33 (reject-repair resolve fix, 2026-10-20): `reject_repair_in_progress` and
		// `reject_repair_not_resolvable`, 409s from the platform-admin "Resolve manually" on /onboarding.
		// RECOUNTED on the live Map.
		// ⛔ 33 → 34 (reject-repair live-access fix, 2026-10-20): `reject_repair_live_access_unacknowledged`,
		// a 422 from the same "Resolve manually" when the close would leave the requester's access live
		// and the body lacks `acknowledgeLiveAccess` (the screen's checkbox always sends it).
		expect(
			NOT_LOCALIZED_CODES.size,
			'NOT_LOCALIZED_CODES changed size. That is fine — but the comments above and in ' +
				'error-message.ts state the figure, so UPDATE BOTH to what you just measured. Do not ' +
				'edit this number without re-reading them; the last drift happened exactly here.'
		).toBe(34);
		expect(
			NOT_LOCALIZED_CODES.size,
			'NOT_LOCALIZED_CODES is (nearly) empty — the grep above proved nothing, and an empty ' +
				'register also makes the contract assertion above weaker than it reads'
		).toBeGreaterThan(20);
		expect(
			backendText.length,
			'backend/src read as (almost) empty — the grep above proved nothing'
		).toBeGreaterThan(100_000);
	});
});
