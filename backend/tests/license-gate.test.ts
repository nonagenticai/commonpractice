// tests/license-gate.test.ts — Phase 4 / F.1: Gate 2 of the license dual-gate
// (middleware/license-gate.ts). Drives `assertTenantLicensed` with a faked introspection client
// (__setLicenseClientForTests) and real tenant rows (one with a secret-box token, one without).
// Proves the Spec-9.6 matrix AND the F.1 safety invariant: with the flag OFF the gate is a pure
// no-op (never reads the DB, never introspects), so shipping it changes prod behaviour by zero.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray, eq } from 'drizzle-orm';
import { db, tenants, users, memberEntitlements } from '../src/db/client';
import { config } from '../src/config';
import { encryptSecret } from '../src/host/secret-box';
import { assertTenantLicensed } from '../src/middleware/license-gate';
import {
  __setLicenseClientForTests,
  LicenseClientError,
  LicenseClientService,
  type LicenseClient,
  type LicenseIntrospectResponse,
} from '../src/services/license-client';
import { HttpError } from '../src/utils/http';
import { renderMetrics } from '../src/host/metrics';
import {
  __setLicenseStatusDepsForTests,
  __resetLicenseStatusDepsForTests,
} from '../src/lib/license-status';

const T_LICENSED = '00000000-0000-0000-0000-0000000f2001'; // has a stored token
const T_NOTOKEN = '00000000-0000-0000-0000-0000000f2002'; // exists, no token
const OTHER = '00000000-0000-0000-0000-0000000f2003'; // a foreign tenant id
const TOKEN = 'tok-licensed-A';

// ---- fake introspection client (token → response | Error) ----
function makeLicense(byToken: Record<string, LicenseIntrospectResponse | Error>) {
  const calls: string[] = [];
  const client: LicenseClient = {
    async introspect(token: string) {
      calls.push(token);
      const r = byToken[token];
      if (r instanceof Error) throw r;
      if (!r) throw new LicenseClientError(404, 'unknown token');
      return r;
    },
  };
  return { client, calls };
}

const okFor = (tenantId: string): LicenseIntrospectResponse => ({
  active: true,
  tenant_id: tenantId,
  app: { key: 'commonpractice' },
  status: 'active',
  expires_at: '2999-01-01T00:00:00Z',
});

function req(path = '/api/flows'): Request {
  return new Request(`http://t${path}`);
}

function setFlag(on: boolean) {
  (config.license as { enforceGate2: boolean }).enforceGate2 = on;
}

/** Run the gate and return the HTTP status it would produce (200 = passed/allowed). */
async function gateStatus(request: Request, tenantId: string | null): Promise<number> {
  try {
    await assertTenantLicensed(request, tenantId);
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
}

async function gateCode(request: Request, tenantId: string | null): Promise<string | null> {
  try {
    await assertTenantLicensed(request, tenantId);
    return null;
  } catch (e) {
    if (e instanceof HttpError) return e.code;
    throw e;
  }
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  await db
    .insert(tenants)
    .values([
      { id: T_LICENSED, name: 'Licensed Co', slug: 'licensed-f2-test', license_token_encrypted: encryptSecret(TOKEN) },
      { id: T_NOTOKEN, name: 'Unlicensed Co', slug: 'unlicensed-f2-test' },
    ])
    .onConflictDoNothing({ target: tenants.id });
  // Ensure the token is set even if the row pre-existed from a prior run.
  await db
    .update(tenants)
    .set({ license_token_encrypted: encryptSecret(TOKEN) })
    .where(eq(tenants.id, T_LICENSED));
  await db
    .update(tenants)
    .set({ license_token_encrypted: null })
    .where(eq(tenants.id, T_NOTOKEN));
  setFlag(true); // default the gate ON for the matrix; the no-op test flips it off
}, 30_000);

afterAll(async () => {
  setFlag(false); // restore the F.1 prod/CI default
  __setLicenseClientForTests(undefined);
  __resetLicenseStatusDepsForTests();
  (config.license as { perMemberGate: boolean }).perMemberGate = false;
  await db.delete(memberEntitlements).where(inArray(memberEntitlements.user_id, [M_ALICE, M_BOB]));
  await db.delete(users).where(inArray(users.id, [M_ALICE, M_BOB]));
  await db.delete(tenants).where(inArray(tenants.id, [T_LICENSED, T_NOTOKEN, OTHER]));
}, 30_000);

// ---- the F.1 safety invariant ----

test('flag OFF → pure no-op: any request passes, introspect is never called', async () => {
  setFlag(false);
  const { client, calls } = makeLicense({}); // no responses configured
  __setLicenseClientForTests(client);
  // Even a tenant with no token sails through when enforcement is off.
  expect(await gateStatus(req(), T_NOTOKEN)).toBe(200);
  expect(calls.length).toBe(0);
});

// ---- the happy path ----

test('active commonpractice license whose tenant_id == session tenant → passes (200)', async () => {
  const { client } = makeLicense({ [TOKEN]: okFor(T_LICENSED) });
  __setLicenseClientForTests(client);
  expect(await gateStatus(req(), T_LICENSED)).toBe(200);
});

// ---- 402: unlicensed / inactive / expired / unavailable ----

test('tenant with no stored token → 402 license_required', async () => {
  const { client, calls } = makeLicense({});
  __setLicenseClientForTests(client);
  expect(await gateStatus(req(), T_NOTOKEN)).toBe(402);
  expect(await gateCode(req(), T_NOTOKEN)).toBe('license_required');
  expect(calls.length).toBe(0); // no token → never even introspected
});

test('introspection active:false → 402 license_inactive', async () => {
  const { client } = makeLicense({ [TOKEN]: { active: false, status: 'revoked' } });
  __setLicenseClientForTests(client);
  expect(await gateCode(req(), T_LICENSED)).toBe('license_inactive');
});

test('active but past expires_at → 402 license_expired', async () => {
  const { client } = makeLicense({
    [TOKEN]: { active: true, tenant_id: T_LICENSED, app: { key: 'commonpractice' }, expires_at: '2000-01-01T00:00:00Z' },
  });
  __setLicenseClientForTests(client);
  expect(await gateCode(req(), T_LICENSED)).toBe('license_expired');
});

test('licenses service unreachable (introspect throws) → 402 license_unavailable (fail-closed)', async () => {
  const { client } = makeLicense({ [TOKEN]: new LicenseClientError(503, 'down') });
  __setLicenseClientForTests(client);
  expect(await gateStatus(req(), T_LICENSED)).toBe(402);
  expect(await gateCode(req(), T_LICENSED)).toBe('license_unavailable');
});

// ---- 403: wrong app / cross-tenant (the two-gate bind) ----

test('token for a different app → 403 license_app_mismatch', async () => {
  const { client } = makeLicense({
    [TOKEN]: { active: true, tenant_id: T_LICENSED, app: { key: 'workers' }, expires_at: '2999-01-01T00:00:00Z' },
  });
  __setLicenseClientForTests(client);
  expect(await gateStatus(req(), T_LICENSED)).toBe(403);
  expect(await gateCode(req(), T_LICENSED)).toBe('license_app_mismatch');
});

test('license whose tenant_id != session tenant → 403 license_tenant_mismatch (the two-gate bind)', async () => {
  // The token introspects to a DIFFERENT tenant than the Keycloak-resolved session tenant.
  const { client } = makeLicense({ [TOKEN]: okFor(OTHER) });
  __setLicenseClientForTests(client);
  expect(await gateStatus(req(), T_LICENSED)).toBe(403);
  expect(await gateCode(req(), T_LICENSED)).toBe('license_tenant_mismatch');
});

// ---- path-blindness + unauthenticated ----
//
// WS-2 deleted the path allowlist (`isExemptPath`) from this module: the exemption is now derived
// from which GUARD the route chose (`requireSuperAdmin` → no Gate 2; anything else → Gate 2), not
// from the pathname. The four old allowlist entries still behave the same end-to-end, but that is
// now a property of the ROUTER + guards and is pinned in tests/license-gate-guard-derived.test.ts.
// What this module owes is the opposite guarantee: given a tenant, it judges the LICENCE and
// nothing else — no path is special to it any more.

test('the gate is path-BLIND: no pathname is special to it, including the four formerly-exempt ones', async () => {
  const { client } = makeLicense({});
  __setLicenseClientForTests(client);
  for (const path of [
    // formerly hard-coded exempt
    '/health',
    '/ready',
    '/metrics',
    '/api/admin/tenants',
    '/api/admin/signups',
    '/api/license/status',
    `/api/tenants/${T_NOTOKEN}/license`,
    // never exempt — the anchoring that stopped `startsWith('/api/tenants/')` swallowing the product
    `/api/tenants/${T_NOTOKEN}`,
    `/api/tenants/${T_NOTOKEN}/users`,
    `/api/tenants/${T_NOTOKEN}/budget`,
    `/api/tenants/${T_NOTOKEN}/usage`,
    `/api/tenants/${T_NOTOKEN}/license/extra`,
    '/api/tenants/not-a-uuid/license',
  ]) {
    expect(await gateStatus(req(path), T_NOTOKEN), `${path} must be judged on the licence`).toBe(402);
  }
});

test('/api/tenants/:id/usage is licence-gated — it used to live under the exempt /api/admin/*'
  + ' prefix (a genuine enforcement hole: an unlicensed tenant admin could still load usage/spend'
  + ' while every other tenant route correctly 402d), and must NOT regress back onto that prefix', async () => {
  const { client, calls } = makeLicense({});
  __setLicenseClientForTests(client);
  // Unlicensed → 402, same as any other tenant-facing route.
  expect(await gateStatus(req(`/api/tenants/${T_NOTOKEN}/usage`), T_NOTOKEN)).toBe(402);
  expect(calls.length).toBe(0); // no token → never even introspected

  // Licensed → passes, same as any other tenant-facing route.
  const { client: okClient } = makeLicense({ [TOKEN]: okFor(T_LICENSED) });
  __setLicenseClientForTests(okClient);
  expect(await gateStatus(req(`/api/tenants/${T_LICENSED}/usage`), T_LICENSED)).toBe(200);
});

test('unauthenticated (no resolved tenant) → no-op (the route guard 401s, not Gate 2)', async () => {
  const { client, calls } = makeLicense({});
  __setLicenseClientForTests(client);
  expect(await gateStatus(req(), null)).toBe(200);
  expect(calls.length).toBe(0);
});

// ---- secret hygiene ----

test('the stored token round-trips through secret-box (encrypted at rest, decrypted for introspect)', async () => {
  const { client, calls } = makeLicense({ [TOKEN]: okFor(T_LICENSED) });
  __setLicenseClientForTests(client);
  await assertTenantLicensed(req(), T_LICENSED);
  // The gate decrypted the at-rest blob back to the plaintext token before introspecting.
  expect(calls).toEqual([TOKEN]);
  const [row] = await db
    .select({ blob: tenants.license_token_encrypted })
    .from(tenants)
    .where(eq(tenants.id, T_LICENSED));
  expect(row?.blob).not.toBe(TOKEN); // stored ciphertext, not plaintext
  expect(typeof row?.blob).toBe('string');
});

// ---- the misconfiguration counter, and the outage it must NOT accuse ------------------------
//
// ⛔ A COUNTER NAMED `misconfigured` MUST ONLY EVER MEAN MISCONFIGURED.
// `license_introspect_misconfigured_total` used to be gated on `err instanceof LicenseClientError &&
// err.status === 500`, next to a comment asserting that 500 "is raised by exactly one branch of
// services/license-client.ts". It is raised by TWO: the not-configured guard, and `throw new
// LicenseClientError(res.status, …)` for ANY non-2xx — which includes a genuine HTTP 500 from a
// struggling licences service. So during a real upstream outage the counter climbed on every
// request and told the operator to go looking for a config regression that did not exist.
//
// Both tests below drive the REAL `LicenseClientService` (not the `makeLicense` fake), because the
// thing under test is which ERROR TYPE that class raises — a fake that throws a hand-built error
// would be testing the hand-built error.

/**
 * Current value of a counter in the process registry (0 when it has never been bumped).
 * `renderMetrics` prefixes every name with `commonpractice_`, hence the leading `\\w*`.
 */
function counterValue(name: string): number {
  const m = new RegExp(`^\\w*${name} (\\d+)$`, 'm').exec(renderMetrics());
  return m ? Number(m[1]) : 0;
}

test('⛔ a genuine upstream HTTP 500 is an OUTAGE — it must not bump the MISCONFIGURED counter', async () => {
  // A licences service that is up, reachable, and returning 500s. The old `status === 500` check
  // counted every one of these as "LICENSE_INTROSPECT_URL is empty".
  __setLicenseClientForTests(
    new LicenseClientService({
      introspectUrl: 'https://licenses.example.com/license/introspect',
      cacheTtlMs: 0,
      fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    }),
  );
  const beforeMis = counterValue('license_introspect_misconfigured_total');
  const beforeFail = counterValue('license_introspect_failures_total');

  expect(await gateCode(req(), T_LICENSED)).toBe('license_unavailable');

  // The outage IS counted — that is the alertable signal, and it must still fire.
  expect(counterValue('license_introspect_failures_total')).toBe(beforeFail + 1);
  // …and the misconfiguration counter stays exactly where it was.
  expect(counterValue('license_introspect_misconfigured_total')).toBe(beforeMis);
});

test('⛔ NON-VACUITY — an EMPTY introspect URL still bumps the misconfigured counter', async () => {
  // Without this, deleting the `incCounter` outright would satisfy the test above while destroying
  // the one signal that says the boot guard was bypassed.
  __setLicenseClientForTests(
    new LicenseClientService({
      introspectUrl: '',
      cacheTtlMs: 0,
      fetchImpl: (async () => {
        throw new Error('the client must not reach fetch — there is no URL to fetch');
      }) as unknown as typeof fetch,
    }),
  );
  const beforeMis = counterValue('license_introspect_misconfigured_total');

  expect(await gateCode(req(), T_LICENSED)).toBe('license_unavailable');
  expect(counterValue('license_introspect_misconfigured_total')).toBe(beforeMis + 1);
});

// ===================================================================================================
// PER-MEMBER GATE (migration 0089, flag LICENSE_GATE_PER_MEMBER)
// ===================================================================================================

const M_ALICE = '00000000-0000-0000-0000-0000000e9a01';
const M_BOB = '00000000-0000-0000-0000-0000000f2a02';
const SUBJ_ALICE = '11111111-1111-4111-8111-000000000a01';
const SUBJ_BOB = '11111111-1111-4111-8111-000000000b02';
const TOK_ALICE = 'tok-member-alice';
const TOK_BOB = 'tok-member-bob';

function setPerMember(on: boolean) {
  (config.license as { perMemberGate: boolean }).perMemberGate = on;
}

/** An introspect response for a member's own licence: tenant-valid AND subject-bound. */
const okForMember = (tenantId: string, subjectId: string): LicenseIntrospectResponse => ({
  ...okFor(tenantId),
  subject_id: subjectId,
});

async function seedMember(
  userId: string,
  opts: { token: string; subjectId: string | null; status?: string },
) {
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@licensed.test`, name: userId, tenant_id: T_LICENSED })
    .onConflictDoNothing({ target: users.id });
  await db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, userId));
  await db.insert(memberEntitlements).values({
    tenant_id: T_LICENSED,
    user_id: userId,
    license_id: '00000000-0000-4000-8000-0000000e9aaa',
    license_subject_id: opts.subjectId,
    token_encrypted: encryptSecret(opts.token),
    status: (opts.status ?? 'active') as 'active',
  });
}

async function memberGate(tenantId: string, userId: string): Promise<string | number> {
  try {
    await assertTenantLicensed(req(), tenantId, { userId });
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.code;
    throw e;
  }
}

test('per-member OFF → the caller argument is ignored and the tenant token still decides', async () => {
  setPerMember(false);
  await seedMember(M_ALICE, { token: TOK_ALICE, subjectId: SUBJ_ALICE });
  const { client, calls } = makeLicense({ [TOKEN]: okFor(T_LICENSED) });
  __setLicenseClientForTests(client);
  expect(await memberGate(T_LICENSED, M_ALICE)).toBe(200);
  // The TENANT token was introspected, not Alice's — this flag is what makes the change inert.
  expect(calls).toEqual([TOKEN]);
});

test('per-member ON → a member with their own entitlement passes on their OWN token', async () => {
  setPerMember(true);
  await seedMember(M_ALICE, { token: TOK_ALICE, subjectId: SUBJ_ALICE });
  const { client, calls } = makeLicense({
    [TOK_ALICE]: okForMember(T_LICENSED, SUBJ_ALICE),
    [TOKEN]: okFor(T_LICENSED),
  });
  __setLicenseClientForTests(client);
  expect(await memberGate(T_LICENSED, M_ALICE)).toBe(200);
  expect(calls).toEqual([TOK_ALICE]); // the tenant token was never consulted
  setPerMember(false);
});

test("per-member ON → ALICE'S TOKEN DOES NOT ADMIT BOB (the whole point of per-member licensing)", async () => {
  // ⭐ THE HEADLINE ASSERTION. Under the tenant-level scheme this was IMPOSSIBLE to express: one
  // token admitted every employee, which is why a seat could never be counted or released. Bob's
  // row holds Alice's token — the shape a copied/stale credential takes — and every OTHER check in
  // the gate passes on it (it is active, unexpired, the right app, the right tenant). Only the
  // subject binding refuses it.
  setPerMember(true);
  await seedMember(M_BOB, { token: TOK_ALICE, subjectId: SUBJ_BOB });
  const { client } = makeLicense({ [TOK_ALICE]: okForMember(T_LICENSED, SUBJ_ALICE) });
  __setLicenseClientForTests(client);
  expect(await memberGate(T_LICENSED, M_BOB)).toBe('license_subject_mismatch');
  setPerMember(false);
});

test('per-member ON → a member with NO entitlement gets license_seat_required, not license_required', async () => {
  // ⛔ THE CODE MATTERS. `license_required` means "this workspace was never licensed" and the SPA
  // renders it as a billing wall aimed at the workspace. Here the workspace IS licensed and paying;
  // this one person has no seat. Emitting the tenant code would send the reader to a billing screen
  // to fix something that is not broken.
  setPerMember(true);
  await db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, M_BOB));
  await db
    .insert(users)
    .values({ id: M_BOB, email: 'bob@licensed.test', name: 'Bob', tenant_id: T_LICENSED })
    .onConflictDoNothing({ target: users.id });
  const { client, calls } = makeLicense({ [TOKEN]: okFor(T_LICENSED) });
  __setLicenseClientForTests(client);
  expect(await memberGate(T_LICENSED, M_BOB)).toBe('license_seat_required');
  // ⚠️ And it must NOT fall back to the tenant token — a fallback would silently restore the shared
  // -token behaviour the flag claims to have removed, while reporting success.
  expect(calls).toEqual([]);
  setPerMember(false);
});

test('per-member ON → a seat refusal is NOT laundered into license_unavailable by the lookup catch', async () => {
  // The seat refusal is thrown from INSIDE the try block that wraps the token lookup. Without an
  // `instanceof HttpError` re-throw it would be caught and re-emitted as `license_unavailable`,
  // whose copy promises "access resumes automatically" — turning a permanent, actionable state into
  // a phantom outage nobody would ever chase.
  setPerMember(true);
  await db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, M_BOB));
  __setLicenseClientForTests(makeLicense({}).client);
  expect(await memberGate(T_LICENSED, M_BOB)).toBe('license_seat_required');
  setPerMember(false);
});

test('per-member ON → an entitlement with a NULL subject DENIES rather than skipping the binding', async () => {
  // ⚠️ "Nothing to compare" must not read as "comparison passed". A row written by an older build
  // could carry a token and no subject; treating that as a pass would silently restore the shared
  // -token behaviour under a flag that claims to have removed it.
  setPerMember(true);
  await seedMember(M_ALICE, { token: TOK_ALICE, subjectId: null });
  const { client } = makeLicense({ [TOK_ALICE]: okForMember(T_LICENSED, SUBJ_ALICE) });
  __setLicenseClientForTests(client);
  expect(await memberGate(T_LICENSED, M_ALICE)).toBe('license_subject_mismatch');
  setPerMember(false);
});

test('per-member ON → a non-active entitlement is no seat (revoking is mid-offboard)', async () => {
  setPerMember(true);
  await seedMember(M_BOB, { token: TOK_BOB, subjectId: SUBJ_BOB, status: 'revoking' });
  const { client } = makeLicense({ [TOK_BOB]: okForMember(T_LICENSED, SUBJ_BOB) });
  __setLicenseClientForTests(client);
  expect(await memberGate(T_LICENSED, M_BOB)).toBe('license_seat_required');
  setPerMember(false);
});

// ---- TENANT-LEVEL LICENCES (ruling 2026-09-28) ----
//
// A tenant's bundle holds ONE licence per (tenant, app) on the service subject
// `svc:<tenant>:commonpractice`. CP holds no token for it; the gate must admit on it via the
// licences service's `GET /licenses/active` (injected here as `loadActiveTenantLicense`).

/** What `GET /licenses/active?subject_id=svc:<t>:commonpractice` returns when the svc holder has it. */
const svcOk = (tenantId: string): LicenseIntrospectResponse => ({
  ...okFor(tenantId),
  subject_id: `svc:${tenantId}:commonpractice`,
  subject_match: true,
});

/** The service's FALLBACK pick when the svc holder has nothing: a colleague's member licence. */
const colleaguesLicence = (tenantId: string): LicenseIntrospectResponse => ({
  ...okForMember(tenantId, SUBJ_ALICE),
  subject_match: false,
});

function tenantLevel(byTenant: Record<string, LicenseIntrospectResponse | null | Error>) {
  const calls: string[] = [];
  __setLicenseStatusDepsForTests({
    async loadActiveTenantLicense(tenantId: string) {
      calls.push(tenantId);
      const r = byTenant[tenantId];
      if (r instanceof Error) throw r;
      return r ?? null;
    },
  });
  return calls;
}

test('tenant-level: NO stored token but an active tenant-level licence (svc holder) → passes (200)', async () => {
  const { client, calls: introspects } = makeLicense({});
  __setLicenseClientForTests(client);
  const lookups = tenantLevel({ [T_NOTOKEN]: svcOk(T_NOTOKEN) });
  try {
    expect(await gateStatus(req(), T_NOTOKEN)).toBe(200);
    expect(introspects.length).toBe(0); // there is no token to introspect
    expect(lookups).toEqual([T_NOTOKEN]);
  } finally {
    __resetLicenseStatusDepsForTests();
  }
});

test('tenant-level: NO stored token and NO tenant-level licence → still 402 license_required', async () => {
  const { client } = makeLicense({});
  __setLicenseClientForTests(client);
  const lookups = tenantLevel({ [T_NOTOKEN]: null });
  try {
    expect(await gateCode(req(), T_NOTOKEN)).toBe('license_required');
    expect(lookups.length).toBe(1); // it DID ask — the 402 is a measured answer, not a skipped one
  } finally {
    __resetLicenseStatusDepsForTests();
  }
});

test('tenant-level: a lookup answer for ANOTHER tenant / app, or expired, never admits', async () => {
  const { client } = makeLicense({});
  __setLicenseClientForTests(client);
  for (const bad of [
    svcOk(OTHER),
    { ...svcOk(T_NOTOKEN), app: { key: 'fr' } },
    { ...svcOk(T_NOTOKEN), expires_at: '2000-01-01T00:00:00Z' },
    { ...svcOk(T_NOTOKEN), active: false },
    { ...svcOk(T_NOTOKEN), subject_match: false },
    { ...svcOk(T_NOTOKEN), subject_match: null },
  ]) {
    tenantLevel({ [T_NOTOKEN]: bad });
    try {
      expect(await gateCode(req(), T_NOTOKEN)).toBe('license_required');
    } finally {
      __resetLicenseStatusDepsForTests();
    }
  }
});

test('tenant-level: lookup THROWS with no stored token → 402 license_unavailable (fail-closed, not "unpaid")', async () => {
  const { client } = makeLicense({});
  __setLicenseClientForTests(client);
  tenantLevel({ [T_NOTOKEN]: new Error('licenses down') });
  try {
    expect(await gateStatus(req(), T_NOTOKEN)).toBe(402);
    expect(await gateCode(req(), T_NOTOKEN)).toBe('license_unavailable');
  } finally {
    __resetLicenseStatusDepsForTests();
  }
});

test('tenant-level: a WORKING stored token is unchanged — admitted with ZERO tenant-level lookups', async () => {
  const { client, calls } = makeLicense({ [TOKEN]: okFor(T_LICENSED) });
  __setLicenseClientForTests(client);
  const lookups = tenantLevel({ [T_LICENSED]: new Error('must not be called') });
  try {
    expect(await gateStatus(req(), T_LICENSED)).toBe(200);
    expect(calls).toEqual([TOKEN]);
    expect(lookups.length).toBe(0);
  } finally {
    __resetLicenseStatusDepsForTests();
  }
});

test('tenant-level: a stored-token denial with no tenant-level licence keeps its ORIGINAL code', async () => {
  const { client } = makeLicense({ [TOKEN]: okFor(OTHER) });
  __setLicenseClientForTests(client);
  tenantLevel({ [T_LICENSED]: null });
  try {
    expect(await gateCode(req(), T_LICENSED)).toBe('license_tenant_mismatch');
  } finally {
    __resetLicenseStatusDepsForTests();
  }
});

test('tenant-level: a stale/revoked stored token is rescued by the tenant-level licence', async () => {
  const { client } = makeLicense({ [TOKEN]: { active: false, status: 'revoked' } });
  __setLicenseClientForTests(client);
  tenantLevel({ [T_LICENSED]: svcOk(T_LICENSED) });
  try {
    expect(await gateStatus(req(), T_LICENSED)).toBe(200);
  } finally {
    __resetLicenseStatusDepsForTests();
  }
});

test('tenant-level: per-member ON, member with NO seat, tenant holds the tenant-level licence → passes', async () => {
  (config.license as { perMemberGate: boolean }).perMemberGate = true;
  const { client } = makeLicense({});
  __setLicenseClientForTests(client);
  tenantLevel({ [T_NOTOKEN]: svcOk(T_NOTOKEN) });
  try {
    await assertTenantLicensed(req(), T_NOTOKEN, { userId: '00000000-0000-0000-0000-0000000f2c99' });
  } finally {
    __resetLicenseStatusDepsForTests();
    (config.license as { perMemberGate: boolean }).perMemberGate = false;
  }
});

test("tenant-level: the lookup returns a COLLEAGUE'S member licence (subject_match false) → default mode denies 402", async () => {
  // GET /licenses/active never denies on the selector: when the svc holder has nothing it returns
  // the tenant's first active licence of ANY holder. Active, unexpired, right app, right tenant —
  // and still not the tenant's licence. Only subject_match refuses it.
  const { client } = makeLicense({});
  __setLicenseClientForTests(client);
  tenantLevel({ [T_NOTOKEN]: colleaguesLicence(T_NOTOKEN) });
  try {
    expect(await gateStatus(req(), T_NOTOKEN)).toBe(402);
    expect(await gateCode(req(), T_NOTOKEN)).toBe('license_required');
  } finally {
    __resetLicenseStatusDepsForTests();
  }
});

test("tenant-level: per-member ON, seatless Bob is NOT admitted on Alice's licence returned by the lookup (402)", async () => {
  setPerMember(true);
  await db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, M_BOB));
  const { client } = makeLicense({});
  __setLicenseClientForTests(client);
  tenantLevel({ [T_LICENSED]: colleaguesLicence(T_LICENSED) });
  try {
    expect(await memberGate(T_LICENSED, M_BOB)).toBe('license_seat_required');
  } finally {
    __resetLicenseStatusDepsForTests();
    setPerMember(false);
  }
});

test('tenant-level: a revoked stored token + a colleague licence from the lookup stays denied', async () => {
  const { client } = makeLicense({ [TOKEN]: { active: false, status: 'revoked' } });
  __setLicenseClientForTests(client);
  tenantLevel({ [T_LICENSED]: colleaguesLicence(T_LICENSED) });
  try {
    expect(await gateStatus(req(), T_LICENSED)).toBe(402);
  } finally {
    __resetLicenseStatusDepsForTests();
  }
});
