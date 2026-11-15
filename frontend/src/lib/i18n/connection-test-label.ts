// src/lib/i18n/connection-test-label.ts — the ONE place a "Test connection" result becomes words.
//
// ⛔ THE DEFECT, AND ITS SUCCESS PATH IS THE WORST PART. Three screens render a backend `detail`
// string RAW:
//
//   routes/connectors/+page.svelte            {#if testResult}<div …>{testResult.detail}</div>
//   routes/(tenant)/llm-settings/+page.svelte <div class="test-result …">{testResult.detail}</div>
//   routes/(tenant)/delivery/+page.svelte     <div class="test-result …">{testResults[t.id].detail}</div>
//
// All three endpoints answer **HTTP 200** by deliberate design (backend/src/routes/delivery.ts
// documents it: "a config/credential failure is a normal test result, surfaced as ok:false rather
// than an HTTP error"). Nothing throws, so `api/error-message.ts`'s `errorText` — the one place
// this app turns a backend code into localized copy — is NEVER invoked on this path. The result:
// a Dutch tenant admin who clicks **Testen** on a connector that WORKS reads
//
//     Connected — read 5 columns, 3 sample rows.
//
// in English, on the screen a new workspace reaches first. The failure paths were English too, but
// the success path is the one nobody thinks to check, because "the test passed" feels like a
// non-event.
//
// ⛔ THE FIX IS THE HOUSE SPLIT, NOT BACKEND TRANSLATION. `backend/src/host/connection-test.ts`
// now defines one `ConnectionTestResult { ok, code, params?, detail }` and every return site in
// routes/connectors.ts, routes/llm-settings.ts, routes/delivery.ts and the three delivery adapters
// carries a stable snake_case code plus the machine facts its sentence needs. This module owns the
// words. Same shape as the eighteen `*-label` modules beside it.
//
// ⛔ THE FALLBACK IS LOAD-BEARING AND MUST NEVER RENDER BLANK. A code this build does not know
// falls back to `detail`, because:
//   · a rolling deploy WILL serve one — the browser reaches the API through the Service, so a new
//     bundle really is answered by an old pod for the length of the roll (this exact hazard blanked
//     /governance and was caught only at review in PR #233);
//   · two sites forward an `HttpError.code` from code spaces this module does not own
//     (`validateConnectorConfig`, the delivery precheck, `assertFrLicense`) — those are open sets
//     by construction, not an oversight. ⚠️ "Does not own" is no longer "does not handle": the two
//     codes a mistyped connector form actually produces — `bad_config` and `unknown_connector` —
//     now have cases below, because leaving the ONE refusal a Dutch admin reaches first to the
//     fallback made the fallback the product. The set stays open, so the default still catches a
//     ninth `reason` or a code from the other two spaces;
//   · an old pod ships NO `code` field at all, which lands in the same branch.
// An English sentence is a worse read than a Dutch one and an infinitely better read than nothing.
//
// ⚠️ `detail` IS ALSO A PARAMETER on two codes, which is a different thing from being a fallback.
// `connector_test_failed` and `llm_test_failed` wrap an arbitrary driver/provider exception
// ("connect ECONNREFUSED 10.0.0.4:5432") that no catalog can ever contain and that is the most
// useful text on the screen. There the FRAME is localized and the technical string is interpolated
// into it — never dropped for a generic sentence that would say strictly less.
//
// EXHAUSTIVE SWITCH, NOT A LOOKUP TABLE — paraglide compiles one function per key and tree-shakes
// on the import graph, so `m[`${code}`]()` does not resolve. The house idiom.
import * as m from '$lib/paraglide/messages';
import { num } from '$lib/utils/format';
import { deliveryKindLabel } from './delivery-error-label';

/** The wire shape all three test endpoints answer with. `code`/`params` are absent from an old pod. */
export interface ConnectionTestResult {
	ok: boolean;
	code?: string;
	params?: Record<string, string | number>;
	detail: string;
}

/**
 * Bidirectional isolation for a value the PRODUCT does not constrain.
 *
 * Copied deliberately from `graph-issue-label.ts`, which carries the full reasoning: U+2068 FIRST
 * STRONG ISOLATE / U+2069 POP DIRECTIONAL ISOLATE are exactly what `<bdi>` compiles down to, are
 * zero-width, and change nothing in the five LTR locales — but returning `<bdi>` markup instead
 * would require `{@html}` at the render site, which would inject backend-supplied strings into the
 * DOM as HTML.
 *
 * ⛔ IT IS NOT DECORATION HERE. Every value it wraps is attacker- or environment-supplied and
 * mixed-script by nature: a Jira display name, an ADO project key, an fr base URL, a model id, and
 * above all a raw driver exception. Without isolation, `Could not reach {tool}: {detail}` in Hebrew
 * reorders a latin host:port into nonsense, and a display name containing Arabic swaps the sentence
 * around it.
 */
const iso = (v: string): string => `⁨${v}⁩`;

/** A `params` value as a string, or `null` when the field is absent — the mid-roll guard. */
function str(p: Record<string, string | number> | undefined, k: string): string | null {
	const v = p?.[k];
	return typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;
}

/** A `params` value as a number, or `null` when absent. `0` is preserved — it is a real count. */
function int(p: Record<string, string | number> | undefined, k: string): number | null {
	const v = p?.[k];
	return typeof v === 'number' ? v : null;
}

/**
 * The reader's sentence for one connection-test result.
 *
 * ⛔ `locale` IS A PARAMETER BECAUSE THIS IS A PLAIN `.ts` MODULE — it cannot import
 * `$lib/stores/locale.svelte` without binding every importer (including this file's own pure-logic
 * spec) to the Svelte runtime. `notification-label.ts` and `ops-alert-label.ts` solved exactly this
 * the same way: the COMPONENT passes `locale.current` from its template, where the rune is in
 * scope and the read is reactive. It is needed here for `num()` on the column/row counts.
 *
 * Takes `code?: string` rather than a literal union, for the open-code-space reason in the header.
 */
export function connectionTestLabel(r: ConnectionTestResult, locale: string): string {
	const p = r.params;
	switch (r.code) {
		// ── /connectors ──────────────────────────────────────────────────────────────────────────
		case 'connector_test_ok': {
			// ⛔ THE MID-ROLL GUARD IS NOT CEREMONY. An old pod ships this code with no `params` at
			// all, and "Kolommen gelezen: undefined" is a localized sentence that says LESS than the
			// English it replaced. `0` is a legitimate value (a source with no rows yet), which is
			// exactly why `int()` preserves it and this test is `=== null`.
			// ⚠️ EXPLICITLY ANNOTATED `: number | null`, NOT INFERRED, AND THAT IS THE POINT.
			// `$lib/test/number-sites.ts` builds its numeric vocabulary from DECLARATIONS; an
			// un-annotated `const x = int(…)` is invisible to it, so `icu-number-params.sites.test.ts`
			// would pass while a raw figure reached a message — the precise blind spot that file was
			// written to close. Annotating puts these three sites INTO the inventory, where each one
			// then has to be classified as grouped or written down.
			const cols: number | null = int(p, 'cols');
			const rows: number | null = int(p, 'rows');
			if (cols === null || rows === null) return r.detail;
			// ⚠️ GROUPED IN THE READER'S LOCALE. `rows` is `result.rows?.length` — the WHOLE fetched
			// set, bounded by DATASET_INJECT_ROW_CAP = 10 000 — so four digits is an ordinary value
			// here, and "10000" beside a "10.000" elsewhere on the same screen is the exact
			// self-contradiction `icu-number-params.sites.test.ts` exists to stop.
			return m.connector_test_ok({
				cols: num(cols, locale),
				rows: num(rows, locale)
			});
		}
		case 'connector_test_failed': {
			const detail = str(p, 'detail');
			if (!detail) return r.detail;
			return m.connector_test_failed({ detail: iso(detail) });
		}

		// ── /connectors — the REFUSAL, which never reached this switch at all ────────────────────
		// ⛔ `bad_config` IS THE ONE A DUTCH ADMIN ACTUALLY HITS FIRST, and it was the only family
		// this module never had a case for. `routes/connectors.ts` catches `validateConnectorConfig`'s
		// `HttpError` and answers **HTTP 200** `{ok:false, code:'bad_config', detail:"'url' is
		// required"}` — its own comment says "the frontend localizes the ones it knows and falls back
		// to `detail` for the rest", and this was one of the rest. Sixteen cases, every one a
		// `*_test_*` RESULT; the sentence a mistyped form produces stayed English on the Dutch screen.
		//
		// ⛔ ONE CODE, EIGHT SENTENCES — `reason` IS THE DISCRIMINATOR, NOT A NEW CODE. `utils/http.ts`
		// states the seam: `reason` travels in `details` precisely because `code` is already keyed on
		// by this switch and by backend tests, so adding a sub-discriminator is additive while
		// renaming the code is a behaviour change. An old pod sends `code` with NO `reason` and lands
		// in the inner `default` → `detail`, exactly like the outer one.
		case 'bad_config': {
			// ⚠️ The reason values are the backend's `badRequest('bad_config', …, { reason })` sites in
			// `datasets/connectors/index.ts` (config validation) and `datasets/connectors/storage.ts`
			// (the URL builder's post-condition). Pinned by the backend scan in this module's spec.
			switch (str(p, 'reason')) {
				// `field` is a CONFIG KEY the caller supplied ('url', 'query', 'bucket', 'key',
				// 'baseUrl'). It is not product-constrained — a `.strict()` zod record accepts any
				// string key — so it is isolated like every other foreign value here.
				case 'required': {
					const field = str(p, 'field');
					if (!field) return r.detail;
					return m.bad_config_required({ field: iso(field) });
				}
				case 'percent_escape': {
					const field = str(p, 'field');
					if (!field) return r.detail;
					return m.bad_config_percent_escape({ field: iso(field) });
				}
				case 'backslash': {
					const field = str(p, 'field');
					if (!field) return r.detail;
					return m.bad_config_backslash({ field: iso(field) });
				}
				case 'dot_segment': {
					const field = str(p, 'field');
					if (!field) return r.detail;
					return m.bad_config_dot_segment({ field: iso(field) });
				}
				case 'absolute': {
					const field = str(p, 'field');
					if (!field) return r.detail;
					return m.bad_config_absolute({ field: iso(field) });
				}
				// No parameter: the whole sentence is the rule, and the two scheme lists are protocol
				// tokens, not translatable words.
				case 'postgres_scheme':
					return m.bad_config_postgres_scheme();
				case 'http_scheme':
					return m.bad_config_http_scheme();
				case 'key_escapes_bucket': {
					// `resolved` is the URL-parser's normalised pathname — the single most useful fact on
					// the screen, because it shows WHERE the key actually pointed after `..` collapsed.
					const resolved = str(p, 'resolved');
					if (!resolved) return r.detail;
					return m.bad_config_key_escapes_bucket({ resolved: iso(resolved) });
				}
				default:
					// No `reason` (an old pod), or a ninth reason added backend-first. Never blank.
					return r.detail;
			}
		}
		// ⛔ THE SQL GUARD'S THREE REFUSALS REACH THIS SCREEN TOO, AND THE FIRST PASS MISSED THEM.
		// `assertReadOnlySelect` (backend/src/datasets/connectors/postgres.ts:20,22,25) runs INSIDE
		// `validateConnectorConfig`, so `/api/connectors/test` catches it in the same branch that
		// forwards `bad_config` — a different code, the same 200-OK path, and no case here. Caught by
		// typing `delete from datasets` into the Dutch form and reading the notice: two of three
		// refusals came back Dutch and this one came back
		// `connector query must be a SELECT (or WITH … SELECT)`.
		//
		// The keys are the ones `VALIDATION_MESSAGES` already owns for the THROWN 400 of the same
		// codes on the create path — one sentence per refusal, whichever route the user took.
		case 'empty_query':
			return m.error_empty_query();
		case 'multi_statement':
			return m.error_multi_statement();
		case 'not_select':
			return m.error_not_select();
		case 'unknown_connector': {
			// ⛔ NOT REACHABLE FROM THIS SCREEN TODAY — say so rather than let the next reader assume
			// coverage this branch does not have. Both throw sites are `default:` arms guarded by a
			// zod enum: `routes/connectors.ts` hands `validateConnectorConfig` a `body.sourceType`
			// typed `z.enum(['postgres','storage','http'])`, so a fourth value 422s before it arrives,
			// and `fetchConnector` only ever sees a config that function already returned.
			//
			// It is kept, not deleted, because the code space is open by construction: the SYNC path
			// (`datasets/connector-refresh.ts:201`) builds its config from a PERSISTED row via
			// `loadConnectorConfig`, which no enum guards, so a row written by another build can still
			// reach it. Deleting the branch would make that case render the English sentence again.
			// Recorded as known dead copy on the /test path in the session handoff.
			//
			// ⚠️ `kind` IS GENUINELY OPTIONAL, which is why this is two keys and not one with an empty
			// `{kind}`. `validateConnectorConfig`'s default branch knows the rejected kind and names it;
			// `fetchConnector`'s default has already narrowed `cfg` to a typed union and has no string
			// to report. An empty `{kind}` would render "“” is not a source type" — a localized
			// sentence that says less than the English it replaced.
			const kind = str(p, 'kind');
			return kind ? m.unknown_connector({ kind: iso(kind) }) : m.unknown_connector_generic();
		}

		// ── (tenant)/llm-settings ────────────────────────────────────────────────────────────────
		case 'llm_test_ok': {
			const provider = str(p, 'provider');
			const model = str(p, 'model');
			if (!provider || !model) return r.detail;
			return m.llm_test_ok({ provider: iso(provider), model: iso(model) });
		}
		case 'llm_test_model_not_offered': {
			const model = str(p, 'model');
			const provider = str(p, 'provider');
			if (!model || !provider) return r.detail;
			return m.llm_test_model_not_offered({ model: iso(model), provider: iso(provider) });
		}
		case 'llm_test_no_api_key':
			return m.llm_test_no_api_key();
		case 'llm_test_stub_only':
			return m.llm_test_stub_only();
		case 'llm_test_failed': {
			const detail = str(p, 'detail');
			if (!detail) return r.detail;
			return m.llm_test_failed({ detail: iso(detail) });
		}

		// ── (tenant)/delivery ────────────────────────────────────────────────────────────────────
		// `kind` is the machine token the adapters emit ('jira' | 'azure_devops'); the PRODUCT NAME
		// is resolved here through the same `deliveryKindLabel` the rest of the delivery UI uses, so
		// the tool name is localized alongside the sentence rather than baked into the backend.
		case 'delivery_test_unreachable': {
			const kind = str(p, 'kind');
			const detail = str(p, 'detail');
			if (!kind || !detail) return r.detail;
			return m.delivery_test_unreachable({ tool: deliveryKindLabel(kind), detail: iso(detail) });
		}
		case 'delivery_test_http': {
			const kind = str(p, 'kind');
			const status: number | null = int(p, 'status');
			if (!kind || status === null) return r.detail;
			// ⚠️ `status` IS NOT GROUPED and must never be — it is an HTTP status code, three digits
			// by definition, and "4.04" is not a status. Recorded as an explicit RAW_PARAM exclusion
			// in `icu-number-params.sites.test.ts`, which is why the annotation above matters: without
			// it the scan never asks the question and the exclusion could not be stated.
			return m.delivery_test_http({ tool: deliveryKindLabel(kind), status });
		}
		case 'delivery_test_jira_ok': {
			const user = str(p, 'user');
			if (!user) return r.detail;
			return m.delivery_test_jira_ok({ tool: deliveryKindLabel('jira'), user: iso(user) });
		}
		case 'delivery_test_jira_ok_anon':
			// ⛔ ITS OWN CODE rather than `delivery_test_jira_ok` with an empty `{user}`. Jira answers
			// `/myself` with neither a display name nor an email often enough (an app-scoped token, a
			// privacy-restricted directory) that the backend used to paper over it with the English
			// literal "the configured user" — prose, travelling on the wire, which is the whole defect.
			return m.delivery_test_jira_ok_anon({ tool: deliveryKindLabel('jira') });
		case 'delivery_test_jira_unauthorized':
			return m.delivery_test_jira_unauthorized({ tool: deliveryKindLabel('jira') });
		case 'delivery_test_ado_ok': {
			const project = str(p, 'project');
			if (!project) return r.detail;
			return m.delivery_test_ado_ok({
				tool: deliveryKindLabel('azure_devops'),
				project: iso(project)
			});
		}
		case 'delivery_test_ado_unauthorized':
			return m.delivery_test_ado_unauthorized({ tool: deliveryKindLabel('azure_devops') });
		case 'delivery_test_ado_project_not_found': {
			const project = str(p, 'project');
			if (!project) return r.detail;
			return m.delivery_test_ado_project_not_found({ project: iso(project) });
		}
		case 'delivery_test_fr_ok': {
			const base = str(p, 'base');
			if (!base) return r.detail;
			return m.delivery_test_fr_ok({ base: iso(base) });
		}

		// ── (tenant)/delivery — fr GATE 2, four reasons that used to share ONE code ──────────────
		// ⛔ THE DEFECT WAS A COLLAPSE, NOT A MISSING TRANSLATION. `assertFrLicense`
		// (backend/src/services/fr-license.ts) distinguishes four reasons — inactive, app_mismatch,
		// tenant_mismatch, introspect_unavailable — and gave every one of them the code
		// `fr_license_required`, carrying the difference ONLY in an English sentence. This screen
		// reaches them through the same 200-OK catch as `bad_config` (routes/delivery.ts:249-258), so
		// nothing throws, `errorText` never runs, and the `default` below rendered that English prose
		// to a Dutch tenant_admin. Four codes now, one sentence each.
		//
		// ⚠️ PARAMETERLESS, AND THAT IS A DECISION, NOT AN OMISSION. The only machine fact the old
		// prose carried is the `app.key` in the app_mismatch case ("commonpractice") — a
		// licensing-server token the reader can neither recognise nor act on. The action is the same
		// whatever it says: put an fr licence on this connector. Carrying it would mean a `params`
		// bag, which `paymentRequired(code, message)` has no slot for and which the 200-OK branch
		// would drop anyway — the exact plumbing four codes exist to avoid. It stays in `detail`,
		// which remains the log line and the MCP read.
		//
		// ⚠️ NOT `LICENSE_BLOCK_CODES` MEMBERS. A workspace whose CP licence is fine must not be
		// blanked by the whole-app renewal wall because one connector holds a wrong fr token — see
		// `$lib/api/fr-license-codes.guard.test.ts`, which pins that absence with its consequence.
		case 'fr_license_inactive':
			return m.fr_license_inactive();
		case 'fr_license_app_mismatch':
			return m.fr_license_app_mismatch();
		case 'fr_license_tenant_mismatch':
			return m.fr_license_tenant_mismatch();
		case 'fr_license_unavailable':
			return m.fr_license_unavailable();

		default:
			// An unknown code, or NO code at all (an old pod). See the header — never blank.
			// ⚠️ `fr_license_required`, the collapsed code these four replaced, lands HERE for the
			// length of a roll and renders its English `detail`. Deliberate: worse than Dutch, far
			// better than blank.
			return r.detail;
	}
}
