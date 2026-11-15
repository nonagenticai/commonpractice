// src/host/delivery/errors.ts — Phase 5B. Typed errors for the delivery adapters so the
// forward/retry routes map outcomes deterministically (config errors → 422 with NO ledger
// row; dispatch errors → a persisted 'failed' row + 200). Kept tiny + drizzle-free.

/**
 * The machine fields behind a `DeliveryConfigError`'s English sentence.
 *
 * Every field is OPTIONAL and every consumer must degrade when one is absent — the browser reaches
 * the API through a Service that load-balances across old and new pods for the length of a rolling
 * deploy, so `detail === undefined` on a known code is a real wire shape, not a hypothetical.
 *
 * · `kind`   — which connector. Present on all 14 throw sites; the frontend needs it to name the
 *              tool, and an absent one sends the reader back to the English sentence.
 * · `field`  — for `delivery_target_incomplete`: WHICH config field is empty. The two values are
 *              the CONNECTOR-FORM fields (`delivery_baseurl_label`, `delivery_project_key_label`),
 *              which is why Azure DevOps's "organization URL"/"project" prose maps onto
 *              `base_url`/`project_key` rather than onto two further values: the reader fixes it in
 *              the box the form calls "Base URL", whatever the vendor calls it.
 * · `reason` — for `delivery_target_credentials_invalid`: the ciphertext would not decrypt
 *              (`undecryptable`) versus decrypted to the wrong shape (`malformed`). Two different
 *              causes, one identical repair (re-enter the credentials), but the sentence that names
 *              the cause is the one an admin can act on without guessing.
 */
// ⚠️ A `type` ALIAS, NOT AN `interface`, AND THE DIFFERENCE IS LOAD-BEARING. `unprocessable()` takes
// `Record<string, unknown>`; TypeScript gives an object-literal type an implicit index signature but
// an `interface` none, so the interface form does not typecheck at the two forwarding sites in
// routes/delivery.ts and the "fix" under pressure is a cast that would erase the shape.
export type DeliveryConfigDetail = {
  kind: 'jira' | 'azure_devops' | 'fr';
  field?: 'base_url' | 'project_key';
  reason?: 'undecryptable' | 'malformed';
};

/** A connector's config is incomplete/invalid: missing base_url/project_key, no stored
 *  credentials, or a credentials blob that doesn't decrypt to the expected shape. This is
 *  NOT a dispatch failure — the admin must fix the connector first — so the route maps it to
 *  422 and writes no `solution_deliveries` row. */
export class DeliveryConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /**
     * The MACHINE fields behind the English `message`, forwarded onto the wire by
     * `routes/delivery.ts`'s `unprocessable(err.code, err.message, err.detail)`.
     *
     * ⛔ IT EXISTS BECAUSE THE CODE IS COARSER THAN THE SENTENCE. `delivery_target_incomplete` is
     * thrown from FIVE sites with five different English sentences ("…missing its base URL",
     * "…missing its project key", "…missing its organization URL", "…missing its project") and
     * `delivery_target_credentials_invalid` from SIX. A browser that keys only on `code` can
     * therefore say no more than "not fully configured", which is strictly less than the English it
     * replaces — and the alternative, minting eleven new codes, would break every consumer that
     * already switches on these three (the ledger column, the connection-test result, the backend's
     * own tests).
     *
     * ⛔ THE ENGLISH `message` IS UNCHANGED, BYTE FOR BYTE, and must stay that way. It is the
     * correct output for the reader that is NOT a browser and it is the frontend's documented
     * fallback for an old pod that ships no `detail` at all. Same split as
     * `frontend/src/lib/i18n/graph-issue-label.ts` records.
     *
     * `kind` is repeated on every throw rather than filled in by the route, because the ADAPTER is
     * the authority on which connector it is validating — `routes/delivery.ts` resolves the adapter
     * by `target.kind` through three explicit branches precisely so that mapping is never inferred.
     */
    readonly detail?: DeliveryConfigDetail,
  ) {
    super(message);
    this.name = 'DeliveryConfigError';
  }
}

/** The dispatch reached (or tried to reach) the target but failed: a non-2xx from the target
 *  API, or a transport/timeout error. Carries the HTTP status (0 for transport/timeout) and a
 *  jsonb-safe `body` so the route can persist `solution_deliveries.{status:'failed', error,
 *  response}` and the UI can show it. */
export class DeliveryDispatchError extends Error {
  constructor(
    /** 'target_http_error' | 'transport' | 'timeout' */
    readonly code: string,
    /** the target's HTTP status, or 0 for a transport/timeout failure (no response). */
    readonly status: number,
    message: string,
    /** the target's response body (or {raw}/{message}); always a jsonb-safe object. */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DeliveryDispatchError';
  }
}
