// @vitest-environment jsdom
//
// Render guards for the Build topbar's primary action.
//
// A solution belongs to a challenge — `POST /api/solutions` requires `challenge_id` — so when the
// builder was opened with no `?challenge=` in context there is nothing to submit TO. Before this,
// the button looked identical in both cases and clicking it silently did nothing useful. It must
// instead be visibly unavailable AND say why, in text (not a `title=` on a disabled, unfocusable
// button — the same accessibility finding as `kanban-card.review-control.render.test.ts` D4).
//
// The SECOND gate on the same button: the flow must carry a name a human chose. `/build` auto-names
// every new flow `build_new_flow_default_name` and Submit copies that name verbatim into
// `solutions.title`, so the product's first ever user-submitted solution is literally titled
// "Untitled flow" — and it is about to be crowned a weekly winner and become a pipeline card of the
// same name. The backend cannot refuse it (`z.string().min(1).max(160)` must stay honest — "must
// not equal one of eight localized strings" would refuse a legitimately named flow forever), so
// this gate is the only thing standing there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { FlowListItem, FlowStatus } from '$lib/types/flows';

// `build_new_flow_default_name` per locale, keyed exactly as the REAL `paraglide/runtime` `locales`
// array (which this file deliberately does NOT mock — the component must iterate the real list).
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
	build_submitted: () => 'SUBMITTED_LABEL',
	build_submitting: () => 'SUBMITTING_LABEL',
	build_submit_solution: () => 'SUBMIT_LABEL',
	build_submit_short: () => 'SUBMIT_SHORT',
	build_submit_needs_challenge: () => 'NEEDS_CHALLENGE',
	build_submit_needs_name: () => 'NEEDS_NAME',
	build_submit_challenge_closed: () => 'CHALLENGE_CLOSED',
	// Locale-aware on purpose: with no `{ locale }` it answers in the CURRENT locale, exactly like
	// the real paraglide message. That is what makes the cross-locale test below non-vacuous.
	build_new_flow_default_name: (_inputs?: unknown, options?: { locale?: string }) =>
		DEFAULT_NAMES[options?.locale ?? UI_LOCALE]
}));

const FLOW: FlowListItem = {
	id: 'flow-1',
	name: 'My flow',
	description: '',
	status: 'draft',
	version: '1',
	node_count: 3,
	last_saved_at: null,
	updated_at: '2026-08-09T00:00:00Z'
};

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

async function render(over: Record<string, unknown> = {}) {
	const { default: BuildTopbar } = await import('./BuildTopbar.svelte');
	app = mount(BuildTopbar, {
		target: host,
		props: {
			name: 'My flow',
			status: 'draft' as FlowStatus,
			nodeCount: 3,
			saveLabel: 'Saved',
			saving: false,
			flows: [FLOW],
			currentId: 'flow-1',
			challengeId: 'ch-1',
			challengeClosed: false,
			// A flow IS loaded — this file measures the name and challenge gates, and "no flow behind
			// `currentId`" is a third, independent reason to shut Submit (see the prop's doc comment).
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
		}
	});
	flushSync();
	return host;
}

function submitButton(el: HTMLElement): HTMLButtonElement {
	const btn = el.querySelector('button.btn-primary') as HTMLButtonElement | null;
	expect(btn, 'no primary submit button in the topbar').not.toBeNull();
	return btn!;
}

describe('the Submit action is gated on a challenge being in context', () => {
	it('is enabled and silent when a challenge IS in context', async () => {
		const el = await render({ challengeId: 'ch-1' });
		const btn = submitButton(el);
		expect(btn.disabled).toBe(false);
		expect(btn.textContent).toContain('SUBMIT_LABEL');
		expect(el.textContent).not.toContain('NEEDS_CHALLENGE');
		expect(btn.getAttribute('aria-describedby')).toBeNull();
	});

	it('is DISABLED with a visible, linked reason when no challenge is in context', async () => {
		const el = await render({ challengeId: null });
		const btn = submitButton(el);

		expect(
			btn.disabled,
			'the Submit button is still clickable with no challenge in context. ' +
				'POST /api/solutions requires challenge_id, so the click can only fail — a control ' +
				'that cannot work must not look available.'
		).toBe(true);

		// The reason is real text in the DOM, not only a `title=` on a disabled (unfocusable) button.
		expect(el.textContent).toContain('NEEDS_CHALLENGE');

		// …and it is programmatically associated with the control it explains.
		const describedBy = btn.getAttribute('aria-describedby');
		expect(describedBy).toBeTruthy();
		const note = el.ownerDocument.getElementById(describedBy!);
		expect(note, `no element with id "${describedBy}" — aria-describedby points at nothing`).not.toBeNull();
		expect(note!.textContent).toContain('NEEDS_CHALLENGE');
	});

	it('offers the way OUT — the reason links to the challenge board', async () => {
		const el = await render({ challengeId: null });
		const link = el.querySelector('a.submit-hint') as HTMLAnchorElement | null;
		expect(link, 'the "no challenge" hint is not a link, so it names a dead end').not.toBeNull();
		expect(link!.getAttribute('href')).toBe('/challenges');
	});

	it('stays disabled while a submission is in flight, so it cannot be double-posted', async () => {
		const el = await render({ challengeId: 'ch-1', submitting: true });
		const btn = submitButton(el);
		expect(btn.disabled).toBe(true);
		expect(btn.textContent).toContain('SUBMITTING_LABEL');
	});

	it('shows the submitted label once the flow has been published', async () => {
		const el = await render({ challengeId: 'ch-1', status: 'submitted' as FlowStatus });
		expect(submitButton(el).textContent).toContain('SUBMITTED_LABEL');
	});
});

describe('the Submit action is gated on that challenge still ACCEPTING solutions', () => {
	// ⛔ WHY THIS GATE EXISTS SEPARATELY FROM THE LINK. Withdrawing the "Build a solution" CTA on the
	// challenge page removes the INVITATION, not the ENTRANCE: `?challenge=` is a hand-editable URL
	// parameter, and `builderBootUrl` deliberately carries it across every navigation /build makes,
	// so a bookmark or a mid-session flow switch arrives here with a dead challenge in context. The
	// server now answers `422 challenge_closed` — and by then the author has already spent the whole
	// session. This is the last place the refusal is still cheap.

	it('is DISABLED with a visible, linked reason when the challenge cycle is over', async () => {
		const el = await render({ challengeId: 'ch-1', challengeClosed: true });
		const btn = submitButton(el);

		expect(
			btn.disabled,
			'Submit is live on a challenge whose cycle is over. `POST /api/solutions` refuses it with ' +
				'422 challenge_closed — this click can only throw away a finished build.'
		).toBe(true);

		expect(el.textContent).toContain('CHALLENGE_CLOSED');
		const describedBy = btn.getAttribute('aria-describedby');
		expect(describedBy).toBe('submit-challenge-closed');
		const note = el.ownerDocument.getElementById(describedBy!);
		expect(note, `no element with id "${describedBy}" — aria-describedby points at nothing`).not.toBeNull();
		expect(note!.textContent).toContain('CHALLENGE_CLOSED');
	});

	it('offers the way OUT — the reason links to the board, which now defaults to live challenges', async () => {
		const el = await render({ challengeId: 'ch-1', challengeClosed: true });
		const link = el.querySelector('a.submit-hint#submit-challenge-closed') as HTMLAnchorElement | null;
		expect(link, 'the "challenge is closed" hint is not a link, so the refusal names a dead end').not.toBeNull();
		expect(link!.getAttribute('href')).toBe('/challenges');
	});

	it('OUTRANKS the name gate — renaming the flow cannot make a dead challenge accept it', async () => {
		// Both blockers are true. Offering "name it first" here would send the author to fix the one
		// thing that changes nothing about the refusal they are about to get.
		const el = await render({ challengeId: 'ch-1', challengeClosed: true, name: DEFAULT_NAMES.nl });
		const btn = submitButton(el);
		expect(btn.disabled).toBe(true);
		expect(btn.getAttribute('aria-describedby')).toBe('submit-challenge-closed');
		expect(el.textContent).toContain('CHALLENGE_CLOSED');
		expect(el.textContent).not.toContain('NEEDS_NAME');
	});

	it('LOSES to the no-challenge gate — with nothing in context there is no challenge to be closed', async () => {
		// `challengeClosed` is meaningless without a `challengeId`, and /build leaves it `false` in
		// that case anyway. Pinned so a future refactor cannot make the two hints fight.
		const el = await render({ challengeId: null, challengeClosed: true });
		const btn = submitButton(el);
		expect(btn.getAttribute('aria-describedby')).toBe('submit-needs-challenge');
		expect(el.textContent).toContain('NEEDS_CHALLENGE');
		expect(el.textContent).not.toContain('CHALLENGE_CLOSED');
	});

	it('says nothing about the challenge once the flow is already SUBMITTED', async () => {
		// Same call as the name gate: this flow's submission already happened, so a refusal it never
		// met sitting beside a dead "Submitted ✓" describes nothing that is true of it.
		const el = await render({
			challengeId: 'ch-1',
			challengeClosed: true,
			status: 'submitted' as FlowStatus
		});
		const btn = submitButton(el);
		expect(btn.disabled, 'a submitted flow must stay unsubmittable').toBe(true);
		expect(btn.textContent).toContain('SUBMITTED_LABEL');
		expect(el.textContent).not.toContain('CHALLENGE_CLOSED');
		expect(btn.getAttribute('aria-describedby')).toBeNull();
	});

	it('⚠️ is ENABLED and silent when the challenge is OPEN — the gate is not just "always off"', async () => {
		// The mirror case. Without it, hard-coding `challengeClosed` true (or `disabled={true}`) would
		// pass every assertion above.
		const el = await render({ challengeId: 'ch-1', challengeClosed: false });
		const btn = submitButton(el);
		expect(btn.disabled).toBe(false);
		expect(el.textContent).not.toContain('CHALLENGE_CLOSED');
		expect(btn.getAttribute('aria-describedby')).toBeNull();
		expect(el.querySelector('a.submit-hint#submit-challenge-closed')).toBeNull();
	});
});

function titleInput(el: HTMLElement): HTMLInputElement {
	const input = el.querySelector('input.title') as HTMLInputElement | null;
	expect(input, 'no title input in the topbar').not.toBeNull();
	return input!;
}

/** Type into the title WITHOUT blurring — no `change`, exactly what a mouse user does. */
function type(el: HTMLElement, value: string) {
	const input = titleInput(el);
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('the Submit action is gated on the flow having a name a human chose', () => {
	it('is DISABLED while the flow still carries the name the builder invented', async () => {
		const el = await render({ challengeId: 'ch-1', name: DEFAULT_NAMES.nl });
		const btn = submitButton(el);

		expect(
			btn.disabled,
			'Submit is available on a flow named "Naamloze flow". `POST /api/solutions` copies the ' +
				'flow name verbatim into `solutions.title`, and the backend validates only ' +
				'min(1).max(160) — so this click publishes a competition entry with a name nobody chose.'
		).toBe(true);

		// The reason is real text in the DOM, wired to the control it explains — never a `title=` on
		// a disabled (and therefore unfocusable) button.
		expect(el.textContent).toContain('NEEDS_NAME');
		const describedBy = btn.getAttribute('aria-describedby');
		expect(describedBy).toBe('submit-needs-name');
		const note = el.ownerDocument.getElementById(describedBy!);
		expect(note, `no element with id "${describedBy}" — aria-describedby points at nothing`).not.toBeNull();
		expect(note!.textContent).toContain('NEEDS_NAME');
	});

	it('is DISABLED on ANOTHER locale\'s default name — the row sitting in prod today', async () => {
		// The UI locale here is Dutch (UI_LOCALE); the flow carries the ENGLISH default, because the
		// name was baked in at CREATE time in whatever locale its author had then. A gate that
		// compared only `m.build_new_flow_default_name()` — the current locale — goes green here.
		const el = await render({ challengeId: 'ch-1', name: DEFAULT_NAMES.en });
		expect(
			submitButton(el).disabled,
			'a flow created with the UI in English sails through a Dutch gate. This is literally the ' +
				'"Untitled flow" solution in production, one click from being crowned weekly winner.'
		).toBe(true);
		expect(el.textContent).toContain('NEEDS_NAME');
	});

	it('is DISABLED for every locale\'s default name, not just en and nl', async () => {
		for (const [locale, name] of Object.entries(DEFAULT_NAMES)) {
			const el = await render({ challengeId: 'ch-1', name });
			expect(submitButton(el).disabled, `${locale} ("${name}") was accepted as a real name`).toBe(true);
			if (app) unmount(app);
			app = undefined;
			host.innerHTML = '';
		}
	});

	it('is DISABLED on an empty or whitespace-only name', async () => {
		for (const name of ['', '   ']) {
			const el = await render({ challengeId: 'ch-1', name });
			expect(submitButton(el).disabled, `an empty name (${JSON.stringify(name)}) was accepted`).toBe(true);
			if (app) unmount(app);
			app = undefined;
			host.innerHTML = '';
		}
	});

	it('is ENABLED, with no hint, once the flow has a real name', async () => {
		const el = await render({ challengeId: 'ch-1', name: 'Claimformulier-samenvatter' });
		const btn = submitButton(el);
		expect(btn.disabled).toBe(false);
		expect(el.textContent).not.toContain('NEEDS_NAME');
		expect(btn.getAttribute('aria-describedby')).toBeNull();
	});

	it('is ENABLED on "Untitled flow v2" — a name that merely CONTAINS a default', async () => {
		const el = await render({ challengeId: 'ch-1', name: 'Untitled flow v2' });
		expect(
			submitButton(el).disabled,
			'the gate matches by substring, so a deliberate v2 of a default-named flow can never be ' +
				'submitted. Refusing a real name forever is a worse defect than the one being fixed.'
		).toBe(false);
	});

	it('reacts to TYPING — the click after the first keystroke must land', async () => {
		// The title input commits on `onchange`, i.e. on blur/Enter. Clicking a DISABLED button does
		// not move focus, so with no `oninput` draft the `change` never fires and the user's first
		// Submit click is silently eaten by a button that is still disabled.
		const el = await render({ challengeId: 'ch-1', name: DEFAULT_NAMES.nl });
		expect(submitButton(el).disabled).toBe(true);

		type(el, 'Claimformulier-samenvatter');

		expect(
			submitButton(el).disabled,
			'the gate only reacts to blur. A user who types a name and clicks Submit straight away ' +
				'loses the click to a still-disabled button, with no feedback at all.'
		).toBe(false);
		expect(el.textContent).not.toContain('NEEDS_NAME');
	});

	it('re-gates while typing, so clearing the name back to the default disables again', async () => {
		const el = await render({ challengeId: 'ch-1', name: 'Claimformulier-samenvatter' });
		expect(submitButton(el).disabled).toBe(false);
		type(el, '   ');
		expect(submitButton(el).disabled).toBe(true);
		type(el, DEFAULT_NAMES.de);
		expect(submitButton(el).disabled).toBe(true);
	});

	it('still commits the rename on change, and drops the draft', async () => {
		const renamed: string[] = [];
		const el = await render({
			challengeId: 'ch-1',
			name: DEFAULT_NAMES.nl,
			onRename: (n: string) => renamed.push(n)
		});
		const input = titleInput(el);
		input.value = 'Claimformulier-samenvatter';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		input.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		expect(
			renamed,
			'the draft state swallowed the rename — the name is now only in the topbar, and the flow ' +
				'is still called "Naamloze flow" everywhere else.'
		).toEqual(['Claimformulier-samenvatter']);
	});

	it('the hint is the affordance: clicking it focuses AND selects the title', async () => {
		const el = await render({ challengeId: 'ch-1', name: DEFAULT_NAMES.nl });
		const hint = el.querySelector('button.submit-hint#submit-needs-name') as HTMLButtonElement | null;
		expect(hint, 'the "needs a name" reason is not a button, so the refusal names no way out').not.toBeNull();
		expect(hint!.type).toBe('button'); // never a form submit

		hint!.click();
		flushSync();

		const input = titleInput(el);
		expect(el.ownerDocument.activeElement, 'clicking the hint did not focus the title').toBe(input);
		expect(input.selectionStart, 'the existing default name was not selected, so the user has to clear it by hand').toBe(0);
		expect(input.selectionEnd).toBe(DEFAULT_NAMES.nl.length);
	});

	it('marks the title input itself as the thing that is wrong', async () => {
		const unnamedEl = await render({ challengeId: 'ch-1', name: DEFAULT_NAMES.nl });
		expect(titleInput(unnamedEl).classList.contains('unnamed')).toBe(true);
		if (app) unmount(app);
		app = undefined;
		host.innerHTML = '';

		const namedEl = await render({ challengeId: 'ch-1', name: 'Claimformulier-samenvatter' });
		expect(titleInput(namedEl).classList.contains('unnamed')).toBe(false);
	});

	it('says nothing about the name once the flow is already SUBMITTED', async () => {
		// The row this whole commit is about: "Untitled flow", already submitted. Submit is dead by
		// `status === 'submitted'` whatever the name is, so an amber field and a clickable "name it
		// first" beside "Submitted ✓" advertise a fix that cannot change anything — renaming the flow
		// does not retitle the solution row that was already created from it.
		const el = await render({ challengeId: 'ch-1', name: DEFAULT_NAMES.en, status: 'submitted' as FlowStatus });
		const btn = submitButton(el);

		expect(btn.disabled, 'a submitted flow must stay unsubmittable').toBe(true);
		expect(btn.textContent).toContain('SUBMITTED_LABEL');
		expect(
			el.textContent,
			'an actionable "give your flow a name first" hint sits beside a permanently disabled ' +
				'"Submitted ✓" button. Following it changes nothing.'
		).not.toContain('NEEDS_NAME');
		expect(el.querySelector('button.submit-hint#submit-needs-name')).toBeNull();
		expect(btn.getAttribute('aria-describedby')).toBeNull();
		expect(
			titleInput(el).classList.contains('unnamed'),
			'the title is painted amber-as-a-problem on a flow whose submission has already happened'
		).toBe(false);
	});

	it('lets the challenge blocker win — one reason at a time, and the first one first', async () => {
		// With no challenge in context there is nothing to submit TO at all, so naming the flow would
		// not help. The older, more fundamental refusal keeps the slot.
		const el = await render({ challengeId: null, name: DEFAULT_NAMES.nl });
		const btn = submitButton(el);
		expect(btn.disabled).toBe(true);
		expect(btn.getAttribute('aria-describedby')).toBe('submit-needs-challenge');
		expect(el.textContent).toContain('NEEDS_CHALLENGE');
		expect(el.textContent).not.toContain('NEEDS_NAME');
	});
});
