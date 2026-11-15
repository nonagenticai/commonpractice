// tests/license-provisioning.test.ts — Phase 4 / F.2: per-tenant license issue/revoke policy
// (services/license-provisioning.ts). Drives the real functions against real tenant/user rows + a
// FAKED SA client (__setLicensesAdminForTests) and real secret-box + runAsSystem. Proves the F.2
// safety invariant (flag OFF → pure no-op, SA never touched) AND the write-side matrix: issue once
// (idempotent), at-rest encryption, revoke, reactivate re-issue, and fail-loud (502) on outage.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray, eq } from 'drizzle-orm';
import { db, tenants, users, memberEntitlements } from '../src/db/client';
import { config } from '../src/config';
import { encryptSecret, tryDecryptSecret } from '../src/host/secret-box';
import {
  ensureTenantLicense,
  revokeTenantLicense,
  reissueTenantLicense,
  ensureMemberEntitlement,
  revokeMemberEntitlement,
} from '../src/services/license-provisioning';
import {
  __setLicensesAdminForTests,
  LicencesAccessRefusedError,
  LicencesTenantOwnedByOtherAppError,
  LicensesAdminError,
  tenantLicenceSubjects,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';
import { HttpError } from '../src/utils/http';

const T_NEW = '00000000-0000-0000-0000-00000f2a0001'; // onboard target, no token yet
const T_HASTOKEN = '00000000-0000-0000-0000-00000f2a0002'; // already licensed
const T_EMPTY = '00000000-0000-0000-0000-00000f2a0003'; // suspended tenant with no users
const U_OLDEST = '00000000-0000-0000-0000-00000f2a00a1'; // a user of T_NEW (for reissue)
const U_SURVIVOR = '00000000-0000-0000-0000-00000f2a00a2'; // the LIVE member the tombstone tests bind to

// ⚠️ THE FAKE MINTS REAL UUIDs, NOT `lic-1`. `member_entitlements.license_id` /
// `.license_subject_id` are `uuid` columns (migration 0089) because the licences service returns
// UUIDs, so a fake emitting an opaque string cannot be stored and the type is a genuine constraint
// rather than decoration. LIC and SUBJ stay VISIBLY different from each other — the whole point of
// carrying both is that they are not interchangeable.
const LIC = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const SUBJ = (n: number) => `11111111-1111-4111-8111-00000000000${n}`;

// ---- faked SA client: records calls, mints deterministic license ids + tokens ----
function makeAdmin(opts: { failCreate?: boolean; failRevoke?: boolean; failRegister?: boolean } = {}) {
  const calls = {
    ensureTenantRegistered: [] as Array<{ tenantId: string; name: string }>,
    createLicense: [] as Array<{ subjectId: string; tenantId: string }>,
    createToken: [] as Array<{ licenseId: string; tenantId: string }>,
    revoke: [] as Array<{ token: string; tenantId: string }>,
    revokeByLicenseId: [] as Array<{ licenseId: string; tenantId: string }>,
  };
  let n = 0;
  const client: LicensesAdminClient = {
    async ensureTenantRegistered(tenantId, name) {
      calls.ensureTenantRegistered.push({ tenantId, name });
      if (opts.failRegister) throw new LicensesAdminError(409, 'name taken');
    },
    async createLicense(subjectId, tenantId) {
      calls.createLicense.push({ subjectId, tenantId });
      if (opts.failCreate) throw new LicensesAdminError(503, 'licenses down');
      return { licenseId: LIC(++n), subjectId: SUBJ(n) };
    },
    async createToken(licenseId, tenantId) {
      calls.createToken.push({ licenseId, tenantId });
      return { token: `token-${licenseId}` };
    },
    async revokeByToken(token, tenantId) {
      calls.revoke.push({ token, tenantId });
      if (opts.failRevoke) throw new LicensesAdminError(503, 'licenses down');
    },
    async revokeByLicenseId(licenseId, tenantId) {
      calls.revokeByLicenseId.push({ licenseId, tenantId });
      if (opts.failRevoke) throw new LicensesAdminError(503, 'licenses down');
    },
  };
  return { client, calls };
}

function setFlag(on: boolean) {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = on;
}

async function storedToken(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ t: tenants.license_token_encrypted })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return tryDecryptSecret(row?.t ?? null);
}

beforeEach(async () => {
  await db
    .insert(tenants)
    .values([
      { id: T_NEW, name: 'New Co', slug: 'new-f2a' },
      { id: T_HASTOKEN, name: 'Has Token Co', slug: 'hastoken-f2a' },
      { id: T_EMPTY, name: 'Empty Co', slug: 'empty-f2a' },
    ])
    .onConflictDoNothing({ target: tenants.id });
  // Reset to a known state regardless of prior runs.
  await db.update(tenants).set({ license_token_encrypted: null }).where(eq(tenants.id, T_NEW));
  await db
    .update(tenants)
    .set({ license_token_encrypted: encryptSecret('pre-existing-token') })
    .where(eq(tenants.id, T_HASTOKEN));
  await db.update(tenants).set({ license_token_encrypted: null }).where(eq(tenants.id, T_EMPTY));
  await db
    .insert(users)
    .values({ id: U_OLDEST, email: 'oldest@new.co', name: 'Oldest', tenant_id: T_NEW })
    .onConflictDoNothing({ target: users.id });
  // Debris from an interrupted run of the tombstone tests below — delete it FIRST, so a poisoned
  // database heals itself instead of failing every subsequent run on a duplicate key.
  await db.delete(users).where(eq(users.id, U_SURVIVOR));
  // The insert above is conflict-DO-NOTHING, so it does NOT restore a row a previous test mutated.
  // The tombstone tests below deliberately backdate `created_at` and set `deleted_at` on this row,
  // and without this reset that state leaked forward and broke whichever test ran next — the
  // "reset to a known state regardless of prior runs" promise above only covered `tenants`.
  await db
    .update(users)
    .set({ deleted_at: null, created_at: new Date('2024-01-01T00:00:00Z'), tenant_id: T_NEW })
    .where(eq(users.id, U_OLDEST));
  setFlag(true); // default ON for the matrix; the no-op test flips it off
  // ⛔ Explicit hook timeout: bun 1.3.14 ignores bunfig.toml's `[test] timeout` (fixed 5 s), and
  // this hook is ~7 round trips at 300-500 ms each on a loaded dev container. Over budget it
  // reports as `(fail) (unnamed) [5003ms]`, naming neither file nor cause.
  //
  // ⛔ CORRECTION, measured 2026-08-02: earlier notes here and in #164/#167/#169/#177 said bun
  // ignores that setting "for HOOKS". It ignores it for TESTS TOO. Proven directly — `bunfig.toml`
  // carries `timeout = 30000`, yet a plain `test()` that sleeps 7 s dies at exactly 5000 ms:
  //     (fail) sleeps 7s … [5011.22ms]   ^ this test timed out after 5000ms.
  // So a slow DB-touching TEST BODY needs its own explicit `}, 30_000)` argument too, and
  // `scripts/check-hook-timeouts.ts` — which only inspects hooks — does NOT cover that case.
}, 30_000);

afterAll(async () => {
  setFlag(false); // restore the F.2 prod/CI default
  __setLicensesAdminForTests(undefined);
  await db.delete(users).where(inArray(users.id, [U_OLDEST, U_SURVIVOR]));
  await db.delete(tenants).where(inArray(tenants.id, [T_NEW, T_HASTOKEN, T_EMPTY]));
}, 30_000);

// ---- the F.2 safety invariant ----

test('flag OFF → ensureTenantLicense is a pure no-op (SA never called, token stays null)', async () => {
  setFlag(false);
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await ensureTenantLicense(T_NEW, 'sub-1');
  expect(calls.createLicense.length).toBe(0);
  expect(await storedToken(T_NEW)).toBeNull();
});

test('flag OFF → revoke is a no-op even when a token exists (service never contacted)', async () => {
  setFlag(false);
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await revokeTenantLicense(T_HASTOKEN);
  expect(calls.revoke.length).toBe(0);
  expect(await storedToken(T_HASTOKEN)).toBe('pre-existing-token'); // untouched
});

// ---- issue + at-rest encryption ----

test('flag ON + no token → issues a license, mints + stores the token encrypted', async () => {
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await ensureTenantLicense(T_NEW, 'sub-1');

  // A2: the tenant licence is held by CP's synthetic tenant subject, never the person whose action
  // triggered it ('sub-1') — bound to a person it WAS their seat licence (licences keys one active
  // licence per subject), and offboarding them 402'd the workspace.
  expect(calls.createLicense).toEqual([{ subjectId: tenantLicenceSubjects(T_NEW)[0], tenantId: T_NEW }]);
  // mint carries the tenant (the X-Tenant-Id ownership check at the service)
  expect(calls.createToken).toEqual([{ licenseId: LIC(1), tenantId: T_NEW }]);
  // round-trips through secret-box to the minted token (encrypted at rest, never plaintext)
  expect(await storedToken(T_NEW)).toBe(`token-${LIC(1)}`);
  const [row] = await db
    .select({ t: tenants.license_token_encrypted })
    .from(tenants)
    .where(eq(tenants.id, T_NEW));
  expect(row!.t).not.toBe(`token-${LIC(1)}`); // stored ciphertext, not the raw token
});

test('idempotent: a 2nd ensure on an already-licensed tenant does NOT re-issue', async () => {
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await ensureTenantLicense(T_HASTOKEN, 'sub-x'); // already has a token
  expect(calls.createLicense.length).toBe(0);
  expect(await storedToken(T_HASTOKEN)).toBe('pre-existing-token');
});

// ---- revoke ----

test('revokeTenantLicense revokes with the decrypted token, then nulls the column', async () => {
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await revokeTenantLicense(T_HASTOKEN);
  // revoke carries the tenant (the X-Tenant-Id ownership check at the service)
  expect(calls.revoke).toEqual([{ token: 'pre-existing-token', tenantId: T_HASTOKEN }]);
  expect(await storedToken(T_HASTOKEN)).toBeNull();
});

test('revoke on a tenant with no token is a no-op', async () => {
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await revokeTenantLicense(T_NEW); // no token
  expect(calls.revoke.length).toBe(0);
});

// ---- reactivate (re-issue bound to oldest user) ----

test('reissueTenantLicense re-issues bound to the tenant oldest user', async () => {
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await reissueTenantLicense(T_NEW); // T_NEW has U_OLDEST, no token
  expect(calls.createLicense).toEqual([{ subjectId: tenantLicenceSubjects(T_NEW)[0], tenantId: T_NEW }]);
  expect(await storedToken(T_NEW)).toBe(`token-${LIC(1)}`);
});

test('reissue SKIPS a tombstoned founder and binds to the oldest LIVE member', async () => {
  // A tombstone keeps its `tenant_id` and stays OLDEST by `created_at` (0050), so the founding
  // member of a tenant, once offboarded, remained this function's pick forever. Nothing downstream
  // catches it: the licences service's `create_or_get_subject` upserts on the `keycloak_sub` string
  // and never asks Keycloak whether that subject exists, so the licence mints against an identity
  // that is gone. It does NOT 402 the tenant (Gate 2 asserts `tenant_id`, not `subject_id`) — it
  // quietly binds the licence to a dead subject, which is an audit-trail defect that would surface
  // during a compliance review rather than in a log. Reachable via suspend → reactivate
  // (`PATCH /api/tenants/:id` with status active).
  // Older than U_OLDEST, and offboarded — the shape that used to win the ORDER BY.
  await db
    .update(users)
    .set({ created_at: new Date('2020-01-01T00:00:00Z'), deleted_at: new Date('2026-07-01T00:00:00Z') })
    .where(eq(users.id, U_OLDEST));
  // ⛔ `onConflictDoNothing`, not a bare insert. This row has a FIXED id, and the dev Postgres is a
  // LONG-LIVED shared container — so an interrupted run (crash, SIGKILL, the documented `:5433`
  // connection drops) leaves the row behind and the next bare insert dies on `23505 duplicate key`.
  // That failure then looks like a genuine logic regression rather than debris, and because the
  // insert sits outside the `finally`, nothing ever cleans it up: permanently red until someone
  // deletes the row by hand. CI never sees it (fresh ephemeral postgres per job), which is exactly
  // what makes it expensive — it only ever bites a human. `U_SURVIVOR` is now in `beforeEach`'s
  // reset and `afterAll`'s cleanup too, so the file self-heals from a poisoned database.
  await db
    .insert(users)
    .values({ id: U_SURVIVOR, email: 'survivor@new.co', name: 'Survivor', tenant_id: T_NEW })
    .onConflictDoNothing({ target: users.id });
  const survivor = U_SURVIVOR;
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  try {
    await reissueTenantLicense(T_NEW);
    // Since A2 no person is the holder at all (the tombstone cannot be, by construction); a LIVE
    // member is still what licenses the reissue to happen.
    expect(survivor).toBeTruthy();
    expect(calls.createLicense).toEqual([{ subjectId: tenantLicenceSubjects(T_NEW)[0], tenantId: T_NEW }]);
  } finally {
    // finally, not a trailing statement: a failed expect() would otherwise leak this row into
    // every later test in the file (and `beforeEach` does not know about it).
    await db.delete(users).where(eq(users.id, survivor));
  }
});

test('reissue on a tenant whose ONLY member is a tombstone is a no-op, not a dead binding', async () => {
  // An all-tombstone tenant is semantically empty. Before the filter it had a "user" to bind to,
  // so it would mint a licence for a workspace nobody can log into.
  await db.update(users).set({ deleted_at: new Date() }).where(eq(users.id, U_OLDEST));
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await reissueTenantLicense(T_NEW);
  expect(calls.createLicense.length).toBe(0);
  expect(await storedToken(T_NEW)).toBeNull();
});

test('reissue on an empty tenant (no users) is a no-op', async () => {
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await reissueTenantLicense(T_EMPTY);
  expect(calls.createLicense.length).toBe(0);
  expect(await storedToken(T_EMPTY)).toBeNull();
});

// ---- fail-loud ----

test('issuance outage → HttpError(502) (fail-loud), token left unset', async () => {
  const { client } = makeAdmin({ failCreate: true });
  __setLicensesAdminForTests(client);
  await expect(ensureTenantLicense(T_NEW, 'sub-1')).rejects.toBeInstanceOf(HttpError);
  await expect(ensureTenantLicense(T_NEW, 'sub-1')).rejects.toMatchObject({ status: 502 });
  expect(await storedToken(T_NEW)).toBeNull();
});

// ---- licences migration 050: ownership refusals are named, never retried, never fallen back from ----

test('a 403 ownership refusal at the mint → 502 licences_access_refused naming licences\' code, token unset', async () => {
  for (const code of ['tenant_not_accessible', 'app_not_issuable_by_caller'] as const) {
    const { client } = makeAdmin();
    let creates = 0;
    client.createLicense = async () => {
      creates++;
      throw new LicencesAccessRefusedError(code, `create license refused by licences: HTTP 403 ${code}`);
    };
    __setLicensesAdminForTests(client);
    const err = await ensureTenantLicense(T_NEW, 'sub-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect((err as HttpError).code).toBe('licences_access_refused');
    expect((err as HttpError).details).toMatchObject({ upstreamStatus: 403, licencesError: code });
    expect(creates).toBe(1); // no retry, no second subject, no fallback
    expect(await storedToken(T_NEW)).toBeNull();
  }
}, 30_000);

test('⛔ the pre-mint register answering tenant_owned_by_other_app FAILS the tenant mint loudly: 502, no mint, no retry, token unset', async () => {
  // Licences answers PUT /tenants/{id} with 200 for an owner OR an active grantee, so this 409 means
  // CP is neither: a real misconfiguration. It is no longer tolerated on the mint path.
  const { client, calls } = makeAdmin();
  client.ensureTenantRegistered = async (tenantId, name) => {
    calls.ensureTenantRegistered.push({ tenantId, name });
    throw new LicencesTenantOwnedByOtherAppError(tenantId);
  };
  __setLicensesAdminForTests(client);
  const err = await ensureTenantLicense(T_NEW, 'sub-1').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(502);
  expect((err as HttpError).code).toBe('licences_tenant_owned_by_other_app');
  expect((err as HttpError).details).toMatchObject({ upstreamStatus: 409 });
  expect(calls.ensureTenantRegistered).toHaveLength(1); // no retry
  expect(calls.createLicense).toHaveLength(0); // never reached the mint
  expect(await storedToken(T_NEW)).toBeNull();
}, 30_000);

test('revoke outage → HttpError(502); the stored token is NOT nulled (row stays reconcilable)', async () => {
  const { client } = makeAdmin({ failRevoke: true });
  __setLicensesAdminForTests(client);
  await expect(revokeTenantLicense(T_HASTOKEN)).rejects.toMatchObject({ status: 502 });
  expect(await storedToken(T_HASTOKEN)).toBe('pre-existing-token'); // untouched on a failed revoke
});

// ===================================================================================================
// PER-MEMBER ENTITLEMENTS (migration 0089)
// ===================================================================================================

const U_MEMBER = '00000000-0000-0000-0000-00000f2a00b1';

async function entRow(userId: string) {
  const rows = await db
    .select()
    .from(memberEntitlements)
    .where(eq(memberEntitlements.user_id, userId))
    .orderBy(memberEntitlements.created_at);
  return rows;
}

async function resetMember() {
  await db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, U_MEMBER));
  await db
    .insert(users)
    .values({ id: U_MEMBER, email: 'member@new.co', name: 'Member', tenant_id: T_NEW })
    .onConflictDoNothing({ target: users.id });
}

test('flag OFF → ensureMemberEntitlement is a pure no-op and never touches the SA client', async () => {
  await resetMember();
  setFlag(false);
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  const out = await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);
  expect(out).toEqual({ state: 'disabled' });
  expect(calls.createLicense.length).toBe(0);
  expect(await entRow(U_MEMBER)).toHaveLength(0);
  setFlag(true);
}, 30_000);

test('ensureMemberEntitlement stores the LICENCE, the central SUBJECT and the token', async () => {
  await resetMember();
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);

  const out = await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);
  expect(out.state).toBe('active');

  // The KEYCLOAK SUB is what goes to the service…
  expect(calls.createLicense).toHaveLength(1);
  // The KEYCLOAK SUB is what goes in the licences path param — passed explicitly by the caller, who
  // must be able to prove it. The onboarding paths pass the sub they just provisioned; the reconciler
  // passes the recorded `users.keycloak_sub` and refuses rows that have none.
  expect(calls.createLicense[0]!.subjectId).toBe(U_MEMBER);

  const [row] = await entRow(U_MEMBER);
  expect(row!.status).toBe('active');
  expect(row!.license_id).toBeTruthy();
  expect(row!.token_encrypted).toBeTruthy();
  expect(tryDecryptSecret(row!.token_encrypted)).toBe(`token-${row!.license_id}`);

  // ⛔ …and the stored subject is the one the SERVICE RETURNED, which is a DIFFERENT value.
  // Asserting the negative as well: a future change that echoes the keycloak sub back into this
  // column would reproduce the `attribution_status='unlicensed'` defect and must fail here.
  expect(row!.license_subject_id).toBe(SUBJ(1));
  expect(row!.license_subject_id).not.toBe(U_MEMBER);
}, 30_000);

test('ensureMemberEntitlement is idempotent — a second call mints nothing', async () => {
  await resetMember();
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);

  const first = await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);
  const second = await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);

  expect(first).toEqual(second);
  expect(calls.createLicense).toHaveLength(1);
  expect(calls.createToken).toHaveLength(1);
  expect(await entRow(U_MEMBER)).toHaveLength(1);
}, 30_000);

test('two concurrent callers mint exactly ONE licence — the partial index is the mutual exclusion', async () => {
  await resetMember();
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);

  // ⭐ THE PROPERTY `ensureTenantLicense` CANNOT HAVE. There, two first-time callers carry DIFFERENT
  // subjects, so the upstream (subject, tenant, app) idempotency key differs and BOTH mint a real
  // billable licence — it compensates with a CAS on the store plus a self-revoke by the loser. Here
  // the claim happens BEFORE the network call, so the second caller never reaches the mint at all.
  const [a, b] = await Promise.all([
    ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER),
    ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER),
  ]);

  expect(calls.createLicense).toHaveLength(1);
  expect(await entRow(U_MEMBER)).toHaveLength(1);

  // ⚠️ DELIBERATELY NOT ASSERTING `['active','pending']`. Both OUTCOMES ARE CORRECT and which one
  // occurs is a timing detail: the loser re-reads the row, and if the winner has already finalised
  // by then it legitimately sees `active`. Pinning one interleaving would make this test flaky on a
  // loaded box and would be asserting the scheduler, not the invariant. What must hold either way:
  //   * exactly ONE licence was minted (above) — the property this whole claim design exists for;
  //   * at least one caller is told the member is licensed;
  //   * NOBODY reports `active` without a real licence id, i.e. no half-built entitlement escapes.
  expect([a.state, b.state]).toContain('active');
  for (const out of [a, b]) {
    if (out.state === 'active') {
      expect(out.licenseId).toBeTruthy();
      expect(out.subjectId).toBeTruthy();
    } else {
      expect(out.state).toBe('pending');
    }
  }
}, 30_000);

test('offboarding revokes the LICENCE (the seat), not merely the token', async () => {
  await resetMember();
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);
  const [before] = await entRow(U_MEMBER);

  await revokeMemberEntitlement(T_NEW, U_MEMBER);

  // ⛔ A token revoke leaves the licence `status='active'` upstream, so licences-service
  // `human_subjects` keeps counting it and the tenant keeps paying for someone who has left.
  expect(calls.revokeByLicenseId).toEqual([{ licenseId: before!.license_id!, tenantId: T_NEW }]);
  expect(calls.revoke).toHaveLength(0);

  const [after] = await entRow(U_MEMBER);
  expect(after!.status).toBe('revoked');
  expect(after!.revoked_at).toBeTruthy();
  expect(after!.token_encrypted).toBeNull();
}, 30_000);

test('a failed revoke leaves the row `revoking` — an unreleased seat must not look released', async () => {
  await resetMember();
  const ok = makeAdmin();
  __setLicensesAdminForTests(ok.client);
  await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);

  const bad = makeAdmin({ failRevoke: true });
  __setLicensesAdminForTests(bad.client);
  await expect(revokeMemberEntitlement(T_NEW, U_MEMBER)).rejects.toBeInstanceOf(HttpError);

  // ⚠️ NOT `revoked`. The seat is still ACTIVE upstream and still BILLABLE; tombstoning here would
  // make an unreleased seat indistinguishable from a released one — the same fail-open shape
  // `revokeTenantLicense` documents at its own decrypt site.
  const [row] = await entRow(U_MEMBER);
  expect(row!.status).toBe('revoking');
  expect(row!.revoked_at).toBeNull();
}, 30_000);

test('⛔ the pre-mint register answering tenant_owned_by_other_app FAILS the member mint loudly: 502, no mint, seat parked in error', async () => {
  await resetMember();
  const { client, calls } = makeAdmin();
  client.ensureTenantRegistered = async (tenantId, name) => {
    calls.ensureTenantRegistered.push({ tenantId, name });
    throw new LicencesTenantOwnedByOtherAppError(tenantId);
  };
  __setLicensesAdminForTests(client);
  const err = await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(502);
  expect((err as HttpError).code).toBe('licences_tenant_owned_by_other_app');
  expect((err as HttpError).details).toMatchObject({ upstreamStatus: 409 });
  expect(calls.ensureTenantRegistered).toHaveLength(1);
  expect(calls.createLicense).toHaveLength(0);
  const [row] = await entRow(U_MEMBER);
  expect(row!.status).toBe('error');
  expect(row!.license_id).toBeNull();
}, 30_000);

test('a member who never reached the mint is tombstoned without calling the service', async () => {
  await resetMember();
  // A licence outage leaves the row `error` with no license_id.
  const failing = makeAdmin({ failCreate: true });
  __setLicensesAdminForTests(failing.client);
  await expect(ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER)).rejects.toBeInstanceOf(HttpError);
  const [errored] = await entRow(U_MEMBER);
  expect(errored!.status).toBe('error');
  expect(errored!.license_id).toBeNull();

  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await revokeMemberEntitlement(T_NEW, U_MEMBER);

  // No seat was ever counted, so there is nothing to release. Calling the service with a null id
  // would 422, and treating THAT as a failure would block an offboard over a seat that never existed.
  expect(calls.revokeByLicenseId).toHaveLength(0);
  const [row] = await entRow(U_MEMBER);
  expect(row!.status).toBe('revoked');
}, 30_000);

test('a re-hire gets a NEW entitlement and the revoked one survives as evidence', async () => {
  await resetMember();
  const { client } = makeAdmin();
  __setLicensesAdminForTests(client);

  await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);
  await revokeMemberEntitlement(T_NEW, U_MEMBER);
  const again = await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);

  expect(again.state).toBe('active');
  const rows = await entRow(U_MEMBER);
  // ⭐ Two rows, which is what `member_entitlements_live_uq` being PARTIAL buys: the earlier seat is
  // still the evidence that this member was licensed in an earlier billing period, and billing bills
  // anyone licensed at ANY instant in the period.
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.status === 'revoked')).toHaveLength(1);
  expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
}, 30_000);

test('an EXPIRED pending lease is re-claimable — the lease must release, not just block', async () => {
  await resetMember();
  // ⭐ THE NEGATIVE CONTROL FOR THE LEASE. The concurrency test above proves the lease BLOCKS a
  // second caller. On its own that is equally consistent with a lease that never releases — which
  // would wedge every stalled saga forever and look exactly like correct exclusion. This proves the
  // other direction, and the two together are what make the claim a lease rather than a lock.
  const stalled = makeAdmin({ failCreate: true });
  __setLicensesAdminForTests(stalled.client);
  await expect(ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER)).rejects.toBeInstanceOf(HttpError);

  // Put the row back to `pending` (a process that died mid-mint leaves it there, not at `error`)
  // and age it past the lease.
  await db
    .update(memberEntitlements)
    .set({ status: 'pending', updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    .where(eq(memberEntitlements.user_id, U_MEMBER));

  const fresh = makeAdmin();
  __setLicensesAdminForTests(fresh.client);
  const out = await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);

  expect(out.state).toBe('active');
  expect(fresh.calls.createLicense).toHaveLength(1);
  const [row] = await entRow(U_MEMBER);
  expect(row!.status).toBe('active');
  expect(row!.license_id).toBeTruthy();
}, 30_000);

test('a FRESH pending row is NOT re-claimable — same statement, opposite side of the lease', async () => {
  await resetMember();
  const stalled = makeAdmin({ failCreate: true });
  __setLicensesAdminForTests(stalled.client);
  await expect(ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER)).rejects.toBeInstanceOf(HttpError);

  // Identical to the test above EXCEPT the age. Same row, same call, `updated_at = now()`.
  await db
    .update(memberEntitlements)
    .set({ status: 'pending', updated_at: new Date() })
    .where(eq(memberEntitlements.user_id, U_MEMBER));

  const fresh = makeAdmin();
  __setLicensesAdminForTests(fresh.client);
  const out = await ensureMemberEntitlement(T_NEW, U_MEMBER, U_MEMBER);

  expect(out).toEqual({ state: 'pending', reason: 'held-by-another-caller' });
  expect(fresh.calls.createLicense).toHaveLength(0);
}, 30_000);

// ---- TENANT-LEVEL LICENCES (ruling 2026-09-28): onboarding mints NOTHING beside the bundle ----

test('tenant-level: tenant already holds its svc licence → ensureTenantLicense mints nothing, stores nothing', async () => {
  setFlag(true);
  const { client, calls } = makeAdmin();
  const asked: Array<{ tenantId: string; subjectId?: string }> = [];
  __setLicensesAdminForTests({
    ...client,
    async getActiveLicense(tenantId, opts) {
      asked.push({ tenantId, subjectId: opts?.subjectId });
      return { active: true, tenant_id: tenantId, app: { key: 'commonpractice' }, subject_match: true };
    },
  });
  await ensureTenantLicense(T_NEW, 'kc-sub-first-member');
  expect(asked).toEqual([{ tenantId: T_NEW, subjectId: `svc:${T_NEW}:commonpractice` }]);
  expect(calls.createLicense.length).toBe(0);
  expect(calls.createToken.length).toBe(0);
  expect(await storedToken(T_NEW)).toBeNull();
});

test('tenant-level: the active pick is a MEMBER licence (subject_match false) → mints as before', async () => {
  setFlag(true);
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests({
    ...client,
    async getActiveLicense(tenantId) {
      return { active: true, tenant_id: tenantId, app: { key: 'commonpractice' }, subject_match: false };
    },
  });
  await ensureTenantLicense(T_NEW, 'kc-sub-first-member');
  expect(calls.createLicense.length).toBe(1);
  expect(await storedToken(T_NEW)).not.toBeNull();
});
