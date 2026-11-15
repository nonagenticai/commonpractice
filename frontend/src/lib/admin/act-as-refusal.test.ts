// src/lib/admin/act-as-refusal.test.ts — every refusal code /api/me can put in
// `activeTenantRejected` maps to a sentence with the operator's remedy; an unknown one still says
// WHAT was refused (its code), never nothing.
import { describe, it, expect, vi } from 'vitest';

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

import { actAsReasonText } from './act-as-refusal';

describe('actAsReasonText', () => {
	it.each([
		'license_required',
		'license_inactive',
		'license_expired',
		'license_app_mismatch',
		'license_tenant_mismatch',
		'license_unreadable'
	])('%s → the licence remedy', (code) => {
		expect(actAsReasonText(code)).toBe('act_as_reason_licence');
	});

	it.each([
		['tenant_suspended', 'act_as_reason_suspended'],
		['tenant_offboarded', 'act_as_reason_offboarded'],
		['tenant_not_provisioned', 'act_as_reason_not_provisioned'],
		['INVALID_ACTIVE_TENANT_HEADER', 'act_as_reason_other:INVALID_ACTIVE_TENANT_HEADER']
	])('%s → %s', (code, text) => {
		expect(actAsReasonText(code)).toBe(text);
	});
});
