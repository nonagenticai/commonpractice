// src/lib/i18n/license-copy.ts — the ONE place a blocked licence state becomes words a reader can
// read. Two screens ask that question and they must not answer it differently.
//
// ⛔ WHY THIS FILE EXISTS. The taxonomy was widened from TWO states to FOUR across three PRs:
// #252 (`license_unreadable` — we hold a blob we cannot decrypt), #255 (`license_unavailable` — the
// licences service is unreachable) and #258 (the backend half). `LicenseBlocked.svelte` was
// updated. `routes/license-upgrade/+page.svelte` was NOT — it kept the original
//
//     state === 'expired' ? heading_expired : heading_none
//
// so every non-expired state, INCLUDING the two new ones and `unknown`, fell through to
// "Your workspace doesn't have an active Common Practice license." That is the exact accusation
// those three PRs were written to delete: telling a paid-up customer they never paid.
//
// ⛔ AND IT IS REACHABLE — BUT NOT BY THE JOURNEY THE FIRST VERSION OF THIS COMMENT CLAIMED.
// That claim was: "during an OUTAGE the block screen still offers Renew to a super-admin acting as
// another tenant". It is FALSE, and adversarial review caught it. `isBlocked` is
// `!activeTenant.id && (...)` (licenseGate.svelte.ts:164), so the moment `activeTenant.current` is
// set the block screen does not mount AT ALL — the whole `{#if activeTenant.current}` arm inside
// LicenseBlocked.svelte is dead code. A false ⛔ claim in a load-bearing comment is worse than no
// comment, so it is corrected here rather than quietly deleted.
//
// The REAL reachable journey is `LicenseExpiringBanner.svelte` — see the entitled branch below —
// and it is the one that was broken. `/license-upgrade` is where `LICENSE_RENEW_URL` lands
// (licenseGate.svelte.ts:289-290) and it is deliberately NOT behind the gate (`+layout.svelte:19`),
// so it is a surface an ENTITLED reader can stand on.
//
// Measured on the running app 2026-08-15: the page rendered "Geen actieve licentie" for a tenant
// whose state was merely `unknown`.
//
// The fix is not to copy the four-branch ternary into a second file — that is how the two drifted
// in the first place. It is to have one definition both screens import, so the next person who adds
// a fifth state changes one place and `tsc` finds the rest.
//
// ⚠️ PRECEDENCE IS `blockReason` FIRST, THEN `state`, and the order matters. It mirrors
// `licenseGate.svelte.ts:75-115` exactly: `unreadable` outranks `outage` because it is a STANDING
// fault (a rotated key hits every tenant at once and clears only when an operator fixes it), while
// an outage is transient and self-resolving. `state` is consulted only when neither 402-derived
// reason is set — during an outage `state` is `'unknown'`, which carries no commercial meaning at
// all and must never be read as "none".
import * as m from '$lib/paraglide/messages';
import type { BlockReason, LicenseGateState } from '$lib/stores/licenseGate.svelte';

export interface LicenseCopy {
	heading: string;
	body: string;
	/** `true` when renewing cannot possibly help, so a Renew CTA would be a false promise.
	 *  Both non-commercial reasons qualify: an unreachable service and an unreadable blob. */
	renewIsPointless: boolean;
}

/**
 * Map the precise blocked state to heading + body.
 *
 * ⚠️ `state` alone is NOT enough and that is the whole lesson here — pass BOTH. A caller holding
 * only `state` sees `'unknown'` during an outage and during a decrypt failure alike, and the only
 * thing distinguishing them is the 402 code the gate recorded in `blockReason`.
 */
export function licenseCopy(
	reason: BlockReason,
	state: LicenseGateState,
	daysRemaining: number | null = null,
): LicenseCopy {
	// ⛔⛔ THE ENTITLED BRANCH, AND IT IS THE ONE THAT IS ACTUALLY REACHABLE FROM A BUTTON.
	// Found by adversarial review after the first version of this file shipped, by rendering the real
	// component across every (reason, state) pair rather than the four the test covered:
	//
	//     state=expiring_soon reason=null  →  "License expired · Your workspace's license has expired"
	//     state=active        reason=null  →  same
	//
	// `LicenseExpiringBanner.svelte` fires for `expiring_soon` with NO block reason and offers a
	// "Renew licence" button, which navigates here. So a paying customer with five days left clicked
	// Renew and was told their licence had ALREADY EXPIRED — the exact false claim this module was
	// written to delete, on the page it is named after, reachable by one click from a healthy screen.
	// The old two-branch ternary said "no active licence" for the same case, so this was wrong before
	// and wrong after; it is the branch nobody thought about because `/license-upgrade` was assumed
	// to be a blocked-only surface. It is not — `+layout.svelte:19` excludes it from the gate.
	//
	// ⚠️ ENTITLED IS NOT A BLOCK, SO THE COPY IS NOT A DIAGNOSIS. Heading is the ACTION ("Renew
	// licence") rather than a verdict on the workspace, and the body is the existing expiring copy.
	// Zero new catalog keys: `license_expiring_days` / `license_expiring_soon` already ship in all 8.
	if (reason === null && (state === 'active' || state === 'expiring_soon')) {
		return {
			heading: m.license_blocked_renew(),
			body:
				daysRemaining != null
					? m.license_expiring_days({ days: daysRemaining })
					: m.license_expiring_soon(),
			renewIsPointless: false,
		};
	}
	if (reason === 'unreadable') {
		return {
			heading: m.license_blocked_heading_unreadable(),
			body: m.license_blocked_body_unreadable(),
			renewIsPointless: true,
		};
	}
	if (reason === 'outage') {
		return {
			heading: m.license_blocked_heading_unavailable(),
			body: m.license_blocked_body_unavailable(),
			renewIsPointless: true,
		};
	}
	// ⛔ A FOURTH REASON, AND IT IS THE ONE THIS FILE'S HEADER PREDICTED ("the next person who adds a
	// fifth state changes one place"). `seat` means the WORKSPACE IS PAYING and this reader has no
	// seat on its licence — so both terminal branches below are false about them, in the precise way
	// this module exists to delete: `heading_none` + `error_license_required` accuses a paid-up
	// customer of never buying, and `heading_expired` + `error_license_expired` of letting it lapse.
	//
	// ⚠️ `renewIsPointless` IS TRUE AND IT IS NOT DECORATION HERE. Renewing a current licence changes
	// nothing a seatless member can see; the money is already spent. Unlike `unreadable`, though, the
	// reader is not helpless — there IS a next step, and the BODY is the sentence that names it,
	// which is why it reuses `error_license_seat_required` rather than minting a second wording of
	// the same instruction (the same reuse `state === 'none'` makes of `error_license_required`).
	// Only the HEADING is new.
	if (reason === 'seat') {
		return {
			heading: m.license_blocked_heading_seat(),
			body: m.error_license_seat_required(),
			renewIsPointless: true,
		};
	}
	// `setup`: the reader IS a member and their seat is being minted (an accept whose licence call
	// failed after seating — the backend finishes it). Not `seat` ("ask your administrator for a
	// seat") and not renewal: the honest sentence is "being set up, this page checks again".
	if (reason === 'setup') {
		return {
			heading: m.license_blocked_heading_setup(),
			body: m.license_blocked_body_setup(),
			renewIsPointless: true,
		};
	}
	// `no_workspace` (the reader is seated in no workspace) is NOT a licence verdict and is never
	// blocked; it reaches this function only on `/license-upgrade`, which is ungated. Falling through
	// to the terminal default would tell someone with no workspace that "their" licence expired.
	// The no-workspace copy says what is actually true; renewing cannot help a workspace that is not
	// there. Zero new catalog keys.
	if (reason === null && state === 'no_workspace') {
		return {
			heading: m.no_workspace_heading(),
			body: m.no_workspace_body(),
			renewIsPointless: true,
		};
	}
	// ⛔ THE TERMINAL DEFAULT IS *EXPIRED*, NOT *NONE*, AND THAT IS DELIBERATE — I GOT IT BACKWARDS
	// ONCE AND TWO EXISTING TESTS CAUGHT IT.
	//
	// `handleForbidden` (licenseGate.svelte.ts:256-273) collapses every commercial 402 —
	// `license_expired`, `license_required`, `license_inactive`, `license_tenant_mismatch` — into the
	// single reason `'terminal'`, throwing the specific code away. The status poll that would tell
	// us which one has NOT come back yet at the moment the screen first paints, so `state` is
	// `'unknown'`. Branching on `state === 'expired'` therefore renders "no active licence" for a
	// workspace whose 402 said, in as many words, that its licence EXPIRED —
	// `license-blocked.outage.render.test.ts:73` and `.unreadable.render.test.ts` both pin exactly
	// that instant. Only `state === 'none'` is positive evidence of never having had one.
	//
	// ⚠️ SO THIS IS A KNOWN-LOSSY DEFAULT, WRITTEN DOWN RATHER THAN HIDDEN. It is right for the two
	// codes that dominate in practice and wrong for a `license_required` 402 seen before the poll
	// lands — that reader is told "expired" instead of "never bought". The real repair is upstream:
	// `BlockReason` should carry the terminal KIND instead of flattening four codes into one word.
	// That is a change to the store's contract and its own tests, deliberately not made inside a PR
	// about two screens drifting apart. When someone does it, this branch is where it lands.
	//
	// HEADING AND BODY NOW MOVE TOGETHER. Before, the heading branched on `state === 'none'` while
	// the body branched on `state === 'expired'`, so this same `unknown` case rendered the heading
	// "License expired" above the body "Your workspace doesn't have an active license" — two
	// different claims, stacked. One rule now decides both.
	if (state === 'none') {
		return {
			heading: m.license_blocked_heading_none(),
			body: m.error_license_required(),
			renewIsPointless: false,
		};
	}
	return {
		heading: m.license_blocked_heading_expired(),
		body: m.error_license_expired(),
		renewIsPointless: false,
	};
}
