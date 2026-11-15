// @vitest-environment jsdom
//
// src/routes/governance/governance-page.enforcement-bands.render.test.ts — /governance must not let
// an ARCHITECTURAL ASSERTION pass for an ENFORCED BOUNDARY.
//
// ⛔ THE DEFECT. The screen was headed "Policy rails · enforced at the boundary" — in all eight
// languages — over EIGHTEEN rails rendered as one undifferentiated list. Four of them are enforced
// by nothing at all: `models.code_exec_outside_blocks`, `data.block_prod_data`,
// `data.cross_sandbox_isolation` and `data.eu_only` have GovernanceSnapshot fields with ZERO
// consumers anywhere in backend/src, backend/tests or backend/scripts. Turning one of those toggles
// off changed nothing, and a compliance reader had no way to tell it apart from
// `models.external_http`, which really does refuse a run and name itself in the refusal.
//
// The backend now says which is which (`host/policy-enforcement.ts` → `Policy.enforcement` on the
// wire); this file is the half that proves the SCREEN acts on it. `policy-enforcement.backend-
// contract.test.ts` is the other half — it proves the classification itself matches the code.
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME (the technique in
// governance-page.i18n.render.test.ts), so the assertions state WHICH message each band resolved
// without pinning English copy a translator may reword.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Governance, Policy, PolicyEnforcement } from '$lib/types/governance';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { getGovernance, updateGovernance, FakeApiError } = vi.hoisted(() => ({
	getGovernance: vi.fn(),
	updateGovernance: vi.fn(),
	FakeApiError: class extends Error {
		status = 0;
	}
}));
vi.mock('$lib/api/governance', () => ({
	governanceApi: { get: getGovernance, update: updateGovernance, exportNow: vi.fn() },
	ApiError: FakeApiError
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

function policy(key: string, enforcement?: PolicyEnforcement): Policy {
	return {
		key,
		category: 'data_isolation',
		label: 'SEEDER ENGLISH',
		description: 'SEEDER ENGLISH DESCRIPTION',
		control: 'toggle',
		value: true,
		options: null,
		unit: null,
		enabled: true,
		...(enforcement ? { enforcement } : {})
	};
}

/** A group carrying ONE RAIL OF EVERY KIND: two enforced-by-nothing rails and a retired one, two
 *  rails that genuinely refuse a run, and one `applied` rail — a live setting whose edit changes
 *  the next call while refusing nothing. Shaped on the real `data_isolation` group; the applied
 *  rail (`models.work_tiers`, really in `models_tools`) is borrowed into it because no single
 *  seeded group happens to contain all four kinds, and the four bands must be rendered in one
 *  card to be asserted in order. `policy()` stamps `category: 'data_isolation'` on every entry, so
 *  the group is synthetic on purpose. */
function dto(withEnforcement = true): Governance {
	const e = (k: string, kind: PolicyEnforcement) => policy(k, withEnforcement ? kind : undefined);
	return {
		groups: [
			{
				category: 'data_isolation',
				title: 'Data & isolation',
				policies: [
					e('data.block_prod_data', 'architectural'),
					e('data.pii_scrubbing', 'enforced'),
					e('models.work_tiers', 'applied'),
					e('data.cross_sandbox_isolation', 'architectural'),
					e('data.eu_only', 'retired'),
					e('data.validation_mode', 'enforced')
				]
			}
		],
		compliance: [],
		recentChanges: [],
		exportStatus: { enabled: false, bucket: 'compliance', hourUtc: 2, lastRun: null, recent: [] }
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	getGovernance.mockReset();
	updateGovernance.mockReset();
	updateGovernance.mockResolvedValue(undefined);
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function render() {
	app = mount(Page, { target: host, props: {} });
	flushSync();
	await Promise.resolve();
	await Promise.resolve();
	flushSync();
	return host;
}

describe('the rails are banded by what actually backs them', () => {
	it('renders four bands, in order, each with its own heading AND its caveat', async () => {
		getGovernance.mockResolvedValue(dto());
		const el = await render();
		expect(getGovernance).toHaveBeenCalled(); // or every assertion below is vacuous

		// ⛔ ORDER IS PART OF THE ASSERTION and `applied` belongs SECOND. The bands run down the
		// strength of the claim: refuses something → changes something but refuses nothing → changes
		// nothing → withdrawn. Putting `applied` below `architectural` would file a rail that really
		// does change the next call underneath one that changes nothing at all.
		expect([...el.querySelectorAll('.section-head h3')].map((n) => n.textContent)).toEqual([
			'governance_enforcement_enforced',
			'governance_enforcement_applied',
			'governance_enforcement_architectural',
			'governance_enforcement_retired'
		]);
		// ⛔ THE NOTE IS NOT DECORATION. The heading "Holds by construction" alone still reads like a
		// stronger guarantee than "enforced"; the sentence under it is the part that says the switch
		// does nothing. A band without its caveat is the defect wearing a new hat.
		expect([...el.querySelectorAll('.section-head p')].map((n) => n.textContent)).toEqual([
			'governance_enforcement_enforced_note',
			'governance_enforcement_applied_note',
			'governance_enforcement_architectural_note',
			'governance_enforcement_retired_note'
		]);
	});

	it('⛔ the APPLIED band exists BECAUSE its note denies what the enforced note promises', async () => {
		// The band is only worth having if its caveat says the opposite thing. Asserted on the real
		// EN and NL catalogs (the two languages a reader of this repo can check, and `nl` is the demo
		// language), because a fourth heading over a note copy-pasted from `enforced` would render
		// four bands, pass every structural assertion above, and change nothing for a compliance
		// reader — which is this whole family of defects.
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const cat = (loc: string) =>
			JSON.parse(readFileSync(resolve(process.cwd(), `messages/${loc}.json`), 'utf8')) as Record<
				string,
				string
			>;
		for (const loc of ['en', 'nl']) {
			const c = cat(loc);
			expect(c.governance_enforcement_applied).toBeTruthy();
			expect(c.governance_enforcement_applied_note).toBeTruthy();
			// Not a copy of any sibling band's words.
			for (const sib of ['enforced', 'architectural', 'retired']) {
				expect(c.governance_enforcement_applied_note).not.toBe(
					c[`governance_enforcement_${sib}_note`]
				);
				expect(c.governance_enforcement_applied).not.toBe(c[`governance_enforcement_${sib}`]);
			}
		}
		// EN: the enforced note PROMISES a refusal; the applied note DENIES one. Both halves are
		// asserted so "no refusal word" cannot be satisfied by a lexicon that matches nothing.
		expect(cat('en').governance_enforcement_enforced_note!.toLowerCase()).toContain('is refused');
		expect(cat('en').governance_enforcement_applied_note!.toLowerCase()).toContain(
			'nothing is refused'
		);
		// NL, the primary language, the same pair.
		expect(cat('nl').governance_enforcement_enforced_note!.toLowerCase()).toContain('geweigerd');
		expect(cat('nl').governance_enforcement_applied_note!.toLowerCase()).toContain(
			'niets geweigerd'
		);
		// …and the applied note must not silently claim the OTHER untruth either — that editing it
		// does nothing. It says the edit takes effect.
		expect(cat('en').governance_enforcement_applied_note!.toLowerCase()).toContain('changes the next');
	});

	it('puts each rail under the band its `enforcement` names', async () => {
		getGovernance.mockResolvedValue(dto());
		const el = await render();
		// Walk the card in document order and attribute every rail to the heading above it.
		const bandOf = new Map<string, string>();
		let band = '(none)';
		for (const node of el.querySelectorAll('.section-head h3, .policy-name')) {
			if (node.classList.contains('policy-name')) bandOf.set(node.textContent!, band);
			else band = node.textContent!;
		}
		expect(bandOf.get('policy_label_data_pii_scrubbing')).toBe('governance_enforcement_enforced');
		expect(bandOf.get('policy_label_data_validation_mode')).toBe('governance_enforcement_enforced');
		expect(bandOf.get('policy_label_data_block_prod_data')).toBe(
			'governance_enforcement_architectural'
		);
		expect(bandOf.get('policy_label_data_cross_sandbox_isolation')).toBe(
			'governance_enforcement_architectural'
		);
		expect(bandOf.get('policy_label_data_eu_only')).toBe('governance_enforcement_retired');
		expect(bandOf.get('policy_label_models_work_tiers')).toBe('governance_enforcement_applied');
		// All six rails are on screen — a band that swallowed a rail would also pass the lookups.
		expect(bandOf.size).toBe(6);
	});

	it('the retired rail is the only one with no control, and it cannot write', async () => {
		getGovernance.mockResolvedValue(dto());
		const el = await render();
		const rows = [...el.querySelectorAll('.policy-row')];
		expect(rows).toHaveLength(6);
		const withoutControl = rows.filter((r) => !r.querySelector('.policy-control button'));
		// ⛔ EXACTLY ONE, and the `applied` rail is NOT it. 'applied' means "refuses nothing", which
		// is not "nobody may edit it" — a live setting rendered read-only would be a second untruth
		// on the same screen, and the backend's PATCH guard is keyed on retirement for the same
		// reason (routes/governance.ts).
		expect(withoutControl).toHaveLength(1);
		expect(withoutControl[0]!.querySelector('.policy-name')!.textContent).toBe(
			'policy_label_data_eu_only'
		);
		expect(withoutControl[0]!.querySelector('.retired-mark')!.textContent).toBe(
			'governance_enforcement_retired_mark'
		);
		// Nothing on the page has PATCHed anything just by rendering.
		expect(updateGovernance).not.toHaveBeenCalled();
	});

	// ⛔ THE ROLLING-DEPLOY GUARD, and the reason `Policy.enforcement` is OPTIONAL in the type. The
	// browser reaches the API through the Service, which answers from old and new pods for the
	// length of a roll, so a NEW frontend really is served a payload with no `enforcement` field.
	// The failure to avoid is not a crash — it is the screen quietly filing all eighteen rails under
	// "Enforced at the boundary", which is the ORIGINAL DEFECT restored for the duration of every
	// deploy. So the fallback renders the pre-change screen: one flat list, no band, no claim.
	it('⛔ an OLD backend that sends no `enforcement` gets NO band and NO enforcement claim', async () => {
		getGovernance.mockResolvedValue(dto(false));
		const el = await render();
		// 1. The page did not collapse and every rail is still there, editable.
		expect(el.querySelectorAll('.policy-name')).toHaveLength(6);
		expect(el.querySelectorAll('.policy-control button')).toHaveLength(6);
		// 2. Not one band heading, and — the point — not the word the bands are made of.
		expect(el.querySelectorAll('.section-head')).toHaveLength(0);
		expect(el.textContent).not.toContain('governance_enforcement_enforced');
		expect(el.textContent).not.toContain('governance_enforcement_applied');
		expect(el.textContent).not.toContain('governance_enforcement_architectural');
		expect(el.textContent).not.toContain('governance_enforcement_retired');
		// 3. …and the retired rail is NOT hidden or disabled on this payload: an old backend has not
		//    told us it is retired, and guessing would take the screen read-only during every roll.
		expect(el.querySelectorAll('.retired-mark')).toHaveLength(0);
	});

	it('a MIXED payload bands what it knows and leaves the rest unbanded, above the bands', async () => {
		// Belt and braces for the roll: a Service can answer one request from each pod, but a single
		// payload can also be assembled by a backend mid-upgrade. The unknown rails must not be
		// silently dropped from the screen.
		const mixed = dto();
		mixed.groups[0]!.policies = [
			policy('data.block_prod_data', 'architectural'),
			policy('data.pii_scrubbing'), // no classification on the wire
			policy('data.validation_mode', 'enforced')
		];
		getGovernance.mockResolvedValue(mixed);
		const el = await render();
		expect([...el.querySelectorAll('.policy-name')].map((n) => n.textContent)).toEqual([
			'policy_label_data_pii_scrubbing', // unbanded, first
			'policy_label_data_validation_mode', // enforced
			'policy_label_data_block_prod_data' // architectural
		]);
		expect([...el.querySelectorAll('.section-head h3')].map((n) => n.textContent)).toEqual([
			'governance_enforcement_enforced',
			'governance_enforcement_architectural'
		]);
	});

	it('the page title no longer claims the boundary for all of them', async () => {
		// The heading this whole change exists to correct. It is asserted by MESSAGE KEY, so a
		// translator may reword the sentence; what may not come back is the old key's promise.
		getGovernance.mockResolvedValue(dto());
		const el = await render();
		const en = JSON.parse(
			(await import('node:fs')).readFileSync(
				(await import('node:path')).resolve(process.cwd(), 'messages/en.json'),
				'utf8'
			)
		) as Record<string, string>;
		expect(el.querySelector('h1')!.textContent).toBe('governance_title');
		expect(en.governance_title).not.toContain('enforced at the boundary');
	});
});
