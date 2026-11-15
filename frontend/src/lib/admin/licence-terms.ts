// src/lib/admin/licence-terms.ts — pure helpers for the super_admin licence editor and the create
// form on (platform)/tenants. Its own module (like license-chip.ts / parse-money.ts) so the parts
// that decide WHAT IS SENT are testable under vitest's node env, without a Svelte component.
import type { ByoMode, PatchTenantBody, TenantLicence, TenantStatus } from '$lib/types/admin';

/**
 * `<input type="date">` value → the ISO instant the backend takes (it refuses a naive string:
 * `z.string().datetime({ offset: true })`). Blank → null (= clear / perpetual).
 *
 * LOCAL midnight of that day, serialised with `toISOString()` (an explicit `Z` offset). The reverse
 * (`isoToDateInput`) reads it back in the same local zone, so the day the operator picked is the day
 * the editor shows next time. An unparseable value → undefined (caller says "invalid date").
 */
export function dateInputToIso(value: string): string | null | undefined {
	const t = value.trim();
	if (!t) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
	if (!m) return undefined;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	if (Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3])) return undefined;
	return d.toISOString();
}

/** ISO instant → `YYYY-MM-DD` in the local zone, for an `<input type="date">`. null → ''. */
export function isoToDateInput(iso: string | null | undefined): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Seats field: blank → null (unlimited), a positive integer → it, anything else → undefined. */
export function parseSeatsField(raw: string): number | null | undefined {
	const t = raw.trim();
	if (!t) return null;
	if (!/^\d+$/.test(t)) return undefined;
	const n = Number.parseInt(t, 10);
	return n > 0 ? n : undefined;
}

/** What the editor shows, as strings exactly as the inputs hold them. */
export interface LicenceDraft {
	name: string;
	planCode: string;
	/** `YYYY-MM-DD` or '' */
	startsAt: string;
	expiresAt: string;
	/** seat cap as typed; '' = unlimited */
	seats: string;
	/** '' = unknown (licences could not be read) — never sent unless the operator picks one. */
	byoMode: ByoMode | '';
	status: TenantStatus;
}

export type PatchBuild =
	| { ok: true; patch: PatchTenantBody }
	| { ok: false; reason: 'name_required' | 'seats_invalid' | 'date_invalid' | 'window_invalid' };

/**
 * Diff the draft against what was loaded and return ONLY the changed fields — the backend treats
 * every present key as a change (a re-sent `planCode` re-mints a licence; a re-sent `startsAt` is a
 * licence change too), so sending the whole form would re-issue the tenant's licence on every save.
 *
 * Dates compare as the `YYYY-MM-DD` the inputs hold, so an untouched date is never re-sent even
 * though its ISO form round-trips through local midnight. A cleared date is sent as `null`.
 */
export function buildLicencePatch(original: LicenceDraft, draft: LicenceDraft): PatchBuild {
	const patch: PatchTenantBody = {};
	const name = draft.name.trim();
	if (!name) return { ok: false, reason: 'name_required' };
	if (name !== original.name.trim()) patch.name = name;

	if (draft.planCode && draft.planCode !== original.planCode) patch.planCode = draft.planCode;

	const start = dateInputToIso(draft.startsAt);
	const end = dateInputToIso(draft.expiresAt);
	if (start === undefined || end === undefined) return { ok: false, reason: 'date_invalid' };
	if (start && end && new Date(end).getTime() <= new Date(start).getTime()) {
		return { ok: false, reason: 'window_invalid' };
	}
	if (draft.startsAt.trim() !== original.startsAt) patch.startsAt = start;
	if (draft.expiresAt.trim() !== original.expiresAt) patch.expiresAt = end;

	const seats = parseSeatsField(draft.seats);
	if (seats === undefined) return { ok: false, reason: 'seats_invalid' };
	if (seats !== parseSeatsField(original.seats)) patch.maxMembers = seats;

	if (draft.byoMode && draft.byoMode !== original.byoMode) patch.byoMode = draft.byoMode;
	if (draft.status !== original.status) patch.status = draft.status;
	return { ok: true, patch };
}

/**
 * Where licences disagrees with CP's own terms. Only judged when licences ANSWERED (`liveError`
 * null and it is configured): an outage is reported as "could not check", never as drift.
 *   missing — CP thinks the tenant is licensed and active, licences holds no active licence.
 *   plan    — licences' active licence is on another plan.
 *   expiry  — licences' expiry differs from CP's (to the minute; null = perpetual on both sides).
 */
export function licenceDrift(lic: TenantLicence): { missing: boolean; plan: boolean; expiry: boolean } {
	const none = { missing: false, plan: false, expiry: false };
	if (!lic.centralConfigured || lic.liveError) return none;
	const live = lic.live;
	if (!live || !live.active) {
		return { ...none, missing: lic.licensed && lic.status === 'active' };
	}
	const minute = (iso: string | null) => (iso ? Math.floor(new Date(iso).getTime() / 60_000) : null);
	return {
		missing: false,
		plan: live.planCode !== null && live.planCode !== lic.planCode,
		expiry: minute(live.expiresAt) !== minute(lic.expiresAt)
	};
}
