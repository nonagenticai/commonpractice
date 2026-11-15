// @vitest-environment jsdom
//
// src/routes/(tenant)/delivery/delivery-page.test-result.render.test.ts — the strip under each
// connector row's **Testen** link.
//
// ⛔ THE DEFECT. `<div class="test-result …">{testResults[t.id].detail}</div>`. `POST
// /api/delivery-targets/:id/test` is the endpoint whose OWN DOCBLOCK spells out the 200-OK rule —
// "Returns 200 {ok, detail} in all reachable cases — a config/credential failure is a normal test
// result, surfaced as ok:false rather than an HTTP error" — which is precisely why `errorText` is
// never reached here and why every one of these sentences reached a Dutch admin in English.
//
// ⛔⛔ AND THE PRODUCT NAME WAS BAKED IN TOO. The adapters used to write "Connected to Jira as …"
// and "Azure DevOps returned HTTP 502" as prose. They now emit a machine `kind` and the browser
// resolves the tool name through `deliveryKindLabel` — the same function the kind badge two lines
// up already used, so one row can no longer name the same tool two different ways.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DeliveryTarget } from '$lib/api/delivery';

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

const { listFn, testFn } = vi.hoisted(() => ({ listFn: vi.fn(), testFn: vi.fn() }));

// ⚠️ Real `deliveryApi` method names, checked against the client.
vi.mock('$lib/api/delivery', () => ({
	deliveryApi: {
		list: listFn,
		test: testFn,
		create: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		listForSolution: vi.fn(),
		forward: vi.fn(),
		retry: vi.fn()
	},
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';

const TARGET: DeliveryTarget = {
	id: 't-1',
	kind: 'jira',
	name: 'Acme Jira',
	baseUrl: 'https://acme.atlassian.net',
	projectKey: 'DEL',
	defaultItemType: 'Epic',
	config: {},
	enabled: true,
	hasCredentials: true,
	createdAt: '2026-08-14T09:00:00.000Z',
	updatedAt: '2026-08-14T09:00:00.000Z'
};

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle(until: () => boolean, tries = 40) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

async function pressTest(result: unknown, kind: DeliveryTarget['kind'] = 'jira') {
	listFn.mockResolvedValue([{ ...TARGET, kind }]);
	testFn.mockResolvedValue(result);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle(() => !!host.querySelector('.target-actions button'));

	const testBtn = [...host.querySelectorAll('.target-actions button')].find(
		(b) => b.textContent?.trim() === 'delivery_test'
	) as HTMLButtonElement | undefined;
	expect(testBtn, 'the Test link is not on screen — this case tests nothing').toBeTruthy();
	testBtn!.click();
	await settle(() => !!host.querySelector('.test-result'));

	const strip = host.querySelector('.test-result');
	expect(strip, 'no test-result strip rendered — this case tests nothing').not.toBeNull();
	return strip!;
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	listFn.mockReset();
	testFn.mockReset();
});

describe('(tenant)/delivery renders the test result from its CODE', () => {
	it('⛔ THE SUCCESS PATH — Jira, HTTP 200, ok:true, tool name localized too', async () => {
		const strip = await pressTest({
			ok: true,
			code: 'delivery_test_jira_ok',
			params: { user: 'Mary de Vries' },
			detail: 'Connected to Jira as Mary de Vries.'
		});
		expect(strip.className).toContain('ok');
		expect(strip.textContent).toBe('delivery_test_jira_ok:delivery_kind_jira,⁨Mary de Vries⁩');
		expect(host.textContent).not.toContain('Connected to Jira as Mary de Vries.');
	});

	it('⛔ the ANONYMOUS success gets its OWN code — no English "the configured user" on the wire', async () => {
		// Jira answers /myself with neither a display name nor an email often enough (an app-scoped
		// token, a privacy-restricted directory) that the backend used to paper over it with an
		// English literal. Prose on the wire is the whole defect.
		const strip = await pressTest({
			ok: true,
			code: 'delivery_test_jira_ok_anon',
			params: {},
			detail: 'Connected to Jira as the configured user.'
		});
		expect(strip.textContent).toBe('delivery_test_jira_ok_anon:delivery_kind_jira');
		expect(host.textContent).not.toContain('the configured user');
	});

	it('⛔ an ADO project success names the project and the tool from machine facts', async () => {
		const strip = await pressTest(
			{
				ok: true,
				code: 'delivery_test_ado_ok',
				params: { project: 'Claims' },
				detail: 'Connected to Azure DevOps project "Claims".'
			},
			'azure_devops'
		);
		expect(strip.textContent).toBe(
			'delivery_test_ado_ok:delivery_kind_azure_devops,⁨Claims⁩'
		);
	});

	it('⛔ an HTTP failure carries the status WITHOUT a thousands separator', async () => {
		const strip = await pressTest({
			ok: false,
			code: 'delivery_test_http',
			params: { kind: 'jira', status: 502 },
			detail: 'Jira returned HTTP 502.'
		});
		expect(strip.className).toContain('error');
		expect(strip.textContent).toBe('delivery_test_http:delivery_kind_jira,502');
		expect(strip.textContent).not.toContain('5.02');
	});

	it('⛔ a precheck refusal forwards an HttpError code and falls back to `detail`', async () => {
		// `egress_host_not_allowlisted` comes from a code space this switch does not own, which is
		// exactly the case the documented fallback exists for. It must never render a bare token.
		const strip = await pressTest({
			ok: false,
			code: 'egress_host_not_allowlisted',
			detail: 'acme.atlassian.net is not on the outbound allowlist'
		});
		expect(strip.textContent).toBe('acme.atlassian.net is not on the outbound allowlist');
		expect(strip.textContent).not.toContain('egress_host_not_allowlisted');
	});

	it('⛔ MID-ROLL — an old pod sending only `detail` still renders it, never blank', async () => {
		const strip = await pressTest({ ok: true, detail: 'Connected to Jira as Mary de Vries.' });
		expect(strip.textContent).toBe('Connected to Jira as Mary de Vries.');
	});
});
