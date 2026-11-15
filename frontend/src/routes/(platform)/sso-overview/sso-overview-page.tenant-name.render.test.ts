// @vitest-environment jsdom
//
// src/routes/(platform)/sso-overview/sso-overview-page.tenant-name.render.test.ts — what the
// platform SSO overview actually PUTS in its Tenant column.
//
// ⛔ THE DEFECT. `/sso-overview` is the one screen whose entire purpose is "which tenant has which
// identity provider". Its first column, headed `admin_sso_col_tenant`, rendered `{p.tenantId}` —
// a raw UUID, in `--font-mono`, clipped by `text-overflow: ellipsis` inside a 1.6fr grid track. A
// super_admin scanning the table for a tenant could not tell which tenant any row belonged to.
//
// The fix widened the backend DTO (`sso-service.ts listAllIdps` leftJoins `tenants`, giving each
// row an optional `tenantName`) rather than resolving names in the browser from `allTenants` —
// that call is PAGINATED at 500 and `(tenant)/sso/+page.svelte`'s own fallback for a miss is
// `name: scopeTenantId`, i.e. it renders the UUID again. See the comment on `listAllIdps`.
//
// ⛔ THIS ROUTE HAD NO TEST FILE AT ALL before this one, so there is no harness to inherit: the
// messages module is mocked key-returns-its-own-name (the technique in
// `(platform)/onboarding/onboarding.email-outcome.render.test.ts`), which also means an assertion
// about the tenant column cannot accidentally match translated chrome.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import type { IdpProvider } from '$lib/types/admin';

vi.mock('$lib/paraglide/messages', () => {
	const keys = [
		'admin_tenants_eyebrow', 'admin_sso_overview_title', 'admin_sso_overview_lede',
		'admin_denied', 'admin_loading', 'admin_load_failed', 'error_load_failed',
		'admin_sso_col_tenant', 'admin_sso_col_provider', 'admin_sso_col_status',
		'admin_sso_col_secret', 'admin_sso_overview_empty', 'admin_sso_enabled',
		'admin_sso_disabled', 'admin_sso_secret_set', 'admin_sso_secret_unset', 'admin_sso_manage'
	];
	return Object.fromEntries(keys.map((k) => [k, () => k]));
});
vi.mock('$lib/api/error-message', () => ({ errorText: () => 'ERR' }));

const UUID = '9f1c3a2e-7b84-4d16-9a05-2c8f41b6de77';
const NAME = 'Acme Verzekeringen';

/** What the fake backend answers `allSsoProviders()` with. */
let providers: IdpProvider[];

vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: { allSsoProviders: async () => ({ providers }) }
}));

function row(over: Partial<IdpProvider> = {}): IdpProvider {
	return {
		id: 'idp-1',
		tenantId: UUID,
		tenantName: NAME,
		alias: 'entra-acme',
		displayName: 'Acme Entra ID',
		providerType: 'oidc',
		enabled: true,
		config: {
			discovery_url: 'https://login.microsoftonline.com/x/.well-known/openid-configuration',
			client_id: 'cid',
			scopes: 'openid',
			trust_email: true
		},
		linkOnly: false,
		hasSecret: true,
		redirectUri: 'https://auth.example/broker/entra-acme/endpoint',
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-01T00:00:00.000Z',
		...over
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	providers = [row()];
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Let onMount → load() settle. */
async function render(): Promise<HTMLElement> {
	const { default: Page } = await import('./+page.svelte');
	app = mount(Page, { target: host });
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 12; i++) await Promise.resolve();
	return host;
}

/**
 * ⛔ ANTI-VACUITY GATE. The page opens in `{#if loading}`, which renders one notice and NO table.
 * Every `not.toContain(UUID)` below passes trivially against a page stuck there, or against a
 * dropped row. So: prove a row rendered, by a positive marker only the loaded table emits.
 */
function tenantCell(el: HTMLElement): HTMLElement {
	expect(el.textContent, 'the page never left its loading branch').toContain('admin_sso_col_tenant');
	const cells = [...el.querySelectorAll<HTMLElement>('.ctenant')];
	expect(cells.length, 'no provider row rendered — the assertions below would be vacuous').toBe(
		providers.length
	);
	return cells[0]!;
}

describe('/sso-overview names the tenant it is about', () => {
	it('⛔ the Tenant column reads the tenant NAME, not its UUID', async () => {
		const el = await render();
		const cell = tenantCell(el);

		expect(el.textContent).toContain(NAME);
		// The column itself carries no identifier. Asserting on the CELL and not on the document
		// matters: `href="/sso?tenant=<uuid>"` on the Manage link is deliberately UNCHANGED, so the
		// uuid is still in the DOM — just not where a human reads the tenant.
		expect(cell.textContent).toBe(NAME);
		expect(cell.textContent).not.toContain(UUID);
	});

	it('keeps the id reachable as the cell tooltip', async () => {
		const el = await render();
		// An operator still needs the uuid to paste into a query; a `title` gives it without
		// spending the column on it.
		expect(tenantCell(el).getAttribute('title')).toBe(UUID);
	});

	it('falls back to the id when the row has no tenantName', async () => {
		// `tenantName` is optional on the DTO (`listTenantIdps` never sets it; the overview's
		// leftJoin leaves it undefined for a row with no `tenants` match). A row must still LIST —
		// showing an unreadable id beats hiding a live identity provider from the platform admin.
		providers = [row({ tenantName: undefined })];
		const el = await render();
		expect(tenantCell(el).textContent).toBe(UUID);
	});

	it('the drill-down link stays keyed by the tenant id', async () => {
		// ⛔ Load-bearing. Cases 1–3 are all satisfied by a page that renders the name and drops the
		// id everywhere — including out of the `Manage` href, which `/sso` reads as `?tenant=`.
		const el = await render();
		tenantCell(el);
		const manage = el.querySelector<HTMLAnchorElement>('a.cmanage');
		expect(manage?.getAttribute('href')).toBe(`/sso?tenant=${UUID}`);
	});
});
