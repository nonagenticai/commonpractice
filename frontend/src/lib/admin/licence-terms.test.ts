import { describe, it, expect } from 'vitest';
import {
	buildLicencePatch,
	dateInputToIso,
	isoToDateInput,
	licenceDrift,
	parseSeatsField,
	type LicenceDraft
} from './licence-terms';
import type { TenantLicence } from '$lib/types/admin';

const base: LicenceDraft = {
	name: 'Acme',
	planCode: 'standard',
	startsAt: '',
	expiresAt: '2027-01-15',
	seats: '10',
	byoMode: 'byo_required',
	status: 'active'
};

describe('dateInputToIso / isoToDateInput', () => {
	it('blank is null (clear / perpetual)', () => {
		expect(dateInputToIso('')).toBeNull();
		expect(dateInputToIso('  ')).toBeNull();
	});
	it('a day is LOCAL midnight, serialised with an explicit offset, and round-trips to the same day', () => {
		const iso = dateInputToIso('2027-01-15')!;
		expect(iso).toBe(new Date(2027, 0, 15).toISOString());
		expect(iso).toMatch(/Z$/);
		expect(isoToDateInput(iso)).toBe('2027-01-15');
	});
	it('rejects garbage and impossible days', () => {
		expect(dateInputToIso('15/01/2027')).toBeUndefined();
		expect(dateInputToIso('2027-02-30')).toBeUndefined();
	});
	it('null ISO → empty input', () => {
		expect(isoToDateInput(null)).toBe('');
	});
});

describe('parseSeatsField', () => {
	it('blank = unlimited, positive int = it, else invalid', () => {
		expect(parseSeatsField('')).toBeNull();
		expect(parseSeatsField('5')).toBe(5);
		expect(parseSeatsField('0')).toBeUndefined();
		expect(parseSeatsField('2.5')).toBeUndefined();
		expect(parseSeatsField('-3')).toBeUndefined();
	});
});

describe('buildLicencePatch', () => {
	it('⛔ an untouched draft is an EMPTY patch', () => {
		expect(buildLicencePatch(base, { ...base })).toEqual({ ok: true, patch: {} });
	});
	it('sends only the changed field', () => {
		expect(buildLicencePatch(base, { ...base, planCode: 'local-llm' })).toEqual({
			ok: true,
			patch: { planCode: 'local-llm' }
		});
	});
	it('a cleared expiry is null, a cleared seat cap is null', () => {
		expect(buildLicencePatch(base, { ...base, expiresAt: '', seats: '' })).toEqual({
			ok: true,
			patch: { expiresAt: null, maxMembers: null }
		});
	});
	it('an unknown BYO mode is never sent unless picked', () => {
		const orig = { ...base, byoMode: '' as const };
		expect(buildLicencePatch(orig, { ...orig })).toEqual({ ok: true, patch: {} });
		expect(buildLicencePatch(orig, { ...orig, byoMode: 'platform_only' })).toEqual({
			ok: true,
			patch: { byoMode: 'platform_only' }
		});
	});
	it('refuses a window that ends before it starts, a blank name, bad seats', () => {
		expect(buildLicencePatch(base, { ...base, startsAt: '2027-02-01' })).toEqual({ ok: false, reason: 'window_invalid' });
		expect(buildLicencePatch(base, { ...base, name: ' ' })).toEqual({ ok: false, reason: 'name_required' });
		expect(buildLicencePatch(base, { ...base, seats: 'x' })).toEqual({ ok: false, reason: 'seats_invalid' });
	});
});

describe('licenceDrift', () => {
	const lic = (over: Partial<TenantLicence>): TenantLicence => ({
		tenantId: 't',
		planCode: 'standard',
		startsAt: null,
		expiresAt: null,
		status: 'active',
		tenantStatus: 'active',
		licensed: true,
		licenceId: 'l',
		byoMode: null,
		licencesName: 't',
		centralLink: 'registered',
		centralConfigured: true,
		live: null,
		liveError: null,
		...over
	});
	const live = (planCode: string | null, expiresAt: string | null) => ({
		active: true,
		licenceId: 'l',
		planCode,
		expiresAt,
		status: 'active',
		subjectId: 's',
		candidateCount: 1
	});
	it('agrees → no drift', () => {
		expect(licenceDrift(lic({ live: live('standard', null) }))).toEqual({ missing: false, plan: false, expiry: false });
	});
	it('another plan / another expiry', () => {
		expect(licenceDrift(lic({ live: live('legacy', '2027-01-01T00:00:00.000Z') }))).toEqual({
			missing: false,
			plan: true,
			expiry: true
		});
	});
	it('licensed + active in CP but nothing live → missing', () => {
		expect(licenceDrift(lic({ live: null })).missing).toBe(true);
	});
	it('⛔ an error or an unconfigured licences is never drift', () => {
		expect(licenceDrift(lic({ live: null, liveError: 'down' }))).toEqual({ missing: false, plan: false, expiry: false });
		expect(licenceDrift(lic({ live: null, centralConfigured: false }))).toEqual({
			missing: false,
			plan: false,
			expiry: false
		});
	});
});
