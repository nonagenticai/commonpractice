// @vitest-environment jsdom
//
// src/routes/(platform)/tenants/tenants-page.create-licence.render.test.ts — the create form under
// A2: CP registers its OWN licences tenant, so there is no adopt prompt any more; the body carries
// the plan (default pre-selected from the catalogue) and optional licence dates; the result says how
// the first-admin invite was delivered and, when licences gave the tenant a suffixed name, says so.
//
// (Was tenants-page.create-adopt.render.test.ts — the adopt flow it pinned is gone by design.)
//
// The form sits behind the "New workspace" button (the list gets the full width), so `render()`
// opens it first. Same harness as [id]/tenant-page.offboard.render.test.ts: messages are mocked key-returns-its-own-name
// from the real en.json, so no assertion depends on wording.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { PlatformTenant, LicencePlan } from '$lib/types/admin';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const stub = (key: string) => (params?: Record<string, unknown>) =>
		params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = stub(key);
	return mod;
});

vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, f: string) => f,
	writeErrorText: (e: unknown, f: string) => `${f}[${(e as { code?: string })?.code ?? ''}]`
}));
vi.mock('$lib/stores/activeTenant.svelte', () => ({
	activeTenant: { current: null, set: vi.fn() }
}));

const { allTenants, createTenant, plans, FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			readonly details?: Record<string, unknown>
		) {
			super(code);
		}
	}
	return { allTenants: vi.fn(), createTenant: vi.fn(), plans: vi.fn(), FakeApiError };
});
vi.mock('$lib/api/admin', () => ({
	ApiError: FakeApiError,
	adminApi: {
		allTenants,
		createTenant,
		plans,
		tenantLicence: vi.fn(),
		offboardTenant: vi.fn(),
		patchTenant: vi.fn(),
		grantBudget: vi.fn(),
		issueLicense: vi.fn()
	}
}));

function tenant(over: Partial<PlatformTenant> = {}): PlatformTenant {
	return {
		id: 't-1',
		name: 'Acme BV',
		slug: 'acme-bv',
		status: 'active',
		createdAt: '2026-01-05T00:00:00.000Z',
		memberCount: 1,
		maxMembers: null,
		licensed: true,
		offboardedAt: null,
		...over
	};
}

function plan(over: Partial<LicencePlan> = {}): LicencePlan {
	return {
		id: 'p-std',
		code: 'standard',
		name: 'Standard',
		description: null,
		durationDays: null,
		rateLimitRpm: null,
		rateLimitBurst: null,
		quotaMonthly: null,
		tokenBudgetMonthly: null,
		revoked: false,
		tenantCount: 3,
		isDefault: true,
		...over
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	allTenants.mockImplementation(async () => ({
		tenants: [tenant({ centralLink: 'registered', licencesName: 'acme-bv-cp', planCode: 'standard' })],
		total: 1
	}));
	plans.mockImplementation(async () => ({
		app: 'commonpractice',
		defaultPlanCode: 'standard',
		plans: [
			plan(),
			plan({ id: 'p-local', code: 'local-llm', name: 'Local LLM', isDefault: false }),
			plan({ id: 'p-old', code: 'legacy', name: 'Legacy', isDefault: false, revoked: true })
		],
		capabilities: { canRetire: true }
	}));
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	vi.clearAllMocks();
});

async function settle() {
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

async function render() {
	const { default: Page } = await import('./+page.svelte');
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	expect(host.querySelectorAll('[data-testid="tenant-row"]').length, 'no tenant row rendered').toBe(1);
	expect(host.querySelector('#tname'), 'the create form is open before anyone asked for it').toBeNull();
	host.querySelector<HTMLButtonElement>('[data-testid="tenant-new"]')!.click();
	flushSync();
	expect(host.querySelector('#tname'), '"New workspace" did not open the create form').not.toBeNull();
}

function type(sel: string, value: string) {
	const el = host.querySelector<HTMLInputElement | HTMLSelectElement>(sel);
	expect(el, `${sel} is not on the page`).not.toBeNull();
	el!.value = value;
	el!.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
	flushSync();
}

async function submit() {
	host.querySelector<HTMLFormElement>('#tname')!.closest('form')!
		.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await settle();
}

const created = (invite: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
	tenant: {
		id: 't-2',
		name: 'Globex',
		slug: 'globex',
		status: 'active',
		central_link: 'registered',
		licences_name: 'globex',
		plan_code: 'standard',
		licence_starts_at: null,
		licence_expires_at: null,
		...over
	},
	invite
});

const invite = (emailDelivery: string) => ({
	id: 'i1',
	tenantId: 't-2',
	email: 'boss@globex.com',
	role: 'tenant_admin',
	expiresAt: '2026-10-26T00:00:00.000Z',
	emailDelivery,
	inviteUrl: 'https://cp.example/invite/accept?token=abc'
});

describe('tenants create form (A2: CP-owned licences tenant)', () => {
	it('per-plan help: the hint explains local-llm and byo, and follows the plan selection', async () => {
		plans.mockImplementation(async () => ({
			app: 'commonpractice',
			defaultPlanCode: 'standard',
			plans: [plan(), plan({ id: 'p-local', code: 'local-llm', isDefault: false }), plan({ id: 'p-byo', code: 'byo', isDefault: false })],
			capabilities: { canRetire: true }
		}));
		await render();
		const help = () => host.querySelector('[data-testid="create-plan-help"]')?.textContent ?? null;
		// A new workspace starts on the platform's local model (NEW_TENANT_PLAN), not the deployment default.
		expect(help()).toBe('admin_plan_help_local_llm');
		type('#tplan', 'standard');
		expect(help()).toBeNull(); // standard: no plan-specific help
		type('#tplan', 'local-llm');
		expect(help()).toBe('admin_plan_help_local_llm');
		type('#tplan', 'byo');
		expect(help()).toBe('admin_plan_help_byo');
		type('#tplan', 'standard');
		expect(help()).toBeNull();
	});

	it("⛔ switching standard → byo → standard restores the posture the operator CHOSE, not byo_required", async () => {
		plans.mockImplementation(async () => ({
			app: 'commonpractice',
			defaultPlanCode: 'standard',
			plans: [plan(), plan({ id: 'p-byo', code: 'byo', isDefault: false })],
			capabilities: { canRetire: true }
		}));
		createTenant.mockResolvedValue(created(null));
		await render();
		type('#tname', 'Globex');
		type('#tbyo', 'local_allowed'); // the operator's own choice
		type('#tplan', 'byo');
		await settle();
		// Fixed by the plan: read-only text, no select.
		expect(host.querySelector('[data-testid="create-byo-value"]')?.textContent?.trim()).toBe('admin_tenants_byo_required');
		type('#tplan', 'standard');
		await settle();
		expect(host.querySelector<HTMLSelectElement>('#tbyo')!.value).toBe('local_allowed');
		await submit();
		expect((createTenant.mock.calls[0]![0] as Record<string, unknown>).byoMode).toBe('local_allowed');
	});

	it('⛔ a plan that FIXES the LLM access shows it as text — no (disabled) select, one non-repeating hint', async () => {
		// It used to be a disabled <select> plus "Set by the plan: <mode>." — a dropdown that does
		// not open, followed by a hint repeating it.
		createTenant.mockResolvedValue(created(null));
		await render();
		type('#tplan', 'standard');
		expect(host.querySelector('select#tbyo'), 'the editable select is missing for a non-fixing plan').not.toBeNull();
		type('#tname', 'Globex');
		type('#tplan', 'local-llm');
		await settle();
		const field = host.querySelector('[data-testid="create-byo-help"]')!.closest('.field')!;
		expect(field.querySelector('select'), 'a select is rendered for a plan-fixed LLM access').toBeNull();
		expect(host.querySelector('[data-testid="create-byo"]')).toBeNull();
		const value = host.querySelector('[data-testid="create-byo-value"]');
		expect(value?.textContent?.trim()).toBe('admin_tenants_byo_local_allowed');
		// The label is not left dangling: it names the text.
		expect(field.querySelector('label[for]')).toBeNull();
		const labelId = value!.getAttribute('aria-labelledby')!;
		expect(document.getElementById(labelId)?.textContent).toBe('admin_tenants_byo_label');
		// ONE hint that the plan sets it, and it does not repeat the mode.
		const fixed = host.querySelectorAll('[data-testid="create-byo-fixed"]');
		expect(fixed.length).toBe(1);
		expect(fixed[0]!.textContent).toBe('admin_tenants_byo_fixed_by_plan');
		expect(host.querySelector('[data-testid="create-byo-help"]')?.textContent?.trim()).toBe('admin_tenants_byo_help_local_allowed');
		// What is sent is unchanged: the plan decides, so no byoMode is sent.
		await submit();
		const body = createTenant.mock.calls[0]![0] as Record<string, unknown>;
		expect(body.planCode).toBe('local-llm');
		expect('byoMode' in body).toBe(false);
	});

	it('⛔ early access: local-llm is pre-selected for a NEW workspace, not the deployment default — no budget, no adopt id', async () => {
		createTenant.mockResolvedValue(created(null));
		await render();
		expect(host.querySelector('#tbudget'), 'the welcome-budget input is still on the create form').toBeNull();
		const select = host.querySelector<HTMLSelectElement>('#tplan')!;
		// The catalogue's deployment default is `standard`; a new workspace still starts on local-llm.
		expect(select.value, 'local-llm is not pre-selected').toBe('local-llm');
		// A retired plan can never be newly assigned (422 plan_retired) — it is not offered.
		expect([...select.options].map((o) => o.value)).toEqual(['standard', 'local-llm']);
		type('#tname', 'Globex');
		type('#tadmin', 'boss@globex.com');
		type('#tadmin-first', 'Ann');
		type('#tadmin-last', 'de Lee');
		await submit();
		expect(createTenant).toHaveBeenCalledTimes(1);
		const body = createTenant.mock.calls[0]![0] as Record<string, unknown>;
		// local-llm FIXES the posture, so no byoMode is sent.
		expect(body).toEqual({
			name: 'Globex',
			firstAdminEmail: 'boss@globex.com',
			firstAdminFirstName: 'Ann',
			firstAdminLastName: 'de Lee',
			planCode: 'local-llm'
		});
	});

	it('local-llm missing or retired in the catalogue → falls back to the live deployment default', async () => {
		plans.mockImplementation(async () => ({
			app: 'commonpractice',
			defaultPlanCode: 'byo',
			plans: [plan({ id: 'p-byo', code: 'byo' }), plan({ id: 'p-local', code: 'local-llm', isDefault: false, revoked: true })],
			capabilities: { canRetire: true }
		}));
		await render();
		expect(host.querySelector<HTMLSelectElement>('#tplan')!.value).toBe('byo');
	});

	// ⛔ The realm requires first + last name; an identity minted without them stopped a brand-new
	// tenant admin at Keycloak's profile form (2026-10-13). The backend 422s too — this is the
	// readable half.
	it('a first-admin email without BOTH names is refused locally, nothing is sent', async () => {
		await render();
		expect(host.querySelector('#tadmin-first'), 'name fields shown before an email was typed').toBeNull();
		type('#tname', 'Globex');
		type('#tadmin', 'boss@globex.com');
		type('#tadmin-first', 'Ann');
		await submit();
		expect(createTenant).not.toHaveBeenCalled();
		expect(host.querySelector('.banner.error')?.textContent).toContain('admin_tenants_first_admin_names_required');
	});

	it('sends the chosen plan and the dates as ISO instants WITH an offset', async () => {
		createTenant.mockResolvedValue(created(null));
		await render();
		type('#tname', 'Globex');
		type('#tplan', 'local-llm');
		type('#tstart', '2026-11-01');
		type('#texpires', '2027-11-01');
		await submit();
		const body = createTenant.mock.calls[0]![0] as Record<string, string>;
		expect(body.planCode).toBe('local-llm');
		expect(body.startsAt).toBe(new Date(2026, 10, 1).toISOString());
		expect(body.expiresAt).toBe(new Date(2027, 10, 1).toISOString());
		// The backend refuses a naive datetime (`datetime({ offset: true })`).
		expect(body.startsAt).toMatch(/Z$/);
	});

	it('an expiry on or before the start is refused locally, nothing is sent', async () => {
		await render();
		type('#tname', 'Globex');
		type('#tstart', '2027-01-01');
		type('#texpires', '2026-12-31');
		await submit();
		expect(createTenant).not.toHaveBeenCalled();
		expect(host.querySelector('.banner.error')?.textContent).toContain('error_licence_window_invalid');
	});

	it('⛔ a plan catalogue that cannot be read still lets the tenant be created (backend default plan, no planCode, no byoMode)', async () => {
		plans.mockRejectedValue(new FakeApiError(502, 'licences_unavailable'));
		createTenant.mockResolvedValue(created(null));
		await render();
		expect(host.textContent).toContain('admin_tenants_plans_unavailable');
		type('#tname', 'Globex');
		await submit();
		expect(createTenant.mock.calls[0]![0]).not.toHaveProperty('planCode');
		// The backend then applies NEW_TENANT_PLAN (local-llm), which FIXES the posture: sending a
		// byoMode here would contradict it (422 byo_mode_fixed_by_plan).
		expect(createTenant.mock.calls[0]![0]).not.toHaveProperty('byoMode');
	});

	it('⛔ there is NO adopt path: a 409 is an error banner, never a prompt or a second request', async () => {
		createTenant.mockRejectedValueOnce(new FakeApiError(409, 'licences_name_unavailable'));
		await render();
		type('#tname', 'Globex');
		await submit();
		expect(host.querySelector('[data-testid="tenant-adopt-prompt"]')).toBeNull();
		expect(host.querySelector('.banner.error')?.textContent).toContain('licences_name_unavailable');
		expect(createTenant).toHaveBeenCalledTimes(1);
		expect(createTenant.mock.calls[0]![0]).not.toHaveProperty('adoptLicencesTenantId');
	});

	it('says which name licences registered when it is not the slug (`globex-cp`)', async () => {
		createTenant.mockResolvedValue(created(null, { licences_name: 'globex-cp' }));
		await render();
		type('#tname', 'Globex');
		await submit();
		expect(host.querySelector('.banner.ok')?.textContent).toContain('admin_tenants_licences_registered_as:globex-cp');
	});

	// The Netcare create (prod 2026-10-13) said "Billing did not accept its terms" for what was billing
	// not KNOWING the tenant yet — and the terms were lost. The banner now names the real cause: a
	// transient failure (terms held, the backend retries) is not a refusal (terms held, needs Retry).
	const withBillingStep = (status: 'pending' | 'failed', code: string) => ({
		...created(null),
		termsError: code,
		provisioning: {
			recorded: true,
			termsHeld: true,
			firstAdminHeld: false,
			steps: {
				billing_terms: { status, code, message: null, attempts: 3, lastAttemptAt: null, nextAttemptAt: null }
			}
		}
	});

	it('billing PENDING → "terms saved, will retry automatically", a warning, not the old "did not accept"', async () => {
		createTenant.mockResolvedValue(withBillingStep('pending', 'billing_tenant_not_registered'));
		await render();
		type('#tname', 'Globex');
		await submit();
		const banner = host.querySelector('.banner');
		expect(banner?.className).toContain('warn');
		expect(banner?.textContent).toContain('admin_tenants_terms_pending');
		expect(banner?.textContent).not.toContain('admin_tenants_terms_failed');
		expect(banner?.textContent).not.toContain('admin_tenants_terms_refused');
	});

	it('billing REFUSED → "refused, terms saved, press Retry"', async () => {
		createTenant.mockResolvedValue(withBillingStep('failed', 'billing_refused'));
		await render();
		type('#tname', 'Globex');
		await submit();
		const banner = host.querySelector('.banner');
		expect(banner?.textContent).toContain('admin_tenants_terms_refused');
		expect(banner?.textContent).not.toContain('admin_tenants_terms_pending');
	});

	it('says nothing about licences when the name IS the slug', async () => {
		createTenant.mockResolvedValue(created(null));
		await render();
		type('#tname', 'Globex');
		await submit();
		expect(host.querySelector('.banner')?.textContent).not.toContain('admin_tenants_licences_registered_as');
	});

	it('a failed invite email warns and shows the invite link to copy', async () => {
		createTenant.mockResolvedValue(created(invite('failed')));
		await render();
		type('#tname', 'Globex');
		type('#tadmin', 'boss@globex.com');
		type('#tadmin-first', 'Ann');
		type('#tadmin-last', 'Lee');
		await submit();
		expect(host.querySelector('.banner')?.className).toContain('warn');
		const link = host.querySelector<HTMLInputElement>('[data-testid="tenant-invite-link"] input');
		expect(link?.value).toBe('https://cp.example/invite/accept?token=abc');
	});

	// ⛔ HUNT (A2 review): the tenant stands when the first-admin invite FAILS (tenant-service step 5),
	// and the response says so in `inviteError` with `invite: null`. The page read only `invite`, so a
	// typed first-admin address that could not be invited (another workspace, Keycloak down…) showed
	// the plain green "Tenant created." — the operator never learned nobody was invited.
	it('⛔ a first-admin invite that FAILED (`inviteError`) warns with the address — never a plain "created"', async () => {
		createTenant.mockResolvedValue({ ...created(null), inviteError: 'email_in_other_tenant' });
		await render();
		type('#tname', 'Globex');
		type('#tadmin', 'boss@globex.com');
		type('#tadmin-first', 'Ann');
		type('#tadmin-last', 'Lee');
		await submit();
		const banner = host.querySelector('.banner');
		expect(banner?.className).toContain('warn');
		expect(banner?.textContent).toContain('admin_tenants_created_invite_error:boss@globex.com');
		expect(banner?.textContent).toContain('email_in_other_tenant');
	});

	it('`keycloak_actions` says a set-password email was sent — and shows no copy link', async () => {
		createTenant.mockResolvedValue(created(invite('keycloak_actions')));
		await render();
		type('#tname', 'Globex');
		type('#tadmin', 'boss@globex.com');
		type('#tadmin-first', 'Ann');
		type('#tadmin-last', 'Lee');
		await submit();
		expect(host.querySelector('.banner.ok')?.textContent).toContain(
			'admin_tenants_created_set_password:boss@globex.com'
		);
		expect(host.querySelector('[data-testid="tenant-invite-link"]')).toBeNull();
	});

	it('shows the row’s licences name when it differs from its slug', async () => {
		await render();
		expect(host.querySelector('[data-testid="tenant-licences-name"]')?.textContent).toContain(
			'admin_tenants_licences_name_short:acme-bv-cp'
		);
		// The central-link chip moved to the tenant's own page with the rest of the detail.
	});

	it('⛔ the BYO help under the select follows the SELECTED mode', async () => {
		await render();
		type('#tplan', 'standard'); // a plan that leaves the posture to the operator
		const help = () => host.querySelector('[data-testid="create-byo-help"]')?.textContent?.trim();
		expect(help()).toBe('admin_tenants_byo_help_byo_required');
		type('#tbyo', 'local_allowed');
		expect(help()).toBe('admin_tenants_byo_help_local_allowed');
		type('#tbyo', 'platform_only');
		expect(help()).toBe('admin_tenants_byo_help_platform_only');
		createTenant.mockResolvedValue(created(null));
		type('#tname', 'Globex');
		await submit();
		expect((createTenant.mock.calls[0]![0] as Record<string, unknown>).byoMode).toBe('platform_only');
	});

	it('every create field explains itself, and the selected plan shows its limits', async () => {
		plans.mockResolvedValue({
			app: 'commonpractice',
			defaultPlanCode: 'standard',
			plans: [plan({ rateLimitRpm: 60 }), plan({ id: 'p-local', code: 'local-llm', name: 'Local LLM', isDefault: false, rateLimitRpm: 600 })],
			capabilities: { canRetire: true }
		});
		await render();
		const form = host.querySelector('#tname')!.closest('form')!.textContent ?? '';
		for (const key of [
			'admin_tenants_name_help',
			'admin_tenants_first_admin_help',
			'admin_tenants_seats_help',
			'admin_tenants_starts_help',
			'admin_tenants_expires_help',
			'admin_tenants_plan_hint'
		]) {
			expect(form, key).toContain(key);
		}
		// ⛔ The first admin's role is named by the SAME label the members page shows for it, not by an
		// inline "tenant admin" spelled into the sentence.
		expect(form).toContain('admin_tenants_first_admin_help:admin_onboarding_role_admin');
		const limits = () => host.querySelector('[data-testid="create-plan-limits"]')?.textContent ?? '';
		type('#tplan', 'standard');
		expect(limits()).toMatch(/admin_plans_rpm,60(?!\d)/);
		type('#tplan', 'local-llm');
		expect(limits()).toContain('admin_plans_rpm,600');
	});
});

describe('tenants create form — licences bundles (backend 0104)', () => {
	function key(sel: string, k: string) {
		host.querySelector<HTMLInputElement>(sel)!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
		flushSync();
	}
	const chips = () =>
		[...host.querySelectorAll('[data-testid="create-bundle-chips"] code')].map((c) => c.textContent);

	it('Enter adds chips (case-folded, no duplicates); × removes; the body carries licenceBundles', async () => {
		createTenant.mockResolvedValue({ ...created(null), licenceBundles: [] });
		await render();
		type('#tname', 'Netcare');
		type('[data-testid="create-bundles-input"]', 'N8n-Nodes, w2v');
		key('[data-testid="create-bundles-input"]', 'Enter');
		type('[data-testid="create-bundles-input"]', 'w2v');
		key('[data-testid="create-bundles-input"]', 'Enter');
		expect(chips()).toEqual(['n8n-nodes', 'w2v']);
		// Enter in the chip input does NOT submit the form.
		expect(createTenant).not.toHaveBeenCalled();
		host.querySelector<HTMLButtonElement>('[aria-label="admin_tenants_bundles_remove:w2v"]')!.click();
		flushSync();
		expect(chips()).toEqual(['n8n-nodes']);
		// A key still typed in the input is not dropped on submit.
		type('[data-testid="create-bundles-input"]', 'commonpractice');
		await submit();
		expect((createTenant.mock.calls[0]![0] as Record<string, unknown>).licenceBundles).toEqual(['n8n-nodes', 'commonpractice']);
	});

	it('a malformed key is refused in place, nothing is sent; no bundles → no licenceBundles in the body', async () => {
		createTenant.mockResolvedValue(created(null));
		await render();
		type('#tname', 'Globex');
		type('[data-testid="create-bundles-input"]', 'n8n_nodes');
		key('[data-testid="create-bundles-input"]', 'Enter');
		expect(host.querySelector('[data-testid="create-bundles-error"]')?.textContent).toBe('admin_tenants_bundles_invalid:n8n_nodes');
		expect(chips()).toEqual([]);
		await submit();
		expect(createTenant).not.toHaveBeenCalled();
		type('[data-testid="create-bundles-input"]', '');
		await submit();
		expect(createTenant).toHaveBeenCalledTimes(1);
		expect('licenceBundles' in (createTenant.mock.calls[0]![0] as Record<string, unknown>)).toBe(false);
	});

	it('a bundle licences refused → the tenant was created, the banner warns and names it', async () => {
		createTenant.mockResolvedValue({
			...created(null),
			licenceBundles: [
				{ bundle: 'n8n-nodes', status: 'failed', code: 'tenant_owner_only' },
				{ bundle: 'w2v', status: 'ok', code: null }
			],
			licenceBundlesError: 'tenant_owner_only'
		});
		await render();
		type('#tname', 'Globex');
		type('[data-testid="create-bundles-input"]', 'n8n-nodes w2v');
		await submit();
		const banner = host.querySelector('.banner.warn');
		expect(banner, 'no warn banner for a refused bundle').not.toBeNull();
		expect(banner!.textContent).toContain('admin_tenants_bundles_failed:n8n-nodes');
		expect(banner!.textContent).not.toContain('w2v');
	});
});
