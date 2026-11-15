// src/lib/stores/licenseGate.no-prose.test.ts — the licence gate store holds STATE, never SENTENCES.
//
// ⛔ THE DEFECT THIS PINS, AND IT IS NOT THE ONE THE STORE'S OWN COMMENT USED TO CLAIM.
// `LicenseGate` carried a `get statusMessage()` that composed the block screen's copy in code:
//
//     `Your license expired on ${formatDate(this.expiresAt)}.`
//     `Your license expires in ${this.daysRemaining} day${this.daysRemaining === 1 ? '' : 's'}.`
//
// Hard-coded English, a hand-rolled `day${s}` plural that no other language inflects that way, and
// a raw ungrouped number — beside a `formatDate` helper written to date it in the reader's locale.
//
// ⚠️ IT HAD NO CONSUMER. A repo-wide grep for `statusMessage` returned this store and its own test
// and NOTHING ELSE. `LicenseBlocked.svelte` composes its heading from `m.license_blocked_heading_*`
// and its body from `m.error_license_*`, and renders no date anywhere on the screen;
// `LicenseExpiringBanner.svelte` renders `m.license_expiring_days({ days })`. So the "un-fixed
// instance of the localization defect on the one screen that is nothing but this sentence" was
// dead code the whole time — and localizing its date made a dead string marginally less wrong
// while documenting it, in a comment, as a live customer-facing bug. That comment is the thing
// most likely to mislead the next reader, which is why the getter and the helper are gone rather
// than fixed.
//
// The rule, stated so it survives the next person: a store that models licence STATE must not be
// able to compose a sentence. The catalog owns every word; the component owns the composition,
// where `locale.current` and paraglide's plural machinery are both in scope.
import { describe, it, expect } from 'vitest';
import { readSource } from '$lib/test/source-scan';

const STORE = 'lib/stores/licenseGate.svelte.ts';

/**
 * ⚠️ EVERY `not.toContain` BELOW IS PAIRED WITH THIS. A source guard whose assertions are all
 * negative reports GREEN when its input is EMPTY — and the first version of `stripComments` really
 * did empty this file's import block (the `$app/*` in its header opened a phantom block comment;
 * see source-scan.test.ts). The anchor makes "the scan returned nothing" a failure rather than a
 * pass.
 */
function storeSource(): string {
	const src = readSource(STORE);
	expect(src, 'the scan returned a file with no class in it — the stripper ate the source').toContain(
		'export class LicenseGate'
	);
	expect(src).toContain("import { authFetch } from '$lib/api/auth-fetch';");
	return src;
}

describe('⛔ licenseGate.svelte.ts composes no reader-facing prose', () => {
	it('imports no message catalog and no display formatter — it CANNOT phrase anything', () => {
		// `formatDate` needed both: `$lib/paraglide/runtime` for `getLocale()` and `$lib/utils/format`
		// for `fullDate`. Restoring either is the first move of a revert, and it reds here first.
		const src = storeSource();
		expect(src, 'the store reached for the message catalog / paraglide runtime — phrase it in the component').not.toContain(
			'$lib/paraglide'
		);
		expect(src, 'the store reached for a display formatter — format it in the component').not.toContain(
			'$lib/utils/format'
		);
	});

	it('holds no template literal — every one this store ever had was prose or a plural', () => {
		// A backtick in a state store is either a sentence or a hand-built plural; both belong in the
		// catalog. `day${s}` carries no terminal punctuation, so the sentence rule below cannot see
		// it — this is the assertion that does.
		expect(storeSource(), 'a template literal appeared in the licence store').not.toContain('`');
	});

	it('holds no string literal that reads as a sentence', () => {
		// A quoted run containing a space and ending in terminal punctuation. The literals that
		// legitimately remain are state tags and paths — 'expiring_soon', 'license_unavailable',
		// '/api/license/status', '/license-upgrade' — none of which can match.
		const offenders = storeSource().match(/(['"])[^'"\n]*\s[^'"\n]*[.!?]\1/g) ?? [];
		expect(offenders, `hard-coded copy in the licence store: ${offenders.join(' | ')}`).toEqual([]);
	});
});

describe('…because the screens get their words from the catalog, which is why the getter was dead', () => {
	// ⚠️ THE COMPOSITION MOVED, THE RULE DID NOT. This assertion used to read the `m.*` calls out of
	// LicenseBlocked.svelte directly. They now live in `lib/i18n/license-copy.ts`, because a SECOND
	// screen — `/license-upgrade`, the target of this screen's own Renew button — carried its own
	// stale two-branch copy of the same decision and told entitled customers they had no licence.
	// One definition, two consumers.
	//
	// The rule this file exists to enforce is unchanged and is now checked in both halves: the words
	// come from the CATALOG, and neither half may compose a sentence or render a date in code.
	it('the block screen builds heading and body from m.*, and renders no date', () => {
		const copySrc = readSource('lib/i18n/license-copy.ts');
		expect(
			copySrc,
			'the scan returned a file with no licenseCopy in it — the stripper ate the source',
		).toContain('export function licenseCopy');
		expect(copySrc).toContain('m.license_blocked_heading_expired()');
		expect(copySrc).toContain('m.error_license_expired()');
		// The premise of the deleted getter — that this screen shows an expiry date — was false.
		// It must stay false in the module that now owns the words.
		expect(copySrc, 'licence copy started rendering a date; it must go through $lib/utils/format').not.toContain(
			'expiresAt',
		);
		expect(copySrc).not.toContain('statusMessage');

		const src = readSource('lib/components/LicenseBlocked.svelte');
		expect(src, 'the scan returned a component with no markup in it').toContain('lb-title');
		// Positive anchor: the component must actually READ the shared copy. Without this the two
		// `not.toContain`s below would pass on a component that had gone back to composing its own.
		expect(src, 'the block screen no longer uses the shared licence copy').toContain('licenseCopy');
		expect(src, 'the block screen started rendering a date; it must go through $lib/utils/format').not.toContain(
			'expiresAt',
		);
		expect(src).not.toContain('statusMessage');
	});

	// ⛔ AND THE SECOND CONSUMER, FOR THE SAME REASON. `/license-upgrade` is where the Renew CTA
	// lands, so it is a licence-copy surface even though it is not the block screen. It drifted once
	// already; pin it here rather than discovering it again from a screenshot.
	it('/license-upgrade takes its words from the same place and composes none of its own', () => {
		const src = readSource('routes/license-upgrade/+page.svelte');
		expect(src, 'the scan returned a page with no markup in it').toContain('lu-title');
		expect(src, '/license-upgrade no longer uses the shared licence copy').toContain('licenseCopy');
		expect(src).not.toContain('expiresAt');
		expect(src).not.toContain('statusMessage');
	});

	it('LicenseExpiringBanner.svelte pluralizes through the catalog, not through `day${s}`', () => {
		const src = readSource('lib/components/LicenseExpiringBanner.svelte');
		expect(src).toContain('m.license_expiring_days({ days: licenseGate.daysRemaining })');
		expect(src).not.toContain('statusMessage');
	});
});
