// @vitest-environment jsdom
//
// src/lib/components/ops/policy-row.silent-writes.render.test.ts — /governance must not record a
// policy change that never happened.
//
// ⛔ THE DEFECT, MEASURED IN POSTGRES. `commitList` fired `onchange(arr)` UNCONDITIONALLY, and it is
// wired to `onblur`. Opening the "Allowlisted models" editor and clicking away WITHOUT TYPING
// therefore PATCHed /api/governance with the value it already held, which wrote a `policy_changes`
// row whose `old_value` was byte-identical to its `new_value`, a `policy.change` row in `audit_log`,
// and a fresh top entry in the on-screen "Recent changes" panel. The sibling `commitMapEntry` has
// carried the equality check that prevents exactly this since it was written.
//
// This is a compliance surface. An audit trail that records changes which did not occur is worse
// than no trail: every real edit now sits in a list the reader has learned to discount.
//
// ⛔ THE ASSERTION IS ON THE CALL, NOT ON A STRING. `expect(onchange).not.toHaveBeenCalled()` is the
// only shape that can see this — comparing the rendered badges before and after would pass on the
// broken code too, because the value written is the value already held. Every case therefore spies
// on `onchange` and every "no write" case is paired with a "yes write" case in the same describe, so
// a component that simply never emits cannot satisfy this file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Policy, PolicyValue } from '$lib/types/governance';

vi.mock('$lib/paraglide/messages', () => ({
	ops_policy_list_placeholder: () => 'PLACEHOLDER',
	ops_policy_edit: () => 'EDIT',
	policy_label_models_allowlist: () => 'M_LABEL_ALLOWLIST',
	policy_desc_models_allowlist: () => 'M_DESC_ALLOWLIST',
	policy_label_data_egress_allowlist: () => 'M_LABEL_EGRESS',
	policy_desc_data_egress_allowlist: () => 'M_DESC_EGRESS',
	policy_label_spend_daily_llm_cap: () => 'M_LABEL_CAP',
	policy_desc_spend_daily_llm_cap: () => 'M_DESC_CAP',
	policy_label_models_work_tiers: () => 'M_LABEL_TIERS',
	policy_desc_models_work_tiers: () => 'M_DESC_TIERS',
	policy_tier_small: () => 'M_TIER_SMALL',
	policy_tier_medium: () => 'M_TIER_MEDIUM',
	policy_tier_large: () => 'M_TIER_LARGE'
}));

const MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
let onchange: ReturnType<typeof vi.fn>;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	onchange = vi.fn();
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/**
 * ⛔ THE THREE COMMIT PATHS ARE ONE CLASS, NOT ONE BUG. `commitList` was the measured defect, but
 * `commitNumber` had NO equality check at all and `commitMapEntry`'s was pinned by nothing — deleting
 * its `if (current[key] === next) return;` left the whole frontend suite green. Every rail on
 * /governance PATCHes through this component, so a no-op write on any of them mints the same false
 * `policy_changes` diff and `policy.change` audit row on the same compliance surface.
 */
function numberPolicy(value: number = 15): Policy {
	return {
		key: 'spend.daily_llm_cap',
		category: 'spend_quota',
		label: 'Daily LLM cap',
		description: 'Stops one workspace burning the platform budget.',
		control: 'number',
		value,
		options: null,
		unit: null,
		enabled: true
	} as Policy;
}

/** `models.work_tiers` — the fixed-key map rail. Only the VALUES are editable. */
function mapPolicy(value: Record<string, string> = { small: 'a/b', medium: 'c/d', large: 'e/f' }): Policy {
	return {
		key: 'models.work_tiers',
		category: 'models_tools',
		label: 'Work tiers',
		description: 'Which model answers which size of job.',
		control: 'map',
		value,
		options: null,
		unit: null,
		enabled: true
	} as Policy;
}

function listPolicy(value: string[] = MODELS): Policy {
	return {
		key: 'models.allowlist',
		category: 'models_tools',
		label: 'Allowlisted models',
		description: 'The broker refuses any model not on this list before it ever reaches a provider.',
		control: 'list',
		value,
		options: null,
		unit: null,
		enabled: true
	} as Policy;
}

async function render(policy: Policy) {
	const { default: PolicyRow } = await import('./PolicyRow.svelte');
	app = mount(PolicyRow, {
		target: host,
		props: { policy, onchange: onchange as unknown as (v: PolicyValue) => void }
	});
	flushSync();
	return host;
}

/** Click "Edit" and hand back the text input the editor swapped in. */
function openEditor(): HTMLInputElement {
	const edit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'EDIT');
	expect(edit, 'the list rail rendered no Edit control — nothing below could be exercised').toBeTruthy();
	edit!.click();
	flushSync();
	const input = host.querySelector<HTMLInputElement>('.list-edit');
	expect(input, 'clicking Edit did not open the list editor').not.toBeNull();
	return input!;
}

function type(input: HTMLInputElement, text: string) {
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}
function blur(input: HTMLInputElement) {
	input.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
	flushSync();
}
function key(input: HTMLInputElement, k: string) {
	input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
	flushSync();
}

/** Put `text` in a control and fire `change` — the event `commitNumber`/`commitMapEntry` are on. */
function change(input: HTMLInputElement, text: string) {
	input.value = text;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
}
function numberInput(): HTMLInputElement {
	const el = host.querySelector<HTMLInputElement>('input.num');
	expect(el, 'the number rail rendered no input — nothing below could be exercised').not.toBeNull();
	return el!;
}
function mapInputs(): HTMLInputElement[] {
	const els = [...host.querySelectorAll<HTMLInputElement>('.map-value')];
	expect(els.length, 'the map rail rendered no fields').toBeGreaterThan(0);
	return els;
}

describe('the list editor writes only when the value actually changed', () => {
	it('⛔ opening the editor and clicking away WITHOUT TYPING writes nothing', async () => {
		// THE MEASURED DEFECT. On the pre-fix component this emits `['claude-opus-4-7', …]` — the
		// value already stored — and the page PATCHes it, minting a policy_changes row and an
		// audit_log row for an edit the admin never made.
		await render(listPolicy());
		const input = openEditor();
		expect(input.value, 'the draft did not seed from the stored value').toBe(MODELS.join(', '));
		blur(input);
		expect(onchange).not.toHaveBeenCalled();
		// …and the editor still closed, so this is not "the fix froze the control".
		expect(host.querySelector('.list-edit'), 'the editor stayed open').toBeNull();
	});

	it('⛔ pressing Enter on an untouched draft writes nothing either', async () => {
		// The keyboard route into the identical commit. Blur alone would leave this half open.
		await render(listPolicy());
		const input = openEditor();
		key(input, 'Enter');
		expect(onchange).not.toHaveBeenCalled();
	});

	it('a whitespace-only edit is not a change — the parse normalizes it away', async () => {
		// `split(',').map(trim).filter(Boolean)` turns "a,   b ,, c" into the same three strings, so
		// the value on the wire would be identical. Comparing the DRAFT TEXT instead of the parsed
		// array would call this a change and write the row anyway.
		await render(listPolicy());
		const input = openEditor();
		type(input, `${MODELS[0]},   ${MODELS[1]} ,,  ${MODELS[2]}  `);
		blur(input);
		expect(onchange).not.toHaveBeenCalled();
	});

	it('a REAL edit still commits, exactly once, as a parsed array', async () => {
		// ⛔ THE ANTI-VACUITY HALF. Every assertion above is a `not.toHaveBeenCalled()`, which a
		// component that never emits satisfies for free. This is the same control doing its job.
		await render(listPolicy());
		const input = openEditor();
		type(input, 'claude-opus-4-7, claude-sonnet-4-6');
		blur(input);
		expect(onchange).toHaveBeenCalledTimes(1);
		expect(onchange).toHaveBeenCalledWith(['claude-opus-4-7', 'claude-sonnet-4-6']);
	});

	it('adding one model commits the whole new list', async () => {
		await render(listPolicy(['a', 'b']));
		const input = openEditor();
		type(input, 'a, b, c');
		blur(input);
		expect(onchange).toHaveBeenCalledTimes(1);
		expect(onchange).toHaveBeenCalledWith(['a', 'b', 'c']);
	});

	it('reordering IS a change — the stored value would differ', async () => {
		// Deliberate: `policies.value` is a JSON array and the row it writes really would differ.
		// The equality check is about "did nothing change", not about set membership.
		await render(listPolicy(['a', 'b']));
		const input = openEditor();
		type(input, 'b, a');
		blur(input);
		expect(onchange).toHaveBeenCalledWith(['b', 'a']);
	});

	it('⛔ a duplicate the SERVER would strip is not a change either', async () => {
		// The rail holds ['a','b']; the admin types "a, b, b". Pre-dedupe this parsed to three
		// elements, failed the length test, PATCHed — and `validateValue` in
		// backend/src/routes/governance.ts deduped it straight back to ['a','b'], the value already
		// stored. A policy_changes row and an audit row for an edit that did not survive its own
		// validation. The draft must be compared as the value that would actually be STORED.
		await render(listPolicy(['a', 'b']));
		const input = openEditor();
		type(input, 'a, b, b');
		blur(input);
		expect(onchange).not.toHaveBeenCalled();
	});

	it('a real edit carrying a duplicate commits the deduped list, once', async () => {
		// The complement: dedupe must not swallow the NEW member travelling with the duplicate, and
		// what goes on the wire must be what the server will store.
		await render(listPolicy(['a', 'b']));
		const input = openEditor();
		type(input, 'a, b, c, c');
		blur(input);
		expect(onchange).toHaveBeenCalledTimes(1);
		expect(onchange).toHaveBeenCalledWith(['a', 'b', 'c']);
	});

	it('a rail whose stored value is already empty stays silent on an empty draft', async () => {
		// `data.egress_allowlist` seeds empty in some workspaces, and its own description documents
		// empty as a legitimate state ("Empty = no external host is reachable"). Opening and closing
		// it must be as inert as any other untouched rail.
		const p = listPolicy([]);
		p.key = 'data.egress_allowlist';
		await render(p);
		const input = openEditor();
		blur(input);
		expect(onchange).not.toHaveBeenCalled();
	});
});

describe('Escape abandons the edit', () => {
	it('⛔ Escape closes the editor and writes nothing, even after typing', async () => {
		// Before the fix there was no Escape handler at all, so the only way out of the editor was
		// blur — which committed. A reader who opened it by accident had no way to leave without
		// writing to the audit trail.
		await render(listPolicy());
		const input = openEditor();
		type(input, 'something-entirely-different');
		key(input, 'Escape');
		expect(onchange).not.toHaveBeenCalled();
		expect(host.querySelector('.list-edit'), 'Escape did not close the editor').toBeNull();
	});

	it('⛔ the blur that follows Escape does not commit the abandoned draft', async () => {
		// The half that makes Escape real rather than decorative: removing a FOCUSED input fires
		// `blur`, and `onblur={commitList}` is still attached at that moment. Without a guard, Escape
		// would close the editor and then write the very draft it just discarded.
		await render(listPolicy());
		const input = openEditor();
		type(input, 'something-entirely-different');
		key(input, 'Escape');
		blur(input);
		expect(onchange).not.toHaveBeenCalled();
	});

	it('the abandoned draft is gone when the editor is reopened', async () => {
		await render(listPolicy());
		type(openEditor(), 'wiped');
		key(host.querySelector<HTMLInputElement>('.list-edit')!, 'Escape');
		expect(openEditor().value, 'the cancelled draft survived into the next edit').toBe(MODELS.join(', '));
	});

	it('Enter after a real edit commits once, not twice', async () => {
		// Same guard from the other side: `Enter` closes the editor too, so the blur it provokes
		// used to re-enter `commitList` with the draft still loaded.
		await render(listPolicy());
		const input = openEditor();
		type(input, 'only-one');
		key(input, 'Enter');
		blur(input);
		expect(onchange).toHaveBeenCalledTimes(1);
		expect(onchange).toHaveBeenCalledWith(['only-one']);
	});
});

describe('the number rail writes only when the NUMBER actually changed', () => {
	// ⛔ `commitNumber` HAD NO EQUALITY CHECK AT ALL, and `type=number` is the rail that needs one
	// most: the DOM decides whether to fire `change` by comparing the input's STRING. `15.0`, `015`
	// and `1.5e1` are each a different string from `15`, so the browser reports an edit; each parses
	// to the number already stored; each PATCHed a policy that did not move. Not exotic — `015` is
	// what a stray keystroke in front of a value produces, and `15.0` is what a paste from a
	// spreadsheet produces.
	// ⚠️ Every spelling here must be a VALID floating-point literal per the HTML value-sanitization
	// algorithm (`" 15 "` is not — the input would blank it, `parseFloat` would see NaN, and the case
	// would pass through the REJECT branch while claiming to prove the equality check).
	for (const spelling of ['15.0', '015', '1.5e1']) {
		it(`⛔ typing "${spelling}" over a stored 15 writes nothing`, async () => {
			await render(numberPolicy(15));
			const input = numberInput();
			change(input, spelling);
			expect(onchange).not.toHaveBeenCalled();
			// …and the box shows the value the rail actually holds. Same principle as the reject
			// branch: never leave text on screen that is not the saved value.
			expect(input.value, 'a spelling the rail does not hold was left in the box').toBe('15');
		});
	}

	it('a REAL number edit still commits, exactly once, as a number', async () => {
		// ⛔ THE ANTI-VACUITY HALF — every assertion above is a `not.toHaveBeenCalled()`.
		await render(numberPolicy(15));
		change(numberInput(), '20');
		expect(onchange).toHaveBeenCalledTimes(1);
		expect(onchange).toHaveBeenCalledWith(20);
	});

	it('⚠️ 0 is a change, not a falsy no-op', async () => {
		// The check has to be `n === Number(policy.value)` and not a truthiness test: `0` is the
		// value that switches a cap off, which is a governance decision that MUST be recorded.
		await render(numberPolicy(15));
		change(numberInput(), '0');
		expect(onchange).toHaveBeenCalledTimes(1);
		expect(onchange).toHaveBeenCalledWith(0);
	});

	it('a rejected value writes nothing and reverts the box', async () => {
		await render(numberPolicy(15));
		const input = numberInput();
		change(input, '-5');
		expect(onchange).not.toHaveBeenCalled();
		expect(input.value).toBe('15');
	});
});

describe('the map rail writes only when the entry actually changed', () => {
	// ⛔ `commitMapEntry` HAS CARRIED ITS EQUALITY CHECK SINCE IT WAS WRITTEN AND NOTHING PINNED IT.
	// Measured: delete `if (current[key] === next) return;` and all 1545 frontend tests stay green —
	// the guard that the two fixes above were modelled on was itself unprotected, one careless
	// refactor from reintroducing the defect on the third rail.
	it('⛔ re-committing an unchanged entry writes nothing', async () => {
		await render(mapPolicy());
		change(mapInputs()[1]!, 'c/d');
		expect(onchange).not.toHaveBeenCalled();
	});

	it('whitespace around an unchanged entry is not a change — the trim normalizes it away', async () => {
		// `commitMapEntry` trims BEFORE comparing, for the same reason `commitList` compares the
		// parsed array: the trimmed string is what would go on the wire.
		await render(mapPolicy());
		change(mapInputs()[1]!, '  c/d  ');
		expect(onchange).not.toHaveBeenCalled();
	});

	it('a REAL map edit still commits the whole map, exactly once', async () => {
		await render(mapPolicy());
		change(mapInputs()[1]!, 'x/y');
		expect(onchange).toHaveBeenCalledTimes(1);
		expect(onchange).toHaveBeenCalledWith({ small: 'a/b', medium: 'x/y', large: 'e/f' });
	});

	it('an emptied entry writes nothing and reverts the field', async () => {
		// The map's own reject branch: the key set is fixed server-side, so a blank value is not a
		// deletion — it is a rejected edit, and must not be left on screen looking saved.
		await render(mapPolicy());
		const input = mapInputs()[0]!;
		change(input, '   ');
		expect(onchange).not.toHaveBeenCalled();
		expect(input.value).toBe('a/b');
	});
});
