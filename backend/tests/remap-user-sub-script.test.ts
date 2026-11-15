// tests/remap-user-sub-script.test.ts — scripts/remap-user-sub.ts re-keys ONE user from an old Keycloak
// sub to a new one in one transaction (realm-per-app P2, Ola portal → commonpractice), and moves her
// member seat revoke-THEN-issue so no second seat is ever held.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { config } from '../src/config';
import { db } from '../src/db/client';
import { __setLicensesAdminForTests, type LicensesAdminClient } from '../src/services/licenses-admin';
import {
  applyRemap,
  moveMemberLicence,
  parseArgs,
  planRemap,
  referencingColumns,
  RemapRefused,
  SUB_COLUMNS,
} from '../scripts/remap-user-sub';

const id = (n: string) => `00000000-0000-4000-8000-0000000f${n.padStart(4, '0')}`;
const TENANT = id('0001');
const OLD = id('0002');
const NEW = id('0003');
const OTHER = id('0004'); // a bystander: must be untouched
const NOSUB = id('0005'); // a users row whose keycloak_sub differs from its id
const NEW2 = id('0006');
const OLD2 = id('0007'); // pre-existing-stub scenario: the user logged in with NEW3 before the remap
const NEW3 = id('0008');
const OLD3 = id('0009'); // pre-existing NON-stub scenario: NEW4 already has a workspace
const NEW4 = id('0010');
const OLD4 = id('0011'); // --to points at a DIFFERENT real pending user (other email)
const NEW5 = id('0012');
const OLD5 = id('0013'); // same-email stub, but created BEFORE --moved-after
const NEW6 = id('0014');

type Row = Record<string, unknown>;
const q = async (s: string): Promise<Row[]> => {
  const r = (await db.execute(sql.raw(s))) as unknown;
  return Array.isArray(r) ? (r as Row[]) : ((r as { rows?: Row[] }).rows ?? []);
};
const count = async (s: string): Promise<number> => Number((await q(s))[0]?.n ?? 0);

async function cleanup(): Promise<void> {
  const ids = [OLD, NEW, OTHER, NOSUB, NEW2, OLD2, NEW3, OLD3, NEW4, OLD4, NEW5, OLD5, NEW6].map((x) => `'${x}'`).join(',');
  await q(`DELETE FROM usage_events WHERE tenant_id = '${TENANT}'`);
  await q(`DELETE FROM member_entitlements WHERE tenant_id = '${TENANT}'`);
  await q(`DELETE FROM notifications WHERE tenant_id = '${TENANT}'`);
  await q(`DELETE FROM tenant_invites WHERE tenant_id = '${TENANT}'`);
  await q(`DELETE FROM audit_log WHERE action = 'remap-test'`);
  await q(`DELETE FROM signup_approvals WHERE email LIKE 'remap-%@example.test'`);
  await q(`DELETE FROM tenant_llm_budgets WHERE tenant_id = '${TENANT}'`);
  await q(`DELETE FROM users WHERE id IN (${ids})`);
  await q(`DELETE FROM tenants WHERE id = '${TENANT}'`);
}

async function seed(): Promise<void> {
  await cleanup();
  await q(`INSERT INTO tenants (id, name, slug) VALUES ('${TENANT}', 'Remap T', 'remap-t-${TENANT.slice(-4)}')`);
  await q(`INSERT INTO users (id, keycloak_sub, email, name, tenant_id, tenant_role, locale)
           VALUES ('${OLD}', '${OLD}', 'remap-ola@example.test', 'Ola', '${TENANT}', 'tenant_admin', 'pl'),
                  ('${OTHER}', '${OTHER}', 'remap-other@example.test', 'Other', '${TENANT}', 'member', NULL),
                  ('${NOSUB}', 'some-other-sub', 'remap-nosub@example.test', 'NoSub', '${TENANT}', 'member', NULL)`);
  await q(`INSERT INTO signup_approvals (email, keycloak_sub, decided_by) VALUES
           ('remap-ola@example.test', '${OLD}', '${OTHER}'), ('remap-x@example.test', NULL, '${OLD}')`);
  await q(`INSERT INTO tenant_invites (tenant_id, email, token_hash, expires_at, keycloak_sub, invited_by, accepted_by)
           VALUES ('${TENANT}', 'remap-ola@example.test', 'remap-h1', now() + interval '1 day', '${OLD}', '${OTHER}', '${OLD}')`);
  await q(`INSERT INTO audit_log (action, actor_id) VALUES ('remap-test', '${OLD}'), ('remap-test', '${OTHER}')`);
  await q(`INSERT INTO audit_log (action, target_type, target_id) VALUES ('remap-test', 'user', '${OLD}'), ('remap-test', 'user', '${OTHER}')`);
  await q(`INSERT INTO notifications (tenant_id, user_id, kind, title) VALUES ('${TENANT}', '${OLD}', 'k', 't'), ('${TENANT}', '${OTHER}', 'k', 't')`);
  await q(`INSERT INTO member_entitlements (tenant_id, user_id, status, license_id, license_subject_id, token_encrypted, provisioned_at) VALUES ('${TENANT}', '${OLD}', 'active', '${id('0100')}', '${id('0101')}', 'enc', now())`);
  await q(`INSERT INTO usage_events (tenant_id, user_id, actor_id, provider, model) VALUES ('${TENANT}', '${OLD}', '${OLD}', 'p', 'm')`);
  await q(`INSERT INTO tenant_llm_budgets (tenant_id, limit_usd, created_by) VALUES ('${TENANT}', 1, '${OLD}')`);
}

beforeAll(seed, 30_000);
afterAll(cleanup, 30_000);

test('referencingColumns = every FK to users(id) + the non-FK sub columns', async () => {
  const cols = await db.transaction(async (tx) => referencingColumns(tx as never));
  const fkCount = await count(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.users'::regclass`,
  );
  expect(cols.filter((c) => c.fk).length).toBe(fkCount);
  expect(fkCount).toBeGreaterThan(30);
  for (const sc of SUB_COLUMNS) expect(cols.some((c) => c.table === sc.table && c.column === sc.column)).toBe(true);
  for (const must of ['member_entitlements.user_id', 'tenant_invites.invited_by', 'signup_approvals.decided_by', 'usage_events.user_id']) {
    expect(cols.some((c) => `${c.table}.${c.column}` === must)).toBe(true);
  }
});

test('dry run: per-table counts, nothing written', async () => {
  const plan = await planRemap(OLD, NEW);
  expect(plan.state).toBe('ready');
  expect(plan.tenantId).toBe(TENANT);
  const by = Object.fromEntries(plan.columns.map((c) => [`${c.table}.${c.column}`, c.rows]));
  expect(by['signup_approvals.keycloak_sub']).toBe(1);
  expect(by['signup_approvals.decided_by']).toBe(1);
  expect(by['tenant_invites.keycloak_sub']).toBe(1);
  expect(by['tenant_invites.accepted_by']).toBe(1);
  expect(by['tenant_invites.invited_by']).toBe(0);
  expect(by['usage_events.actor_id']).toBe(1);
  expect(by['usage_events.user_id']).toBe(1);
  expect(by['member_entitlements.user_id']).toBe(1);
  expect(by['tenant_llm_budgets.created_by']).toBe(1);
  expect(by['audit_log.target_id']).toBe(1);
  expect(by['audit_log.actor_id']).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${OLD}'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${NEW}'`)).toBe(0);
});

test('refusals write nothing: --to taken, --from unknown, id ≠ keycloak_sub', async () => {
  await expect(applyRemap(OLD, OTHER)).rejects.toThrow(/already a users id/);
  await expect(applyRemap(id('0999'), NEW2)).rejects.toThrow(/no users row/);
  await expect(applyRemap(NOSUB, NEW2)).rejects.toThrow(/does not have id = keycloak_sub/);
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${OLD}' AND keycloak_sub = '${OLD}'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${NEW2}'`)).toBe(0);
});

test('apply: every reference moves, the row is re-keyed, bystanders untouched', async () => {
  const plan = await applyRemap(OLD, NEW);
  expect(plan.state).toBe('ready');
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${OLD}' OR keycloak_sub = '${OLD}'`)).toBe(0);
  const [u] = await q(`SELECT keycloak_sub, email, name, tenant_id::text AS t, tenant_role::text AS r, locale FROM users WHERE id = '${NEW}'`);
  expect(u).toMatchObject({ keycloak_sub: NEW, email: 'remap-ola@example.test', name: 'Ola', t: TENANT, r: 'tenant_admin', locale: 'pl' });
  // every column, FK or not, is clear of OLD
  const cols = await db.transaction(async (tx) => referencingColumns(tx as never));
  for (const c of cols) {
    expect(await count(`SELECT count(*)::int AS n FROM "${c.table}" WHERE "${c.column}"::text = '${OLD}'`)).toBe(0);
  }
  expect(await count(`SELECT count(*)::int AS n FROM signup_approvals WHERE keycloak_sub = '${NEW}'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM tenant_invites WHERE keycloak_sub = '${NEW}' AND accepted_by = '${NEW}' AND invited_by = '${OTHER}'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM usage_events WHERE actor_id = '${NEW}' AND user_id = '${NEW}'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM member_entitlements WHERE user_id = '${NEW}' AND status = 'active'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = '${TENANT}'`)).toBe(2); // CASCADE did not fire
  expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'remap-test' AND actor_id = '${OTHER}'`)).toBe(1);
  // audit_log.target_id (text, no FK) follows the user; a bystander's target row does not move
  expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'remap-test' AND target_id = '${NEW}'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'remap-test' AND target_id = '${OTHER}'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${OTHER}' AND keycloak_sub = '${OTHER}'`)).toBe(1);
});

test('re-run after apply is a no-op: already_remapped', async () => {
  expect((await applyRemap(OLD, NEW)).state).toBe('already_remapped');
  expect((await planRemap(OLD, NEW)).state).toBe('already_remapped');
});

// ---- pre-existing --to row (the user logged in to CP with the new sub before the remap) ----------

async function seedPreexisting(): Promise<void> {
  await q(`INSERT INTO users (id, keycloak_sub, email, name, tenant_id, tenant_role)
           VALUES ('${OLD2}', '${OLD2}', 'remap-ola2@example.test', 'Ola2', '${TENANT}', 'member'),
                  ('${NEW3}', '${NEW3}', 'remap-ola2@example.test', 'Ola2', NULL, NULL),
                  ('${OLD3}', '${OLD3}', 'remap-ola3@example.test', 'Ola3', '${TENANT}', 'member'),
                  ('${NEW4}', '${NEW4}', 'remap-ola3@example.test', 'Ola3', '${TENANT}', 'member')`);
  // exactly what ensureUser → recordSignupStrand writes on a stranded first login
  await q(`INSERT INTO signup_approvals (email, keycloak_sub, status) VALUES ('remap-ola2@example.test', '${NEW3}', 'pending')`);
  await q(`INSERT INTO audit_log (action, target_type, target_id) VALUES ('remap-test', 'user', '${NEW3}')`);
}

test('pre-existing --to stub: refused WITH a plan unless --resolve-preexisting; nothing written', async () => {
  await seedPreexisting();
  const err = await applyRemap(OLD2, NEW3).catch((e: Error) => e);
  expect(err).toBeInstanceOf(RemapRefused);
  expect((err as Error).message).toMatch(/already a users id/);
  expect((err as Error).message).toMatch(/1 pending signup_approvals/);
  expect((err as Error).message).toMatch(/--resolve-preexisting/);
  await expect(planRemap(OLD2, NEW3)).rejects.toThrow(/--resolve-preexisting/);
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id IN ('${OLD2}', '${NEW3}')`)).toBe(2);
  expect(await count(`SELECT count(*)::int AS n FROM signup_approvals WHERE keycloak_sub = '${NEW3}' AND status = 'pending'`)).toBe(1);
});

test('pre-existing --to stub: --resolve-preexisting dry run shows the plan and writes nothing', async () => {
  const plan = await planRemap(OLD2, NEW3, true);
  expect(plan.state).toBe('ready');
  expect(plan.preexisting).toMatchObject({ userId: NEW3, tenantId: null, pendingApprovals: 1, auditTargetRows: 1, blockers: [] });
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${NEW3}' AND tenant_id IS NULL`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM signup_approvals WHERE keycloak_sub = '${NEW3}'`)).toBe(1);
});

test('pre-existing --to stub: --resolve-preexisting --apply removes stub + pending approval and re-keys, one tx', async () => {
  const plan = await applyRemap(OLD2, NEW3, true);
  expect(plan.state).toBe('ready');
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${OLD2}' OR keycloak_sub = '${OLD2}'`)).toBe(0);
  const [u] = await q(`SELECT keycloak_sub, tenant_id::text AS t, tenant_role::text AS r FROM users WHERE id = '${NEW3}'`);
  expect(u).toMatchObject({ keycloak_sub: NEW3, t: TENANT, r: 'member' }); // OLD2's seat, not the stub's
  expect(await count(`SELECT count(*)::int AS n FROM signup_approvals WHERE keycloak_sub = '${NEW3}'`)).toBe(0);
  expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE target_id = '${NEW3}'`)).toBe(1);
});

test('pre-existing --to that is NOT a stub (has a workspace): refused even with --resolve-preexisting', async () => {
  const err = await applyRemap(OLD3, NEW4, true).catch((e: Error) => e);
  expect(err).toBeInstanceOf(RemapRefused);
  expect((err as Error).message).toMatch(/NOT a removable stub/);
  expect((err as Error).message).toMatch(/already has a workspace/);
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id IN ('${OLD3}', '${NEW4}') AND tenant_id IS NOT NULL`)).toBe(2);
});

test('--resolve-preexisting refuses when --to is a DIFFERENT real pending user (email differs)', async () => {
  await q(`INSERT INTO users (id, keycloak_sub, email, name, tenant_id, tenant_role)
           VALUES ('${OLD4}', '${OLD4}', 'remap-ola4@example.test', 'Ola4', '${TENANT}', 'member'),
                  ('${NEW5}', '${NEW5}', 'remap-someone-else@example.test', 'Someone', NULL, NULL)`);
  await q(`INSERT INTO signup_approvals (email, keycloak_sub, status) VALUES ('remap-someone-else@example.test', '${NEW5}', 'pending')`);
  const err = await applyRemap(OLD4, NEW5, true).catch((e: Error) => e);
  expect(err).toBeInstanceOf(RemapRefused);
  expect((err as Error).message).toMatch(/NOT a removable stub/);
  expect((err as Error).message).toMatch(/DIFFERENT person/);
  const plan = await planRemap(OLD4, NEW5, true).catch((e: Error) => e);
  expect(plan).toBeInstanceOf(RemapRefused);
  // nothing changed: the other person's row and pending approval survive, OLD4 untouched
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${NEW5}' AND tenant_id IS NULL`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM signup_approvals WHERE keycloak_sub = '${NEW5}' AND status = 'pending'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id = '${OLD4}' AND keycloak_sub = '${OLD4}'`)).toBe(1);
});

test('--resolve-preexisting refuses a same-email stub created BEFORE --moved-after', async () => {
  await q(`INSERT INTO users (id, keycloak_sub, email, name, tenant_id, tenant_role)
           VALUES ('${OLD5}', '${OLD5}', 'remap-ola5@example.test', 'Ola5', '${TENANT}', 'member'),
                  ('${NEW6}', '${NEW6}', 'REMAP-ola5@example.test', 'Ola5', NULL, NULL)`);
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const err = await applyRemap(OLD5, NEW6, { resolvePreexisting: true, movedAfter: future }).catch((e: Error) => e);
  expect(err).toBeInstanceOf(RemapRefused);
  expect((err as Error).message).toMatch(/created before the move/);
  expect((err as Error).message).not.toMatch(/DIFFERENT person/); // case-insensitive email match
  // default cut-off (now - 24h) accepts the just-created stub: dry run shows a resolvable plan
  const plan = await planRemap(OLD5, NEW6, true);
  expect(plan.preexisting).toMatchObject({ sameEmail: true, blockers: [] });
  expect(await count(`SELECT count(*)::int AS n FROM users WHERE id IN ('${OLD5}', '${NEW6}')`)).toBe(2);
});

test('parseArgs: UUIDs required, from ≠ to, dry run by default', () => {
  expect(parseArgs(['--from', OLD, '--to', NEW])).toEqual({
    from: OLD,
    to: NEW,
    apply: false,
    moveLicence: false,
    resolvePreexisting: false,
    movedAfter: null,
  });
  expect(parseArgs(['--from', OLD, '--to', NEW, '--moved-after', '2026-10-21T18:00:00Z']).movedAfter).toBe(
    '2026-10-21T18:00:00.000Z',
  );
  expect(() => parseArgs(['--from', OLD, '--to', NEW, '--moved-after', 'yesterday'])).toThrow(/ISO timestamp/);
  expect(parseArgs(['--from', OLD, '--to', NEW, '--resolve-preexisting']).resolvePreexisting).toBe(true);
  expect(parseArgs(['--from', OLD, '--to', NEW, '--apply', '--move-licence']).apply).toBe(true);
  expect(() => parseArgs(['--from', 'x', '--to', NEW])).toThrow(RemapRefused);
  expect(() => parseArgs(['--from', OLD, '--to', OLD])).toThrow(/same/);
});

// ---- licence move -------------------------------------------------------------------------------

function fakeLicences(calls: string[], held: Array<{ id: string; tenantId: string; status: string; appKey: string | null }>): LicensesAdminClient {
  return {
    ensureTenantRegistered: async () => void calls.push('register'),
    createLicense: async (sub: string) => {
      calls.push(`create:${sub}`);
      return { licenseId: id('0200'), subjectId: id('0201'), termsMatch: true };
    },
    createToken: async () => (calls.push('token'), { token: 'tok-new' }),
    revokeByToken: async () => void calls.push('revokeByToken'),
    revokeByLicenseId: async (lic: string) => void calls.push(`revoke:${lic}`),
    listSubjectLicences: async (sub: string) => (calls.push(`list:${sub}`), held),
  } as LicensesAdminClient;
}

async function withLicenceConfig<T>(userRealm: string, fn: () => Promise<T>): Promise<T> {
  const lic = config.license as unknown as { issuanceEnabled: boolean; adminBaseUrl: string; sa: { tokenUrl: string } };
  const kc = config.keycloak as unknown as { userRealm: string };
  const saved = { i: lic.issuanceEnabled, b: lic.adminBaseUrl, t: lic.sa.tokenUrl, r: kc.userRealm };
  Object.assign(lic, { issuanceEnabled: true, adminBaseUrl: 'http://licences.fake' });
  lic.sa.tokenUrl = 'http://kc.fake/token';
  kc.userRealm = userRealm;
  try {
    return await fn();
  } finally {
    Object.assign(lic, { issuanceEnabled: saved.i, adminBaseUrl: saved.b });
    lic.sa.tokenUrl = saved.t;
    kc.userRealm = saved.r;
    __setLicensesAdminForTests(undefined);
  }
}

test('licence move refuses outside the cutover env (KEYCLOAK_USER_REALM ≠ commonpractice)', async () => {
  const calls: string[] = [];
  await withLicenceConfig('portal', async () => {
    __setLicensesAdminForTests(fakeLicences(calls, []));
    await expect(moveMemberLicence(TENANT, NEW, true)).rejects.toThrow(/KEYCLOAK_USER_REALM/);
  });
  expect(calls).toEqual([]);
});

test('licence move: dry run touches nothing; apply REVOKES the old seat BEFORE minting the new one', async () => {
  const calls: string[] = [];
  await withLicenceConfig('commonpractice', async () => {
    __setLicensesAdminForTests(fakeLicences(calls, []));
    expect(await moveMemberLicence(TENANT, NEW, false)).toEqual({ state: 'would_move' });
    expect(calls.filter((c) => c.startsWith('revoke') || c.startsWith('create'))).toEqual([]);
    const out = await moveMemberLicence(TENANT, NEW, true);
    expect(out).toEqual({ state: 'moved', licenseId: id('0200'), subjectId: id('0201') });
  });
  const revokeAt = calls.indexOf(`revoke:${id('0100')}`);
  const createAt = calls.indexOf(`create:${NEW}`);
  expect(revokeAt).toBeGreaterThanOrEqual(0);
  expect(createAt).toBeGreaterThan(revokeAt);
  expect(calls.filter((c) => c.startsWith('create:')).length).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM member_entitlements WHERE user_id = '${NEW}' AND status = 'active' AND license_id = '${id('0200')}'`)).toBe(1);
  expect(await count(`SELECT count(*)::int AS n FROM member_entitlements WHERE user_id = '${NEW}' AND status = 'revoked' AND license_id = '${id('0100')}'`)).toBe(1);
});

test('licence move is idempotent: the new subject already holds an active licence ⇒ skipped', async () => {
  const calls: string[] = [];
  await withLicenceConfig('commonpractice', async () => {
    __setLicensesAdminForTests(fakeLicences(calls, [{ id: id('0200'), tenantId: TENANT, status: 'active', appKey: config.license.appKey }]));
    expect(await moveMemberLicence(TENANT, NEW, true)).toEqual({ state: 'already_moved', licenseId: id('0200') });
  });
  expect(calls.filter((c) => c.startsWith('revoke') || c.startsWith('create'))).toEqual([]);
});
