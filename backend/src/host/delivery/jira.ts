// src/host/delivery/jira.ts — Phase 5B: the Atlassian Jira Cloud delivery adapter (Target A).
//
// Renders the canonical, target-neutral DeliveryPayload (services/delivery-payload.ts, spec
// Part 3) into a Jira Cloud issue and CREATEs it via the egress-gated outbound path
// (governedSend → assertEgressAllowed: externalHttp + the data.egress_allowlist + the SSRF
// hard-block). The description is Atlassian Document Format (ADF); EMPTY sections are omitted
// (Jira 400s on an empty bulletList or an empty text node). Credentials (email + apiToken) are
// decrypted from the connector's secret-box blob at call time only and presented as HTTP Basic.
//
// Failure posture: a config gap (no base_url/project_key/creds) → DeliveryConfigError (the
// route maps it to 422, no ledger row). A non-2xx from Jira, or a transport/timeout →
// DeliveryDispatchError (the route persists a 'failed' delivery + Jira's error body). See
// SPEC-PHASE5 Parts 3 / 4.3 / 9.
import type { DeliveryTarget } from '../../db/schema';
import type { DeliveryPayload } from '../../db/delivery-types';
import type { GovernanceSnapshot } from '../policy-store';
import { governedSend } from '../egress-guard';
import { decryptSecret } from '../secret-box';
import { DeliveryConfigError, DeliveryDispatchError } from './errors';
import { safeJsonBody } from './util';
import type { ConnectionTestResult } from '../connection-test';

export interface JiraDispatchResult {
  /** the Jira issue key, e.g. "DEL-42". */
  externalRef: string;
  /** deep link to the created issue, e.g. "https://acme.atlassian.net/browse/DEL-42". */
  externalUrl: string;
  /** the parsed Jira create response (jsonb-safe). */
  response: Record<string, unknown>;
}

/** Jira rejects labels containing whitespace (and some punctuation). Replace any run of chars
 *  outside [\w.-] with a single '-', collapse/trim '-', drop empties, dedupe — preserving
 *  first-seen order and case. So `"Claims Ops"` → `Claims-Ops`, `source:commonpractice` →
 *  `source-commonpractice`. Without this every create 400s (work_area/tags carry spaces). */
export function sanitizeJiraLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const cleaned = String(raw)
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

// ── ADF (Atlassian Document Format) builders ───────────────────────────────────────────────
// Every `text` node must be a non-empty string and every bulletList ≥1 listItem, or Jira 400s.
const adfText = (text: string) => ({ type: 'text', text });
const adfParagraph = (text: string) => ({ type: 'paragraph', content: [adfText(text)] });
const adfHeading = (text: string) => ({
  type: 'heading',
  attrs: { level: 3 },
  content: [adfText(text)],
});
const adfBulletList = (items: string[]) => ({
  type: 'bulletList',
  content: items.map((t) => ({ type: 'listItem', content: [adfParagraph(t)] })),
});
const adfCodeBlock = (text: string) => ({ type: 'codeBlock', content: [adfText(text)] });

/** Compose the issue description as an ADF doc. A section is emitted only when its source has
 *  content; the provenance code block is always present, so `content` is never empty. */
export function buildJiraDescription(payload: DeliveryPayload): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  const para = (title: string, value: string | null | undefined) => {
    const v = value?.trim();
    if (v) content.push(adfHeading(title), adfParagraph(v));
  };
  const list = (title: string, items: string[]) => {
    const clean = (items ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (clean.length) content.push(adfHeading(title), adfBulletList(clean));
  };

  para('Problem', payload.problem);
  para('Outcome', payload.outcome);
  list('Deliverables', payload.deliverables);
  list('Acceptance criteria', payload.acceptance_criteria);
  list('Requirements', payload.requirements);
  list('Data access', payload.data_access);
  list('Needs human input', payload.needs_human);
  // Always present → the doc always has ≥1 content block.
  content.push(
    adfHeading('Provenance (Common Practice)'),
    adfCodeBlock(JSON.stringify(payload.provenance, null, 2)),
  );

  return { type: 'doc', version: 1, content };
}

/** Decrypt + validate the connector's Jira credentials. Missing/garbage → DeliveryConfigError. */
function readJiraCredentials(target: DeliveryTarget): { email: string; apiToken: string } {
  if (!target.credentials_encrypted) {
    throw new DeliveryConfigError(
      'delivery_target_credentials_missing',
      'This Jira connector has no stored credentials',
      { kind: 'jira' },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(target.credentials_encrypted));
  } catch {
    throw new DeliveryConfigError(
      'delivery_target_credentials_invalid',
      'The stored Jira credentials could not be decrypted',
      { kind: 'jira', reason: 'undecryptable' },
    );
  }
  const email = (parsed as Record<string, unknown>)?.email;
  const apiToken = (parsed as Record<string, unknown>)?.apiToken;
  if (typeof email !== 'string' || !email || typeof apiToken !== 'string' || !apiToken) {
    throw new DeliveryConfigError(
      'delivery_target_credentials_invalid',
      'Jira credentials must include a non-empty {email, apiToken}',
      { kind: 'jira', reason: 'malformed' },
    );
  }
  return { email, apiToken };
}

/** Validate a Jira connector's config up front (base_url, project_key, decryptable {email,
 *  apiToken}) and return the resolved bits. Throws DeliveryConfigError on any gap — the route
 *  uses this as a PRECHECK (→ 422, no ledger row) and deliverJira reuses it. */
export function assertJiraConfigured(target: DeliveryTarget): {
  email: string;
  apiToken: string;
  base: string;
  issueType: string;
} {
  if (!target.base_url) {
    throw new DeliveryConfigError(
      'delivery_target_incomplete',
      'This Jira connector is missing its base URL',
      { kind: 'jira', field: 'base_url' },
    );
  }
  if (!target.project_key) {
    throw new DeliveryConfigError(
      'delivery_target_incomplete',
      'This Jira connector is missing its project key',
      { kind: 'jira', field: 'project_key' },
    );
  }
  const { email, apiToken } = readJiraCredentials(target);
  return {
    email,
    apiToken,
    base: target.base_url.replace(/\/+$/, ''),
    issueType: target.default_item_type?.trim() || 'Epic',
  };
}

/** Lightweight "test connection": GET /myself with the stored Basic creds. A 2xx proves the
 *  base URL + email + API token are accepted (no issue is created). Returns {ok, detail} — never
 *  throws for a remote/credential failure (those are normal test outcomes). */
export async function testJiraConnection(
  target: DeliveryTarget,
  snapshot: GovernanceSnapshot,
): Promise<ConnectionTestResult> {
  const { email, apiToken, base } = assertJiraConfigured(target);
  const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  let res: { status: number; text: string };
  try {
    res = await governedSend(`${base}/rest/api/3/myself`, snapshot, {
      method: 'GET',
      headers: { authorization, accept: 'application/json' },
      timeoutMs: 10_000,
    });
  } catch (err) {
    // `kind` is the machine token, NOT a display name: the browser turns it into "Atlassian Jira"
    // through the same `deliveryKindLabel` the rest of the delivery UI uses, so the product name is
    // localized alongside the sentence rather than baked in here.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'delivery_test_unreachable',
      params: { kind: 'jira', detail: reason },
      detail: `Could not reach Jira: ${reason}`,
    };
  }
  if (res.status >= 200 && res.status < 300) {
    // ⛔ A 200-OK SUCCESS PATH — the one a Dutch admin sees when the connector WORKS.
    const who = safeJsonBody(res.text) as { displayName?: string; emailAddress?: string } | null;
    const user = who?.displayName || who?.emailAddress || '';
    return {
      ok: true,
      // ⛔ TWO CODES, NOT ONE WITH AN EMPTY `{user}`. Jira answers `/myself` without a display name
      // or an email often enough (a token scoped to an app, a privacy-restricted directory) that
      // the old code papered over it with the English literal "the configured user" — which is
      // prose, and prose is exactly what must not travel. An absent name is a DIFFERENT sentence.
      code: user ? 'delivery_test_jira_ok' : 'delivery_test_jira_ok_anon',
      params: user ? { user } : {},
      detail: `Connected to Jira as ${user || 'the configured user'}.`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    // Its own code, not a shared "unauthorized": the ACTION differs per tool (Jira wants an email
    // + API token, ADO wants a PAT and its scopes), and telling an admin to check the wrong pair of
    // fields is worse than saying nothing.
    return {
      ok: false,
      code: 'delivery_test_jira_unauthorized',
      detail: 'Jira rejected the credentials — check the email and API token.',
    };
  }
  return {
    ok: false,
    code: 'delivery_test_http',
    params: { kind: 'jira', status: res.status },
    detail: `Jira returned HTTP ${res.status}.`,
  };
}

/**
 * Create a Jira Cloud issue for the canonical payload. Returns the issue key + deep link on
 * success; throws DeliveryConfigError (config gap) or DeliveryDispatchError (Jira non-2xx /
 * transport / timeout). Pure of persistence + audit — the route records the outcome.
 */
export async function deliverJira(
  target: DeliveryTarget,
  payload: DeliveryPayload,
  snapshot: GovernanceSnapshot,
): Promise<JiraDispatchResult> {
  const { email, apiToken, base, issueType } = assertJiraConfigured(target);

  const body = JSON.stringify({
    fields: {
      project: { key: target.project_key },
      issuetype: { name: issueType },
      summary: payload.title.slice(0, 250), // Jira summary hard cap is 255
      labels: sanitizeJiraLabels(payload.labels),
      description: buildJiraDescription(payload),
    },
  });
  const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  let res: { status: number; text: string };
  try {
    res = await governedSend(`${base}/rest/api/3/issue`, snapshot, {
      method: 'POST',
      headers: {
        authorization,
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
        ? 'Jira request timed out — verify in Jira before retrying'
        : `Could not reach Jira: ${err instanceof Error ? err.message : String(err)}`,
      { message: err instanceof Error ? err.message : String(err) },
    );
  }

  const parsed = safeJsonBody(res.text);
  if (res.status < 200 || res.status >= 300) {
    throw new DeliveryDispatchError(
      'target_http_error',
      res.status,
      `Jira returned HTTP ${res.status}`,
      parsed,
    );
  }
  const key = (parsed as Record<string, unknown>).key;
  if (typeof key !== 'string' || !key) {
    throw new DeliveryDispatchError(
      'target_http_error',
      res.status,
      'Jira accepted the request but returned no issue key',
      parsed,
    );
  }
  return { externalRef: key, externalUrl: `${base}/browse/${key}`, response: parsed };
}
