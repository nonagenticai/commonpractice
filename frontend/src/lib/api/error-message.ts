// src/lib/api/error-message.ts — map license (402) / permission (403) / seat-cap (409) failures
// to a friendly, localized, actionable message. Both `ApiError` (admin/marketplace clients,
// carries status+code) and `AgentApiError` (the agent stream, status+optional code) expose
// `status`; the license/Gate-2 codes come from the backend body (`error` field).
//
// The backend already emits a stable, machine-readable snake_case code on EVERY 402/403 — one
// serializer (backend/src/utils/http.ts, mirrored in server.ts) writes `{ error: err.code,
// message: err.message, … }`, and `forbidden(code, message)` takes the code first. Every typed
// client lifts it into `ApiError.code`. So localizing a permission failure is purely a lookup
// on that code; nothing on the wire needs to change.
//
// Returns `null` when the error is NOT a recognised license/permission failure, so callers
// keep their own context-specific fallback (e.g. `m.chat_error_generic()`). That null contract
// is load-bearing: 400/422/500 domain errors must stay in the hands of the screen that raised
// them, not be flattened into a generic sentence here.
import * as m from '$lib/paraglide/messages';
import { llmSettingsPath } from '$lib/i18n/llm-settings-path';
import { getLocale } from '$lib/paraglide/runtime';
import { decimal1, num } from '$lib/utils/format';
// ⛔ THE DELIVERY SENTENCES LIVE THERE, NOT HERE, AND THAT IS NOT THE `delivery_already_live`
// EXCEPTION RE-OPENED. That entry's comment argues a single top-level refusal keyed by a wire code
// belongs in this map rather than in a label module — and it still does. These five are the case it
// does not cover: the SAME codes, off the SAME precheck, already render on the `/solutions/[id]`
// delivery-ledger column through `deliveryErrorLabel`. A copy here would be two sets of sentences
// for one wire field that can and would drift apart; importing the switch means the ledger and the
// refusal cannot disagree by construction. See that module's `deliveryRefusalCopy`.
import { deliveryRefusalLabel } from '$lib/i18n/delivery-error-label';

function statusOf(err: unknown): number | undefined {
	return typeof (err as { status?: unknown })?.status === 'number'
		? (err as { status: number }).status
		: undefined;
}

function codeOf(err: unknown): string | undefined {
	return typeof (err as { code?: unknown })?.code === 'string'
		? (err as { code: string }).code
		: undefined;
}

/**
 * Every 403 code the backend can emit, as of this commit. Kept as a literal union (rather than
 * `string`) so that adding a code to `FORBIDDEN_MESSAGES` without adding it here — or misspelling
 * one — is a COMPILE error instead of a silent fallthrough to the generic "Forbidden".
 *
 * Sources (backend): middleware/admin-guards.ts, middleware/license-gate.ts,
 * middleware/tenant-status-gate.ts, middleware/fr-feedback-auth.ts, services/user-service.ts,
 * blocks/authoring-service.ts, routes/{flows,ontology,challenges,connectors}.ts, ai/mcp/tools.ts.
 *
 * NOTE: `HttpError.code` is a bare `string` backend-side, so this union is a convention, not an
 * enforced contract — renaming a code there degrades the frontend to the generic message with no
 * build failure. A shared literal-union package is the real long-term fix.
 */
export type ForbiddenCode =
	| 'license_app_mismatch'
	| 'license_tenant_mismatch'
	| 'license_subject_mismatch'
	| 'developer_required'
	| 'tenant_id_claim_required'
	| 'super_admin_required'
	| 'admin_required'
	| 'tenant_not_provisioned'
	| 'tenant_suspended'
	| 'tenant_admin_required'
	| 'tenant_scope_mismatch'
	| 'fr_feedback_forbidden'
	| 'data_manager_required'
	| 'ontology_manager_required'
	| 'flow_not_owner'
	| 'foreign_bucket'
	| 'self_vote_not_allowed'
	| 'self_review_not_allowed'
	| 'user_offboarded'
	| 'llm_byo_key_required'
	| 'llm_byo_disabled'
	| 'llm_platform_local_only'
	| 'no_workspace'
	| 'invite_email_mismatch'
	| 'email_not_verified'
	| 'app_not_allowed'
	| 'signup_intake_forbidden'
	| 'signup_decider_forbidden'
	| 'turnstile_required'
	| 'turnstile_failed'
	| 'scope_switch_unsupported'
	| 'forbidden';

/**
 * 403 code → localized copy. Each entry answers "what do I do about it?", which the bare
 * `error_forbidden()` ("You don't have permission to do that.") never could: a member who cannot
 * edit the ontology needs to be told to ask for the Developer role, not that a door is shut.
 *
 * `Record<ForbiddenCode, …>` is exhaustive by construction — a new union member without a message
 * fails `bun run check`.
 */
const FORBIDDEN_MESSAGES: Record<ForbiddenCode, () => string> = {
	// Gate-2 licence checks that land on 403 rather than 402 (the licence exists but is the wrong
	// one). The global 402 interceptor in auth-fetch.ts does NOT catch these.
	license_app_mismatch: () => m.error_license_app_mismatch(),
	license_tenant_mismatch: () => m.error_license_tenant_mismatch(),
	// The third member of that family: the token verifies but its subject is not this member. A
	// misconfiguration or a stale token, NOT a commercial state and NOT `license_seat_required` —
	// the reader may well hold a seat. So it is a 403, it stays OUT of `LICENSE_BLOCK_CODES` with
	// its two siblings (one bad token must never raise the whole-app renewal wall), and the copy
	// mentions neither seats nor billing.
	license_subject_mismatch: () => m.error_license_subject_mismatch(),
	// Role gates.
	developer_required: () => m.error_developer_required(),
	super_admin_required: () => m.error_super_admin_required(),
	admin_required: () => m.error_admin_required(),
	tenant_admin_required: () => m.error_tenant_admin_required(),
	data_manager_required: () => m.error_data_manager_required(),
	ontology_manager_required: () => m.error_ontology_manager_required(),
	// Tenancy / provisioning gates — the user chose nothing and can fix nothing, so the copy has
	// to point at the administrator who can.
	tenant_id_claim_required: () => m.error_tenant_id_claim_required(),
	// CP has not seated this person in any workspace. The root layout swaps to NoWorkspace.svelte
	// on this code; this is the one-line form for a catch block that renders it inline.
	no_workspace: () => m.error_no_workspace(),
	// POST /api/invites/accept — the invite was addressed to a different (or unverified) email.
	invite_email_mismatch: () => m.error_invite_email_mismatch(),
	email_not_verified: () => m.error_email_not_verified(),
	// routes/platform-plans.ts: the plan catalogue is pinned to this deployment's app; a request
	// naming another app is refused. The Plans page never sends one — a hand-built call does.
	app_not_allowed: () => m.error_app_not_allowed(),
	tenant_not_provisioned: () => m.error_tenant_not_provisioned(),
	tenant_scope_mismatch: () => m.error_tenant_scope_mismatch(),
	// ⛔ A PLATFORM OPERATOR SUSPENDED THE WHOLE WORKSPACE — backend/src/middleware/tenant-status-gate.ts.
	// NOT a role gate and NOT `tenant_not_provisioned`: the reader's account, role and licence are all
	// fine and nothing they do on any screen will change the answer, so the copy names the ONE person
	// who can undo it. Without an entry here it degrades to `error_forbidden()` ("You don't have
	// permission to do that."), which on a suspended workspace is both false and unactionable — the
	// reader would go hunting for a missing role that was never the reason.
	//
	// ⚠️ THE FULL-SCREEN COPY IS A DIFFERENT SET OF KEYS (`workspace_suspended_*`) AND THAT IS NOT A
	// DUPLICATE. This is the one-line refusal a catch block renders inline; those are the heading,
	// body and two buttons of the block screen the gate raises. One sentence cannot be both.
	tenant_suspended: () => m.error_tenant_suspended(),
	user_offboarded: () => m.error_user_offboarded(),
	// Ownership + service-to-service.
	flow_not_owner: () => m.error_flow_not_owner(),
	foreign_bucket: () => m.error_foreign_bucket(),
	self_vote_not_allowed: () => m.error_self_vote_not_allowed(),
	// The pipeline sibling of self_vote_not_allowed (routes/pipeline.ts, migration 0062): an admin
	// may not approve their own card — "two reviewers approved this" means nothing if one of them
	// wrote the code.
	self_review_not_allowed: () => m.error_self_review_not_allowed(),
	fr_feedback_forbidden: () => m.error_fr_feedback_forbidden(),
	// ⛔ THE WORKSPACE MUST BRING ITS OWN LLM KEY AND HAS NOT — backend/src/services/byo-posture.ts
	// (`TenantByoKeyRequiredError`, code `llm_byo_key_required`). A `byo_required` tenant pays the
	// provider directly and is invoiced only a markup, so every path that would quietly fall back to
	// the PLATFORM's credential is a hard refuse. Until this entry existed the error was not even a
	// 403: it was a plain `Error`, so `route()` answered an unlabelled 500, `licenseOrPermissionMessage`
	// returned `null` for it, and the reader met their screen's own "could not load" in all eight
	// locales — never the one gesture that repairs it.
	//
	// ⚠️ NOT A ROLE GATE AND NOT A LICENCE GATE, which is why the copy names neither a missing
	// permission nor billing. The reader's roles are fine and the workspace licence is fine; what is
	// missing is a provider key on the LLM settings screen. The audience is very often a tenant_admin
	// who can fix it in the next thirty seconds, so the sentence points them there — the same
	// "accurate block beats an accusation-shaped default" argument `license_seat_required` makes.
	llm_byo_key_required: () => m.error_llm_byo_key_required({ path: llmSettingsPath() }),
	// The mirror image (services/byo-posture.ts `TenantByoDisabledError`): a `platform_only`
	// (demo/trial) workspace tried to SAVE a provider key of its own on LLM settings. Bringing your
	// own key is switched off for it, so the key was not stored.
	llm_byo_disabled: () => m.error_llm_byo_disabled(),
	// services/byo-posture.ts `PlatformLocalOnlyError`: the call would have reached a commercial model
	// on a credential that is not the tenant's own key. The platform never pays for a commercial model,
	// so the repair is the same gesture as llm_byo_key_required: add your own key on LLM settings.
	llm_platform_local_only: () => m.error_llm_platform_local_only({ path: llmSettingsPath() }),
	// Early-access signup (backend/src/middleware/signup-intake-auth.ts, services/turnstile.ts). The
	// intake code reaches a SERVICE caller, not a person; the two Turnstile codes reach a person only
	// through a public sign-up form, which the website renders — the SPA's own notify-self is never
	// asked for a challenge. Catalogued because the 403 contract has no "unreachable" register.
	signup_intake_forbidden: () => m.error_signup_intake_forbidden(),
	// The Telegram decision door (middleware/signup-decider-auth.ts): reaches chat-bridge's service
	// account only, never a person. Catalogued for the same reason as the intake code above.
	signup_decider_forbidden: () => m.error_signup_decider_forbidden(),
	turnstile_required: () => m.error_turnstile_required(),
	turnstile_failed: () => m.error_turnstile_failed(),
	// routes/tenant-cycle-cadence.ts: the voting schedule is set by the workspace's OWN admin. A
	// super_admin acting into another workspace (X-Active-Tenant-Id) is refused, not redirected.
	scope_switch_unsupported: () => m.error_scope_switch_unsupported(),
	// The backend's own catch-all code (routes/challenges.ts) — same copy as an unknown code.
	forbidden: () => m.error_forbidden()
};

/**
 * Runtime mirror of the `ForbiddenCode` union, for code that needs to enumerate it — the union
 * itself is erased at compile time. Built by `Object.keys` over the exhaustive `FORBIDDEN_MESSAGES`
 * record, so it can never drift from the union/message-map by construction.
 *
 * Consumed by `error-message.backend-contract.test.ts`, which walks `backend/src` for every
 * `forbidden(...)` / `new HttpError(403, ...)` code the backend can actually emit and asserts each
 * one is a member of this array — the guard against the "renamed code silently degrades to the
 * generic message" failure mode documented on `ForbiddenCode` above.
 */
export const KNOWN_FORBIDDEN_CODES: readonly ForbiddenCode[] = Object.keys(
	FORBIDDEN_MESSAGES
) as ForbiddenCode[];

/**
 * Every 402 code the backend can emit that has its OWN copy, as a literal union — same reasoning as
 * `ForbiddenCode`: adding a message without adding the code here is a COMPILE error.
 *
 * `license_required` is deliberately ABSENT: it is the documented `default`, and every unrecognised
 * 402 renders as it. See `KNOWN_LICENSE_CODES`.
 */
export type LicenseCode =
	| 'license_inactive'
	| 'license_expired'
	| 'license_unavailable'
	| 'license_unreadable'
	| 'license_seat_required';

/**
 * 402 code → localized copy. A RECORD rather than a `switch`, for one reason: it can be mirrored at
 * runtime, and `error-message.backend-contract.test.ts` diffs that mirror against every
 * `paymentRequired(...)` code in `backend/src`. A `switch` is invisible to anything but the compiler,
 * which is why the 402 half of that contract went unguarded while the 403 half was enforced — and
 * that gap is precisely what let a backend-only `license_unreadable` look shippable.
 */
const LICENSE_MESSAGES: Record<LicenseCode, () => string> = {
	license_inactive: () => m.error_license_inactive(),
	license_expired: () => m.error_license_expired(),
	license_unavailable: () => m.error_license_unavailable(),
	// ⛔ NOT `license_unavailable`, AND NOT THE DEFAULT EITHER. The backend emits this when the
	// tenant's stored licence blob will not decrypt (middleware/license-gate.ts →
	// LicenseTokenUnreadableError). Falling through to the default would say "your workspace doesn't
	// have an active licence, contact your administrator" — the accusation #252 removed; routing it
	// to `license_unavailable` would promise "try again shortly" for a standing fault that no retry
	// clears. It needs an operator, so the copy says so.
	//
	// ⚠️ THIS HALF SHIPPED FIRST AND ALONE (#255), AND THE BACKEND EMISSION FOLLOWED ONLY ONCE THIS
	// BUNDLE WAS LIVE IN PRODUCTION. An old cached SPA meeting a new API that emits an unknown 402
	// shows NO block screen at all (the code is not in `LICENSE_BLOCK_CODES`, so the auth-fetch
	// interceptor never fires) and papers every screen with `error_license_required`. The reverse
	// window — a new bundle against the older API — was byte-identical to the behaviour it replaced,
	// so the ordering was forced. Full reasoning in `backend/src/middleware/license-gate.ts`.
	license_unreadable: () => m.error_license_unreadable(),
	// ⛔ THE WORKSPACE IS LICENSED AND THE READER IS NOT — per-member seating, so this is the ONE
	// 402 in this map that is about a PERSON rather than about the tenant. Every other sentence
	// here, and the `license_required` default above all, says "your workspace doesn't have an
	// active Common Practice license": for this code that is FALSE, and falsely actionable — it
	// sends a member to a billing screen to renew a licence that is paid, current and working for
	// their colleagues. Nothing on screen would reveal the mistake. The only repair is an
	// administrator assigning them a seat, so the copy names that person and that gesture, and
	// says "renew" nowhere. Same failure shape as `license_unreadable` and the fr connector codes
	// below: an accurate block beats an accusation-shaped default.
	license_seat_required: () => m.error_license_seat_required()
};

/**
 * Runtime mirror of every 402 code the SPA understands, INCLUDING `license_required` — which has no
 * entry above because it is what the `default` renders, and is therefore still "understood".
 *
 * Consumed by `error-message.backend-contract.test.ts`. Built from `Object.keys` so it cannot drift
 * from `LICENSE_MESSAGES`; `license_required` is appended explicitly because a default is not a key.
 */
export const KNOWN_LICENSE_CODES: readonly string[] = [
	...(Object.keys(LICENSE_MESSAGES) as LicenseCode[]),
	'license_required'
];

/**
 * The fr connector's Gate-2 402s — A DIFFERENT LICENCE FROM THE ONE ABOVE, and that is the defect.
 *
 * ⛔ WHAT WENT WRONG. `precheckTarget` (backend/src/routes/delivery.ts) runs on three paths. On the
 * Test button (`:249`) the refusal is caught and answered HTTP 200, and `i18n/connection-test-label.ts`
 * owns it. On FORWARD (`:696`) and RETRY (`:816`) it escapes as a genuine 402 and lands here — where
 * the code was unknown, so `licenseOrPermissionMessage` returned its documented default:
 * `m.error_license_required()`, "Your workspace doesn't have an active Common Practice license."
 *
 * That is not an untranslated sentence, it is a FALSE one. The reader's workspace licence is fine;
 * a delivery connector's stored fr token is not. It sends a tenant_admin to the billing screen to
 * fix something that is not broken, and unlike English-instead-of-Dutch there is nothing on screen
 * to reveal the mistake. Consulted BEFORE `LICENSE_MESSAGES` so the connector's answer wins.
 *
 * ⚠️ DELIBERATELY NOT IN `KNOWN_LICENSE_CODES` NOR IN `LICENSE_BLOCK_CODES`. Those two describe the
 * WORKSPACE's Common Practice entitlement — block set membership raises the whole-app renewal wall
 * (`stores/licenseGate.svelte.ts:55-72`). One misconfigured connector must never take a paying
 * workspace offline. Same category as `license_app_mismatch`/`license_tenant_mismatch`, which are
 * 403 for exactly this reason (`licenseGate.svelte.ts:50-53`). Pinned in
 * `fr-license-codes.guard.test.ts`, with the consequence spelled out beside the assertion.
 */
const FR_LICENSE_MESSAGES: Record<string, () => string> = {
	fr_license_inactive: () => m.fr_license_inactive(),
	fr_license_app_mismatch: () => m.fr_license_app_mismatch(),
	fr_license_tenant_mismatch: () => m.fr_license_tenant_mismatch(),
	fr_license_unavailable: () => m.fr_license_unavailable()
};

/**
 * The 503 codes the SPA has COPY for — today exactly ONE (`tenant_status_unavailable`), and it is a
 * map rather than an `if` because a second one is coming the moment another gate learns to fail
 * closed. Nothing derives this figure — `KNOWN_SERVICE_UNAVAILABLE_CODES` is `Object.keys` of the
 * map — so re-count it here rather than incrementing a remembered number.
 *
 * ⚠️ ONE IS NOT THE NUMBER OF 503 CODES THE BACKEND EMITS — THERE ARE NOW THREE, re-counted by
 * scraping `backend/src` rather than incremented from the "TWO" this line used to say.
 * `signup_queue_full` (routes/onboarding.ts:198) and `signup_queue_anonymous_full`
 * (routes/onboarding.ts:192) are the other two — the total cap on the self-signup queue and the
 * anonymous sub-quota that reserves headroom inside it — and BOTH are deliberately NOT here: the
 * only SPA caller swallows them fire-and-forget, and cannot provoke the second one at all. They are
 * registered in `NOT_LOCALIZED_CODES` with those measurements instead, which is the second home the
 * 503 contract test accepts. See those entries before adding a sentence here for either.
 *
 * ⛔ 503 IS A STATUS CLASS THIS MODULE HAD NO BRANCH FOR AT ALL, AND THAT IS THE DEFECT.
 * `licenseOrPermissionMessage` answered 402/403/409-seat-cap and returned `null` for everything
 * else, so a 503 landed on the CALLER'S generic fallback ("Kon niet laden") — which is not wrong,
 * merely empty: it tells a reader whose workspace status could not be READ that something failed,
 * never that the failure is transient and a retry is the whole repair. `tenant-status-gate.ts`
 * fails CLOSED on an unreadable status (the safe choice), so this is the sentence an ordinary
 * member meets during a database blip, on every screen at once.
 *
 * ⚠️ DELIBERATELY NARROW: any OTHER 503 still returns `null` and keeps the caller's fallback. A
 * blanket "the service is unavailable" for every 5xx would flatten the one case we can name into
 * the many we cannot, which is the accusation-shaped failure `license_unreadable` documents above.
 */
const SERVICE_UNAVAILABLE_MESSAGES: Record<string, () => string> = {
	// backend/src/middleware/tenant-status-gate.ts — the fail-closed arm: the workspace's status row
	// could not be read, so the gate refuses rather than guessing "active". "Try again shortly" is
	// TRUE here and would be a false promise on `tenant_suspended` (403), which no retry clears —
	// the two sentences are split for exactly the reason `license_unavailable` and
	// `license_unreadable` are.
	tenant_status_unavailable: () => m.error_tenant_status_unavailable(),
	// backend/src/services/tenant-inference.ts — a `local-llm` workspace whose own inference-router
	// credential has not been provisioned (or will not decrypt). Its LLM calls are refused rather than
	// sent unattributed; a platform admin re-saves the plan to provision it. Reached from every LLM
	// surface (copilot, runs) through `writeErrorText`.
	llm_inference_not_provisioned: () => m.error_llm_inference_not_provisioned()
	// ⛔ `signup_queue_full` (backend/src/routes/onboarding.ts:198) IS DELIBERATELY ABSENT, AND IT WAS
	// BRIEFLY HERE. Eight locales of copy were written for it and then reverted: no reader can reach
	// the sentence, so it was copy nothing renders. The measurement is in `NOT_LOCALIZED_CODES`.
	// "The sentence already exists for the day someone surfaces it" is not a reason to catalogue —
	// this map's entries are claims that a reader meets the refusal, and an entry nothing can render
	// is the false-coverage claim the register exists to prevent, wearing the fix's clothes.
};

/**
 * Named 502 codes with copy. `licences_unavailable`: POST /api/tenants could not reach the licences
 * service, and the create was refused before anything was written in CP.
 */
const BAD_GATEWAY_MESSAGES: Record<string, () => string> = {
	licences_unavailable: () => m.error_licences_unavailable()
};

/**
 * Runtime mirror of every 503 code the SPA has copy for — `Object.keys` over the map above, exactly
 * as `KNOWN_FORBIDDEN_CODES` and `KNOWN_LICENSE_CODES` are built, so it cannot drift from the copy
 * it claims to mirror.
 *
 * ⛔ IT EXISTS ONLY SO THE GUARD CAN READ IT, AND THAT IS THE WHOLE REASON. Until this export,
 * `error-message.backend-contract.test.ts` scraped `forbidden(` / `paymentRequired(` / `badRequest(`
 * / `unprocessable(` / `conflict(` and NOT `serviceUnavailable(` — so `tenant_status_unavailable`
 * had copy by hand, and the NEXT 503 would have shipped with no copy in any of the eight locales
 * while every assertion in that file stayed green. `backend/src/utils/http.ts`'s own header says as
 * much beside the helper ("Add the code to the SPA map in the same change, by hand, until that
 * scrape learns this helper"). It has now learned it, and this array is what it diffs against.
 *
 * ⚠️ A `Record<string, …>` above rather than an exhaustive union like `ForbiddenCode`, so there is
 * NO compile-time half here — the scrape is the only thing standing between a new 503 code and
 * eight untranslated locales. Do not delete it in favour of "the union will catch it".
 */
export const KNOWN_SERVICE_UNAVAILABLE_CODES: readonly string[] =
	Object.keys(SERVICE_UNAVAILABLE_MESSAGES);

/**
 * The 401 codes the SPA has COPY for — today exactly ONE (`agent_token_no_tenant`).
 *
 * ⛔ 401 IS A STATUS CLASS THIS MODULE HAD NO BRANCH FOR AT ALL, AND THE COPILOT IS WHERE THAT
 * SHOWS. `AgentChatStore.send`'s `onError` runs the failure through `writeErrorText`, which routes
 * 400/422/409 through `VALIDATION_MESSAGES` and everything else through
 * `licenseOrPermissionMessage` — 402, 403, 409-seat-cap, 503 and `null` for the rest. A 401
 * therefore landed on `m.chat_error_generic()` ("the assistant could not complete that request"),
 * which is TRUE and useless: it does not say the session is the thing that is stale, and it does
 * not name the one gesture that repairs it.
 *
 * ⛔ NARROW BY CONSTRUCTION, AND THE NARROWNESS IS THE POINT — the same lookup-not-a-status-sweep
 * shape `SERVICE_UNAVAILABLE_MESSAGES` documents. Every OTHER 401 still returns `null`: the
 * expired-Keycloak-session 401 that the route auth gate owns, the `unauthorized` a read screen
 * latches into its own "denied" state (routes/audit, /ontology, /(tenant)/usage all branch on
 * `status === 401` themselves), and agent.ts's own `Invalid or expired agent token`. Answering
 * `status === 401` unconditionally would put a copilot sentence in front of a reader whose session
 * simply expired, and would take the `denied` branches' fallback away from them.
 */
const AGENT_SESSION_MESSAGES: Record<string, () => string> = {
	// backend/src/routes/agent.ts:129 (POST /api/agent/chat) and :264 (the tool-result POST), plus
	// backend/src/routes/mcp.ts:111 (`resolveMcpIdentity`). The agent token carries the workspace as
	// a `tid` claim since `/session/issue` learned to bake it in; a token minted before that claim
	// existed verifies fine and reports no tenant, and all three sites fail closed rather than
	// falling back to `users.tenant_id` — the column whose drift from the Keycloak claim is what
	// made the copilot answer about the wrong workspace.
	//
	// ⚠️ THE READER IS AN ORDINARY AUTHOR ON /build OR /block-edit, and the window is a ROLLING
	// DEPLOY: `AgentChatStore.send` re-issues a token per turn, so once every replica mints `tid`
	// this cannot fire — but while replicas disagree, a token from an old one is refused by a new
	// one and the refusal lands in the chat bubble. That is the whole audience for the sentence, and
	// it is why the copy says "reload" rather than "contact your administrator": there is nobody to
	// contact and the next page load fixes it.
	//
	// ⛔ THE `tool-result` SITE AND THE MCP SITE ARE **NOT** EVIDENCE FOR THIS ENTRY and must not be
	// cited as if they were. `AgentChatStore.report()` logs its failure and shows nothing
	// (`'[chat] could not report a frontend tool result'`), and `routes/mcp.ts` answers a protocol
	// client, not a browser. One of the three throw sites reaches a reader; that one is enough, and
	// pretending three do would be the false-coverage claim `NOT_LOCALIZED_CODES` exists to prevent.
	agent_token_no_tenant: () => m.error_agent_token_no_tenant()
};

/**
 * Runtime mirror of every 401 code the SPA has copy for — `Object.keys` over the map above, built
 * the same way `KNOWN_SERVICE_UNAVAILABLE_CODES` is.
 *
 * ⚠️ NOTHING SCRAPES 401 YET. `error-message.backend-contract.test.ts` reads `forbidden(` /
 * `paymentRequired(` / `serviceUnavailable(` / `badRequest(` / `unprocessable(` / `conflict(` and
 * the status-qualified `new HttpError(403|402|503|400|409|422, …)` — never a bare `new HttpError(`,
 * which is verified: a 401 code passes every assertion in that file untouched. So this export has
 * no reader today and is here for the scrape that learns 401, exactly as
 * `KNOWN_SERVICE_UNAVAILABLE_CODES` sat unread until the 503 half was written. Adding that scrape
 * is a lane of its own: `new HttpError(401,` and `UnauthorizedError` are used tree-wide for
 * ordinary auth failures, so it would demand a home for every one of them, which is a decision
 * about the auth surface and not about this code.
 */
export const KNOWN_AGENT_SESSION_CODES: readonly string[] = Object.keys(AGENT_SESSION_MESSAGES);

/**
 * The `details` bag a typed client lifts off a 4xx body — `SolutionApiError` / `RunApiError` carry
 * it; the plain `ApiError` has no such field, in which case this is `undefined` and every
 * name-requiring entry below correctly declines to answer.
 */
function detailsOf(err: unknown): Record<string, unknown> | undefined {
	const d = (err as { details?: unknown })?.details;
	return typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : undefined;
}

/**
 * A `VALIDATION_MESSAGES` entry: localized copy for this refusal, or `null` for "I cannot say this
 * as well as the backend did — use its sentence".
 *
 * ⛔ THE `null` RETURN IS NOT A CONVENIENCE, IT IS THE DOCTRINE APPLIED TO ITSELF. `writeErrorText`
 * prefers the backend sentence for 400/422/409 because that sentence NAMES the offender and no
 * static translation can. Six of the entries below answer refusals whose English named a specific
 * block — `Block 'llm-summarize' is archived…` — and a localized sentence that cannot reach that
 * name would read "a block in this flow", on a graph of up to 40 nodes (`createSolutionSchema`).
 * That is the same information loss, wearing the fix's clothes. So those entries interpolate
 * `details.blockSlug` when the wire carries it and return `null` when it does not, which lands the
 * reader back on the named English sentence rather than on an anonymous localized one.
 */
type ValidationCopy = (details: Record<string, unknown> | undefined) => string | null;

/** The offending block's slug off a refusal's details, or `null`. */
function offendingBlock(details: Record<string, unknown> | undefined): string | null {
	const slug = details?.blockSlug;
	return typeof slug === 'string' && slug.trim() ? slug.trim() : null;
}

/**
 * Copy that NAMES the offending block, or `null` when the wire did not carry the name.
 *
 * The backend half is `blockSlug` on the details bag of every refusal that quotes a block:
 * `host/publication-service.ts` (4 sites) and `host/run-policy.ts` → its two callers. An older API
 * against this SPA therefore degrades to the English-but-NAMED sentence, never to a blank
 * placeholder — which is why this returns `null` rather than substituting a generic noun.
 *
 * ⛔ THE SLUG IS BIDI-ISOLATED, and it was the ONE interpolation site in this file that was not.
 * Its sibling `carrying` (:412) does `render(iso(v))`, and so do the three call sites at :1049,
 * :1056 and :731 — this one did `render(block)` on a raw string. The `ar` and `he` catalogs embed
 * `{block}` inside `«…»` guillemets in an RTL run, so a Latin slug (`http-fetch`) lands with no
 * directional boundary and UAX#9's implicit reordering moves it, along with any neighbouring
 * digits, punctuation or the guillemets themselves. The reader is shown a name that is not the
 * name the backend refused — in the six refusals below, whose entire purpose is to say WHICH
 * block, and which are the reader's instruction for what to go and fix.
 *
 * ⚠️ ONE isolate around the WHOLE token, per `iso`'s doc comment (:322-335) — a slug is a single
 * readable token, so there are no parts to isolate separately and no compound to reverse.
 */
const naming =
	(render: (block: string) => string): ValidationCopy =>
	(details) => {
		const block = offendingBlock(details);
		return block === null ? null : render(iso(block));
	};

/**
 * Wrap ONE READABLE TOKEN in a Unicode bidi ISOLATE (U+2068 FIRST STRONG ISOLATE … U+2069 POP
 * DIRECTIONAL ISOLATE), so `ar`/`he` cannot reorder it into nonsense.
 *
 * ⛔ CHARACTER-FOR-CHARACTER THE SAME `iso` AS `i18n/graph-issue-label.ts` AND
 * `i18n/connection-test-label.ts`, and deliberately copied rather than shared — those two carry the
 * measurement, and it is worth reading before touching this: isolating each FIELD of a joined
 * compound separately REVERSES the halves under UAX#9, and returning `<bdi>` markup instead would
 * require `{@html}` at the render site, i.e. injecting backend-supplied strings into the DOM as HTML.
 *
 * ⛔ NOT DECORATION HERE EITHER. Every value it wraps below is a string the PRODUCT does not
 * constrain: a config key the caller typed, a bucket name, an object key, a node or edge id, a block
 * or dataset slug, an entity/template/test name, a lint transcript. `entity_exists` and
 * `template_name_taken` quote a name a HUMAN typed, which in an Arabic-speaking workspace is Arabic
 * by default — the sentence around it swaps without this.
 *
 * ⚠️ A COMPOUND IS ONE ISOLATE, NOT ONE PER PART. `bad_category`'s comma-joined list and
 * `derived_lint_failed`'s `; `-joined transcript are each wrapped WHOLE, so the separators sit INSIDE
 * the FSI…PDI. That is the lesson `graph-issue-label.ts` measured on `“{sourceNode}.{sourceHandle}”`,
 * applied here rather than rediscovered.
 */
const iso = (v: string): string => `⁨${v}⁩`;

/**
 * A `details` field as a NON-BLANK string, or `null` when the wire did not carry it.
 *
 * ⛔ `null`, NEVER `''` — `offendingBlock`'s rule generalised to every other field, and for the same
 * reason `ValidationCopy` documents. `“” already exists in this cell` is a localized sentence that
 * says strictly LESS than the English it replaced, and it reads as a product bug rather than as a
 * missing wire field.
 *
 * ⚠️ A FINITE NUMBER IS ACCEPTED AND STRINGIFIED, and that is load-bearing for exactly two fields:
 * `version_exists` ships `{ version }` and `not_a_draft` ships `{ version: v.version, status }`
 * (blocks/authoring-service.ts:249/:296) — `version` is an INTEGER on the wire, so a string-only
 * guard would reject every real payload and this entry would never fire. `0` is a legitimate value,
 * which is why the test is `=== null` and not falsiness.
 */
function detailStr(details: Record<string, unknown> | undefined, field: string): string | null {
	const v = details?.[field];
	if (typeof v === 'string') return v.trim() ? v.trim() : null;
	return typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
}

/** A `details` field as a finite number, or `null`. `0` is preserved — it is a real size. */
function detailNum(details: Record<string, unknown> | undefined, field: string): number | null {
	const v = details?.[field];
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The READER'S locale, for the three figures below (`xlsx_too_large`, `dataset_too_large`).
 *
 * ⛔ WHY THIS IS NOT A PARAMETER, UNLIKE EVERY OTHER FORMATTER CALL SITE IN THIS APP. The house rule
 * (`utils/format.ts`'s header, `i18n/connection-test-label.ts`'s `locale` argument) is that a plain
 * `.ts` module takes `locale` so it cannot import the Svelte-runes store. That rule is about the
 * STORE, not about the locale: this module's public surface is `writeErrorText(e, fallback)`, called
 * from ~70 catch blocks, and threading a locale through all of them to reach two sentences would be
 * a wider change than the defect. `$lib/paraglide/runtime` is the package this module ALREADY
 * depends on for `m.*()`, and `stores/locale.svelte.ts:125` rebinds `getLocale()` to the very rune
 * `locale.current` reads — so this returns the app locale, not the runtime's, which is the property
 * `format.ts`'s header cares about.
 *
 * ⛔ THE `catch` IS NOT PADDING. Paraglide's own `getLocale()` resolves through its strategies and
 * READS `localStorage` directly when the store has not rebound it — which is the case in every
 * vitest node-environment spec that imports this module, and in a sandboxed iframe in production
 * (`SecurityError`). `stores/locale.svelte.ts:67` guards the identical call for the identical
 * reason and its comment records ten render-test files dying at import. An error message that throws
 * while formatting an error message takes the screen down instead of the request.
 */
function readerLocale(): string {
	try {
		return getLocale();
	} catch {
		return 'en';
	}
}

/**
 * The 429 and 413 codes the SPA has copy for — one each, and they are the same lookup-not-a-status-
 * sweep shape `SERVICE_UNAVAILABLE_MESSAGES` and `AGENT_SESSION_MESSAGES` document. An unknown 429
 * or 413 still returns `null` and keeps the caller's own fallback.
 *
 * ⛔ 429 AND 413 ARE TWO MORE STATUS CLASSES THIS MODULE HAD NO BRANCH FOR, AND `writeErrorText`
 * CANNOT COVER THEM. Its 400/422 and 409 branches render the backend's English sentence when no
 * localized entry answers; NEITHER branch sees a 429 or a 413, so both fell straight through
 * `licenseOrPermissionMessage`'s `return null` onto the caller's generic fallback ("Kon niet
 * opslaan") in all eight locales. Nothing on screen named the rate limit or the size cap, so the
 * reader had no repair to perform. That also means there is no English sentence BEHIND these
 * entries — a `null` here would be a silent loss, not the informed fall-through `ValidationCopy`
 * documents — which is why both entries always answer.
 *
 * ⚠️ TWO KEYS PER CODE, AND THE FIGURE-LESS ONE IS NOT PADDING. `details` reaches this module only
 * from the four `ApiError` copies that lift it (`parse.ts`'s `detailsFrom`); `AgentApiError` — the
 * copilot stream, an obvious rate-limit target — carries `status` + `code` and no bag at all, and an
 * old pod mid-roll can ship the code with no details either. The generic sentence is what those
 * readers get, and it is still actionable ("wait", "shorten it"). Same shape as `unknown_connector`
 * / `unknown_connector_generic`.
 *
 * ⚠️ NO ICU PLURAL ON THE SECONDS, DELIBERATELY — `utils/format.ts`'s `duration`/`demoDuration`
 * headers carry the rule and the reason: the unit is ABBREVIATED inside the catalog message
 * (`{seconds}s`, ar `ث`, he `שנ׳`, exactly as `demo_dur_sec` is), abbreviations do not inflect in any
 * of the eight locales, and a variant message would drag `i18n/icu-number-params.test.ts`'s
 * all-eight-or-none `FIXED` guard — six Arabic categories — behind one error string.
 */
const RATE_LIMIT_MESSAGES: Record<string, (d: Record<string, unknown> | undefined) => string> = {
	// backend/src/middleware/rate-limit.ts `rateLimitError` — `retryAfterSec` is already
	// `Math.max(1, ceil(…))` there, so it needs no flooring here; the guard is only for its absence.
	rate_limited: (d) => {
		const retryAfterSec = detailNum(d, 'retryAfterSec');
		return retryAfterSec === null || retryAfterSec <= 0
			? m.error_rate_limited()
			: m.error_rate_limited_retry({ seconds: num(Math.ceil(retryAfterSec), readerLocale()) });
	},
	// W8 — backend/src/routes/information-requests.ts `assertRequestQuota`: a member over the open-
	// request limit on one challenge (`reason: 'pending'`) or the 24-hour limit (`reason: 'daily'`).
	// The figure is deliberately not in the sentence: what the member can DO differs by reason
	// (wait for a review vs. wait until tomorrow), the number does not change that. An absent or
	// unknown reason (an old pod mid-roll) gets the daily sentence — both say "wait, then retry".
	information_request_limit: (d) =>
		d?.reason === 'pending'
			? m.error_information_request_limit_pending()
			: m.error_information_request_limit_daily()
};

const PAYLOAD_TOO_LARGE_MESSAGES: Record<
	string,
	(d: Record<string, unknown> | undefined) => string
> = {
	// backend/src/utils/http.ts `readBoundedText` (both arms: the `content-length` early refusal and
	// the streaming ceiling), reached through `readJson`/`readJsonOptional`.
	//
	// ⚠️ MB, AND THE `>= 1` GUARD IS WHY THIS IS NOT A BARE `Math.round`. The cap is
	// `MAX_REQUEST_BODY_BYTES` and defaults to 1 MiB, but it is env-settable: a sub-megabyte override
	// rounds to "0 MB", a sentence that reads as a product bug. Below a megabyte the figure is dropped
	// rather than mis-stated. The unit WORD lives in each catalog (`ميجابايت`, `Mo`, `מ״ב`) exactly as
	// `error_dataset_too_large_*` does it, so the translator owns unit and order and no Latin token
	// crosses into the RTL run.
	request_body_too_large: (d) => {
		const limitBytes = detailNum(d, 'limitBytes');
		if (limitBytes === null) return m.error_request_body_too_large();
		const limitMb = limitBytes / 1_048_576;
		return limitMb >= 1
			? m.error_request_body_too_large_limit({
					limitMb: num(Math.round(limitMb), readerLocale())
				})
			: m.error_request_body_too_large();
	}
};

/**
 * Runtime mirrors of the two maps above, built by `Object.keys` for the reason
 * `KNOWN_SERVICE_UNAVAILABLE_CODES` is. ⚠️ NOTHING SCRAPES 429 OR 413 YET —
 * `error-message.backend-contract.test.ts` reads `forbidden(` / `paymentRequired(` /
 * `serviceUnavailable(` / `badRequest(` / `unprocessable(` / `conflict(` and never
 * `payloadTooLarge(` or `rateLimitError(`. These sit here for the scrape that learns them, as the
 * 401 mirror sat unread before it.
 */
export const KNOWN_RATE_LIMIT_CODES: readonly string[] = Object.keys(RATE_LIMIT_MESSAGES);
export const KNOWN_PAYLOAD_TOO_LARGE_CODES: readonly string[] =
	Object.keys(PAYLOAD_TOO_LARGE_MESSAGES);

/**
 * `naming`'s generalisation: copy that carries ONE foreign value out of the details bag,
 * bidi-isolated — or `null` when the wire did not carry it.
 *
 * Same contract as `naming`, deliberately: `null` lands the reader on the backend's English
 * sentence, which still NAMES the offender. See `ValidationCopy` for why that is the doctrine
 * applied to itself rather than a convenience.
 */
const carrying =
	(field: string, render: (value: string) => string): ValidationCopy =>
	(details) => {
		const v = detailStr(details, field);
		return v === null ? null : render(iso(v));
	};

/**
 * ONE code, SEVERAL sentences, chosen by `details.reason`.
 *
 * ⛔ `reason` IS THE SUB-DISCRIMINATOR, NOT A NEW CODE, and the seam is the backend's: `utils/http.ts`
 * puts it in `details` precisely because `code` is already keyed on by this map and by backend tests,
 * so adding a reason is additive while renaming the code is a behaviour change.
 * `i18n/connection-test-label.ts` already switches on it for `bad_config` on the 200-OK test path;
 * this is the same switch on the 400 path, which is why those eight keys are REUSED below and not
 * minted a second time.
 *
 * ⚠️ AN ABSENT OR UNKNOWN `reason` RETURNS `null`, AND THAT IS THE MID-ROLL GUARD RATHER THAN A GAP.
 * An OLD POD ships the code with no `details` at all — the browser reaches the API through the
 * Service, so a new bundle really is answered by an old pod for the length of a roll — and a ninth
 * reason can land backend-first. Both fall through to the English sentence, which still says which
 * rule broke.
 */
const byReason =
	(arms: Record<string, ValidationCopy>): ValidationCopy =>
	(details) => {
		const reason = detailStr(details, 'reason');
		return reason !== null && Object.prototype.hasOwnProperty.call(arms, reason)
			? arms[reason]!(details)
			: null;
	};

/**
 * The `upload`/`file` arms of `dataset_too_large`, which share one sentence because they share one
 * reader gesture and one wire shape.
 *
 * ⚠️ NEITHER SHIPS `actualMb`, AND THAT IS WHY THEY CANNOT REUSE THE `input` SENTENCE. Both refuse
 * BEFORE the body is measured — routes/datasets.ts:108 reads `Content-Length`, :123 trips the
 * streaming ceiling, :162 checks the multipart part — so the only figure on the wire is the limit.
 * Two keys for one sentence would be the duplication this map's doctrine bars; one sentence for two
 * reasons is the same sentence, correctly.
 */
function datasetUploadLimit(details: Record<string, unknown> | undefined): string | null {
	const limitMb = detailNum(details, 'limitMb');
	return limitMb === null
		? null
		: m.error_dataset_too_large_file({ limitMb: num(limitMb, readerLocale()) });
}

/**
 * `derived_lint_failed`'s findings as ONE readable transcript, or `null`.
 *
 * ⚠️ `details.findings` IS AN ARRAY OF `LintFinding` OBJECTS (blocks/lint.ts:10), not of strings —
 * `{ source, rule, message, line? }` — and the backend's English joins their `.message` with `'; '`.
 * That prose is authored in `blocks/lint.ts` and is the single most useful text on the screen, so the
 * split here is `connector_test_failed`'s and not `graph_issue_*`'s: the FRAME is localized and the
 * technical transcript is interpolated whole. Localizing the findings themselves needs a stable
 * per-rule wire code first, exactly as `flow_invalid`'s entry records for `issue.message`.
 */
function lintTranscript(details: Record<string, unknown> | undefined): string | null {
	const raw = details?.findings;
	if (!Array.isArray(raw)) return null;
	const messages = raw
		.map((f) => {
			if (typeof f === 'string') return f.trim();
			const msg = (f as { message?: unknown } | null)?.message;
			return typeof msg === 'string' ? msg.trim() : '';
		})
		.filter((s) => s !== '');
	return messages.length ? messages.join('; ') : null;
}

/**
 * Every OTHER tenant-reachable 400/422/409 refusal — the 62 codes that were still arriving in
 * English, and the reason this file grew by an order of magnitude.
 *
 * ⚠️ 56 WHEN THIS OBJECT WAS WRITTEN, 62 NOW: the run-path + source-gate family (`lint_failed`,
 * `sandbox_busy`, `sandbox_suspended`, `data_validation_failed`, `not_resumable`,
 * `sandbox_admin_suspended`) moved in from `NOT_LOCALIZED_CODES`, where every one of their reasons
 * already began "deferred (⚠️ NOT admin-only)". RECOUNTED against `Object.keys` of this object, not
 * incremented — the same rule the catalog key-count literal carries.
 *
 * ⛔ THE DEFECT, MEASURED. `writeErrorText` renders the backend's ENGLISH `message` verbatim for any
 * 400/409/422 whose code has no entry in `VALIDATION_MESSAGES`. On `8d36692` that was 91 of the 102
 * codes the product can emit, so a Dutch tenant uploading a spreadsheet read `CSV must have a header
 * row with column names` inside a Dutch frame. Reproduced live against the API.
 *
 * ⛔ SAME ENTRY TEST AS THE MAP ABOVE — **WHO THE SENTENCE IS AIMED AT** — AND IT IS WHAT BOUNDS THIS
 * SET. Every code here is reachable by an ORDINARY GESTURE on a tenant screen: dropping a file on
 * /datasets, filling in a connector form, naming an entity on /ontology, pressing Publish on
 * /block-edit, voting on a closed round. None of them is a developer-shaped 422 whose sentence quotes
 * something the reader typed and no static translation could carry — those still fall through, and
 * `NOT_LOCALIZED_CODES` at the foot of this file names the ones deliberately left out and why.
 *
 * ⛔ EVERY ENTRY IS SEPARATE FROM `VALIDATION_MESSAGES`'S OWN BODY FOR ONE MECHANICAL REASON:
 * `NON_SUBMIT_PATH_CODES` is derived from `Object.keys` of THIS object. `error-message.backend-
 * contract.test.ts` asserts the submit-path mirror in both directions, so a code catalogued here that
 * `POST /api/solutions` cannot emit MUST be subtracted from `KNOWN_SUBMIT_REFUSAL_CODES` or the
 * mirror goes red. Hand-listing 56 code names beside a 56-entry object would be one more place to
 * rot and would add no information the object does not already carry. Deriving does NOT weaken the
 * guard: if one of these ever DOES become reachable from the submit path, the walk derives it, it is
 * missing from `KNOWN_SUBMIT_REFUSAL_CODES`, and the test reds on its `wronglySubtracted` branch
 * naming this exact fix. The rot-guard that greps `backend/src` for every member still applies to all
 * of them.
 *
 * ⚠️ OFF-PATH ENTRIES CARRY NO AUTOMATED REACHABILITY PROOF — the scraper is seeded at
 * `POST /api/solutions` only. So each entry cites the emitting `file:line`, as `delivery_already_live`
 * does, and the next reader checks by hand.
 *
 * ⚠️ THE "56" ABOVE IS THE SIZE THIS OBJECT WAS BORN AT, NOT ITS SIZE TODAY — it is left as written
 * because it is the MEASUREMENT the lane that created it made, and re-flowing that prose on every
 * addition would turn a measured figure into a running total nobody re-measures. The tenant-lifecycle
 * block at the foot adds two (`tenant_offboarded`, `confirm_mismatch`), so the live object holds 58.
 * Nothing derives a count from the prose; `Object.keys` is the only consumer.
 */
const OFF_PATH_REFUSAL_MESSAGES: Record<string, ValidationCopy> = {
	// ── connector config: backend/src/datasets/connectors/index.ts + storage.ts ──────────────────
	// ⛔ EIGHT SENTENCES, ONE CODE, AND NOT ONE NEW CATALOG KEY. `routes/connectors.ts:274` already
	// re-emits these same `HttpError.details` as an HTTP 200 `{ok:false, code, params}` for the "Test
	// connection" button, and `i18n/connection-test-label.ts:145` switches on the identical `reason`
	// values into `bad_config_*`. The only difference between the two paths is the envelope: the SAVE
	// throws a 400, the TEST answers 200. Minting `error_bad_config_required` beside
	// `bad_config_required` would be two keys for one sentence and eight duplicated translations.
	// :132 percent_escape · :139 backslash · :146 dot_segment · :153 absolute · :168 required ·
	// :178 postgres_scheme · :218 http_scheme · storage.ts:50 key_escapes_bucket.
	bad_config: byReason({
		// `field` is a CONFIG KEY the caller supplied ('url', 'query', 'bucket', 'key', 'baseUrl') —
		// a `.strict()` zod record accepts any string key, so it is foreign and isolated.
		required: carrying('field', (field) => m.bad_config_required({ field })),
		percent_escape: carrying('field', (field) => m.bad_config_percent_escape({ field })),
		backslash: carrying('field', (field) => m.bad_config_backslash({ field })),
		dot_segment: carrying('field', (field) => m.bad_config_dot_segment({ field })),
		absolute: carrying('field', (field) => m.bad_config_absolute({ field })),
		// No parameter: the whole sentence is the rule, and the scheme lists are protocol tokens.
		postgres_scheme: () => m.bad_config_postgres_scheme(),
		http_scheme: () => m.bad_config_http_scheme(),
		// `resolved` is the URL parser's normalised pathname — the single most useful fact here,
		// because it shows WHERE the key actually pointed after `..` collapsed.
		key_escapes_bucket: carrying('resolved', (resolved) =>
			m.bad_config_key_escapes_bucket({ resolved })
		)
	}),
	// datasets/connectors/index.ts:31 and :229. ⚠️ `kind` IS GENUINELY OPTIONAL — :229 knows the
	// rejected kind, :31 has already narrowed `cfg` to a typed union and passes `undefined`. Two keys,
	// not one with an empty `{kind}`, for the reason connection-test-label.ts:196 records: `“” is not
	// a source type` says less than the English. REUSED from that module, not minted.
	unknown_connector: (d) => {
		const kind = detailStr(d, 'kind');
		return kind ? m.unknown_connector({ kind: iso(kind) }) : m.unknown_connector_generic();
	},
	// datasets/connectors/storage.ts:23 — "cannot infer a format for object '{key}'".
	storage_format_unknown: carrying('key', (key) => m.error_storage_format_unknown({ key })),

	// ── connector queries: backend/src/datasets/connectors/postgres.ts ───────────────────────────
	// :20, :22, :25. One sentence each, no details bag — nothing locale-specific to lose.
	empty_query: () => m.error_empty_query(),
	multi_statement: () => m.error_multi_statement(),
	not_select: () => m.error_not_select(),

	// ── paste/upload parsing: backend/src/datasets/parse/* ───────────────────────────────────────
	// csv.ts:43 — the string in the reproduction: "CSV must have a header row with column names".
	csv_no_header: () => m.error_csv_no_header(),
	json_invalid: () => m.error_json_invalid(), // json.ts:12
	sql_empty: () => m.error_sql_empty(), // sql.ts:12
	sql_json_invalid: () => m.error_sql_json_invalid(), // sql.ts:18
	// xlsx.ts:87. ⚠️ THE WIRE CARRIES RAW FLOATS and the English rounds to a WHOLE number
	// (`mb = (n) => Math.round(n / 1_048_576)`, xlsx.ts:85). Rounding the same way is not tidiness:
	// a Dutch reader who sees "62 MB" in one locale and "61,7 MB" in another is being told two
	// different things about one file. `num()` for the reader's grouping, `Math.round` for parity
	// with the sentence this replaces.
	xlsx_too_large: (d) => {
		const actualMb = detailNum(d, 'actualMb');
		const limitMb = detailNum(d, 'limitMb');
		if (actualMb === null || limitMb === null) return null;
		const locale = readerLocale();
		return m.error_xlsx_too_large({
			actualMb: num(Math.round(actualMb), locale),
			limitMb: num(Math.round(limitMb), locale)
		});
	},
	xlsx_unreadable: () => m.error_xlsx_unreadable(), // xlsx.ts:113
	xlsx_no_sheet: () => m.error_xlsx_no_sheet(), // xlsx.ts:116
	xlsx_no_header: () => m.error_xlsx_no_header(), // xlsx.ts:142
	xlsx_no_file: () => m.error_xlsx_no_file(), // parse/index.ts:58
	// THREE reasons, TWO sentences — see `datasetUploadLimit` for why `upload` and `file` share one.
	dataset_too_large: byReason({
		// parse/index.ts:35. The only arm that knows the actual size. ⚠️ ONE DECIMAL ON `actualMb`
		// and NONE on `limitMb`, matching the English exactly: it interpolates
		// `${(bytes / 1_048_576).toFixed(1)}` and a bare `${DATASET_MAX_BYTES / 1_048_576}`.
		// `decimal1` rather than `toFixed(1)` because `toFixed` hard-codes '.', which is the THOUSANDS
		// separator in six of the eight catalogs — the defect `utils/format.ts` documents at length.
		input: (d) => {
			const actualMb = detailNum(d, 'actualMb');
			const limitMb = detailNum(d, 'limitMb');
			if (actualMb === null || limitMb === null) return null;
			const locale = readerLocale();
			return m.error_dataset_too_large_input({
				actualMb: decimal1(actualMb, locale),
				limitMb: num(limitMb, locale)
			});
		},
		upload: datasetUploadLimit, // routes/datasets.ts:108 (Content-Length) and :123 (stream ceiling)
		file: datasetUploadLimit // routes/datasets.ts:162 (the multipart part)
	}),
	// parse/index.ts:68 — `sourceType` is whatever the caller sent, so it is isolated.
	unknown_source_type: carrying('sourceType', (sourceType) =>
		m.error_unknown_source_type({ sourceType })
	),

	// ── dataset upload + column editing: backend/src/routes/datasets.ts ──────────────────────────
	no_file: () => m.error_no_file(), // :158
	// routes/datasets.ts `resolveUploadSourceType`. ⛔ THE CODE THAT REPLACED A GUESS: the route used
	// to close `sourceTypeFromName`'s null with `?? 'csv'`, so a dropped `report.pdf` was decoded as
	// UTF-8, line 1 became the header row, and the upload answered 201 with a garbage dataset. TWO
	// sentences behind one code, because the two repairs are genuinely different — "we don't read
	// .pdf" tells you to convert, "this file has no extension" tells you to rename. Both isolate
	// their value: a file name is the reader's own text, Arabic by default in an Arabic workspace.
	// ⚠️ THE SAME TWO KEYS ARE RENDERED CLIENT-SIDE by `lib/components/FileUpload.svelte`'s drop
	// guard, which refuses before the round trip. Reused, never duplicated — the two paths must not
	// be able to say different things about the same file.
	unsupported_file_type: byReason({
		extension: carrying('extension', (extension) => m.error_unsupported_file_type({ extension })),
		no_extension: carrying('name', (name) =>
			m.error_unsupported_file_type_no_extension({ name })
		)
	}),
	dataset_empty: () => m.error_dataset_empty(), // :215
	duplicate_column: () => m.error_duplicate_column(), // :370
	columns_mismatch: () => m.error_columns_mismatch(), // :373
	// ⛔ `bad_column_type` (:377) IS DELIBERATELY ABSENT — it is unreachable. See NOT_LOCALIZED_CODES.

	// ── bucket naming + storage webhooks: backend/src/routes/connectors.ts ───────────────────────
	// FOUR reasons; only `not_cp_bucket` carries a value, so only it can name one.
	bucket_convention: byReason({
		name_required: () => m.error_bucket_convention_name_required(), // :144
		name_too_long: () => m.error_bucket_convention_name_too_long(), // :147
		webhook_needs_cp_bucket: () => m.error_bucket_convention_webhook_needs_cp_bucket(), // :418
		// :640 (register) and :802 (status), identical message and details at both.
		not_cp_bucket: carrying('bucket', (bucket) =>
			m.error_bucket_convention_not_cp_bucket({ bucket })
		)
	}),
	shared_secret: () => m.error_shared_secret(), // :593
	not_webhook: () => m.error_not_webhook(), // :599
	// :626, :789, :834 — three routes, one message, and NO `reason` on the wire, so one key is the
	// honest count. Do not invent a per-route sentence the backend cannot tell apart.
	notifications_disabled: () => m.error_notifications_disabled(),
	not_storage_webhook: byReason({
		register: () => m.error_not_storage_webhook_register(), // :635
		read: () => m.error_not_storage_webhook_read() // :797
	}),

	// ── ontology scope gates: backend/src/ontology/ontology-service.ts + routes/ontology.ts ───────
	// ⛔ TWO DIFFERENT PROPOSITIONS UNDER ONE CODE, WHICH IS WHY `reason` EXISTS. `entity_scope` is
	// "the entity you are SAVING needs one" (ontology-service.ts:704/:696); `query_param` is "the
	// LIST you are opening needs one" (routes/ontology.ts:118/:122). One sentence for both would be
	// wrong on whichever screen it was not written for.
	industry_required: byReason({
		entity_scope: () => m.error_industry_required_entity_scope(),
		query_param: () => m.error_industry_required_query_param()
	}),
	department_required: byReason({
		entity_scope: () => m.error_department_required_entity_scope(),
		query_param: () => m.error_department_required_query_param()
	}),
	cell_required: () => m.error_cell_required(), // ontology-service.ts:710
	name_required: () => m.error_name_required(), // ontology-service.ts:757
	// ⚠️ `duplicate_attribute` (:722) names an attribute the AUTHOR typed — foreign, so isolated.
	duplicate_attribute: carrying('attribute', (attribute) =>
		m.error_duplicate_attribute({ attribute })
	),
	// :774, a 409. `writeErrorText`'s 409 branch consults this same map, which is why the conflict
	// codes below need no separate mechanism.
	entity_exists: carrying('name', (name) => m.error_entity_exists({ name })),
	bad_endpoint: () => m.error_bad_endpoint(), // ontology-service.ts:858
	predicate_required: () => m.error_predicate_required(), // ontology-service.ts:869
	self_edge: () => m.error_self_edge(), // ontology-service.ts:871
	relation_exists: () => m.error_relation_exists(), // ontology-service.ts:887 (409)
	not_global: () => m.error_not_global(), // ontology-service.ts:928
	bad_locale: () => m.error_bad_locale(), // ontology-service.ts:1049
	mapping_dataset_mismatch: () => m.error_mapping_dataset_mismatch(), // ontology/sample-service.ts:380
	no_primary_sample: () => m.error_no_primary_sample(), // ontology/data-block-derivation.ts:73
	// ontology/data-block-derivation.ts:141 — see `lintTranscript` for why the findings stay English.
	derived_lint_failed: (d) => {
		const findings = lintTranscript(d);
		return findings === null ? null : m.error_derived_lint_failed({ findings: iso(findings) });
	},

	// ── block authoring: backend/src/blocks/authoring-service.ts + routes/blocks.ts ──────────────
	// :165/:174 (409) both ship `{ slug }`.
	slug_taken: carrying('slug', (slug) => m.error_slug_taken({ slug })),
	// ⚠️ TWO SITES, ONE WITH NO DETAILS BAG. authoring-service.ts:166 ships `{ slug }`;
	// ontology/data-block-derivation.ts:119 ships NOTHING. `carrying` returns `null` for the second,
	// which lands the reader on the English sentence — which still quotes the slug. That asymmetry is
	// the exact case `ValidationCopy`'s `null` contract exists for, arriving from two files rather
	// than from a rolling deploy.
	slug_reserved_global: carrying('slug', (slug) => m.error_slug_reserved_global({ slug })),
	// :249 (409). `version` is an INTEGER on the wire — `detailStr` stringifies it.
	// ⚠️ NOT PUT THROUGH `num()`, DELIBERATELY: a block version is an IDENTIFIER, not a quantity, and
	// grouping it would print "1.024" for version 1024 in nl. Same call `connection-test-label.ts`
	// records for an HTTP status ("4.04 is not a status").
	version_exists: carrying('version', (version) => m.error_version_exists({ version })),
	// :296 and :338 (409), identical. TWO fields and the sentence needs both — "Version is , and only
	// a draft can be edited" names no problem at all, so it is both or the English.
	// ⚠️ `status` IS A PRODUCT ENUM ('draft' | 'beta' | 'stable'), so it is NOT isolated (rule: isolate
	// what the product does not constrain) — but it IS still an English token inside a Dutch frame.
	// Localizing it needs the block-status label module, which is follow-on work and is NOT done here;
	// this entry is strictly better than the fully-English sentence and not a claim of completeness.
	not_a_draft: (d) => {
		const version = detailStr(d, 'version');
		const status = detailStr(d, 'status');
		if (version === null || status === null) return null;
		return m.error_not_a_draft({ version: iso(version), status });
	},
	// :382, both codes chosen at :377-381. `details.summary` is a test-run object, not a sentence
	// fragment, so there is nothing to interpolate and one sentence each is complete.
	tests_required: () => m.error_tests_required(),
	tests_failing: () => m.error_tests_failing(),
	// routes/blocks.ts:736 (create) and :787 (update), 409, `{ test, block }`. Both are author-typed.
	test_name_taken: (d) => {
		const test = detailStr(d, 'test');
		const block = detailStr(d, 'block');
		if (test === null || block === null) return null;
		return m.error_test_name_taken({ test: iso(test), block: iso(block) });
	},

	// ── ⚠️ NOT admin-only: the block SOURCE GATE and the RUN path ────────────────────────────────
	//
	// ⛔ ALL SIX WERE `NOT_LOCALIZED_CODES` ENTRIES WHOSE OWN REASON ALREADY SAID SO. Every one of them
	// read `deferred (⚠️ NOT admin-only)` — the register recorded the correction, named this as the
	// next lane, and left the English in place. This is that lane. `sandbox_busy` alone fires on an
	// ordinary DOUBLE-CLICK OF RUN on /build and /solutions/[id]; none of the six needs a role above
	// member except `lint_failed`, which needs developer (routes/blocks.ts `authorizeBlockWrite`).
	//
	// ⚠️ EVERY LINE REFERENCE THE REGISTER CARRIED FOR THIS FAMILY WAS STALE BY ROUGHLY +127, and the
	// coordinates below were re-measured against the tree (2026-08-26) rather than copied across. The
	// contract scrape greps the code LITERAL and never the line, so that rot was invisible to CI and
	// only ever cost the next reader — which is exactly why it is worth fixing by hand.

	// blocks/source-gate.ts:75 AND blocks/authoring-service.ts:345 — byte-identical throws (message
	// included; source-gate.ts:64 explains why the two must never diverge), both shipping
	// `{ findings }` as `LintFinding[]`.
	//
	// ⛔ THE SAME SHAPE AS `derived_lint_failed` ABOVE, DELIBERATELY AND NOT BY COINCIDENCE. The two
	// carry the identical payload from the identical linter, and `lintTranscript` is the reader for
	// it; a second shape for one wire field is the drift this file's contract test exists to prevent.
	// So the FRAME is localized and the technical transcript is interpolated whole, in ONE isolate.
	// `null` when the bag carries no usable finding lands the reader on the backend's `Block failed
	// lint` — which is no worse than a findings-less localized sentence would be.
	lint_failed: (d) => {
		const findings = lintTranscript(d);
		return findings === null ? null : m.error_lint_failed({ findings: iso(findings) });
	},
	// host/run-controller.ts:1198 — a 409 raised INSIDE the claim transaction when the sandbox row was
	// not won and the current status is not `suspended`. No details bag and none is wanted: the reader
	// pressed Run while their own previous run is still going.
	sandbox_busy: () => m.error_sandbox_busy(),
	// host/run-controller.ts:1022 (the pre-flight check) and :1192 (the lost claim race).
	//
	// ⛔ THREE SENTENCES, KEYED ON `suspensionReason` — WHICH IS WHY THIS IS NOT `byReason`. That
	// helper reads `details.reason`, and the field the backend actually puts on the wire at BOTH sites
	// is `suspensionReason` (`{ sandboxId, suspensionReason, resumable }`). Aliasing it to `reason`
	// here would be inventing a wire contract this map does not own.
	//
	// ⛔ AND THE SPLIT IS NOT DECORATION. :1022 answers with two DIFFERENT English sentences chosen by
	// the same field, and their repairs differ — "resume it and retry" versus "ask a platform operator"
	// — so one flattened sentence would say strictly LESS than the English it replaces, which is the
	// loss `ValidationCopy` documents rather than a tidier spelling of it.
	//
	// ⚠️ THE GENERIC ARM ANSWERS INSTEAD OF RETURNING `null`, and that departs from the named-value
	// entries for a measured reason: :1192's English IS the bare "Your sandbox is suspended.", so
	// nothing is lost, while an old pod that ships no bag at all would otherwise leave the reader with
	// a sentence they cannot read in seven of the eight locales.
	sandbox_suspended: (d) => {
		switch (detailStr(d, 'suspensionReason')) {
			case 'idle':
				return m.error_sandbox_suspended_idle();
			case 'admin':
				return m.error_sandbox_suspended_admin();
			default:
				return m.error_sandbox_suspended();
		}
	},
	// host/run-controller.ts:1137, reached only when the governance policy `data.validation_mode` is
	// `block` (under the shipped default `warn` the same findings ride the 201 instead).
	//
	// ⛔ THE HEADLINE ONLY, AND THAT IS THE WHOLE ENTRY RATHER THAN A GAP. `details.findings` here is
	// `DataValidationFinding[]` — `{ dataset, column, attribute, rule }`, NOT the `LintFinding[]` two
	// entries up — and the run surface already reads it through `api/data-findings.ts` and renders it
	// through the LOCALIZED `data_finding_*` keys. Interpolating a transcript here would print the
	// same findings twice, once untranslated. Same division of labour as `flow_invalid`.
	data_validation_failed: () => m.error_data_validation_failed(),
	// routes/sandboxes.ts:403 — `POST /api/sandboxes/me/resume`, reachable by ANY member from the
	// resume banner — and :303, the super_admin twin on `POST /api/sandboxes/:id/resume`.
	//
	// ⛔ THE RUNTIME `status` IS NOT ON THE WIRE, SO THE COPY STATES THE RULE INSTEAD. Both English
	// sentences interpolate it (`Sandbox is ${status}, not auto-suspended.` at :403, `…, not
	// suspended/error` at :303) but NEITHER throw passes a third argument to `unprocessable`, so the
	// body carries no `status` field at all — `details` is the localization seam (utils/http.ts) and
	// these two sites simply do not use it. A `{status}` placeholder would therefore be unfillable:
	// the entry would return `null` for every real payload and stand as dead copy claiming coverage,
	// which is the false claim this map's doctrine bars. `delivery_not_retriable` made the identical
	// call for the identical reason — state the RULE, which needs no wire field to be true and
	// survives a fourth status being added to the enum.
	//
	// ⚠️ WORDED TO BE TRUE OF BOTH SITES, because the map is keyed by code and the two guards differ
	// (:403 wants suspended+idle, :303 wants suspended-or-error). "not in a state that can be resumed"
	// is their union and the refresh is the next step for either reader. What is lost is the English
	// status TOKEN — itself an untranslated product enum ('idle', 'running', 'error') sitting in a
	// Dutch frame, which that reader could act on no better than on the sentence around it. Localizing
	// it needs the status put on the details bag backend-side FIRST; that is follow-on work and is
	// deliberately NOT done here, so do not read this entry as "the status is localized".
	not_resumable: () => m.error_not_resumable(),
	// routes/sandboxes.ts:398 — the ADMIN-PAUSED arm of that same self-resume route, fail-closed on
	// purpose. ⚠️ The name describes WHO paused the sandbox, not who reads the refusal: this reaches
	// any member pressing Resume on their own sandbox, which is why it was never admin-only.
	sandbox_admin_suspended: () => m.error_sandbox_admin_suspended(),

	// ── templates: backend/src/templates/templates-service.ts + routes/templates.ts ──────────────
	template_name_taken: carrying('name', (name) => m.error_template_name_taken({ name })), // :178 (409)
	// routes/templates.ts:22. ⚠️ `categories` IS AN ARRAY (`[...BLOCK_CATEGORIES]`), not the joined
	// string the English builds — so the join happens HERE, where the separator is a locale decision.
	// The whole joined run is ONE isolate, not one per member: the commas must sit inside the FSI…PDI
	// or the list reverses in `ar`/`he`. See `iso`.
	bad_category: (d) => {
		const raw = d?.categories;
		if (!Array.isArray(raw)) return null;
		const names = raw.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
		return names.length
			? m.error_bad_category({ categories: iso(names.map((c) => c.trim()).join(', ')) })
			: null;
	},

	// ── voting: backend/src/host/vote-service.ts ─────────────────────────────────────────────────
	// :112 (cast) and :144 (retract), both 409, both `{ type: 'challenge' | 'solution' }`.
	//
	// ⛔ TWO KEYS, AND THIS IS NOT THE DUPLICATION THE `bad_config` NOTE ABOVE FORBIDS. That one was
	// two keys for ONE sentence. These are two DIFFERENT sentences: `type` is an English noun the
	// backend picked, and interpolating it into a Dutch frame would render "Stemmen op deze challenge
	// is gesloten" — the precise half-translated result this whole map exists to remove. An unknown
	// third target falls through to the English, which is correct until someone adds its sentence.
	voting_closed: (d) => {
		switch (detailStr(d, 'type')) {
			case 'challenge':
				return m.error_voting_closed_challenge();
			case 'solution':
				return m.error_voting_closed_solution();
			default:
				return null;
		}
	},

	// ── the agent's flow editor: backend/src/ai/flow-edit-service.ts ─────────────────────────────
	// :167 knows only that an endpoint is missing; :237 knows WHICH node. Two shapes, so two arms —
	// and only the second can name anything.
	unknown_node: byReason({
		connect_endpoint: () => m.error_unknown_node_connect_endpoint(),
		not_found: carrying('node', (node) => m.error_unknown_node_not_found({ node }))
	}),
	// :298 — no `reason`, ships `edge`.
	unknown_edge: carrying('edge', (edge) => m.error_unknown_edge({ edge })),

	// ── the remaining tenant-reachable one-liners ────────────────────────────────────────────────
	//
	// ⛔ `no_home_tenant` WAS HERE AND IS GONE, AND IT IS A RENAME RATHER THAN A DELETION. It was
	// `badRequest('no_home_tenant', 'User has no home tenant')` at routes/agent.ts:102, the 400 the
	// copilot answered users whose `users.tenant_id` was NULL with. That column is no longer read:
	// the workspace rides in the agent token as a `tid` claim, and all three sites that used to fall
	// back to it now fail closed with 401 `agent_token_no_tenant` (routes/agent.ts:129, :264 and
	// routes/mcp.ts:111). Measured: the literal `no_home_tenant` appears NOWHERE in `backend/src`
	// outside a comment, so `NON_SUBMIT_PATH_CODES`'s own rot-guard
	// (`lists only codes the backend still emits somewhere`) is what reds if the entry is kept —
	// this map's keys ARE that list. The successor copy lives in `AGENT_SESSION_MESSAGES` at the top
	// of this file, because the successor is a 401 and `writeErrorText` consults THIS map on
	// 400/422/409 only; leaving the entry (or moving the key here) would be copy nothing can render.
	invalid_challenge_id: () => m.error_invalid_challenge_id(), // routes/solutions.ts:82
	// ⛔ THE **400** IN routes/challenges.ts (:470 create, :682 the PUT-datasets twin), NOT the four
	// 404s of the same name (ontology/sample-service.ts:351, ai/mcp/tools.ts:302 and :394,
	// routes/datasets.ts:53). `writeErrorText` consults this map on 400/422/409 only, so the 404s keep
	// their own handling and never reach here. The 400 is the only arm that ships `{ slug }`, which is
	// also what makes `carrying` the right shape: any OTHER status or route reusing the code arrives
	// without a slug, returns `null`, and gets its own English sentence back — three different English
	// sentences share this code, and none of them would survive being flattened into one translation.
	dataset_not_found: carrying('slug', (slug) => m.error_dataset_not_found({ slug })),
	// W8/P2 — the 400 from `assertLinkableEntities` (backend/src/challenges/challenge-information.ts),
	// thrown by POST /api/challenges and PUT /api/challenges/:id/entities when a picked type of
	// information is gone or not this workspace's.
	information_not_found: () => m.error_information_not_found(),
	// W8/P4 — the two 422s from `prepareSampleTest` (backend/src/challenges/sample-test.ts) on
	// POST /api/runs {sampleChallengeId}. /build's data panel renders them itself with the way forward
	// (a link, an "Add" button); these are the sentences any OTHER reader of the error gets.
	sample_none_linked: () => m.build_sample_none_linked(),
	sample_no_data_input: () => m.build_sample_no_input(),
	// W8/P5 — backend/src/routes/information-requests.ts: a request id that is gone / not this
	// workspace's (404), and a second decision on an already-decided request (409).
	request_not_found: () => m.error_request_not_found(),
	request_not_pending: () => m.error_request_not_pending(),

	// ── the TENANT-ADMIN screens: /(tenant)/{members,sso,llm-settings,delivery} + the ────────────
	// ── /solutions/[id] forward+retry buttons ────────────────────────────────────────────────────
	//
	// ⛔ THESE WERE `NOT_LOCALIZED_CODES` ENTRIES, AND THE REASON THEY ARE NOT ANY MORE IS THAT THE
	// REGISTER'S OWN TEST FOR ENTRY NEVER FIT THEM. That test is **who the sentence is aimed at**,
	// and every reason on the seventeen entries under that heading said the same thing:
	// "tenant-admin only". FIFTEEN of them moved here; the other two (`platform_role_forbidden`,
	// `delivery_target_kind_unsupported`) stayed in the register with a CORRECTED reason — they are
	// not deferrals, they are unreachable, and "tenant-admin only" was a wrong claim about both. A tenant admin is an ORDINARY CUSTOMER on their OWN workspace screens — the person a
	// Dutch demo is given to — not a platform operator with a terminal open. `platform-admin only`
	// is a real bound (nobody outside the vendor sees /governance); `tenant-admin only` is not a
	// bound at all, it is most of the paying audience. They read English refusals in a Dutch frame
	// for the same reason the 91 codes before them did, and the register recorded the decision
	// honestly enough to make that visible — which is what it is for.
	//
	// ⚠️ NONE IS ON THE SUBMIT PATH, so all of them are subtracted from `KNOWN_SUBMIT_REFUSAL_CODES`
	// automatically (`NON_SUBMIT_PATH_CODES` is `Object.keys` of this object). Per this object's
	// header that buys no reachability proof, so each cites its emitting `file:line`.

	// ── /(tenant)/members: routes/tenant-users.ts + services/provisioning.ts ─────────────────────
	// `last_tenant_admin` (routes/tenant-users.ts: PATCH demote, DELETE remove, and the super_admin
	// move): the consequence and the repair are the same for all three, so one sentence. Worded
	// "the workspace" because the move's reader stands OUTSIDE the workspace in question.
	last_tenant_admin: () => m.error_last_admin(),
	// ⛔ A SEPARATE CODE FROM `last_tenant_admin`, NOT A DUPLICATE: the super_admin move refuses to
	// leave a workspace with no live member at all (every licence-binding path resolves its subject
	// as "the oldest live member"). Same "the workspace" wording, for the same reader.
	last_member: () => m.error_last_member(),
	// :269 — one site, one sentence.
	cannot_offboard_self: () => m.error_cannot_offboard_self(),
	// ⛔ THE **409** ARM ONLY. The 403 of the same name is owned by `FORBIDDEN_MESSAGES` above and
	// must keep being owned by it — `writeErrorText` routes 403 through `licenseOrPermissionMessage`
	// and never consults this map, so the two entries cannot collide. They are different refusals to
	// different readers: the 403 tells the OFFBOARDED PERSON their own account is gone
	// (services/user-service.ts:87), this one tells an ADMIN that the account they are trying to
	// re-use or move is a tombstone (routes/onboarding.ts:243, routes/tenant-users.ts:416,
	// services/provisioning.ts:252 — the last is `new HttpError(409, …)`, not `conflict()`).
	user_offboarded: () => m.error_user_offboarded_conflict(),

	// ── /(tenant)/sso: services/sso-service.ts:222 (the Keycloak 409 catch) and :253 (the local
	// duplicate check). Two sites, one English sentence, one translation.
	idp_exists: () => m.error_idp_exists(),

	// ── /(tenant)/members: services/provisioning.ts:290. The invited email already has a Keycloak
	// account that holds a PLATFORM role (`super_admin`). Adoption is refused rather than resolved,
	// because the two ways to resolve it are both wrong: stripping the platform role would let a
	// customer's invite demote Common Practice staff, and adopting the account as-is would seat a
	// platform account against the customer's licence and put it on their invoice. A tenant admin
	// reads this and can act on it — use a different address — so it is catalogued rather than
	// deferred as admin-only.
	platform_account_adoption_refused: () => m.error_platform_account_adoption_refused(),
	// 409 from the same invite / approve path (services/provisioning.ts `reclaimDisabledIdentity`): the
	// realm account for the address is DISABLED and not by a CommonPractice signup reject, so CP will
	// not re-enable it (and an invite would be one the person can never use). A tenant admin reads
	// this on an invite, so it is catalogued rather than deferred as admin-only.
	identity_disabled: () => m.error_identity_disabled(),

	// ── /(tenant)/llm-settings: routes/llm-settings.ts ───────────────────────────────────────────
	// :91. Both halves are needed or the sentence names no problem: "does not offer the model" with
	// either side missing is a shrug. `preset.label` is the vendor NAME the reader picked in the
	// dropdown ("OpenAI", "Anthropic"), latin text inside an `ar`/`he` sentence — hence `iso` on both.
	invalid_model: (d) => {
		const model = detailStr(d, 'model');
		const provider = detailStr(d, 'provider');
		return model === null || provider === null
			? null
			: m.error_invalid_model({ model: iso(model), provider: iso(provider) });
	},
	// :115. The English also explains WHERE the fix is (the Governance screen) and the copy keeps
	// that, because the reader here cannot act at all without knowing it is somebody else's screen.
	model_not_allowlisted: carrying('model', (model) => m.error_model_not_allowlisted({ model })),
	// :152 — TWO sentences behind one code, chosen by `vendorChanged`. They are not paraphrases: the
	// second says a key IS stored and is being deliberately refused for this vendor, which is the
	// difference between "fill this in" and "this looks filled in and is not being used".
	api_key_required: (d) => {
		const provider = detailStr(d, 'provider');
		if (provider === null) return null;
		switch (detailStr(d, 'reason')) {
			case 'vendor_changed':
				return m.error_api_key_required_vendor_changed({ provider: iso(provider) });
			case 'missing':
				return m.error_api_key_required({ provider: iso(provider) });
			default:
				return null;
		}
	},
	// ⛔ THE SAVE-TIME KEY PROBE (routes/llm-settings.ts `putSettings`). The PUT now asks the
	// provider for one token BEFORE it encrypts and stores the key, and refuses the save when the
	// provider says no — so a typo'd or revoked token can no longer persist with a 200 OK and
	// `hasKey: true` and surface hours later inside a flow run.
	//
	// ⚠️ A LOCALIZED FRAME AROUND AN INTERPOLATED TRANSCRIPT, which is `connector_test_failed`'s and
	// `llm_test_failed`'s split rather than `invalid_model`'s. `detail` is the VENDOR's own text —
	// an HTTP body, a TLS failure, a rate-limit notice — and no catalog can hold it; it is also the
	// single most useful thing on the screen. What the frame must carry, and what the raw English
	// buried, is the part the reader acts on: the key was NOT saved, so nothing is half-applied.
	//
	// ⚠️ `detail` IS ALREADY KEY-REDACTED BACKEND-SIDE (`redactKey` in routes/llm-settings.ts,
	// prefix-matching so a truncated `sk-abc***` echo is caught too). Nothing here can re-do that —
	// this module never sees the key — so do NOT relax that redaction on the assumption the SPA
	// filters it.
	//
	// ⚠️ `null` WHEN EITHER FIELD IS ABSENT, per `ValidationCopy`'s doctrine: an old pod mid-roll
	// ships the code with no `details`, and the English sentence still names the vendor and quotes
	// the provider. A frame with an empty transcript would say strictly less.
	llm_key_probe_failed: (d) => {
		const provider = detailStr(d, 'provider');
		const detail = detailStr(d, 'detail');
		return provider === null || detail === null
			? null
			: m.error_llm_key_probe_failed({ provider: iso(provider), detail: iso(detail) });
	},

	// ── /(tenant)/delivery + /solutions/[id] forward/retry: routes/delivery.ts ───────────────────
	// :147 create, :191 update — an `isUniqueViolation` on (tenant, name). The English names no
	// value (the name the reader just typed is still in the box in front of them), so nothing is lost.
	delivery_target_name_taken: () => m.error_delivery_target_name_taken(),
	// ⛔ TWO SITES, TWO ENGLISH SENTENCES, ONE HONEST TRANSLATION. :390 is "not configured or is
	// disabled" (the target row is missing OR `enabled = false`); :731 is "the original connector no
	// longer exists" on a retry whose `target_id` is null. The union of those is "switched off or no
	// longer exists", which is exactly what the copy says — and both readers do the same thing next,
	// which is look at the Delivery screen.
	delivery_target_not_configured: () => m.error_delivery_target_not_configured(),
	// :728 — a 409. The English interpolates the CURRENT status ("A sent delivery cannot be
	// retried"); the copy states the RULE instead (`status !== 'failed' && status !== 'rejected'`),
	// which is the whole of it and needs no wire field to be true. Stating the rule also survives a
	// fourth non-retriable status being added.
	delivery_not_retriable: () => m.error_delivery_not_retriable(),
	// ⛔ THE FIVE THAT NEEDED THE BACKEND TO SAY MORE FIRST. `delivery_target_incomplete` is thrown
	// from FIVE sites with five different English sentences and `delivery_target_credentials_invalid`
	// from SIX (host/delivery/{jira,azure-devops,fr}.ts), all re-thrown by the same
	// `unprocessable(err.code, err.message)` at routes/delivery.ts:428/:438 — so keying on `code`
	// alone could only ever produce "this connector is not fully configured", which says strictly
	// LESS than the English it replaces. `DeliveryConfigError` now carries a `{kind, field?, reason?}`
	// bag and the route forwards it, which is what makes these localizable at all rather than a
	// downgrade dressed as a fix. `deliveryRefusalLabel` returns `null` when the bag has no
	// recognised `kind` — an old pod — landing the reader back on the English sentence.
	delivery_target_incomplete: (d) => deliveryRefusalLabel('delivery_target_incomplete', d),
	delivery_target_credentials_missing: (d) =>
		deliveryRefusalLabel('delivery_target_credentials_missing', d),
	delivery_target_credentials_invalid: (d) =>
		deliveryRefusalLabel('delivery_target_credentials_invalid', d),
	// ⛔ THE **422** ARM ONLY, and the register's warning about the other one still stands: this is
	// `EgressBlockedError` re-thrown at routes/delivery.ts:452, where the connector `kind` is in
	// scope and is attached to the bag. On the CONNECTOR side the same code is not an HTTP error at
	// all — datasets/connector-refresh.ts:259 records it onto the dataset row shown on /connectors,
	// a separate surface that `writeErrorText` never sees and this entry does not claim to cover.
	//
	// ⚠️ ONLY `egress_bad_target` MOVES. The other three (`egress_disabled`,
	// `egress_host_not_allowlisted`, `egress_ssrf_blocked`) already have ledger copy in
	// `delivery-error-label.ts` but were never in this register, because the 422 path emits them from
	// the same `catch` — they are reachable here too and are follow-on work, not a claim of coverage.
	egress_bad_target: (d) =>
		deliveryRefusalLabel('egress_bad_target', d) ??
		// …and the CONNECTOR arm the note above says this entry does not cover. It does now.
		// `deliveryRefusalLabel` needs a delivery `kind` to name the tool, and a connector refresh
		// has no tool — its bag is `{host, reason}` (datasets/connector-refresh.ts). Falling through
		// to English was correct while /connectors had nowhere else to go; now that `syncErrorText`
		// reads this map, it is the difference between a Dutch sentence and the server's prose.
		// ⚠️ The delivery path is UNCHANGED: it only reaches this line when its own bag carried no
		// recognised kind, and such a bag has no `host` either, so this returns null exactly where
		// the old code did (error-message.wire.test.ts's `unrecognised: [{ kind: 'gitlab' }]` case).
		// ⚠️ ONE GENERIC SENTENCE, DELIBERATELY. The backend mints `egress_bad_target` from EIGHT
		// distinct sites (unparseable target, no host, DNS failure, no address, refused redirect,
		// non-2xx status, two size caps — src/host/egress-guard.ts) and nothing on the wire tells
		// them apart: `reason` is the English prose itself, not a discriminator. A sentence that
		// claimed one specific cause would be wrong seven times out of eight.
		carrying('host', (host) => m.error_egress_bad_target_host({ host }))(d),

	// ── the CONNECTOR-REFRESH family: codes that reach a reader ONLY via datasets.sync_error_code ──
	//
	// ⛔ THESE ARE NOT HTTP REFUSALS AND THEY REACH NO `writeErrorText` CALLER. They are minted in
	// `datasets/connector-refresh.ts`'s catch, PERSISTED onto the dataset row (migration 0074), and
	// read back by `syncErrorText` below for /connectors. They live in this map rather than in a
	// private one because the map is keyed by wire code and `egress_bad_target` — the same guard,
	// the same catch — is already here: two catalogs for one code space is the drift this file's
	// contract test exists to prevent. All four literals are greppable in backend/src, which is what
	// `NON_SUBMIT_PATH_CODES`'s rot guard checks.
	//
	// `egress_disabled` / `egress_host_not_allowlisted` / `egress_ssrf_blocked` also have ledger
	// copy in delivery-error-label.ts. That copy interpolates a delivery TOOL name, which a
	// connector has none of, so these are separate sentences rather than a shared call.
	//
	// src/host/egress-guard.ts:146 — policy `models.external_http` is off for the workspace.
	egress_disabled: () => m.error_egress_disabled(),
	// :155. The host is the whole of the fix (add it to the allowlist), so it is interpolated when
	// the bag carries it and the sentence degrades to a generic when it does not — `null` here
	// would drop the reader back onto English for a case we can name perfectly well without it.
	egress_host_not_allowlisted: (d) => {
		const host = detailStr(d, 'host');
		return host
			? m.error_egress_host_not_allowlisted({ host: iso(host) })
			: m.error_egress_host_not_allowlisted_generic();
	},
	// :182 — the host resolves to loopback/link-local/metadata.
	egress_ssrf_blocked: (d) => {
		const host = detailStr(d, 'host');
		return host
			? m.error_egress_ssrf_blocked({ host: iso(host) })
			: m.error_egress_ssrf_blocked_generic();
	},
	// src/datasets/connector-refresh.ts:263 — the DEFAULT arm: any throw that is neither an
	// `EgressBlockedError` nor an `HttpError`. A driver's `ECONNREFUSED`, an auth failure, a
	// statement timeout, an aborted fetch. Necessarily generic — the bag's `reason` is the raw
	// English and there is no machine field to branch on — and that is why the row keeps
	// `sync_error`: the drawer shows this sentence, and the specifics stay one MCP call away.
	sync_failed: () => m.error_sync_failed(),

	// ── the TENANT-LIFECYCLE refusals: /(platform)/tenants offboard + reactivate ─────────────────
	//
	// ⛔ THE READER IS A PLATFORM OPERATOR, WHICH THIS MAP'S DOCTRINE NORMALLY DEFERS — AND THESE TWO
	// ARE THE EXCEPTION, ON PURPOSE, SO SAY WHY RATHER THAN LET THE NEXT READER GUESS.
	// `NOT_LOCALIZED_CODES` already carries `no_changes` off the SAME route (`PATCH /api/tenants/:id`,
	// routes/admin.ts:450) reasoned "super_admin only", and that reason is honest: nobody outside the
	// vendor opens /(platform)/tenants. The difference is what the sentence has to carry. `no_changes`
	// is a no-op notice; these two are the refusals of a DESTRUCTIVE, IRREVERSIBLE gesture, and the
	// operator driving a Dutch demo of the offboarding flow reads them at the moment they are deciding
	// whether the product did what they asked. Deferring them means the one screen where the product
	// says "this cannot be undone" answers in a different language than the sentence above it.
	//
	// ⚠️ NEITHER IS ON THE SUBMIT PATH, so both are subtracted from `KNOWN_SUBMIT_REFUSAL_CODES`
	// automatically (`NON_SUBMIT_PATH_CODES` is `Object.keys` of this object). Per this object's
	// header that buys no reachability proof, so each cites its emitting route.
	//
	// ⛔ BOTH SHIPPED FRONTEND-FIRST, and the ordering is the same one `license_unreadable` records:
	// an old bundle meeting the new API renders the backend's English sentence (the documented
	// fall-through), while a new bundle against the old API is byte-identical to what it replaced.
	// The `NON_SUBMIT_PATH_CODES` rot-guard greps `backend/src` for both literals, so it is RED until
	// the backend half lands — that red is the mechanism working, not a reason to relax it.

	// `PATCH /api/tenants/:id {status:'active'}` on an offboarded tenant → 409. The English says the
	// tenant "has been offboarded"; the copy keeps that AND states the consequence the operator is
	// actually asking about — reactivation is refused, not merely unavailable right now. No wire field
	// to interpolate: the tenant whose row they just clicked is named on the screen in front of them.
	tenant_offboarded: () => m.error_tenant_offboarded(),
	// `POST /api/tenants/:id/offboard` → 400 when the typed confirmation does not equal the tenant
	// slug. ⚠️ THE SLUG IS DELIBERATELY NOT INTERPOLATED: `tenant_offboard_confirm_prompt` already
	// prints it in the dialog, immediately above the box that was typed into, and echoing a
	// type-to-confirm token back into its own error is how a confirmation stops confirming anything.
	confirm_mismatch: () => m.error_confirm_mismatch(),
	// `PATCH /api/tenant/cycle-cadence` → 400 when the body or query names a tenant. The workspace
	// comes from the sign-in only; the voting-schedule page never sends one — a hand-built call does.
	tenant_id_not_accepted: () => m.error_tenant_id_not_accepted(),

	// ── CP-owned membership: invites (services/invite-service.ts) + tenant creation
	// (services/tenant-service.ts). The reader is a tenant admin on /(tenant)/members or a platform
	// operator on /(platform)/{tenants,onboarding}. `/invite/accept` renders its own copy for the
	// invitee, because there `email_in_other_tenant` is about the reader's OWN account.
	email_in_other_tenant: () => m.error_email_in_other_tenant(),
	already_member: () => m.error_already_member(),
	seats_full: () => m.error_seats_full(),
	// invite-service.ts renewAndSend: resending an EXPIRED invite while a newer one for the same
	// address is pending (one pending invite per address — 0094).
	invite_superseded: () => m.error_invite_superseded(),
	// ── A2 licence control (super_admin): POST/PATCH /api/tenants(/:id) (services/tenant-service.ts,
	// services/license-provisioning.ts, routes/admin.ts) and the plan catalogue
	// (routes/platform-plans.ts). Adoption is gone: CP registers its own licences tenant, and names
	// are unique per owning app, so a clash means CP itself already has a workspace with that name.
	licences_name_unavailable: () => m.error_licences_name_unavailable(),
	licences_not_configured: () => m.error_licences_not_configured(),
	licence_changed_concurrently: () => m.error_licence_changed_concurrently(),
	// license-provisioning.ts `withLicenceLease`: another tenant-licence op holds the lease; retryable.
	licence_busy: () => m.error_licence_busy(),
	// services/tenant-provisioning.ts: another caller (the integrity tick, a second Retry) holds this
	// creation step's claim right now; retryable in a minute.
	provisioning_step_busy: () => m.error_provisioning_step_busy(),
	// routes/admin.ts patchTenant: the nil-UUID seed/dev tenant is not edited (SYSTEM_TENANT_ID).
	system_tenant: () => m.error_system_tenant(),
	// services/offboarding.ts loadOffboardTarget: DEMO_TENANT_ID holds showcase/marketplace seeds.
	demo_tenant: () => m.error_demo_tenant(),
	licence_window_invalid: () => m.error_licence_window_invalid(),
	seats_below_usage: () => m.error_seats_below_usage(),
	plan_unknown: () => m.error_plan_unknown(),
	plan_retired: () => m.error_plan_retired(),
	// services/tenant-service.ts + routes/admin.ts (Part B): `local-llm` / `byo` FIX the BYO posture.
	// The forms lock the select, so these are reached only by a stale tab or a direct API caller.
	byo_mode_fixed_by_plan: () => m.error_byo_mode_fixed_by_plan(),
	byo_mode_required: () => m.error_byo_mode_required(),
	// routes/admin.ts `topUpBudget` (Part B, prepaid credit): billing has no money budget for this
	// workspace yet / the feature is switched off; and a refused top-up (key reuse, currency clash).
	billing_topup_unavailable: () => m.error_billing_topup_unavailable(),
	billing_topup_conflict: () => m.error_billing_topup_conflict(),
	// billing 403 `topup_writer_required`: CP's service account may not top up — a support matter.
	billing_topup_forbidden: () => m.error_billing_topup_forbidden(),
	plan_code_taken: () => m.error_plan_code_taken(),
	plan_in_use: () => m.error_plan_in_use(),
	// PATCH member move (routes/tenant-users.ts:359) → 409 when the target user's row changed
	// (deleted, or moved out of the source workspace) between the read and the locked re-read.
	user_changed: () => m.error_user_changed(),
	// ── flow templates: backend/src/routes/flow-templates.ts ─────────────────────────────────────
	// `createRoute`: "Save as template" on an empty canvas (the ⋯ menu stays enabled on a new flow).
	flow_template_empty: () => m.error_flow_template_empty(),
	// `createRoute` with scope=global (platform admin): a starter may name only platform blocks.
	// `details.blockSlugs` names them; without it the sentence still says what to do.
	flow_template_tenant_blocks: (details) => {
		const slugs = Array.isArray(details?.blockSlugs)
			? (details!.blockSlugs as unknown[]).filter((s): s is string => typeof s === 'string')
			: [];
		return slugs.length
			? m.error_flow_template_tenant_blocks({ blocks: slugs.join(', ') })
			: m.error_flow_template_tenant_blocks_generic();
	},
	// `useSolutionRoute`: "Use as starting point" on a solution whose author linked no flow.
	solution_no_flow: () => m.error_solution_no_flow()
};

/**
 * 400/422/409 codes whose backend message is NOT the actionable thing, keyed by `code`.
 *
 * ⛔ THE EXCEPTION TO `writeErrorText`'S WHOLE ARGUMENT, AND THE TEST FOR ENTRY IS **WHO THE
 * SENTENCE IS AIMED AT**, not how many entries feel tidy. That function exists because a validation
 * failure's backend sentence — "dataset name is too long for a bucket", "No dataset 'x' in the org's
 * test data" — is information the caller's generic fallback throws away. That reasoning holds for a
 * DEVELOPER-shaped 4xx: the reader typed the offending value, the sentence quotes it back, and no
 * static translation can carry that. Those codes stay OFF this map and keep falling through.
 *
 * It does not hold for a refusal aimed at an ORDINARY AUTHOR who just pressed a button on their own
 * work. That reader chose nothing, can fix nothing by re-reading the sentence, and in seven of the
 * eight locales cannot read it at all. `challenge_closed` was the first such entry; the rest of this
 * map is every OTHER code the `/build` submit path can refuse with, which is the same population and
 * had the same defect — a Dutch author pressing Submit was shown "An archived flow cannot be
 * submitted", "The flow is not ready to publish.", "Request validation failed." verbatim in English.
 * Same call as `seat_limit_reached`, which reaches the identical reader through a 409.
 *
 * ⛔ THIS IS STILL NOT "ADD EVERY CODE". The map is bounded by REACHABILITY, not by appetite: an
 * entry for a code the product cannot emit is a false claim of coverage that no test can ever
 * contradict. `error-message.backend-contract.test.ts` MECHANISES that rule for one route — it
 * walks the call graph of `POST /api/solutions` in `backend/src` and fails in BOTH directions: a
 * 400/422/409 code on that path with no entry here, and an entry here that path cannot emit.
 *
 * ⚠️ THE RULE IS REACHABILITY; THE TEST IS ONE ROUTE'S ENFORCEMENT OF IT, AND THE TWO ARE NOT THE
 * SAME THING. `delivery_already_live` (below) is the first entry off the submit path: reachable by
 * double-clicking Deliver on `/solutions/[id]`, therefore legitimate, but invisible to a scraper
 * seeded at `POST /api/solutions`. It is subtracted from `KNOWN_SUBMIT_REFUSAL_CODES` via
 * `NON_SUBMIT_PATH_CODES` so the mirror assertion keeps meaning what it says. An off-path entry
 * therefore carries NO automated proof that its code is still emitted — cite the emitting file and
 * line in its comment, as that entry does, so the next reader can check by hand.
 *
 * ⚠️ AN UNCATALOGUED CODE STILL FALLS THROUGH TO THE BACKEND SENTENCE — deliberately, unchanged.
 * That fall-through is not the bug and deleting it would be a regression (it is the only thing that
 * carries a developer-shaped 422's specifics). What was missing was any way for CI to SEE a
 * user-facing refusal arriving in English, which is what the contract test now supplies. The guard
 * is what stops the fall-through being permanent; the map is not.
 *
 * ⚠️ CONSULTED BEFORE THE RAW-MESSAGE FALLBACK, never after — after is unreachable, since the raw
 * message is a perfectly "useful" string by `isUselessMessage`'s test and would always win.
 *
 * A plain `Record<string, …>` and not an exhaustive union like `ForbiddenCode`: 400/422 codes are
 * open-ended (every Zod route can mint one) and an unlisted code MUST fall through to the backend's
 * own sentence, which is the behaviour this map is a deliberate exception to.
 */
const VALIDATION_MESSAGES: Record<string, ValidationCopy> = {
	// ── backend/src/routes/solutions.ts, `createSolution` — the submit handler itself ──────────
	// `POST /api/solutions` against a challenge whose cycle is over (:442).
	challenge_closed: () => m.error_challenge_closed(),
	// :432. A 422, NOT the 404 of the same name in routes/challenges.ts / host/vote-service.ts —
	// `writeErrorText` only consults this map on 400/422/409, so those keep their own handling.
	challenge_not_found: () => m.error_challenge_not_found(),
	// :455 — "No owned flow '…'": the flow is missing OR belongs to someone else, and the copy has
	// to cover both without accusing. Again a 422 here; the many `notFound('flow_not_found')` sites
	// are 404 and unaffected.
	flow_not_found: () => m.error_flow_not_found(),
	// :456 — "An archived flow cannot be submitted", the string in the demo screenshot.
	flow_archived: () => m.error_flow_archived(),
	// :469 — "The flow is not ready to publish." The per-node `details.issues` list renders BELOW
	// this headline (build/+page.svelte's `issueList`), so the headline's only job is to say "not
	// yet, look down there". ⚠️ host/run-controller.ts:1047 raises the same code for the RUN path
	// (re-measured 2026-08-26 — this said :920, stale by the same ~+127 as the whole run-path family)
	// ("The flow is not ready to run."); the copy is worded to be true of both, because the map is
	// keyed by code and both land on the same screen in front of the same author.
	//
	// ⚠️ THE LIST THIS HEADLINE POINTS AT IS STILL ENGLISH, AND THIS ENTRY DOES NOT FIX THAT. Each
	// `issue.message` is hardcoded prose in `backend/src/exec/flow-validate.ts` and arrives on the
	// wire already rendered; there is no per-issue wire CODE to key a catalog on, so localizing them
	// means giving every validator rule a stable code first. Strictly better than before (the
	// headline was English too) but NOT done — do not read this entry as "the flow_invalid refusal
	// is localized".
	flow_invalid: () => m.error_flow_invalid(),
	// ── backend/src/host/publication-service.ts, `resolveExecutableBlocks` (called at :460) ─────
	// :39, :46, :53, :63. Every one NAMES a block — which is the actionable half — and wraps it in
	// English prose plus an internal id or a version number, which is not. `naming` keeps the name
	// and replaces the prose; see its doc comment for what happens when the name is absent.
	//
	// ⚠️ `blockSlug` is the NODE's slug for the first two and the BUILDING BLOCK's slug for the last
	// two, decided backend-side at each throw (publication-service.ts) because they are refusals
	// about different things: a version that pins the wrong block is the author's node, an archived
	// block is the library entry. `tests/runs.test.ts` pins both, including a `not.toBe('node')`.
	missing_block_version: naming((block) => m.error_missing_block_version({ block })),
	block_version_mismatch: naming((block) => m.error_block_version_mismatch({ block })),
	block_archived: naming((block) => m.error_block_archived({ block })),
	block_version_unpublished: naming((block) => m.error_block_version_unpublished({ block })),
	// ── backend/src/host/run-policy.ts, `enforceRunPolicies` (called at :471) ────────────────────
	// The codes arrive INDIRECTLY: solutions.ts:473 throws `unprocessable(policyViolation.code, …)`,
	// so the literal never appears at the throw site. :43 and :67/:81 are where they are minted.
	//
	// ⚠️ `policyKey` was already on the details bag and is NOT the name this copy needs: it identifies
	// the POLICY (`models.external_http`), not the block that tripped it. `RunPolicyViolation.nodeSlug`
	// was added for this, and both callers forward it as `blockSlug` — one field name for the whole
	// path, so this map needs no per-code lookup.
	policy_network_blocked: naming((block) => m.error_policy_network_blocked({ block })),
	policy_pii_violation: naming((block) => m.error_policy_pii_violation({ block })),
	// ── backend/src/utils/http.ts — the `route()` wrapper's OWN 4xx, which every handler inherits ─
	// :128. The ZodError branch. ⚠️ It DOES carry a message now — `'Request validation failed.'`,
	// added 2026-08-03 by #189 — so the `isUselessMessage` bare-code guard no longer catches it and
	// it reached the screen in English. That is precisely the class this map exists for: it names no
	// field, so there is nothing locale-specific to lose. Reachable from `/build` for real (a flow
	// name over 160 chars, or a graph over 40 nodes, both fail `createSolutionSchema`).
	validation: () => m.error_validation(),
	// :49 (`readJson`) and :103 (the pg 22P02 catch). Structural rather than user-triggered — the
	// SPA sends `JSON.stringify` output and zod-validated uuids — but they are on the path because
	// the wrapper is, and a truncated body or a proxy-mangled request lands here.
	invalid_json: () => m.error_invalid_json(),
	invalid_input: () => m.error_invalid_input(),
	// ── backend/src/routes/delivery.ts — the ONE entry that is NOT on the submit path ────────────
	// `POST /api/solutions/:id/forward` (:472) and `.../forward/:deliveryId/retry` (:726) both answer
	// `{ error: 'delivery_already_live', message: 'This solution already has a live delivery to that
	// connector' }` with a 409. The call site is `solutions/[id]/+page.svelte:269`, already on
	// `writeErrorText`, so before this entry a Dutch tenant admin who pressed Deliver twice read that
	// English sentence inside a Dutch frame. Ordinary demo action, not an edge case.
	//
	// ⛔ A LABEL MODULE IS THE WRONG TOOL FOR THIS, and the distinction is not stylistic. A label
	// module (`$lib/i18n/*-labels.ts`) renders a LIST of structured findings off a DTO — many rows,
	// each keyed by its own field, rendered beside the data they describe. This is a SINGLE top-level
	// refusal keyed by a wire `code`, which is exactly the shape `VALIDATION_MESSAGES` is: one code
	// in, one localized sentence out, consulted by `writeErrorText` before the backend string. Adding
	// a label module here would mean a second, parallel code→copy mechanism for the same wire field.
	//
	// ⚠️ NOT COVERED BY `error-message.backend-contract.test.ts`. That scraper derives its code set
	// from `SUBMIT_METHOD`/`SUBMIT_PATH` (`POST /api/solutions`) only, so it can neither demand this
	// entry nor confirm it. The entry is still legitimate under this map's own doctrine, which bars
	// codes the product CANNOT emit — this one is reachable by double-clicking Deliver. It is
	// therefore excluded from `KNOWN_SUBMIT_REFUSAL_CODES` below (see `NON_SUBMIT_PATH_CODES`) rather
	// than smuggled into a set that claims submit-path reachability. Generalizing that scraper to a
	// second (method, path) pair is available follow-on work and is deliberately NOT done here.
	delivery_already_live: () => m.error_delivery_already_live(),
	// ── backend/src/routes/governance.ts — the SECOND off-submit-path entry ───────────────────────
	// `PATCH /api/governance/:key` (`validateValue`'s `list` branch, `NON_EMPTY_LISTS`) answers
	// `{ error: 'empty_allowlist', … }` with a 400 when an operator clears the "Allowlisted models"
	// box. The call site is `governance/+page.svelte`'s `update()`, already on `writeErrorText`.
	//
	// ⛔ THE READER IS A DUTCH PLATFORM ADMIN, WHICH IS THE ONLY TEST FOR ENTRY ON THIS MAP. Without
	// this entry `writeErrorText` renders the backend's English sentence verbatim on the 400 — the
	// exact defect the rest of this map exists to answer, shipped in the same commit as the floor
	// that produces it. The sentence names a POLICY KEY, not a value the reader typed, so unlike a
	// developer-shaped 422 nothing is lost by replacing it with localized copy.
	//
	// ⚠️ NOT COVERED BY `error-message.backend-contract.test.ts` (governance is not the submit
	// path) — see `NON_SUBMIT_PATH_CODES`, which is where it is subtracted and where the two
	// standing rot-guards on off-path entries live.
	empty_allowlist: () => m.error_empty_allowlist(),
	// `PATCH /api/governance/cycle.cadence` answers `{ error: 'cycle_busy' }` with a 409 when the
	// switch could not take its row locks within `lock_timeout` because the daily cycle tick holds
	// them (backend `switchCadence`). Same screen and same `update()` call site as `empty_allowlist`;
	// nothing changed, so the copy says to retry.
	cycle_busy: () => m.error_cycle_busy(),
	// ── CP-owned membership: a suspended/offboarded workspace (409) ──────────────────────────────
	// ⚠️ ON THE SUBMIT PATH, so deliberately NOT in `OFF_PATH_REFUSAL_MESSAGES`: the first-login seat
	// claim (services/cp-identity.ts:195/:210, services/seat-limit.ts:153) runs under
	// `POST /api/solutions`, and the invite path (services/invite-service.ts:152) mints the same code.
	// No wire field to interpolate — the workspace is the reader's own or the one on screen.
	tenant_not_active: () => m.error_tenant_not_active(),
	// ── every OTHER tenant-reachable refusal ─────────────────────────────────────────────────────
	// ⚠️ SPREAD LAST AND DELIBERATELY NOT INLINED. The 62 entries above it in `OFF_PATH_REFUSAL_MESSAGES`
	// are all off the submit path, and `NON_SUBMIT_PATH_CODES` is `Object.keys` of that object — so
	// the subtraction cannot drift from the copy it subtracts. Read that object's header for why the
	// derivation does not weaken the contract test.
	...OFF_PATH_REFUSAL_MESSAGES
};

/**
 * Codes in `VALIDATION_MESSAGES` that `POST /api/solutions` cannot emit, and which therefore must
 * NOT appear in `KNOWN_SUBMIT_REFUSAL_CODES`.
 *
 * ⛔ THIS IS AN HONESTY LIST, NOT AN ESCAPE HATCH. `error-message.backend-contract.test.ts` asserts
 * BOTH directions against the submit path — every derived code has copy, and every known code is
 * derivable — and the second direction exists so that a catalogued code the product cannot emit is
 * caught as dead copy. A localized refusal on a DIFFERENT route is not dead copy; it is simply
 * outside that test's (method, path) seed. Subtracting it here keeps the mirror assertion meaning
 * what it says instead of being loosened to accommodate a code it was never given the input to see.
 *
 * ⚠️ AN ENTRY HERE BUYS NO *SUBMIT-PATH* COVERAGE, BUT IT IS NOT UNPOLICED EITHER — that was the
 * hole when this list was introduced. `error-message.backend-contract.test.ts` now asserts, for
 * every member: (a) it is a live key of `VALIDATION_MESSAGES` above, and (b) the literal appears in
 * `backend/src` outside a comment. (b) is the one-line grep that CI was missing for
 * `delivery_already_live` — it is not a call-graph proof that the code is reachable from the route
 * the comment names, and it does not pretend to be, but it does turn "the backend stopped emitting
 * this at all" from a silent rot into a red test. A code that is in neither the map nor the backend
 * is exactly the false-coverage claim this map's doctrine forbids, and it used to pass in silence.
 *
 * Members: `delivery_already_live` (`routes/delivery.ts`, a 409 on a double-clicked Deliver) and
 * `empty_allowlist` (`routes/governance.ts`, a 400 on clearing the "Allowlisted models" box) and
 * `cycle_busy` (`routes/governance.ts`, a 409 when a cadence change meets the running cycle tick) —
 * each reachable by an ordinary gesture on a real screen, none on `POST /api/solutions` — plus every
 * key of `OFF_PATH_REFUSAL_MESSAGES`.
 *
 * ⛔ THE TAIL IS DERIVED, NOT TYPED, AND THAT IS A DELIBERATE DEPARTURE FROM THE TWO NAMED ABOVE.
 * Hand-listing 62 code names next to a 62-entry object would be a second copy of the same fact, and
 * the failure it invites — a code in the map that nobody remembered to subtract — is precisely the
 * silent one this whole file is written against. The honesty property survives the derivation
 * because the two rot-guards below still run over EVERY member: (a) it must be a live key of
 * `VALIDATION_MESSAGES` (true by construction now), and (b) the literal must still appear in
 * `backend/src` outside a comment, which is what catches a backend that stopped emitting it.
 *
 * ⛔ AND IT CANNOT LAUNDER A SUBMIT-PATH CODE. If any of the 62 ever becomes reachable from
 * `POST /api/solutions`, the walk derives it, `KNOWN_SUBMIT_REFUSAL_CODES` no longer contains it, and
 * `error-message.backend-contract.test.ts` reds on its `wronglySubtracted` branch — the one whose
 * advice text says "REMOVE each from NON_SUBMIT_PATH_CODES … This path DOES emit the code, so listing
 * it as off-path is the false claim." The subtraction is guarded from both sides either way.
 */
export const NON_SUBMIT_PATH_CODES: readonly string[] = [
	'delivery_already_live',
	'empty_allowlist',
	'cycle_busy',
	...Object.keys(OFF_PATH_REFUSAL_MESSAGES)
];

/**
 * Runtime mirror of EVERY key of `VALIDATION_MESSAGES` — the whole map, unfiltered.
 *
 * ⛔ NOT THE SAME LIST AS `KNOWN_SUBMIT_REFUSAL_CODES`, and the difference is the entire point: that
 * one is the SUBMIT-PATH SUBSET (this minus `NON_SUBMIT_PATH_CODES`). The guard test needs both to
 * tell "this code has no localized copy at all" apart from "this code has copy that was subtracted
 * from the submit-path set" — two failures with opposite fixes, which read identically without it.
 */
export const VALIDATION_MESSAGE_CODES: readonly string[] = Object.keys(VALIDATION_MESSAGES);

/**
 * Runtime mirror of every 400/422/409 code the SPA has localized copy for ON THE SUBMIT PATH —
 * `VALIDATION_MESSAGES` minus `NON_SUBMIT_PATH_CODES`, NOT the whole map — plus
 * `seat_limit_reached`, which has no entry above because `licenseOrPermissionMessage`
 * owns it (and must keep owning it), but is nonetheless "understood". Same construction as
 * `KNOWN_LICENSE_CODES`: `Object.keys` so it cannot drift from the map, plus the one code whose
 * copy lives elsewhere.
 *
 * Consumed by `error-message.backend-contract.test.ts`, which derives the 400/422/409 codes
 * reachable from `POST /api/solutions` by walking the backend call graph and asserts each is a
 * member here. That guard is the reason this array is exported at all.
 */
export const KNOWN_SUBMIT_REFUSAL_CODES: readonly string[] = [
	// ⚠️ FILTERED, and the filter is what keeps the contract test's MIRROR assertion honest: this
	// array is the SUBMIT-path subset of the map, not the map. See `NON_SUBMIT_PATH_CODES`.
	...Object.keys(VALIDATION_MESSAGES).filter((c) => !NON_SUBMIT_PATH_CODES.includes(c)),
	// Localized by `licenseOrPermissionMessage`, and deliberately excluded from the 409 branch of
	// `writeErrorText` so that copy keeps winning over the backend's English sentence.
	'seat_limit_reached'
];

/**
 * Localized copy for a Gate-2 (402), permission (403), seat-cap (409), named service-unavailable
 * (503), named agent-session (401), rate-limit (429) or body-cap (413) error, else `null`.
 */
export function licenseOrPermissionMessage(err: unknown): string | null {
	const status = statusOf(err);
	// A seat-cap 409 reaches an ordinary user only on an SSO/JIT first login, where the backend
	// refuses to seat them (services/user-service.ts). The backend message is English-only, and this
	// is the one person in the flow who chose nothing and can fix nothing — so localize it, and keep
	// the copy pointed at the workspace administrator who can.
	if (status === 409 && codeOf(err) === 'seat_limit_reached') return m.error_seat_limit_reached();
	if (status === 402) {
		const code = codeOf(err);
		// ⛔ THE CONNECTOR'S LICENCE IS CHECKED FIRST, AND THE ORDER IS THE FIX. An fr Gate-2 refusal
		// is about ONE delivery connector's stored fr token; the default below is about the READER'S
		// workspace. Falling through accused a paying customer of an expired Common Practice licence
		// and pointed them at the wrong screen. See `FR_LICENSE_MESSAGES`.
		const fr = code ? FR_LICENSE_MESSAGES[code] : undefined;
		if (fr) return fr();
		const known =
			code && Object.prototype.hasOwnProperty.call(LICENSE_MESSAGES, code)
				? LICENSE_MESSAGES[code as LicenseCode]
				: undefined;
		// license_required + any other 402 → the generic "no active license" copy. `fr_license_required`
		// — the collapsed code the four replaced — still lands here for the length of a roll.
		return known ? known() : m.error_license_required();
	}
	if (status === 403) {
		const code = codeOf(err);
		// An unknown/absent code keeps the generic copy — a backend rename must degrade, not crash.
		const known = code && Object.prototype.hasOwnProperty.call(FORBIDDEN_MESSAGES, code);
		return known ? FORBIDDEN_MESSAGES[code as ForbiddenCode]() : m.error_forbidden();
	}
	// ⛔ THE 503 ARM, AND IT IS DELIBERATELY THE LAST ONE. See `SERVICE_UNAVAILABLE_MESSAGES`: an
	// UNKNOWN 503 must keep returning `null` so the caller's own fallback survives, which is why this
	// is a lookup and not `status >= 500`. A `null` here is the pre-existing behaviour for every 5xx,
	// unchanged.
	// 502 — a lookup for the reason the 503 arm is one: an unknown 502 keeps returning `null`.
	if (status === 502) {
		const code = codeOf(err);
		const known = code && Object.prototype.hasOwnProperty.call(BAD_GATEWAY_MESSAGES, code);
		return known ? BAD_GATEWAY_MESSAGES[code]!() : null;
	}
	if (status === 503) {
		const code = codeOf(err);
		const known = code && Object.prototype.hasOwnProperty.call(SERVICE_UNAVAILABLE_MESSAGES, code);
		return known ? SERVICE_UNAVAILABLE_MESSAGES[code]!() : null;
	}
	// ⛔ THE 401 ARM, AND IT IS A LOOKUP FOR THE REASON THE 503 ARM IS. See
	// `AGENT_SESSION_MESSAGES`: an unknown or absent 401 code MUST keep returning `null`, because
	// every other 401 in this product already has an owner — the route auth gate, or a read screen's
	// own `status === 401 → denied` branch. This arm answers exactly the codes that have copy and
	// nothing else.
	if (status === 401) {
		const code = codeOf(err);
		const known = code && Object.prototype.hasOwnProperty.call(AGENT_SESSION_MESSAGES, code);
		return known ? AGENT_SESSION_MESSAGES[code]!() : null;
	}
	// ⛔ THE 429 AND 413 ARMS, LOOKUPS FOR THE REASON THE 503 AND 401 ARMS ARE — see
	// `RATE_LIMIT_MESSAGES`. They take the `details` bag because both sentences carry a figure the
	// reader acts on (how long to wait, how much to cut); an absent bag is answered by the
	// figure-less variant inside the map, never by a `null`, because no backend sentence follows.
	if (status === 429) {
		const code = codeOf(err);
		const known = code && Object.prototype.hasOwnProperty.call(RATE_LIMIT_MESSAGES, code);
		return known ? RATE_LIMIT_MESSAGES[code]!(detailsOf(err)) : null;
	}
	if (status === 413) {
		const code = codeOf(err);
		const known = code && Object.prototype.hasOwnProperty.call(PAYLOAD_TOO_LARGE_MESSAGES, code);
		return known ? PAYLOAD_TOO_LARGE_MESSAGES[code]!(detailsOf(err)) : null;
	}
	return null;
}

/**
 * The screen-facing form: a localized licence/permission message when the error is one, else the
 * caller's own translated `fallback`.
 *
 * Exists because ~130 catch blocks did `e instanceof Error ? e.message : String(e)` and rendered
 * the backend's English developer string verbatim ("Developer role required", "Tenant scope
 * mismatch") in all 8 locales. `licenseOrPermissionMessage` deliberately still returns `null` so
 * callers that DO have something better to say than a static fallback keep that freedom.
 */
export function errorText(e: unknown, fallback: string): string {
	return licenseOrPermissionMessage(e) ?? fallback;
}

/**
 * The reader's sentence for a connector's LAST SYNC FAILURE — `datasets.sync_error_code` +
 * `sync_error_detail`, with the server's English `sync_error` as the fallback.
 *
 * ⛔ THE DEFECT. `datasets.sync_error` is English prose COMPOSED ON THE SERVER AND WRITTEN TO A
 * COLUMN (`` `${code}: ${err.message}` ``, datasets/connector-refresh.ts). /connectors rendered it
 * twice — the drawer notice beside `m.connectors_sync_error_label()`, and the status badge's
 * `title=` — so a Dutch admin read "egress_host_not_allowlisted: Host 'files.example.com' is not on
 * the connector egress allowlist." inside an otherwise fully-Dutch page. Because it is a COLUMN and
 * not a response it survived reload, re-render and re-login: it stayed English until the connector
 * next synced successfully. Every render fixture in the repo set `syncError: null`, so CI had never
 * once seen the string.
 *
 * ⚠️ THE ORDER IS CATALOG FIRST, LEGACY TEXT SECOND, AND BOTH ARMS ARE PERMANENT.
 *   • no code            → pre-0074 row. There is no code to resolve; the English is all there is.
 *   • code, no entry     → a code shipped backend-first, or one whose entry needs a `details` field
 *                          this row does not carry. Same fall-through `writeErrorText` performs,
 *                          for the same reason: the English says MORE than a generic localized
 *                          sentence would.
 *                          ⚠️ THIS USED TO NAME THREE CODES THAT ALWAYS LANDED HERE, AND NO LONGER
 *                          DOES. `connector-refresh.ts` persisted exactly `{ host, reason }`, so
 *                          `bad_config` (discriminates on `details.reason`, which held English
 *                          prose), `storage_format_unknown` (needs `details.key`) and
 *                          `xlsx_too_large` (needs `details.actualMb` AND `details.limitMb` as
 *                          numbers, or `detailNum` bails) resolved to `null` for every reader. Its
 *                          catch now spreads `HttpError.details` over that bag — LAST, so a
 *                          thrower's snake_case `reason` discriminator beats `err.message` — and
 *                          all three reach their entry. Proven end to end by
 *                          routes/connectors/connectors.sync-error-dutch.render.test.ts against
 *                          bags transcribed from real persisted rows. Rows written BEFORE that fix
 *                          still land here, which is the arm below.
 *   • code with an entry → the reader's own language.
 * Neither fallback is transitional scaffolding: rows written before 0074 keep `sync_error_code`
 * NULL forever (nothing recomputes the column — only that connector's next refresh rewrites it),
 * and a connector nobody syncs again keeps its English row until it is deleted.
 *
 * Takes the SAME `VALIDATION_MESSAGES` map the 400/422 path uses rather than a private catalog:
 * `egress_bad_target` is minted by one guard (host/egress-guard.ts) and reaches BOTH surfaces, and
 * two catalogs for one code space is exactly the drift the contract test forbids.
 *
 * Returns `''` — never a manufactured sentence, never the bare token — when there is neither an
 * entry nor a legacy string, so a caller's `{#if}` on the value keeps behaving as it did.
 */
export function syncErrorText(
	code: string | null | undefined,
	legacyText: string | null | undefined,
	detail?: Record<string, unknown> | null
): string {
	if (code && Object.prototype.hasOwnProperty.call(VALIDATION_MESSAGES, code)) {
		// `?? undefined`: the catalog's `ValidationCopy` reads a bag or no bag, and `null` is not
		// one — `detailStr(null, 'host')` would throw on the property access.
		const copy = VALIDATION_MESSAGES[code]!(detail ?? undefined);
		if (copy !== null) return copy;
	}
	// ⛔ NEVER `code` ITSELF. Falling back to the raw token would put `egress_ssrf_blocked` in a
	// notice, which is worse than the English sentence it replaced — a machine word no reader in
	// any of the eight locales can act on.
	return legacyText ?? '';
}

function messageOf(err: unknown): string | undefined {
	return typeof (err as { message?: unknown })?.message === 'string'
		? (err as { message: string }).message
		: undefined;
}

/**
 * True when `text` is not a genuine, user-actionable backend message — empty/whitespace, a JS-ism
 * like `[object Object]`/`undefined`/`null`, the bare machine `code` re-used as the message (any
 * body with no `message` field, where `unwrap()`'s `body?.message ?? body?.error ?? …` chain falls
 * through to the code itself), or the synthetic `HTTP ### …` string `parse.ts`'s
 * `nonJsonErrorMessage` builds for a non-JSON body (an Istio/ingress error page, a stray proxy
 * response). None of those are something worth showing over the caller's translated fallback.
 *
 * ⚠️ THE ZodError BRANCH IS NO LONGER AN EXAMPLE OF THE BARE-CODE CASE, AND THAT MATTERS. This
 * comment used to cite `route()`'s ZodError branch as emitting `{ error: 'validation', issues: … }`
 * with NO `message`. True when it was written (#165, 2026-07-30); false since #189 (2026-08-03)
 * added `message: 'Request validation failed.'` in backend/src/utils/http.ts. The guard therefore
 * stopped catching it and the English sentence went to the screen — which is why `validation` is
 * now an explicit `VALIDATION_MESSAGES` entry rather than something this function absorbs.
 */
function isUselessMessage(text: string | undefined, code: string | undefined): boolean {
	if (!text) return true;
	const trimmed = text.trim();
	if (!trimmed) return true;
	if (trimmed === '[object Object]' || trimmed === 'undefined' || trimmed === 'null') return true;
	if (/^HTTP \d{3}\b/.test(trimmed)) return true;
	if (code && trimmed.toLowerCase() === code.toLowerCase()) return true;
	return false;
}

/**
 * The WRITE/mutation-path sibling of `errorText`: for a validation failure (400/422) the backend
 * message is the actionable thing — "dataset name is too long for a bucket", "No dataset 'x' in the
 * org's test data" — and the ~66-site sweep onto `errorText` (PR #156) replaced that with a vague
 * per-operation fallback, correct only for 402/403 (see `licenseOrPermissionMessage`'s doc comment)
 * but wrong for 400/422, where it threw away information the user needed.
 *
 * 409 gets the same treatment, added in the #165 follow-up review: every `conflict(code, message)`
 * call in `backend/src` (grep `conflict(` and `new HttpError(409` — both shapes exist) emits a
 * full, user-actionable sentence — "A connector with that name already exists", "Cannot offboard
 * the tenant's last admin — promote another member first", "Version 3 already exists" — not
 * developer jargon, so throwing it away for a generic "Failed to save" is the identical bug the
 * 400/422 fix addressed. The one exception is `seat_limit_reached`: it is the one 409 an ordinary
 * user reaches through no action of their own (SSO/JIT first login, `services/user-service.ts`),
 * its backend message is English-only, and `licenseOrPermissionMessage` already gives it localized
 * copy — that must keep winning, so it is excluded here and falls through to `errorText` below.
 *
 * For every other status this delegates to `errorText` unchanged — 402/403 still gets the localized
 * copy (never the raw backend string; `existing-block-picker.render.test.ts` pins that for 403), and
 * anything else (5xx, a network failure with no `status` at all) gets the caller's fallback exactly
 * as before. Only READ/load/diagnostic-probe call sites should stay on plain `errorText`; write
 * sites (save/create/update/delete/forward/provision) should use this.
 */
export function writeErrorText(e: unknown, fallback: string): string {
	const status = statusOf(e);
	if (status === 400 || status === 422) {
		const code = codeOf(e);
		// The localized override, FIRST — see `VALIDATION_MESSAGES`. `hasOwnProperty.call` so a code
		// spelled `toString` or `constructor` resolves to nothing instead of to Object.prototype.
		//
		// ⚠️ A `null` RETURN DELIBERATELY FALLS THROUGH to the backend sentence below rather than to
		// the caller's fallback: it means "the wire did not carry the block's name", and the English
		// sentence DOES carry it. Losing the name is the failure mode that entry exists to avoid, so
		// short-circuiting to a generic localized string here would defeat it. See `ValidationCopy`.
		const copy =
			code && Object.prototype.hasOwnProperty.call(VALIDATION_MESSAGES, code)
				? VALIDATION_MESSAGES[code]!(detailsOf(e))
				: null;
		if (copy !== null) return copy;
		const text = messageOf(e);
		if (!isUselessMessage(text, code)) return text as string;
	}
	if (status === 409 && codeOf(e) !== 'seat_limit_reached') {
		const code = codeOf(e);
		// The SAME localized override the 400/422 branch consults, for the same reason and with the
		// same precedence. No 409 code has an entry today — the only 409 on the `/build` submit path
		// is `seat_limit_reached`, excluded above because `licenseOrPermissionMessage` already owns
		// it. This branch exists so that the contract test's 409 half is not a trap: that test derives
		// 400, 422 AND 409 codes from the backend, so a `conflict(…)` added to the submit path
		// tomorrow goes red, and the obvious fix — an entry in `VALIDATION_MESSAGES` — has to actually
		// work. Without this lookup the map would silently ignore it and the guard would go green
		// while the English sentence still reached the author.
		const copy =
			code && Object.prototype.hasOwnProperty.call(VALIDATION_MESSAGES, code)
				? VALIDATION_MESSAGES[code]!(detailsOf(e))
				: null;
		if (copy !== null) return copy;
		const text = messageOf(e);
		if (!isUselessMessage(text, code)) return text as string;
	}
	return errorText(e, fallback);
}

/**
 * The codes this lane examined and deliberately did NOT catalogue, each with the reason.
 *
 * ⚠️ ALL BUT ONE MEMBER IS A 400/422/409, AND THE MAP IS NOT SCOPED TO THOSE STATUSES. This header
 * used to say "the 400/422/409 codes", which read as a rule and was only ever a census — and it is
 * now false as well as misleading: `signup_queue_full` at the foot of the Map is a 503.
 * `error-message.backend-contract.test.ts`'s 503 describe reads this Map for exactly the same
 * "catalogued or honestly registered" contract its whole-tree 400/422/409 half uses, and the rot-guard
 * that greps `backend/src` for every member does not care what status a code is — so a 503 whose
 * sentence reaches no reader belongs here rather than in a second register keyed by status, which
 * would be a second thing to rot for no gain. See the entry at the bottom of the Map.
 *
 * ⛔ IT EXISTS BECAUSE "NOT ON THE MAP" HAS TWO MEANINGS AND THEY LOOK IDENTICAL FROM CI. A code with
 * no entry either (a) was judged not to need one, or (b) was never looked at. `VALIDATION_MESSAGES`
 * can only ever express the first as silence, and silence is what let 91 of 102 codes reach a Dutch
 * tenant in English while every test stayed green. This register is the difference written down.
 *
 * ⛔ AN ENTRY HERE IS A CLAIM, NOT A PARKING SPACE, AND IT IS NOW A CI GUARD. `error-message.backend-
 * contract.test.ts`'s `every 400/422/409 code in backend/src is catalogued or honestly registered`
 * asserts BOTH directions over the whole tree: every string-literal code passed to `badRequest` /
 * `unprocessable` / `conflict` in `backend/src` (102 of them, measured 2026-08-24) is a key of
 * `VALIDATION_MESSAGES` or a key of THIS map, and every key of this map still appears in
 * `backend/src` outside a comment. So a wrong reason becomes a wrong GREEN, which is worse than the
 * gap it papers over. Two rules:
 *   · anything catalogued in `VALIDATION_MESSAGES` MUST NOT appear here (the two sets are disjoint by
 *     construction, and a code in both would claim coverage and non-coverage at once);
 *   · the reason must be the measured one. "deferred: /governance, admin-only" is honest. "n/a" is not.
 *
 * ⚠️ "DEFERRED" IS THE COMMONEST REASON AND IT IS NOT A JUDGEMENT THAT THE CODE DOES NOT MATTER. An
 * uncatalogued code still falls through to the backend's English sentence, which is the doctrine
 * `VALIDATION_MESSAGES` documents and which stays. What is recorded here is that someone read the
 * throw site and decided; the reader who disagrees now has something to disagree WITH.
 *
 * ⚠️ THE RUN-PATH FAMILY IS THE WORKED EXAMPLE OF THIS REGISTER DOING ITS JOB, IN BOTH DIRECTIONS.
 * Seven codes (`sandbox_suspended`, `sandbox_busy`, `invalid_idempotency_key`,
 * `data_validation_failed`, `not_resumable`, `sandbox_admin_suspended`, `lint_failed`) were handed to
 * a previous lane as "admin/platform-only"; measurement said otherwise for all seven and they were
 * registered with that correction — "deferred (⚠️ NOT admin-only)" — rather than with the assumption.
 * SIX are now catalogued. The seventh, `invalid_idempotency_key`, turned out to be unreachable from
 * the SPA and keeps its entry with a corrected reason. Neither outcome was available to a reader of
 * silence, which is the argument for writing the decision down at all.
 */
export const NOT_LOCALIZED_CODES: ReadonlyMap<string, string> = new Map([
	// ── the two that are not deferrals at all ────────────────────────────────────────────────────
	[
		'bad_column_type',
		'unreachable: zod enum rejects first (routes/datasets.ts columnSchema — :340 is the byte-identical enum to COLUMN_TYPES at :45, and patchSchema.parse at :357 runs 20 lines before the check at :377, so a bad type is already a 422 validation)'
	],
	[
		'no_secret',
		'service-to-service: MinIO webhook ingress, no browser path (routes/connectors.ts:931 on POST /api/connectors/events, registered :1058; frontend/src never fetches that path)'
	],
	[
		'delivery_solution_mismatch',
		'service-to-service: POST /api/delivery/fr-feedback, fr portal service account behind requireFrFeedbackWriter, no browser caller (routes/delivery.ts:867)'
	],
	// ⛔ THESE TWO ARRIVED HERE FROM THE OTHER DIRECTION, AND THE CORRECTION IS THE POINT. Both were
	// listed under `── tenant-admin screens ──` as "deferred: …, tenant-admin only" — a reason that
	// asserts REACHABILITY and is wrong for both. Writing localized copy for them was started and
	// then abandoned when the measurement came in, because a `VALIDATION_MESSAGES` entry for a
	// refusal the product cannot emit is a false claim of coverage that no test can contradict —
	// which is the same failure this register exists to prevent, wearing the fix's clothes.
	[
		'delivery_target_kind_unsupported',
		"unreachable: `SUPPORTED_FORWARD_KINDS` (routes/delivery.ts:402) is ['jira','azure_devops','fr'] — byte-identical to the WHOLE `delivery_target_kind` pg enum (db/schema.ts:1962), and `target.kind` is read from that column. So `!includes(target.kind)` at :692/:749 is always false and no row can trip the gate. It is defence-in-depth for the day a FOURTH kind is added to the enum; measured 2026-08-24, and the old reason ('deferred: /solutions/[id] forward/retry, tenant-admin only') claimed a reachability the schema forbids"
	],
	[
		'platform_role_forbidden',
		'unreachable over HTTP: all three callers of `assertTenantScopedRole` (routes/tenant-users.ts:83, :188, :448) pass a value zod has ALREADY narrowed with `tenantScopedRoleSchema` (:62, :74, :348), so a platform role is a 422 `validation` at the body boundary and never reaches services/provisioning.ts:32. Same class as `bad_column_type` above. Its own doc comment says "defense-in-depth … the zod schema already enforces this"'
	],
	// ⛔ AND SO DID THIS ONE, OFF A ROUTE THE SAME COMMIT WROTE. `?source=` LOOKS like a typed filter
	// and is not one: it is minted by the page, never by the reader. `sourceFromQuery`
	// (frontend/src/routes/connectors/+page.svelte:170) resolves the WHOLE typed input against the
	// three localized source labels and returns a member of the literal `['postgres','storage','http']`
	// or `undefined`; `listParams()` (:180) sends `source` only in the first case, and
	// `connectorsApi.list` sets the param only from that value (lib/api/connectors.ts:63). The screen
	// also never reads `?source=` off its OWN url — `q` is `$state('')` (:39) and the file contains no
	// `searchParams` at all — so a pasted, bookmarked or shared `/connectors?source=xyz` is ignored by
	// the page and mints no request. There is no second caller: `connectorsApi.list` has exactly one
	// call site in the product.
	//
	// ⚠️ AND A `VALIDATION_MESSAGES` ENTRY WOULD BE COPY NOTHING RENDERS, which is the
	// `signup_queue_full` failure at the foot of this Map. The list load is a READ path — its catch is
	// `errorText(e, m.error_load_failed())` (+page.svelte:214), which never consults
	// `VALIDATION_MESSAGES` — so even a reachable `invalid_source` could not reach `writeErrorText`
	// from this screen in any of the 8 locales.
	[
		'invalid_source',
		"unreachable through the product: `?source=` on GET /api/connectors is minted by /connectors, never typed — `sourceFromQuery` (frontend/src/routes/connectors/+page.svelte:170) matches the whole input against the three localized source labels and yields a member of `['postgres','storage','http']` or `undefined`, `listParams()` (:180) sends it only in the first case, `connectorsApi.list` (lib/api/connectors.ts:63) sets the param only from that value, and the page never reads `?source=` off its own url (`q` is `$state('')` at :39, no `searchParams` in the file), so a pasted or bookmarked /connectors?source=xyz mints no request. Only a hand-crafted API call reaches the guard at routes/connectors.ts:623. Measured 2026-08-27"
	],

	// ── platform-admin screens ───────────────────────────────────────────────────────────────────
	['invalid_value', 'deferred: /governance, platform-admin only (routes/governance.ts:194-237)'],
	['invalid_control', 'deferred: /governance, platform-admin only (routes/governance.ts:245)'],
	['policy_retired', 'deferred: /governance, platform-admin only (routes/governance.ts:273)'],
	[
		'cycle_off',
		'unreachable through the product: POST /api/cycle/advance (routes/cycle.ts) is a super_admin API with no screen; it answers 422 cycle_off only when the voting cycle cadence is off and no period key was named'
	],
	[
		'cycle_kind_mismatch',
		'unreachable through the product: POST /api/cycle/advance (routes/cycle.ts) is a super_admin API with no screen; it answers 400 cycle_kind_mismatch only when the named period key is of another kind than the effective voting cycle cadence'
	],
	[
		'approval_not_pending',
		'deferred: /(platform)/onboarding, platform-admin only (routes/onboarding.ts:326 approve, :414 reject)'
	],
	[
		'tenant_required',
		'deferred: /(platform)/onboarding approve, platform-admin only (routes/onboarding.ts:330)'
	],
	[
		'approval_in_progress',
		'deferred: /(platform)/onboarding approve/reject, platform-admin only — 409 while another decider (a Telegram tap, another tab) holds the approve claim (routes/onboarding.ts claimApproval)'
	],
	[
		'approval_claim_lost',
		'deferred: /(platform)/onboarding approve, platform-admin only — 409 when an approve run lost its claim (lapsed, taken over, decided) or hit the 30-min ceiling and stopped before its next irreversible step (routes/onboarding.ts HeldApprovalClaim.assertHeld)'
	],
	[
		'signup_workspace_in_use',
		'deferred: /(platform)/onboarding reject, platform-admin only — 409 when an aborted approve of this signup founded a workspace that now has other members or data, so the reject (which would offboard it) is refused (routes/onboarding.ts rejectApprovalRow)'
	],
	[
		'reject_repair_in_progress',
		'deferred: /(platform)/onboarding "Resolve manually", platform-admin only — 409 when a cleanup run holds the row\'s lease right now (routes/onboarding.ts:1336 resolveRepair)'
	],
	[
		'reject_repair_not_resolvable',
		'deferred: /(platform)/onboarding "Resolve manually", platform-admin only — 409 when the rejected signup\'s cleanup is no longer failed / blocked (finished or resolved meanwhile) (routes/onboarding.ts:1338 resolveRepair)'
	],
	[
		'reject_repair_live_access_unacknowledged',
		'deferred: /(platform)/onboarding "Resolve manually", platform-admin only — 422 when the close would leave the rejected requester\'s access live (blocked; failed on a seat / licence / IdP / identity / offboard cause) and the body lacks acknowledgeLiveAccess; the screen requires the confirmation checkbox first and then always sends it (routes/onboarding.ts resolveRepair)'
	],
	[
		'user_belongs_to_another_workspace',
		'deferred: /(platform)/onboarding approve + invite preflight, platform-admin only (routes/onboarding.ts:252, :308)'
	],
	[
		'no_changes',
		'deferred: /(platform)/tenants, super_admin only (routes/admin.ts:450, PATCH /api/tenants/:id)'
	],
	[
		'license_issuance_disabled',
		'deferred: /(platform)/tenants, super_admin only (routes/admin.ts:364)'
	],
	[
		'INVALID_ACTIVE_TENANT_HEADER',
		'deferred: the super_admin tenant switcher on /(platform)/tenants sets X-Active-Tenant-Id; a non-super caller never sees it (middleware/admin-guards.ts:155)'
	],
	// ⚠️ MEASURED, not inferred from the word "admin" in the sentence — the correction three blocks
	// down is what that mistake looks like. `no_metering_actor` is minted at
	// backend/src/routes/translations.ts:71, inside `postQueue`, whose FIRST statement is
	// `await requireSuperAdmin(req)` (:35 → middleware/admin-guards.ts:74, realm role `super_admin`,
	// NOT the tenant_admin composite). Its only caller is frontend/src/lib/api/translations.ts:47
	// (`POST /api/admin/translations/queue`) from /translations, which navConfig.ts:147 gates
	// `requiresRole: 'super_admin'`. A tenant admin cannot reach the screen or the route.
	// The refusal is also aimed at the VENDOR, not at a customer: it fires only when the operator was
	// granted super_admin directly in Keycloak and so has no `users` row for `translation_jobs.
	// requested_by` to bill against, and the action it asks for ("sign in once through the normal
	// flow") is an internal one no tenant reader could take.
	[
		'no_metering_actor',
		'deferred: /translations backfill, super_admin only (routes/translations.ts:71 under requireSuperAdmin at :35; nav gated super_admin in lib/layout/navConfig.ts:147). Reader is a vendor operator whose Keycloak-granted super_admin has no local users row'
	],

	// ── tenant-admin screens: EMPTY, AND THAT IS THE POINT ──────────────────────────────────────
	// Seventeen entries stood here — `last_admin`, `cannot_offboard_self`, `platform_role_forbidden`,
	// `email_exists`, `idp_exists`, `invalid_model`, `model_not_allowlisted`, `api_key_required`, the
	// six `delivery_*`, `egress_bad_target` and the 409 arm of `user_offboarded` — every one of them
	// reasoned "deferred: …, tenant-admin only". FIFTEEN are now catalogued in `VALIDATION_MESSAGES`.
	// The remaining two are UNREACHABLE and moved up to the "not deferrals at all" section at the top
	// of this map, with the measurement that says so.
	//
	// ⚠️ REGISTER: 27 ENTRIES BEFORE THE RUN-PATH LANE, 21 AFTER IT — that block lost six to
	// `VALIDATION_MESSAGES` and kept `invalid_idempotency_key` with a corrected reason. The
	// tenant-lifecycle lane moved the same Map in the OPPOSITE direction, restoring the 503
	// `signup_queue_full` entry at the foot of this Map, so the INTEGRATED size WAS 22 — neither
	// lane's own figure, both of which are true only of that lane in isolation. RECOUNTED on the live
	// Map (`NOT_LOCALIZED_CODES.size`) after the rebase, not added up, and pinned exactly in
	// `error-message.backend-contract.test.ts` so this figure cannot drift the way the last one did.
	// ⚠️ IT IS 23 NOW: the `?source=` filter this branch added to GET /api/connectors mints a SIXTH
	// unreachable code, `invalid_source`, registered in the block at the top of this Map. RECOUNTED on
	// the live Map, not incremented from the 22 above, and the exact pin in that test moved with it.
	// ⚠️ 28 as of the voting-cycle cadence branch (2026-10-14): `cycle_off` and `cycle_kind_mismatch`,
	// both from the screenless super_admin POST /api/cycle/advance. Pinned exactly in the contract test.
	// ⚠️ 29 as of early-access v2 (2026-10-19): `approval_in_progress` (onboarding approve claim).
	// ⚠️ 30 as of the approve-claim ceiling fix (2026-10-19): `approval_claim_lost` (an approve run that
	// lost its claim or hit the ceiling aborts before its next irreversible step).
	// ⚠️ 31 as of the reject-offboard fix (2026-10-19): `signup_workspace_in_use` (reject refused when
	// the workspace an aborted approve founded has other members or data).
	// ⚠️ 33 as of the reject-repair resolve fix (2026-10-20): `reject_repair_in_progress` and
	// `reject_repair_not_resolvable` (the super_admin "Resolve manually" refusals on /onboarding).
	// ⚠️ 34 as of the reject-repair live-access fix (2026-10-20): `reject_repair_live_access_unacknowledged`
	// (the same resolve, unconfirmed, on a row whose close leaves the requester's access live).
	// ⚠️ THE `> 20` NON-VACUITY FLOOR NOW HAS A MARGIN OF TWO. It is still the right floor — it
	// guards the grep, not the size — but the next lane to empty a block must recount and lower it
	// rather than delete an entry to stay above it.
	//
	// The paragraph below is the PREVIOUS lane's count and is kept because its lesson is not the
	// number: 41 ENTRIES BEFORE, 27 AFTER — and the "27" is COUNTED, not derived. That line read
	// "26 after" and was wrong: `NOT_LOCALIZED_CODES.size` was 27, and CI only asserts `> 20`, so
	// nothing caught the drift. The narrative above accounts for 41 − 15 = 26; the 27th is
	// `no_metering_actor`, ADDED to the register by the same change and not mentioned in the
	// seventeen-entry story. Both figures re-measured against the live Map (and the "before" against
	// the same Map at the parent commit) rather than decremented from a remembered number.
	//
	// ⚠️ AND THE 503 `signup_queue_full` AT THE FOOT OF THIS MAP IS OUTSIDE THE SEVENTEEN-ENTRY
	// NARRATIVE ABOVE ENTIRELY. It was registered, then catalogued in `SERVICE_UNAVAILABLE_MESSAGES`
	// and removed from here, then RESTORED when the copy was measured to render nowhere. On the
	// tenant-lifecycle lane alone that made the Map 28; integrated with the run-path lane, which took
	// SIX entries out, the live size was 22 (23 since `invalid_source`) — RECOUNTED after the rebase, not adjusted from either
	// lane's number. `error-message.backend-contract.test.ts` pins the exact size, so this figure and
	// that one move together — re-count `NOT_LOCALIZED_CODES.size` rather than editing either from
	// memory.
	//
	// ⛔ THE REASON THEY WERE WRONG IS THE ONE THIS REGISTER EXISTS TO EXPOSE. "tenant-admin only"
	// reads like the bound that `platform-admin only` genuinely is, and it is not one: a tenant admin
	// is an ordinary paying customer configuring their OWN workspace on /(tenant)/{members,sso,
	// llm-settings,delivery}. Seventeen refusals on the screens a Dutch demo is given from were
	// arriving in English, with a green suite and an honest-looking reason beside each. Do not
	// re-register a code on the strength of "admin" appearing in the sentence.

	// ── /pipeline and /sandboxes (platform-admin) ────────────────────────────────────────────────
	['review_locked', 'deferred: /pipeline, admin-only (routes/pipeline.ts:378)'],
	['policy_violation', 'deferred: /pipeline, admin-only (routes/pipeline.ts:483, :499)'],
	[
		'not_in_production',
		'deferred: /pipeline rollback, super_admin only (routes/pipeline.ts:579)'
	],
	[
		'solution_not_found',
		'deferred: the only 400/422/409 arm is the /pipeline enqueue 422 (routes/pipeline.ts:627), admin-only. Every other site is a 404 — routes/solutions.ts:336, host/vote-service.ts:95, routes/delivery.ts:280/:363/:370 — and writeErrorText never consults this map on a 404'
	],
	// ⚠️ :328, not the :324 this entry used to say — re-measured 2026-08-26 with the run-path family.
	['owner_not_found', 'deferred: /sandboxes create, super_admin only (routes/sandboxes.ts:328)'],

	// ── ⚠️ THE RUN-PATH BLOCK: SIX OUT, ONE LEFT, AND THE ONE LEFT IS NOT A DEFERRAL ─────────────
	// Seven entries stood here, every one of them reasoning "deferred (⚠️ NOT admin-only)" — an
	// honest correction of the brief that had called them admin-only, and a queue rather than a
	// decision. SIX are now catalogued in `VALIDATION_MESSAGES` (`sandbox_suspended`, `sandbox_busy`,
	// `data_validation_failed`, `not_resumable`, `sandbox_admin_suspended`, `lint_failed`), under
	// `── ⚠️ NOT admin-only: the block SOURCE GATE and the RUN path ──`.
	//
	// ⛔ THE SEVENTH IS A CORRECTION, NOT A CARRY-OVER, AND IT IS THE SHAPE THIS REGISTER IS FOR.
	// `invalid_idempotency_key`'s reason said "ordinary author", which asserts REACHABILITY and is
	// false: the SPA has exactly two callers and both set the header to `crypto.randomUUID()`, so no
	// browser gesture can produce the >200-character value the guard refuses. Same class as
	// `delivery_target_kind_unsupported` and `platform_role_forbidden` at the top of this map — a code
	// that stayed registered because the measurement came in, with the measurement written down.
	[
		'invalid_idempotency_key',
		'unreachable from the SPA: the Idempotency-Key header is set by exactly two call sites, both to `crypto.randomUUID()` — 36 characters, no user-supplied path (frontend/src/lib/api/runs.ts:122 start, :135 startSolution) — while the guard refuses only above 200 (host/run-controller.ts:1014-1015). Only a hand-crafted request trips it. Its old reason read "deferred (⚠️ NOT admin-only): ordinary author", which claimed a reachability the client cannot produce; corrected 2026-08-26'
	],

	// ⛔ THE OTHER SIX OF THAT BLOCK ARE GONE FROM HERE ON PURPOSE, AND RE-ADDING THEM WOULD BE A
	// SILENT REGRESSION RATHER THAN A MERGE. `sandbox_suspended`, `sandbox_busy`,
	// `data_validation_failed`, `not_resumable`, `sandbox_admin_suspended` and `lint_failed` are now
	// catalogued in `OFF_PATH_REFUSAL_MESSAGES` above; this Map and `VALIDATION_MESSAGES` are
	// DISJOINT by contract (see this Map's header and `error-message.test.ts`'s disjointness case), so
	// a re-added entry here would claim coverage and non-coverage at once and turn the whole-tree
	// contract into a wrong GREEN. A rebase that brings the old entries back has taken a side, not a
	// union.

	// ── the one 503, and the only entry here that is not a 400/422/409 ───────────────────────────
	// ⛔ THE REGISTER IS NOT SCOPED BY STATUS, WHICH IS WHY THIS SITS IN THE SAME MAP.
	// `error-message.backend-contract.test.ts`'s 503 describe reads this Map as the second home for a
	// 503 code, exactly as the whole-tree 400/422/409 half does, and the rot-guard that greps
	// `backend/src` for every member does not care what status a code is. A second register keyed by
	// status would be a second thing to rot for no gain.
	//
	// ⚠️ THIS ENTRY WAS DELETED AND RESTORED, AND THE ROUND TRIP IS THE LESSON. It was replaced by
	// eight locales of `error_signup_queue_full` copy in `SERVICE_UNAVAILABLE_MESSAGES` on the
	// argument that "the 503 contract should be satisfied by copy rather than by silence" and that
	// "the sentence already exists on the day that catch is changed". Both are wrong under this
	// register's own header — AN ENTRY HERE IS A CLAIM, NOT A PARKING SPACE, and a catalogue entry is
	// a claim too: that a reader meets the refusal. Nobody does. The copy rendered nowhere in any of
	// the eight locales, and the code was simultaneously catalogued AND registered-as-uncatalogued,
	// which the 503 describe's own DISJOINT case forbids. The contract the register header states —
	// catalogued OR honestly registered, with no third state — is what the 503 arm asserts, so an
	// honest register entry satisfies it and dead copy is not needed to.
	[
		'signup_queue_full',
		'unreachable by any reader: the 503 from the self-signup queue TOTAL cap (`SIGNUP_QUEUE_MAX_PENDING`, default 500, backend/src/services/onboarding-service.ts:signupQueueLimits) on POST /api/signup-approvals/notify-self, thrown at routes/onboarding.ts:198. Its ONLY SPA caller is `void adminApi.notifySelf(…).catch(() => {})` on the login bootstrap (frontend/src/lib/stores/auth.svelte.ts:86) — fire-and-forget BY DESIGN so a queue outage can never block a login, so the refusal is swallowed with no store field, no render and no screen in any of the 8 locales. Localized copy for it would be copy nothing renders. If that catch is ever changed to surface the failure, delete this entry and add a SERVICE_UNAVAILABLE_MESSAGES entry in the SAME change'
	],

	// ⛔ THE SECOND 503, AND IT IS UNREACHABLE BY A STRICTLY STRONGER ARGUMENT THAN ITS SIBLING —
	// which is why it gets its own entry rather than a shrug at the one above. `signup_queue_full`
	// is unreachable because the ONE call site swallows it. This code is unreachable for that reason
	// AND because that call site can never provoke it in the first place: it is only ever thrown to a
	// caller who is NEITHER authenticated NOR domain-matched (backend/src/routes/onboarding.ts:165,
	// `authenticated || matched !== null`), and `adminApi.notifySelf` goes through `authFetch`
	// (frontend/src/lib/api/admin.ts:332) on the login bootstrap, i.e. always with a bearer token the
	// backend has just accepted. An SPA reader is on the reserved side of this quota by construction.
	// The refusal exists for the raw-HTTP sprayer, and a sprayer reads no localized sentence.
	//
	// ⚠️ IT IS ALSO THE ARM THAT MUST NOT BE COLLAPSED INTO ITS SIBLING'S COPY IF EITHER IS EVER
	// SURFACED. "Sign-up is temporarily closed" is TRUE for `signup_queue_full` and FALSE here:
	// matched and authenticated signups are still being accepted, and telling a customer's employee
	// the door is shut when it is open for them is a worse answer than the generic fallback.
	// Early-access Turnstile (backend/src/services/turnstile.ts `enforceTurnstile`). Neither 503 can
	// reach an SPA reader: `turnstile_unconfigured` is thrown only when the token is MANDATORY, i.e.
	// for an ANONYMOUS notify-self (routes/onboarding.ts, `requireToken: caller === null`), and
	// `turnstile_unavailable` only when a token was SENT — the SPA's single caller,
	// `void adminApi.notifySelf(…).catch(() => {})` on the login bootstrap (stores/auth.svelte.ts),
	// is authenticated and sends no `turnstileToken`, and swallows every failure besides. The other
	// caller is the server-to-server POST /api/signup-approvals/intake, whose reader is a service.
	[
		'turnstile_unconfigured',
		'unreachable by any SPA reader: thrown by services/turnstile.ts only when TURNSTILE_REQUIRED=true without TURNSTILE_SECRET AND the caller is anonymous (routes/onboarding.ts notify-self `requireToken: caller === null`); the SPA only ever calls notify-self authenticated (stores/auth.svelte.ts login bootstrap, fire-and-forget `.catch(() => {})`). A public form renders its own copy'
	],
	[
		'turnstile_unavailable',
		'unreachable by any SPA reader: thrown by services/turnstile.ts only when a `turnstileToken` was sent and siteverify failed; the SPA never sends one (lib/api/admin.ts notifySelf body is {email, name}) and its only call is fire-and-forget (stores/auth.svelte.ts). The intake caller is a server (website backend / signup chat)'
	],
	[
		'signup_queue_anonymous_full',
		'unreachable by any reader, twice over: the 503 from the ANONYMOUS sub-quota on the self-signup queue (`SIGNUP_QUEUE_MAX_ANON_PENDING`, default 80% of the total cap, backend/src/services/onboarding-service.ts:signupQueueLimits), thrown at routes/onboarding.ts:192. (a) It is only ever thrown to a caller who is neither authenticated nor domain-matched, and the only SPA caller — `void adminApi.notifySelf(…).catch(() => {})` on the login bootstrap (frontend/src/lib/stores/auth.svelte.ts:86) — reaches the route through `authFetch` (lib/api/admin.ts:332) with a bearer token, so it is on the RESERVED side of the quota by construction and cannot provoke this code at all; (b) that same caller swallows every failure fire-and-forget so a queue outage can never block a login. No store field, no render, no screen, in any of the 8 locales. If a public (token-less) signup form is ever added, this becomes reachable — catalogue it THEN, with a sentence that says matched/authenticated signups are still open, and delete this entry in the same change'
	]
]);
