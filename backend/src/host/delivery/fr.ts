// src/host/delivery/fr.ts — Phase 5 / 5D: the fr internal-bridge delivery adapter (Target B).
//
// Unlike the productized backlog connectors (Jira 5B / Azure DevOps 5C, which CREATE a real issue),
// fr is the in-house path: CP forwards a solution to fr as a DRAFT `project_request` that a human
// reviews, edits, and APPROVES in fr before fr/n8n/kanban act (Spec Parts 1.3 / 3 / 5). So this
// adapter POSTs the canonical, target-neutral DeliveryPayload (services/delivery-payload.ts) to fr's
// `POST /api/project-requests` as an intake envelope, via the same egress-gated outbound path
// (governedSend → assertEgressAllowed) the other adapters use.
//
// AUTH is two-token, CP-asserts-the-tenant (PLAN-PHASE5.D go-live, Design A): the `commonpractice-bridge`
// service-account JWT is the CALLER identity (Authorization: Bearer …; carries the project-request-writer
// role), and `X-Tenant-Id` is the resolved platform tenant uuid. fr's edge does NOT introspect/rewrite a
// `Bearer <license token>` in X-Tenant-Id for a JWT-authorized bridge call (it skips JWTs), and fr's intake
// requires a plain uuid — so CP asserts the tenant, trusted via the SA. Gate 2 (active fr license) still
// runs CP-side in the route precheck (services/fr-license.ts) against the connector's stored license token,
// before any ledger row — the entitlement IS verified, just CP-side rather than at the edge.
//
// Failure posture mirrors Jira/ADO: a config gap (no base_url / no license token) →
// DeliveryConfigError (route → 422, no row); an fr non-2xx, transport, or timeout →
// DeliveryDispatchError (route → persisted 'failed' row + fr's error body). On success fr returns a
// draft project_request id → the route records the delivery as 'draft_created'.
//
// ⛔ NO LONGER GATED. This used to say the adapter was "unreachable in prod until 'fr' joins
// SUPPORTED_FORWARD_KINDS" — 'fr' HAS been in that list since the 5D go-live
// (`routes/delivery.ts` SUPPORTED_FORWARD_KINDS = ['jira','azure_devops','fr']), so this path is
// LIVE. Leaving the old text in place invited exactly the wrong conclusion: that a failure here
// could not affect production. It can. See PLAN-PHASE5.D for the design.
import type { DeliveryTarget } from '../../db/schema';
import type { DeliveryPayload } from '../../db/delivery-types';
import type { GovernanceSnapshot } from '../policy-store';
import { governedSend } from '../egress-guard';
import { decryptSecret } from '../secret-box';
import { frBridgeSa } from '../../services/fr-bridge-sa';
import { DeliveryConfigError, DeliveryDispatchError } from './errors';
import { safeJsonBody } from './util';
import type { ConnectionTestResult } from '../connection-test';

export interface FrDispatchResult {
  /** the fr project_request id as a string. */
  externalRef: string;
  /** deep link to the draft project request in fr (for the "Open in fr" status chip). */
  externalUrl: string;
  /** the parsed fr intake response (jsonb-safe). */
  response: Record<string, unknown>;
}

/** fr's intake requires a repository_url it cannot derive from CP; we post a clearly-invalid
 *  sentinel so the draft is creatable but fr's APPROVE step (which requires a real URL) rejects
 *  until a human supplies one. Mirrors the `needs_human` framing in the canonical payload. */
export const FR_REPO_SENTINEL = 'https://example.invalid/REPLACE-IN-FR';

/** fr's intake requires X-Tenant-Id / X-Subject-Id to be plain uuids; we only forward a subject when
 *  the CP initiator id is uuid-shaped (fr nulls a malformed one rather than 500-ing on telemetry). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decrypt + validate the connector's fr credential ({licenseToken}). Missing/garbage →
 *  DeliveryConfigError. The connector form stores the tenant's fr license token under this key. */
function readFrCredentials(target: DeliveryTarget): { licenseToken: string } {
  if (!target.credentials_encrypted) {
    throw new DeliveryConfigError(
      'delivery_target_credentials_missing',
      'This fr connector has no stored license token',
      { kind: 'fr' },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(target.credentials_encrypted));
  } catch {
    throw new DeliveryConfigError(
      'delivery_target_credentials_invalid',
      'The stored fr credentials could not be decrypted',
      { kind: 'fr', reason: 'undecryptable' },
    );
  }
  const licenseToken = (parsed as Record<string, unknown>)?.licenseToken;
  if (typeof licenseToken !== 'string' || !licenseToken) {
    throw new DeliveryConfigError(
      'delivery_target_credentials_invalid',
      'fr credentials must include a non-empty {licenseToken}',
      { kind: 'fr', reason: 'malformed' },
    );
  }
  return { licenseToken };
}

/** Validate an fr connector's config up front (base_url = fr ingress, a decryptable {licenseToken})
 *  and return the resolved bits. Throws DeliveryConfigError on any gap — the route uses this as a
 *  PRECHECK (→ 422, no ledger row) and deliverFr reuses it. */
export function assertFrConfigured(target: DeliveryTarget): {
  licenseToken: string;
  base: string;
} {
  if (!target.base_url) {
    throw new DeliveryConfigError(
      'delivery_target_incomplete',
      'This fr connector is missing its base URL',
      { kind: 'fr', field: 'base_url' },
    );
  }
  const { licenseToken } = readFrCredentials(target);
  return { licenseToken, base: target.base_url.replace(/\/+$/, '') };
}

/** Lightweight "test connection" for an fr connector. The route's precheck has already validated
 *  config + the active fr license (token introspect) + egress before this runs, so reaching here
 *  means the connector is usable; return the resolved base for a clear message. {ok, detail}. */
export function testFrConnection(target: DeliveryTarget): ConnectionTestResult {
  // ⛔ A 200-OK SUCCESS PATH, and the only one of the three that cannot fail here at all — the
  // route's precheck has already verified config + the active fr license + egress, so reaching this
  // line IS the result. The resolved base URL is the fact worth showing.
  const { base } = assertFrConfigured(target);
  return {
    ok: true,
    code: 'delivery_test_fr_ok',
    params: { base },
    detail: `fr license active · ${base}`,
  };
}

/** Compact, non-empty list-rendering for the human-readable `notes` block. */
function notesSection(title: string, items: string[]): string {
  const clean = (items ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (!clean.length) return '';
  return `${title}:\n${clean.map((t) => `- ${t}`).join('\n')}\n`;
}

/** A human-readable notes block fr shows the reviewer: the CP provenance + the fields a human must
 *  still supply (needs_human). Always non-empty (provenance is always present). */
export function buildFrNotes(payload: DeliveryPayload): string {
  const parts = [
    notesSection('Outstanding (human input needed before approval)', payload.needs_human),
    'Provenance (Common Practice):\n' + JSON.stringify(payload.provenance, null, 2),
  ];
  return parts.filter(Boolean).join('\n');
}

/** First-class traceability fr persists onto the promoted project (bidirectional: CP ids + who
 *  initiated). Distinct from the free-text notes so fr can index/link on it. */
export function buildFrExternalOrigin(payload: DeliveryPayload): Record<string, unknown> {
  const p = payload.provenance;
  return {
    source: 'commonpractice',
    cp_solution_id: p.cp_solution_id,
    cp_challenge_id: p.cp_challenge_id,
    cp_flow_id: p.cp_flow_id,
    cp_tenant_id: p.cp_tenant_id,
    initiated_by: p.initiated_by,
    votes_count: p.votes_count,
  };
}

/** Map the canonical payload to fr's ProjectCreate envelope (Spec Part 3 fr mapping). The
 *  repository_url is the REPLACE-IN-FR sentinel (CP can't supply it); requestor is the CP initiator;
 *  the lifecycle/shape are fixed for a CP-originated workflow improvement. */
export function buildFrProjectCreate(payload: DeliveryPayload): Record<string, unknown> {
  return {
    name: payload.title,
    repository_url: FR_REPO_SENTINEL,
    problem_statement: payload.problem,
    desired_outcome: payload.outcome,
    acceptance_criteria: payload.acceptance_criteria,
    key_deliverables: payload.deliverables,
    high_level_requirements: payload.requirements,
    access_requirements: payload.data_access,
    requestor: payload.provenance.initiated_by,
    lifecycle_class: 'workflow-improvement',
    shape: 'deliverable',
    notes: buildFrNotes(payload),
  };
}

/**
 * Forward the canonical payload to fr as a draft project_request. Returns the project-request id +
 * deep link on success; throws DeliveryConfigError (config gap) or DeliveryDispatchError (fr non-2xx
 * / transport / timeout). Pure of persistence + audit — the route records the outcome. Gate 2 (the
 * active fr license) is asserted by the route precheck before this is called.
 */
export async function deliverFr(
  target: DeliveryTarget,
  payload: DeliveryPayload,
  snapshot: GovernanceSnapshot,
): Promise<FrDispatchResult> {
  // assertFrConfigured still validates the connector's stored fr license token exists (config gap →
  // 422); Gate 2 (the route precheck, services/fr-license.ts) introspects that token before any row.
  // The adapter itself no longer carries the license token — see the header note below.
  const { base } = assertFrConfigured(target);
  const saToken = await frBridgeSa().getToken();

  const body = JSON.stringify({
    external_ref: payload.provenance.cp_solution_id,
    external_origin: buildFrExternalOrigin(payload),
    payload: buildFrProjectCreate(payload),
  });

  // The CP initiator's keycloak subject, when it is a uuid (fr persists it to created_by, a uuid
  // column, and ignores a non-uuid). Sent as a plain header — see the X-Subject-Id note below.
  const subjectId = UUID_RE.test(payload.provenance.initiated_by)
    ? payload.provenance.initiated_by
    : undefined;

  let res: { status: number; text: string };
  try {
    res = await governedSend(`${base}/api/project-requests`, snapshot, {
      method: 'POST',
      headers: {
        // Two-token, CP-asserts-the-tenant (PLAN-PHASE5.D go-live, Design A). The bridge SA JWT is
        // the caller identity (carries the project-request-writer role); fr trusts only this SA to
        // assert a tenant. X-Tenant-Id is the resolved platform tenant uuid (delivery_targets.tenant_id,
        // also the one Gate 2 matched the fr license against) — NOT the license token: fr's edge does
        // not introspect/rewrite X-Tenant-Id for a JWT-authorized bridge call, and fr's intake requires
        // a plain uuid. X-Subject-Id carries the initiator for provenance.
        authorization: `Bearer ${saToken}`,
        'x-tenant-id': target.tenant_id,
        ...(subjectId ? { 'x-subject-id': subjectId } : {}),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body,
    });
  } catch (err) {
    // governedSend throws on egress refusal (EgressBlockedError) or a transport/timeout abort.
    const timeout = err instanceof Error && err.name === 'AbortError';
    throw new DeliveryDispatchError(
      timeout ? 'timeout' : 'transport',
      0,
      timeout
        ? 'fr request timed out — verify in fr before retrying'
        : `Could not reach fr: ${err instanceof Error ? err.message : String(err)}`,
      { message: err instanceof Error ? err.message : String(err) },
    );
  }

  const parsed = safeJsonBody(res.text);
  if (res.status < 200 || res.status >= 300) {
    throw new DeliveryDispatchError('target_http_error', res.status, `fr returned HTTP ${res.status}`, parsed);
  }
  const id = (parsed as Record<string, unknown>).project_request_id;
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new DeliveryDispatchError(
      'target_http_error',
      res.status,
      'fr accepted the request but returned no project_request_id',
      parsed,
    );
  }
  const ref = String(id);
  return {
    externalRef: ref,
    externalUrl: `${base}/projects/requests/${encodeURIComponent(ref)}`,
    response: parsed,
  };
}
