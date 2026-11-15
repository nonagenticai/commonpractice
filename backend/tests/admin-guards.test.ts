// tests/admin-guards.test.ts — the authz guards in middleware/admin-guards.ts. The deny/allow
// matrix over an already-hydrated identity (`tenantId` = CP `users.tenant_id`, roles include the
// CP `tenant_role`). Identity is injected via __setAuthOverridesForTests.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { db, tenants } from '../src/db/client';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  requireSuperAdmin,
  requireTenantAdmin,
  requireAnyAdmin,
  requireTenantExists,
  effectiveHomeTenant,
  canonicalTenantId,
  readActiveTenantHeader,
  hasTenantAdmin,
  isSuperAdmin,
} from '../src/middleware/admin-guards';
import { HttpError } from '../src/utils/http';
import { UnauthorizedError, type User } from '../src/types';

const TENANT = '00000000-0000-0000-0000-0000000a9001';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000a9002';

const anon = null; // validateAuth throws for unauthenticated
const member: User = { id: 'u-mem', email: 'm@t', name: 'Mem', roles: ['member'], tenantId: TENANT };
const tenantAdmin: User = { id: 'u-ta', email: 'ta@t', name: 'TA', roles: ['tenant_admin'], tenantId: TENANT };
const superAdmin: User = { id: 'u-sa', email: 'sa@t', name: 'SA', roles: ['super_admin'], tenantId: TENANT };
const tenantAdminNoWorkspace: User = { id: 'u-tanc', email: 'tanc@t', name: 'TANC', roles: ['tenant_admin'] };

function as(u: User | null) {
  __setAuthOverridesForTests({
    validateAuth: async () => {
      if (!u) throw new UnauthorizedError('no auth');
      return u;
    },
  });
}

function req(headers?: Record<string, string>): Request {
  return new Request('http://t/api/whatever', { headers });
}

/** Run a guard and return the HTTP status it would produce (200 if it passed). */
async function status(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    if (e instanceof UnauthorizedError) return e.status;
    throw e;
  }
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  await db.insert(tenants).values({ id: TENANT, name: 'Guard Co', slug: 'guard-co-test' }).onConflictDoNothing();
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, OTHER_TENANT]));
}, 30_000);

// ---- pure role helpers ----

test('isSuperAdmin / hasTenantAdmin: super_admin is a composite of tenant_admin', () => {
  expect(isSuperAdmin(superAdmin)).toBe(true);
  expect(isSuperAdmin(tenantAdmin)).toBe(false);
  expect(hasTenantAdmin(superAdmin)).toBe(true); // composite
  expect(hasTenantAdmin(tenantAdmin)).toBe(true);
  expect(hasTenantAdmin(member)).toBe(false);
});

// ---- requireSuperAdmin ----

test('requireSuperAdmin: anon 401, member 403, tenant_admin 403, super_admin 200', async () => {
  as(anon);        expect(await status(() => requireSuperAdmin(req()))).toBe(401);
  as(member);      expect(await status(() => requireSuperAdmin(req()))).toBe(403);
  as(tenantAdmin); expect(await status(() => requireSuperAdmin(req()))).toBe(403);
  as(superAdmin);  expect(await status(() => requireSuperAdmin(req()))).toBe(200);
});

// ---- requireTenantAdmin (composite) ----

test('requireTenantAdmin: member 403, tenant_admin 200, super_admin 200 (composite)', async () => {
  as(member);      expect(await status(() => requireTenantAdmin(req()))).toBe(403);
  as(tenantAdmin); expect(await status(() => requireTenantAdmin(req()))).toBe(200);
  as(superAdmin);  expect(await status(() => requireTenantAdmin(req()))).toBe(200);
});

test('requireTenantAdmin resolves the effective tenant from the CP home tenant', async () => {
  as(tenantAdmin);
  const ctx = await requireTenantAdmin(req());
  expect(ctx.effectiveTenantId).toBe(TENANT);
});

// ---- fail-closed with no home tenant (no sub fallback) ----

test('requireTenantAdmin fails closed (403 no_workspace) when the caller has no home tenant', async () => {
  as(tenantAdminNoWorkspace);
  const err = await requireTenantAdmin(req()).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(403);
  expect((err as HttpError).code).toBe('no_workspace');
});

test('effectiveHomeTenant throws 403 no_workspace with no home tenant, never fabricates from sub', () => {
  let caught: unknown;
  try {
    effectiveHomeTenant(tenantAdminNoWorkspace);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(403);
  expect((caught as HttpError).code).toBe('no_workspace');
  expect(effectiveHomeTenant(tenantAdmin)).toBe(TENANT);
});

// ---- requireAnyAdmin ----

test('requireAnyAdmin: member 403, tenant_admin 200, super_admin 200', async () => {
  as(member);      expect(await status(() => requireAnyAdmin(req()))).toBe(403);
  as(tenantAdmin); expect(await status(() => requireAnyAdmin(req()))).toBe(200);
  as(superAdmin);  expect(await status(() => requireAnyAdmin(req()))).toBe(200);
});

// ---- requireTenantExists (fail-closed provisioning) ----

test('requireTenantExists: provisioned tenant passes, unknown tenant 403', async () => {
  await requireTenantExists(TENANT); // provisioned → no throw
  expect(await status(() => requireTenantExists(OTHER_TENANT))).toBe(403);
});

// ---- tenant-id CANONICALISATION (the source half of the WS-4 case defect) ----

test('⛔ readActiveTenantHeader canonicalises the UUID it accepts — an uppercase header is the SAME workspace', () => {
  // ⛔ WHY THIS MATTERS AND WHERE IT BIT. `UUID_RE` carries `/i` on purpose (RFC 9562 §4: a UUID is
  // case-insensitive on input), so `A1B2…` is a VALID `X-Active-Tenant-Id` — and the value used to
  // travel through verbatim. Wherever it met a `uuid` COLUMN that was harmless (`eq(tenants.id, …)`
  // and the RLS `app_current_tenant_uuid()` both normalise). The harm was everywhere it met TEXT:
  // `routes/ontology.ts` stamps this exact string into `audit_log.metadata->>'tenantId'` (jsonb
  // text), and `ontology/ontology-changes.ts` compares it as text. Measured through the real route
  // before the fix: an uppercase header returned `{"items":[],"unattributed":0}` — the reader's own
  // "Recent changes" panel blank, with the disclosure reporting that nothing had been hidden.
  //
  // ⚠️ THIS IS THE GUARD FOR THE SOURCE HALF SPECIFICALLY, and it is here because the panel's own
  // suite CANNOT see this layer alone: `ontology-changes.ts` also compares case-insensitively
  // (defence in depth, because `metadata` holds rows written before this function existed), so
  // reverting only the canonicalisation leaves that file 10/10 green. Measured.
  as(superAdmin);
  const upper = '00000000-0000-0000-0000-0000000A9001'.toUpperCase();
  const seen = readActiveTenantHeader(req({ 'X-Active-Tenant-Id': upper }), superAdmin);
  expect(seen, 'the scope header was passed through in the case it arrived in').toBe(
    upper.toLowerCase(),
  );
  // POSITIVE HALF: the header is still HONOURED, not dropped. A guard that returned null would
  // satisfy "not uppercase" and silently retire the whole scope-switch.
  expect(seen, 'canonicalising ate the scope switch').not.toBeNull();
  // …and a canonical header is untouched.
  expect(readActiveTenantHeader(req({ 'X-Active-Tenant-Id': TENANT }), superAdmin)).toBe(TENANT);
});

test('canonicalTenantId lower-cases a UUID and leaves anything else alone', () => {
  expect(canonicalTenantId('00000000-0000-0000-0000-0000000A9001')).toBe(TENANT);
  expect(canonicalTenantId(TENANT)).toBe(TENANT);
  // ⛔ NOT A BLANKET `.toLowerCase()`. `effectiveHomeTenant` does not validate its input, and
  // lower-casing a non-UUID id would be this function quietly inventing a different tenant id.
  // A non-UUID is returned verbatim and fails where it always did — at the `uuid` column.
  expect(canonicalTenantId('NotAUuid-Tenant')).toBe('NotAUuid-Tenant');
});

test('effectiveHomeTenant canonicalises the home tenant too — the other way a stray case gets in', () => {
  const upperHome: User = { ...superAdmin, tenantId: TENANT.toUpperCase() };
  expect(effectiveHomeTenant(upperHome)).toBe(TENANT);
  // Unchanged for the normal case, and still fail-closed with no home tenant (asserted above).
  expect(effectiveHomeTenant(tenantAdmin)).toBe(TENANT);
});
