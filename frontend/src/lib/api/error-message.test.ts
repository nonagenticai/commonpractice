// Unit test for licenseOrPermissionMessage / errorText — the 402/403/409 → localized-copy mapper.
// Mocks the paraglide messages module so the test asserts the MAPPING (which message is chosen per
// status/code), not the catalog text.
import { describe, it, expect, vi } from 'vitest';

// Every key the mapper can reach, stubbed to a unique sentinel. A missing stub here would surface
// as `undefined` in the assertions below rather than silently passing.
vi.mock('$lib/paraglide/messages', () => ({
	error_license_required: () => 'LICENSE_REQUIRED',
	error_license_inactive: () => 'LICENSE_INACTIVE',
	error_license_expired: () => 'LICENSE_EXPIRED',
	error_license_unavailable: () => 'LICENSE_UNAVAILABLE',
	error_license_unreadable: () => 'LICENSE_UNREADABLE',
	error_forbidden: () => 'FORBIDDEN',
	error_seat_limit_reached: () => 'SEAT_LIMIT',
	error_license_app_mismatch: () => 'LICENSE_APP_MISMATCH',
	error_license_tenant_mismatch: () => 'LICENSE_TENANT_MISMATCH',
	error_developer_required: () => 'DEVELOPER_REQUIRED',
	error_super_admin_required: () => 'SUPER_ADMIN_REQUIRED',
	error_admin_required: () => 'ADMIN_REQUIRED',
	error_tenant_admin_required: () => 'TENANT_ADMIN_REQUIRED',
	error_data_manager_required: () => 'DATA_MANAGER_REQUIRED',
	error_ontology_manager_required: () => 'ONTOLOGY_MANAGER_REQUIRED',
	error_tenant_id_claim_required: () => 'TENANT_ID_CLAIM_REQUIRED',
	error_tenant_not_provisioned: () => 'TENANT_NOT_PROVISIONED',
	error_tenant_scope_mismatch: () => 'TENANT_SCOPE_MISMATCH',
	error_user_offboarded: () => 'USER_OFFBOARDED',
	error_flow_not_owner: () => 'FLOW_NOT_OWNER',
	error_fr_feedback_forbidden: () => 'FR_FEEDBACK_FORBIDDEN',
	error_challenge_closed: () => 'CHALLENGE_CLOSED',
	// The rest of the `/build` submit-path refusals — see VALIDATION_MESSAGES.
	error_challenge_not_found: () => 'CHALLENGE_NOT_FOUND',
	error_flow_not_found: () => 'FLOW_NOT_FOUND',
	error_flow_archived: () => 'FLOW_ARCHIVED',
	error_flow_invalid: () => 'FLOW_INVALID',
	// ⛔ THE SIX THAT NAME THE OFFENDER take a `{block}` parameter, and the sentinel ECHOES IT. A
	// sentinel that ignored the parameter would pass every assertion below while the real catalog
	// dropped the name — the exact loss these six entries exist to prevent.
	error_missing_block_version: (i: { block: string }) => `MISSING_BLOCK_VERSION:${i.block}`,
	error_block_version_mismatch: (i: { block: string }) => `BLOCK_VERSION_MISMATCH:${i.block}`,
	error_block_archived: (i: { block: string }) => `BLOCK_ARCHIVED:${i.block}`,
	error_block_version_unpublished: (i: { block: string }) => `BLOCK_VERSION_UNPUBLISHED:${i.block}`,
	error_policy_network_blocked: (i: { block: string }) => `POLICY_NETWORK_BLOCKED:${i.block}`,
	error_policy_pii_violation: (i: { block: string }) => `POLICY_PII_VIOLATION:${i.block}`,
	error_validation: () => 'VALIDATION',
	error_invalid_json: () => 'INVALID_JSON',
	error_invalid_input: () => 'INVALID_INPUT',
	error_delivery_already_live: () => 'DELIVERY_ALREADY_LIVE',
	error_empty_allowlist: () => 'EMPTY_ALLOWLIST',

	// ⛔ THE TENANT-ADMIN LANE. Seventeen codes moved out of `NOT_LOCALIZED_CODES` into
	// `VALIDATION_MESSAGES`; the sentinels for the ones that carry a value ECHO it, for the reason the
	// six `{block}` stubs above record — a sentinel that swallowed its parameter would pass every
	// assertion here while the real catalog dropped the name.
	error_last_admin: () => 'LAST_ADMIN',
	error_cannot_offboard_self: () => 'CANNOT_OFFBOARD_SELF',
	error_user_offboarded_conflict: () => 'USER_OFFBOARDED_CONFLICT',
	error_email_exists: () => 'EMAIL_EXISTS',
	error_email_exists_other_workspace: () => 'EMAIL_EXISTS_OTHER_WORKSPACE',
	error_email_exists_orphan: () => 'EMAIL_EXISTS_ORPHAN',
	error_idp_exists: () => 'IDP_EXISTS',
	error_invalid_model: (i: { model: string; provider: string }) =>
		`INVALID_MODEL:${i.model}:${i.provider}`,
	error_model_not_allowlisted: (i: { model: string }) => `MODEL_NOT_ALLOWLISTED:${i.model}`,
	error_api_key_required: (i: { provider: string }) => `API_KEY_REQUIRED:${i.provider}`,
	error_api_key_required_vendor_changed: (i: { provider: string }) =>
		`API_KEY_REQUIRED_VENDOR_CHANGED:${i.provider}`,
	error_delivery_target_name_taken: () => 'DELIVERY_TARGET_NAME_TAKEN',
	error_delivery_target_not_configured: () => 'DELIVERY_TARGET_NOT_CONFIGURED',
	error_delivery_not_retriable: () => 'DELIVERY_NOT_RETRIABLE',

	// ⛔ THE DELIVERY SENTENCES ARE REACHED THROUGH `i18n/delivery-error-label.ts`, WHICH IS WHY THESE
	// LOOK LIKE A DIFFERENT FAMILY. `error-message.ts` imports that module rather than re-declaring
	// its switch, so this mock has to stub the keys IT calls — including `delivery_kind_*`, which is
	// how a `{ kind }` off the wire becomes the `{tool}` noun inside every sentence below. Four of
	// them (`delivery_error_target_incomplete`, `_credentials_missing`, `_credentials_invalid`,
	// `_egress_bad_target`) were minted for the delivery-LEDGER column and are REUSED, not duplicated
	// — the shared sentinels are what makes that provable rather than asserted.
	delivery_kind_jira: () => 'Jira',
	delivery_kind_azure_devops: () => 'ADO',
	delivery_kind_fr: () => 'FR',
	delivery_error_target_incomplete: (i: { tool: string }) => `TARGET_INCOMPLETE:${i.tool}`,
	delivery_error_incomplete_base_url: (i: { tool: string }) => `INCOMPLETE_BASE_URL:${i.tool}`,
	delivery_error_incomplete_project_key: (i: { tool: string }) => `INCOMPLETE_PROJECT_KEY:${i.tool}`,
	delivery_error_credentials_missing: (i: { tool: string }) => `CREDENTIALS_MISSING:${i.tool}`,
	delivery_error_credentials_invalid: (i: { tool: string }) => `CREDENTIALS_INVALID:${i.tool}`,
	delivery_error_credentials_undecryptable: (i: { tool: string }) =>
		`CREDENTIALS_UNDECRYPTABLE:${i.tool}`,
	delivery_error_credentials_malformed: (i: { tool: string }) => `CREDENTIALS_MALFORMED:${i.tool}`,
	delivery_error_egress_bad_target: (i: { tool: string }) => `EGRESS_BAD_TARGET:${i.tool}`,

	// ⛔ THE TEN REUSED KEYS, AND THE SENTINELS ARE WHAT MAKE "REUSED" PROVABLE. These were minted by
	// the connection-test lane for the 200-OK `POST /api/connectors/test` path
	// (`i18n/connection-test-label.ts`); the 400 path is the same eight sentences in a different
	// envelope. `reuses the connection-test keys …` below asserts the SAME sentinels come back
	// through `writeErrorText`, which is the only mechanical way to tell reuse from a second key
	// family whose English happens to match.
	bad_config_required: (i: { field: string }) => `BAD_CONFIG_REQUIRED:${i.field}`,
	bad_config_percent_escape: (i: { field: string }) => `BAD_CONFIG_PERCENT_ESCAPE:${i.field}`,
	bad_config_backslash: (i: { field: string }) => `BAD_CONFIG_BACKSLASH:${i.field}`,
	bad_config_dot_segment: (i: { field: string }) => `BAD_CONFIG_DOT_SEGMENT:${i.field}`,
	bad_config_absolute: (i: { field: string }) => `BAD_CONFIG_ABSOLUTE:${i.field}`,
	bad_config_postgres_scheme: () => 'BAD_CONFIG_POSTGRES_SCHEME',
	bad_config_http_scheme: () => 'BAD_CONFIG_HTTP_SCHEME',
	bad_config_key_escapes_bucket: (i: { resolved: string }) => `BAD_CONFIG_KEY_ESCAPES:${i.resolved}`,
	unknown_connector: (i: { kind: string }) => `UNKNOWN_CONNECTOR:${i.kind}`,
	unknown_connector_generic: () => 'UNKNOWN_CONNECTOR_GENERIC',

	// ⛔ EVERY PARAMETERISED STUB ECHOES ITS PARAMETER, for the reason the six `{block}` stubs above
	// already record: a sentinel that ignores its input passes every assertion in this file while the
	// real catalog silently drops the value. That is not hypothetical here — 21 of the 63 new keys
	// carry a name, a slug, an id or a figure, and dropping one is the exact information loss the
	// whole map exists to avoid.
	error_storage_format_unknown: (i: { key: string }) => `STORAGE_FORMAT_UNKNOWN:${i.key}`,
	error_empty_query: () => 'EMPTY_QUERY',
	error_multi_statement: () => 'MULTI_STATEMENT',
	error_not_select: () => 'NOT_SELECT',
	error_csv_no_header: () => 'CSV_NO_HEADER',
	error_json_invalid: () => 'JSON_INVALID',
	error_sql_empty: () => 'SQL_EMPTY',
	error_sql_json_invalid: () => 'SQL_JSON_INVALID',
	error_xlsx_too_large: (i: { actualMb: string; limitMb: string }) =>
		`XLSX_TOO_LARGE:${i.actualMb}/${i.limitMb}`,
	error_xlsx_unreadable: () => 'XLSX_UNREADABLE',
	error_xlsx_no_sheet: () => 'XLSX_NO_SHEET',
	error_xlsx_no_header: () => 'XLSX_NO_HEADER',
	error_xlsx_no_file: () => 'XLSX_NO_FILE',
	error_dataset_too_large_input: (i: { actualMb: string; limitMb: string }) =>
		`DATASET_TOO_LARGE_INPUT:${i.actualMb}/${i.limitMb}`,
	error_dataset_too_large_file: (i: { limitMb: string }) => `DATASET_TOO_LARGE_FILE:${i.limitMb}`,
	error_unknown_source_type: (i: { sourceType: string }) => `UNKNOWN_SOURCE_TYPE:${i.sourceType}`,
	error_no_file: () => 'NO_FILE',
	error_dataset_empty: () => 'DATASET_EMPTY',
	error_duplicate_column: () => 'DUPLICATE_COLUMN',
	error_columns_mismatch: () => 'COLUMNS_MISMATCH',
	error_bucket_convention_name_required: () => 'BUCKET_NAME_REQUIRED',
	error_bucket_convention_name_too_long: () => 'BUCKET_NAME_TOO_LONG',
	error_bucket_convention_webhook_needs_cp_bucket: () => 'BUCKET_WEBHOOK_NEEDS_CP',
	error_bucket_convention_not_cp_bucket: (i: { bucket: string }) => `BUCKET_NOT_CP:${i.bucket}`,
	error_shared_secret: () => 'SHARED_SECRET',
	error_not_webhook: () => 'NOT_WEBHOOK',
	error_notifications_disabled: () => 'NOTIFICATIONS_DISABLED',
	error_not_storage_webhook_register: () => 'NOT_STORAGE_WEBHOOK_REGISTER',
	error_not_storage_webhook_read: () => 'NOT_STORAGE_WEBHOOK_READ',
	error_industry_required_entity_scope: () => 'INDUSTRY_REQUIRED_ENTITY_SCOPE',
	error_industry_required_query_param: () => 'INDUSTRY_REQUIRED_QUERY_PARAM',
	error_department_required_entity_scope: () => 'DEPARTMENT_REQUIRED_ENTITY_SCOPE',
	error_department_required_query_param: () => 'DEPARTMENT_REQUIRED_QUERY_PARAM',
	error_cell_required: () => 'CELL_REQUIRED',
	error_name_required: () => 'NAME_REQUIRED',
	error_bad_endpoint: () => 'BAD_ENDPOINT',
	error_predicate_required: () => 'PREDICATE_REQUIRED',
	error_self_edge: () => 'SELF_EDGE',
	error_relation_exists: () => 'RELATION_EXISTS',
	error_not_global: () => 'NOT_GLOBAL',
	error_bad_locale: () => 'BAD_LOCALE',
	error_mapping_dataset_mismatch: () => 'MAPPING_DATASET_MISMATCH',
	error_no_primary_sample: () => 'NO_PRIMARY_SAMPLE',
	error_duplicate_attribute: (i: { attribute: string }) => `DUPLICATE_ATTRIBUTE:${i.attribute}`,
	error_entity_exists: (i: { name: string }) => `ENTITY_EXISTS:${i.name}`,
	error_derived_lint_failed: (i: { findings: string }) => `DERIVED_LINT_FAILED:${i.findings}`,
	error_slug_taken: (i: { slug: string }) => `SLUG_TAKEN:${i.slug}`,
	error_slug_reserved_global: (i: { slug: string }) => `SLUG_RESERVED_GLOBAL:${i.slug}`,
	error_version_exists: (i: { version: string }) => `VERSION_EXISTS:${i.version}`,
	error_not_a_draft: (i: { version: string; status: string }) =>
		`NOT_A_DRAFT:${i.version}/${i.status}`,
	error_tests_required: () => 'TESTS_REQUIRED',
	error_tests_failing: () => 'TESTS_FAILING',
	error_test_name_taken: (i: { test: string; block: string }) =>
		`TEST_NAME_TAKEN:${i.test}/${i.block}`,
	error_template_name_taken: (i: { name: string }) => `TEMPLATE_NAME_TAKEN:${i.name}`,
	error_bad_category: (i: { categories: string }) => `BAD_CATEGORY:${i.categories}`,
	error_voting_closed_challenge: () => 'VOTING_CLOSED_CHALLENGE',
	error_voting_closed_solution: () => 'VOTING_CLOSED_SOLUTION',
	error_unknown_node_connect_endpoint: () => 'UNKNOWN_NODE_CONNECT_ENDPOINT',
	error_unknown_node_not_found: (i: { node: string }) => `UNKNOWN_NODE_NOT_FOUND:${i.node}`,
	error_unknown_edge: (i: { edge: string }) => `UNKNOWN_EDGE:${i.edge}`,
	error_agent_token_no_tenant: () => 'AGENT_TOKEN_NO_TENANT',
	error_invalid_challenge_id: () => 'INVALID_CHALLENGE_ID',
	error_dataset_not_found: (i: { slug: string }) => `DATASET_NOT_FOUND:${i.slug}`,

	// ⛔ THE RUN-PATH + SOURCE-GATE LANE. Six codes moved out of `NOT_LOCALIZED_CODES`, where every
	// reason already read "deferred (⚠️ NOT admin-only)". `error_lint_failed` ECHOES its transcript
	// for the reason the whole mock records: a sentinel that swallowed `{findings}` would pass the
	// "renders like derived_lint_failed" case below while the real catalog dropped the one piece of
	// text on the screen worth reading.
	error_lint_failed: (i: { findings: string }) => `LINT_FAILED:${i.findings}`,
	error_sandbox_busy: () => 'SANDBOX_BUSY',
	error_sandbox_suspended: () => 'SANDBOX_SUSPENDED',
	error_sandbox_suspended_idle: () => 'SANDBOX_SUSPENDED_IDLE',
	error_sandbox_suspended_admin: () => 'SANDBOX_SUSPENDED_ADMIN',
	error_data_validation_failed: () => 'DATA_VALIDATION_FAILED',
	error_not_resumable: () => 'NOT_RESUMABLE',
	error_sandbox_admin_suspended: () => 'SANDBOX_ADMIN_SUSPENDED',

	// ⛔ THE TENANT-LIFECYCLE LANE — four codes across FOUR different status classes, which is why
	// they are stubbed as a block rather than filed under the families above. `tenant_suspended` is a
	// 403 (FORBIDDEN_MESSAGES), `tenant_status_unavailable` a 503 (SERVICE_UNAVAILABLE_MESSAGES —
	// a status this module had no branch for at all until this lane), `tenant_offboarded` a 409 and
	// `confirm_mismatch` a 400 (both VALIDATION_MESSAGES, via OFF_PATH_REFUSAL_MESSAGES).
	//
	// ⚠️ FOUR DISTINCT SENTINELS, AND THE DISTINCTNESS IS ASSERTED further down: the whole hazard of a
	// four-status family is that one of them quietly resolves through a neighbouring branch and lands
	// on the generic copy, which `.toBe('TENANT_SUSPENDED')` would catch but `.not.toBeNull()` would
	// not.
	error_tenant_suspended: () => 'TENANT_SUSPENDED',
	error_tenant_status_unavailable: () => 'TENANT_STATUS_UNAVAILABLE',
	error_tenant_offboarded: () => 'TENANT_OFFBOARDED',
	error_confirm_mismatch: () => 'CONFIRM_MISMATCH'
}));

// ⛔ THE RUNTIME IS MOCKED SEPARATELY FROM THE MESSAGES, AND NOT MOCKING IT WOULD BE A REAL FAILURE.
// `error-message.ts` reads the reader's locale through paraglide's `getLocale()` for the three
// figures it formats (`readerLocale`). Unmocked, paraglide resolves through its strategies and reads
// `localStorage` directly — absent in this vitest node environment. `readerLocale` catches that and
// falls back to 'en', so the suite would still pass, but it would be exercising the CATCH on every
// call and the two number assertions below would prove nothing about the happy path. Pinning 'en'
// makes the expected strings ("62", "12.3") the ones a real English reader gets.
vi.mock('$lib/paraglide/runtime', () => ({ getLocale: () => 'en' }));

import { iso } from '$lib/test/bidi';
import {
	licenseOrPermissionMessage,
	errorText,
	writeErrorText,
	KNOWN_FORBIDDEN_CODES,
	NON_SUBMIT_PATH_CODES,
	NOT_LOCALIZED_CODES,
	VALIDATION_MESSAGE_CODES,
	type ForbiddenCode
} from './error-message';

/** U+2068 FIRST STRONG ISOLATE / U+2069 POP DIRECTIONAL ISOLATE — what `iso()` wraps a value in. */
const FSI = '⁨';
const PDI = '⁩';
/** The isolated form of a foreign value, as it appears inside a sentinel. */
const wrapped = (v: string) => `${FSI}${v}${PDI}`;

/**
 * Every 403 code the backend can emit, paired with the sentinel it must resolve to.
 *
 * This is the guard that the ticket existed for: `licenseOrPermissionMessage` used to collapse
 * ALL of these into `m.error_forbidden()`, so a member who could not edit the ontology was told
 * "You don't have permission to do that." and nothing else. Typed as ForbiddenCode so a code
 * dropped from the union (or misspelled here) fails `bun run check`.
 */
const FORBIDDEN_CASES: [ForbiddenCode, string][] = [
	['license_app_mismatch', 'LICENSE_APP_MISMATCH'],
	['license_tenant_mismatch', 'LICENSE_TENANT_MISMATCH'],
	['developer_required', 'DEVELOPER_REQUIRED'],
	['tenant_id_claim_required', 'TENANT_ID_CLAIM_REQUIRED'],
	['super_admin_required', 'SUPER_ADMIN_REQUIRED'],
	['admin_required', 'ADMIN_REQUIRED'],
	['tenant_not_provisioned', 'TENANT_NOT_PROVISIONED'],
	['tenant_admin_required', 'TENANT_ADMIN_REQUIRED'],
	['tenant_scope_mismatch', 'TENANT_SCOPE_MISMATCH'],
	// backend/src/middleware/tenant-status-gate.ts — the whole workspace was suspended by a platform
	// operator. Listed HERE, in the typed table, rather than only in the tenant-lifecycle describe
	// below: the array is `[ForbiddenCode, string][]`, so a code dropped from the union or misspelled
	// is a `bun run check` failure, and the `no flattening` assertion under this table is what proves
	// it did not silently take the generic `FORBIDDEN` copy.
	['tenant_suspended', 'TENANT_SUSPENDED'],
	['fr_feedback_forbidden', 'FR_FEEDBACK_FORBIDDEN'],
	['data_manager_required', 'DATA_MANAGER_REQUIRED'],
	['ontology_manager_required', 'ONTOLOGY_MANAGER_REQUIRED'],
	['flow_not_owner', 'FLOW_NOT_OWNER'],
	['user_offboarded', 'USER_OFFBOARDED'],
	// The backend's own catch-all code deliberately shares the generic copy.
	['forbidden', 'FORBIDDEN']
];

describe('licenseOrPermissionMessage', () => {
	it('maps each 402 license code to its message', () => {
		expect(licenseOrPermissionMessage({ status: 402, code: 'license_inactive' })).toBe('LICENSE_INACTIVE');
		expect(licenseOrPermissionMessage({ status: 402, code: 'license_expired' })).toBe('LICENSE_EXPIRED');
		expect(licenseOrPermissionMessage({ status: 402, code: 'license_unavailable' })).toBe('LICENSE_UNAVAILABLE');
	});

	it('⛔ license_unreadable gets its OWN copy — not the default, and not the outage copy', () => {
		// The backend emits this when the tenant's stored licence blob will not decrypt. The default
		// branch below would say "your workspace doesn't have an active licence" (an accusation, and
		// false — a blob exists); LICENSE_UNAVAILABLE would say "try again shortly" (a promise, and
		// false — the fault is standing until an operator repairs the key). Both assertions are the
		// point; the first alone would pass if the case were routed to `error_license_unavailable`.
		const msg = licenseOrPermissionMessage({ status: 402, code: 'license_unreadable' });
		expect(msg).toBe('LICENSE_UNREADABLE');
		expect(msg).not.toBe('LICENSE_REQUIRED');
		expect(msg).not.toBe('LICENSE_UNAVAILABLE');
	});

	it('falls back to license_required for license_required and any unknown 402', () => {
		expect(licenseOrPermissionMessage({ status: 402, code: 'license_required' })).toBe('LICENSE_REQUIRED');
		expect(licenseOrPermissionMessage({ status: 402 })).toBe('LICENSE_REQUIRED');
		expect(licenseOrPermissionMessage({ status: 402, code: 'something_else' })).toBe('LICENSE_REQUIRED');
	});

	describe('403 codes', () => {
		for (const [code, expected] of FORBIDDEN_CASES) {
			it(`maps ${code}`, () => {
				expect(licenseOrPermissionMessage({ status: 403, code })).toBe(expected);
			});
		}

		it('gives every non-catch-all 403 code its OWN copy (no flattening)', () => {
			const distinct = FORBIDDEN_CASES.filter(([c]) => c !== 'forbidden').map(([, v]) => v);
			expect(new Set(distinct).size).toBe(distinct.length);
			// …and none of them is the generic message.
			expect(distinct).not.toContain('FORBIDDEN');
		});

		it('degrades to the generic copy for an unknown or absent code', () => {
			// A backend rename must not crash or return undefined.
			expect(licenseOrPermissionMessage({ status: 403, code: 'renamed_upstream' })).toBe('FORBIDDEN');
			expect(licenseOrPermissionMessage({ status: 403 })).toBe('FORBIDDEN');
		});

		it('does not resolve inherited Object.prototype keys as codes', () => {
			expect(licenseOrPermissionMessage({ status: 403, code: 'toString' })).toBe('FORBIDDEN');
			expect(licenseOrPermissionMessage({ status: 403, code: 'constructor' })).toBe('FORBIDDEN');
		});
	});

	it('maps the seat-cap 409 — the only 409 an SSO/JIT first login can hit', () => {
		expect(licenseOrPermissionMessage({ status: 409, code: 'seat_limit_reached' })).toBe('SEAT_LIMIT');
		// Every other 409 (last_admin, approval_not_pending, idp_exists…) keeps its own copy.
		expect(licenseOrPermissionMessage({ status: 409, code: 'last_admin' })).toBeNull();
		expect(licenseOrPermissionMessage({ status: 409 })).toBeNull();
	});

	describe('the 401 agent-session code — the copilot’s stale-token refusal', () => {
		// ⛔ THE SUCCESSOR TO `no_home_tenant`, AND IT CHANGED STATUS CLASS, WHICH IS THE WHOLE REASON
		// IT NEEDED A NEW BRANCH. routes/agent.ts used to answer a tenant-less copilot with a 400
		// `badRequest('no_home_tenant', …)`, so `writeErrorText`'s 400 arm found it in
		// `VALIDATION_MESSAGES`. It now answers 401 `agent_token_no_tenant` (routes/agent.ts:129,
		// :264, routes/mcp.ts:111) — and `writeErrorText` routes by STATUS before it looks at the
		// code, so a `VALIDATION_MESSAGES` entry for it would have been unreachable copy that no
		// assertion in either project could contradict.
		it('maps agent_token_no_tenant instead of the generic chat failure', () => {
			expect(licenseOrPermissionMessage({ status: 401, code: 'agent_token_no_tenant' })).toBe(
				'AGENT_TOKEN_NO_TENANT'
			);
			// …and through the wrapper the copilot bubble actually calls.
			expect(
				writeErrorText(
					{
						status: 401,
						code: 'agent_token_no_tenant',
						message: 'This copilot session predates workspace-scoped tokens. Reload to start a new one.'
					},
					'FALLBACK'
				)
			).toBe('AGENT_TOKEN_NO_TENANT');
		});

		it('⛔ every OTHER 401 still returns null — the arm is a lookup, not a status sweep', () => {
			// The expired-Keycloak-session 401 belongs to the route auth gate, and /audit, /ontology
			// and /(tenant)/usage each branch on `status === 401` to latch their own `denied` state.
			// A blanket 401 answer would hand all of them a copilot sentence and take their fallback
			// away — the same narrowness `SERVICE_UNAVAILABLE_MESSAGES` documents for 503.
			expect(licenseOrPermissionMessage({ status: 401, code: 'unauthorized' })).toBeNull();
			expect(licenseOrPermissionMessage({ status: 401 })).toBeNull();
			expect(licenseOrPermissionMessage({ status: 401, code: 'toString' })).toBeNull();
			expect(errorText({ status: 401, code: 'unauthorized', message: 'x' }, 'FALLBACK')).toBe(
				'FALLBACK'
			);
		});
	});

	it('returns null for non-license/permission errors so callers keep their own fallback', () => {
		expect(licenseOrPermissionMessage({ status: 500 })).toBeNull();
		expect(licenseOrPermissionMessage(new Error('boom'))).toBeNull();
		expect(licenseOrPermissionMessage(undefined)).toBeNull();
		expect(licenseOrPermissionMessage('plain string')).toBeNull();
	});
});

describe('errorText', () => {
	it('prefers the mapped licence/permission copy over the caller fallback', () => {
		expect(errorText({ status: 403, code: 'developer_required' }, 'FALLBACK')).toBe('DEVELOPER_REQUIRED');
		expect(errorText({ status: 402, code: 'license_expired' }, 'FALLBACK')).toBe('LICENSE_EXPIRED');
	});

	it('uses the fallback for everything else — including a raw backend 500 message', () => {
		expect(errorText(new Error('relation "foo" does not exist'), 'FALLBACK')).toBe('FALLBACK');
		expect(errorText({ status: 422, code: 'validation' }, 'FALLBACK')).toBe('FALLBACK');
		expect(errorText(undefined, 'FALLBACK')).toBe('FALLBACK');
	});
});

describe('writeErrorText', () => {
	it('prefers the backend message on a 400/422 validation failure', () => {
		expect(
			writeErrorText(
				{ status: 400, code: 'bucket_convention', message: 'dataset name is too long for a bucket' },
				'FALLBACK'
			)
		).toBe('dataset name is too long for a bucket');
		expect(
			writeErrorText(
				{ status: 422, code: 'dataset_not_found', message: "No dataset 'x' in the org's test data" },
				'FALLBACK'
			)
		).toBe("No dataset 'x' in the org's test data");
	});

	describe('the 422 code lookup — the narrow exception to "prefer the backend message"', () => {
		it('⛔ challenge_closed gets LOCALIZED copy, not the English sentence off the wire', () => {
			// `POST /api/solutions` against a challenge whose cycle is over. The backend message is a
			// genuinely useful English sentence — which is exactly the problem: it is aimed at an
			// ordinary author who has just finished a build, it quotes a raw id and two ISO week
			// tokens, and seven of the eight locales cannot read it. Same call as `seat_limit_reached`.
			//
			// Red by deleting the `VALIDATION_MESSAGES` lookup: the raw message wins, because
			// `isUselessMessage` (correctly) calls it useful.
			expect(
				writeErrorText(
					{
						status: 422,
						code: 'challenge_closed',
						message:
							"Challenge 'ch-1' competed in cycle 2026-W21, which is over — it takes no new solutions. Pick a challenge from the current cycle (2026-W33) instead."
					},
					'FALLBACK'
				)
			).toBe('CHALLENGE_CLOSED');
		});

		it('⚠️ every OTHER 400/422 code still keeps the backend sentence', () => {
			// The mirror, and the reason the map is a `Record<string, …>` and not an exhaustive union:
			// 400/422 codes are open-ended and an unlisted one MUST fall through. Red by localizing
			// 422 wholesale.
			//
			// ⚠️ THE EXAMPLE HAD TO CHANGE, AND THE REASON IS THE POINT OF THE WHOLE MAP. This used
			// `challenge_not_found` — which is now catalogued, because it IS one of the refusals
			// `POST /api/solutions` puts in front of an author. A developer-shaped 422 is the right
			// example: `dataset_not_found` names a value the reader typed, so the backend's sentence
			// is strictly more useful than any static translation could be.
			expect(
				writeErrorText(
					{ status: 422, code: 'dataset_not_found', message: "No dataset 'x' in the org's test data" },
					'FALLBACK'
				)
			).toBe("No dataset 'x' in the org's test data");
		});

		/**
		 * ⛔ THE DEFECT THIS BLOCK EXISTS FOR: a Dutch author pressed Submit on /build and was shown
		 * the backend's English prose verbatim. Every code below is one `POST /api/solutions` can
		 * refuse with (derived, with file:line, by error-message.backend-contract.test.ts), paired
		 * with the English string that used to reach the screen.
		 *
		 * Each case asserts BOTH directions — the localized sentinel wins AND the wire string does
		 * not — because `.toBe(SENTINEL)` alone would still pass if the wire string happened to be
		 * empty and the fallback chain produced the sentinel some other way.
		 */
		const BLOCK = 'llm-summarize';
		/**
		 * The slug AS `naming` INTERPOLATES IT — inside one FSI…PDI bidi isolate.
		 *
		 * ⛔ NOT COSMETIC, AND NOT SAFE TO STRIP FROM THESE EXPECTATIONS. `naming` used to interpolate
		 * the raw slug, alone among this file's interpolating helpers; `ar`/`he` embed `{block}` inside
		 * `«…»` in an RTL run, so an unisolated Latin slug is reordered by UAX#9 and the reader is shown
		 * a name that is not the one the backend refused. `i18n/error-message-block-slug.bidi.test.ts`
		 * carries the measurement. Writing `${BLOCK}` here again would re-assert the defect.
		 */
		const ISO_BLOCK = iso(BLOCK);
		/** The `details` bag the backend puts on a refusal that names a block. */
		const NAMED = { nodeId: 'n1', blockId: 'b1', versionId: 'v1', blockSlug: BLOCK };

		const SUBMIT_REFUSALS: [code: string, wire: string, sentinel: string, details: object][] = [
			['challenge_not_found', "No challenge 'ch-9'", 'CHALLENGE_NOT_FOUND', {}],
			['flow_not_found', "No owned flow 'f-1'", 'FLOW_NOT_FOUND', {}],
			['flow_archived', 'An archived flow cannot be submitted', 'FLOW_ARCHIVED', {}],
			['flow_invalid', 'The flow is not ready to publish.', 'FLOW_INVALID', {}],
			['missing_block_version', "Block version 'v-1' is unavailable for node 'llm-summarize'.", `MISSING_BLOCK_VERSION:${ISO_BLOCK}`, NAMED],
			['block_version_mismatch', "Node 'llm-summarize' pins a version that belongs to a different block.", `BLOCK_VERSION_MISMATCH:${ISO_BLOCK}`, NAMED],
			['block_archived', "Block 'llm-summarize' is archived and cannot be published or run.", `BLOCK_ARCHIVED:${ISO_BLOCK}`, NAMED],
			['block_version_unpublished', "Version 3 of 'llm-summarize' has not passed the publish gate.", `BLOCK_VERSION_UNPUBLISHED:${ISO_BLOCK}`, NAMED],
			['policy_network_blocked', "Block 'llm-summarize' needs external HTTP, which is disabled by policy.", `POLICY_NETWORK_BLOCKED:${ISO_BLOCK}`, { policyKey: 'models.external_http', blockSlug: BLOCK }],
			['policy_pii_violation', "PII input 'email' on 'llm-summarize' is fed by a non-mock source.", `POLICY_PII_VIOLATION:${ISO_BLOCK}`, { policyKey: 'data.pii_scrubbing', blockSlug: BLOCK }],
			['validation', 'Request validation failed.', 'VALIDATION', {}],
			['invalid_json', 'Request body is not valid JSON', 'INVALID_JSON', {}],
			['invalid_input', 'A path or query value is not a valid identifier', 'INVALID_INPUT', {}]
		];

		it.each(SUBMIT_REFUSALS)('⛔ %s is localized, not shipped as "%s"', (code, wire, sentinel, details) => {
			const shown = writeErrorText({ status: 422, code, message: wire, details }, 'FALLBACK');
			expect(shown).toBe(sentinel);
			expect(shown).not.toBe(wire);
		});

		it('gives each /build refusal its OWN copy — no flattening onto one sentence', () => {
			// Non-vacuity for the table above: 13 rows that all resolved to the same string would
			// satisfy every assertion in it while telling the author nothing.
			const distinct = SUBMIT_REFUSALS.map(([, , sentinel]) => sentinel);
			expect(new Set(distinct).size).toBe(distinct.length);
		});

		/**
		 * The six refusals whose English NAMED a block. Their localized copy interpolates
		 * `details.blockSlug`; see `ValidationCopy` in error-message.ts for why an absent slug must
		 * NOT resolve to a generic sentence.
		 */
		const NAMING_CODES = SUBMIT_REFUSALS.filter(([, , sentinel]) => sentinel.includes(BLOCK));

		it('the naming set is the six that quoted a block — not zero of them', () => {
			// Non-vacuity for the two tests below: an empty `NAMING_CODES` makes both trivially green.
			expect(NAMING_CODES.map(([code]) => code)).toEqual([
				'missing_block_version',
				'block_version_mismatch',
				'block_archived',
				'block_version_unpublished',
				'policy_network_blocked',
				'policy_pii_violation'
			]);
		});

		it.each(NAMING_CODES)('⛔ %s carries the block name through the translation', (code, _wire, _sentinel, details) => {
			// The half a generic localized sentence would have destroyed: "a block in this flow" is
			// not actionable on a 40-node graph, and the English it replaced DID name the block.
			expect(writeErrorText({ status: 422, code, message: 'x', details }, 'FALLBACK')).toContain(BLOCK);
		});

		it.each(NAMING_CODES)(
			'⚠️ %s with NO blockSlug falls back to the NAMED English, not to anonymous localized copy',
			(code, wire) => {
				// ⛔ THE DOCTRINE APPLIED TO ITSELF, AND THE ONLY REASON `ValidationCopy` returns
				// `string | null`. An older API (or any other route reusing the code) sends no
				// `blockSlug`. Rendering the localized sentence anyway would mean dropping the block's
				// name to gain a translation — trading one information loss for another. The English
				// sentence still NAMES it, so that is what wins.
				const shown = writeErrorText({ status: 422, code, message: wire, details: {} }, 'FALLBACK');
				expect(shown).toBe(wire);
				expect(shown).not.toBe('FALLBACK');
			}
		);

		it('an error with no `details` field at all behaves the same way', () => {
			// The plain `ApiError` (admin/marketplace clients) has no `details` property — `detailsOf`
			// must read that as "no name available" rather than throwing.
			expect(
				writeErrorText({ status: 422, code: 'block_archived', message: 'Block \'x\' is archived.' }, 'FALLBACK')
			).toBe("Block 'x' is archived.");
		});

		it('applies the same lookup on a 400, not only a 422', () => {
			// `invalid_json` and `invalid_input` are `route()`'s own 400s. A map consulted only on 422
			// would leave exactly those two in English while every test above still passed.
			expect(
				writeErrorText({ status: 400, code: 'invalid_json', message: 'Request body is not valid JSON' }, 'FALLBACK')
			).toBe('INVALID_JSON');
		});

		it('does not resolve an Object.prototype key as a message', () => {
			// `hasOwnProperty.call`, not `VALIDATION_MESSAGES[code]`: a code spelled `constructor`
			// would otherwise resolve to a function and be CALLED.
			expect(writeErrorText({ status: 422, code: 'constructor', message: 'real message' }, 'FALLBACK')).toBe(
				'real message'
			);
			expect(writeErrorText({ status: 422, code: 'toString' }, 'FALLBACK')).toBe('FALLBACK');
		});

		it('leaves licenseOrPermissionMessage alone — 422 still returns null there', () => {
			// That null contract is load-bearing (see the function's doc comment): READ paths use plain
			// `errorText` and must keep their own context-specific fallback.
			expect(licenseOrPermissionMessage({ status: 422, code: 'challenge_closed' })).toBeNull();
			expect(errorText({ status: 422, code: 'challenge_closed', message: 'x' }, 'FALLBACK')).toBe('FALLBACK');
		});
	});

	it('still gives localized copy for 402/403 — never the raw backend string', () => {
		expect(
			writeErrorText({ status: 403, code: 'developer_required', message: 'Developer role required' }, 'FALLBACK')
		).toBe('DEVELOPER_REQUIRED');
		expect(
			writeErrorText({ status: 402, code: 'license_expired', message: 'License expired' }, 'FALLBACK')
		).toBe('LICENSE_EXPIRED');
	});

	describe('409 conflict codes — the #165 follow-up (every `conflict()` code is a full, actionable sentence)', () => {
		it('prefers the backend message for an ordinary conflict code', () => {
			// ⚠️ THESE USED TO BE `delivery_target_name_taken` AND `last_admin`, AND THE SWAP IS THE
			// POINT OF THE LANE THAT MOVED THEM: both are now catalogued, so the localized copy wins
			// here and the backend sentence no longer reaches the screen. The assertion still needs a
			// 409 whose code has NO entry, or it would silently stop testing the fall-through — both
			// replacements are live `NOT_LOCALIZED_CODES` members (platform-admin screens).
			expect(
				writeErrorText(
					{
						status: 409,
						code: 'user_belongs_to_another_workspace',
						message: 'This email already belongs to another workspace.'
					},
					'FALLBACK'
				)
			).toBe('This email already belongs to another workspace.');
			expect(
				writeErrorText({ status: 409, code: 'version_exists', message: 'Version 3 already exists' }, 'FALLBACK')
			).toBe('Version 3 already exists');
		});

		it('still gives the LOCALIZED seat-cap copy for seat_limit_reached, never the backend string', () => {
			expect(
				writeErrorText({ status: 409, code: 'seat_limit_reached', message: 'no seats left' }, 'FALLBACK')
			).toBe('SEAT_LIMIT');
		});

		it('falls back to the caller fallback when a 409 message is junk (bare code / empty)', () => {
			// ⚠️ `idp_exists` until this lane; it is catalogued now, so the bare-code message can no
			// longer reach `isUselessMessage` — the localized copy short-circuits first. A still-
			// uncatalogued 409 is what this assertion needs.
			expect(
				writeErrorText(
					{ status: 409, code: 'user_belongs_to_another_workspace', message: 'user_belongs_to_another_workspace' },
					'FALLBACK'
				)
			).toBe('FALLBACK');
			expect(writeErrorText({ status: 409, code: 'entity_exists', message: '' }, 'FALLBACK')).toBe('FALLBACK');
			expect(writeErrorText({ status: 409, code: 'entity_exists' }, 'FALLBACK')).toBe('FALLBACK');
		});
	});

	it('falls back for a 5xx and for a network failure with no status at all', () => {
		expect(writeErrorText({ status: 500, message: 'relation "foo" does not exist' }, 'FALLBACK')).toBe('FALLBACK');
		expect(writeErrorText(new TypeError('Failed to fetch'), 'FALLBACK')).toBe('FALLBACK');
		expect(writeErrorText(undefined, 'FALLBACK')).toBe('FALLBACK');
	});

	describe('ugly-body guards — never surface a non-message as if it were one', () => {
		it('falls back when a body with no `message` left only the bare code as the message', () => {
			// unwrap()'s `body?.message ?? body?.error ?? …` chain reuses the code itself when the
			// response carries no `message` field.
			//
			// ⚠️ THIS USED TO CITE route()'s ZodError BRANCH, AND THAT CITATION WAS STALE — which is
			// half of the /build defect. #165 (2026-07-30) was right that the branch emitted
			// `{ error: 'validation', issues: [...] }` with no `message`; #189 (2026-08-03) added
			// `message: 'Request validation failed.'` to it (backend/src/utils/http.ts). From that
			// commit the guard below stopped firing for `validation` and the English sentence went
			// straight to the screen, with no test in either project noticing. `validation` now has
			// its own catalog entry (asserted above) — this case keeps guarding the SHAPE, on a code
			// that genuinely has no copy.
			expect(writeErrorText({ status: 422, code: 'dataset_not_found', message: 'dataset_not_found' }, 'FALLBACK')).toBe(
				'FALLBACK'
			);
		});

		it('falls back on the synthetic non-JSON-body message (an Istio/ingress error page)', () => {
			expect(
				writeErrorText(
					{ status: 422, code: 'error', message: 'HTTP 422 (non-JSON response: <html>...)' },
					'FALLBACK'
				)
			).toBe('FALLBACK');
		});

		it('falls back on an empty message, "undefined", "null", or "[object Object]"', () => {
			expect(writeErrorText({ status: 400, code: 'x', message: '' }, 'FALLBACK')).toBe('FALLBACK');
			expect(writeErrorText({ status: 400, code: 'x', message: '   ' }, 'FALLBACK')).toBe('FALLBACK');
			expect(writeErrorText({ status: 400, code: 'x', message: 'undefined' }, 'FALLBACK')).toBe('FALLBACK');
			expect(writeErrorText({ status: 400, code: 'x', message: 'null' }, 'FALLBACK')).toBe('FALLBACK');
			expect(writeErrorText({ status: 400, code: 'x', message: '[object Object]' }, 'FALLBACK')).toBe(
				'FALLBACK'
			);
			expect(writeErrorText({ status: 400, code: 'x' }, 'FALLBACK')).toBe('FALLBACK');
		});
	});
});

/**
 * ⛔ THE DEFECT THIS WHOLE BLOCK EXISTS FOR, MEASURED ON `8d36692`: 91 of the 102 400/409/422 codes
 * the product can emit had no `VALIDATION_MESSAGES` entry, so `writeErrorText` rendered the backend's
 * ENGLISH `message` verbatim. A Dutch tenant dropping a spreadsheet on /datasets read `CSV must have
 * a header row with column names` inside a Dutch frame; a Dutch admin naming a connector read
 * `'url' is required`. Reproduced live against the API before this lane started.
 *
 * Every case below is one ORDINARY GESTURE on a tenant screen, paired with the English string that
 * used to reach it. Each asserts BOTH directions — the localized sentinel wins AND the wire string
 * does not — because `.toBe(SENTINEL)` alone would still pass if the wire string were empty and the
 * fallback chain produced the sentinel some other way.
 */
describe('the tenant-reachable 400/422/409 refusal catalog', () => {
	/** `[code, status, wire English, details bag, expected sentinel]`. */
	type Case = [code: string, status: number, wire: string, details: object, sentinel: string];

	// ── one code, several sentences, chosen by details.reason ────────────────────────────────────
	const REASON_SWITCHED: Case[] = [
		// backend/src/datasets/connectors/index.ts + storage.ts — the eight `bad_config` reasons.
		['bad_config', 400, "'url' is required", { reason: 'required', field: 'url' }, `BAD_CONFIG_REQUIRED:${wrapped('url')}`],
		['bad_config', 400, 'key contains an invalid percent-escape', { reason: 'percent_escape', field: 'key' }, `BAD_CONFIG_PERCENT_ESCAPE:${wrapped('key')}`],
		['bad_config', 400, 'key must not contain a backslash', { reason: 'backslash', field: 'key' }, `BAD_CONFIG_BACKSLASH:${wrapped('key')}`],
		['bad_config', 400, "bucket must not contain a '.' or '..' path segment", { reason: 'dot_segment', field: 'bucket' }, `BAD_CONFIG_DOT_SEGMENT:${wrapped('bucket')}`],
		['bad_config', 400, 'key must be relative, not absolute', { reason: 'absolute', field: 'key' }, `BAD_CONFIG_ABSOLUTE:${wrapped('key')}`],
		['bad_config', 400, 'postgres url must start with postgres:// or postgresql://', { reason: 'postgres_scheme' }, 'BAD_CONFIG_POSTGRES_SCHEME'],
		['bad_config', 400, 'http url must start with http(s)://', { reason: 'http_scheme' }, 'BAD_CONFIG_HTTP_SCHEME'],
		['bad_config', 400, "storage key escapes its bucket (resolved to '/api/files/cp-victim/x.csv')", { reason: 'key_escapes_bucket', resolved: '/api/files/cp-victim/x.csv' }, `BAD_CONFIG_KEY_ESCAPES:${wrapped('/api/files/cp-victim/x.csv')}`],
		// backend/src/routes/connectors.ts — bucket naming and the storage-webhook guards.
		['bucket_convention', 400, 'a dataset name is required', { reason: 'name_required' }, 'BUCKET_NAME_REQUIRED'],
		['bucket_convention', 400, 'dataset name is too long for a bucket', { reason: 'name_too_long' }, 'BUCKET_NAME_TOO_LONG'],
		['bucket_convention', 400, "storage webhook connectors require a 'cp-*' bucket for notification auto-registration", { reason: 'webhook_needs_cp_bucket' }, 'BUCKET_WEBHOOK_NEEDS_CP'],
		['bucket_convention', 400, "connector bucket 'raw-data' is not a 'cp-*' bucket", { reason: 'not_cp_bucket', bucket: 'raw-data' }, `BUCKET_NOT_CP:${wrapped('raw-data')}`],
		['not_storage_webhook', 400, 'only storage webhook connectors register notifications', { reason: 'register' }, 'NOT_STORAGE_WEBHOOK_REGISTER'],
		['not_storage_webhook', 400, 'only storage webhook connectors have notifications', { reason: 'read' }, 'NOT_STORAGE_WEBHOOK_READ'],
		// backend/src/ontology/ontology-service.ts vs routes/ontology.ts — the SAME code aimed at two
		// different screens: "the entity you are saving needs one" vs "the list you are opening does".
		['industry_required', 400, 'industry-scope entities need an industry', { reason: 'entity_scope' }, 'INDUSTRY_REQUIRED_ENTITY_SCOPE'],
		['industry_required', 400, 'industry query param is required', { reason: 'query_param' }, 'INDUSTRY_REQUIRED_QUERY_PARAM'],
		['department_required', 400, 'generic-scope entities need a department', { reason: 'entity_scope' }, 'DEPARTMENT_REQUIRED_ENTITY_SCOPE'],
		['department_required', 400, 'department query param is required', { reason: 'query_param' }, 'DEPARTMENT_REQUIRED_QUERY_PARAM'],
		// backend/src/ai/flow-edit-service.ts — only the `not_found` arm knows WHICH node.
		['unknown_node', 400, 'connect_nodes references a missing node', { reason: 'connect_endpoint' }, 'UNKNOWN_NODE_CONNECT_ENDPOINT'],
		['unknown_node', 400, "No node 'llm-summarize'", { reason: 'not_found', node: 'llm-summarize' }, `UNKNOWN_NODE_NOT_FOUND:${wrapped('llm-summarize')}`],
		// backend/src/datasets/parse/index.ts vs routes/datasets.ts — `input` is the only arm that
		// knows the actual size; `upload` and `file` refuse before the body is measured.
		['dataset_too_large', 400, 'Input is 41.3 MB; the limit is 25 MB', { reason: 'input', actualMb: 41.27, limitMb: 25 }, 'DATASET_TOO_LARGE_INPUT:41.3/25'],
		['dataset_too_large', 400, 'Upload exceeds the 25 MB dataset limit', { reason: 'upload', limitMb: 25 }, 'DATASET_TOO_LARGE_FILE:25'],
		['dataset_too_large', 400, 'File exceeds the 25 MB dataset limit', { reason: 'file', limitMb: 25 }, 'DATASET_TOO_LARGE_FILE:25']
	];

	// ── one code, one sentence ───────────────────────────────────────────────────────────────────
	const SINGLE_SENTENCE: Case[] = [
		['storage_format_unknown', 400, "cannot infer a format for object 'reports/q3'", { key: 'reports/q3' }, `STORAGE_FORMAT_UNKNOWN:${wrapped('reports/q3')}`],
		['unknown_connector', 400, "unsupported connector kind 'redshift'", { kind: 'redshift' }, `UNKNOWN_CONNECTOR:${wrapped('redshift')}`],
		['empty_query', 400, 'connector query is empty', {}, 'EMPTY_QUERY'],
		['multi_statement', 400, 'only a single SELECT statement is allowed', {}, 'MULTI_STATEMENT'],
		['not_select', 400, 'connector query must be a SELECT (or WITH … SELECT)', {}, 'NOT_SELECT'],
		['csv_no_header', 400, 'CSV must have a header row with column names', {}, 'CSV_NO_HEADER'],
		['json_invalid', 400, 'Body is not valid JSON', {}, 'JSON_INVALID'],
		['sql_empty', 400, 'Paste the SELECT result (JSON or CSV)', {}, 'SQL_EMPTY'],
		['sql_json_invalid', 400, 'Looks like JSON but did not parse', {}, 'SQL_JSON_INVALID'],
		['xlsx_too_large', 400, "This Excel file's sheet data decompresses to ~62 MB, over the 60 MB limit", { actualMb: 61.7, limitMb: 60 }, 'XLSX_TOO_LARGE:62/60'],
		['xlsx_unreadable', 400, 'Could not read the Excel file', {}, 'XLSX_UNREADABLE'],
		['xlsx_no_sheet', 400, 'The workbook has no readable sheet', {}, 'XLSX_NO_SHEET'],
		['xlsx_no_header', 400, 'The first row must contain column names', {}, 'XLSX_NO_HEADER'],
		['xlsx_no_file', 400, 'Excel ingestion needs an uploaded file', {}, 'XLSX_NO_FILE'],
		['unknown_source_type', 400, "Unsupported source type 'parquet'", { sourceType: 'parquet' }, `UNKNOWN_SOURCE_TYPE:${wrapped('parquet')}`],
		['no_file', 400, 'Expected a "file" field', {}, 'NO_FILE'],
		['dataset_empty', 400, 'No rows were parsed from the input', {}, 'DATASET_EMPTY'],
		['duplicate_column', 400, 'columns must not repeat a column name', {}, 'DUPLICATE_COLUMN'],
		['columns_mismatch', 400, 'columns must cover exactly the existing column names', {}, 'COLUMNS_MISMATCH'],
		['shared_secret', 400, 'storage connectors use the shared platform events secret and cannot rotate', {}, 'SHARED_SECRET'],
		['not_webhook', 400, 'only webhook connectors have an event secret', {}, 'NOT_WEBHOOK'],
		['notifications_disabled', 400, 'self-serve notifications are not enabled', {}, 'NOTIFICATIONS_DISABLED'],
		['cell_required', 400, 'industry_dept entities need both industry and department', {}, 'CELL_REQUIRED'],
		['name_required', 400, 'entity name is required', {}, 'NAME_REQUIRED'],
		['bad_endpoint', 400, "Relation endpoints must be global or this tenant's entities", {}, 'BAD_ENDPOINT'],
		['predicate_required', 400, 'relation predicate is required', {}, 'PREDICATE_REQUIRED'],
		['self_edge', 400, 'a relation needs two distinct entities', {}, 'SELF_EDGE'],
		['relation_exists', 409, 'That relation already exists for this tenant', {}, 'RELATION_EXISTS'],
		['not_global', 400, 'Only a global entity can be hidden; a custom entity is deleted', {}, 'NOT_GLOBAL'],
		['bad_locale', 400, 'Translations target a supported non-en locale', {}, 'BAD_LOCALE'],
		['mapping_dataset_mismatch', 400, 'That mapping does not belong to the dataset and entity being bound, or is not confirmed', {}, 'MAPPING_DATASET_MISMATCH'],
		['no_primary_sample', 422, 'Bind a primary test-data sample to this entity before deriving a data block', {}, 'NO_PRIMARY_SAMPLE'],
		['duplicate_attribute', 400, "Attribute 'author' is listed more than once", { attribute: 'author' }, `DUPLICATE_ATTRIBUTE:${wrapped('author')}`],
		['entity_exists', 409, "A custom entity 'Invoice' already exists in this cell", { name: 'Invoice' }, `ENTITY_EXISTS:${wrapped('Invoice')}`],
		['derived_lint_failed', 422, 'Generated data block failed lint: no default export; banned import', { findings: [{ rule: 'no-default-export', message: 'no default export' }, { rule: 'banned-import', message: 'banned import' }] }, `DERIVED_LINT_FAILED:${wrapped('no default export; banned import')}`],
		['slug_taken', 409, "A block 'llm-summarize' already exists", { slug: 'llm-summarize' }, `SLUG_TAKEN:${wrapped('llm-summarize')}`],
		['slug_reserved_global', 409, "'http-fetch' is a platform block slug", { slug: 'http-fetch' }, `SLUG_RESERVED_GLOBAL:${wrapped('http-fetch')}`],
		// ⚠️ `version` ARRIVES AS A NUMBER on the wire (blocks/authoring-service.ts:249) — a
		// string-only details reader would reject every real payload and this entry would be dead.
		['version_exists', 409, 'Version 3 already exists', { version: 3 }, `VERSION_EXISTS:${wrapped('3')}`],
		// ⚠️ `status` is a PRODUCT enum, so it is interpolated WITHOUT an isolate — see the entry's
		// comment, which also records that it is still an English token and why that is deferred.
		['not_a_draft', 409, 'Version 3 is stable; only drafts are editable', { version: 3, status: 'stable' }, `NOT_A_DRAFT:${wrapped('3')}/stable`],
		['tests_required', 422, 'Publishing to stable requires at least one passing test.', { summary: {} }, 'TESTS_REQUIRED'],
		['tests_failing', 422, 'All enabled tests must pass before publishing to stable.', { summary: {} }, 'TESTS_FAILING'],
		['test_name_taken', 409, "A test 'happy path' already exists for 'llm-summarize'", { test: 'happy path', block: 'llm-summarize' }, `TEST_NAME_TAKEN:${wrapped('happy path')}/${wrapped('llm-summarize')}`],
		['template_name_taken', 409, "A template 'Weekly digest' already exists for this tenant", { name: 'Weekly digest' }, `TEMPLATE_NAME_TAKEN:${wrapped('Weekly digest')}`],
		// ⚠️ `categories` is an ARRAY on the wire and the JOIN happens locale-side — the English
		// interpolates `BLOCK_CATEGORIES.join(', ')`, which is a separator decision, not a fact.
		['bad_category', 400, 'category must be one of: transform, llm, io', { categories: ['transform', 'llm', 'io'] }, `BAD_CATEGORY:${wrapped('transform, llm, io')}`],
		['voting_closed', 409, 'Voting on this challenge has closed', { type: 'challenge' }, 'VOTING_CLOSED_CHALLENGE'],
		['voting_closed', 409, 'Voting on this solution has closed', { type: 'solution' }, 'VOTING_CLOSED_SOLUTION'],
		['unknown_edge', 400, "No edge 'e-7'", { edge: 'e-7' }, `UNKNOWN_EDGE:${wrapped('e-7')}`],
		['invalid_challenge_id', 400, 'challenge_id must be a UUID', {}, 'INVALID_CHALLENGE_ID'],
		['dataset_not_found', 400, "No dataset 'crm-export' in the org's test data", { slug: 'crm-export' }, `DATASET_NOT_FOUND:${wrapped('crm-export')}`],

		// ── the RUN path and the block SOURCE GATE — six codes, none of them admin-only ──────────
		// Every wire string below is transcribed from the throw site, not paraphrased:
		// blocks/source-gate.ts:75 · blocks/authoring-service.ts:345 · host/run-controller.ts:1022,
		// :1137, :1192, :1198 · routes/sandboxes.ts:398, :403.
		//
		// ⚠️ `lint_failed` MIRRORS `derived_lint_failed` ABOVE — same `LintFinding[]` bag, same `; `
		// join, same single isolate. That is asserted as a shape below rather than only pinned here.
		['lint_failed', 422, 'Block failed lint', { findings: [{ source: 'scan', rule: 'no-fetch', message: 'fetch() is not available in the sandbox' }, { source: 'tsc', rule: 'ts2304', message: "Cannot find name 'foo'" }] }, `LINT_FAILED:${wrapped("fetch() is not available in the sandbox; Cannot find name 'foo'")}`],
		// ⚠️ A 409, AND IT IS THE ONE THAT FIRES ON AN ORDINARY DOUBLE-CLICK OF RUN. It reaches the
		// map through `writeErrorText`'s SEPARATE 409 branch, so it also proves that branch consults
		// the same catalog.
		['sandbox_busy', 409, 'Your sandbox is already running another flow.', {}, 'SANDBOX_BUSY'],
		// THREE ARMS OF ONE CODE, keyed on `suspensionReason` — NOT on `reason`, which is why this
		// code is not in REASON_SWITCHED above. The two named arms are :1022's two English sentences.
		['sandbox_suspended', 422, 'Your sandbox was paused after being idle. Resume it and retry this run.', { sandboxId: 'sb-1', suspensionReason: 'idle', resumable: true }, 'SANDBOX_SUSPENDED_IDLE'],
		['sandbox_suspended', 422, 'Your sandbox was paused by an administrator. Ask a platform operator to resume it.', { sandboxId: 'sb-1', suspensionReason: 'admin', resumable: false }, 'SANDBOX_SUSPENDED_ADMIN'],
		// :1192's arm: `suspension_reason` is nullable in the DB, so `null` really does reach the wire.
		['sandbox_suspended', 422, 'Your sandbox is suspended.', { sandboxId: 'sb-1', suspensionReason: null, resumable: false }, 'SANDBOX_SUSPENDED'],
		// ⚠️ `findings` HERE IS `DataValidationFinding[]`, NOT `LintFinding[]` — deliberately shaped
		// like the real bag so that an entry which mistakenly ran it through `lintTranscript` would
		// render an empty transcript and fail rather than quietly pass.
		['data_validation_failed', 422, 'The selected test data does not satisfy the published data contract.', { findings: [{ dataset: 'crm-export', column: 'bedrag', attribute: 'amount', rule: 'type_mismatch' }] }, 'DATA_VALIDATION_FAILED'],
		// ⚠️ NO DETAILS BAG AT EITHER THROW SITE — the English interpolates `status` but the wire does
		// not carry it. See the entry's comment for why the copy states the RULE instead.
		['not_resumable', 422, 'Sandbox is idle, not auto-suspended.', {}, 'NOT_RESUMABLE'],
		['sandbox_admin_suspended', 422, 'This sandbox was paused by an administrator and cannot be self-resumed.', {}, 'SANDBOX_ADMIN_SUSPENDED']
	];

	const ALL: Case[] = [...REASON_SWITCHED, ...SINGLE_SENTENCE];

	it.each(ALL)('⛔ %s (%d) is localized, not shipped as "%s"', (code, status, wire, details, sentinel) => {
		const shown = writeErrorText({ status, code, message: wire, details }, 'FALLBACK');
		expect(shown).toBe(sentinel);
		expect(shown).not.toBe(wire);
	});

	it('the table is not empty and covers all three statuses', () => {
		// Non-vacuity for `it.each` above: an empty table runs zero cases and reports green. The
		// status spread matters too — `writeErrorText` has SEPARATE branches for 400/422 and for 409,
		// and a table that only exercised the first would leave the conflict half unproven.
		expect(ALL.length).toBeGreaterThan(60);
		expect(new Set(ALL.map(([, status]) => status))).toEqual(new Set([400, 409, 422]));
	});

	describe('the `reason` sub-discriminator', () => {
		it('⛔ picks DIFFERENT copy per reason — six codes, twenty-three sentences', () => {
			// THE POINT OF `byReason`. One sentence for all eight `bad_config` reasons would satisfy
			// every `.toBe(sentinel)` above if the sentinels were equal; they are not, and this is
			// where that is asserted rather than assumed.
			const perCode = new Map<string, Set<string>>();
			for (const [code, , , , sentinel] of REASON_SWITCHED) {
				if (!perCode.has(code)) perCode.set(code, new Set());
				perCode.get(code)!.add(sentinel);
			}
			// `dataset_too_large` is the deliberate exception: `upload` and `file` SHARE one sentence
			// because neither ships `actualMb`, so it has 3 reasons and 2 distinct sentences.
			expect([...perCode].map(([code, s]) => [code, s.size])).toEqual([
				['bad_config', 8],
				['bucket_convention', 4],
				['not_storage_webhook', 2],
				['industry_required', 2],
				['department_required', 2],
				['unknown_node', 2],
				['dataset_too_large', 2]
			]);
		});

		it.each([
			['bad_config', "'url' is required"],
			['bucket_convention', 'dataset name is too long for a bucket'],
			['not_storage_webhook', 'only storage webhook connectors have notifications'],
			['industry_required', 'industry query param is required'],
			['department_required', 'department query param is required'],
			['unknown_node', "No node 'x'"],
			['dataset_too_large', 'Upload exceeds the 25 MB dataset limit']
		])(
			'⚠️ %s with NO reason (an OLD POD) falls back to the English, not to one arm picked at random',
			(code, wire) => {
				// ⛔ THE MID-ROLL SHAPE, AND IT IS REAL RATHER THAN HYPOTHETICAL: the browser reaches the
				// API through the Service, so a new bundle is answered by an old pod for the length of
				// a roll. An old pod ships the code with no `details` at all. Answering with whichever
				// arm happens to be first would tell the reader about a rule they did not break.
				const shown = writeErrorText({ status: 400, code, message: wire, details: {} }, 'FALLBACK');
				expect(shown).toBe(wire);
				expect(shown).not.toBe('FALLBACK');
			}
		);

		it('a NINTH reason landing backend-first also falls through, rather than rendering blank', () => {
			const wire = 'url must not contain a query string';
			expect(
				writeErrorText(
					{ status: 400, code: 'bad_config', message: wire, details: { reason: 'query_string', field: 'url' } },
					'FALLBACK'
				)
			).toBe(wire);
		});

		it('does not resolve an Object.prototype key as a reason arm', () => {
			// `hasOwnProperty.call` inside `byReason`, for the same reason `writeErrorText` uses it on
			// the code: `{ reason: 'constructor' }` would otherwise resolve to a function and be CALLED.
			const wire = 'a dataset name is required';
			expect(
				writeErrorText(
					{ status: 400, code: 'bucket_convention', message: wire, details: { reason: 'constructor' } },
					'FALLBACK'
				)
			).toBe(wire);
		});
	});

	describe('⚠️ a missing parameter lands on the ENGLISH sentence, never on blank copy', () => {
		/**
		 * ⛔ THE DOCTRINE APPLIED TO ITSELF — the same argument `ValidationCopy` makes for the six
		 * `{block}` entries, now covering twenty more. Each of these English sentences NAMES the
		 * offender; a localized sentence that could not reach the name would read "an attribute is
		 * listed twice" on a 40-attribute entity. So when the wire lacks the value, the entry returns
		 * `null` and `writeErrorText` falls through to the sentence that still carries it.
		 *
		 * ⚠️ AND IT IS A REAL WIRE SHAPE, TWICE OVER. An OLD POD ships no `details` at all; and
		 * `slug_reserved_global` is thrown from TWO files, one of which
		 * (ontology/data-block-derivation.ts:119) ships no details bag even on the current build.
		 */
		const MISSING_PARAM: [code: string, status: number, wire: string][] = [
			['storage_format_unknown', 400, "cannot infer a format for object 'reports/q3'"],
			['unknown_source_type', 400, "Unsupported source type 'parquet'"],
			['bucket_convention', 400, "connector bucket 'raw-data' is not a 'cp-*' bucket"],
			['duplicate_attribute', 400, "Attribute 'author' is listed more than once"],
			['entity_exists', 409, "A custom entity 'Invoice' already exists in this cell"],
			['derived_lint_failed', 422, 'Generated data block failed lint: no default export'],
			['slug_taken', 409, "A block 'llm-summarize' already exists"],
			['slug_reserved_global', 409, "'http-fetch' is a platform block slug"],
			['version_exists', 409, 'Version 3 already exists'],
			['not_a_draft', 409, 'Version 3 is stable; only drafts are editable'],
			['test_name_taken', 409, "A test 'happy path' already exists for 'llm-summarize'"],
			['template_name_taken', 409, "A template 'Weekly digest' already exists for this tenant"],
			['bad_category', 400, 'category must be one of: transform, llm, io'],
			['voting_closed', 409, 'Voting on this challenge has closed'],
			['unknown_edge', 400, "No edge 'e-7'"],
			['dataset_not_found', 400, "No dataset 'crm-export' in the org's test data"],
			['xlsx_too_large', 400, "This Excel file's sheet data decompresses to ~62 MB, over the 60 MB limit"],
			// ⚠️ `lint_failed` FOLLOWS `derived_lint_failed` HERE TOO, and that is the point of giving it
			// the same shape: a 422 whose bag carries no findings lands on the backend sentence rather
			// than on a localized frame wrapped around nothing.
			['lint_failed', 422, 'Block failed lint']
		];

		it.each(MISSING_PARAM)('%s with an EMPTY details bag keeps the English', (code, status, wire) => {
			const shown = writeErrorText({ status, code, message: wire, details: {} }, 'FALLBACK');
			expect(shown).toBe(wire);
			expect(shown).not.toBe('FALLBACK');
		});

		it.each(MISSING_PARAM)('%s with NO details FIELD AT ALL behaves the same way', (code, status, wire) => {
			// The plain `ApiError` (admin/marketplace clients) has no `details` property at all —
			// `detailsOf` must read that as "no value available" rather than throwing.
			expect(writeErrorText({ status, code, message: wire }, 'FALLBACK')).toBe(wire);
		});

		const UNUSABLE: [code: string, details: object, wire: string][] = [
			['bad_category', { categories: [] }, 'category must be one of: transform, llm, io'],
			['bad_category', { categories: 'transform, llm' }, 'category must be one of: transform, llm'],
			['derived_lint_failed', { findings: [] }, 'Generated data block failed lint: '],
			['derived_lint_failed', { findings: [{ rule: 'x' }] }, 'Generated data block failed lint: x'],
			// The same two absences on `lint_failed`: an empty array, and findings that carry a rule but
			// no `message` — `lintTranscript` filters both to nothing and the entry declines.
			['lint_failed', { findings: [] }, 'Block failed lint'],
			['lint_failed', { findings: [{ source: 'scan', rule: 'no-fetch' }] }, 'Block failed lint'],
			['duplicate_attribute', { attribute: '   ' }, "Attribute '   ' is listed more than once"],
			['not_a_draft', { version: 3 }, 'Version 3 is stable; only drafts are editable'],
			['test_name_taken', { test: 'happy path' }, "A test 'happy path' already exists for 'x'"]
		];

		it.each(UNUSABLE)('%s with a PRESENT-BUT-UNUSABLE value keeps the English too', (code, details, wire) => {
			// ⛔ AN EMPTY ARRAY, A BLANK STRING AND A HALF-FILLED BAG ARE THE SAME ABSENCE WEARING
			// DIFFERENT HATS. `“” is listed twice`, `Choose one of these categories: .` and
			// `Version 3 is , and only a draft can be edited` are each a localized sentence that says
			// strictly LESS than the English it replaced — which is the failure this null contract
			// exists to prevent, not a tidier spelling of it.
			expect(writeErrorText({ status: 400, code, message: wire, details }, 'FALLBACK')).toBe(wire);
		});

		it('⚠️ unknown_connector is the ONE entry that does not fall through, and that is deliberate', () => {
			// `kind` is GENUINELY OPTIONAL on the wire: datasets/connectors/index.ts:229 knows the
			// rejected kind, :31 has already narrowed `cfg` to a typed union and has no string. The
			// English at :31 is the bare "unsupported connector kind" — it names nothing either — so
			// the generic localized sentence loses NOTHING, unlike every case above. Same split
			// `i18n/connection-test-label.ts:196` already makes, and the reason there are two keys.
			expect(
				writeErrorText(
					{ status: 400, code: 'unknown_connector', message: 'unsupported connector kind', details: {} },
					'FALLBACK'
				)
			).toBe('UNKNOWN_CONNECTOR_GENERIC');
		});
	});

	describe('⛔ the ten connection-test keys are REUSED, not minted a second time', () => {
		it('bad_config resolves to the SAME catalog keys the 200-OK test path uses', () => {
			// `routes/connectors.ts:274` re-emits these identical `HttpError.details` as an HTTP 200
			// `{ok:false, code, params}` for the "Test connection" button, and
			// `i18n/connection-test-label.ts:145` switches the same eight `reason` values into
			// `bad_config_*`. Only the envelope differs. Two key families for one set of sentences
			// would be eight duplicated strings in each of eight catalogs — the single failure the
			// brief for this lane was written to prevent, asserted here rather than assumed, because
			// nothing else in CI can tell `error_bad_config_required` from `bad_config_required`.
			const shown = writeErrorText(
				{ status: 400, code: 'bad_config', message: "'url' is required", details: { reason: 'required', field: 'url' } },
				'FALLBACK'
			);
			expect(shown).toBe(`BAD_CONFIG_REQUIRED:${wrapped('url')}`);
			// …and NOT a sentinel from an `error_`-prefixed twin, which is what a duplicate would be.
			expect(shown).not.toContain('ERROR_BAD_CONFIG');
		});

		it('unknown_connector resolves to the shared pair, both arms', () => {
			expect(
				writeErrorText({ status: 400, code: 'unknown_connector', message: 'x', details: { kind: 's3' } }, 'FALLBACK')
			).toBe(`UNKNOWN_CONNECTOR:${wrapped('s3')}`);
			expect(
				writeErrorText({ status: 400, code: 'unknown_connector', message: 'x', details: {} }, 'FALLBACK')
			).toBe('UNKNOWN_CONNECTOR_GENERIC');
		});
	});

	describe('bidi isolation on values the product does not constrain', () => {
		const FOREIGN: [code: string, status: number, details: object, value: string][] = [
			['duplicate_attribute', 400, { attribute: 'الكاتب' }, 'الكاتب'],
			['entity_exists', 409, { name: 'חשבונית' }, 'חשבונית'],
			['slug_taken', 409, { slug: 'llm عربي' }, 'llm عربي'],
			['dataset_not_found', 400, { slug: 'crm-export' }, 'crm-export'],
			['unknown_edge', 400, { edge: 'e-7' }, 'e-7']
		];

		it.each(FOREIGN)('%s wraps its foreign value in FSI…PDI', (code, status, details, value) => {
			// ⛔ NOT DECORATION. `entity_exists` and `template_name_taken` quote a name a HUMAN typed,
			// which in an Arabic- or Hebrew-speaking workspace is RTL by default; without the isolate
			// the latin sentence around it reorders. Zero-width and invisible in the five LTR locales,
			// which is exactly why nothing else would ever catch its absence.
			const shown = writeErrorText({ status, code, message: 'x', details }, 'FALLBACK');
			expect(shown).toContain(`${FSI}${value}${PDI}`);
			// Non-vacuity: the value alone would be `.toContain`-satisfied without any isolate.
			expect(shown).not.toContain(`:${value}`);
		});

		it('a joined COMPOUND is ONE isolate, with the separators inside it', () => {
			// ⛔ THE MEASURED LESSON FROM `graph-issue-label.ts`'s `iso` doc: per-PART isolation leaves
			// the separator outside both isolates, which under UAX#9 resolves to the RTL base level and
			// SWAPS the halves. `bad_category`'s commas and `derived_lint_failed`'s `; ` must sit
			// INSIDE the FSI…PDI, so there is exactly ONE of each character in the rendered sentence.
			const cat = writeErrorText(
				{ status: 400, code: 'bad_category', message: 'x', details: { categories: ['transform', 'llm', 'io'] } },
				'FALLBACK'
			);
			expect(cat).toBe(`BAD_CATEGORY:${FSI}transform, llm, io${PDI}`);
			expect(cat.split(FSI)).toHaveLength(2);
			expect(cat.split(PDI)).toHaveLength(2);
		});

		it('a product-constrained enum is NOT isolated', () => {
			// `not_a_draft`'s `status` is 'draft' | 'beta' | 'stable' — the product picks it, so there
			// is nothing foreign to isolate. Asserting the ABSENCE keeps the rule from being applied
			// by reflex to every field, which would make the isolate meaningless where it matters.
			expect(
				writeErrorText(
					{ status: 409, code: 'not_a_draft', message: 'x', details: { version: 3, status: 'stable' } },
					'FALLBACK'
				)
			).toBe(`NOT_A_DRAFT:${wrapped('3')}/stable`);
		});
	});

	describe('⚠️ the figures are formatted the way the ENGLISH sentence rounds them', () => {
		it('xlsx_too_large rounds to a WHOLE number, matching the backend`s Math.round', () => {
			// backend/src/datasets/parse/xlsx.ts:85 defines `mb = (n) => Math.round(n / 1_048_576)` for
			// the sentence and puts RAW FLOATS on the wire. A Dutch reader shown "61,7 MB" beside an
			// English "62 MB" for one file is being told two different things about it.
			expect(
				writeErrorText(
					{ status: 400, code: 'xlsx_too_large', message: 'x', details: { actualMb: 61.7, limitMb: 60 } },
					'FALLBACK'
				)
			).toBe('XLSX_TOO_LARGE:62/60');
		});

		it('dataset_too_large keeps ONE decimal on the size and NONE on the limit', () => {
			// The English is `${(bytes / 1_048_576).toFixed(1)} MB; the limit is ${…} MB` — asymmetric
			// on purpose, and matched here. `decimal1` rather than `toFixed(1)` because `toFixed`
			// hard-codes '.', the THOUSANDS separator in six of the eight catalogs.
			expect(
				writeErrorText(
					{ status: 400, code: 'dataset_too_large', message: 'x', details: { reason: 'input', actualMb: 41.27, limitMb: 25 } },
					'FALLBACK'
				)
			).toBe('DATASET_TOO_LARGE_INPUT:41.3/25');
		});

		it('a non-numeric or absent figure falls through instead of rendering NaN', () => {
			// `num(undefined, …)` throws out of its own catch (utils/format.ts documents the measured
			// case), and "NaN MB" is a localized sentence saying less than the English.
			const wire = 'Input is 41.3 MB; the limit is 25 MB';
			expect(
				writeErrorText(
					{ status: 400, code: 'dataset_too_large', message: wire, details: { reason: 'input', actualMb: '41.27', limitMb: 25 } },
					'FALLBACK'
				)
			).toBe(wire);
			expect(
				writeErrorText(
					{ status: 400, code: 'xlsx_too_large', message: wire, details: { actualMb: Number.NaN, limitMb: 60 } },
					'FALLBACK'
				)
			).toBe(wire);
		});
	});

	/**
	 * ⛔ THE RUN PATH AND THE SOURCE GATE — the six refusals an ordinary author meets by pressing Run
	 * or Save, which spent this whole lane's predecessor sitting in `NOT_LOCALIZED_CODES` under
	 * reasons that all began "deferred (⚠️ NOT admin-only)". The table above proves each renders its
	 * own sentence; what is asserted here is the three PROPERTIES that table cannot see.
	 */
	describe('⛔ the run-path + source-gate family', () => {
		it('lint_failed renders its findings in the SAME shape as derived_lint_failed', () => {
			// ⛔ NOT A STYLE POINT. The two codes carry the identical `LintFinding[]` from the identical
			// linter (blocks/lint.ts); one shape means the frame differs and the transcript does not.
			// Asserted by driving BOTH through `writeErrorText` with the SAME bag and comparing the
			// interpolated halves — an entry that invented its own join, or dropped the isolate, breaks
			// here rather than in a screenshot.
			const findings = [
				{ source: 'scan', rule: 'no-fetch', message: 'fetch() is not available in the sandbox' },
				{ source: 'tsc', rule: 'ts2304', message: "Cannot find name 'foo'" }
			];
			const transcript = wrapped("fetch() is not available in the sandbox; Cannot find name 'foo'");
			expect(writeErrorText({ status: 422, code: 'lint_failed', message: 'Block failed lint', details: { findings } }, 'FALLBACK')).toBe(
				`LINT_FAILED:${transcript}`
			);
			expect(
				writeErrorText({ status: 422, code: 'derived_lint_failed', message: 'x', details: { findings } }, 'FALLBACK')
			).toBe(`DERIVED_LINT_FAILED:${transcript}`);
			// ONE isolate around the WHOLE `; `-joined run, separators inside — the UAX#9 lesson
			// `iso()` records, which per-finding isolation would break in ar/he.
			const shown = writeErrorText({ status: 422, code: 'lint_failed', message: 'x', details: { findings } }, 'FALLBACK');
			expect(shown.split(FSI)).toHaveLength(2);
			expect(shown.split(PDI)).toHaveLength(2);
			expect(shown).toContain('; ');
		});

		it('⛔ sandbox_suspended gives each suspensionReason its OWN copy — no flattening', () => {
			// The two English sentences at host/run-controller.ts:1022 differ in their REPAIR ("resume
			// it and retry" vs "ask a platform operator"), so one sentence for both would say strictly
			// less than the English it replaces. Red by collapsing the switch to a single key.
			const say = (suspensionReason: string | null) =>
				writeErrorText(
					{ status: 422, code: 'sandbox_suspended', message: 'Your sandbox is suspended.', details: { sandboxId: 'sb-1', suspensionReason } },
					'FALLBACK'
				);
			const arms = [say('idle'), say('admin'), say(null)];
			expect(arms).toEqual(['SANDBOX_SUSPENDED_IDLE', 'SANDBOX_SUSPENDED_ADMIN', 'SANDBOX_SUSPENDED']);
			expect(new Set(arms).size).toBe(3);
		});

		it('⚠️ sandbox_suspended with NO reason still answers, unlike every named-value entry', () => {
			// The deliberate departure, and the reason is written on the entry: :1192's English IS the
			// bare "Your sandbox is suspended.", so the generic arm loses nothing — while an old pod
			// shipping no bag would otherwise leave a Dutch reader on an English sentence.
			expect(
				writeErrorText({ status: 422, code: 'sandbox_suspended', message: 'Your sandbox is suspended.', details: {} }, 'FALLBACK')
			).toBe('SANDBOX_SUSPENDED');
			expect(writeErrorText({ status: 422, code: 'sandbox_suspended', message: 'Your sandbox is suspended.' }, 'FALLBACK')).toBe(
				'SANDBOX_SUSPENDED'
			);
			// …and an unknown fourth reason lands on the generic too, rather than on an arm picked at
			// random or on a blank.
			expect(
				writeErrorText({ status: 422, code: 'sandbox_suspended', message: 'x', details: { suspensionReason: 'quota' } }, 'FALLBACK')
			).toBe('SANDBOX_SUSPENDED');
		});

		it('⛔ not_resumable carries NO runtime status, because the wire does not either', () => {
			// ⛔ THE DECISION THIS LANE HAD TO MAKE, PINNED. Both English sentences interpolate the
			// sandbox status — `Sandbox is idle, not auto-suspended.` (routes/sandboxes.ts:403) and
			// `Sandbox is running, not suspended/error` (:303) — and NEITHER throw passes a third
			// argument to `unprocessable`, so no `status` field exists on the body. A `{status}`
			// placeholder would be unfillable and the entry would be dead copy. The copy states the
			// RULE instead, exactly as `delivery_not_retriable` does.
			//
			// Both sites therefore resolve to the SAME sentence, and neither leaks the English token.
			for (const wire of ['Sandbox is idle, not auto-suspended.', 'Sandbox is running, not suspended/error']) {
				const shown = writeErrorText({ status: 422, code: 'not_resumable', message: wire }, 'FALLBACK');
				expect(shown).toBe('NOT_RESUMABLE');
				expect(shown).not.toBe(wire);
			}
			// Non-vacuity for the claim above: a bag that DID carry a status must not change the
			// answer, or this entry would be silently reason-switched and the comment would be wrong.
			expect(
				writeErrorText({ status: 422, code: 'not_resumable', message: 'x', details: { status: 'idle' } }, 'FALLBACK')
			).toBe('NOT_RESUMABLE');
		});

		it('the two administrator-paused refusals are DIFFERENT sentences to different readers', () => {
			// `sandbox_admin_suspended` (routes/sandboxes.ts:398) refuses a SELF-RESUME; the `admin` arm
			// of `sandbox_suspended` (host/run-controller.ts:1022) refuses a RUN. Similar names, one
			// cause, two gestures — flattening them would tell a reader to resume a sandbox they have
			// just been told they cannot resume.
			expect(
				writeErrorText({ status: 422, code: 'sandbox_admin_suspended', message: 'x' }, 'FALLBACK')
			).toBe('SANDBOX_ADMIN_SUSPENDED');
			expect(
				writeErrorText({ status: 422, code: 'sandbox_suspended', message: 'x', details: { suspensionReason: 'admin' } }, 'FALLBACK')
			).not.toBe('SANDBOX_ADMIN_SUSPENDED');
		});

		it('⚠️ invalid_idempotency_key is the one that stayed registered, and still ships English', () => {
			// Its old register reason claimed "ordinary author". The SPA sets the header to
			// `crypto.randomUUID()` at both call sites (api/runs.ts:122, :135), so nothing a browser
			// does produces the >200-character value host/run-controller.ts:1014 refuses. The register
			// now says so, and the behaviour is unchanged — which is what "registered" has to mean.
			const wire = 'Idempotency-Key must be at most 200 characters';
			expect(writeErrorText({ status: 422, code: 'invalid_idempotency_key', message: wire }, 'FALLBACK')).toBe(wire);
			expect(NOT_LOCALIZED_CODES.has('invalid_idempotency_key')).toBe(true);
		});
	});

	describe('the codes deliberately left OUT still behave as before', () => {
		it('⚠️ an UNCATALOGUED code keeps falling through to the backend sentence', () => {
			// ⛔ THE FALL-THROUGH IS NOT THE BUG AND DELETING IT WOULD BE A REGRESSION — it is the only
			// thing that carries a developer-shaped 422's specifics. Every code in NOT_LOCALIZED_CODES
			// still lands here, which is what makes that register a record of a DECISION rather than a
			// claim of coverage. Red by localizing 400/422/409 wholesale.
			const UNCATALOGUED: [code: string, wire: string][] = [
				['invalid_value', "'temperature' must be between 0 and 2"],
				// ⚠️ `last_admin` sat here until it was catalogued. `policy_violation` replaces it from the
				// same register, so the case keeps naming a REAL uncatalogued code rather than a
				// hypothetical one — `never_seen_by_this_build` below already covers the hypothetical.
				['policy_violation', 'This card violates the promotion policy'],
				// ⚠️ `lint_failed` SAT HERE UNTIL THIS LANE AND HAD TO GO — it is catalogued now, so the
				// localized copy short-circuits and this case would assert the opposite of the fix.
				// `invalid_idempotency_key` replaces it from the SAME register block, which keeps the
				// case naming a real uncatalogued code rather than only a hypothetical one.
				['invalid_idempotency_key', 'Idempotency-Key must be at most 200 characters'],
				['bad_column_type', "Unknown type 'geo'"],
				['never_seen_by_this_build', 'Some sentence a future backend invented']
			];
			for (const [code, wire] of UNCATALOGUED) {
				expect(writeErrorText({ status: 422, code, message: wire }, 'FALLBACK')).toBe(wire);
			}
		});

		it('⛔ NOT_LOCALIZED_CODES and VALIDATION_MESSAGES are DISJOINT', () => {
			// A code in both would claim coverage and non-coverage at once, and a following lane turns
			// this register into a CI guard — so an overlap becomes a wrong GREEN, which is worse than
			// the gap it papers over. `tests_required` is the live example: the brief listed it as a
			// candidate for the register AND it is catalogued, so it must appear in exactly one place.
			const catalogued = new Set(VALIDATION_MESSAGE_CODES);
			const both = [...NOT_LOCALIZED_CODES.keys()].filter((c) => catalogued.has(c));
			expect(both).toEqual([]);
			expect(NOT_LOCALIZED_CODES.has('tests_required')).toBe(false);
			expect(catalogued.has('tests_required')).toBe(true);
			expect(NOT_LOCALIZED_CODES.has('bad_column_type')).toBe(true);
		});

		it('every register entry carries a real reason, not a placeholder', () => {
			// Non-vacuity for the disjointness assertion: an EMPTY register satisfies it trivially, and
			// an empty register is also what "someone deleted the mechanism" looks like. A one-word
			// reason ("deferred", "n/a") is the shape that makes the whole list unfalsifiable.
			// ⚠️ RECOUNTED, NOT DECREMENTED — measured on the live Map, not derived from the old floor.
			// ⚠️ 27 → 21 ON THE RUN-PATH LANE: that block gave six codes to `VALIDATION_MESSAGES` and kept
			// `invalid_idempotency_key` with a CORRECTED reason (unreachable from the SPA, not
			// deferred). The tenant-lifecycle lane moved the same Map the other way (the 503
			// `signup_queue_full` entry came back), so the INTEGRATED size is 22 — RECOUNTED after the
			// rebase, never one lane's figure and never 21 + 1 by hand.
			// The exact size is pinned in `error-message.backend-contract.test.ts`; the `>20`
			// floor below now has a margin of TWO, so the next lane to empty a block recounts and lowers
			// it — nobody deletes an entry to stay above it, and nobody lowers it to get past a red.
			// The paragraph below is the PREVIOUS lane's arithmetic, kept for its lesson, not its number:
			// The register held 41 entries; that lane emptied the `── tenant-admin screens ──` block of
			// SEVENTEEN, fifteen of which moved into `VALIDATION_MESSAGES` while two came BACK as
			// unreachable (with a corrected reason, under "the two that are not deferrals at all" —
			// now four). 41 - 17 + 2 = 26. The floor is what stops "someone deleted the mechanism"
			// reading as green, so it tracks the real size — but it is NOT a target: the next lane to
			// empty a block recounts and lowers it, and nobody lowers it to get past a red.
			expect(NOT_LOCALIZED_CODES.size).toBeGreaterThan(20);
			for (const [code, reason] of NOT_LOCALIZED_CODES) {
				expect(reason.length, `${code} has no usable reason`).toBeGreaterThan(25);
				// Each names either the emitting file or the screen it is deferred on.
				expect(reason, code).toMatch(/\.ts|\//);
			}
		});
	});

	it('⛔ every new code is subtracted from the SUBMIT-path set', () => {
		// `error-message.backend-contract.test.ts` asserts the submit-path mirror in BOTH directions:
		// a catalogued code that `POST /api/solutions` cannot emit fails as dead copy. None of these
		// is on that path, so `NON_SUBMIT_PATH_CODES` has to contain all of them or that guard reds
		// with 56 names. It is derived from `Object.keys(OFF_PATH_REFUSAL_MESSAGES)`, and this is the
		// assertion that the derivation actually reaches the map — a spread that silently dropped
		// would leave both lists plausible and the contract test red for a reason nobody would connect
		// to this file.
		const subtracted = new Set(NON_SUBMIT_PATH_CODES);
		const codes = [...new Set(ALL.map(([code]) => code))];
		expect(codes.filter((c) => !subtracted.has(c))).toEqual([]);
		// …and the two that were there before this lane are still there.
		expect(subtracted.has('delivery_already_live')).toBe(true);
		expect(subtracted.has('empty_allowlist')).toBe(true);
		// Non-vacuity: `codes` must be the real set, not an empty one.
		// ⚠️ 56 → 62: the run-path + source-gate family. RECOUNTED off `ALL`, not incremented.
		// ⚠️ 62 → 61: `no_home_tenant` left the map. backend/src stopped emitting the literal when
		// routes/agent.ts:102's `badRequest` became the 401 `agent_token_no_tenant`, and
		// `NON_SUBMIT_PATH_CODES`'s rot-guard greps for it. RECOUNTED off `ALL`, not decremented.
		expect(codes).toHaveLength(61);
	});

	it('leaves licenseOrPermissionMessage alone — these still return null there', () => {
		// The null contract is load-bearing (see that function's doc comment): READ paths use plain
		// `errorText` and must keep their own context-specific fallback.
		expect(licenseOrPermissionMessage({ status: 400, code: 'csv_no_header' })).toBeNull();
		expect(errorText({ status: 400, code: 'csv_no_header', message: 'x' }, 'FALLBACK')).toBe('FALLBACK');
	});
});

/**
 * ⛔ THE TENANT-LIFECYCLE REFUSALS — FOUR CODES ACROSS FOUR STATUS CLASSES, WHICH IS THE WHOLE
 * REASON THEY GET THEIR OWN BLOCK RATHER THAN FOUR ROWS IN THE TABLES ABOVE.
 *
 * `writeErrorText` routes by STATUS before it ever looks at the code — 400/422 through one branch,
 * 409 through a second, 402/403/503 through `licenseOrPermissionMessage` — and these four land in
 * three different branches (`tenant_suspended` 403, `tenant_status_unavailable` 503,
 * `tenant_offboarded` 409, `confirm_mismatch` 400). A code catalogued in the WRONG map is invisible
 * to `bun run check` (`VALIDATION_MESSAGES` is a `Record<string, …>`, so any code name type-checks)
 * and shows up only as the generic fallback on screen. So every case below asserts the localized
 * sentinel AND that it is not the sentence it would otherwise have degraded to.
 *
 * ⚠️ `tenant_status_unavailable` IS THE ONE THAT COULD NOT EXIST BEFORE THIS LANE. There was no 503
 * branch at all: `licenseOrPermissionMessage` returned `null` for every 5xx, so the fail-closed arm
 * of the status gate reached the reader as the caller's own "kon niet laden" fallback. The
 * `an UNKNOWN 503 still returns null` case below is what keeps the new branch narrow.
 */
describe('the tenant-lifecycle refusals (suspend / offboard / reactivate)', () => {
	it('⛔ tenant_suspended (403) gets its own copy, not the generic FORBIDDEN', () => {
		// Without a `FORBIDDEN_MESSAGES` entry this degrades to "You don't have permission to do
		// that." — which on a suspended workspace is FALSE (the reader's permissions are intact) and
		// sends them looking for a missing role. Both directions asserted; the first alone would pass
		// if the code were routed to any other named 403.
		const shown = licenseOrPermissionMessage({ status: 403, code: 'tenant_suspended' });
		expect(shown).toBe('TENANT_SUSPENDED');
		expect(shown).not.toBe('FORBIDDEN');
		expect(shown).not.toBe('TENANT_NOT_PROVISIONED');
		// …and through both public entry points, since a suspended workspace refuses reads AND writes.
		expect(
			errorText({ status: 403, code: 'tenant_suspended', message: 'Tenant is suspended' }, 'FALLBACK')
		).toBe('TENANT_SUSPENDED');
		expect(
			writeErrorText({ status: 403, code: 'tenant_suspended', message: 'Tenant is suspended' }, 'FALLBACK')
		).toBe('TENANT_SUSPENDED');
	});

	it('⛔ tenant_suspended is a member of KNOWN_FORBIDDEN_CODES', () => {
		// The runtime mirror `error-message.backend-contract.test.ts` diffs the backend's 403 scrape
		// against. It is `Object.keys(FORBIDDEN_MESSAGES)`, so this cannot drift — but asserting it
		// here is what makes the FRONTEND-FIRST ordering provable: the SPA half must already be live
		// when middleware/tenant-status-gate.ts starts emitting the code, or every screen shows the
		// generic copy for the length of a roll.
		expect(KNOWN_FORBIDDEN_CODES).toContain('tenant_suspended');
	});

	it('⛔ tenant_status_unavailable (503) is localized — the status class that had no branch', () => {
		// The gate fails CLOSED when the workspace's status row cannot be read. "Try again shortly" is
		// TRUE of this and would be a false promise on `tenant_suspended`, which no retry clears —
		// the second assertion is what pins that the two did not collapse onto one sentence.
		const shown = licenseOrPermissionMessage({ status: 503, code: 'tenant_status_unavailable' });
		expect(shown).toBe('TENANT_STATUS_UNAVAILABLE');
		expect(shown).not.toBe('TENANT_SUSPENDED');
		expect(
			errorText({ status: 503, code: 'tenant_status_unavailable' }, 'FALLBACK')
		).toBe('TENANT_STATUS_UNAVAILABLE');
		expect(
			writeErrorText({ status: 503, code: 'tenant_status_unavailable' }, 'FALLBACK')
		).toBe('TENANT_STATUS_UNAVAILABLE');
	});

	it('⚠️ an UNKNOWN 503 still returns null, so the caller keeps its own fallback', () => {
		// ⛔ THE BOUND ON THE NEW BRANCH, AND IT IS AN ASSERTION RATHER THAN A COMMENT. A blanket
		// "the service is unavailable" for every 5xx would flatten the one case we can name into the
		// many we cannot — an Istio 503, a rolling deploy, a dead upstream — and every screen would
		// stop showing its own context. Red by widening the branch to `status >= 500`.
		expect(licenseOrPermissionMessage({ status: 503 })).toBeNull();
		expect(licenseOrPermissionMessage({ status: 503, code: 'upstream_gone' })).toBeNull();
		expect(licenseOrPermissionMessage({ status: 503, code: 'toString' })).toBeNull();
		expect(errorText({ status: 503, code: 'upstream_gone' }, 'FALLBACK')).toBe('FALLBACK');
		// …and 500/502/504 are untouched by this lane.
		expect(licenseOrPermissionMessage({ status: 500, code: 'tenant_status_unavailable' })).toBeNull();
	});

	/** `[code, status, the English the backend ships, expected sentinel]`. */
	const LIFECYCLE_4XX: [code: string, status: number, wire: string, sentinel: string][] = [
		// PATCH /api/tenants/:id {status:'active'} on an offboarded tenant.
		['tenant_offboarded', 409, 'This tenant has been offboarded and cannot be reactivated', 'TENANT_OFFBOARDED'],
		// POST /api/tenants/:id/offboard with a confirmation that is not the tenant slug.
		['confirm_mismatch', 400, 'confirm must match the tenant slug', 'CONFIRM_MISMATCH']
	];

	it.each(LIFECYCLE_4XX)('⛔ %s (%d) is localized, not shipped as "%s"', (code, status, wire, sentinel) => {
		const shown = writeErrorText({ status, code, message: wire }, 'FALLBACK');
		expect(shown).toBe(sentinel);
		expect(shown).not.toBe(wire);
		expect(shown).not.toBe('FALLBACK');
	});

	it('⚠️ the 409 and the 400 really do travel different branches of writeErrorText', () => {
		// Non-vacuity for the table: `writeErrorText` consults `VALIDATION_MESSAGES` from TWO separate
		// blocks (400/422, then 409). A table whose rows all shared one status would leave whichever
		// branch it missed unproven — which is exactly how the 409 lookup came to be added as a
		// "so the guard is not a trap" measure rather than because anything exercised it.
		expect(new Set(LIFECYCLE_4XX.map(([, status]) => status))).toEqual(new Set([400, 409]));
	});

	it('⛔ all four sentences are DISTINCT — no flattening onto one refusal', () => {
		// Four refusals with four different repairs: contact your admin (403); wait and retry (503);
		// this workspace is gone for good (409); you mistyped the confirmation (400). Collapsing any
		// two would satisfy every `.toBe(sentinel)` above if the sentinels were equal. They are not.
		const shown = [
			licenseOrPermissionMessage({ status: 403, code: 'tenant_suspended' }),
			licenseOrPermissionMessage({ status: 503, code: 'tenant_status_unavailable' }),
			writeErrorText({ status: 409, code: 'tenant_offboarded', message: 'x' }, 'FALLBACK'),
			writeErrorText({ status: 400, code: 'confirm_mismatch', message: 'x' }, 'FALLBACK')
		];
		expect(new Set(shown).size).toBe(4);
		expect(shown).not.toContain('FALLBACK');
		expect(shown).not.toContain('FORBIDDEN');
	});

	it('⛔ the two 4xx codes are subtracted from the SUBMIT-path set', () => {
		// `error-message.backend-contract.test.ts` fails in BOTH directions on the submit-path mirror:
		// a catalogued code `POST /api/solutions` cannot emit reads as dead copy. Neither of these is
		// on that path — they are `/(platform)/tenants` — so `NON_SUBMIT_PATH_CODES` must contain
		// both. It is derived from `Object.keys(OFF_PATH_REFUSAL_MESSAGES)`, and this asserts the
		// entries really went into THAT object rather than into `VALIDATION_MESSAGES`'s own body,
		// where they would type-check identically and red a guard three files away.
		const subtracted = new Set(NON_SUBMIT_PATH_CODES);
		expect(subtracted.has('tenant_offboarded')).toBe(true);
		expect(subtracted.has('confirm_mismatch')).toBe(true);
	});

	it('⛔ neither 4xx code is ALSO in NOT_LOCALIZED_CODES', () => {
		// The two sets must stay disjoint — a code in both claims coverage and non-coverage at once,
		// and the whole-tree contract test is satisfied by either membership, so an overlap becomes a
		// wrong GREEN. ⚠️ `no_changes` is the near neighbour to check against: it is minted on the
		// SAME route (`PATCH /api/tenants/:id`) and legitimately stays registered, so its presence
		// here is the non-vacuity half — an empty register would make the first two assertions pass
		// for the wrong reason.
		const catalogued = new Set(VALIDATION_MESSAGE_CODES);
		expect(NOT_LOCALIZED_CODES.has('tenant_offboarded')).toBe(false);
		expect(NOT_LOCALIZED_CODES.has('confirm_mismatch')).toBe(false);
		expect(catalogued.has('tenant_offboarded')).toBe(true);
		expect(catalogued.has('confirm_mismatch')).toBe(true);
		expect(NOT_LOCALIZED_CODES.has('no_changes')).toBe(true);
	});
});
