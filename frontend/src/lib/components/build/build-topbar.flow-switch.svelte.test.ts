// @vitest-environment jsdom
//
// src/lib/components/build/build-topbar.flow-switch.svelte.test.ts — the Submit-name gate ACROSS a
// flow switch, i.e. with the `name`/`currentId` props MUTATED on a component that is already mounted.
//
// ⚠️ WHY THIS FILE EXISTS SEPARATELY. `build-topbar.submit-gate.render.test.ts` mounts with fixed
// props and never changes them, so every gate assertion there is about one frozen flow. The gate is
// not made of props alone: it reads `nameDraft ?? name`, where `nameDraft` is a LOCAL draft of an
// uncommitted edit. A draft that outlives its flow makes the gate answer about a flow the user is no
// longer looking at, and no fixed-props test can see that.
//
// It is a `.svelte.test.ts` (note the infix) so vite-plugin-svelte compiles it as a rune module:
// `mount(..., { props })` only observes later mutations when `props` is a `$state` proxy.
//
// The two failures measured on the real component before the fix:
//   A. type a name into flow A, never blur, press browser Back → flow B loads as "Untitled flow"
//      and Submit is ENABLED. One click publishes a competition entry titled "Untitled flow" — the
//      exact defect this component was written to prevent.
//   B. the reverse: a draft that happens to hold a default name survives onto a properly named flow
//      and disables Submit forever, with nothing on screen saying why.
//
// Neither needs exotic input. `/build` reopens the flow from `?id=` via an `$effect`, `selectFlow`
// navigates with `goto()` (which PUSHES history), and `BuildTopbar` is not keyed — so Back/Forward
// swaps the flow under a live, still-focused input: no blur, no `change`, no `commitRename`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { FlowListItem, FlowStatus } from '$lib/types/flows';

/** `build_new_flow_default_name` per locale, keyed as the REAL `paraglide/runtime` `locales`. */
const DEFAULT_NAMES: Record<string, string> = {
	en: 'Untitled flow',
	nl: 'Naamloze flow',
	pl: 'Przepływ bez nazwy',
	fr: 'Flux sans titre',
	es: 'Flujo sin título',
	de: 'Unbenannter Flow',
	ar: 'تدفق بدون عنوان',
	he: 'זרימה ללא שם'
};
/** The UI locale these tests render in: Dutch, as in prod. */
const UI_LOCALE = 'nl';

vi.mock('$lib/paraglide/messages', () => ({
	build_back_to_solutions: () => 'Back',
	build_flow_switch_blocked: () => 'Busy',
	build_flow_picker_aria: () => 'Open flow',
	build_new_flow: () => 'New flow',
	build_flow_name_aria: () => 'Flow name',
	build_your_sandbox: () => 'Your sandbox',
	build_block_count: ({ count }: { count: number }) => `${count} blocks`,
	build_sandbox_pill: () => 'Sandbox',
	build_more_actions: () => 'More actions',
	build_undo: () => 'Undo',
	build_redo: () => 'Redo',
	build_test_run_title_empty: () => 'Add a block first',
	build_test_run_title: () => 'Run it',
	build_running: () => 'Running',
	build_test_run: () => 'Test run',
	flow_history_title: () => 'History',
	flow_history_open: () => 'History',
	build_share_title: () => 'Share link',
	build_share_copied: () => 'Copied',
	build_share: () => 'Share',
	build_share_copy_failed: () => 'COPY_FAILED',
	build_submitted: () => 'SUBMITTED_LABEL',
	build_submitting: () => 'SUBMITTING_LABEL',
	build_submit_solution: () => 'SUBMIT_LABEL',
	build_submit_short: () => 'SUBMIT_SHORT',
	build_submit_needs_challenge: () => 'NEEDS_CHALLENGE',
	build_submit_needs_name: () => 'NEEDS_NAME',
	build_new_flow_default_name: (_inputs?: unknown, options?: { locale?: string }) =>
		DEFAULT_NAMES[options?.locale ?? UI_LOCALE]
}));

const FLOW_A: FlowListItem = {
	id: 'flow-a',
	name: 'Mijn eerste flow',
	description: '',
	status: 'draft',
	version: '1',
	node_count: 3,
	last_saved_at: null,
	updated_at: '2026-08-09T00:00:00Z'
};
const FLOW_B: FlowListItem = { ...FLOW_A, id: 'flow-b', name: DEFAULT_NAMES.en };

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Mounts with a REACTIVE props object and hands it back, so a test can swap the open flow. */
async function render(over: Record<string, unknown> = {}) {
	const { default: BuildTopbar } = await import('./BuildTopbar.svelte');
	const props = $state({
		name: FLOW_A.name,
		status: 'draft' as FlowStatus,
		nodeCount: 3,
		saveLabel: 'Opgeslagen',
		saving: false,
		flows: [FLOW_A, FLOW_B],
		currentId: FLOW_A.id,
		challengeId: 'ch-1',
		// A LIVE challenge — this file is about the flow-switch draft reset, and a closed challenge
		// would disable Submit for a reason that has nothing to do with what it measures.
		challengeClosed: false,
		// Both flows in this file load fine — the subject is the uncommitted name draft, not a
		// failed switch, so this stays true across the swap.
		flowLoaded: true,
		// This flow is the caller’s own; the read-only branch has its own specs.
		readOnly: false,
		chatBusy: false,
		submitting: false,
		running: false,
		historyOpen: false,
		canUndo: false,
		canRedo: false,
		onRename: () => {},
		onSelect: () => {},
		onNew: () => {},
		onSubmit: () => {},
		onTestRun: () => {},
		onToggleHistory: () => {},
		onUndo: () => {},
		onRedo: () => {},
		...over
	});
	app = mount(BuildTopbar, { target: host, props });
	flushSync();
	return { el: host, props: props as Record<string, unknown> };
}

function submitButton(el: HTMLElement): HTMLButtonElement {
	const btn = el.querySelector('button.btn-primary') as HTMLButtonElement | null;
	expect(btn, 'no primary submit button in the topbar').not.toBeNull();
	return btn!;
}
function titleInput(el: HTMLElement): HTMLInputElement {
	const input = el.querySelector('input.title') as HTMLInputElement | null;
	expect(input, 'no title input in the topbar').not.toBeNull();
	return input!;
}

/** Type into the title WITHOUT blurring — no `change`, exactly what Back/Forward leaves behind. */
function type(el: HTMLElement, value: string) {
	const input = titleInput(el);
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

/** Browser Back / picker: the `?id=` effect reopens another flow. Focus never moves. */
function switchFlow(props: Record<string, unknown>, id: string, name: string) {
	props.currentId = id;
	props.name = name;
	flushSync();
}

describe('an uncommitted title edit does not survive a flow switch', () => {
	it('PROBE A: a typed name must not vouch for the flow that Back navigates TO', async () => {
		const { el, props } = await render({ name: FLOW_A.name, currentId: FLOW_A.id });
		type(el, 'Claimformulier-samenvatter');
		expect(submitButton(el).disabled, 'precondition: a real name unlocks Submit').toBe(false);

		switchFlow(props, FLOW_B.id, DEFAULT_NAMES.en);

		expect(
			submitButton(el).disabled,
			'Submit is ENABLED on a flow named "Untitled flow". The name typed into the PREVIOUS flow ' +
				'is still shadowing the prop (`nameDraft ?? name`), because the draft is cleared only in ' +
				'`commitRename` (onchange) and Back/Forward swaps the flow without moving focus. One ' +
				'click now publishes a competition entry titled "Untitled flow" — the exact defect this ' +
				'component exists to prevent.'
		).toBe(true);
		expect(el.textContent, 'no visible reason either — the gate believes the flow is named').toContain('NEEDS_NAME');
		expect(submitButton(el).getAttribute('aria-describedby')).toBe('submit-needs-name');
		expect(titleInput(el).classList.contains('unnamed')).toBe(true);
		expect(titleInput(el).value, 'the field still shows text from the previous flow').toBe(DEFAULT_NAMES.en);
	});

	it('PROBE A, same-name pair: two auto-created flows are BOTH "Untitled flow"', async () => {
		// The most likely pair to switch between, and the one a reset keyed on `name` alone cannot
		// see at all: the prop never changes, only `?id=` does.
		const { el, props } = await render({ name: DEFAULT_NAMES.en, currentId: FLOW_A.id });
		expect(submitButton(el).disabled).toBe(true);
		type(el, 'Claimformulier-samenvatter');
		expect(submitButton(el).disabled).toBe(false);

		switchFlow(props, FLOW_B.id, DEFAULT_NAMES.en);

		expect(
			submitButton(el).disabled,
			'switching between two flows that share the default name left the draft standing, so the ' +
				'gate opened on a flow that is still literally called "Untitled flow".'
		).toBe(true);
		expect(
			titleInput(el).value,
			'`value={name}` only writes the DOM when `name` itself changes, so the typed text is still ' +
				'displayed on a flow it does not belong to.'
		).toBe(DEFAULT_NAMES.en);
	});

	it('PROBE B: a draft holding a default name must not permanently block the NEXT flow', async () => {
		const { el, props } = await render({ name: DEFAULT_NAMES.nl, currentId: FLOW_A.id });
		type(el, DEFAULT_NAMES.en); // mid-edit, and momentarily a default name

		switchFlow(props, FLOW_B.id, 'Een echte naam');

		expect(
			submitButton(el).disabled,
			'Submit is disabled on a properly named flow, permanently and with no visible cause — the ' +
				'stale draft from the previous flow is still what the gate reads.'
		).toBe(false);
		expect(el.textContent).not.toContain('NEEDS_NAME');
		expect(submitButton(el).getAttribute('aria-describedby')).toBeNull();
		expect(titleInput(el).classList.contains('unnamed')).toBe(false);
		expect(titleInput(el).value).toBe('Een echte naam');
	});

	it('keeps the draft while the SAME flow is open — autosave must not eat what is being typed', async () => {
		// `/build` re-renders this bar constantly: `saveLabel`/`saving` tick on every 800ms autosave and
		// `nodeCount` moves with the canvas. A reset that is not keyed on the flow would wipe the draft
		// mid-keystroke and re-disable Submit under the user's hand.
		const { el, props } = await render({ name: DEFAULT_NAMES.nl, currentId: FLOW_A.id });
		type(el, 'Claimformulier-samenvatter');
		expect(submitButton(el).disabled).toBe(false);

		props.saving = true;
		props.saveLabel = 'Opslaan…';
		props.nodeCount = 4;
		flushSync();

		expect(
			submitButton(el).disabled,
			'an autosave tick dropped the uncommitted name. The gate re-closed while the user was still ' +
				'typing, and the name they had entered is gone from the gate (though not from the field).'
		).toBe(false);
		expect(titleInput(el).value).toBe('Claimformulier-samenvatter');
	});

	it('still lets a committed rename through — the reset must not swallow the rename itself', async () => {
		const renamed: string[] = [];
		const { el, props } = await render({
			name: DEFAULT_NAMES.nl,
			currentId: FLOW_A.id,
			onRename: (n: string) => renamed.push(n)
		});
		const input = titleInput(el);
		input.value = 'Claimformulier-samenvatter';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		input.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(renamed).toEqual(['Claimformulier-samenvatter']);

		// …and the parent echoing the new name back as a prop keeps the gate open.
		props.name = 'Claimformulier-samenvatter';
		flushSync();
		expect(submitButton(el).disabled).toBe(false);
		expect(titleInput(el).value).toBe('Claimformulier-samenvatter');
	});

	it('⛔ a FAILED COPY does not follow the reader onto the next flow', async () => {
		// THE FIX'S OWN NEW DEFECT, caught by a verifier before it shipped. The share failure notice
		// renders the permalink so "copy it by hand" is followable — the value is never otherwise on
		// screen. But `shareLink` holds the permalink of the flow the copy was attempted ON, and
		// nothing reset it on a switch. Measured on the real component:
		//
		//   after failure on flow-a: "Kopiëren mislukt … /build?id=flow-a"
		//   after switching to flow-b: "Kopiëren mislukt … /build?id=flow-a"   ← under flow B's title
		//
		// A reader following that instruction shares the WRONG flow. Before the notice existed,
		// `catch { return }` rendered nothing, so this surface could not be wrong at all: adding an
		// honest message is what created the way for it to lie.
		Object.defineProperty(navigator, 'clipboard', {
			value: {
				writeText: vi.fn(async () => {
					throw new Error('NotAllowedError');
				})
			},
			configurable: true
		});
		const { el, props } = await render({ currentId: FLOW_A.id, name: 'Flow A' });

		const share = [...el.querySelectorAll('button')].find(
			(b) => b.textContent!.trim() === 'Share'
		) as HTMLButtonElement | undefined;
		expect(share, 'no Share button — this case would prove nothing').toBeTruthy();
		share!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		for (let i = 0; i < 40 && !el.querySelector('[data-testid="share-copy-failed"]'); i++) {
			await new Promise((r) => setTimeout(r, 0));
			flushSync();
		}

		// The failure IS on screen and names flow A — without this the case is vacuous.
		const failed = el.querySelector('[data-testid="share-copy-failed"]');
		expect(failed, 'the copy failure never rendered').toBeTruthy();
		expect(failed!.textContent).toContain(FLOW_A.id);

		switchFlow(props, FLOW_B.id, 'Flow B');
		flushSync();

		expect(el.querySelector('[data-testid="share-copy-failed"]')).toBeNull();
	});
});
