// tests/connector-bad-url-refusal.test.ts — a typo'd connector URL was a bare 500, not an answer.
//
// ⛔ THE DEFECT. `metaFromConfig()` calls `parseTarget()`, which throws `EgressBlockedError` on a
// URL the parser cannot read (`https://` — a scheme and nothing else, exactly what a half-typed
// address looks like). `EgressBlockedError extends Error`, NOT `HttpError`, and `route()`
// (src/utils/http.ts) maps only HttpError / ZodError / UnauthorizedError / pg 22P02. So it fell
// through to server.ts's bare catch-all: `500 {"error":"Internal Server Error"}`.
//
// ⛔ THE `/test` ENDPOINT'S ENTIRE CONTRACT IS THAT THIS CANNOT HAPPEN. Its header says it: "a bad
// config or unreachable source is a normal test result (ok:false), not an HTTP error." Two catch
// blocks already forward `validateConnectorConfig`'s and `resolveOwnedStorageBucket`'s refusals as
// `ok:false`; the `metaFromConfig` line sits BETWEEN them, unguarded.
//
// ⛔ AND ON SAVE, NOTHING PERSISTS AND NOTHING EXPLAINS. `POST /api/connectors` hits the same call
// after the bucket rewrite, so the admin's only feedback on a mistyped address is an opaque 500
// with no code the frontend can localize.
//
// ⛔ WHY THE ERROR CLASS IS NOT PROMOTED TO `HttpError`. `EgressBlockedError` is minted in
// host/egress-guard.ts, which is shared by the connector-refresh path and the delivery path and
// knows nothing about either. routes/delivery.ts:446 already argues this explicitly and maps it at
// the CALL SITE so it can attach `{ kind: target.kind }`. Making the class an HttpError would
// hand every future call site a silent default status and delete that seam. These two sites map it
// the same way delivery.ts does.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import { invalidatePolicyCache } from '../src/host/policy-store';
import { Router } from '../src/utils/router';
import { registerConnectorRoutes } from '../src/routes/connectors';
import { db, users, datasets, datasetRows, policies, auditLog } from '../src/db/client';
import type { User } from '../src/types';

const OWNER_ID = '00000000-0000-0000-0000-0000c0bd0001';
const owner: User = {
  id: OWNER_ID,
  email: 'badurl@test',
  name: 'Bad URL Owner',
  roles: ['super_admin', 'employee'],
  tenantId: OWNER_ID,
};

const router = new Router();
registerConnectorRoutes(router);

/**
 * ⛔ MODELS server.ts, NOT `route()`. `route()` RETHROWS what it cannot map, and the outermost
 * `catch` that turns that into `500 Internal Server Error` lives in server.ts (:384-386). Calling
 * the handler bare would surface the defect as a REJECTED PROMISE, which reads like a broken test
 * rather than the 500 a browser actually receives — so this helper reproduces the production
 * mapping and the assertions below are about a real status code.
 */
async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let res: Response;
  try {
    res = await matched.handler(req, ...matched.params);
  } catch (err) {
    res = new Response(JSON.stringify({ error: 'Internal Server Error', _threw: String(err) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function setAllowlist(allow: string[], externalHttp = true) {
  for (const [key, value, control, category, label] of [
    ['models.external_http', externalHttp, 'toggle', 'models_tools', 'External HTTP'],
    ['data.egress_allowlist', allow, 'list', 'models_tools', 'Egress allowlist'],
  ] as const) {
    await db
      .insert(policies)
      .values({ key, value, control, category, label })
      .onConflictDoUpdate({ target: policies.key, set: { value } });
  }
  invalidatePolicyCache();
}

async function cleanup() {
  const owned = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));
  for (const d of owned) await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  await db.delete(datasets).where(eq(datasets.owner_id, OWNER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, OWNER_ID));
  await db.delete(users).where(eq(users.id, OWNER_ID));
}

/** The two policy rows this file mutates, captured verbatim so `afterAll` can put back what it
 *  actually found. ⛔ NOT a literal: a hardcoded restore in `governance.test.ts` was silently
 *  truncating the live `models.allowlist` from 22 entries to the 3 someone typed months ago, for
 *  every session sharing this DB. The same shape here would clobber whatever a sibling suite (or a
 *  developer) had set. A snapshot cannot go stale; a literal always does. */
const POLICY_SNAPSHOT = new Map<string, unknown>();

beforeAll(async () => {
  await cleanup();
  for (const key of ['models.external_http', 'data.egress_allowlist']) {
    const [row] = await db.select({ value: policies.value }).from(policies).where(eq(policies.key, key));
    if (row) POLICY_SNAPSHOT.set(key, row.value);
  }
  __setAuthOverridesForTests({ validateAuth: async () => owner });
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async () => new Response('id,city\n1,Ams\n', { headers: { 'content-type': 'text/csv' } }),
  });
  await setAllowlist(['data.test.invalid']);
}, 30_000);

afterAll(async () => {
  await cleanup();
  // Restore exactly what `beforeAll` found — never a literal (see POLICY_SNAPSHOT above).
  for (const [key, value] of POLICY_SNAPSHOT) {
    await db
      .update(policies)
      .set({ value: value as never })
      .where(eq(policies.key, key));
  }
  invalidatePolicyCache();
  __setAuthOverridesForTests(undefined);
  __setEgressHooksForTests(undefined);
}, 30_000);

// A scheme with no authority: it passes `validateConnectorConfig`'s `/^https?:\/\//` scheme check
// (so the refusal cannot come from there) and then kills `new URL()`.
const HALF_TYPED = 'https://';

test('THE DEFECT: POST /api/connectors/test with a half-typed URL answers ok:false, never 500', async () => {
  const res = await call('POST', '/api/connectors/test', {
    sourceType: 'http',
    config: { url: HALF_TYPED, format: 'json' },
  });

  expect(
    res.status,
    `the endpoint whose contract is "bad config is a test RESULT" returned an HTTP error: ${JSON.stringify(res.json)}`,
  ).toBe(200);
  expect(res.json.ok, 'a URL the parser cannot read was reported as a working source').toBe(false);
  // A machine code, not just prose — it is what the frontend keys its localized copy on.
  expect(res.json.code).toBe('egress_bad_target');
  expect(typeof res.json.detail).toBe('string');
  expect(res.json.detail.length).toBeGreaterThan(0);
});

test('THE DEFECT: POST /api/connectors with a half-typed URL is a 4xx refusal carrying a code', async () => {
  const before = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));

  const res = await call('POST', '/api/connectors', {
    name: 'half typed',
    sourceType: 'http',
    config: { url: HALF_TYPED, format: 'json' },
  });

  expect(
    res.status,
    `a mistyped address was answered with a server fault instead of a refusal: ${JSON.stringify(res.json)}`,
  ).toBe(422);
  expect(res.json.error, 'the refusal carries no code the UI can act on').toBe('egress_bad_target');
  expect(res.json.message, 'the refusal carries no message').toBeTruthy();

  // Nothing may be half-created by a rejected save.
  const after = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));
  expect(after.length, 'the refused create left a connector row behind').toBe(before.length);
});

test('THE CONTROL: a well-formed URL is still tested and still saved', async () => {
  // ⛔ THE OVER-CORRECTION GUARD. Refusing every http connector would satisfy both cases above.
  const tested = await call('POST', '/api/connectors/test', {
    sourceType: 'http',
    config: { url: 'https://data.test.invalid/rows.csv', format: 'csv' },
  });
  expect(tested.status).toBe(200);
  expect(tested.json.ok, `a legitimate source was refused: ${JSON.stringify(tested.json)}`).toBe(true);

  const created = await call('POST', '/api/connectors', {
    name: 'well formed',
    sourceType: 'http',
    config: { url: 'https://data.test.invalid/rows.csv', format: 'csv' },
  });
  expect(created.status, `a legitimate create was refused: ${JSON.stringify(created.json)}`).toBe(201);
});
