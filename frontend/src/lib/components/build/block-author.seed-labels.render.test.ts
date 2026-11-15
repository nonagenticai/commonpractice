// @vitest-environment jsdom
//
// src/lib/components/build/block-author.seed-labels.render.test.ts — the first message the
// "Build with AI" form puts in the developer's OWN chat bubble.
//
// ⛔ THE DEFECT. `start()` interpolated three raw wire values into three localized patterns:
//
//     m.blockauthor_seed_goal({ category, goal })          → "Maak een logic-blok. Doel: …"
//     m.blockauthor_seed_cell({ industry, department })     → "Branche: insurance, Afdeling: Claims."
//
// So the sentence around the values was Dutch and the values themselves were English slugs — in a
// bubble attributed to the USER, i.e. words the product puts in the developer's mouth. And it did
// this while the SAME COMPONENT localized all three vocabularies in its own dropdowns thirty lines
// below (`industryLabel`, `departmentLabel`) and while the block palette three panels away called
// `logic` "Logica" (`categoryLabel`).
//
// ⛔ THE HALF THAT IS NOT A STRING FIX, AND THE REASON THIS FILE ASSERTS TWO THINGS PER VALUE.
// `chat.send(msg)` sends this exact string to the AGENT — `AgentChatStore.send` takes one string
// and uses it for both the bubble and the wire. `industry` and `department` are ROUTING VALUES: the
// agent's `get_ontology` tool (backend/src/ai/mcp/tools.ts) takes `industry` and hands it to
// `compileEffective`, which matches it against the `ontology_entities.industry` COLUMN. A prompt
// that says only "Branche: Verzekeringen" invites `get_ontology(industry="Verzekeringen")`, which
// matches no row and silently empties the ontology grounding this form exists to provide — a worse
// defect than the English one being fixed, and precisely the hazard
// `$lib/i18n/ontology-axis-label.ts` documents for a value that is a word AND a key. So the fix
// keeps the canonical key beside the reader's word, and both halves are asserted here.
//
// ⚠️ `category` GETS NO SUCH ESCORT, DELIBERATELY. It is not an agent INPUT: the agent's
// `propose_block_draft` schema constrains its category OUTPUT to the `BLOCK_CATEGORIES` enum
// (tools.ts), so the canonical value is enforced on the way back whatever word seeded the request.
// Asserted below so the asymmetry is not "tidied up" later.
//
// ⛔ `$lib/i18n/ontology-axis-label` AND `$lib/types/blocks` ARE DELIBERATELY NOT MOCKED — the
// labellers ARE the unit under test. Its sibling `block-author.grounding-failure.render.test.ts`
// stubs the axis module to identity, which is exactly why that file could not have caught this.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		// The parameters are REALLY interpolated — a stub that discards them could not tell
		// "Branche: Verzekeringen" from "Branche: insurance", which is the whole subject here.
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key]!.replace(/\{(\w+)\}/g, (whole: string, name: string) =>
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

// The seed message never leaves the component, so the spy IS the observation point.
const { sent } = vi.hoisted(() => ({ sent: vi.fn() }));
vi.mock('$lib/stores/agent-chat.svelte', () => ({
	AgentChatStore: class {
		busy = false;
		messages: unknown[] = [];
		stop() {}
		async send(text: string) {
			sent(text);
		}
	}
}));
vi.mock('$lib/agent/block-author-driver', () => ({
	BlockAuthorDriver: class {},
	describeBlockEdit: (name: string) => name
}));

const { matrix, listAll, listPaged } = vi.hoisted(() => ({
	matrix: vi.fn(),
	listAll: vi.fn(),
	listPaged: vi.fn()
}));
vi.mock('$lib/api/ontology', () => ({ ontologyApi: { matrix } }));
vi.mock('$lib/api/datasets', () => ({ datasetsApi: { listAll, list: listPaged } }));

import BlockAuthorAssistant from './BlockAuthorAssistant.svelte';

/** The nl words, from the catalogs these helpers resolve through. */
const LOGICA = 'Logica'; // category_logic
const VERZEKERINGEN = 'Verzekeringen'; // industry_insurance
const SCHADECLAIMS = 'Schadeclaims'; // domain_claims

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Fill the form (goal + optionally the two axes) and press Start; return the seeded message. */
async function seed(opts: { industry?: string; department?: string } = {}): Promise<string> {
	app = mount(BlockAuthorAssistant, {
		target: host,
		props: { category: 'logic', onProposal: () => {} }
	}) as Record<string, unknown>;
	await settle();

	const ta = host.querySelector('textarea') as HTMLTextAreaElement | null;
	// ⛔ THE ANTI-VACUITY GATE. `start()` returns early on an empty goal, so without this every
	// assertion below would run against a `sent` spy that was never called.
	expect(ta, 'the intent textarea never rendered — this file would test nothing').not.toBeNull();
	ta!.value = 'markeer dubbele claims';
	ta!.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();

	const selects = [...host.querySelectorAll('select')] as HTMLSelectElement[];
	const pick = (sel: HTMLSelectElement | undefined, value: string) => {
		expect(sel, `no <select> to choose "${value}" from`).toBeTruthy();
		sel!.value = value;
		sel!.dispatchEvent(new Event('change', { bubbles: true }));
	};
	if (opts.industry) pick(selects[0], opts.industry);
	if (opts.department) pick(selects[1], opts.department);
	await settle();

	const startBtn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'Starten'
	) as HTMLButtonElement | undefined;
	expect(startBtn, 'the Start button is not on screen').toBeTruthy();
	startBtn!.click();
	await settle();

	expect(sent, 'pressing Start sent no message at all').toHaveBeenCalledTimes(1);
	return String(sent.mock.calls[0]![0]);
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	matrix.mockResolvedValue({ industries: ['insurance'], departments: ['Claims'] });
	listAll.mockResolvedValue({ items: [], total: 0, capped: false });
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [matrix, listAll, listPaged, sent]) fn.mockReset();
});

describe('the "Build with AI" seed message speaks the developer’s language', () => {
	it('⛔ the CATEGORY is the palette’s word, not the slug', async () => {
		const msg = await seed();
		// Positive first: the message really was built from the Dutch pattern.
		expect(msg).toContain('Maak een');
		expect(msg).toContain('markeer dubbele claims');
		// ⛔ THE ASSERTION THAT INVERTS ON A REVERT TO `{ category, goal }`.
		expect(msg).toContain(`Maak een ${LOGICA}-blok`);
		expect(msg, 'the raw category slug is still in the developer’s own bubble').not.toContain(
			'logic-blok'
		);
	});

	it('⛔ the category carries NO canonical escort — it is not an agent input', async () => {
		// The asymmetry with the two axis values below, asserted so it is not "tidied up". The
		// agent's `propose_block_draft` schema enforces the enum on the way back.
		const msg = await seed();
		expect(msg).not.toContain('(logic)');
	});

	it('⛔ the two AXES read Dutch — "Branche: insurance" is gone', async () => {
		const msg = await seed({ industry: 'insurance', department: 'Claims' });
		expect(msg).toContain('Branche:');
		expect(msg).toContain(VERZEKERINGEN);
		expect(msg).toContain(SCHADECLAIMS);
		// ⛔ THE REVERT DETECTOR. Anchored on the LABEL POSITION rather than on a bare
		// `not.toContain('insurance')`, because the canonical key is still legitimately present in
		// the parenthetical — asserting its total absence would demand deleting the half that keeps
		// the copilot's grounding working.
		expect(msg).not.toContain('Branche: insurance');
		expect(msg).not.toContain('Afdeling: Claims,');
		expect(msg).not.toMatch(/Afdeling: Claims\./);
	});

	it('⛔ …AND THE CANONICAL KEYS SURVIVE, so `get_ontology` can still resolve the cell', async () => {
		// The half a pure string fix breaks. `compileEffective` matches these against the
		// `ontology_entities` columns; a prompt carrying only "Verzekeringen" empties the grounding.
		const msg = await seed({ industry: 'insurance', department: 'Claims' });
		expect(msg).toContain(`${VERZEKERINGEN} (insurance)`);
		expect(msg).toContain(`${SCHADECLAIMS} (Claims)`);
	});

	it('an axis whose label IS its value gets no redundant parenthetical', async () => {
		// `departmentLabel('Finance')` has no `domain_finance`-style divergence in nl for this value
		// set, and in `en` every label equals its value bar capitalization. "Insurance (insurance)"
		// in every English bubble would be noise, so the escort is case-folded-conditional.
		const msg = await seed({ industry: 'insurance', department: 'Claims' });
		expect(msg).not.toContain('(Schadeclaims)');
		expect(msg).not.toContain(`${VERZEKERINGEN} (${VERZEKERINGEN})`);
	});

	it('the DATASET SLUG stays verbatim — it is an identifier, not a word', async () => {
		// The third interpolation in the same function, deliberately untouched: the agent quotes
		// this slug back to `get_dataset`. A fix that "localized" it too would be the mirror-image
		// defect.
		const msg = await seed({ industry: 'insurance' });
		expect(msg).not.toContain('Gebruik de dataset'); // no dataset picked in this fixture
		expect(msg).toContain('Branche:');
	});
});
