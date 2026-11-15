// tests/tenant-seats-include-invites.test.ts — "seats used" must be members PLUS pending invites.
//
// The cap is ENFORCED that way (services/seat-limit.ts `claimSeatInTx`: an unexpired pending invite
// reserves its seat) and the tenant page copy says so ("Counts members plus pending invitations").
// But the page rendered `memberCount` — prod tenant Netcare showed "0 / unlimited" with one
// tenant_admin invite open (E2E 2026-10-14). The members page's `getSeatUsage` had the same gap.
// Only a PENDING, UNEXPIRED invite counts: revoked, accepted and expired ones hold nothing.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { db, tenants, users } from '../src/db/client';
import { tenantInvites } from '../src/db/schema';
import { getSeatUsage } from '../src/services/seat-limit';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts).
const TENANT = '00000000-0000-4000-8000-00005ea71001';
const UID_SUPER = '00000000-0000-4000-8000-00005ea71011';
const UID_MEMBER = '00000000-0000-4000-8000-00005ea71012';

const superAdmin: User = {
  id: UID_SUPER,
  email: 'seats-inv-super@test',
  name: 'Seats Inv Super',
  roles: ['super_admin'],
  tenantId: undefined,
};

const router = new Router();
registerAdminRoutes(router);

async function cleanup() {
  await db.delete(tenantInvites).where(eq(tenantInvites.tenant_id, TENANT));
  await db.delete(users).where(inArray(users.id, [UID_SUPER, UID_MEMBER]));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: TENANT, name: 'Seats Inv Co', slug: 'seats-inv-co' });
  await db.insert(users).values([
    { id: UID_SUPER, email: superAdmin.email, name: superAdmin.name },
    { id: UID_MEMBER, tenant_id: TENANT, email: 'seats-inv-member@test', name: 'Seats Inv Member' },
  ]);
  const future = new Date(Date.now() + 7 * 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  await db.insert(tenantInvites).values([
    { tenant_id: TENANT, email: 'pending@seats-inv.test', role: 'tenant_admin', token_hash: 'seats-inv-h1', expires_at: future },
    { tenant_id: TENANT, email: 'revoked@seats-inv.test', token_hash: 'seats-inv-h2', expires_at: future, status: 'revoked', revoked_at: new Date() },
    { tenant_id: TENANT, email: 'accepted@seats-inv.test', token_hash: 'seats-inv-h3', expires_at: future, status: 'accepted' },
    { tenant_id: TENANT, email: 'expired@seats-inv.test', token_hash: 'seats-inv-h4', expires_at: past },
  ]);
  __setAuthOverridesForTests({ validateAuth: async () => superAdmin, requireRole: async () => superAdmin });
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

test('⛔ the platform tenant row counts the pending invite as a seat (and only that one)', async () => {
  // REVERT THAT REDDENS THIS: drop `seatsUsed`/`pendingInviteCount` from listAllTenants.
  const matched = router.match('GET', '/api/admin/tenants');
  if (!matched) throw new Error('no route for GET /api/admin/tenants');
  const res = await matched.handler(new Request(`http://localhost/api/admin/tenants?id=${TENANT}`), ...matched.params);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tenants: Array<Record<string, unknown>> };
  expect(body.tenants).toHaveLength(1);
  const t = body.tenants[0]!;
  expect(t.memberCount).toBe(1); // still PEOPLE — the offboard confirmation counts these
  expect(t.pendingInviteCount).toBe(1);
  expect(t.seatsUsed).toBe(2);
});

test('getSeatUsage (members page) agrees with the enforcement: members + pending invites', async () => {
  const usage = await getSeatUsage(TENANT);
  expect(usage.used).toBe(2);
});
