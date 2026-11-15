// src/lib/i18n/delivery-error-label.ts — the ONE place a failed delivery attempt becomes words.
//
// ⛔ THE DEFECT. `/solutions/[id]` rendered
//
//     <span class="delivery-rowerr" title={d.error ?? ''}>{d.error ?? ''}</span>
//
// and `d.error` is `solution_deliveries.error`: an ENGLISH SENTENCE authored in the adapter
// (`backend/src/host/delivery/azure-devops.ts` — "Azure DevOps request timed out — verify in Azure
// DevOps before retrying") and persisted verbatim. The two neighbouring branches on that same block
// are localized (`m.delivery_forward_ticket_exists()`, `m.delivery_forward_retry()`), so the English
// sat inside otherwise-Dutch copy on a screen the product demos from.
//
// ⛔⛔ AND THE CODE EXISTED THE WHOLE TIME. Every failure that reaches this column is one of the
// three typed classes — `DeliveryConfigError`, `DeliveryDispatchError`, `EgressBlockedError` — and
// all three carry a stable snake_case `code`. The route kept `err.message` and threw the code away
// at exactly the point where the code was the only translatable thing in the room. It is now
// persisted alongside (`response._cp_code`, an existing jsonb column — NO migration) and lifted onto
// the wire as `errorCode`.
//
// ⛔ ROWS ALREADY IN THE TABLE HOLD ONLY ENGLISH, AND THEY ARE NOT MIGRATED. `errorCode` is `null`
// for every attempt written before this change, and the fallback below renders `d.error` for them —
// forever, or until they age out. That is a deliberate, stated limitation, not an oversight: a
// backfill would have to re-derive a code from prose, and a wrong classification on a delivery
// ledger is worse than an untranslated one.
//
// ⚠️ THE SAME FALLBACK COVERS THREE MORE CASES, WHICH IS WHY IT IS NOT DEAD CODE:
//   · a rolling deploy — the browser reaches the API through the Service, so a NEW bundle really is
//     answered by an OLD pod that ships no `errorCode` at all;
//   · a code shipped BACKEND-FIRST that this build has never heard of;
//   · a failure the backend itself could not classify (it stores `_cp_code: null` on purpose — the
//     raw message is the only information that exists, and a generic localized sentence would say
//     strictly less).
// In all four, an English sentence is a worse read than a Dutch one and an infinitely better read
// than nothing. Same rule `data-finding-label.ts` and `api/graph-issues.ts` already established.
//
// EXHAUSTIVE SWITCH, NOT A LOOKUP TABLE — paraglide compiles one function per key and tree-shakes
// on the import graph, so `m[`delivery_error_${code}`]()` does not resolve. The house idiom.
import * as m from '$lib/paraglide/messages';
import type { Delivery, DeliveryKind } from '$lib/api/delivery';

/**
 * The connector's tool name.
 *
 * ⚠️ THIS USED TO EXIST TWICE — once in `routes/(tenant)/delivery/+page.svelte` and once in
 * `routes/solutions/[id]/+page.svelte`, the second one carrying the comment "reuses the (tenant)/
 * delivery screen's kind labels" while being a hand-written copy of them. A third copy inside this
 * module would have been the one that finally drifted, so both call sites now import this.
 *
 * The `jira` fallback for an unknown kind is the pre-existing behaviour of both copies, kept: the
 * kind is a closed backend enum and a new member is a build-time concern, not a render-time one.
 */
export function deliveryKindLabel(kind: DeliveryKind | string): string {
	if (kind === 'azure_devops') return m.delivery_kind_azure_devops();
	if (kind === 'fr') return m.delivery_kind_fr();
	return m.delivery_kind_jira();
}

/**
 * The machine fields the backend puts behind a delivery/egress refusal's English sentence —
 * `backend/src/host/delivery/errors.ts`'s `DeliveryConfigDetail`, plus the `{ kind }` that
 * `routes/delivery.ts` adds for `egress_bad_target` and `delivery_target_kind_unsupported`.
 *
 * ⚠️ EVERY FIELD IS `unknown`, NOT THE BACKEND'S UNION. This bag arrives off the wire through
 * `ApiError.details`, which is `Record<string, unknown>`; typing it as the union here would be a
 * claim the runtime cannot keep, and the `=== 'base_url'` comparisons below are what actually
 * narrows it. Same reason `deliveryErrorLabel` takes `string | null` for `errorCode`.
 */
export interface DeliveryRefusalDetail {
	kind?: unknown;
	field?: unknown;
	reason?: unknown;
}

/**
 * The connector's tool name for a wire `kind`, or `null` when the wire did not carry a KNOWN one.
 *
 * ⛔ DELIBERATELY NOT `deliveryKindLabel`, AND THE DIFFERENCE IS A LIE AVOIDED. That function
 * defaults an unrecognised kind to Jira, which is correct where it is used — the ledger row's
 * `targetKind` is a non-null DB enum column, so the default is unreachable there and exists only to
 * keep the return type total. On the REFUSAL path the kind comes from a `details` bag that an OLD
 * POD does not send at all (the browser reaches the API through the Service, so a new bundle really
 * is answered by an old pod for the length of a roll). Defaulting there would tell an Azure DevOps
 * admin that their ATLASSIAN JIRA connector is misconfigured. `null` sends them to the backend's
 * English sentence instead, which is the house three-branch rule (see `graph-issue-label.ts`).
 */
function toolForKind(kind: unknown): string | null {
	return kind === 'jira' || kind === 'azure_devops' || kind === 'fr' ? deliveryKindLabel(kind) : null;
}

/**
 * The reader's sentence for a delivery CONFIG/EGRESS refusal, given the tool it is about.
 *
 * ⛔ ONE SWITCH, TWO CALLERS, AND THAT IS THE WHOLE REASON IT IS A SEPARATE FUNCTION. These codes
 * reach the reader on two different surfaces: the DELIVERY LEDGER column on `/solutions/[id]`
 * (a persisted attempt, via `deliveryErrorLabel` below) and the 422 REFUSAL that
 * `api/error-message.ts`'s `writeErrorText` renders when the same precheck rejects a forward or a
 * connector save. Before this existed only the first was localized, and duplicating the switch into
 * `VALIDATION_MESSAGES` would have been a second code→copy mechanism for the same wire field — the
 * thing `error-message.ts`'s `delivery_already_live` comment argues against at length. The two
 * paths now cannot disagree, because there is only one set of sentences.
 *
 * ⛔ THE `detail` ARGUMENT IS THE ONLY DIFFERENCE BETWEEN THEM, AND IT IS ALWAYS `undefined` FOR THE
 * LEDGER. A stored `solution_deliveries` row keeps `response._cp_code` and nothing finer — there is
 * no `_cp_detail` column and no migration here — so the ledger takes the code-granular sentence and
 * the refusal takes the finer one when the bag is on the wire. Both are true; the refusal's is
 * simply more useful, and it is the one an admin can act on without opening the connector to guess
 * which field is empty.
 *
 * Returns `null` for a code this module does not own, so a caller can fall through to its own
 * switch (the ledger) or to the backend's English sentence (the refusal).
 */
export function deliveryRefusalCopy(
	code: string,
	tool: string,
	detail?: DeliveryRefusalDetail
): string | null {
	switch (code) {
		case 'delivery_target_incomplete':
			// ⚠️ THE VALUES ARE THE CONNECTOR FORM'S FIELDS, NOT THE VENDOR'S NOUNS. Azure DevOps's
			// English says "organization URL" and "project"; the box the reader has to fill is labelled
			// `delivery_baseurl_label` / `delivery_project_key_label` for all three kinds, so the
			// backend maps both onto `base_url`/`project_key`. See `DeliveryConfigDetail`.
			if (detail?.field === 'base_url') return m.delivery_error_incomplete_base_url({ tool });
			if (detail?.field === 'project_key') return m.delivery_error_incomplete_project_key({ tool });
			// No bag (ledger row, or an old pod) → the code-granular sentence, which is what this
			// column already said before the bag existed.
			return m.delivery_error_target_incomplete({ tool });
		case 'delivery_target_credentials_missing':
			// One sentence at all three throw sites (jira.ts:99, azure-devops.ts:114, fr.ts:61) — the
			// bag carries only `kind`, and there is nothing finer to say.
			return m.delivery_error_credentials_missing({ tool });
		case 'delivery_target_credentials_invalid':
			// Six English sentences, two causes: the ciphertext would not decrypt, or it decrypted to
			// the wrong shape. Same repair, but only the second tells the admin the token is THERE.
			if (detail?.reason === 'undecryptable')
				return m.delivery_error_credentials_undecryptable({ tool });
			if (detail?.reason === 'malformed') return m.delivery_error_credentials_malformed({ tool });
			return m.delivery_error_credentials_invalid({ tool });
		case 'egress_bad_target':
			return m.delivery_error_egress_bad_target({ tool });
		default:
			return null;
	}
}

/**
 * `deliveryRefusalCopy` for the REFUSAL path, where the tool has to be recovered from the wire.
 *
 * Returns `null` — landing the reader on the backend's English sentence — when the `details` bag
 * carries no recognised `kind`. See `toolForKind` for why that is not a defaulting opportunity.
 */
export function deliveryRefusalLabel(
	code: string,
	details: Record<string, unknown> | undefined
): string | null {
	const tool = toolForKind(details?.kind);
	return tool === null ? null : deliveryRefusalCopy(code, tool, details as DeliveryRefusalDetail);
}

/** The fields of a delivery attempt this module reads — nothing else. */
export type DeliveryErrorView = Pick<
	Delivery,
	'error' | 'errorCode' | 'errorStatus' | 'targetKind'
>;

/**
 * The reader's sentence for one failed delivery attempt.
 *
 * Takes `string | null` for `errorCode` (via the DTO), not a literal union: the code is a
 * backend-first field and this function must degrade to `d.error` for one it does not recognise
 * rather than render a bare token or nothing at all.
 *
 * Returns `''` — not a manufactured sentence — when there is neither a code nor an `error`, so the
 * caller's existing `{d.error ?? ''}` behaviour for a blank cell is unchanged.
 */
export function deliveryErrorLabel(d: DeliveryErrorView): string {
	const tool = deliveryKindLabel(d.targetKind);
	// ── config + the bad-target egress arm: SHARED with the 422 refusal path ─────────────────────
	// ⛔ NOT A SECOND COPY OF THOSE SENTENCES. `deliveryRefusalCopy` owns them because
	// `api/error-message.ts` renders the identical codes when the SAME precheck rejects a forward
	// before any row is written; a ledger row carries no `detail` bag (there is no `_cp_detail`
	// column), so this call passes none and gets the code-granular sentence this switch used to
	// hold inline. `null` for every code it does not own, which falls through to the switch below.
	if (d.errorCode) {
		const shared = deliveryRefusalCopy(d.errorCode, tool);
		if (shared !== null) return shared;
	}
	switch (d.errorCode) {
		// ── dispatch: we reached (or tried to reach) the target ──────────────────────────────────
		case 'target_http_error':
			// ⛔ THE STATUS IS PART OF THE MESSAGE AND ITS ABSENCE IS A FALLBACK, not a zero. A pod
			// one deploy behind persists `_cp_code` without `_cp_status` (they shipped together, but
			// the wire is not a transaction), and "answered with HTTP undefined" says less than the
			// English sentence it replaced. `0` is not a real status either — the backend uses it to
			// mean "no response at all", which is the transport/timeout case, not this one.
			if (!d.errorStatus) return d.error ?? m.delivery_error_target_http_no_status({ tool });
			return m.delivery_error_target_http({ tool, status: d.errorStatus });
		case 'timeout':
			return m.delivery_error_timeout({ tool });
		case 'transport':
			return m.delivery_error_transport({ tool });

		// ── egress: the platform refused the outbound call before it left ────────────────────────
		// Four distinct causes with four distinct fixes (a workspace switch, an allowlist entry, a
		// target that resolves somewhere it must not, a target that is not an address at all).
		// Collapsing them into one "blocked" sentence would tell an admin to do nothing in
		// particular, which is what the English already did badly.
		case 'egress_disabled':
			return m.delivery_error_egress_disabled();
		case 'egress_host_not_allowlisted':
			return m.delivery_error_egress_not_allowlisted({ tool });
		case 'egress_ssrf_blocked':
			return m.delivery_error_egress_ssrf_blocked({ tool });
		// `egress_bad_target` is handled ABOVE, by `deliveryRefusalCopy` — it is the one egress code
		// the 422 refusal path also emits (routes/delivery.ts:452), so its sentence is shared.

		// ── the ticket EXISTS and we failed to record it ─────────────────────────────────────────
		// ⛔ THE ONE MESSAGE ON THIS LIST A READER MUST ACT ON DIFFERENTLY. Everything else above
		// means "nothing happened at the target"; this one means a real ticket was created and CP
		// lost the write. Retrying makes a SECOND ticket.
		case 'delivery_ledger_update_failed':
			return m.delivery_error_ledger_update_failed({ tool });

		default:
			// Historical row, mid-roll pod, backend-first code, or a genuinely unclassified failure —
			// see the header. Never a bare token, never blank when there is prose to show.
			return d.error ?? '';
	}
}
