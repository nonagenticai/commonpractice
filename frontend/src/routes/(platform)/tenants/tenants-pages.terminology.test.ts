// src/routes/(platform)/tenants/tenants-pages.terminology.test.ts — one word for the thing.
//
// ⛔ The list's button said "New workspace" and the form it opened said "Create tenant"; the page
// title, the success banners, the name label and "Acting as this tenant" said tenant too. The UI
// word is WORKSPACE. This scans every message the tenant list, the tenant page, the Plans page and
// their shared label module call, and refuses an English value that says "tenant".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILES = [
	'src/routes/(platform)/tenants/+page.svelte',
	'src/routes/(platform)/tenants/[id]/+page.svelte',
	'src/routes/(platform)/plans/+page.svelte',
	'src/lib/admin/tenant-labels.ts'
];

/** Shared copy that names something else. `admin_denied` is the app-wide role refusal, and
 *  `admin_onboarding_role_admin` is the ROLE's display label (as the members page shows it), which
 *  the first-admin help interpolates rather than spelling the role inline. */
const ALLOWED = new Set(['admin_denied', 'admin_onboarding_role_admin']);

describe('these pages say "workspace", never "tenant"', () => {
	it('no English message they render contains the word tenant', () => {
		const en = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
		const keys = new Set<string>();
		for (const f of FILES) {
			const src = readFileSync(resolve(process.cwd(), f), 'utf8');
			for (const m of src.matchAll(/\bm\.([a-z0-9_]+)/g)) keys.add(m[1]!);
		}
		expect(keys.size, 'the scan found no message calls — it would pass vacuously').toBeGreaterThan(50);
		expect(keys.has('admin_tenants_create')).toBe(true);
		const offenders = [...keys]
			.filter((k) => !ALLOWED.has(k))
			.filter((k) => /\btenants?\b/i.test(JSON.stringify(en[k] ?? '')))
			.sort();
		expect(offenders).toEqual([]);
	});
});
