// src/lib/i18n/placeholder-parity.test.ts — every locale must interpolate the SAME parameters for a
// given key. A pattern that quietly stops interpolating one renders an EMPTY slot for that reader.
//
// ⛔ THE DEFECT THIS EXISTS TO CATCH, MEASURED ON THIS REPO. Delete `{column}` from all three
// patterns of `data_finding_type_mismatch` in `messages/de.json` — leaving both `input column`
// declarations in place, so nothing about the message SIGNATURE changes — and:
//
//     bun run check   → 2021 files, 0 errors      (a paraglide input is `NonNullable<unknown>`;
//                                                  TypeScript cannot see an unused one)
//     bun run test    → 2021 files, 1036/1036 PASS
//
//     DE renders  'Spalte „“ hat 11.774 Werte, die nicht zum Attribut „amount“ passen …'
//     EN renders  'Column “bedrag” has 11,774 values that don’t match attribute “amount” …'
//
// A German reader gets empty quotation marks on a finding whose entire purpose is to name that
// column. Nothing in the repo could see it: `catalogs.test.ts` compares key SETS and never looks
// inside a pattern, and PR #256's guard drives the compiled messages for `{countNum}` — the ten
// PLURAL keys only, 80 of the 2112 (key, locale, placeholder) triples across 195 parameterised
// keys. Every other placeholder in every other locale was unguarded, including this one.
//
// ⛔⛔ WHY A CATALOG SCAN AND NOT MORE COMPILED-MESSAGE DRIVING. `icu-number-params.test.ts` drives
// the real compiled functions because its property is about RUNTIME behaviour (the plural selector
// reading `Number("1.000")`). This property is different: it is about the catalogs agreeing with
// each other, it holds for every key in the base catalog × 8 locales, and driving it would mean
// inventing a plausible argument for every parameter of every message in eight languages. The
// catalog is the artifact that is edited by hand and by the translation worker, and it is where the
// drift appears.
//
// ⚠️ NO KEY COUNT IN THIS PROSE, DELIBERATELY. The number belongs in exactly one place — the
// assertion below, which fails loudly and prints both figures when it goes stale. A second copy in
// a comment is worse than none: git auto-merges a comment line WITHOUT a conflict, so two branches
// that each add keys leave a confidently wrong number here and a correct one twelve lines down.
//
// ⚠️ THE UNION ACROSS VARIANTS IS DELIBERATE, NOT LAZINESS. `he/console_ready`'s `one` branch is
// "בלוק אחד מוכן" — Hebrew spells the singular as a word and interpolates nothing, which is CORRECT
// and which a pattern-by-pattern comparison would report as drift. What must hold is that the
// message as a whole still names every parameter the base catalog names.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Same list, same order as `catalogs.test.ts` — the SPEC §5B locales.
const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;

type Variant = { declarations?: string[]; selectors?: string[]; match: Record<string, string> };
type Entry = string | Variant[];

const load = (locale: string): Record<string, Entry> =>
	JSON.parse(readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8'));

const cats = Object.fromEntries(LOCALES.map((l) => [l, load(l)])) as Record<
	string,
	Record<string, Entry>
>;

/** Every `{param}` a locale's patterns actually interpolate, unioned across variants. */
function placeholders(entry: Entry): Set<string> {
	const out = new Set<string>();
	const add = (pattern: string) => {
		for (const m of pattern.matchAll(/\{(\w+)\}/g)) out.add(m[1]!);
	};
	if (typeof entry === 'string') add(entry);
	else for (const v of entry) for (const p of Object.values(v.match)) add(p);
	return out;
}

describe('every catalog interpolates the same parameter set for a key', () => {
	// ⛔ NON-VACUITY. A scrape that silently read nothing would pass every assertion below, which is
	// the failure mode this repo has hit before (see `source-scan.ts`). Both halves are anchored: the
	// catalogs are real, and the specific message the defect was measured on really does carry four
	// placeholders — so "the parity holds" cannot mean "the parser found no placeholders".
	it('the scrape read real catalogs', () => {
		// ⚠️ RECOUNT, do not add your delta. This is `Object.keys(en.json).length`, and four parallel
		// branches each bumped it to THEIR OWN total (1699 / 1705 / 1697) — every one wrong once
		// another landed. 1704 (after ontology axis labels) + 13 (the /build 4xx copy) = 1717.
		// RECOUNTED against the tree in front of you, NOT arithmetic done in my head.
		// FIVE lanes have now rewritten this one line from 1776 (1777 / 1778 / 1783 / 1786 / +3), so every
		// merge after the first conflicts here. That conflict is the FEATURE: a hardcoded anchor is what
		// makes "the catalogs agree" mean something instead of comparing two empty sets, and the conflict
		// forces a human recount instead of silently landing a total that is short by the other side's key
		// count. Resolve it by RECOUNTING, never by taking one side — both sides are stale the moment they
		// merge:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"
		// This lane added three: scan_finding_no_function_constructor, scan_finding_no_computed_global
		// (the two new static-scan rules) and blockedit_err_source_refused (the save/create refusal, which
		// spoke English on a Dutch screen).
		// …and then ONE more: `datasets_picker_capped`, the note the dataset pickers render when the
		// page-walk hits its ceiling (/submit, challenge-detail, /ontology). 1820 + 1 = 1821, RECOUNTED
		// against the tree, not arithmetic. ⚠️ A sibling lane is editing components/build/*.svelte right
		// now; if it adds keys this line conflicts — recount, do not take a side.
		// …and then the `bad_config` refusal family, this lane: `bad_config_required`,
		// `_percent_escape`, `_backslash`, `_dot_segment`, `_absolute`, `_postgres_scheme`,
		// `_http_scheme`, `_key_escapes_bucket`, plus `unknown_connector` / `unknown_connector_generic`
		// — the sentences `POST /api/connectors/test` answers HTTP 200 with, which had NO case in
		// `connection-test-label.ts` and so reached a Dutch admin as `'url' is required`.
		// ⚠️ NO ARITHMETIC HERE ON PURPOSE — see the header: the count below is RECOUNTED against the
		// tree, never derived from the previous line's total. `datasets_picker_capped` landed under me
		// mid-edit and the recount absorbed it silently, which is exactly why the delta is not written.
		// …and then the 400/422/409 REFUSAL catalog, this lane: 63 keys for the 56 tenant-reachable
		// codes `writeErrorText` was still rendering the backend's English `message` for (91 of 102
		// codes had no `VALIDATION_MESSAGES` entry on 8d36692). The 63 are not 56 because six codes
		// carry a `details.reason` sub-discriminator and get one sentence per reason
		// (`bucket_convention` ×4, `not_storage_webhook` ×2, `industry_required` ×2,
		// `department_required` ×2, `unknown_node` ×2, `dataset_too_large` ×2), `voting_closed` gets
		// one per target noun, and `bad_config` / `unknown_connector` get NONE — their ten keys were
		// already minted for the 200-OK connection-test path and are REUSED, not duplicated.
		// …and then the TENANT-ADMIN half of that same defect, this lane: 18 keys for the 15 refusal
		// codes an ordinary customer's tenant admin hits on /(tenant)/{members,sso,llm-settings,
		// delivery} and the /solutions/[id] forward+retry buttons, which were `NOT_LOCALIZED_CODES`
		// entries reasoning "tenant-admin only". (The block held SEVENTEEN; two were measured
		// UNREACHABLE and kept their register entry with a corrected reason, so they minted no key.)
		// The 18 are not 15 because `email_exists` carries a
		// `details.reason` with three genuinely different repairs (×3), `api_key_required` two (×2),
		// `delivery_target_incomplete` gets one key per CONFIG FIELD (×2) and
		// `delivery_target_credentials_invalid` one per CAUSE (×2) — while `egress_bad_target`,
		// `delivery_target_credentials_missing` and the code-granular arms of the other two get NONE:
		// their keys were already minted for the delivery-LEDGER column on /solutions/[id] and are
		// REUSED through `i18n/delivery-error-label.ts`, not duplicated.
		// ⚠️ RECOUNTED AGAINST THE TREE, not derived — 1912 is what
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"
		// ⚠️ RECOUNTED AFTER INTEGRATION, NOT INCREMENTED, NOT PICKED FROM A SIDE.
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2021
		// This literal collides on EVERY merge because every catalog-touching lane bumps it. The rule
		// is: the integrated number is 1894 (measured on 8074fde) plus the UNION of every lane's new
		// keys — never one lane's figure, which is only true of that lane in isolation.
		//   +9   flow_summary_*        (the /build history panel's snapshot sentences)
		//   +3   connectors_secret_*   (the once-only webhook secret's copy control)
		//   +18  the tenant-admin refusal copy (delivery / llm-settings / members / sso)
		//   +6   the six controls that reported success they had not earned
		//   +28  blockerr_*            (the block-run + descriptor + executor refusals)
		//   +11  the six raw exec sentences, the generic kind fallback and the forgery guards
		//   +6   fr_license_* (×4) + run_stream_failed{,_request} (×2) — the fr Gate-2 refusals and
		//        the run-stream failure frame; measured, NOT added to 1969 by hand:
		//        python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2021
		// The earlier "stale key-count literal" claim in the session plan was WRONG and is retracted:
		// measured on 8074fde, en.json really did hold 1894 raw keys and this assertion was GREEN.
		// ⚠️ `$schema` IS one of these keys: catalogs.test.ts filters it out and this file does not,
		// so the two files legitimately disagree by exactly one. Not a bug.
		// …and then THREE more, this lane: `build_node_ports_unavailable` /
		// `_title` (the /build node placeholder that used to render `—` — indistinguishable from a
		// block that genuinely has no ports — when the descriptor fetch had FAILED) and
		// `build_descriptors_unavailable` (the amber canvas pill naming those blocks, with a retry).
		// ⚠️ TWO LANES LANDED IN ONE RELEASE (WS-1's 3 build_* keys and WS-2's 6 fr/run keys), so
		// neither lane's own figure (1972, 1975) is true of the merged tree. RECOUNTED here after
		// the rebase — never 1969+3+6 by hand, which is exactly how three 'right' answers were all
		// wrong once before:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2021
		// …and then TWO more, this lane: `error_unsupported_file_type{,_no_extension}` — the two
		// sentences behind the ONE wire code `unsupported_file_type`, chosen by `details.reason`.
		// The upload route used to close `sourceTypeFromName`'s null with `?? 'csv'`, so a dropped
		// `report.pdf` became a CSV dataset with 201 and no warning; the refusal that replaces the
		// guess has to reach a Dutch reader in Dutch, and the drag-drop guard in FileUpload.svelte
		// renders the SAME two keys client-side so the two paths cannot say different things.
		// ⚠️ RECOUNTED, NOT INCREMENTED — 1978 + 2 happens to agree here, but the figure below is
		// what the tree measured after the edit, not what arithmetic predicted:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2021
		// …and then EIGHT more, the run-path lane: the run-path + block-source-gate refusals, which were
		// `NOT_LOCALIZED_CODES` entries whose reasons all began "deferred (⚠️ NOT admin-only)".
		// `error_lint_failed` (the source gate, `{findings}` in the same shape as
		// `error_derived_lint_failed`), `error_sandbox_busy` (fires on an ordinary double-click of
		// Run), `error_sandbox_suspended{,_idle,_admin}` — THREE keys for one code, chosen by the
		// `suspensionReason` the backend already puts on the wire, because the two named arms have
		// genuinely different repairs — `error_data_validation_failed`, `error_not_resumable` and
		// `error_sandbox_admin_suspended`. Six codes, eight keys. That lane measured 2029 in isolation.
		// …and then EIGHTEEN more, the tenant-lifecycle lane: the suspension screen
		// (`workspace_suspended_*`) plus its two refusal sentences (`error_tenant_suspended`,
		// `error_tenant_status_unavailable`) and the offboard flow (`error_tenant_offboarded`,
		// `error_confirm_mismatch`, `tenant_offboard_confirm_prompt` and the rest of the dialog). That
		// lane measured 2039 in isolation.
		// ⛔ AND NEITHER FIGURE IS TRUE OF THE MERGED TREE, WHICH IS WHY THIS LINE CONFLICTED. Both
		// lanes branched from 2021 and each added its own keys, so 2029 and 2039 each count one lane's
		// delta and none of the other's. The integrated number is the UNION of both key sets — taking
		// either side wholesale silently reverts the other lane's catalog work while every test still
		// compiles. RECOUNTED against the eight resolved catalogs after the rebase (2029 + 18 = 2047
		// happens to agree, but the figure below is the MEASURED one, not the arithmetic):
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2047
		// ⛔ THIS CONSTANT IS SHARED BY EVERY BRANCH IN FLIGHT. Re-measure after every rebase onto a
		// moved main; never add, and never take a side.
		// ⚠️ RECOUNTED after rebasing onto #325 (which itself rebased onto #326) — MEASURED, not added:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2051
		// ⛔ This constant is shared by every branch in flight and it went wrong THREE times in one
		// session: 2021 → 2029 (#326) → 2047 (#325) → 2051 (#329). Each rebase must re-measure.
		// …and then FIVE more, the authoring-honesty lane: `build_readonly_notice` /
		// `build_save_readonly` (the /build banner + save-status label a NON-OWNER now sees, because
		// `GET /api/flows/:id` has always minted `readOnly` and no frontend read it),
		// `blockedit_cap_network_unavailable` (the Permissions & data row that replaces a toggle
		// granting a capability the sandbox does not have), `blockedit_test_run_failed` (the SSE
		// error frame's Dutch banner, which used to render the backend's raw English) and
		// `blockedit_usage_consumers_capped` (`{shown}`/`{total}` — the `LIMIT 6` the Usage-stats
		// consumer list never admitted to). MEASURED after the edit, not 2051 + 5 in my head:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2056
		//
		// ⛔ THEN +2 MORE, AND THIS IS WHY THIS LITERAL IS A TRAP. `delivery_forward_status_approved`
		// and `_rejected` came from a SIBLING branch. Both branches were green ALONE and red TOGETHER:
		// this anchor is a count of a GLOBAL total, so no single PR's CI can see two lanes contending
		// on it — per-PR CI tests branch+main, never branch+sibling-branch. It was caught only by
		// merging all three into an integration worktree and running the union. Re-measure, never
		// arithmetic-in-your-head, and expect to move it again whenever two lanes add keys at once:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2058
		//
		// …AND +4, the ontology-cardinality lane: `ontology_cardinality_{one_to_one,one_to_many,
		// many_to_one,many_to_many}` — the `.rel-card` chip on /ontology's relation rows, which
		// printed the raw `cardinality` column ("many-to-one") between two chips that were already
		// localized. See $lib/i18n/ontology-cardinality-label.ts. MEASURED after the edit, per the
		// trap the paragraph above describes — not 2058 + 4 in my head:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2062
		// …and then ONE more, the solution-detail sandbox lane: `solution_detail_sandbox_unavailable`
		// — the sentence a viewer gets when `GET /api/sandboxes/me` FAILS, which until now shared
		// `solution_detail_sandbox_pending`'s `null` and so told them their sandbox would be created
		// on the first run, forever. RECOUNTED against the tree after the edit, never 2062 + 1 in my
		// head, and never taken from a sibling lane's figure:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2063
		// …and then ONE more, the node-inspector lane: `nodecfg_ontology_schema_unknown` — what the
		// /build inspector says instead of a coverage fraction it could not measure (it used to fall
		// back to `cols.length / cols.length` and announce 100%%). RECOUNTED, never incremented:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2064
		// …and then ONE more, same lane: `nodecfg_ontology_load_failed` — a FAILED mapping fetch used
		// to render as `nodecfg_ontology_none`, i.e. as a fact about the dataset. RECOUNTED:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2065
		// …and then FOUR more, the canvas-node lane: `node_status_{running,ok,error,skipped}` — the
		// /build status dot rendered its enum raw, and two of its four members have no `run_status_*`
		// key at all (that enum is running|ok|partial|failed; this one is running|ok|error|skipped).
		// RECOUNTED, never 2065 + 4 in my head:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2069
		// …and then ONE more: `blockauthor_ontology_load_failed` — the "Bouwen met AI" form swallowed
		// its ontology-matrix read, and two selects collapsing to "Geen" is indistinguishable from a
		// tenant with no ontology. RECOUNTED:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2070
		//
		// …AND +6, the root +error.svelte lane: `error_page_not_found_{title,body}`,
		// `error_page_generic_{title,body}`, `error_page_status` and `error_page_home_link` — the
		// SvelteKit default error page (English, unstyled, no app shell) had no `+error.svelte`
		// anywhere in the route tree until this lane. RECOUNTED, not added by hand:
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2068
		// ⛔ THE TWO LANES ABOVE LANDED TOGETHER, so this is not 2070 and not 2068 — it is the
		// UNION, RE-MEASURED after the cherry-pick rather than added up. 2062 (base) + 8 (this
		// branch) + 6 (the +error.svelte lane) happens to equal it, but the arithmetic is the
		// check, never the source: a key that COLLIDED between the two lanes would make the sum
		// right and the catalog wrong. All 8 catalogs were verified to hold ONE identical key set
		// at this count.
		//   python3 -c "import json;print(len(json.load(open('messages/en.json'))))"  → 2076
		//
		// …AND +4, the production-hardening lane: `error_rate_limited{,_retry}` and
		// `error_request_body_too_large{,_limit}`. The backend gained an HTTP rate limiter (429
		// `rate_limited`) and a request body cap (413 `request_body_too_large`), and NEITHER status
		// had a branch in error-message.ts at all — both fell through to each caller's generic
		// string in all 8 locales. Two keys per code because the `details` bag only reaches that
		// module via the four ApiError copies that lift it, so the figure-less variant covers the
		// copilot stream and a mid-rollout pod that sends none.
		// RECOUNTED after the change, not added by hand — and re-verified that all 8 catalogs hold
		// ONE identical key set at this count, which is the assertion the arithmetic cannot make:
		//   for l in ar de en es fr he nl pl; do python3 -c "import json;print(len(json.load(open('messages/$l.json'))))"; done
		//   → 2080 for every locale
		//
		// 2080 → 2081: `error_last_member`, the refusal minted at routes/tenant-users.ts:486 when a
		// super_admin move would leave the source workspace with no live members at all. RECOUNTED
		// with the command above after the catalogs were edited, not incremented by hand — all eight
		// report 2081, which is the part the arithmetic cannot tell you and the reason this pin is an
		// exact count rather than a floor. ⚠️ `catalogs.test.ts` will NOT catch a mistake here: it
		// asserts the eight locales hold the SAME key set, so eight catalogs that moved together stay
		// green while this absolute count goes stale. That is exactly how this line was missed — the
		// parity test was run locally and passed; this one is the only thing that pins the number.
		//
		// 2081 → 2084: the three keys the per-member licensing change adds (migration 0089) —
		// `error_license_seat_required` (402 `license_seat_required`, the workspace is licensed but
		// THIS caller has no seat), `error_license_subject_mismatch` (403, the presented token belongs
		// to a different member) and `license_blocked_heading_seat` (the block screen's heading, which
		// must not say "expired" and must not offer Renew). RECOUNTED with the command above after the
		// catalogs were edited, never incremented: all eight report 2084.
		// ⚠️ An earlier reading of 2083 was taken MID-EDIT, with two of the three keys landed. It was
		// arithmetically plausible and wrong, which is precisely why this protocol says recount.
		//
		// 2084 → 2085: `tenant_offboard_seats_pending` — a tenant offboard whose member licence
		// revokes failed (the seats are still billed until the reconciler retries). RECOUNTED in all
		// eight catalogs after the edit, not incremented.
		//
		// 2085 → 2089: the four keys round 2 of the CommonPractice billing work adds —
		// `error_llm_byo_key_required` (403: a byo_required tenant with no key of its own, which used
		// to be an unlabelled 500 no copy could reach), `error_llm_key_probe_failed` (the provider
		// rejected a key on save), `error_platform_account_adoption_refused` (409: the invited email
		// belongs to a platform account, refused rather than demoted) and `blockerr_llm_seat_required`
		// (the block-run rule for a member with no seat). RECOUNTED in all eight catalogs after the
		// edit — `python3 -c "import json;print(len(json.load(open(f))))"` reports 2089 for every one —
		// never incremented from the previous number.
		//
		// 2089 → 2108: the NINETEEN keys the /usage Billing section adds — the panel that finally
		// renders what the customer is CHARGED (platform fee + seats + BYO markup, from
		// billing-service) next to what CP's own ledger ESTIMATES the provider cost to be. Fourteen
		// are the panel itself (`billing_section_*`, `billing_loading`, `billing_unknown_*` ×3,
		// `billing_preview_*` ×2, `billing_total`, `billing_line_*` ×2, `billing_invoices_*` ×2,
		// `billing_invoice_issued`), three are billing's own invoice status words
		// (`billing_invoice_status_{paid,open,void}` — an unrecognised status falls through to
		// billing's raw string rather than to a key), and two relabel the EXISTING per-member figure
		// as the estimate it always was (`billing_estimate_col_spend`, `billing_estimate_note`).
		// ⚠️ The two relabel keys are spelled `billing_*` rather than `admin_usage_*` ON PURPOSE:
		// the whole `billing_`/`invoice_` namespace was measured EMPTY before minting, so all
		// nineteen are collision-free by construction. `admin_usage_col_spend` is left in place and
		// was not renamed or deleted, so it contributes no delta.
		//
		// Re-measured 2026-10-12 (CP-owned tenancy: invite/no-workspace keys added, the budget-on-create,
		// send-email, rolesUnavailable, Keycloak-partial-offboard and email_exists keys removed; then
		// `error_tenant_not_active` + `error_user_changed` for the new 409 codes), all
		// eight catalogs counted with the command below and all report the same number:
		//   for l in ar de en es fr he nl pl; do python3 -c "import json;print(len(json.load(open('messages/$l.json'))))"; done
		// Re-measured 2026-10-12 (A2 licence control, backend half): +10 error keys for the licence
		// editor / plan catalogue codes, −4 adopt-path keys whose codes the backend no longer emits
		// → 2164 in all eight catalogs.
		// Re-measured 2026-10-12 (A2 licence control, frontend half): +83 keys for the create form's
		// plan/dates, the per-tenant licence editor, the Plans page + nav entry and the
		// `keycloak_actions` invite outcome; −4 `admin_tenants_adopt_*` (the adopt prompt is gone)
		// → 2243 in all eight catalogs.
		// Re-measured 2026-10-12 (A2 review): +1 `admin_tenants_created_invite_error` — the create
		// form's warning when the first-admin invite failed (`inviteError`) → 2244 in all eight.
		// Re-measured 2026-10-13: +1 `error_licence_busy` (409 from the per-tenant licence lease)
		// → 2245 in all eight.
		// Re-measured 2026-10-13: +1 `error_system_tenant` (409: the nil-UUID seed tenant is not edited)
		// → 2246 in all eight.
		// Re-measured 2026-10-13 (tenant edit page): +35 keys — the compact list's columns, the
		// "System workspace" label, the /tenants/<id> page's sections, and the plain-language help
		// under every create/edit field (one per BYO posture) → 2281 in all eight.
		// Re-measured 2026-10-13 (platform_only honoured in CP): +2 — `error_llm_byo_disabled` (403:
		// a platform_only workspace tried to save its own key) and `llmset_byo_locked` (why the LLM
		// settings key field is switched off) → 2283 in all eight, RECOUNTED per catalog.
		// Re-measured 2026-10-13 (offboarded tenant is read-only): +1 `admin_tenant_offboarded_note`
		// ("Offboarded on {date} — read-only") → 2333 in all eight, RECOUNTED per catalog.
		// Re-measured 2026-10-13 (invitee names): +5 — the first admin's first/last name labels and the
		// "both names" refusal on the create form, and the members form's first/last name labels
		// (the realm requires both; without them Keycloak stops a new invitee at its profile form)
		// → 2338 in all eight, RECOUNTED per catalog.
		// Re-measured 2026-10-13 (workspace setup record): +23 — the blocked/accept "access is being set
		// up" copy (3), the create banner's billing-pending vs billing-refused sentences (2), and the
		// workspace page's Setup section: heading, hint, no-record note, 5 step names, 4 statuses,
		// Retry, the retry outcome, attempts / next-try labels and the "terms are saved" note (17)
		// Plus `error_provisioning_step_busy` (Retry while the tick holds the step's claim)
		// → 2361 in all eight, RECOUNTED per catalog.
		// Re-measured 2026-10-13 (orphaned setup steps): +1 `admin_tenant_setup_interrupted` (a step a
		// create died before finishing, which the tick does not retry) → 2362 in all eight.
		// Re-measured 2026-10-13 (invite login_hint): +2 — the mismatch screen's "This invitation is
		// for <masked address>" label and its "No password yet? Use Forgot password" line → 2364 in
		// all eight, RECOUNTED per catalog.
		// Re-measured 2026-10-13 (platform is local-only): +1 `error_llm_platform_local_only` (403: a
		// commercial model on a credential that is not the tenant's own key) → 2365 in all eight,
		// RECOUNTED per catalog.
		// Re-measured 2026-10-13 (run refusal rules): +2 — `blockerr_llm_platform_local_only` and
		// `blockerr_llm_byo_key_required`, the block-run rules for the two spend-posture refusals the
		// broker now returns as values (same sentences as the `error_llm_*` API codes) → 2367 in all
		// eight, RECOUNTED per catalog.
		// Re-measured 2026-10-13 (invite superseded): +1 `error_invite_superseded` (409: resending an
		// expired invite while a newer one for the address is pending) → 2368 in all eight, RECOUNTED.
		// Re-measured 2026-10-14 (licences bundles, backend 0104): +9 — the create form's bundle chips
		// (`admin_tenants_bundles_{label,help,placeholder,add,remove,invalid,too_many,failed}`) and the
		// setup step label `admin_tenant_setup_step_licence_bundles` → 2377 in all eight, RECOUNTED.
		// Re-measured 2026-10-14 (early-access signup): +16 — the onboarding deep-link dialog and
		// signup facts (`admin_onboarding_{company,source,source_web,source_chat,source_app,
		// tenant_name_suggested,focus_approve_title,focus_reject_title,focus_hint,focus_missing,
		// confirm_approve,confirm_reject,focus_cancel}`) and three 403 codes
		// (`error_{signup_intake_forbidden,turnstile_required,turnstile_failed}`) → 2393 in all eight,
		// RECOUNTED per catalog. Re-measured 2026-10-14 (offboard guard): +1 `error_demo_tenant` → 2394
		// in all eight, RECOUNTED. Re-measured 2026-10-14 (copy style pass): −1 `docs_quote`, a
		// fabricated testimonial, deleted → 2393 in all eight, RECOUNTED. Re-measured 2026-10-14 (W2 nav
		// + W4 home): +19 (`nav_group_library`, `nav_settings`, `settings_{title,group_organisation,
		// group_platform}`, `home_steps_title`, `home_step_{report,prioritise,build,practice}_{title,body}`,
		// `home_next_{label,vote,continue,build,results}`) and −7 now-unused (`home_hero_{eyebrow,browse}`,
		// `home_stat_active_builders{,_sub}`, `home_stat_{active_challenges,solutions_in_voting,
		// live_in_production}_sub`) → 2405 in all eight, RECOUNTED. Merged with W1 builder layout: +10 —
		// `shell_sidebar_{collapse,expand}`, `build_{more_actions,palette_show,palette_hide,side_show,
		// side_hide,tab_details,run_log,narrow_note}` — and W6 builder for non-technical users: +21 —
		// `build_{example_data,show_field_types,field_required,result,result_idle,result_idle_empty,
		// result_details,result_ok,result_partial,result_failed,step_running,step_done,step_failed,
		// step_skipped,start_title,start_challenge,start_challenge_sub,start_template,start_template_sub,
		// start_assistant,start_assistant_sub}` → 2436 in all eight, RECOUNTED from the merged en.json.
		// Re-measured 2026-10-14 (UX fix lane): −1 orphan `console_ready` (zero references), +1
		// `settings_path_llm` (the Settings → Organisation → LLM settings path) → 2436 in all eight,
		// RECOUNTED from en.json after both edits — the same total, by coincidence, not by omission.
		// Then +1 `build_flow_picker_aria` (the flow picker had no accessible name, and a narrow
		// toolbar now repeats it inside ⋯) → 2437 in all eight, RECOUNTED.
		// Re-measured 2026-10-14 (voting-cycle cadence): +13 (`policy_group_marketplace`,
		// `policy_{label,desc}_cycle_cadence`, `policy_option_cadence_{off,week,month,year}`,
		// `cadence_title_{month,year}`, `cadence_bar_{voting,building}`, `winner_cycle_off_{title,text}`)
		// → 2450 in all eight, RECOUNTED.
		// …and +1: `cadence_waiting` (month/year cadence, period not opened yet) → 2451 in all eight,
		// RECOUNTED.
		// …and +3: `challenge_period_week`, `challenge_vote_note_earlier_period`,
		// `challenge_build_blocked_period` (the period badge/notes render by kind) → 2454, RECOUNTED.
		// Then −3 now-unrendered week-only keys (`challenge_week_badge`,
		// `challenge_{vote_note_earlier,build_blocked}_week`, zero references) → 2451, RECOUNTED.
		// Then +1 `error_cycle_busy` (409 when a cadence change meets the running cycle tick) → 2452 in
		// all eight, RECOUNTED.
		// Then the 2026-10-14 browser-walk round: +4 (`governance_enforcement_scheduled{,_note}`,
		// `governance_cadence_effective_from`, `mkt_cadence_closes_at`) −2 (the false "Closes 18:00"
		// `mkt_cadence_{mon,thu}_s`) → 2454 in all eight, RECOUNTED.
		// Then +1 `build_submit_short` (Submit's label in a very narrow builder toolbar) → 2455 in all
		// eight, RECOUNTED.
		// Re-measured 2026-10-14 (flow templates): +31 — the template gallery (`build_tpl_*` ×13), the
		// New-flow choice (`build_new_{choice_title,blank,blank_sub,from_template,from_template_sub}`),
		// the save dialog (`build_save_template{,_name,_desc,_hint,_save,_saving,_done}`),
		// `solution_use_as_start{,_busy}` and four refusals (`error_flow_template_{empty,tenant_blocks,
		// tenant_blocks_generic}`, `error_solution_no_flow`) → 2486 in all eight, RECOUNTED
		// (2455 after #448 + 31).
		// Re-measured 2026-10-14 (quarter period kind): +3 (`policy_option_cadence_quarter`,
		// `cadence_title_quarter`, `challenge_period_quarter`) → 2489 in all eight (after the merged base), RECOUNTED.
		// W7 tenant voting schedule: +14 (`nav_voting_schedule`, 11 `vschedule_*`,
		// `error_scope_switch_unsupported`, `error_tenant_id_not_accepted`) → 2503 in all eight, RECOUNTED.
		// W8 (members-information), rebased onto the W7 base (2503), each step RECOUNTED in all eight:
		// W8/P7: +1 `dataset_preview_masked` (the "Hidden personal data" tooltip) → 2504.
		// W8/P1: +3 `challenge_info_{title,none,load_failed}` ("Information involved") → 2507.
		// W8/P2: +7 `challenge_info_{help,search,no_match,options_empty,options_failed,remove,save}`
		// (the picker) + `error_information_not_found` (its 400) → 2515.
		// W8/P3: +5 `submit_info_{suggest,suggesting,suggested,add,no_suggestions}` → 2520.
		// W8/P4: +16 `build_sample_*` ("Test with this challenge's sample data" + its plain-words
		// findings) → 2536.
		// W8/P5: +20 `challenge_request_*` (the member side), +13 `requests_*` + `requests_denied` + `nav_requests` (the
		// queue), +2 `error_request_{not_found,not_pending}` → 2573.
		// W8 upload limits: +2 `error_information_request_limit_{pending,daily}` (429
		// `information_request_limit`) → 2575.
		// W8 sample-test verdict: +1 `build_sample_failed` (the run's failure, never the success line) → 2576.
		// Builder polish 2: +1 `build_starting_env`, +1 `nodecfg_value_ph`, +16 `nodecfg_opt_*` (enum
		// option labels) → 2594.
		// Member walk: +1 `build_result_internal_error`, +1 `build_data_node_no_dataset`,
		// +1 `nodecfg_ontology_none_member`, −1 `brand_sub` (the stale "Leaderboards" logo subtitle) → 2596.
		// +1 `build_result_idle_timeout` (the host idle watchdog, in plain words) → 2597.
		// Plain result panel: +5 `build_output_*` (row count, cut row count, hidden columns, yes, no) → 2602.
		// +1 `build_output_rows_cut` (a rows array the 2048-char cut emptied) → 2603.
		// +3 `datasets_col_not_personal`, `datasets_col_suggested_not_personal`,
		// `datasets_mark_suggested_not_personal` (schema editor: not-personal mark + suggestions) → 2606.
		// +2 `nav_early_access`, `nav_feedback` (shell badge + SUPPORT_EMAIL link) → 2608.
		// +1 `footer_early_access` (the shell footer link to the public /early-access notice) → 2609.
		// +1 `chat_turn_incomplete` (the assistant's localized out-of-budget notice) → 2610.
		// +1 `submit_field_domain_placeholder` (/submit no longer preselects a work area) → 2611.
		// +2 `chat_tool_checked_flow`, `chat_tool_used` (activity line no longer calls a flow check a catalogue search) → 2613.
		// +1 `admin_onboarding_message` (the applicant's early-access message on /onboarding) → 2614.
		// +1 `invite_accept_setting_up` (the accept page's only screen while it works) → 2615, RECOUNTED.
		// +6 `admin_onboarding_ea_{title,hint,name,company,btn,done}` (the /onboarding "Invite to early
		// access" form) → 2621, RECOUNTED from en.json.
		// +1 `admin_onboarding_source_invite` (the queue's label for a pre-approved invite row) → 2622.
		// Early-access v2: +3 `admin_tenant_setup_step_{member_seat,member_licence,invite_email}` (the
		// approve path's new setup steps), +1 `admin_onboarding_invite_deferred` (seated; the email
		// follows the licence), +1 `admin_onboarding_ea_locale` (the invite form's email language)
		// → 2627; +1 `error_signup_decider_forbidden` (403 of the Telegram decision door) → 2628,
		// RECOUNTED from en.json. +1 `error_identity_disabled` (409: the invitee's realm account is
		// disabled, not by a CP signup reject) → 2629, RECOUNTED from en.json. +6
		// `admin_onboarding_repair_{title,hint,pending,blocked,retry,done}` (rejected signups whose
		// cleanup is not finished, with a Retry) → 2635, RECOUNTED from en.json. +2
		// `admin_onboarding_repair_{in_progress,failed}` (a Retry still under way; a cleanup the
		// automatic retries gave up on) → 2637, RECOUNTED from en.json. +16
		// `admin_onboarding_repair_{resolve,resolve_note,resolve_confirm,resolve_cancel,resolved}` +
		// `admin_onboarding_repair_code_*` (10 backend REJECT_REPAIR_ERROR_CODES + `unknown`): Resolve
		// manually with a note, and guidance per error code → 2653, RECOUNTED from en.json. +2
		// `admin_onboarding_repair_resolve_live_{warning,ack}` (a resolve that leaves the requester's
		// access live names it and needs a confirmation) → 2655, RECOUNTED from en.json. +7
		// `tenant_act_as_refused`, `shell_act_as_dropped`, `act_as_reason_{licence,suspended,offboarded,
		// not_provisioned,other}` (Act-as refused up front / a refused selection announced, never a
		// silent drop) → 2662, RECOUNTED from en.json.
		expect(Object.keys(cats.en!)).toHaveLength(2662);
		expect([...placeholders(cats.en!.data_finding_type_mismatch!)].sort()).toEqual([
			'attribute',
			'column',
			'countNum',
			'expected'
		]);
		expect([...placeholders(cats.nl!.home_activity_showing_of!)].sort()).toEqual(['shown', 'total']);
		const parameterised = Object.values(cats.en!).filter((e) => placeholders(e).size > 0);
		expect(parameterised.length).toBeGreaterThan(150);
	});

	for (const locale of LOCALES.filter((l) => l !== 'en')) {
		it(`${locale}.json matches en.json parameter for parameter`, () => {
			const drift: string[] = [];
			for (const key of Object.keys(cats.en!)) {
				const entry = cats[locale]![key];
				if (entry === undefined) continue; // a missing KEY is `catalogs.test.ts`'s failure to report
				const want = [...placeholders(cats.en![key]!)].sort();
				const got = [...placeholders(entry)].sort();
				if (want.join(',') !== got.join(',')) drift.push(`${key}: en=[${want}] ${locale}=[${got}]`);
			}
			expect(
				drift,
				drift.length
					? `${locale}.json drops or invents message parameters. A pattern that stops ` +
							`interpolating one renders an EMPTY slot for that reader while every other locale ` +
							`names it — and neither svelte-check nor any other test in this repo can see it:\n  ` +
							drift.join('\n  ')
					: undefined
			).toEqual([]);
		});
	}

	// The declaration half. Paraglide builds a message's call signature from `declarations`, so a
	// locale that declares a different set is a locale that compiles to a different function — and
	// the base catalog is not necessarily the one that wins at the call site.
	it('variant messages declare the same inputs in every locale', () => {
		const drift: string[] = [];
		for (const key of Object.keys(cats.en!)) {
			const base = cats.en![key]!;
			if (typeof base === 'string') continue;
			const want = [...(base[0]?.declarations ?? [])].sort().join('|');
			for (const locale of LOCALES) {
				const entry = cats[locale]![key];
				if (entry === undefined || typeof entry === 'string') {
					drift.push(`${key}: ${locale} is a plain string where en is a variant message`);
					continue;
				}
				const got = [...(entry[0]?.declarations ?? [])].sort().join('|');
				if (got !== want) drift.push(`${key}: en declares [${want}], ${locale} declares [${got}]`);
			}
		}
		expect(drift, drift.length ? drift.join('\n  ') : undefined).toEqual([]);
	});
});
