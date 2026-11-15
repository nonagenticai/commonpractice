// src/routes/delivery.ts — Phase 5 / 5A: per-tenant delivery-connector config + the delivery ledger.
//
// A tenant_admin configures their external backlog connectors (Jira / Azure DevOps / fr) here; the
// actual "Forward to delivery" dispatch (the adapters + POST /forward) lands in 5B/5C/5D. Mirrors
// the llm-settings secret-form posture: credentials are secret-box encrypted on write, NEVER
// returned on read (only `hasCredentials`), and a write that omits `credentials` keeps the stored
// blob. Everything is scoped to the caller's effective tenant (requireTenantAdmin) with an explicit
// tenant predicate (app-layer scope; RLS is the DB-level backstop). See SPEC-PHASE5 Parts 4 / 6.
//
//   • GET    /api/delivery-targets            — list the tenant's connectors (credentials stripped)
//   • POST   /api/delivery-targets            — create a connector
//   • PUT    /api/delivery-targets/:id        — update (omit `credentials` to keep the stored blob)
//   • DELETE /api/delivery-targets/:id        — remove a connector
//   • GET    /api/solutions/:id/deliveries    — this solution's delivery attempts (5B populates them)
import { z } from 'zod';
import { and, eq, desc, inArray } from 'drizzle-orm';
import {
  db,
  withTenantDb,
  deliveryTargets,
  solutionDeliveries,
  solutions,
  challenges,
  flows,
  type DeliveryTarget,
  type SolutionDelivery,
  type Solution,
  type Challenge,
  type Flow,
} from '../db/client';
import { requireTenantAdmin } from '../middleware/admin-guards';
import { requireFrFeedbackWriter } from '../middleware/fr-feedback-auth';
import { assertTenantNotSuspended } from '../middleware/tenant-status-gate';
import { recordAudit } from '../host/audit-service';
import { encryptSecret } from '../host/secret-box';
import { buildDeliveryPayload } from '../services/delivery-payload';
import type { DeliveryPayload } from '../db/delivery-types';
import {
  resolveChallengeDatasets,
  resolveChallengeEntities,
} from '../challenges/challenge-data-service';
import { getSnapshot, type GovernanceSnapshot } from '../host/policy-store';
import { assertEgressAllowed, EgressBlockedError } from '../host/egress-guard';
import { deliverJira, assertJiraConfigured, testJiraConnection } from '../host/delivery/jira';
import { deliverAzureDevOps, assertAzureDevOpsConfigured, testAzureDevOpsConnection } from '../host/delivery/azure-devops';
import { deliverFr, assertFrConfigured, testFrConnection } from '../host/delivery/fr';
import { assertFrLicense, FrLicenseError } from '../services/fr-license';
import { DeliveryConfigError, DeliveryDispatchError } from '../host/delivery/errors';
import type { DeliveryTargetKind } from '../db/delivery-types';
import {
  jsonResponse,
  readJson,
  route,
  notFound,
  conflict,
  unprocessable,
  paymentRequired,
  HttpError,
} from '../utils/http';
import { isUniqueViolation } from '../utils/pg-errors';
import type { Router } from '../utils/router';
import type { ConnectionTestResult } from '../host/connection-test';

/** The delivery statuses considered "live" — the partial-unique idempotency index
 *  (solution_deliveries_live_uq, migration 0032) covers exactly these. One live delivery per
 *  (solution, target); 'failed'/'rejected' are excluded → re-sendable. */
const LIVE_DELIVERY_STATUSES = [
  'pending',
  'sent',
  'created',
  'draft_created',
  'approved',
  'promoted',
] as const;

const kindEnum = z.enum(['jira', 'azure_devops', 'fr']);

const createSchema = z
  .object({
    kind: kindEnum,
    name: z.string().min(1).max(120),
    baseUrl: z.string().url().max(500).optional(),
    projectKey: z.string().max(200).optional(),
    defaultItemType: z.string().max(60).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    // The secret blob (Jira {email,apiToken} / ADO {pat} / fr {licenseToken}). Opaque here.
    credentials: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// Update: every field optional; `kind` is immutable (a connector doesn't change target type).
const updateSchema = createSchema.omit({ kind: true }).partial().strict();

/** The client-safe projection: the row minus the encrypted blob, plus a boolean presence flag. */
function publicTarget(row: DeliveryTarget) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.base_url,
    projectKey: row.project_key,
    defaultItemType: row.default_item_type,
    config: row.config,
    enabled: row.enabled,
    hasCredentials:
      row.credentials_encrypted != null && row.credentials_encrypted.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** GET /api/delivery-targets — the tenant's configured connectors (credentials stripped). */
const listTargets = route(async (req) => {
  const { effectiveTenantId: tenantId } = await requireTenantAdmin(req);
  const rows = await db
    .select()
    .from(deliveryTargets)
    .where(eq(deliveryTargets.tenant_id, tenantId))
    .orderBy(desc(deliveryTargets.created_at));
  return jsonResponse({ targets: rows.map(publicTarget) });
});

/** POST /api/delivery-targets — create a connector (force-scoped to the effective tenant). */
const createTarget = route(async (req) => {
  const { user: actor, effectiveTenantId: tenantId } = await requireTenantAdmin(req);
  const body = createSchema.parse(await readJson(req));

  const values = {
    tenant_id: tenantId,
    kind: body.kind,
    name: body.name,
    base_url: body.baseUrl ?? null,
    project_key: body.projectKey ?? null,
    default_item_type: body.defaultItemType ?? null,
    config: body.config ?? {},
    credentials_encrypted: body.credentials
      ? encryptSecret(JSON.stringify(body.credentials))
      : null,
    enabled: body.enabled ?? true,
  };

  let row: DeliveryTarget | undefined;
  try {
    [row] = await db.insert(deliveryTargets).values(values).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('delivery_target_name_taken', 'A connector with that name already exists');
    }
    throw err;
  }

  await recordAudit({
    actorId: actor.id,
    action: 'delivery_target.create',
    category: 'deploy',
    targetType: 'delivery_target',
    targetId: row!.id,
    result: `${row!.kind} · ${row!.name}`,
    resultTone: 'ok',
    metadata: { tenantId, kind: row!.kind, hasCredentials: row!.credentials_encrypted != null },
  });
  return jsonResponse({ target: publicTarget(row!) }, 201);
});

/** PUT /api/delivery-targets/:id — update; omitting `credentials` keeps the stored blob. */
const updateTarget = route(async (req, id) => {
  const { user: actor, effectiveTenantId: tenantId } = await requireTenantAdmin(req);
  const body = updateSchema.parse(await readJson(req));

  // Build the patch, only touching the encrypted blob when a new one is supplied.
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.baseUrl !== undefined) patch.base_url = body.baseUrl;
  if (body.projectKey !== undefined) patch.project_key = body.projectKey;
  if (body.defaultItemType !== undefined) patch.default_item_type = body.defaultItemType;
  if (body.config !== undefined) patch.config = body.config;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.credentials !== undefined) {
    patch.credentials_encrypted = encryptSecret(JSON.stringify(body.credentials));
  }

  let rows: DeliveryTarget[];
  try {
    rows = await db
      .update(deliveryTargets)
      .set(patch)
      .where(and(eq(deliveryTargets.id, id!), eq(deliveryTargets.tenant_id, tenantId)))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('delivery_target_name_taken', 'A connector with that name already exists');
    }
    throw err;
  }
  if (!rows.length) throw notFound('delivery_target_not_found');

  await recordAudit({
    actorId: actor.id,
    action: 'delivery_target.update',
    category: 'deploy',
    targetType: 'delivery_target',
    targetId: rows[0]!.id,
    result: `${rows[0]!.kind} · ${rows[0]!.name}`,
    resultTone: 'ok',
    metadata: { tenantId, credentialsRotated: body.credentials !== undefined },
  });
  return jsonResponse({ target: publicTarget(rows[0]!) });
});

/** DELETE /api/delivery-targets/:id — remove a connector. */
const deleteTarget = route(async (req, id) => {
  const { user: actor, effectiveTenantId: tenantId } = await requireTenantAdmin(req);
  const rows = await db
    .delete(deliveryTargets)
    .where(and(eq(deliveryTargets.id, id!), eq(deliveryTargets.tenant_id, tenantId)))
    .returning({ id: deliveryTargets.id, name: deliveryTargets.name });
  if (!rows.length) throw notFound('delivery_target_not_found');

  await recordAudit({
    actorId: actor.id,
    action: 'delivery_target.delete',
    category: 'deploy',
    targetType: 'delivery_target',
    targetId: id,
    result: rows[0]!.name,
    resultTone: 'warn',
    metadata: { tenantId },
  });
  return jsonResponse({ ok: true });
});

/** POST /api/delivery-targets/:id/test — verify a saved connector end-to-end without dispatching:
 *  precheck (config + fr license + egress allowlist) then a lightweight authenticated probe
 *  (Jira GET /myself, ADO GET project; fr is fully verified by the precheck's license introspect).
 *  Returns 200 {ok, detail} in all reachable cases — a config/credential failure is a normal test
 *  result, surfaced as ok:false rather than an HTTP error. */
const testTarget = route(async (req, id) => {
  const { effectiveTenantId: tenantId } = await requireTenantAdmin(req);
  const [target] = await db
    .select()
    .from(deliveryTargets)
    .where(and(eq(deliveryTargets.id, id!), eq(deliveryTargets.tenant_id, tenantId)))
    .limit(1);
  if (!target) throw notFound('delivery_target_not_found');

  let snapshot: GovernanceSnapshot;
  try {
    snapshot = await precheckTarget(target);
  } catch (e) {
    // precheck maps config→422, fr license→402, egress→422 as HttpError; surface as a test result.
    // ⛔ `e.code` IS ALREADY THE MACHINE TOKEN and is forwarded rather than re-derived — the precheck
    // codes are the SAME taxonomy the ledger persists (`delivery_target_incomplete`,
    // `delivery_target_credentials_missing`, the four `egress_*`) plus the fr-licence ones, so the
    // frontend localizes them through one switch. This branch is the reason `ConnectionTestResult.code`
    // is `string` and not a literal union: `assertFrLicense` owns part of that code space.
    if (e instanceof HttpError)
      return jsonResponse({ ok: false, code: e.code, detail: e.message ?? e.code });
    throw e;
  }

  let result: ConnectionTestResult;
  if (target.kind === 'jira') result = await testJiraConnection(target, snapshot);
  else if (target.kind === 'azure_devops') result = await testAzureDevOpsConnection(target, snapshot);
  else result = testFrConnection(target);
  return jsonResponse(result);
});

/** GET /api/solutions/:id/deliveries — this solution's delivery attempts (read-only; 5B writes
 *  the rows). Asserts the solution belongs to the effective tenant (404 otherwise). */
const listDeliveries = route(async (req, id) => {
  const { effectiveTenantId: tenantId } = await requireTenantAdmin(req);

  // The solution must exist AND belong to this tenant (its challenge's tenant is the authority).
  const [sol] = await db
    .select({ id: solutions.id, tenantId: challenges.tenant_id })
    .from(solutions)
    .innerJoin(challenges, eq(challenges.id, solutions.challenge_id))
    .where(eq(solutions.id, id!))
    .limit(1);
  if (!sol || sol.tenantId !== tenantId) throw notFound('solution_not_found');

  const rows = await db
    .select()
    .from(solutionDeliveries)
    .where(
      and(
        eq(solutionDeliveries.solution_id, id!),
        eq(solutionDeliveries.tenant_id, tenantId),
      ),
    )
    .orderBy(desc(solutionDeliveries.created_at));

  return jsonResponse({ deliveries: rows.map(publicDelivery) });
});

/**
 * The failure CLASSIFICATION of a ledger row, lifted out of the stored `response` jsonb.
 *
 * ⛔ TWO SEPARATE `null`s, AND THE DIFFERENCE IS THE WHOLE POINT.
 *  · A row written BEFORE this change has a `response` with no `_cp_code` at all. Those rows hold
 *    only the adapter's English sentence and nothing can recover the code — the row is not migrated
 *    and must not be. `null` here tells the browser "fall back to `error`", which is the honest
 *    render for history.
 *  · A row whose failure was genuinely unclassified (an exception outside the typed taxonomy)
 *    stores `_cp_code: null` on purpose — same answer, same fallback, for the same reason: the raw
 *    message is the only information that exists.
 *
 * Reading it defensively (`typeof === 'string'`) rather than casting: `response` is jsonb written
 * partly from a REMOTE system's response body, so its shape is not ours to assume.
 */
function errorClassification(row: SolutionDelivery): { code: string | null; status: number | null } {
  const r = row.response as Record<string, unknown> | null;
  return {
    code: typeof r?._cp_code === 'string' ? r._cp_code : null,
    status: typeof r?._cp_status === 'number' ? r._cp_status : null,
  };
}

/** The client-safe delivery projection — the ledger row minus the canonical `payload`,
 *  `initiated_by`, and the raw `response`. Shared by listDeliveries / forward / retry so the
 *  frontend has one shape and the secret-bearing payload provenance never leaks.
 *
 *  ⛔ `errorCode`/`errorStatus` ARE NOT "THE RESPONSE, LEAKED". The raw `response` stays off the
 *  wire exactly as before; what is added is the two CP-authored scalars this route itself wrote
 *  into it (a snake_case taxonomy token and an HTTP status), which is the machine half of the
 *  `error` sentence beside them. Neither can carry a credential or a payload fragment. */
function publicDelivery(row: SolutionDelivery) {
  const cls = errorClassification(row);
  return {
    id: row.id,
    targetId: row.target_id,
    targetKind: row.target_kind,
    status: row.status,
    externalRef: row.external_ref,
    externalUrl: row.external_url,
    // ⛔ `error` STAYS, and stays byte-identical. It is the fallback the browser renders for every
    // row written before `errorCode` existed and for every failure the taxonomy does not classify,
    // and it is what the tooltip keeps showing even when the visible text is localized — the
    // technical sentence is worth keeping reachable.
    error: row.error,
    errorCode: cls.code,
    errorStatus: cls.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Forward to delivery (Phase 5B — Jira dispatch) ──────────────────────────────────────────

const forwardSchema = z.object({ target_id: z.string().uuid() }).strict();

/** Load a solution + its authoritative challenge (the challenge owns the tenant) + its flow,
 *  asserting the solution belongs to the caller's tenant (404 otherwise). */
async function loadForwardContext(
  solutionId: string,
  tenantId: string,
): Promise<{ solution: Solution; challenge: Challenge; flow: Flow | null }> {
  const [solution] = await db
    .select()
    .from(solutions)
    .where(eq(solutions.id, solutionId))
    .limit(1);
  if (!solution) throw notFound('solution_not_found');
  const [challenge] = await db
    .select()
    .from(challenges)
    .where(eq(challenges.id, solution.challenge_id))
    .limit(1);
  // The challenge's tenant is the authority; cross-tenant is invisible (404, never 403).
  if (!challenge || challenge.tenant_id !== tenantId) throw notFound('solution_not_found');

  let flow: Flow | null = null;
  if (solution.flow_id) {
    const [f] = await db.select().from(flows).where(eq(flows.id, solution.flow_id)).limit(1);
    flow = f
      ? { ...f, graph: solution.published_graph ?? f.graph }
      : null;
  }
  return { solution, challenge, flow };
}

/** Load a tenant-scoped delivery target; missing or disabled → 422 (spec Part 9#4). */
async function loadTarget(targetId: string, tenantId: string): Promise<DeliveryTarget> {
  const [t] = await db
    .select()
    .from(deliveryTargets)
    .where(and(eq(deliveryTargets.id, targetId), eq(deliveryTargets.tenant_id, tenantId)))
    .limit(1);
  if (!t || !t.enabled) {
    throw unprocessable(
      'delivery_target_not_configured',
      'That delivery connector is not configured or is disabled',
    );
  }
  return t;
}

/** The connectors that can actually dispatch a forward. Target A (jira/azure_devops) plus Target B
 *  ('fr', 5D) — un-gated at go-live now that the fr-side receiver + the commonpractice-bridge SA exist
 *  (PLAN-PHASE5.D go-live). The fr branch (precheck Gate 2 + dispatch) was built ready; this is the flip. */
const SUPPORTED_FORWARD_KINDS: readonly DeliveryTargetKind[] = ['jira', 'azure_devops', 'fr'];

/** Resolve the per-kind config validator's base URL (the egress target). Throws
 *  DeliveryConfigError on a config gap. Explicit per-kind branches (not a Jira-defaulting ternary)
 *  so un-gating 'fr' can never silently route an fr target through the Jira validator. */
function assertConfiguredBase(target: DeliveryTarget): string {
  if (target.kind === 'fr') return assertFrConfigured(target).base;
  if (target.kind === 'azure_devops') return assertAzureDevOpsConfigured(target).base;
  return assertJiraConfigured(target).base;
}

/** Config (base_url/project_key/creds) + license (fr Gate 2) + egress (externalHttp/allowlist/SSRF)
 *  precheck for a supported target — runs BEFORE any ledger row is written so a misconfigured /
 *  unlicensed / egress-blocked connector returns 422/402 with no `failed` row to clean up. Returns
 *  the snapshot for the subsequent dispatch. Exported for direct unit testing of the per-kind
 *  branches (incl. fr). The three failure modes are distinct:
 *  config → 422, fr license → 402 (Spec §9), egress → 422. */
export async function precheckTarget(target: DeliveryTarget): Promise<GovernanceSnapshot> {
  let base: string;
  try {
    base = assertConfiguredBase(target);
  } catch (err) {
    // ⛔ `err.detail` IS THE THIRD ARGUMENT, AND WITHOUT IT THE BROWSER CANNOT SAY MORE THAN THE
    // CODE. `delivery_target_incomplete` is five sentences and `delivery_target_credentials_invalid`
    // is six (see host/delivery/errors.ts); `utils/http.ts`'s `route()` spreads `details` both
    // top-level and under `details`, so the bag reaches `ApiError.details` in the SPA and
    // `VALIDATION_MESSAGES` picks the right one of the five. The English `message` is unchanged.
    if (err instanceof DeliveryConfigError) throw unprocessable(err.code, err.message, err.detail);
    throw err;
  }
  // fr Gate 2 (5D): the tenant must separately hold an active fr-family license. Distinct 402,
  // BEFORE the egress check and any ledger row. (Jira/ADO carry their own per-connector creds.)
  if (target.kind === 'fr') {
    try {
      await assertFrLicense(assertFrConfigured(target).licenseToken, target.tenant_id);
    } catch (err) {
      if (err instanceof FrLicenseError) throw paymentRequired(err.code, err.message);
      if (err instanceof DeliveryConfigError) throw unprocessable(err.code, err.message, err.detail);
      throw err;
    }
  }
  const snapshot = await getSnapshot();
  try {
    await assertEgressAllowed(base, snapshot);
  } catch (err) {
    // ⛔ THE KIND COMES FROM THE TARGET, NOT FROM THE ERROR. `EgressBlockedError` is minted in
    // host/egress-guard.ts, which is shared with the CONNECTOR refresh path and knows nothing about
    // delivery connectors — so the one machine field the browser needs to name the tool
    // ("The Azure DevOps address is not a valid destination") is added here, where `target` is in
    // scope. Same bag shape as `DeliveryConfigDetail.kind` so one frontend helper reads both.
    if (err instanceof EgressBlockedError)
      throw unprocessable(err.code, err.message, { kind: target.kind });
    throw err;
  }
  return snapshot;
}

/** Dispatch the payload via the adapter for the target's kind. All adapters share the
 *  `{externalRef, externalUrl, response}` result and the config/dispatch error taxonomy. Explicit
 *  per-kind branches (not a Jira-defaulting ternary) so un-gating 'fr' can never silently route an
 *  fr target through deliverJira. */
function dispatchByKind(
  target: DeliveryTarget,
  payload: DeliveryPayload,
  snapshot: GovernanceSnapshot,
): Promise<{ externalRef: string; externalUrl: string; response: Record<string, unknown> }> {
  if (target.kind === 'fr') return deliverFr(target, payload, snapshot);
  if (target.kind === 'azure_devops') return deliverAzureDevOps(target, payload, snapshot);
  return deliverJira(target, payload, snapshot);
}

/** Insert the 'pending' claim (the live-unique index is the idempotency guard → 23505 → 409),
 *  dispatch via the kind adapter, then update the row to 'created' (201) or 'failed' (200,
 *  fail-loud + retriable). The same snapshot is passed through, so the dispatch egress check is
 *  deterministic with the precheck. Returns the HTTP Response. */
async function dispatchDelivery(args: {
  action: string;
  tenantId: string;
  actorId: string;
  solutionId: string;
  target: DeliveryTarget;
  payload: DeliveryPayload;
  snapshot: GovernanceSnapshot;
}): Promise<Response> {
  const { action, tenantId, actorId, solutionId, target, payload, snapshot } = args;

  // INSERT-or-409. The (solution_id, target_id) partial unique index (`solution_deliveries_live_uq`)
  // permits one LIVE delivery per target; a duplicate forward hits it → 409 carrying the live row.
  // If a concurrent request DELETEs that live row in the window between our failed insert and the
  // lookup, the constraint is now free — so we retry the insert (which now succeeds) rather than
  // returning a 409 with no delivery. The loop is bounded so pathological churn can't spin forever;
  // the final fallback matches the pre-existing behaviour (409 with delivery:null).
  let row: SolutionDelivery | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      [row] = await db
        .insert(solutionDeliveries)
        .values({
          tenant_id: tenantId,
          solution_id: solutionId,
          target_id: target.id,
          target_kind: target.kind,
          initiated_by: actorId,
          status: 'pending',
          payload,
        })
        .returning();
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [live] = await db
        .select()
        .from(solutionDeliveries)
        .where(
          and(
            eq(solutionDeliveries.solution_id, solutionId),
            eq(solutionDeliveries.target_id, target.id),
            inArray(solutionDeliveries.status, [...LIVE_DELIVERY_STATUSES]),
          ),
        )
        .limit(1);
      if (live || attempt >= 2) {
        return jsonResponse(
          {
            error: 'delivery_already_live',
            message: 'This solution already has a live delivery to that connector',
            delivery: live ? publicDelivery(live) : null,
          },
          409,
        );
      }
      // raced delete cleared the conflict — fall through and retry the insert.
    }
  }

  // Tracks a successful dispatch result even if the bookkeeping UPDATE below throws, so the
  // catch block can tell "adapter never produced a ticket" apart from "ticket exists, only our
  // ledger write failed" and avoid orphaning the external ref (see the catch's fallback branch).
  let result: { externalRef: string; externalUrl: string; response: Record<string, unknown> } | undefined;
  try {
    result = await dispatchByKind(target, payload, snapshot);
    // fr creates a DRAFT a human approves in fr (not a live backlog item) → 'draft_created';
    // Jira/ADO create the item directly → 'created'. Both are "live" (idempotency index covers
    // them). fr_project_id stays NULL until fr promotes the draft (5.1 feedback).
    //
    // AT-LEAST-ONCE, accepted (v1 decision, Phase 5B). The external issue already EXISTS at this
    // point; if this UPDATE fails (DB blip, connection dropped mid-statement) the row falls into
    // the catch below, which now maps it to 'failed' (retriable) rather than leaving it stuck
    // 'pending' forever — see that branch for why a retry can still produce a SECOND Jira issue,
    // which is the accepted tradeoff. The alternative — reserving the external ref before dispatch
    // — needs an idempotency key the target honours, which Jira Cloud's issue API does not offer.
    // We deliberately prefer a rare duplicate over a lost delivery: a duplicate is visible in the
    // customer's backlog and closable by a human, a silently-dropped forward is not.
    const [updated] = await db
      .update(solutionDeliveries)
      .set({
        status: target.kind === 'fr' ? 'draft_created' : 'created',
        external_ref: result.externalRef,
        external_url: result.externalUrl,
        response: result.response,
        error: null,
        updated_at: new Date(),
      })
      .where(eq(solutionDeliveries.id, row!.id))
      .returning();
    await recordAudit({
      actorId,
      action,
      category: 'deploy',
      targetType: 'solution_delivery',
      targetId: row!.id,
      result: `${target.kind} · ${result.externalRef}`,
      resultTone: 'ok',
      metadata: {
        tenantId,
        kind: target.kind,
        target_id: target.id,
        solution_id: solutionId,
        external_ref: result.externalRef,
      },
    });
    return jsonResponse({ delivery: publicDelivery(updated!) }, 201);
  } catch (err) {
    // Dispatch reached/tried the target and failed (or egress flipped between precheck and
    // send) → persist a 'failed' row + the target's error body; the UI shows it + a retry.
    //
    // Any OTHER exception — an adapter throwing outside the typed taxonomy (e.g. FrBridgeSaError
    // from host/delivery/fr.ts resolving the bridge SA token, thrown before that adapter's own
    // try/catch), or the success-path ledger UPDATE above throwing after a real dispatch — MUST
    // still land here and MUST still terminate the row. 'pending' is a LIVE status (blocks any
    // re-forward to this target via the unique index) and is NOT retriable (retryDelivery only
    // accepts 'failed'/'rejected'), and nothing anywhere sweeps stale 'pending' rows. Re-throwing
    // for anything outside the three typed classes — the old behaviour — left the row stuck
    // 'pending' forever with no way for a tenant_admin to retry or even see it as broken.
    //
    // We fold this into ONE catch (rather than a `finally`-shaped "still pending? force it closed"
    // guarantee) because every exception the try block can produce — sync or from an awaited
    // promise — surfaces here; there is no code path in `try` that can leave the function without
    // going through this catch. A `finally` would only add value if the catch itself could fail to
    // run or could exit without writing the terminal state, which isn't the case: the risk is the
    // fallback UPDATE below failing too (DB fully unavailable), and no control-flow shape fixes
    // that — if the DB can't be written, it can't be written from a `finally` either.
    const isTyped =
      err instanceof DeliveryDispatchError ||
      err instanceof DeliveryConfigError ||
      err instanceof EgressBlockedError;
    const message = isTyped
      ? (err as Error).message
      : result
        ? `Delivery ${result.externalRef} was created at ${target.kind} but recording it failed: ${err instanceof Error ? err.message : String(err)}`
        : `Unexpected delivery error: ${err instanceof Error ? err.message : String(err)}`;
    // ⛔ THE MACHINE CODE MUST SURVIVE THE WRITE, AND IT DID NOT. Every typed error above already
    // carries a stable `code` — `delivery_target_credentials_missing`, `timeout`, `transport`,
    // `target_http_error`, the four `egress_*` — and this block used to keep only `err.message`,
    // an ENGLISH SENTENCE authored in the adapter. That sentence is what `solution_deliveries.error`
    // stores and what /solutions/[id] renders, on a line whose neighbouring branches are localized
    // (`m.delivery_forward_ticket_exists()`, `m.delivery_forward_retry()`) — so a Dutch reader got
    // "Azure DevOps request timed out — verify in Azure DevOps before retrying" inside Dutch copy.
    // The code was discarded at exactly the point where it was the only translatable thing present.
    //
    // ⛔ NO MIGRATION, AND THAT IS A CHECKED FACT, NOT A HOPE. `response` is an existing `jsonb`
    // column on this table (db/schema.ts:2030) that this same `.set()` already writes on every
    // failure path, and it already carries a CP-authored key (`_cp_note`, one line below) — so the
    // convention, the column and the write are all in place. Nothing about the schema changes.
    //
    // ⚠️ WE WRITE OURS LAST so a target whose own response body happened to contain `_cp_code`
    // cannot shadow the classification. `_cp_status` is the target's HTTP status (0 for a
    // transport/timeout failure, which has no response) — the frontend needs it to say WHICH status
    // came back without parsing the English sentence.
    //
    // ⚠️ THE UNTYPED-AND-NO-RESULT BRANCH DELIBERATELY GETS NO CODE. It is the genuinely unclassified
    // case (`Unexpected delivery error: …`), where the raw message is the ONLY information there is;
    // emitting a code would replace it on screen with a generic localized sentence that says less.
    // The renderer's documented fallback is to show `error` verbatim, which is the right answer here.
    const typedCode = isTyped ? ((err as { code?: string }).code ?? null) : null;
    const cpFields: Record<string, unknown> = {
      _cp_code: typedCode ?? (result ? 'delivery_ledger_update_failed' : null),
      ...(err instanceof DeliveryDispatchError ? { _cp_status: err.status } : {}),
    };
    const response = isTyped
      ? err instanceof DeliveryDispatchError
        ? { ...err.body, ...cpFields }
        : { message: (err as Error).message, ...cpFields }
      : result
        ? { ...result.response, _cp_note: 'dispatch succeeded but the ledger update failed', ...cpFields }
        : { message, ...cpFields };
    const [updated] = await db
      .update(solutionDeliveries)
      .set({
        status: 'failed',
        error: message,
        response,
        // Preserve the external ref/url when the adapter DID succeed (result is set) so an
        // orphaned ticket stays traceable from CP even though the row is 'failed' — otherwise the
        // only record of it is the target system itself.
        ...(result ? { external_ref: result.externalRef, external_url: result.externalUrl } : {}),
        updated_at: new Date(),
      })
      .where(eq(solutionDeliveries.id, row!.id))
      .returning();
    await recordAudit({
      actorId,
      action,
      category: 'deploy',
      targetType: 'solution_delivery',
      targetId: row!.id,
      result: `failed · ${isTyped ? ((err as { code?: string }).code ?? 'error') : 'unexpected_error'}`,
      resultTone: 'warn',
      metadata: {
        tenantId,
        kind: target.kind,
        target_id: target.id,
        solution_id: solutionId,
        error: message,
      },
    });
    return jsonResponse({ delivery: publicDelivery(updated!) }, 200);
  }
}

/** POST /api/solutions/:id/forward { target_id } — forward a solution to a configured Jira
 *  connector, creating a real issue. tenant_admin only; config/egress prechecked (422 with no
 *  row); idempotent (live re-forward → 409); dispatch failure → a 'failed' row (200, retriable). */
const forwardSolution = route(async (req, id) => {
  const { user: actor, effectiveTenantId: tenantId } = await requireTenantAdmin(req);
  const { target_id } = forwardSchema.parse(await readJson(req));

  const ctx = await loadForwardContext(id!, tenantId);
  const target = await loadTarget(target_id, tenantId);
  if (!SUPPORTED_FORWARD_KINDS.includes(target.kind)) {
    throw unprocessable(
      'delivery_target_kind_unsupported',
      `Forwarding to ${target.kind} is not available yet`,
    );
  }
  const snapshot = await precheckTarget(target);

  const datasets = await resolveChallengeDatasets(ctx.challenge.id, tenantId);
  const entities = await resolveChallengeEntities(ctx.challenge.id, tenantId);
  const payload = buildDeliveryPayload({
    solution: ctx.solution,
    challenge: ctx.challenge,
    flow: ctx.flow,
    datasets,
    entities,
    initiator: actor.id,
  });

  return dispatchDelivery({
    action: 'solution.forward',
    tenantId,
    actorId: actor.id,
    solutionId: ctx.solution.id,
    target,
    payload,
    snapshot,
  });
});

/** POST /api/solutions/:id/forward/:deliveryId/retry — re-dispatch a 'failed'/'rejected'
 *  delivery, reusing its stored (immutable) payload but reading fresh connector credentials.
 *  A new attempt row is inserted (full history); if a live delivery already exists → 409. */
const retryDelivery = route(async (req, id, deliveryId) => {
  const { user: actor, effectiveTenantId: tenantId } = await requireTenantAdmin(req);

  const [prior] = await db
    .select()
    .from(solutionDeliveries)
    .where(
      and(
        eq(solutionDeliveries.id, deliveryId!),
        eq(solutionDeliveries.solution_id, id!),
        eq(solutionDeliveries.tenant_id, tenantId),
      ),
    )
    .limit(1);
  if (!prior) throw notFound('delivery_not_found');
  if (prior.status !== 'failed' && prior.status !== 'rejected') {
    throw conflict('delivery_not_retriable', `A ${prior.status} delivery cannot be retried`);
  }
  if (!prior.target_id) {
    throw unprocessable('delivery_target_not_configured', 'The original connector no longer exists');
  }

  const target = await loadTarget(prior.target_id, tenantId);
  if (!SUPPORTED_FORWARD_KINDS.includes(target.kind)) {
    throw unprocessable(
      'delivery_target_kind_unsupported',
      `Forwarding to ${target.kind} is not available yet`,
    );
  }

  // #174 preserves external_ref/external_url on a 'failed' row when the dispatch itself
  // SUCCEEDED and only the ledger UPDATE afterward threw — the ticket already exists at the
  // target. Re-dispatching here is the EXACT recovery case that preservation exists for, and
  // would deterministically create a SECOND Jira/ADO/fr ticket. There is nothing external left
  // to do — only our own bookkeeping was wrong — so reconcile the row to its terminal success
  // state in place rather than calling the adapter again. This can never re-orphan the ticket
  // (unlike dropping the #174 preservation would): the ref stays on the row throughout.
  if (prior.external_ref) {
    try {
      const [reconciled] = await db
        .update(solutionDeliveries)
        .set({
          status: target.kind === 'fr' ? 'draft_created' : 'created',
          error: null,
          updated_at: new Date(),
        })
        .where(eq(solutionDeliveries.id, prior.id))
        .returning();
      await recordAudit({
        actorId: actor.id,
        action: 'solution.forward.reconcile',
        category: 'deploy',
        targetType: 'solution_delivery',
        targetId: prior.id,
        result: `${target.kind} · ${prior.external_ref} (reconciled — not re-dispatched, ticket already existed)`,
        resultTone: 'ok',
        metadata: {
          tenantId,
          kind: target.kind,
          target_id: target.id,
          solution_id: id,
          external_ref: prior.external_ref,
        },
      });
      return jsonResponse({ delivery: publicDelivery(reconciled!) }, 200);
    } catch (err) {
      // Flipping this row live can only collide with the (solution, target) live-unique index if
      // ANOTHER delivery to the same target went live in the meantime (e.g. a fresh forward, not
      // a retry, dispatched successfully while this row sat 'failed'). Same conflict shape
      // dispatchDelivery's own insert race returns — a 409 carrying the actually-live row.
      if (!isUniqueViolation(err)) throw err;
      const [live] = await db
        .select()
        .from(solutionDeliveries)
        .where(
          and(
            eq(solutionDeliveries.solution_id, id!),
            eq(solutionDeliveries.target_id, target.id),
            inArray(solutionDeliveries.status, [...LIVE_DELIVERY_STATUSES]),
          ),
        )
        .limit(1);
      return jsonResponse(
        {
          error: 'delivery_already_live',
          message: 'This solution already has a live delivery to that connector',
          delivery: live ? publicDelivery(live) : null,
        },
        409,
      );
    }
  }

  const snapshot = await precheckTarget(target);

  return dispatchDelivery({
    action: 'solution.forward.retry',
    tenantId,
    actorId: actor.id,
    solutionId: id!,
    target,
    payload: prior.payload, // immutable provenance — never rebuilt
    snapshot,
  });
});

// ── Phase 5.1 — fr→CP promotion feedback (inbound bridge) ───────────────────────────────────

/** Body fr POSTs when it promotes a CP-originated project_request. `project_request_id` is the
 *  join key (== solution_deliveries.external_ref for the fr forward). Lenient (unknown keys
 *  ignored) for forward-compat across fr releases. */
const frFeedbackSchema = z.object({
  project_request_id: z.string().min(1).max(200),
  fr_project_id: z.string().min(1).max(200),
  tenant_id: z.string().uuid(),
  cp_solution_id: z.string().uuid().optional(),
  fr_project_url: z
    .string()
    .url()
    .max(1000)
    // Stored as `external_url` and rendered as a deep link, so restrict the scheme — a bare
    // .url() accepts `javascript:` and friends.
    .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')
    .optional(),
});

/** POST /api/delivery/fr-feedback — fr signals that a forwarded draft was approved & promoted.
 *  SA-authed (the fr-backend SA — portal or secure-apps, FR_FEEDBACK_ISSUER — carrying `delivery-feedback-writer`); NOT a user/tenant_admin
 *  route and NOT Gate-2'd. Matches the fr delivery by (kind='fr', external_ref=project_request_id)
 *  under the body's tenant (RLS GUC), flips draft_created → promoted, stamps fr_project_id + the deep
 *  link. Idempotent (same fr project re-posted → 200 no-op). Unknown ref → 404; lineage mismatch → 409. */
const frFeedback = route(async (req) => {
  const caller = await requireFrFeedbackWriter(req);
  const body = frFeedbackSchema.parse(await readJson(req));

  // ⛔ THE TENANT GATE HAD TO BE RE-ENTERED HERE, BECAUSE ON THIS ROUTE IT IS A STRUCTURAL NO-OP
  // UPSTREAM. `requireFrFeedbackWriter` authenticates Gate 1 only (realm-per-app P7: it used to call
  // `validateAuth`, whose `assertTenantActive` was a no-op for it) — the fr-backend service account is
  // claim-only and carries NO `tenant_id`, so a caller-tenant gate would resolve a null tenant and
  // check nothing (its documented "no tenant to gate" case). The route then acts on a completely different tenant: the uuid in the request
  // BODY. Going through an authenticated guard is therefore NOT evidence the gate ran on the
  // tenant being written — the check has to sit where the acted-on tenant is known.
  //
  // Placed after the schema parse (so the id is a validated uuid, not free text) and before
  // `withTenantDb` — i.e. before the lookup and before the promotion UPDATE. Failing here means
  // the fr draft stays `draft_created` and fr can re-post the same promotion once the workspace is
  // reactivated; the route is already idempotent on exactly that retry.
  //
  // A 403 IS THE RIGHT SHAPE HERE, unlike the connector webhook: the caller is an authenticated
  // first-party service account that already knows the tenant id it sent, so there is nothing to
  // leak, and a machine peer needs a refusal it can log and alert on rather than a silent no-op.
  await assertTenantNotSuspended(body.tenant_id);

  // Scope all DB work to the asserted tenant (the SA call carries no tenant claim, so the server
  // pipeline left app.current_tenant unset). RLS then makes a cross-tenant external_ref invisible
  // → 404, so the SA can only promote a row in the tenant it names.
  return withTenantDb(body.tenant_id, async () => {
    const [delivery] = await db
      .select()
      .from(solutionDeliveries)
      .where(
        and(
          eq(solutionDeliveries.tenant_id, body.tenant_id),
          eq(solutionDeliveries.target_kind, 'fr'),
          eq(solutionDeliveries.external_ref, body.project_request_id),
        ),
      )
      .limit(1);
    if (!delivery) {
      throw notFound('delivery_not_found', 'No fr delivery matches that project_request_id');
    }
    // Lineage guard: when fr echoes the cp_solution_id, it must match the delivery's solution.
    if (body.cp_solution_id && delivery.solution_id !== body.cp_solution_id) {
      throw conflict('delivery_solution_mismatch', 'cp_solution_id does not match the delivery');
    }
    // Idempotent: the same promotion re-delivered (fr retries) → no-op 200.
    if (delivery.status === 'promoted' && delivery.fr_project_id === body.fr_project_id) {
      return jsonResponse({ delivery_id: delivery.id, status: 'promoted', idempotent: true });
    }

    const priorResponse =
      delivery.response && typeof delivery.response === 'object' ? delivery.response : {};
    const [updated] = await db
      .update(solutionDeliveries)
      .set({
        status: 'promoted',
        fr_project_id: body.fr_project_id,
        external_url: body.fr_project_url ?? delivery.external_url,
        response: {
          ...(priorResponse as Record<string, unknown>),
          fr_promotion: {
            fr_project_id: body.fr_project_id,
            fr_project_url: body.fr_project_url ?? null,
          },
        },
        updated_at: new Date(),
      })
      .where(eq(solutionDeliveries.id, delivery.id))
      .returning();

    await recordAudit({
      actorId: null, // machine-to-machine (fr-backend SA) → System actor
      action: 'solution.delivery.promoted',
      category: 'deploy',
      targetType: 'solution_delivery',
      targetId: delivery.id,
      result: `fr · ${body.fr_project_id}`,
      resultTone: 'ok',
      metadata: {
        tenantId: body.tenant_id,
        kind: 'fr',
        external_ref: body.project_request_id,
        fr_project_id: body.fr_project_id,
        sa: caller.subject,
      },
    });

    return jsonResponse({ delivery_id: updated!.id, status: updated!.status });
  });
});

export function registerDeliveryRoutes(router: Router): void {
  router.add('GET', '/api/delivery-targets', listTargets);
  router.add('POST', '/api/delivery-targets', createTarget);
  router.add('PUT', '/api/delivery-targets/:id', updateTarget);
  router.add('POST', '/api/delivery-targets/:id/test', testTarget);
  router.add('DELETE', '/api/delivery-targets/:id', deleteTarget);
  router.add('GET', '/api/solutions/:id/deliveries', listDeliveries);
  router.add('POST', '/api/solutions/:id/forward', forwardSolution);
  router.add('POST', '/api/solutions/:id/forward/:deliveryId/retry', retryDelivery);
  // Phase 5.1 — inbound fr→CP promotion feedback (SA-authed, not user-scoped).
  router.add('POST', '/api/delivery/fr-feedback', frFeedback);
}
