// @vitest-environment jsdom
//
// src/routes/connectors/connectors.sync-action-reason-dutch.render.test.ts — the banner a Dutch
// admin gets AT THE MOMENT a manual Sync fails.
//
// ⛔ THE DEFECT, AND IT IS THE SAME STRING FIXED TWICE IN TWO PLACES AND MISSED IN A THIRD.
// `syncNow` did:
//
//     actionError = n.reason ? m.connectors_sync_failed({ reason: n.reason }) : …
//
// `RefreshOutcome.reason` on the failure branch is `code` — literally the same variable
// `connector-refresh.ts` writes to `datasets.sync_error_code` in the same `catch` — so the machine
// token went straight into "Synchronisatie mislukt: {reason}" and the admin read
//
//     Synchronisatie mislukt: egress_host_not_allowlisted
//
// ⛔ THE COPY ALREADY EXISTED, AND WAS ALREADY ON THE SAME SCREEN. The PERSISTED half of this
// exact failure — the drawer notice and the status-badge tooltip — resolves through `syncErrorText`
// and reads fluent Dutch; `connectors.sync-error-dutch.render.test.ts` beside this file pins it.
// So one failure had TWO renderings on one page: Dutch once the row had been re-read, English (a
// bare snake_case token) at the instant it happened. The action path was the one that walked past
// the catalog.
//
// ⚠️ WHY THE UNKNOWN-CODE ARM FALLS BACK TO THE CODE AND NOT TO A GENERIC SENTENCE. `syncErrorText`
// itself carries a "⛔ NEVER `code` ITSELF" note — written for the PERSISTED path, which always has
// the backend's English `sync_error` column to fall back to. `RefreshOutcome` has no such field: it
// carries a code and nothing else. So the real choice on this branch is between naming the cause
// and hiding it behind `error_action_failed()`, and a token an admin can quote beats a sentence
// that says nothing. Asserted below so nobody "improves" it into a generic later.
//
// ⛔ `$lib/api/error-message` IS DELIBERATELY NOT MOCKED — `syncErrorText` IS the unit under test.
// Every other render file in this directory stubs it to `(_code, legacy) => legacy`, which is the
// other half of why this survived: in the one suite that drives the Sync button, the only module
// that could have localized the string was never loaded.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connector, ConnectorList, RefreshOutcome } from '$lib/types/connectors';

// The **nl** catalog, for real: the subject of this file is the rendered sentence, and a key-name
// stub would prove only that a message function was called — which is exactly what the defect
// already did.
vi.mock('$lib/paraglide/messages', async () => {
	const nl = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')) as Record<
		string,
		string
	>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(nl)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			nl[key]!.replace(/\{(\w+)\}/g, (whole, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/paraglide/runtime', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getLocale: () => 'nl'
}));

const { list, sync } = vi.hoisted(() => ({ list: vi.fn(), sync: vi.fn() }));
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record than
// the one the page imports and silently does nothing.
vi.mock('$lib/api/connectors', () => ({
	connectorsApi: {
		list,
		sync,
		get: vi.fn(),
		create: vi.fn(),
		test: vi.fn(),
		rotateSecret: vi.fn(),
		reregisterNotifications: vi.fn(),
		verifyNotifications: vi.fn(),
		reconcileNotifications: vi.fn(),
		remove: vi.fn()
	},
	// No SSE — the banner must follow from the response body alone.
	streamConnectors: () => ({ close: () => {} }),
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';
import { locale } from '$lib/stores/locale.svelte';

const NL = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')) as Record<
	string,
	string
>;

/** The nl pattern for `key`, refusing to hand back something an assertion could not fail on. */
function nlPattern(key: string): string {
	const pattern = NL[key];
	expect(pattern, `no nl copy for '${key}' — an assertion using it would prove nothing`).toBeTruthy();
	expect(pattern!.length, `'${key}' resolved to an empty sentence`).toBeGreaterThan(3);
	return pattern!;
}

const CONNECTOR: Connector = {
	id: 'c-1',
	slug: 'claims-files',
	name: 'ZSYNCACT Claims Files',
	sourceType: 'storage',
	status: 'ready',
	eventSource: 'none',
	meta: { kind: 'storage', host: 'files.example.com', bucket: 'claims', key: 'x.csv' },
	columns: [],
	rowCount: 0,
	sizeBytes: 0,
	sandboxId: null,
	lastSyncedAt: '2026-08-09T10:00:00.000Z',
	// ⛔ NULL, ON PURPOSE. This file is about the LIVE action response, not the persisted column —
	// a non-null `syncError` here would let the drawer's (already-fixed) path supply Dutch text and
	// mask whichever language the banner chose.
	syncError: null,
	syncErrorCode: null,
	syncErrorDetail: null,
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-09T10:00:00.000Z'
};

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
const initialLocale = locale.current;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount the page, click Sync on the single connector, and return the red banner's text. */
async function syncFailure(outcome: RefreshOutcome): Promise<string> {
	list.mockResolvedValue({
		items: [{ ...CONNECTOR }],
		total: 1,
		page: 1,
		pageSize: 20,
		canManage: true
	} satisfies ConnectorList);
	sync.mockResolvedValue({ ...CONNECTOR, status: 'error', rows: [], sync: outcome });
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	const syncBtn = [...target.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === nlPattern('connectors_sync')
	) as HTMLButtonElement | undefined;
	// ⛔ THE POSITIVE ANCHOR. Without it every "the raw code is gone" assertion below passes for
	// free on a page whose Sync button never rendered.
	expect(syncBtn, 'the Sync button is not on screen — this file would test nothing').toBeTruthy();
	syncBtn!.click();
	await settle();

	const err = target.querySelector('.notice.error');
	expect(err, 'clicking Sync produced no error banner').not.toBeNull();
	return (err!.textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
	locale.current = 'nl';
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	locale.current = initialLocale;
	list.mockReset();
	sync.mockReset();
});

describe('a failed Sync names its cause in Dutch, at the moment it fails', () => {
	it('the fixture is really Dutch and the two sentences really differ', () => {
		// ⛔ NON-VACUITY. Every assertion below rests on the nl catalog actually being loaded. If the
		// mock regressed to English, `error_egress_host_not_allowlisted_generic` would be an English
		// sentence and `not.toContain('egress_host_not_allowlisted')` would STILL pass — proving the
		// opposite of what it claims.
		expect(nlPattern('connectors_sync_failed')).toContain('Synchronisatie mislukt');
		const generic = nlPattern('error_egress_host_not_allowlisted_generic');
		expect(generic).toContain('toegestane');
		expect(generic).not.toContain('egress_host_not_allowlisted');
	});

	it('⛔ a refused host reads the Dutch sentence, not the wire code', async () => {
		// The exact code `connector-refresh.ts` returns when the egress guard refuses the host.
		// ⚠️ THE GENERIC VARIANT IS THE RIGHT ONE HERE: `RefreshOutcome` carries no details bag, so
		// the catalog entry cannot interpolate `{host}` and correctly degrades to the host-less
		// sentence rather than to English.
		const text = await syncFailure({ ok: false, reason: 'egress_host_not_allowlisted' });
		expect(text).toContain('Synchronisatie mislukt');
		expect(text).toContain(nlPattern('error_egress_host_not_allowlisted_generic'));
		// ⛔ THE ASSERTION THAT INVERTS ON A REVERT TO `{ reason: n.reason }`.
		expect(text, 'the bare wire code is still on the banner').not.toContain(
			'egress_host_not_allowlisted'
		);
	});

	it('…and a second catalogued code, so the wire is not one hardcoded arm', async () => {
		const text = await syncFailure({ ok: false, reason: 'egress_disabled' });
		expect(text).toContain(nlPattern('error_egress_disabled'));
		expect(text).not.toContain('egress_disabled');
	});

	it('⛔ AN UNCATALOGUED CODE KEEPS ITS OWN NAME — never a generic sentence', async () => {
		// `sync_failed` is `connector-refresh.ts`'s DEFAULT arm — any throw that is neither an
		// egress refusal nor an HttpError — and it has no VALIDATION_MESSAGES entry. Naming the
		// cause beats hiding it: an admin can quote this token, and `error_action_failed()` would
		// tell them strictly less than the code did before this change.
		const text = await syncFailure({ ok: false, reason: 'zzz_no_such_code' });
		expect(text).toContain('Synchronisatie mislukt');
		expect(text).toContain('zzz_no_such_code');
		expect(text).not.toContain(nlPattern('error_action_failed'));
	});

	it('the table survives the banner — an action error must not blank the board', async () => {
		// The near-miss the sibling `sync-outcome.render.test.ts` documents: writing this into the
		// page's `error` state puts it inside `{:else if error}` and the table it was meant to
		// explain disappears. Re-asserted here because this change touches that exact line.
		await syncFailure({ ok: false, reason: 'egress_host_not_allowlisted' });
		expect(target.querySelector('table'), 'the connector table was blanked').not.toBeNull();
		expect(target.textContent).toContain('ZSYNCACT Claims Files');
	});
});
