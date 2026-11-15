// @vitest-environment jsdom
//
// src/routes/(platform)/onboarding/onboarding.unknown-tenant.render.test.ts — a workspace we cannot
// name is named as such, not as a GUID.
//
// ⛔ THE DEFECT. `tenantName()` ended `?? id`, and both call sites put its result inside a SENTENCE:
//   "Matched: {tenantName(a.matched_tenant_id)}"     — on the signup-approval queue row
//   "→ {tenantName(d.tenant_id)}"                    — under the email-domain routing rule
// so a tenant absent from the loaded `tenants` array produced "Matched:
// 3f1c8b2e-9a44-4c07-b1de-0e6a8b2f7c31" — thirty-six characters of opaque hex in the slot that
// promises a workspace NAME, on the row a super_admin is about to approve someone into.
//
// ⚠️ AND THE TRIGGER IS WIDER THAN "A ROW POINTING AT A DELETED TENANT". `adminApi.allTenants()` is
// PAGINATED — `TENANTS_DEFAULT_LIMIT = 500` in backend/src/routes/admin.ts — and this page passes no
// `?limit`/`?offset` and ignores the `total` the route returns for exactly this purpose. Past 500
// workspaces, EVERY tenant from 501 on falls into this branch while being perfectly present in the
// database. That is a paging bug in the queue screen and this file does not fix it; what this file
// pins is that its symptom reads as "we could not name this" and carries the id somewhere a human
// can still act on it, instead of pretending a GUID is prose.
//
// ⛔ THE POSITIVE HALF IS ASSERTED IN EVERY CASE. A page that failed to render satisfies "the GUID
// is not on screen" for free, so each case also reads the resolvable neighbour BY NAME.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { EmailDomainMapping, SignupApproval } from '$lib/types/admin';

// Real `en` catalog, each key resolving to its own name, so a reworded translation cannot red this
// file and a resurrected hardcoded English string cannot pass.
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
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, f: string) => f,
	writeErrorText: (_e: unknown, f: string) => f
}));

/** The one tenant the roster call returns. Everything else is "absent", by paging or by deletion —
 *  the screen cannot tell the two apart, which is the point. */
const KNOWN = { id: 't-known', name: 'Nonagentic BV' };
/** A tenant id the page has never heard of. Shaped as a real uuid: the assertions are about a
 *  36-character opaque string appearing in prose, and a short fake id would not be that. */
const ABSENT = '3f1c8b2e-9a44-4c07-b1de-0e6a8b2f7c31';

const { approvals, domains } = vi.hoisted(() => ({
	approvals: { current: [] as unknown[] },
	domains: { current: [] as unknown[] }
}));
vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: {
		signupApprovals: async () => ({ approvals: approvals.current }),
		allTenants: async () => ({ tenants: [KNOWN] }),
		emailDomains: async () => ({ domains: domains.current }),
		signupStats: async () => ({ stats: { pending: 0, approved: 0, rejected: 0, total: 0 } }),
		invite: vi.fn(),
		approveSignup: vi.fn(),
		rejectSignup: vi.fn(),
		addEmailDomain: vi.fn(),
		removeEmailDomain: vi.fn()
	}
}));

import Page from './+page.svelte';

function approval(id: string, email: string, tenantId: string | null): SignupApproval {
	return {
		id,
		keycloak_sub: null,
		email,
		name: null,
		status: 'pending',
		matched_tenant_id: tenantId,
		assigned_tenant_id: null,
		requested_role: 'member',
		note: null,
		created_at: '2026-08-10T09:00:00.000Z',
		decided_at: null,
		decided_by: null
	} as SignupApproval;
}

function domain(name: string, tenantId: string): EmailDomainMapping {
	return { domain: name, tenant_id: tenantId, auto_assign: true, created_at: '2026-08-10T09:00:00.000Z' };
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	approvals.current = [];
	domains.current = [];
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function render(): Promise<HTMLElement> {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	// ⛔ The sentinel is the SKELETON, not a message key: this page's loading state is
	// `<LoadingRows>`, so waiting on `admin_loading` exits on the first tick and every assertion
	// below then runs against a page that is still loading — measured, and it is exactly the
	// "green that proves nothing" shape.
	for (let i = 0; i < 30 && host.querySelector('.loading-rows'); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	expect(
		host.querySelector('.loading-rows'),
		'the page never left its loading state — nothing below would be a proof'
	).toBeNull();
	return host;
}

const matchedEls = () => [...host.querySelectorAll('span.matched')];
const domainSubs = () => [...host.querySelectorAll('.card.row .sub')];

describe('the signup queue names the workspace it matched', () => {
	it('THE DEFECT: an unresolvable tenant reads as a phrase, and the GUID is not in the sentence', async () => {
		approvals.current = [approval('a-1', 'nieuw@klant.nl', ABSENT)];
		await render();

		const el = matchedEls()[0];
		expect(el, 'the queue row did not render at all').toBeDefined();
		expect(el!.textContent).toContain('admin_onboarding_tenant_unknown');
		expect(el!.textContent, 'a raw uuid is still being read as prose').not.toContain(ABSENT);
	});

	it('…and the id survives, on the tooltip, for whoever has to go and look it up', async () => {
		// ⛔ THE OTHER HALF OF THE FIX. "Do not print the id" is satisfied by throwing it away, which
		// would leave an operator with a row they cannot investigate.
		approvals.current = [approval('a-1', 'nieuw@klant.nl', ABSENT)];
		await render();
		expect(matchedEls()[0]!.getAttribute('title')).toBe(ABSENT);
	});

	it('A RESOLVED TENANT IS UNCHANGED — real name, and NO id tooltip', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. Without this, "always say unknown" and "always hang the id off
		// every row" both pass the two cases above.
		approvals.current = [approval('a-1', 'iemand@nonagentic.ai', KNOWN.id)];
		await render();

		const el = matchedEls()[0]!;
		expect(el.textContent).toContain(KNOWN.name);
		expect(el.textContent).not.toContain('admin_onboarding_tenant_unknown');
		expect(el.getAttribute('title'), 'a resolved workspace grew a GUID hover it never had').toBeNull();
	});

	it('both rows at once: only the unresolvable one is captioned', async () => {
		approvals.current = [
			approval('a-1', 'iemand@nonagentic.ai', KNOWN.id),
			approval('a-2', 'nieuw@klant.nl', ABSENT)
		];
		await render();

		const texts = matchedEls().map((e) => e.textContent ?? '');
		expect(texts).toHaveLength(2);
		expect(texts[0]).toContain(KNOWN.name);
		expect(texts[1]).toContain('admin_onboarding_tenant_unknown');
		expect(host.textContent).not.toContain(ABSENT);
	});
});

describe('the email-domain routing rules do the same', () => {
	it('an unresolvable target reads as a phrase and keeps the id on the tooltip', async () => {
		domains.current = [domain('klant.nl', ABSENT)];
		await render();

		const sub = domainSubs()[0]!;
		expect(sub.textContent).toContain('admin_onboarding_tenant_unknown');
		expect(sub.textContent).not.toContain(ABSENT);
		expect(sub.getAttribute('title')).toBe(ABSENT);
		// The POSITIVE half: the rule itself is still on screen and still names its domain.
		expect(host.textContent).toContain('klant.nl');
	});

	it('a resolved target still names the workspace', async () => {
		domains.current = [domain('nonagentic.ai', KNOWN.id)];
		await render();

		const sub = domainSubs()[0]!;
		expect(sub.textContent).toContain(KNOWN.name);
		expect(sub.getAttribute('title')).toBeNull();
	});
});
