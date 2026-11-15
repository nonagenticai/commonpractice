// tests/mcp-key-rls-lockout.test.ts — external MCP API-key auth NEVER WORKED IN PRODUCTION.
//
// ⛔ A chicken-and-egg RLS lockout. `verifyKey` looks up `mcp_api_keys` by hash — it HAS to, because
// that lookup is how the tenant is DISCOVERED. So it necessarily runs before any tenant context
// exists: `server.ts` resolves a non-JWT bearer to `tenantId = null`, so no tenant GUC is set. But
// `mcp_api_keys` has strict RLS (0028 §4a, `tenant_id = app_current_tenant_uuid()`, no NULL
// passthrough), so under `cp_app` with no GUC the row is INVISIBLE and every valid, non-revoked key
// failed as `Invalid MCP API key`.
//
// ⛔ WHY EVERY EXISTING TEST MISSED IT — and why this file exists at all: the suite connects as the
// table OWNER, which bypasses RLS entirely. That is the ONE configuration in which this bug cannot
// reproduce. A test that does not `SET ROLE cp_app` proves nothing about RLS. Verified live:
//
//   SELECT count(*) FROM mcp_api_keys;                    -> 3   (1 active)
//   SET ROLE cp_app; SELECT count(*) FROM mcp_api_keys;   -> 0   <- what verifyKey actually saw
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { db, users, tenants, mcpApiKeys } from '../src/db/client';
import { mintKey, verifyKey } from '../src/services/mcp-api-key';

const TENANT = '00000000-0000-4000-8000-00000000e001';
const ISSUER = '00000000-0000-4000-8000-00000000e002';

/** A connection that has become `cp_app` via SET ROLE — the same technique rls-isolation.test.ts
 *  uses. RLS is skipped only for the table OWNER and BYPASSRLS roles, so this is the only way to
 *  exercise the policy the way prod does. `max: 1` because SET ROLE is per-session. */
function cpAppSql() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  return { sql, ready: sql`SET ROLE cp_app` };
}

async function cleanup() {
  await db.delete(mcpApiKeys).where(eq(mcpApiKeys.tenant_id, TENANT));
  await db.delete(users).where(inArray(users.id, [ISSUER]));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: TENANT, name: 'MCP Key RLS Co', slug: 'mcp-key-rls-co' }).onConflictDoNothing();
  await db.insert(users).values({ id: ISSUER, email: 'mcpkey@test', name: 'Key Issuer', tenant_id: TENANT }).onConflictDoNothing();
}, 30_000);
afterAll(cleanup, 30_000);

test('the key row is INVISIBLE to cp_app without a tenant GUC — the lockout, reproduced', async () => {
  const { raw } = await mintKey({ tenantId: TENANT, issuedBy: ISSUER, name: 'probe' });
  expect(raw).toBeTruthy();

  const { sql, ready } = cpAppSql();
  try {
    await ready;
    // Exactly the state verifyKey ran in: cp_app, no app.current_tenant set.
    const rows = await sql`SELECT count(*)::int AS n FROM mcp_api_keys`;
    expect(rows[0]!.n).toBe(0); // <- the row exists, but RLS hides it
    // ...and with the GUC set, it is visible — proving RLS is the cause, not a missing row.
    await sql`SELECT set_config('app.current_tenant', ${TENANT}, false)`;
    const scoped = await sql`SELECT count(*)::int AS n FROM mcp_api_keys`;
    expect(scoped[0]!.n).toBe(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test('verifyKey resolves a freshly minted key — it must not depend on ambient tenant context', async () => {
  // ⚠️ HONEST LIMIT, and it is the crux of why this bug shipped: this assertion passes on the
  // BROKEN code too, because this suite connects as the table OWNER, which bypasses RLS. It is a
  // regression guard for the behaviour, NOT proof of the fix. The test above is the one that
  // demonstrates the actual hazard, by querying as `cp_app` directly.
  //
  // A test that truly discriminated would have to drive `verifyKey` through a `cp_app`-scoped
  // Db (it accepts one as its second argument). That is worth doing if this file grows; recorded
  // here rather than left as a silent gap, because "the suite runs as owner" is exactly the blind
  // spot that let an entire authentication path be dead in prod without a single red test.
  const { raw } = await mintKey({ tenantId: TENANT, issuedBy: ISSUER, name: 'probe2' });
  const verified = await verifyKey(raw);
  expect(verified.tenantId).toBe(TENANT);
  expect(verified.userId).toBe(ISSUER);
});

test('a key whose issuer cannot be verified is REFUSED, not accepted (fail closed)', async () => {
  // ⚠️ Also honest: with the issuer row hard-deleted, `mcp_api_keys.issued_by` is nulled by its
  // `ON DELETE SET NULL` FK, so the PRE-EXISTING `!row.issued_by` guard already refuses this — the
  // test passes on the old code too, and is a regression guard for that guard.
  //
  // The `!issuer` check added alongside it is DEFENCE IN DEPTH for a case not reachable today:
  // `issued_by` still populated while the `users` row is unreadable (a future RLS policy on
  // `users`, exactly as `mcp_api_keys` already has). `issuer?.deletedAt` alone would leave that
  // unevaluated and ACCEPT the key. Given this very file documents an auth path killed by an
  // unexpected RLS policy, a fail-open branch of the same shape is not one to leave standing.
  const { raw } = await mintKey({ tenantId: TENANT, issuedBy: ISSUER, name: 'probe3' });
  await db.delete(users).where(eq(users.id, ISSUER)); // issuer row vanishes
  await expect(verifyKey(raw)).rejects.toThrow(/issuer/i);
  // restore for afterAll ordering
  await db.insert(users).values({ id: ISSUER, email: 'mcpkey@test', name: 'Key Issuer', tenant_id: TENANT }).onConflictDoNothing();
});
