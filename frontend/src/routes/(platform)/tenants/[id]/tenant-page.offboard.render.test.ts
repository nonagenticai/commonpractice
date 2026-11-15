// @vitest-environment jsdom
//
// src/routes/(platform)/tenants/[id]/tenant-page.offboard.render.test.ts — the operator half of
// tenant offboarding: the control exists, it cannot be fired by accident, and an offboard with seats
// still revoking is reported as the partial success it is. The control moved with every other
// per-tenant action from the /tenants row to the tenant's own page, /tenants/<id>.
//
// ⛔ WHAT THIS SCREEN COULD NOT DO. `(platform)/tenants` had exactly one lifecycle control — a
// Suspend/Reactivate toggle — and no way at all to offboard a departing customer. The last
// `tenant_admin` therefore could never be removed, and every departed tenant left live Keycloak
// identities and live MCP API keys behind. `POST /api/tenants/:id/offboard` fixes the backend half;
// this file pins the front half.
//
// ⛔ AND THE CONTROL IS IRREVERSIBLE, WHICH IS WHY `window.confirm` IS NOT THE PRECEDENT TO COPY.
// The licence re-issue on this same row does use `window.confirm`, and it is allowed to: an
// unwanted re-mint is repaired by running it again. An offboard deletes identities upstream and
// `PATCH {status:'active'}` afterwards answers 409 `tenant_offboarded` by design. So the commit
// stays inert until the operator has typed the tenant's slug EXACTLY, and the two near-miss cases
// below (a trailing space, a prefix) are the whole point of the guard — a confirmation that accepts
// `'acme-bv '` accepts a paste of the wrong row's slug too.
//
// ⛔ THIS ROUTE HAD NO TEST FILE AT ALL, so there is no harness to inherit. The messages module is
// mocked key-returns-its-own-name from the REAL `messages/en.json` — the technique in
// `(platform)/onboarding/onboarding.unknown-tenant.render.test.ts` — so no assertion here depends
// on wording and a reworded catalog cannot red this file.
//
// ⚠️ THE TEN `tenant_offboard_*` KEYS ARE AUTHORED IN A SIBLING CHANGE, and this file must not
// become a hostage to landing order: the stub therefore synthesises any of them the catalog does
// not yet carry. That would quietly hide a key the page invents and nobody ever adds — so the
// FIRST case below asserts, against the real `en.json`, that all eleven are present. One named red
// instead of ten `TypeError: m.tenant_action_offboard is not a function`s.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PlatformTenant } from '$lib/types/admin';

const { OFFBOARD_KEYS } = vi.hoisted(() => ({
	OFFBOARD_KEYS: [
		'tenant_action_offboard',
		'tenant_status_offboarded',
		'tenant_offboarded_at',
		'tenant_offboard_confirm_title',
		'tenant_offboard_confirm_body',
		'tenant_offboard_confirm_prompt',
		'tenant_offboard_confirm_commit',
		'tenant_offboard_cancel',
		'tenant_offboard_done',
		'tenant_offboard_seats_pending'
	] as const
}));

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<
		string,
		unknown
	>;
	// A parameterised key renders `key:v1,v2` so a case can assert WHICH values reached it without
	// asserting on any English.
	const stub = (key: string) => (params?: Record<string, unknown>) =>
		params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = stub(key);
	for (const key of OFFBOARD_KEYS) if (!(key in mod)) mod[key] = stub(key);
	return mod;
});

vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, f: string) => f,
	writeErrorText: (_e: unknown, f: string) => f
}));
// The scope-switch store touches localStorage and issues its own writes; nothing here is about it.
vi.mock('$lib/stores/activeTenant.svelte', () => ({
	activeTenant: { current: null, set: vi.fn() }
}));
vi.mock('$app/state', () => ({ page: { params: { id: 't-1' }, url: new URL('http://localhost/tenants/t-1') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { platformTenant, offboardTenant, patchTenant } = vi.hoisted(() => ({
	platformTenant: vi.fn(),
	offboardTenant: vi.fn(),
	patchTenant: vi.fn()
}));
// ⛔ ALIAS module id, never a relative one — a relative mock id resolves to a different module
// record than the page imports and silently does nothing (see lib/test/setup.ts).
vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: {
		platformTenant,
		offboardTenant,
		// The editor is not what this file is about; a never-settling read keeps it in its loading state.
		tenantLicence: vi.fn(() => new Promise(() => {})),
		plans: vi.fn(async () => ({ app: 'commonpractice', defaultPlanCode: 'standard', plans: [], capabilities: { canRetire: true } })),
		patchTenant,
		createTenant: vi.fn(),
		grantBudget: vi.fn(),
		issueLicense: vi.fn()
	}
}));

const OFFBOARDED_AT = '2026-08-07T09:30:00.000Z';

function tenant(over: Partial<PlatformTenant> = {}): PlatformTenant {
	return {
		id: 't-1',
		name: 'Acme BV',
		// Not a `u-<hex>` auto-slug, so the row prints it and the operator can actually read what
		// they are being asked to type.
		slug: 'acme-bv',
		status: 'active',
		createdAt: '2026-01-05T00:00:00.000Z',
		memberCount: 3,
		maxMembers: null,
		licensed: true,
		licenseState: 'active',
		licenseHasToken: true,
		offboardedAt: null,
		...over
	};
}

/** What the fake backend answers `platformTenant(id)` from — mutable, so a successful offboard can
 *  flip the row exactly the way a reload does. */
let rows: PlatformTenant[];
let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	rows = [tenant()];
	platformTenant.mockImplementation(async (id: string) => rows.find((r) => r.id === id) ?? null);
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

/**
 * ⛔ ANTI-VACUITY GATE. The page opens in `{#if loading}`, which renders one notice and NO tenant, so
 * every `toBeNull()` / `not.toContain()` below passes for free against a page stuck there. Prove the
 * tenant rendered before asserting anything about it.
 */
async function render(): Promise<HTMLElement> {
	const { default: Page } = await import('./+page.svelte');
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	expect(host.textContent, 'the page never left its loading state').not.toContain('admin_loading');
	expect(
		host.querySelectorAll('[data-testid="tenant-header"]').length,
		'no tenant rendered — every assertion below would be vacuous'
	).toBe(1);
	return host;
}

const q = <T extends HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);
const offboardBtn = () => q<HTMLButtonElement>('[data-testid="tenant-offboard"]');
const commitBtn = () => q<HTMLButtonElement>('[data-testid="tenant-offboard-commit"]');
const slugInput = () => q<HTMLInputElement>('[data-testid="tenant-offboard-input"]');
const toggleBtn = () => q<HTMLButtonElement>('[data-testid="tenant-toggle-status"]');

function click(btn: HTMLButtonElement | null) {
	expect(btn, 'tried to click a control that is not on the page').not.toBeNull();
	btn!.click();
	flushSync();
}

/** Drive the bound input the way a keyboard does — assigning `.value` alone never reaches Svelte. */
function typeSlug(value: string) {
	const input = slugInput();
	expect(input, 'the confirm panel is not open').not.toBeNull();
	input!.value = value;
	input!.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('the offboard control exists and is spelled in the catalog', () => {
	it('⛔ all ten tenant_offboard_* keys are in messages/en.json', () => {
		// Without this, the stub above would paper over a key the page calls and nobody ever wrote,
		// and every other case in this file would still pass. The eight-catalog parity is enforced
		// separately by src/lib/i18n/catalogs.test.ts.
		const catalog = JSON.parse(
			readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
		) as Record<string, unknown>;
		const missing = OFFBOARD_KEYS.filter((k) => !(k in catalog));
		expect(missing, 'the page calls these keys and en.json does not carry them').toEqual([]);
	});
});

describe('the offboard button is offered exactly while there is something to offboard', () => {
	it('a live tenant offers it', async () => {
		await render();
		expect(offboardBtn()).not.toBeNull();
		expect(offboardBtn()!.textContent?.trim()).toBe('tenant_action_offboard');
		// It reads as destructive, not as a fourth ordinary row action beside "Act as".
		expect(offboardBtn()!.className).toContain('danger');
	});

	it('⛔ an already-offboarded tenant does NOT — the row reports the stamp instead', async () => {
		rows = [tenant({ offboardedAt: OFFBOARDED_AT })];
		const el = await render();

		expect(offboardBtn(), 'offering to offboard a tenant that already is').toBeNull();
		expect(el.textContent).toContain('tenant_status_offboarded');
		expect(el.textContent).toContain('tenant_offboarded_at:');
		// Rendered through the repo's own date helper, not pasted raw off the wire.
		expect(el.textContent).toContain('2026');
		expect(el.textContent, 'the raw ISO stamp is being read as prose').not.toContain(OFFBOARDED_AT);
		// The live status pill is gone with it — 'active'/'suspended' is not a fact about this row.
		expect(el.querySelector('.status.offboarded')).not.toBeNull();
		expect(el.querySelector('.status.active')).toBeNull();
	});

	it('⛔ and its suspend/reactivate toggle is GONE, because reactivation is refused 409', async () => {
		// A control whose only possible outcome is `409 tenant_offboarded` is a lying affordance.
		rows = [tenant({ status: 'suspended', offboardedAt: OFFBOARDED_AT })];
		await render();
		expect(toggleBtn()).toBeNull();
	});

	it('…while a live tenant’s toggle stays enabled — the over-correction guard', async () => {
		// Without this, "remove the toggle always" passes the case above.
		await render();
		expect(toggleBtn()!.disabled).toBe(false);
	});
});

describe('⛔ an offboarded tenant is READ-ONLY: no actionable control at all', () => {
	// Seen on prod: an offboarded tenant (suspended, `offboardedAt` set) still offered a live "Issue
	// licence". The fixture is exactly that shape — no token, `licenseState: 'none'`, so the licence
	// chip's own decision is `issue` — because a fixture whose chip is inert would pass for free.
	const offboardedUnlicensed = () =>
		tenant({
			status: 'suspended',
			offboardedAt: OFFBOARDED_AT,
			licensed: false,
			licenseState: 'none',
			licenseHasToken: false
		});

	it('renders no button, input or select — only the back link — and says "offboarded on <date> — read-only"', async () => {
		rows = [offboardedUnlicensed()];
		const el = await render();
		const controls = [...el.querySelectorAll('button, input, select, textarea')].map(
			(c) => c.getAttribute('data-testid') ?? c.outerHTML.slice(0, 80)
		);
		expect(controls, 'an offboarded tenant still offers controls').toEqual([]);
		expect(el.querySelector('[data-testid="tenant-licence-action"]'), 'the prod bug: "Issue licence"').toBeNull();
		expect(el.querySelector('[data-testid="tenant-licence-editor"]')).toBeNull();
		expect(el.querySelector('[data-testid="tenant-terms-card"]')).toBeNull();
		expect(el.querySelector('[data-testid="tenant-members-link"]')).toBeNull();

		const note = el.querySelector('[data-testid="tenant-offboarded-readonly"]');
		expect(note, 'no read-only note').not.toBeNull();
		expect(note!.textContent).toContain('admin_tenant_offboarded_note:');
		expect(note!.textContent).toContain('2026');
		expect(note!.textContent).not.toContain(OFFBOARDED_AT);
		expect(note!.textContent).toContain('admin_tenant_offboarded_readonly');
		// The back link survives — read-only is not a dead end.
		expect(el.querySelector('[data-testid="tenant-back"]')).not.toBeNull();
	});

	it('…while the SAME row not offboarded offers Issue licence, toggle and offboard — the anti-vacuity control', async () => {
		rows = [tenant({ licensed: false, licenseState: 'none', licenseHasToken: false })];
		const el = await render();
		const issue = el.querySelector<HTMLButtonElement>('[data-testid="tenant-licence-action"]');
		expect(issue, 'the fixture never offered Issue licence — the case above proves nothing').not.toBeNull();
		expect(issue!.disabled).toBe(false);
		expect(issue!.textContent?.trim()).toBe('admin_tenant_licence_issue');
		expect(toggleBtn()).not.toBeNull();
		expect(offboardBtn()).not.toBeNull();
		expect(el.querySelector('[data-testid="tenant-offboarded-readonly"]')).toBeNull();
	});
});

describe('the confirmation cannot be fired by accident', () => {
	it('the panel names the tenant and how many people lose their accounts', async () => {
		const el = await render();
		click(offboardBtn());

		expect(el.textContent).toContain('tenant_offboard_confirm_title:Acme BV');
		// `memberCount` — the field the list already returns — not a second, invented count.
		expect(el.textContent).toContain('tenant_offboard_confirm_body:3');
		expect(el.textContent).toContain('tenant_offboard_confirm_prompt:acme-bv');
		expect(el.textContent).toContain('tenant_offboard_cancel');
	});

	it('⛔ the commit is inert until the slug is typed EXACTLY', async () => {
		await render();
		click(offboardBtn());

		expect(commitBtn()!.disabled, 'armed before anything was typed').toBe(true);

		// A PREFIX of the slug. The most likely accident: a half-typed name plus a stray Enter.
		typeSlug('acme-b');
		expect(commitBtn()!.disabled, 'a prefix of the slug armed the commit').toBe(true);

		// The slug with a TRAILING SPACE — what a copy-paste out of a table produces. A `.trim()`
		// anywhere in the comparison turns this case green and the guard into decoration.
		typeSlug('acme-bv ');
		expect(commitBtn()!.disabled, 'a trailing space armed the commit — trim() crept in').toBe(true);

		// A different tenant's slug of the same shape.
		typeSlug('acme-nv');
		expect(commitBtn()!.disabled).toBe(true);

		// …and the exact string arms it. Without this half, "always disabled" passes the rest.
		typeSlug('acme-bv');
		expect(commitBtn()!.disabled, 'the exact slug did NOT arm the commit').toBe(false);
	});

	it('a near-miss does not reach the backend even via Enter in the field', async () => {
		// The disabled attribute does not guard the keyboard path — `commitOffboard` re-checks.
		await render();
		click(offboardBtn());
		typeSlug('acme-bv ');
		slugInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		expect(offboardTenant).not.toHaveBeenCalled();
	});

	it('cancel closes the panel and fires nothing', async () => {
		const el = await render();
		click(offboardBtn());
		typeSlug('acme-bv');
		const cancel = [...el.querySelectorAll<HTMLButtonElement>('.confirm-actions .btn-ghost')].find(
			(b) => b.textContent?.includes('tenant_offboard_cancel')
		);
		click(cancel ?? null);
		expect(slugInput(), 'the confirm panel stayed open').toBeNull();
		expect(offboardTenant).not.toHaveBeenCalled();
	});
});

describe('what the operator is told when it lands', () => {
	/** Arm and fire the confirmation on the single fixture row. */
	async function offboard(result: Record<string, unknown>) {
		offboardTenant.mockImplementation(async () => {
			rows = [tenant({ offboardedAt: OFFBOARDED_AT })];
			return result;
		});
		await render();
		click(offboardBtn());
		typeSlug('acme-bv');
		click(commitBtn());
		await settle();
		return host;
	}

	const clean = {
		tenantId: 't-1',
		offboardedAt: OFFBOARDED_AT,
		alreadyOffboarded: false,
		usersOffboarded: 3,
		keysRevoked: 5,
		sessionsRevoked: 4,
		seatFailures: []
	};

	it('a clean sweep reports ok, with the counts the backend actually returned', async () => {
		const el = await offboard(clean);

		expect(offboardTenant).toHaveBeenCalledWith('t-1', { confirmSlug: 'acme-bv' });
		const banner = el.querySelector('.banner');
		expect(banner?.className).toContain('ok');
		expect(banner?.textContent).toBe('tenant_offboard_done:Acme BV,3,5');
		expect(el.querySelector('.banner.warn'), 'a clean sweep was reported as partial').toBeNull();
	});

	it('⛔ AN UNRELEASED SEAT IS A WARNING, never a clean "offboarded" — the customer is still billed', async () => {
		// One member's central licence could not be revoked. The
		// workspace IS offboarded, yet that seat is still counted upstream until the reconciler
		// retries it. An `ok` banner here would tell the operator the customer stopped paying.
		const el = await offboard({
			...clean,
			seatFailures: [{ userId: 'u-9', email: 'jan@acme.nl', message: 'licenses 503' }]
		});

		const banner = el.querySelector('.banner');
		expect(banner?.className, 'an unreleased seat was painted as a clean sweep').toContain('warn');
		expect(banner?.className).not.toContain('error');
		expect(banner?.textContent).toBe(
			'tenant_offboard_done:Acme BV,3,5 tenant_offboard_seats_pending:1'
		);
	});

	it('⛔ …and the row STILL flips to offboarded, because it is', async () => {
		// The tenant is offboarded even with seats still revoking. A row left looking live invites a
		// second attempt at something that already happened.
		const el = await offboard({
			...clean,
			seatFailures: [{ userId: 'u-9', email: 'jan@acme.nl', message: 'licenses 503' }]
		});

		expect(el.textContent).toContain('tenant_status_offboarded');
		expect(offboardBtn(), 'the offboard button survived a completed offboard').toBeNull();
		expect(toggleBtn()).toBeNull();
		expect(host.querySelector('[data-testid="tenant-offboarded-readonly"]')).not.toBeNull();
		// The confirm panel closed on success rather than sitting there re-armed.
		expect(slugInput()).toBeNull();
	});

	it('a refusal goes through the write-error path and the row is untouched', async () => {
		// 400 `confirm_mismatch`, 404, 409 — all reach the same banner. `writeErrorText` is mocked to
		// its fallback, so what is pinned here is the KIND, not the wording.
		offboardTenant.mockRejectedValue(new Error('boom'));
		await render();
		click(offboardBtn());
		typeSlug('acme-bv');
		click(commitBtn());
		await settle();

		const banner = host.querySelector('.banner');
		expect(banner?.className).toContain('error');
		expect(banner?.textContent).toBe('error_action_failed');
		expect(host.textContent).not.toContain('tenant_status_offboarded');
		expect(offboardBtn(), 'the control vanished on a failed offboard').not.toBeNull();
	});
});
