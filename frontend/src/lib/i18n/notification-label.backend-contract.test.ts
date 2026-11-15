// src/lib/i18n/notification-label.backend-contract.test.ts — the two halves of the notification
// wire still agree.
//
// THE DEFECT THIS PINS is the one that only appears LATER. `notificationTitle`/`notificationBody`
// fall back to the backend's English whenever a machine field is absent — deliberately, so a
// pre-0066 row and an old pod mid-roll both degrade instead of vanishing. That fallback is a safety
// net, not a destination, and it is INVISIBLE when it fires: rename `remainingUsd` to `remaining`
// in `backend/src/host/budget-service.ts` and every budget alert in every locale quietly reverts to
// English, with every frontend unit test still green (they build their own fixtures) and nothing in
// CI saying a word. This is the file that reds.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so, exactly as `policy-label.backend-contract.test.ts` and
// `data-finding-label.backend-contract.test.ts` do, this walks BACKEND SOURCE TEXT on disk with
// plain `fs` and diffs the sets.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const BUDGET = join(BACKEND, 'src', 'host', 'budget-service.ts');
const ROUTE = join(BACKEND, 'src', 'routes', 'notifications.ts');

const budgetSrc = readFileSync(BUDGET, 'utf8');
const routeSrc = readFileSync(ROUTE, 'utf8');
const labelSrc = readFileSync(new URL('./notification-label.ts', import.meta.url), 'utf8');
/** The settings path the call-to-action names is built here, from the shell's own labels. */
const pathSrc = readFileSync(new URL('./llm-settings-path.ts', import.meta.url), 'utf8');
const typesSrc = readFileSync(new URL('../types/admin.ts', import.meta.url), 'utf8');
const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, unknown>;

// ---------------------------------------------------------------- backend readers

/**
 * The fields the backend declares on `BudgetAlertData`.
 *
 * ⛔ IT DOES NOT PARSE TYPESCRIPT. A field wrapped across lines in a shape this regex misses is
 * invisible to it — which is why the first assertion below pins the parsed set to an exact list.
 * If the declaration is ever reshaped, that assertion fails loudly rather than every later
 * comparison passing vacuously against an empty set.
 */
function backendDataFields(): string[] {
	// ⚠️ `export type`, not `export interface`, and the backend says why in a comment beside it:
	// TypeScript gives an object type ALIAS an implicit index signature and refuses one to an
	// interface, so the drizzle `jsonb().$type<Record<string, unknown>>()` insert only typechecks
	// against the alias. Accept both spellings here so this parser reports a RENAME rather than
	// dying on a legal refactor.
	const at = budgetSrc.search(/export (?:type|interface) BudgetAlertData\s*=?\s*\{/);
	if (at === -1) throw new Error('BudgetAlertData not found in backend/src/host/budget-service.ts');
	// `\n}` terminates both spellings — the alias closes `};`, the interface `}`.
	const body = budgetSrc.slice(at, budgetSrc.indexOf('\n}', at));
	return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]!);
}

/** The rungs the backend can alert on (`ALERT_THRESHOLDS`). */
function backendThresholds(): number[] {
	const decl = budgetSrc.match(/export const ALERT_THRESHOLDS = \[([^\]]+)\]/);
	if (!decl) throw new Error('ALERT_THRESHOLDS not found in backend/src/host/budget-service.ts');
	return decl[1]!.split(',').map((s) => Number(s.trim()));
}

describe('the parse itself is not vacuous', () => {
	it('reads the four fields off BudgetAlertData', () => {
		// Pinned exactly, not to a floor: this contract is four fields wide, and a FIFTH the frontend
		// has never heard of is as much a break as a missing one.
		expect(backendDataFields().sort()).toEqual(
			['limitUsd', 'remainingUsd', 'tenantName', 'threshold'].sort()
		);
	});

	it('reads the alert rungs off ALERT_THRESHOLDS', () => {
		expect(backendThresholds()).toEqual([75, 90, 100]);
	});
});

describe('every machine field the backend writes is READ by the label module', () => {
	it.each(backendDataFields())('`%s` is referenced in notification-label.ts', (field) => {
		// A field the backend ships and the browser never reads is not harmless: it is a sentence the
		// reader could have had in their own language and did not.
		expect(labelSrc).toContain(field);
	});

	it.each(backendDataFields())('`%s` is declared on AppNotification in types/admin.ts', (field) => {
		// tsc cannot see across the two projects, so the type is a hand-written transcription. This is
		// the only thing that notices when it stops matching.
		expect(typesSrc).toContain(field);
	});

	it('⛔ every field is checked with `== null`, never truthiness', () => {
		// `remainingUsd` is 0 at the 100 % rung; `threshold` and `limitUsd` are numbers too. A `!x`
		// guard drops a legal payload into the English branch, and it is a one-character edit away.
		for (const bad of ['!d.remainingUsd', '!d.threshold', '!d.limitUsd', '!d.tenantName', '!t)']) {
			expect(labelSrc, `a truthiness guard (${bad}) crept into the presence checks`).not.toContain(
				bad
			);
		}
	});
});

describe('the discriminant string is the same on both sides', () => {
	it('the backend names `budget.threshold` and the switch cases on it', () => {
		// Two string literals in two repos with no shared constant between them. The welcome-budget
		// alert WRITER is retired (backend migration 0099), but legacy rows are still in people's bells
		// and must keep rendering in the reader's language — so the kind is still declared backend-side.
		expect(budgetSrc).toContain("'budget.threshold'");
		expect(labelSrc).toContain("case 'budget.threshold':");
		expect(typesSrc).toContain("kind: 'budget.threshold'");
	});

	it('the route still ships `data` AND the English prose', () => {
		// The prose is not deprecated and must not be tidied away: it is the only thing a pre-0066
		// row carries, and the only thing an old frontend can render mid-roll.
		expect(routeSrc).toMatch(/data: row\.data \?\? undefined/);
		expect(routeSrc).toContain('title: row.title');
		expect(routeSrc).toContain('body: row.body');
	});
});

describe('every catalog key the label module names exists', () => {
	it.each([...(labelSrc + pathSrc).matchAll(/m\.(notification_\w+|nav_\w+|settings_\w+)\(/g)].map((x) => x[1]!))(
		'`%s` is in messages/en.json',
		(key) => {
			// Paraglide would fail the build on a missing key, but only once someone runs the build.
			// `catalogs.test.ts` then guarantees the other seven locales carry it too.
			expect(Object.keys(enCatalog)).toContain(key);
		}
	);

	it('names the six budget keys and the three labels of the settings path', () => {
		// The floor that stops the `it.each` above from passing vacuously on an empty match set.
		const keys = new Set([...(labelSrc + pathSrc).matchAll(/m\.(\w+)\(/g)].map((x) => x[1]!));
		expect(keys.size).toBeGreaterThanOrEqual(10);
		// ⛔ The path is Settings (gear) → Organisation → LLM settings. `nav_group_administer` named
		// a sidebar group that no longer exists, so its absence is asserted, not just tolerated.
		expect(keys).toContain('nav_settings');
		expect(keys).toContain('settings_group_organisation');
		expect(keys).toContain('nav_llm_settings');
		expect(keys).not.toContain('nav_group_administer');
	});
});

// ==================================================================================================
// ⛔ BEHAVIOURAL, and derived from the BACKEND's own constant rather than from a fixture this file
// chose. Everything above is a text diff; this block actually runs the label module against every
// rung `ALERT_THRESHOLDS` can produce. A rung added backend-first (a 50 % heads-up, say) must still
// resolve to a catalog message — the ladder is `>=`-based precisely so it can — and this is what
// notices if someone replaces it with `=== 75 / === 90 / === 100`.
// ==================================================================================================
vi.mock('$lib/paraglide/messages', () => ({
	notification_budget_used_up_title: () => 'M_USED_UP_TITLE',
	notification_budget_threshold_title: (p: Record<string, unknown>) => `M_PCT_TITLE(${p.pct})`,
	notification_budget_used_up_body: () => 'M_USED_UP_BODY',
	notification_budget_low_body: () => 'M_LOW_BODY',
	notification_budget_heads_up_body: () => 'M_HEADS_UP_BODY',
	notification_budget_how_to: () => 'M_HOW_TO',
	settings_path_llm: () => 'M_PATH',
	nav_settings: () => 'M_NAV_SETTINGS',
	settings_group_organisation: () => 'M_SETTINGS_ORG',
	nav_llm_settings: () => 'M_NAV_LLM_SETTINGS'
}));
vi.mock('$lib/utils/format', () => ({ usd: (n: number) => `$${n.toFixed(2)}` }));

const { notificationTitle, notificationBody } = await import('./notification-label');
const PROSE = 'BACKEND ENGLISH — must not be reached';

describe('every rung the backend can claim resolves to a catalog message', () => {
	it.each(backendThresholds())('rung %i is localized, not left in English', (threshold) => {
		const n = {
			id: 'n',
			kind: 'budget.threshold' as const,
			severity: 'warn' as const,
			title: PROSE,
			body: PROSE,
			href: '/llm-settings',
			read: false,
			createdAt: '2026-08-12T04:00:00.000Z',
			// `remainingUsd: 0` for the top rung is the real production value, not a convenience.
			data: {
				threshold,
				tenantName: 'Budget Test Co',
				limitUsd: 100,
				remainingUsd: threshold >= 100 ? 0 : 20
			}
		};
		expect(notificationTitle(n)).not.toBe(PROSE);
		expect(notificationBody(n, 'nl')).not.toBe(PROSE);
		expect(notificationBody(n, 'nl')).toContain('M_HOW_TO');
	});

	it('the three rungs do not collapse onto one sentence', () => {
		// 90 says model calls STOP at zero; 75 says nothing is blocked yet; 100 says they have
		// stopped. Three rungs, three messages — a `{pct}`-only design would say one thing.
		const bodies = backendThresholds().map((threshold) =>
			notificationBody({
				id: 'n',
				kind: 'budget.threshold' as const,
				severity: 'warn' as const,
				title: PROSE,
				body: PROSE,
				href: null,
				read: false,
				createdAt: '2026-08-12T04:00:00.000Z',
				data: { threshold, tenantName: 'T', limitUsd: 100, remainingUsd: 20 }
			}, 'nl')
		);
		expect(new Set(bodies).size).toBe(backendThresholds().length);
	});
});
