// @vitest-environment jsdom
//
// src/lib/components/build/block-author.ontology-failure.render.test.ts — "Bouwen met AI" stops
// reporting a failed ontology read as a fact about the workspace.
//
// ⛔ THE DEFECT. `ontologyApi.matrix()` was awaited inside `catch { /* optional grounding */ }`, so
// a 500 or a dropped connection left `industries` and `departments` at `[]` — and a `<select>` whose
// only entry is "Geen" is indistinguishable from a tenant whose ontology matrix genuinely has no
// cells. The developer's reasonable reading, "there is nothing to ground this block in, so I will
// skip it", is wrong, and it costs them exactly the feature this form exists to offer.
//
// ⛔⛔ AND IT IS WORSE THAN THE DATASET HALF THAT WAS ALREADY FIXED IN THIS FILE. `start()` appends
// `blockauthor_seed_cell` only `if (industry)` — so with the pickers empty the ontology grounding
// drops out of the AGENT'S PROMPT as well, silently. The failure costs the block its grounding
// twice: once in the form, once on the wire.
//
// ⚠️ THIS COMPONENT'S OWN HEADER NAMED THIS AND DECLINED IT — "Named, not fixed", because it was a
// separate finding and a separate sentence to translate. This is that separate lane; the note is
// rewritten rather than left standing.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — the reader-visible failure is a false claim about the
// workspace, and a key-name stub cannot tell "the claim is gone" from "the claim is a key name".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { AllDatasets } from '$lib/api/datasets';
import type { DatasetRow } from '$lib/types/datasets';
import type { MatrixData } from '$lib/types/ontology';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

const { matrixFn, listAll } = vi.hoisted(() => ({ matrixFn: vi.fn(), listAll: vi.fn() }));
vi.mock('$lib/api/ontology', () => ({
	ontologyApi: { matrix: matrixFn, get: vi.fn(), compiled: vi.fn() },
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: vi.fn(), get: vi.fn(), listMappings: vi.fn() }
}));
// ⛔ The real `$lib/api/agent` chain reaches `keycloak.ts`, which calls `new Keycloak(...)` at
// module load and throws outside a browser — the hazard `block-fix-assistant.render.test.ts`
// records. The chat store is never started by this file; the form is what is under test.
vi.mock('$lib/api/agent', () => ({
	issueAgentToken: vi.fn(),
	streamAgentChat: vi.fn(() => ({ close: () => {} })),
	postToolResult: vi.fn(),
	AgentApiError: class AgentApiError extends Error {}
}));

import BlockAuthorAssistant from './BlockAuthorAssistant.svelte';

/** `messages/nl.json` — what a failed read must say… */
const ONTOLOGY_FAILED_NL = 'Sectoren en afdelingen konden niet worden geladen';
/** …and the option that must NOT be the only thing on screen explaining an empty picker. */
const NONE_NL = 'Geen';
const RETRY_NL = 'Opnieuw proberen';

const matrix = (): MatrixData =>
	({ industries: ['insurance'], departments: ['Claims'], cells: [] }) as MatrixData;

const allDatasets = (items: DatasetRow[] = []): AllDatasets => ({
	items,
	total: items.length,
	capped: false
});

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	listAll.mockResolvedValue(allDatasets());
	app = mount(BlockAuthorAssistant, {
		target: host,
		props: { category: 'data', onProposal: () => {} }
	}) as Record<string, unknown>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. Everything below is an assertion about the two grounding selects; on a
 * form that never rendered, "the workspace claim is gone" is true for free.
 */
function selects(): HTMLSelectElement[] {
	const sels = [...host.querySelectorAll<HTMLSelectElement>('.grid select')];
	expect(sels.length, 'the grounding form never rendered — this case tests nothing').toBe(3);
	return sels;
}
const errorBox = () => host.querySelector('[data-testid="ontology-error"]');
/** The option TEXTS of the Branche picker — the first of the three. */
const industryOptions = () => [...selects()[0]!.options].map((o) => o.textContent?.trim() ?? '');

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	matrixFn.mockReset();
	listAll.mockReset();
});

describe('"Bouwen met AI" when the ontology matrix read fails', () => {
	it('⛔ THE DEFECT: two empty pickers no longer stand for "you have no ontology"', async () => {
		// REVERT THAT TURNS THIS RED: `catch { /* optional grounding */ }`. There is then no notice at
		// all, and "Geen" is the only entry in both selects — exactly what a tenant with no ontology
		// sees.
		matrixFn.mockRejectedValue(new Error('Failed to fetch'));
		await render();

		expect(industryOptions(), 'the picker is not actually empty, so the reason is moot')
			.toEqual([NONE_NL]);
		const err = errorBox();
		expect(err, 'a failed ontology read is still indistinguishable from an empty workspace')
			.not.toBeNull();
		expect(err!.textContent).toContain(ONTOLOGY_FAILED_NL);
		expect(err!.getAttribute('role')).toBe('alert');
	});

	it('⛔ …and offers a retry that really re-requests', async () => {
		matrixFn.mockRejectedValueOnce(new Error('Failed to fetch'));
		await render();
		const retry = errorBox()!.querySelector('button') as HTMLButtonElement | null;
		expect(retry, 'the failure is stated with no way to act on it').not.toBeNull();
		expect(retry!.textContent?.trim()).toBe(RETRY_NL);

		matrixFn.mockResolvedValueOnce(matrix());
		// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(matrixFn, 'the retry never reached the client').toHaveBeenCalledTimes(2);
		expect(errorBox(), 'the notice survived a retry that succeeded').toBeNull();
		expect(industryOptions().length, 'the recovered options did not render').toBeGreaterThan(1);
	});

	it('⛔ THE FORM STILL SUBMITS — the grounding is optional and stays optional', async () => {
		// The notice must sit UNDER the selects rather than replace them: "Geen" is a legitimate
		// choice, and the agent can ask for the cell in chat. A fix that gated the form on a
		// successful matrix read would cost more than the defect did.
		matrixFn.mockRejectedValue(new Error('Failed to fetch'));
		await render();

		const intent = host.querySelector('textarea, input') as HTMLInputElement | null;
		expect(intent, 'the intent field is gone').not.toBeNull();
		intent!.value = 'markeer claims boven de polislimiet';
		intent!.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();

		const start = [...host.querySelectorAll('button.btn-primary')][0] as HTMLButtonElement;
		expect(start.disabled, 'a failed grounding read blocked the form').toBe(false);
	});

	it('⚠️ A SUCCESSFUL READ SHOWS NO NOTICE — it is not unconditional', async () => {
		// The complement. "Render the notice always" satisfies every case above and would caption a
		// perfectly healthy form with a failure.
		matrixFn.mockResolvedValue(matrix());
		await render();
		expect(errorBox(), 'a notice was shown for a read that succeeded').toBeNull();
		expect(industryOptions().length).toBeGreaterThan(1);
	});

	it('⚠️ AND THE NOTICE IS STATED ONCE, not once per picker', async () => {
		// One `ontologyApi.matrix()` populates both selects, so a failure is one fact about one
		// request — two notices would be two copies of one sentence and two retries for one call.
		matrixFn.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		expect(host.querySelectorAll('[data-testid="ontology-error"]')).toHaveLength(1);
	});

	it('⛔ …and it is NOT inside a <label>, where its retry would pop a dropdown', async () => {
		// This component's own comment documents the hazard on the dataset cell: a `<button>` inside a
		// `<label>` forwards its click to the labelled `<select>`, so pressing "Opnieuw proberen"
		// would open the dropdown over the notice explaining why it is empty.
		matrixFn.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		expect(errorBox()!.closest('label'), 'the retry sits inside a label').toBeNull();
	});
});
