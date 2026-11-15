// @vitest-environment jsdom
//
// src/routes/connectors/connectors-page.row-actions-gate.render.test.ts — the connector table
// offered five writes to a reader the server refuses.
//
// ⛔ THE DEFECT, AS A TESTER MET IT. Logged in as an ordinary member of the org, /connectors
// rendered Sync / Rotate secret / Verify notifications / Re-register / Delete on every row — the
// last of them styled `btn-sm danger`. Every one of those is `requireDataManager` on the wire
// (backend/src/routes/connectors.ts:522, :542, :734, :576, :797), i.e. tenant_admin or platform, so
// a member's click could only ever produce a 403 in the `actionError` strip.
//
// ⛔ AND THE PAGE ALREADY KNEW. The list response carries `canManage`, and the HEADER's "New
// connector" / "Reconcile" and the empty state's CTA had keyed off it since Phase 2-A. One screen,
// one permission, two answers — the row actions simply never got the flag.
//
// ⛔ WHY BOTH HALVES ARE ASSERTED. `{#if false}` satisfies any "the member sees no Delete" case
// forever, so the manager half below is the one that reds on an over-correction. And Preview is
// asserted PRESENT for the member specifically: `getConnector` is `resolveTenant`
// (connectors.ts:507) — reading a connector's rows is a member's to do, and hiding the whole
// action cell would have been a different defect wearing this fix's clothes.
//
// ⚠️ The fixture is deliberately the MAXIMAL connector — storage + webhook + a failed notification
// registration — because that is the only shape for which all five gated buttons render at once.
// A postgres row would have made three of the five assertions vacuous.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Connector, ConnectorList } from '$lib/types/connectors';

// Real `en` catalog, each key resolving to its own name — an assertion names a MESSAGE KEY, so no
// reworded translation can red this file.
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
	return mod;
});

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record than
// the one the page imports and silently does nothing.
vi.mock('$lib/api/connectors', () => ({
	connectorsApi: {
		list,
		get: vi.fn(),
		sync: vi.fn(),
		create: vi.fn(),
		test: vi.fn(),
		rotateSecret: vi.fn(),
		reregisterNotifications: vi.fn(),
		verifyNotifications: vi.fn(),
		reconcileNotifications: vi.fn(),
		remove: vi.fn()
	},
	streamConnectors: () => ({ close: () => {} }),
	ApiError: class ApiError extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			message: string
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback,
	// ⚠️ THE LEGACY-TEXT ARM ONLY — every fixture in THIS file sets `syncError: null`, so the stub
	// is never asked for a sentence. The real catalog path (a wire code → the reader's own
	// language) is asserted in connectors.sync-error-dutch.render.test.ts, which deliberately does
	// NOT mock this module. Do not add a non-null `syncError` fixture here expecting localization.
	syncErrorText: (_code: string | null | undefined, legacy: string | null | undefined) =>
		legacy ?? ''
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';

/** storage + webhook + a FAILED notify registration — the one shape that renders all five. */
const CONNECTOR: Connector = {
	id: 'c-1',
	slug: 'claims-drop',
	name: 'Claims drop bucket',
	sourceType: 'storage',
	status: 'ready',
	eventSource: 'webhook',
	meta: { kind: 'storage', host: 'storage.example.com', bucket: 'claims', notifyRegistered: false },
	columns: [],
	rowCount: 120,
	sizeBytes: 4096,
	sandboxId: null,
	lastSyncedAt: '2026-08-09T10:00:00.000Z',
	syncError: null,
	syncErrorCode: null,
	syncErrorDetail: null,
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-09T10:00:00.000Z'
};

/** Every row action that answers 403 for a member, by the key it renders. */
const GATED = [
	'connectors_sync',
	'connectors_rotate',
	'connectors_verify',
	'connectors_reregister',
	'connectors_delete'
] as const;

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount the roster as a caller with (or without) the data-manager right. */
async function render(canManage: boolean) {
	list.mockResolvedValue({
		items: [{ ...CONNECTOR }],
		total: 1,
		page: 1,
		pageSize: 20,
		canManage
	} satisfies ConnectorList);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// ⛔ POSITIVE ANCHOR. Without a rendered row every "…is absent" assertion below passes for free.
	expect(host.querySelectorAll('td.row-actions').length, 'the table never rendered its row').toBe(1);
}

const rowActionLabels = () =>
	[...host.querySelectorAll<HTMLButtonElement>('td.row-actions button')].map((b) =>
		b.textContent?.trim()
	);

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	list.mockReset();
});

describe('/connectors row actions under a reader who cannot manage', () => {
	it('⛔ THE DEFECT: a member is offered none of the five data-manager writes', async () => {
		await render(false);
		for (const key of GATED) {
			expect(
				rowActionLabels(),
				`${key} renders for a member, and the API answers 403 on click`
			).not.toContain(key);
		}
	});

	it('…and still gets Preview, which the server grants them', async () => {
		// `getConnector` is `resolveTenant` (connectors.ts:507). Emptying the action cell entirely
		// would satisfy the case above while taking away a read a member is entitled to.
		await render(false);
		expect(rowActionLabels(), 'the member lost the one action they are allowed').toEqual([
			'connectors_preview'
		]);
	});

	it('A DATA MANAGER STILL GETS ALL SIX — the over-correction guard', async () => {
		// ⛔ `{#if false}` passes both cases above forever; this is the half that reds on it.
		await render(true);
		const labels = rowActionLabels();
		for (const key of GATED) {
			expect(labels, `${key} disappeared for the tenant_admin who owns it`).toContain(key);
		}
		expect(labels).toContain('connectors_preview');
	});
});
