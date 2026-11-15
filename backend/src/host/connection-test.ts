// src/host/connection-test.ts — the ONE shape every "Test connection" endpoint answers with.
//
// ⛔ THE DEFECT THIS EXISTS TO END. Three screens — /connectors, (tenant)/llm-settings and
// (tenant)/delivery — each render a backend `detail` string RAW, and all three of those endpoints
// answer **HTTP 200** by deliberate design (see the docblock on `testTarget` in routes/delivery.ts:
// "a config/credential failure is a normal test result, surfaced as ok:false rather than an HTTP
// error"). Because nothing throws, the frontend's `errorText` helper — the one place 402/403/409
// codes become localized copy — is NEVER invoked on this path. So a Dutch user who clicks
// **Testen** on a connector that WORKS reads:
//
//     Connected — read 5 columns, 3 sample rows.
//
// The success path. In English. On the screen a new tenant admin reaches first.
//
// ⛔ THE FIX IS THE HOUSE PATTERN, NOT A TRANSLATION LAYER IN THE BACKEND. This repo already has
// eighteen `$lib/i18n/*-label` modules whose entire job is "the backend emits a machine code, the
// frontend renders the words". A server cannot know who is reading; it can only state WHAT
// happened. So every return site now carries a stable snake_case `code` plus the machine
// PARAMETERS the sentence needs (`{cols, rows}`, `{status}`, `{project}`), and
// `frontend/src/lib/i18n/connection-test-label.ts` owns every word.
//
// ⚠️ `detail` STAYS, BYTE-IDENTICAL, AND IS NOT DEPRECATED-IN-PLACE. It is:
//   · the fallback the browser renders for a code it does not know — and a rolling deploy WILL
//     serve one, because the browser reaches the API through the Service and a new bundle really is
//     answered by an old pod for the length of the roll;
//   · the only content for the branches that have no classification to give (an arbitrary driver
//     exception), where a generic localized sentence would say strictly LESS;
//   · what the audit rows and the server logs already record.
// Removing it is a separate decision for a later release, not a side effect of this one.
export interface ConnectionTestResult {
  ok: boolean;
  /**
   * A stable machine code — snake_case, never localized, never a sentence.
   *
   * Typed `string` rather than a literal union ON PURPOSE. Two of the sites that build one of these
   * forward an `HttpError.code` straight through (a connector-config refusal, a delivery precheck),
   * and that code space is owned by other modules and is genuinely open. The frontend's switch is
   * exhaustive over what it knows and falls back to `detail` for everything else — which is the
   * same contract `data-finding-label.ts` and `api/graph-issues.ts` already run on.
   */
  code: string;
  /**
   * The machine fields the reader's sentence interpolates — counts, an HTTP status, a project key.
   *
   * ⛔ NEVER PROSE, and never anything secret. Everything here is rendered into a localized
   * sentence by the browser, so an English phrase smuggled in as a "parameter" would defeat the
   * whole change; and these endpoints handle credentials, so the rule is "only the values the
   * sentence names".
   */
  params?: Record<string, string | number>;
  /** The pre-existing English sentence. See the note above — this is a fallback, not dead weight. */
  detail: string;
}
