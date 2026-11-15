// tests/audit-export-orphan-actor.test.ts — a super_admin with NO `users` row must not be able to
// 500 the compliance export, and the attempt must leave a trace.
//
// ⛔ THE SEAM. `requireSuperAdmin` runs `authenticateWithoutLicense`, which never calls
// `ensureUser`; a super_admin granted directly in Keycloak routinely has no local `users` row.
// `audit_exports.actor_id` is a FK to `users.id` (schema.ts:1191) and the CLAIM-THE-DAY insert in
// audit-export.ts sits OUTSIDE the try block that guards the rest of the run. So the 23503
// propagated unhandled: `POST /api/audit/export` 500'd, and because the claim never landed there
// was no `audit_exports` row either — the failure was invisible the moment the response was gone.
// `recordAudit` has the SAME FK on `audit_log.actor_id`; it is best-effort so it does not 500, but
// the row it was asked to write was simply lost.
//
// ⛔ WHY THIS SURVIVED: db/seed-datasets.ts:313-316 inserts a `users` row for the AUTH_BYPASS id,
// so every test that leans on the seeded dev user is structurally blind to both defects. The actor
// below is asserted to have NO `users` row before anything else runs.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { db, auditLog, auditExports, users } from '../src/db/client';
import { recordAudit } from '../src/host/audit-service';
import { registerAuditRoutes } from '../src/routes/audit';
import { Router } from '../src/utils/router';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError, type User } from '../src/types';

const DATE = '2097-07-07';
const ORPHAN_ID = '00000000-0000-0000-0000-00000a7f0001';
const MARK = 'ZTEST-ORPHAN-ACTOR';

// A platform operator granted super_admin in Keycloak and NOTHING ELSE — no local users row.
const orphanOperator: User = {
  id: ORPHAN_ID,
  email: 'orphan-op@test',
  name: 'Orphan Operator',
  roles: ['super_admin'],
  tenantId: '00000000-0000-0000-0000-00000a7f0002',
};

const router = new Router();
registerAuditRoutes(router);

async function callJson(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // `route()` RETHROWS anything that is not an HttpError/ZodError/UnauthorizedError, and
  // server.ts:385 turns that into a bare 500 `Internal Server Error`. Mirror that here so the
  // assertion below reads the same status a browser would get.
  let res: Response;
  try {
    res = await matched.handler(req, ...matched.params);
  } catch (err) {
    return { status: 500, json: { error: 'Internal Server Error', thrown: String(err).slice(0, 200) } };
  }
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  await db.delete(auditExports).where(eq(auditExports.export_date, DATE));
  await db.delete(auditLog).where(and(eq(auditLog.action, 'audit.export'), eq(auditLog.target_id, DATE)));
  await db.delete(auditLog).where(eq(auditLog.action, `${MARK}.probe`));
}

beforeAll(async () => {
  await cleanup();
  // ⛔ THE NON-VACUITY PRECONDITION. If this id ever gains a `users` row the tests below become
  // decorative, so it is asserted, not assumed.
  const seat = await db.select({ id: users.id }).from(users).where(eq(users.id, ORPHAN_ID));
  expect(seat.length).toBe(0);
  __setAuthOverridesForTests({
    validateAuth: async () => orphanOperator,
    requireRole: async (_req, role) => {
      if (!orphanOperator.roles.includes(role)) throw new UnauthorizedError(`Role '${role}' required`);
      return orphanOperator;
    },
  });
}, 60_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 60_000);

test('POST /api/audit/export does not 500 for an actor with no users row', async () => {
  const r = await callJson('POST', '/api/audit/export', { date: DATE, force: true });
  expect(r.status).not.toBe(500);
  expect(r.status).toBe(200);
});

test('the attempt leaves a trace even though the actor has no users row', async () => {
  await callJson('POST', '/api/audit/export', { date: DATE, force: true });
  // The durable record of the run. Without the claim insert there is NO row at all and the
  // failure is unrecoverable after the response is gone.
  const [row] = await db.select().from(auditExports).where(eq(auditExports.export_date, DATE));
  expect(row).toBeDefined();
  expect(row!.triggered_by).toBe('manual');
  // The FK could not hold this actor, so the row is System-attributed rather than absent.
  expect(row!.actor_id).toBeNull();
});

test('recordAudit still writes the row when the actor has no users row', async () => {
  await recordAudit({
    actorId: ORPHAN_ID,
    action: `${MARK}.probe`,
    category: 'system',
    targetType: 'test',
    targetId: DATE,
    result: 'probe',
    resultTone: 'ok',
    metadata: { probe: true },
  });
  const rows = await db.select().from(auditLog).where(eq(auditLog.action, `${MARK}.probe`));
  expect(rows.length).toBe(1);
  // System-attributed (the FK cannot hold a non-existent user) but the acting subject survives.
  expect(rows[0]!.actor_id).toBeNull();
  expect((rows[0]!.metadata as Record<string, unknown>).actorSub).toBe(ORPHAN_ID);
  // The caller's own metadata is not clobbered by the fallback.
  expect((rows[0]!.metadata as Record<string, unknown>).probe).toBe(true);
});
