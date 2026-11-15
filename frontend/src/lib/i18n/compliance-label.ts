// src/lib/i18n/compliance-label.ts — the ONE place a row of the /governance compliance panel
// becomes words a reader can read.
//
// ⛔ THE DEFECT. Under the Dutch heading "Nalevingsstatus" sat four English rows:
//   "ISO 27001 controls / Passing", "GDPR data flows / Documented",
//   "DORA operational resilience / Passing", "EU AI Act risk profile / Re-assess in 21d".
// They came from the `COMPLIANCE` constant in backend/src/routes/governance.ts, which shipped
// ONLY prose — there was no machine key on the wire to render from, so unlike the policy rails
// this one could not be fixed in the frontend alone. The backend now sends `key` + `statusKey`
// alongside the prose (the prose stays one deploy for old frontends, and is read by nothing).
//
// ⛔ THE FALLBACK IS THREE-BRANCH, AND THE MIDDLE BRANCH IS LOAD-BEARING.
// The two containers share a pod, but the browser reaches the API through the SERVICE, which
// load-balances across old and new pods for the length of a rolling deploy — so a NEW frontend
// really does get answered by an OLD backend, whose rows carry prose and no `key` at all.
//   key known            → the catalog message                  (the normal path)
//   key ABSENT           → the legacy prose                      (old backend, mid-roll)
//   key present, UNKNOWN → the raw key, never the prose           (a build defect — see below)
// The third branch is deliberately NOT prose: an unknown key means someone added a backend row
// without a message, which the contract test reds at build time. Falling back to English there
// would hide exactly the defect this directory exists to remove, whereas a raw `nis2` is honest.
//
// Exhaustive switches for the reason spelled out in `stage-label.ts`: paraglide compiles one
// function per key and tree-shakes on the import graph, so a computed `m[`compliance_label_${k}`]()`
// does not resolve.
import * as m from '$lib/paraglide/messages';

/**
 * The reader's name for a compliance row.
 *
 * An unrecognised key returns the RAW KEY (`nis2`, say) rather than a blank cell — ugly, but it
 * names the row, and it is never an English sentence. The panel is a fixed four-row display, so
 * this only fires if someone adds a row to the backend constant without a catalog key;
 * `policy-label.backend-contract.test.ts` reds the build when that happens (it covers this file
 * too — there is no separate compliance contract test).
 */
export function complianceLabel(key: string | undefined, legacyLabel?: string): string {
	switch (key) {
		case 'iso27001':
			return m.compliance_label_iso27001();
		case 'gdpr':
			return m.compliance_label_gdpr();
		case 'dora':
			return m.compliance_label_dora();
		case 'eu_ai_act':
			return m.compliance_label_eu_ai_act();
		case undefined:
		case '':
			// Old backend, mid-roll. English is the only thing on the wire; a blank row is worse.
			return legacyLabel ?? '';
		default:
			return key;
	}
}

/**
 * The `{#each}` key for a compliance row.
 *
 * ⛔ NOT `c.key`. A pre-change backend sends none, so all four rows would key on `undefined`,
 * Svelte would throw `each_key_duplicate` — which is NOT dev-only, and with no `<svelte:boundary>`
 * anywhere in this tree it takes the WHOLE page down to an empty shell, rails included. An
 * adversarial pass mounted it and measured exactly that: 0 rails, 0 compliance rows, 326-byte body.
 * The label is present and unique on both wire versions, so it is the safe identity.
 */
export function complianceRowKey(row: { key?: string; label?: string }): string {
	return row.key || row.label || '';
}

/**
 * The reader's word for a compliance row's state.
 *
 * ⚠️ These are NOT one-per-row: ISO 27001 and DORA are both `passing` and must resolve to the
 * same word — three status keys for four rows. That is why the status is its own key on the DTO
 * rather than being folded into `complianceLabel`.
 *
 * `reassess` carries its own "in 21d" inside the message rather than taking a parameter: the 21
 * is part of the hard-coded demo prose in the backend constant, not a computed deadline. The day
 * this panel is backed by real attestation dates, this becomes a parameterised message and the
 * number comes off the wire.
 */
export function complianceStatusLabel(statusKey: string | undefined, legacyStatus?: string): string {
	switch (statusKey) {
		case 'passing':
			return m.compliance_status_passing();
		case 'documented':
			return m.compliance_status_documented();
		case 'reassess':
			return m.compliance_status_reassess();
		case undefined:
		case '':
			return legacyStatus ?? '';
		default:
			return statusKey;
	}
}
