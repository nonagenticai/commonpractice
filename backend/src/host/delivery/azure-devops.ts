// src/host/delivery/azure-devops.ts — Phase 5C: the Azure DevOps (Boards) delivery adapter
// (Target A, the second productized backlog connector). Renders the canonical, target-neutral
// DeliveryPayload (services/delivery-payload.ts, spec Part 3) into an Azure DevOps work item and
// CREATEs it via the egress-gated outbound path (governedSend → assertEgressAllowed: externalHttp
// + the data.egress_allowlist + the SSRF hard-block).
//
// ADO's create-work-item API is a JSON-Patch document (content-type application/json-patch+json)
// POSTed to `<org>/<project>/_apis/wit/workitems/$<type>?api-version=7.1`. Auth is HTTP Basic with
// an EMPTY username and the PAT as the password (`:<pat>`). System.Description is HTML (not Jira's
// ADF), so we render escaped HTML and OMIT empty sections; the provenance block is always present.
// Acceptance criteria get ADO's first-class Microsoft.VSTS.Common.AcceptanceCriteria field; tags
// go to System.Tags as a `; `-separated list.
//
// Failure posture mirrors the Jira adapter: a config gap (no base_url/project_key/PAT) →
// DeliveryConfigError (the route maps it to 422, no ledger row). A non-2xx from ADO, or a
// transport/timeout → DeliveryDispatchError (the route persists a 'failed' delivery + ADO's error
// body). See SPEC-PHASE5 Parts 1 / 3 / 4 / 7 (5C) / 9.
import type { DeliveryTarget } from '../../db/schema';
import type { DeliveryPayload } from '../../db/delivery-types';
import type { GovernanceSnapshot } from '../policy-store';
import { governedSend } from '../egress-guard';
import { decryptSecret } from '../secret-box';
import { DeliveryConfigError, DeliveryDispatchError } from './errors';
import { safeJsonBody } from './util';
import type { ConnectionTestResult } from '../connection-test';

export interface AdoDispatchResult {
  /** the work-item id as a string, e.g. "42". */
  externalRef: string;
  /** deep link to the created work item (ADO's _links.html.href, or a constructed _workitems URL). */
  externalUrl: string;
  /** the parsed ADO create response (jsonb-safe). */
  response: Record<string, unknown>;
}

/** Azure DevOps separates tags with `;` (commas are also treated as separators in some UIs), so a
 *  tag value cannot itself contain `;` or `,`. Replace any run of those (or surrounding
 *  whitespace) with a single space, trim, drop empties, dedupe — preserving first-seen order and
 *  case. So `"Claims; Ops"` → `Claims Ops`, `source:commonpractice` is kept as-is. */
export function sanitizeAdoTags(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const cleaned = String(raw)
      .replace(/[;,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

// ── HTML builders for System.Description / AcceptanceCriteria ───────────────────────────────
/** Escape the five XML/HTML-significant characters so payload text can never break the markup. */
export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render an array of strings as an HTML `<ul>`; returns '' for an empty/all-blank source (so the
 *  caller can omit the section entirely rather than emit an empty `<ul>`). */
function htmlList(items: string[]): string {
  const clean = (items ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (!clean.length) return '';
  return `<ul>${clean.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
}

/** Compose the work item's System.Description as an HTML fragment. A section is emitted only when
 *  its source has content; the provenance block is always present, so the result is never empty. */
export function buildAdoDescriptionHtml(payload: DeliveryPayload): string {
  const parts: string[] = [];
  const para = (title: string, value: string | null | undefined) => {
    const v = value?.trim();
    if (v) parts.push(`<h3>${escapeHtml(title)}</h3><p>${escapeHtml(v)}</p>`);
  };
  const list = (title: string, items: string[]) => {
    const html = htmlList(items);
    if (html) parts.push(`<h3>${escapeHtml(title)}</h3>${html}`);
  };

  para('Problem', payload.problem);
  para('Outcome', payload.outcome);
  list('Deliverables', payload.deliverables);
  list('Requirements', payload.requirements);
  list('Data access', payload.data_access);
  list('Needs human input', payload.needs_human);
  // Always present → the description is never empty.
  parts.push(
    `<h3>Provenance (Common Practice)</h3><pre>${escapeHtml(
      JSON.stringify(payload.provenance, null, 2),
    )}</pre>`,
  );

  return parts.join('');
}

/** Render the acceptance criteria as HTML for ADO's first-class AcceptanceCriteria field; '' when
 *  there are none (the field is then omitted from the patch). */
export function buildAdoAcceptanceCriteriaHtml(payload: DeliveryPayload): string {
  return htmlList(payload.acceptance_criteria);
}

/** Decrypt + validate the connector's ADO credentials ({pat}). Missing/garbage →
 *  DeliveryConfigError. */
function readAdoCredentials(target: DeliveryTarget): { pat: string } {
  if (!target.credentials_encrypted) {
    throw new DeliveryConfigError(
      'delivery_target_credentials_missing',
      'This Azure DevOps connector has no stored credentials',
      { kind: 'azure_devops' },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(target.credentials_encrypted));
  } catch {
    throw new DeliveryConfigError(
      'delivery_target_credentials_invalid',
      'The stored Azure DevOps credentials could not be decrypted',
      { kind: 'azure_devops', reason: 'undecryptable' },
    );
  }
  const pat = (parsed as Record<string, unknown>)?.pat;
  if (typeof pat !== 'string' || !pat) {
    throw new DeliveryConfigError(
      'delivery_target_credentials_invalid',
      'Azure DevOps credentials must include a non-empty {pat}',
      { kind: 'azure_devops', reason: 'malformed' },
    );
  }
  return { pat };
}

/** Validate an ADO connector's config up front (base_url = org URL, project_key = project, a
 *  decryptable {pat}) and return the resolved bits. Throws DeliveryConfigError on any gap — the
 *  route uses this as a PRECHECK (→ 422, no ledger row) and deliverAzureDevOps reuses it. */
export function assertAzureDevOpsConfigured(target: DeliveryTarget): {
  pat: string;
  base: string;
  project: string;
  workItemType: string;
  areaPath: string | undefined;
} {
  if (!target.base_url) {
    throw new DeliveryConfigError(
      'delivery_target_incomplete',
      'This Azure DevOps connector is missing its organization URL',
      // The org URL IS `base_url` — the form calls that box "Base URL" for all three kinds, and the
      // reader has to fix it there. See `DeliveryConfigDetail`.
      { kind: 'azure_devops', field: 'base_url' },
    );
  }
  if (!target.project_key) {
    throw new DeliveryConfigError(
      'delivery_target_incomplete',
      'This Azure DevOps connector is missing its project',
      { kind: 'azure_devops', field: 'project_key' },
    );
  }
  const { pat } = readAdoCredentials(target);
  return {
    pat,
    base: target.base_url.replace(/\/+$/, ''),
    project: target.project_key,
    workItemType: target.default_item_type?.trim() || 'Epic',
    areaPath: target.config?.ado_area_path?.trim() || undefined,
  };
}

/** Lightweight "test connection": GET the configured project with the stored PAT. A 2xx proves
 *  the org URL + project + PAT are accepted (no work item is created). Returns {ok, detail} —
 *  never throws for a remote/credential failure (those are normal test outcomes). */
export async function testAzureDevOpsConnection(
  target: DeliveryTarget,
  snapshot: GovernanceSnapshot,
): Promise<ConnectionTestResult> {
  const { pat, base, project } = assertAzureDevOpsConfigured(target);
  const authorization = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  const url = `${base}/_apis/projects/${encodeURIComponent(project)}?api-version=7.1`;
  let res: { status: number; text: string };
  try {
    res = await governedSend(url, snapshot, {
      method: 'GET',
      headers: { authorization, accept: 'application/json' },
      timeoutMs: 10_000,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'delivery_test_unreachable',
      params: { kind: 'azure_devops', detail: reason },
      detail: `Could not reach Azure DevOps: ${reason}`,
    };
  }
  if (res.status >= 200 && res.status < 300) {
    // ⛔ A 2xx HERE DOES NOT MEAN THE PROJECT CAME BACK, AND THE OLD SUCCESS SENTENCE COULD NOT TELL.
    // `project` is read from the target's CONFIG, never from the response, so
    // `Connected to Azure DevOps project "X"` was true by construction — it asserted nothing about
    // what Azure DevOps actually said. The body was fetched by `governedSend` and discarded.
    //
    // That matters because dev.azure.com answers an auth failure with **203 Non-Authoritative
    // Information**, not 401 — Microsoft's own moderator answer (learn.microsoft.com/answers,
    // 2025-07-08) states that requests outside a user context "often result in 203 or 401". 203 is
    // inside this range, so the 401/403 arm below is UNREACHABLE for that case and an admin was told
    // the connector was good. ⚠️ The narrower folklore — "an expired PAT returns an HTML sign-in
    // page" — is NOT verified by any primary source, so this check does not depend on it: it
    // requires positive identification of the project, whatever the failure body happens to be.
    //
    // The sibling connector already did this: `jira.ts` parses `/myself` and even splits the code
    // when the identity is absent, because "an absent name is a DIFFERENT sentence". Same idea here,
    // with one deliberate difference — for Jira an anonymous-but-authenticated token is a legitimate
    // success, whereas a `/projects/{project}` 2xx that identifies no project is not a success at
    // all, so it fails rather than getting an `_anon` variant.
    const body = safeJsonBody(res.text) as { id?: unknown; name?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const identified = name !== '' || typeof body?.id === 'string';
    if (!identified) {
      // ⚠️ REUSES THE EXISTING `delivery_test_ado_unauthorized` RATHER THAN INVENTING A CODE. A new
      // code needs a frontend label in all eight locales or it ships as a raw identifier, and the
      // documented cause of a 2xx-without-a-project IS an auth failure — so this message names the
      // right action ("check the token and its scopes") instead of a truer-but-unactionable one.
      return {
        ok: false,
        code: 'delivery_test_ado_unauthorized',
        detail: 'Azure DevOps rejected the PAT — check the token and its scopes.',
      };
    }
    // The project key is the fact; the sentence is the reader's. Prefer the name Azure DevOps
    // returned over the one we sent, so a case or rename mismatch is visible rather than echoed back.
    return {
      ok: true,
      code: 'delivery_test_ado_ok',
      params: { project: name || project },
      detail: `Connected to Azure DevOps project "${name || project}".`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      code: 'delivery_test_ado_unauthorized',
      detail: 'Azure DevOps rejected the PAT — check the token and its scopes.',
    };
  }
  if (res.status === 404) {
    // A 404 here is NOT "unauthorized" and must not collapse into it: the fix is a different field
    // (the project key, or the organization URL) than the one a 401 points at.
    return {
      ok: false,
      code: 'delivery_test_ado_project_not_found',
      params: { project },
      detail: `Project "${project}" not found at this organization URL.`,
    };
  }
  return {
    ok: false,
    code: 'delivery_test_http',
    params: { kind: 'azure_devops', status: res.status },
    detail: `Azure DevOps returned HTTP ${res.status}.`,
  };
}

/**
 * Create an Azure DevOps work item for the canonical payload. Returns the work-item id + deep link
 * on success; throws DeliveryConfigError (config gap) or DeliveryDispatchError (ADO non-2xx /
 * transport / timeout). Pure of persistence + audit — the route records the outcome.
 */
export async function deliverAzureDevOps(
  target: DeliveryTarget,
  payload: DeliveryPayload,
  snapshot: GovernanceSnapshot,
): Promise<AdoDispatchResult> {
  const { pat, base, project, workItemType, areaPath } = assertAzureDevOpsConfigured(target);

  // JSON-Patch document: each field is an `add` op at /fields/<refName>.
  const patch: { op: 'add'; path: string; value: string }[] = [
    { op: 'add', path: '/fields/System.Title', value: payload.title.slice(0, 255) },
    { op: 'add', path: '/fields/System.Description', value: buildAdoDescriptionHtml(payload) },
  ];
  const acceptance = buildAdoAcceptanceCriteriaHtml(payload);
  if (acceptance) {
    patch.push({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
      value: acceptance,
    });
  }
  const tags = sanitizeAdoTags(payload.labels);
  if (tags.length) {
    patch.push({ op: 'add', path: '/fields/System.Tags', value: tags.join('; ') });
  }
  if (areaPath) {
    patch.push({ op: 'add', path: '/fields/System.AreaPath', value: areaPath });
  }

  const url = `${base}/${encodeURIComponent(project)}/_apis/wit/workitems/$${encodeURIComponent(
    workItemType,
  )}?api-version=7.1`;
  // ADO PAT auth = HTTP Basic with an empty username and the PAT as the password.
  const authorization = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

  let res: { status: number; text: string };
  try {
    res = await governedSend(url, snapshot, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json-patch+json',
        accept: 'application/json',
      },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    // governedSend throws on egress refusal (EgressBlockedError) or a transport/timeout abort.
    const timeout = err instanceof Error && err.name === 'AbortError';
    throw new DeliveryDispatchError(
      timeout ? 'timeout' : 'transport',
      0,
      timeout
        ? 'Azure DevOps request timed out — verify in Azure DevOps before retrying'
        : `Could not reach Azure DevOps: ${err instanceof Error ? err.message : String(err)}`,
      { message: err instanceof Error ? err.message : String(err) },
    );
  }

  const parsed = safeJsonBody(res.text);
  if (res.status < 200 || res.status >= 300) {
    throw new DeliveryDispatchError(
      'target_http_error',
      res.status,
      `Azure DevOps returned HTTP ${res.status}`,
      parsed,
    );
  }
  const id = (parsed as Record<string, unknown>).id;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new DeliveryDispatchError(
      'target_http_error',
      res.status,
      'Azure DevOps accepted the request but returned no work-item id',
      parsed,
    );
  }
  const ref = String(id);
  const links = (parsed as { _links?: { html?: { href?: unknown } } })._links;
  const htmlHref = typeof links?.html?.href === 'string' ? links.html.href : null;
  const externalUrl = htmlHref ?? `${base}/${encodeURIComponent(project)}/_workitems/edit/${ref}`;
  return { externalRef: ref, externalUrl, response: parsed };
}
