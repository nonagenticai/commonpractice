// src/lib/admin/tenant-labels.test.ts — the shared tenant copy: one explanation per BYO posture,
// and the system-tenant decision that must survive a new frontend talking to an old backend.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});

import { BYO_MODES, byoModeHelp, isSystemTenantRow, SYSTEM_TENANT_ID } from './tenant-labels';

describe('byoModeHelp', () => {
	it('every posture the backend accepts has its OWN explanation', () => {
		// Mirrors backend routes/admin.ts `z.enum(['byo_required', 'local_allowed', 'platform_only'])`.
		expect([...BYO_MODES].sort()).toEqual(['byo_required', 'local_allowed', 'platform_only']);
		const texts = BYO_MODES.map((m) => byoModeHelp(m));
		expect(new Set(texts).size, 'two postures share one explanation').toBe(BYO_MODES.length);
		expect(texts).not.toContain(byoModeHelp(''));
	});
});

describe('the expiry help says what the editor SENDS', () => {
	// ⛔ `dateInputToIso` sends LOCAL MIDNIGHT AT THE START of the picked day, and the backend calls a
	// licence expired once `expiresAt <= now` (lib/license-status.ts). So the picked day is already
	// blocked. The help said "After this day everyone … is blocked", i.e. one day too generous —
	// an operator picking a customer's last paid day cut them off a day early.
	it('the instant is the START of the chosen day, and the copy says so', async () => {
		const { dateInputToIso } = await import('./licence-terms');
		expect(dateInputToIso('2026-10-20')).toBe(new Date(2026, 9, 20, 0, 0, 0).toISOString());
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const en = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, string>;
		const help = en.admin_tenants_expires_help!;
		expect(help).not.toMatch(/after this day/i);
		expect(help).toMatch(/ends as this day begins/);
	});
});

describe('the platform_only help matches what CP now enforces', () => {
	// backend ai/llm/select.ts ignores a `tenant_byo` row under platform_only and
	// routes/llm-settings.ts refuses to store one (403 llm_byo_disabled). The caveat that CP
	// "currently treats it like Platform LLM allowed" is therefore false and must not come back.
	it('no "treats it like Platform LLM allowed" caveat, in any locale', async () => {
		const { readFileSync, readdirSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const dir = resolve(process.cwd(), 'messages');
		const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
		expect(files.length).toBe(8);
		const en = JSON.parse(readFileSync(resolve(dir, 'en.json'), 'utf8')) as Record<string, string>;
		expect(en.admin_tenants_byo_help_platform_only).toMatch(/a key saved earlier is ignored/);
		for (const f of files) {
			const cat = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as Record<string, string>;
			// Every locale's old caveat quoted the local_allowed LABEL; the new text never does.
			expect(cat.admin_tenants_byo_help_platform_only, f).not.toContain(cat.admin_tenants_byo_local_allowed!);
		}
	});
});

describe('isSystemTenantRow', () => {
	it('the backend flag wins', () => {
		expect(isSystemTenantRow({ id: 't-1', isSystemTenant: true })).toBe(true);
		expect(isSystemTenantRow({ id: SYSTEM_TENANT_ID, isSystemTenant: false })).toBe(false);
	});

	it('⛔ without the flag (an older backend mid-roll) the nil UUID is still recognised', () => {
		expect(isSystemTenantRow({ id: SYSTEM_TENANT_ID })).toBe(true);
		expect(isSystemTenantRow({ id: SYSTEM_TENANT_ID.toUpperCase() })).toBe(true);
		expect(isSystemTenantRow({ id: '00000000-0000-0000-0000-000000000001' })).toBe(false);
	});
});
