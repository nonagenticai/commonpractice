// @vitest-environment jsdom
//
// src/lib/components/ops/audit-row.system-actor.render.test.ts — the actor cell of one /audit row.
//
// ⛔ THE DEFECT. `backend/src/routes/audit.ts` answered "who did this?" for an unattributed row
// with the object `{ name: 'System', initials: 'SYS' }` — an English NOUN, minted on a server that
// cannot know who is reading — and this component printed `item.actor.name` verbatim. The same
// backend line feeds /ontology's otherwise fully-localized "Recente wijzigingen" panel, where the
// result read "System · Aangepaste entiteit aangemaakt · 2u geleden".
//
// The fix carries the FACT (no human actor → `actor: null`) and lets the browser choose the word.
//
// ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. `item.action` (a raw backend enum) and
// `item.targetId` (a UUID) are still English and are a separate, deliberately deferred lane. The
// fixtures below carry real English values in those fields precisely so that a future "fix" which
// localizes the actor by localizing everything is not what makes this file green.
//
// ⚠️ `item.result` HAS SINCE LEFT THAT LIST FOR THE ROWS THAT CARRY A `resultCode` — see
// `audit-row.flow-summary.render.test.ts`. Every fixture here has NO code, so `flowSummaryLabel`
// takes its permanent fallback and this row's result cell renders verbatim exactly as it always
// did; the last case below is what states that out loud.
//
// ⚠️ NON-VACUITY. A component that threw renders nothing, and "the English word is absent" is true
// of an empty DOM. Every case below asserts the EXACT text of the actor cell, and the human-actor
// case asserts the name still arrives untouched — so "it localized the absence" cannot be confused
// with "it stopped rendering actors".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { AuditItem } from '$lib/types/audit';

// The real `en` catalog with every key resolving to its own name (the house seam — a message key
// this component asks for and the catalog does not have reds here rather than rendering nothing),
// EXCEPT the one key this file is about: `audit_actor_system` resolves to a token that shares no
// substring with the English literal being banished, so `not.toContain('System')` cannot be
// satisfied by the replacement itself. (`timeAgo` calls three catalog keys of its own, which is why
// a hand-written mock of one key is not enough here.)
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	mod.audit_actor_system = () => 'GEEN_MENS';
	return mod;
});

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

/** The three still-English cells carry their real backend values — see the header note. */
const BASE: Omit<AuditItem, 'actor'> = {
	id: 'a-1',
	action: 'ontology.entity_create',
	category: 'data',
	targetType: 'ontology_entity',
	targetId: '3f1c8b2e-1c4a-4d2b-9f0e-6c1b2d3e4a8b',
	result: "Custom entity 'Policy'",
	resultTone: 'ok',
	createdAt: '2026-08-18T10:00:00.000Z'
};

async function render(item: AuditItem) {
	const { default: AuditRow } = await import('./AuditRow.svelte');
	const table = document.createElement('table');
	const body = document.createElement('tbody');
	table.appendChild(body);
	host.appendChild(table);
	app = mount(AuditRow, { target: body, props: { item } });
	flushSync();
	return host;
}

// `:not(.avatar)` because the Avatar monogram is itself a `<span>` inside `.actor` and comes FIRST
// — a bare `.actor span` selects the initials, and every assertion below would then be about the
// two-letter monogram rather than about the name. (Measured: it made all three name assertions fail
// with 'SYS'/'MV', which is the friendly direction, but a case asserting `not.toContain` would have
// passed for the wrong reason.)
const actorText = (el: HTMLElement) => el.querySelector('.actor span:not(.avatar)')!.textContent;

describe('an audit row with no human actor names the absence in the reader’s language', () => {
	it('⛔ `actor: null` renders the catalog word, and the English "System" is nowhere on the row', async () => {
		const el = await render({ ...BASE, actor: null });
		expect(actorText(el)).toBe('GEEN_MENS');
		expect(el.textContent).not.toContain('System');
	});

	it('the avatar still shows a monogram — the cell is localized, not emptied', async () => {
		// 'SYS' is a glyph, not a sentence: it is the same three characters in all eight locales and
		// it is what stops the row rendering a naked circle where every other row has initials.
		const el = await render({ ...BASE, actor: null });
		expect(el.querySelector('.avatar')!.textContent).toBe('SYS');
	});

	it('⛔ NON-VACUITY — a HUMAN actor is still rendered verbatim, never replaced by the catalog word', async () => {
		const el = await render({
			...BASE,
			actor: { name: 'Mary de Vries', initials: 'MV' }
		});
		expect(actorText(el)).toBe('Mary de Vries');
		expect(el.querySelector('.avatar')!.textContent).toBe('MV');
		expect(el.textContent).not.toContain('GEEN_MENS');
	});

	it('⚠️ MID-ROLL — an old pod still shipping `{ name: "System" }` renders exactly as it does today', async () => {
		// The browser cannot tell that object from a user genuinely called "System", and must not
		// try: sniffing the name would rename a real person. For the length of a rolling deploy the
		// unattributed rows read English, which is the status quo, and they flip the moment the pod
		// behind the Service is the new one.
		const el = await render({ ...BASE, actor: { name: 'System', initials: 'SYS' } });
		expect(actorText(el)).toBe('System');
	});

	it('⚠️ the three deferred English cells are untouched — this change is scoped to the actor', async () => {
		const el = await render({ ...BASE, actor: null });
		expect(el.textContent).toContain('ontology.entity_create');
		expect(el.textContent).toContain('3f1c8b2e-1c4a-4d2b-9f0e-6c1b2d3e4a8b');
		expect(el.textContent).toContain("Custom entity 'Policy'");
	});
});
