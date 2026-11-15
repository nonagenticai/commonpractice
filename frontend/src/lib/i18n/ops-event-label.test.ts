// src/lib/i18n/ops-event-label.test.ts — a /it-dash feed row is rendered from its KIND plus machine
// fields, with the actor INSIDE the sentence, and only ever falls back to the backend's English
// fragment when there is nothing else to say.
//
// Messages are mocked so each key returns its own name plus its arguments — the assertions are
// about MESSAGE SELECTION and INTERPOLATION, not about copy a translator may reword.
import { describe, it, expect, vi } from 'vitest';
import type {
	FeedEvent,
	BlockPublishedEvent,
	RunFinishedEvent,
	SandboxSuspendedEvent
} from '$lib/types/ops';

vi.mock('$lib/paraglide/messages', () => ({
	ops_event_block_published: (p: Record<string, unknown>) =>
		`M_PUB(${p.actor}|${p.block}|${p.version})`,
	ops_event_run_finished: (p: Record<string, unknown>) => `M_RUN(${p.actor}|${p.flow}|${p.status})`,
	ops_event_sandbox_suspended: (p: Record<string, unknown>) => `M_SUSP(${p.actor}|${p.project})`,
	ops_event_sandbox_suspended_no_project: (p: Record<string, unknown>) => `M_SUSP_NP(${p.actor})`
}));
// The status vocabulary is `run-status-label`'s, not this module's — stubbed so a change to the
// Dutch word for "partial" does not red this file, while REUSE is still asserted.
vi.mock('$lib/i18n/run-status-label', () => ({
	runStatusLabel: (s: string) => `RS(${s})`
}));

const { opsEventLine, opsEventText } = await import('./ops-event-label');

const PROSE = 'published something v9 — backend English';

const PUB: BlockPublishedEvent = {
	kind: 'block_published',
	block: 'triage-claim',
	version: '1.2.0',
	actor: 'Common Practice',
	text: PROSE,
	ts: '2026-08-12T04:00:00.000Z',
	href: '/block-edit?slug=triage-claim'
};
const RUN: RunFinishedEvent = {
	kind: 'run_finished',
	flow: 'Weekly intake',
	runStatus: 'partial',
	actor: 'Lisa de Vries',
	text: PROSE,
	ts: '2026-08-12T04:00:00.000Z'
};
const SUSP: SandboxSuspendedEvent = {
	kind: 'sandbox_suspended',
	project: 'Email auto-categorize',
	actor: 'Fatima Hassani',
	text: PROSE,
	ts: '2026-08-12T04:00:00.000Z'
};

describe('opsEventLine — the normal path', () => {
	it('renders all THREE kinds from the catalog, never the backend prose', () => {
		expect(opsEventLine(PUB)).toEqual({
			localized: true,
			text: 'M_PUB(Common Practice|triage-claim|1.2.0)'
		});
		expect(opsEventLine(RUN)).toEqual({
			localized: true,
			text: 'M_RUN(Lisa de Vries|Weekly intake|RS(partial))'
		});
		expect(opsEventLine(SUSP)).toEqual({
			localized: true,
			text: 'M_SUSP(Fatima Hassani|Email auto-categorize)'
		});
	});

	it('⛔ puts the ACTOR INSIDE the sentence', () => {
		// The whole reason the bold `.feed-actor` span was given up: ar/he put the verb before the
		// subject and run right-to-left, so a fixed `{actor} {fragment}` concatenation is
		// untranslatable. REVERT THAT TURNS THIS RED: drop `actor` from the message arguments and
		// prepend it in `FeedItem` again — the name stops appearing in the returned string.
		for (const e of [PUB, RUN, SUSP] as FeedEvent[]) {
			const line = opsEventLine(e);
			expect(line.localized).toBe(true);
			expect(line.localized && line.text).toContain(e.actor);
		}
	});

	it('leaves no backend English on any full payload', () => {
		for (const e of [PUB, RUN, SUSP] as FeedEvent[]) {
			expect(opsEventText(e)).not.toContain(PROSE);
		}
	});

	it('⛔ REUSES `runStatusLabel` rather than minting a second status vocabulary', () => {
		// REVERT THAT TURNS THIS RED: swap `runStatusLabel(item.runStatus)` for `item.runStatus` —
		// the raw enum reappears where the shared label belongs.
		expect(opsEventLine({ ...RUN, runStatus: 'ok' })).toEqual({
			localized: true,
			text: 'M_RUN(Lisa de Vries|Weekly intake|RS(ok))'
		});
		expect(opsEventLine({ ...RUN, runStatus: 'failed' })).toEqual({
			localized: true,
			text: 'M_RUN(Lisa de Vries|Weekly intake|RS(failed))'
		});
	});

	it('picks a DIFFERENT sentence when the sandbox has no project', () => {
		// Not an empty interpolation: "Fatima's sandbox was suspended · " reads as a bug.
		expect(opsEventLine({ ...SUSP, project: null })).toEqual({
			localized: true,
			text: 'M_SUSP_NP(Fatima Hassani)'
		});
	});

	it('⛔ treats an EMPTY-STRING identifier as present, not missing', () => {
		// REVERT THAT TURNS THIS RED: change the guards to `if (!item.version)` / `if (!item.flow)`.
		// The backend coalesces a NULL subject to '', so these are legal wire values.
		expect(opsEventLine({ ...PUB, version: '' })).toEqual({
			localized: true,
			text: 'M_PUB(Common Practice|triage-claim|)'
		});
		expect(opsEventLine({ ...RUN, flow: '' })).toEqual({
			localized: true,
			text: 'M_RUN(Lisa de Vries||RS(partial))'
		});
	});

	it('maps the three kinds onto DIFFERENT messages', () => {
		const texts = [PUB, RUN, SUSP].map((e) => opsEventText(e as FeedEvent));
		expect(new Set(texts).size).toBe(3);
	});
});

describe('opsEventText', () => {
	it('is the flat form of `opsEventLine` and cannot disagree with it', () => {
		expect(opsEventText(PUB)).toBe('M_PUB(Common Practice|triage-claim|1.2.0)');
		// On the legacy branch it re-joins the two nodes the markup renders separately.
		const legacy = { kind: 'block_published', actor: 'Ada', text: PROSE } as FeedEvent;
		expect(opsEventText(legacy)).toBe(`Ada ${PROSE}`);
	});
});

// ==================================================================================================
// ⛔ THE MID-ROLL BRANCH — the k8s Service load-balances a NEW frontend onto an OLD pod for the
// length of a rolling deploy, so a prose-only feed row is a REAL wire shape.
// ==================================================================================================
describe('the machine fields are STRIPPED — an old backend, mid-roll', () => {
	function stripped(e: FeedEvent): FeedEvent {
		const { kind, actor, text, ts, href } = e as FeedEvent & { href?: string };
		return { kind, actor, text, ts, href } as FeedEvent;
	}

	it('hands back the actor and the prose SEPARATELY, so the old markup still applies', () => {
		for (const e of [PUB, RUN, SUSP] as FeedEvent[]) {
			expect(opsEventLine(stripped(e)), e.kind).toEqual({
				localized: false,
				actor: e.actor,
				text: PROSE
			});
		}
	});

	it('emits NO catalog token and no `undefined` on a stripped payload', () => {
		for (const e of [PUB, RUN, SUSP] as FeedEvent[]) {
			const flat = opsEventText(stripped(e));
			expect(flat).not.toMatch(/M_/);
			expect(flat).not.toContain('undefined');
			expect(flat).toContain(PROSE);
		}
	});

	it('falls back when only PART of a kind’s field set arrived', () => {
		expect(opsEventLine({ ...PUB, version: undefined }).localized).toBe(false);
		expect(opsEventLine({ ...RUN, runStatus: undefined }).localized).toBe(false);
	});

	it('⛔ distinguishes `project: null` (no project) from `project: undefined` (old pod)', () => {
		// A `== null` guard here would conflate them and send a perfectly renderable event down the
		// English path. REVERT THAT TURNS THIS RED: change `item.project === undefined` to
		// `item.project == null`.
		expect(opsEventLine({ ...SUSP, project: null }).localized).toBe(true);
		expect(opsEventLine({ ...SUSP, project: undefined }).localized).toBe(false);
	});
});

describe('an UNRECOGNISED kind', () => {
	// Same rule as `opsAlertTitle`: this is an operational surface, so it degrades to the English
	// sentence, never to a bare `sandbox_promoted` token.
	const UNKNOWN = {
		kind: 'sandbox_promoted',
		actor: 'Ada Lovelace',
		text: PROSE,
		ts: '2026-08-12T04:00:00.000Z'
	} as unknown as FeedEvent;

	it('renders the PROSE, never the raw key', () => {
		expect(opsEventLine(UNKNOWN)).toEqual({
			localized: false,
			actor: 'Ada Lovelace',
			text: PROSE
		});
		expect(opsEventText(UNKNOWN)).not.toContain('sandbox_promoted');
	});

	it('renders the prose for an ABSENT kind', () => {
		const noKind = { actor: 'Ada', text: PROSE, ts: '' } as unknown as FeedEvent;
		expect(opsEventText(noKind)).toBe(`Ada ${PROSE}`);
	});
});
