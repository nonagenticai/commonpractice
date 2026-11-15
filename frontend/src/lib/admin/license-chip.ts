// src/lib/admin/license-chip.ts — what the licence chip on the platform /tenants screen says, and
// what clicking it does.
//
// Extracted as a PURE function rather than left inline in `+page.svelte` so it can be unit-tested:
// the decision has five branches, one of which (`licenseState === undefined`) exists solely to make
// a mixed deploy safe and is therefore the branch nobody would notice breaking.
//
// Background: the row used to render a single boolean, `licensed`, which meant "a token was written
// into this row once" — not "the token works". In prod 18 of 19 tenants reported licensed=true
// while the licences service held a `commonpractice` licence for only 5; the other 13 introspect
// `active:false`, so Gate 2 402s them on every screen while the chip stayed a calm grey "Licensed".
import type { PlatformTenant } from '$lib/types/admin';

/** Visual weight. `missing` is the loud coral affordance; `muted` is deliberately NOT coral. */
export type LicenseChipTone = 'ok' | 'missing' | 'muted';

/** Which copy the chip carries (the caller maps these to paraglide keys). */
export type LicenseChipLabel = 'ok' | 'missing' | 'not_active' | 'cannot_verify';

/**
 * What a click does.
 *  - `issue` → `issueLicense(t)`: mints a licence for a tenant that has no token.
 *  - `force` → `issueLicense(t, true)`: REPLACES a stored token. The only thing that repairs a
 *    tenant which holds a token the licences service does not honour — the plain call would report
 *    `alreadyLicensed` and change nothing.
 *  - `null`  → non-actionable: we do not know the state, so we do not offer a destructive repair.
 */
export type LicenseChipAction = 'issue' | 'force' | null;

export interface LicenseChip {
  tone: LicenseChipTone;
  label: LicenseChipLabel;
  action: LicenseChipAction;
}

/** The subset of a tenant row this decision reads. All three licence fields may be absent. */
export type LicenseChipInput = Pick<PlatformTenant, 'licensed'> &
  Partial<Pick<PlatformTenant, 'licenseState' | 'licenseHasToken'>>;

/**
 * Decide the chip for one tenant row.
 *
 * | derived                        | chip                        | click                    |
 * |--------------------------------|-----------------------------|--------------------------|
 * | `active`                       | quiet grey, "Licensed"      | force re-issue           |
 * | `none` && !hasToken            | loud coral, "No licence"    | issue                    |
 * | `none` && hasToken, `expired`  | loud coral, "Licence not active" | straight to force   |
 * | `unknown`                      | muted (NOT coral), "Can't verify" | nothing            |
 * | `licenseState === undefined`   | exactly today's behaviour   | exactly today's behaviour|
 */
export function licenseChipFor(t: LicenseChipInput): LicenseChip {
  // MIXED-DEPLOY GUARD: a new frontend talking to an old backend (or one with the licence gate
  // disabled, which emits no licence fields at all) gets no `licenseState`. It must then render
  // EXACTLY what it rendered before this change — never "Can't verify" for the whole estate.
  if (t.licenseState === undefined) {
    return t.licensed
      ? { tone: 'ok', label: 'ok', action: 'force' }
      : { tone: 'missing', label: 'missing', action: 'issue' };
  }

  switch (t.licenseState) {
    case 'active':
      return { tone: 'ok', label: 'ok', action: 'force' };
    case 'unknown':
      // The licences service could not be reached. Muted, not coral: during an outage every row
      // would otherwise turn alarming and invite an operator to force-reissue healthy licences.
      return { tone: 'muted', label: 'cannot_verify', action: null };
    case 'expired':
      return { tone: 'missing', label: 'not_active', action: 'force' };
    case 'none':
      // The whole reason `hasToken` is carried next to `state`: same state, different repair.
      return t.licenseHasToken
        ? { tone: 'missing', label: 'not_active', action: 'force' }
        : { tone: 'missing', label: 'missing', action: 'issue' };
    default:
      // A state this frontend does not know (a NEWER backend). Say so — muted and inert — rather
      // than guessing from the stale `licensed` boolean. Deliberately NOT the legacy fallback: that
      // belongs to `undefined` alone, so deleting the mixed-deploy guard above actually breaks
      // something instead of quietly landing here.
      return { tone: 'muted', label: 'cannot_verify', action: null };
  }
}
