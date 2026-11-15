// @vitest-environment jsdom
//
// src/routes/governance/governance-page.i18n.render.test.ts — the whole /governance screen, in a
// non-English locale, with the backend answering exactly what production answers.
//
// ⛔ THE DEFECT, end to end. Captured live: a Dutch frame around an entirely English body. The
// eyebrow, the title, "Nalevingsstatus" and "Recente wijzigingen" were localized; between them sat
// four English group headings, eighteen English policy names with an English paragraph under each,
// raw enum options, and four English compliance rows. The fixture below is the real DTO — the
// English `title` / `label` / `description` / `status` fields the backend still sends are all
// present and populated — and every assertion is "this English string is NOT in the document".
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME (the technique in
// routes/solutions/solutions-page.reachable.render.test.ts): the rendered document is then a list
// of message keys, so the test states WHICH message each region resolved without pinning Dutch
// copy a translator may reword. It also means a key missing from the catalog renders `undefined`
// and fails loudly rather than silently falling back.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Governance } from '$lib/types/governance';

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

// Hoisted together with the mock: `vi.mock` factories run before module-level declarations, so a
// class declared below would be in its temporal dead zone by the time the factory reads it.
const { getGovernance, FakeApiError } = vi.hoisted(() => ({
	getGovernance: vi.fn(),
	FakeApiError: class extends Error {
		status = 0;
	}
}));
vi.mock('$lib/api/governance', () => ({
	governanceApi: { get: getGovernance, update: vi.fn(), exportNow: vi.fn() },
	ApiError: FakeApiError
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

/**
 * The /api/governance payload, with the backend's English left in every prose field ON PURPOSE.
 * Strings copied verbatim from backend/src/db/seed-platform.ts and backend/src/routes/governance.ts.
 */
const ENGLISH_PROSE = [
	'Data & isolation',
	'Spend & quotas',
	'Models & tools',
	'Promotion to production',
	'Block real production data from sandboxes',
	'A run is started with a scrubbed environment',
	'EU-only execution',
	'No residency check exists anywhere',
	'Validate injected data against the ontology',
	'Per-user daily LLM call cap',
	'Work-tier models',
	'ISO 27001 controls',
	'GDPR data flows',
	'DORA operational resilience',
	'EU AI Act risk profile',
	'Documented',
	'Re-assess in 21d',
	'calls/day'
];

function dto(): Governance {
	return {
		groups: [
			{
				category: 'data_isolation',
				title: 'Data & isolation',
				policies: [
					{
						key: 'data.block_prod_data',
						category: 'data_isolation',
						label: 'Block real production data from sandboxes',
						description: 'A run is started with a scrubbed environment — no database URL.',
						control: 'toggle',
						value: true,
						options: null,
						unit: null,
						enabled: true,
						enforcement: 'architectural'
					},
					{
						key: 'data.eu_only',
						category: 'data_isolation',
						label: 'EU-only execution',
						description: 'Withdrawn. No residency check exists anywhere in the platform.',
						control: 'toggle',
						value: true,
						options: null,
						unit: null,
						enabled: true,
						enforcement: 'retired'
					},
					{
						key: 'data.validation_mode',
						category: 'data_isolation',
						label: 'Validate injected data against the ontology',
						description: 'Before a run, a dataset bound to an ontology entity is checked.',
						control: 'select',
						value: 'warn',
						options: ['warn', 'block'],
						unit: null,
						enabled: true,
						enforcement: 'enforced'
					}
				]
			},
			{
				category: 'spend_quota',
				title: 'Spend & quotas',
				policies: [
					{
						key: 'spend.daily_llm_cap',
						category: 'spend_quota',
						label: 'Per-user daily LLM call cap',
						description: 'The metered LLM broker rejects a call once a user passes this many.',
						control: 'number',
						value: 50,
						options: null,
						unit: 'calls/day',
						enabled: true,
						enforcement: 'enforced'
					}
				]
			},
			{
				category: 'models_tools',
				title: 'Models & tools',
				policies: [
					{
						key: 'models.work_tiers',
						category: 'models_tools',
						label: 'Work-tier models',
						description: 'Which model each work tier resolves to.',
						control: 'map',
						value: { small: 'a/b', medium: 'c/d', large: 'e/f' },
						options: null,
						unit: null,
						enabled: true,
						enforcement: 'enforced'
					}
				]
			},
			{
				category: 'promotion',
				title: 'Promotion to production',
				policies: [
					{
						key: 'promotion.required_reviewers',
						category: 'promotion',
						label: 'Required reviewers',
						description: 'Minimum number of reviewers a card needs.',
						control: 'select',
						value: '2',
						options: ['1', '2', '3'],
						unit: null,
						enabled: true,
						enforcement: 'enforced'
					}
				]
			}
		],
		compliance: [
			{ key: 'iso27001', statusKey: 'passing', label: 'ISO 27001 controls', status: 'Passing', tone: 'ok' },
			{ key: 'gdpr', statusKey: 'documented', label: 'GDPR data flows', status: 'Documented', tone: 'ok' },
			{
				key: 'dora',
				statusKey: 'passing',
				label: 'DORA operational resilience',
				status: 'Passing',
				tone: 'ok'
			},
			{
				key: 'eu_ai_act',
				statusKey: 'reassess',
				label: 'EU AI Act risk profile',
				status: 'Re-assess in 21d',
				tone: 'warn'
			}
		],
		recentChanges: [
			{
				id: 'ch-1',
				policyKey: 'spend.daily_llm_cap',
				label: 'Per-user daily LLM call cap',
				oldValue: 40,
				newValue: 50,
				actor: { name: 'Lisa de Vries', initials: 'LV' },
				createdAt: new Date().toISOString()
			}
		],
		exportStatus: { enabled: false, bucket: 'compliance', hourUtc: 2, lastRun: null, recent: [] }
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	getGovernance.mockReset();
	getGovernance.mockResolvedValue(dto());
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

describe('/governance renders no English body inside its localized frame', () => {
	it('shows not one of the backend’s English strings', async () => {
		const el = await render();
		// Sanity: the page actually loaded its data, or every assertion below passes vacuously.
		expect(getGovernance).toHaveBeenCalled();
		expect(el.textContent).toContain('governance_compliance_status');

		const offenders = ENGLISH_PROSE.filter((s) => el.textContent!.includes(s));
		expect(offenders).toEqual([]);
	});

	it('names each of the four groups from its category', async () => {
		const el = await render();
		expect([...el.querySelectorAll('.rails h2')].map((n) => n.textContent)).toEqual([
			'policy_group_data_isolation',
			'policy_group_spend_quota',
			'policy_group_models_tools',
			'policy_group_promotion'
		]);
	});

	it('names each rail and its paragraph from the policy key', async () => {
		const el = await render();
		// ⚠️ ORDER IS BY ENFORCEMENT BAND, NOT BY THE BACKEND'S `sort`. Within `data_isolation` the
		// enforced rail comes first, then the architectural one, then the retired one — see
		// `sectionsOf` in +page.svelte. A compliance reader must not meet an assertion before the
		// thing that is actually enforced.
		expect([...el.querySelectorAll('.policy-name')].map((n) => n.textContent)).toEqual([
			'policy_label_data_validation_mode',
			'policy_label_data_block_prod_data',
			'policy_label_data_eu_only',
			'policy_label_spend_daily_llm_cap',
			'policy_label_models_work_tiers',
			'policy_label_promotion_required_reviewers'
		]);
		expect([...el.querySelectorAll('.policy-desc')].map((n) => n.textContent)).toEqual([
			'policy_desc_data_validation_mode',
			'policy_desc_data_block_prod_data',
			'policy_desc_data_eu_only',
			'policy_desc_spend_daily_llm_cap',
			'policy_desc_models_work_tiers',
			'policy_desc_promotion_required_reviewers'
		]);
	});

	it('resolves the compliance panel from `key` + `statusKey`', async () => {
		const el = await render();
		const rows = [...el.querySelectorAll('.compliance li')].map((li) => [
			li.querySelector('span:not(.dot-status):not(.d)')!.textContent,
			li.querySelector('.dot-status')!.textContent
		]);
		expect(rows).toEqual([
			['compliance_label_iso27001', 'compliance_status_passing'],
			['compliance_label_gdpr', 'compliance_status_documented'],
			// Two rows, one status message — the panel has four rows and three statuses.
			['compliance_label_dora', 'compliance_status_passing'],
			['compliance_label_eu_ai_act', 'compliance_status_reassess']
		]);
	});

	it('names a recent change from `policyKey`, so it agrees with the rail above it', async () => {
		// This list used to print the backend's English label while the rail it referred to was
		// about to be localized — the two would have disagreed on the same screen.
		const el = await render();
		expect(el.querySelector('.ch-label')!.textContent).toBe('policy_label_spend_daily_llm_cap');
	});

	it('localizes the option text while the submitted values stay raw', async () => {
		const el = await render();
		const selects = [...el.querySelectorAll('select')];
		expect([...selects[0]!.options].map((o) => o.textContent)).toEqual([
			'policy_option_validation_warn',
			'policy_option_validation_block'
		]);
		expect([...selects[0]!.options].map((o) => o.value)).toEqual(['warn', 'block']);
		// Reviewer counts are digits in every locale — untouched, by design.
		expect([...selects[1]!.options].map((o) => o.textContent)).toEqual(['1', '2', '3']);
	});

	it('localizes the unit and the work-tier sub-labels', async () => {
		const el = await render();
		expect(el.querySelector('.unit')!.textContent).toBe('policy_unit_calls_per_day');
		expect([...el.querySelectorAll('.map-key')].map((n) => n.textContent)).toEqual([
			'policy_tier_small',
			'policy_tier_medium',
			'policy_tier_large'
		]);
	});

	// ⛔ THE ROLLING-DEPLOY GUARD. This is the one mutation of twelve that survived green in
	// adversarial review, which is exactly why it needed a test rather than a comment.
	//
	// The two containers share a pod, but the browser reaches the API through the SERVICE, which
	// load-balances across old and new pods for the length of a roll — so a NEW frontend really
	// does get answered by an OLD backend. That backend's compliance rows carry `label`/`status`
	// and no `key`/`statusKey` at all. Keyed on `c.key`, all four rows key on `undefined`, Svelte
	// throws `each_key_duplicate` — NOT dev-only (internal/client/dom/blocks/each.js) — and with
	// no `<svelte:boundary>` anywhere in this tree the WHOLE page collapses to an empty shell:
	// rails, compliance and recent changes all gone, 326 bytes of body.
	//
	// So this asserts the page SURVIVES and still says something true, not merely that it does not
	// throw. Restoring `(c.key)` in +page.svelte reddens it.
	it('⛔ survives an OLD backend that sends no key/statusKey — rails intact, prose shown', async () => {
		const legacy = dto();
		// Exactly what the pre-change backend put on the wire: prose only.
		legacy.compliance = legacy.compliance.map((c) => ({
			label: c.label,
			status: c.status,
			tone: c.tone
		})) as typeof legacy.compliance;
		getGovernance.mockResolvedValue(legacy);
		const el = await render();

		// 1. The page did not collapse. If `each_key_duplicate` threw, the whole tree is gone and
		//    both of these are 0 — the rails live in a SIBLING section to the compliance panel, so
		//    they are the honest witness that the throw did not take the screen down with it.
		expect(el.querySelectorAll('.rails h2').length).toBe(4);
		expect(el.querySelectorAll('.policy-name').length).toBeGreaterThan(0);
		// 2. All four compliance rows are present and DISTINCT — the duplicate-key symptom is
		//    four rows collapsing, so count them explicitly.
		const rows = [...el.querySelectorAll('.compliance li')];
		expect(rows.length).toBe(4);
		// 3. Each row says something a reader can act on. The catalog keys cannot resolve without
		//    `key`, so the legacy prose is the correct answer here — blank rows would be a
		//    different failure wearing the same green.
		const text = rows.map((li) => li.textContent ?? '');
		expect(text.every((t) => t.trim().length > 0)).toBe(true);
		expect(text.join(' | ')).toContain('ISO 27001 controls');
		expect(text.join(' | ')).toContain('Passing');
		// 4. And the rest of the screen is still localized — the fallback is scoped to this panel.
		expect(el.textContent).toContain('governance_compliance_status');
	});
});
