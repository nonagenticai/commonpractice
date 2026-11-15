// tests/tenant-suspension-gate.test.ts — middleware/tenant-status-gate.ts.
//
// ⛔ WHAT THIS SUITE EXISTS TO STOP COMING BACK. `tenants.status` shipped with the schema and with
// an "Opschorten" button in the operator console, and until this gate landed NOTHING in
// `backend/src` read it for an authorization decision (measured: the only reads were two SELECT
// projections in routes/admin.ts for the platform list). Suspending a workspace flipped a pill,
// returned a green banner, and left every user of that tenant with full access.
//
// EVERY CASE ASSERTS THE ERROR CODE STRING, NEVER A BARE STATUS. `tenant_admin_required`,
// `tenant_scope_mismatch`, `tenant_not_provisioned` and `license_app_mismatch` are all 403s
// reachable from these same call sites, so `toBe(403)` alone would go green while the gate did
// nothing it was written to do.
//
// Harness copied from tests/license-gate.test.ts and tests/admin-authz-matrix.test.ts (real rows
// against the live test DB, `__setAuthOverridesForTests` for identity, the sanctioned narrow cast
// on `config.license`, `__setLicenseClientForTests`, `counterValue` over `renderMetrics`, and the
// explicit 30_000 hook timeouts bun requires).
import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inArray, eq } from 'drizzle-orm';
import { db, tenants, users, auditLog } from '../src/db/client';
import { config } from '../src/config';
import { encryptSecret } from '../src/host/secret-box';
import { validateAuth, __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  requireTenantAdmin,
  requireSuperAdmin,
  requireTenantExists,
} from '../src/middleware/admin-guards';
import { assertTenantNotSuspended } from '../src/middleware/tenant-status-gate';
import {
  __setLicenseClientForTests,
  LicenseClientError,
  type LicenseClient,
} from '../src/services/license-client';
import { registerAdminRoutes } from '../src/routes/admin';
import { Router } from '../src/utils/router';
import { HttpError } from '../src/utils/http';
import { renderMetrics } from '../src/host/metrics';
import type { User } from '../src/types';

const T_SUSPENDED = '00000000-0000-0000-0000-00000f5a0001';
const T_ACTIVE = '00000000-0000-0000-0000-00000f5a0002';
/** A syntactically valid uuid with NO `tenants` row — the `tenant_not_provisioned` case. */
const T_MISSING = '00000000-0000-0000-0000-00000f5a0003';
/**
 * Not a uuid at all. `tenants.id` is a `uuid` column, so a lookup on this raises Postgres 22P02
 * out of the real SELECT — which is how the fail-closed branch gets exercised by a REAL failure of
 * the REAL query rather than by a mock standing in for the database. (utils/http.ts's
 * `isInvalidTextRepr` exists precisely because this is what a malformed uuid does here.)
 */
const T_MALFORMED = 'not-a-tenant-id-at-all';

const U_MEMBER = '00000000-0000-0000-0000-00000f5b0001';
const U_TENANT_ADMIN = '00000000-0000-0000-0000-00000f5b0002';
const U_SUPER = '00000000-0000-0000-0000-00000f5b0003';
const USER_IDS = [U_MEMBER, U_TENANT_ADMIN, U_SUPER];

const TOKEN = 'tok-suspended-A';

// ---- identities -----------------------------------------------------------------------------

const memberOf = (tenantId: string): User => ({
  id: U_MEMBER,
  email: 'member@suspension-test',
  name: 'Member',
  roles: ['member'],
  tenantId,
});
const tenantAdminOf = (tenantId: string): User => ({
  id: U_TENANT_ADMIN,
  email: 'admin@suspension-test',
  name: 'Tenant Admin',
  roles: ['tenant_admin'],
  tenantId,
});
const superAdminOf = (tenantId: string): User => ({
  id: U_SUPER,
  email: 'super@suspension-test',
  name: 'Super Admin',
  roles: ['super_admin'],
  tenantId,
});

/** Install `user` as the identity `authenticateWithoutLicense` resolves. The override is consulted
 *  by the RAW verifier on purpose (see middleware/auth.ts), so the real `validateAuth` still runs
 *  BOTH gates on top of it — which is the entire reason these tests drive it rather than the gate
 *  function directly. */
function asUser(user: User): void {
  __setAuthOverridesForTests({ validateAuth: async () => user });
}

function req(path = '/api/flows', headers: Record<string, string> = {}): Request {
  return new Request(`http://t${path}`, { headers });
}

/** The refusal CODE a call produces, or null when it resolved. Never a bare status — see the
 *  header note: four other guards on these paths also answer 403. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof HttpError) return e.code;
    throw e;
  }
}

/** The refusal STATUS, asserted alongside the code and never instead of it. */
async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
}

/** Current value of a counter in the process registry (0 when never bumped). Copied verbatim from
 *  tests/license-gate.test.ts — `renderMetrics` prefixes every name with `commonpractice_`. */
function counterValue(name: string): number {
  const m = new RegExp(`^\\w*${name} (\\d+)$`, 'm').exec(renderMetrics());
  return m ? Number(m[1]) : 0;
}

/** The repo's sanctioned narrow cast for flipping one config knob (tests/license-gate.test.ts:54).
 *  `enforceGate2` is evaluated at module-const time from LICENSE_GATE_2_ENABLED, so mutating the
 *  env after import does nothing — this is the only way to force Gate 2 on. */
function setGate2(on: boolean): void {
  (config.license as { enforceGate2: boolean }).enforceGate2 = on;
}

/** A licences service that is DOWN — every introspect throws, so Gate 2 fails closed with
 *  `402 license_unavailable`. This is what makes the ordering test discriminate. */
const licensesDown: LicenseClient = {
  async introspect() {
    throw new LicenseClientError(503, 'licences service down');
  },
};

/** Audit rows must go BEFORE the users they reference: `audit_log.actor_id` is an FK with no
 *  cascade, and both the super_admin scope-switch and `patchTenant` write one. */
async function cleanup(): Promise<void> {
  await db.delete(auditLog).where(inArray(auditLog.actor_id, USER_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.delete(tenants).where(inArray(tenants.id, [T_SUSPENDED, T_ACTIVE]));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS (see the long note in
// tests/license-provisioning.test.ts), so a slow one fails as "(unnamed) [5003ms]" with no cause.
beforeEach(async () => {
  await db
    .insert(tenants)
    .values([
      { id: T_SUSPENDED, name: 'Suspended Co', slug: 'suspended-gate-test' },
      { id: T_ACTIVE, name: 'Active Co', slug: 'active-gate-test' },
    ])
    .onConflictDoNothing({ target: tenants.id });
  // Re-assert both rows even if they survived a prior test — one case below REACTIVATES
  // T_SUSPENDED, and every other case depends on it being suspended.
  //
  // The suspended tenant deliberately HOLDS a licence token: the ordering test needs Gate 2 to get
  // as far as introspecting, so that a WRONG ordering answers `license_unavailable`. A token-less
  // tenant would answer `license_required` without ever calling the fake, which is a weaker
  // discriminator and would not prove the fake was wired at all.
  await db
    .update(tenants)
    .set({ status: 'suspended', license_token_encrypted: encryptSecret(TOKEN) })
    .where(eq(tenants.id, T_SUSPENDED));
  await db
    .update(tenants)
    .set({ status: 'active', license_token_encrypted: encryptSecret(TOKEN) })
    .where(eq(tenants.id, T_ACTIVE));
  // Real actor rows so `recordAudit` (fired by the scope-switch and by patchTenant) resolves a
  // user instead of taking its orphan-actor fallback.
  await db
    .insert(users)
    .values([
      { id: U_MEMBER, email: 'member@suspension-test', name: 'Member', tenant_id: T_SUSPENDED },
      {
        id: U_TENANT_ADMIN,
        email: 'admin@suspension-test',
        name: 'Tenant Admin',
        tenant_id: T_SUSPENDED,
      },
      { id: U_SUPER, email: 'super@suspension-test', name: 'Super Admin', tenant_id: T_ACTIVE },
    ])
    .onConflictDoNothing({ target: users.id });
  setGate2(false); // the F.1 prod/CI default; the ordering tests flip it on explicitly
  __setLicenseClientForTests(undefined);
}, 30_000);

afterEach(() => {
  __setAuthOverridesForTests(undefined);
});

afterAll(async () => {
  setGate2(false);
  __setLicenseClientForTests(undefined);
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1-2. THE GATE ITSELF — the two guard entry points a tenant user actually arrives through.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a MEMBER of a suspended tenant is refused by validateAuth → 403 tenant_suspended', async () => {
  asUser(memberOf(T_SUSPENDED));
  expect(await codeOf(() => validateAuth(req()))).toBe('tenant_suspended');
  expect(await statusOf(() => validateAuth(req()))).toBe(403);
});

test('a TENANT_ADMIN of a suspended tenant is refused by requireTenantAdmin → 403 tenant_suspended', async () => {
  // NOT `tenant_admin_required` and NOT `tenant_scope_mismatch`: the caller genuinely holds the
  // role and genuinely targets their own tenant. The WORKSPACE is what is refused.
  asUser(tenantAdminOf(T_SUSPENDED));
  expect(await codeOf(() => requireTenantAdmin(req()))).toBe('tenant_suspended');
  expect(await statusOf(() => requireTenantAdmin(req()))).toBe(403);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. NEGATIVE CONTROL — an ACTIVE tenant is untouched. Kills the "deny everyone" mutation, which
//    otherwise passes tests 1 and 2 perfectly.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: a member of an ACTIVE tenant resolves normally', async () => {
  asUser(memberOf(T_ACTIVE));
  const user = await validateAuth(req());
  expect(user.tenantId).toBe(T_ACTIVE);
});

test('NEGATIVE CONTROL: a tenant_admin of an ACTIVE tenant resolves through requireTenantAdmin', async () => {
  asUser(tenantAdminOf(T_ACTIVE));
  const ctx = await requireTenantAdmin(req());
  expect(ctx.effectiveTenantId).toBe(T_ACTIVE);
  expect(ctx.isSuperAdmin).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. NEGATIVE CONTROL — SUSPENSION IS NOT A ONE-WAY TRAP.
//    Kills the mutation that drops the `isSuperAdmin` early return. An operator scope-switched
//    into the suspended workspace must still reach it AND be able to reactivate it; otherwise
//    "Opschorten" is a button that locks out the only person who can undo it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: a super_admin acting INTO the suspended tenant resolves', async () => {
  asUser(superAdminOf(T_ACTIVE));
  const headers = { 'X-Active-Tenant-Id': T_SUSPENDED };
  const user = await validateAuth(req('/api/flows', headers));
  expect(user.roles).toContain('super_admin');
  // …and through the tenant-scoped guard the operator console's tenant screens actually use.
  const ctx = await requireTenantAdmin(req('/api/flows', headers));
  expect(ctx.effectiveTenantId).toBe(T_SUSPENDED);
  expect(ctx.scopeSwitched).toBe(true);
});

test('NEGATIVE CONTROL: requireSuperAdmin — the guard patchTenant uses — is reachable while suspended', async () => {
  asUser(superAdminOf(T_SUSPENDED)); // the operator's OWN claim is the suspended tenant
  const user = await requireSuperAdmin(req('/api/tenants'));
  expect(user.id).toBe(U_SUPER);
});

test("NEGATIVE CONTROL: PATCH /api/tenants/:id {status:'active'} SUCCEEDS while the tenant is suspended", async () => {
  asUser(superAdminOf(T_ACTIVE));
  const router = new Router();
  registerAdminRoutes(router);
  const matched = router.match('PATCH', `/api/tenants/${T_SUSPENDED}`);
  expect(matched).not.toBeNull();

  const res = await matched!.handler(
    new Request(`http://t/api/tenants/${T_SUSPENDED}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    }),
    ...matched!.params,
  );
  expect(res.status).toBe(200);

  // Assert the STORED state, not the response body — the point is that the reactivation landed.
  const [row] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, T_SUSPENDED));
  expect(row?.status).toBe('active');

  // …and the workspace's own users are unblocked immediately, with no restart and no cache to
  // expire (there is deliberately no process-level TTL cache — see the gate's Decision 2).
  asUser(memberOf(T_SUSPENDED));
  expect(await codeOf(() => validateAuth(req()))).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. FAIL-CLOSED — the lookup throwing DENIES, with its own code, and is COUNTED.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('⛔ FAIL-CLOSED: a lookup that throws → 503 tenant_status_unavailable, never a pass-through', async () => {
  expect(await statusOf(() => assertTenantNotSuspended(T_MALFORMED))).toBe(503);
  expect(await codeOf(() => assertTenantNotSuspended(T_MALFORMED))).toBe(
    'tenant_status_unavailable',
  );
});

test('⛔ FAIL-CLOSED: the code is NOT tenant_suspended — an outage must not accuse a customer', async () => {
  // Collapsing the two would tell a paying customer their workspace had been suspended because a
  // connection pool was busy. The whole fail-closed argument rests on them being tellable apart.
  expect(await codeOf(() => assertTenantNotSuspended(T_MALFORMED))).not.toBe('tenant_suspended');
});

test('⛔ FAIL-CLOSED: deleting the try/catch does not go green either (it would 400, not 503)', async () => {
  // Without the catch, the raw 22P02 escapes and route() maps it to `400 invalid_input`
  // (utils/http.ts isInvalidTextRepr) — a client error, on an authorization failure. Pinned
  // explicitly so the mutation is named rather than merely failing an unrelated assertion.
  expect(await codeOf(() => assertTenantNotSuspended(T_MALFORMED))).not.toBe('invalid_input');
});

test('⛔ FAIL-CLOSED: the failure is COUNTED (tenant_status_lookup_failures_total)', async () => {
  // Mandatory, not decorative: this gate runs on 100% of tenant-facing requests, so a dashboard is
  // the only place anyone would see it failing. Deleting the incCounter must red.
  const before = counterValue('tenant_status_lookup_failures_total');
  await codeOf(() => assertTenantNotSuspended(T_MALFORMED));
  expect(counterValue('tenant_status_lookup_failures_total')).toBe(before + 1);
});

test('NON-VACUITY: a HEALTHY lookup does NOT bump the failure counter', async () => {
  // Without this, an `incCounter` hoisted to the top of the function satisfies the test above
  // while making the counter mean nothing.
  const before = counterValue('tenant_status_lookup_failures_total');
  await assertTenantNotSuspended(T_ACTIVE);
  expect(counterValue('tenant_status_lookup_failures_total')).toBe(before);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. A MISSING ROW IS SOMEBODY ELSE'S ERROR.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a tenant with NO row is not this gate\'s error — requireTenantExists still owns it', async () => {
  // The gate itself says nothing…
  expect(await codeOf(() => assertTenantNotSuspended(T_MISSING))).toBeNull();
  // …and the pre-existing refusal is unchanged: `tenant_not_provisioned`, NOT `tenant_suspended`.
  // Answering suspension for a workspace that was never created would mask a provisioning fault
  // behind a commercial-sounding one, and send an operator hunting for who suspended it.
  expect(await codeOf(() => requireTenantExists(T_MISSING))).toBe('tenant_not_provisioned');
});

test('the match is the LITERAL "suspended" — an active row passes, with no truthiness test', async () => {
  // Pins the "never `!== \'active\'`" decision: `tenant_status` is a pgEnum and enums grow, so a
  // future member must be a deliberate decision rather than an automatic fleet-wide lockout.
  expect(await codeOf(() => assertTenantNotSuspended(T_ACTIVE))).toBeNull();
  expect(await codeOf(() => assertTenantNotSuspended(T_SUSPENDED))).toBe('tenant_suspended');
});

test('no resolved tenant → the gate is a no-op (the route guard 401s, not this)', async () => {
  expect(await codeOf(() => assertTenantNotSuspended(null))).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 7. ⛔ THE ORDERING MUTATION.
//    Moving `assertTenantActive` to AFTER `licenseCallerTenant` in validateAuth passes EVERY test
//    above. It is not cosmetic: `routes/admin.ts patchTenant` calls `revokeTenantLicense` on
//    suspend, so once issuance + Gate 2 are both on, a suspended tenant is ALSO an unlicensed one
//    and the loser of that race is the message the customer reads. Gate 2 first says `license_*` —
//    "your workspace has no active licence, renew" — about a licence that did not expire and that
//    the customer cannot renew. The suspension is the CAUSE; it must win.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('⛔ ORDERING: Gate 2 ON + licences service DOWN → a suspended tenant still gets tenant_suspended', async () => {
  setGate2(true);
  __setLicenseClientForTests(licensesDown);
  asUser(memberOf(T_SUSPENDED));
  expect(await codeOf(() => validateAuth(req()))).toBe('tenant_suspended');
  expect(await statusOf(() => validateAuth(req()))).toBe(403);
});

test('⛔ ORDERING NON-VACUITY: the SAME setup on an ACTIVE tenant really does reach Gate 2', async () => {
  // Without this, the test above is green whenever Gate 2 happens to be off — i.e. it passes for
  // the wrong reason and pins nothing at all. This proves the flag was flipped, the fake client
  // was installed, and the licence gate genuinely runs on this request.
  setGate2(true);
  __setLicenseClientForTests(licensesDown);
  asUser(memberOf(T_ACTIVE));
  expect(await codeOf(() => validateAuth(req()))).toBe('license_unavailable');
  expect(await statusOf(() => validateAuth(req()))).toBe(402);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 8. SOURCE RATCHET — validateAuth must CALL the gate, and call it FIRST.
//
//    ⛔ COMMENTS ARE STRIPPED BEFORE MATCHING, AND THAT IS NOT PARANOIA. This repo has already had
//    a source ratchet defeated by a comment: `navConfig.backend-contract.test.ts` records that
//    downgrading `GET /api/audit` from `requireSuperAdmin` to `resolveTenant` and leaving the note
//    `// restore requireSuperAdmin(req) before release` reported GREEN, because a line of English
//    was accepted as enforcement. This file is an especially rich trap — middleware/auth.ts now
//    carries a long comment that NAMES both `assertTenantActive` and `licenseCallerTenant` while
//    explaining their order — so matching raw source here would pass against a validateAuth whose
//    body had been emptied out entirely.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Blank out `//` line comments and block comments, replacing them with spaces so that line count
 * and byte offsets survive (the `indexOf` ordering check below compares positions).
 *
 * A character-scanner rather than three regexes, for the same reason the frontend's `blankOut` is:
 * a regex cannot tell a `//` inside a string literal (`'http://t/api/flows'`) from the start of a
 * comment, and getting that wrong in the CONSERVATIVE direction — blanking real code — would make
 * the ratchet silently vacuous. String literals are left intact; nothing this file asserts on
 * lives inside one.
 */
function blankComments(src: string): string {
  const hollow = (s: string) => s.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const j = src.indexOf('\n', i);
      const end = j === -1 ? src.length : j;
      out += hollow(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j === -1 ? src.length : j + 2;
      out += hollow(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      // Skip the literal wholesale so a `//` inside it is never read as a comment.
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        if (c !== '`' && src[j] === '\n') break; // unterminated — a regex char class, not a string
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function strippedSource(relPath: string): string {
  return blankComments(readFileSync(join(import.meta.dir, relPath), 'utf8'));
}

test('⛔ RATCHET SELF-TEST: the stripper removes comments, keeps code, and preserves offsets', async () => {
  // Every assertion below is only as good as this function. Drive it, do not wait for the bug.
  const LINE = "await assertTenantActive(req, user); // await licenseCallerTenant(req, user);";
  expect(blankComments(LINE)).toContain('await assertTenantActive(req, user);');
  expect(blankComments(LINE)).not.toContain('// await licenseCallerTenant');
  // A `//` inside a string literal must NOT be treated as a comment.
  const STR = "const u = 'http://t/api/flows'; const keep = 1;";
  expect(blankComments(STR)).toContain('const keep = 1;');
  // Offsets and newlines survive, so the indexOf ordering check is trustworthy.
  const MULTI = "const a = 1; /* x\ny */ const b = 2; // z\nconst c = 3;\n";
  expect(blankComments(MULTI)).toHaveLength(MULTI.length);
  expect(blankComments(MULTI).split('\n')).toHaveLength(MULTI.split('\n').length);
});

test('RATCHET: middleware/auth.ts validateAuth calls the tenant-status gate (comments stripped)', async () => {
  const src = strippedSource('../src/middleware/auth.ts');

  // NON-VACUITY OF THE STRIPPING, against strings that really are in that file's comments today.
  // If either survives, the stripper did nothing and every match below is worthless.
  expect(src).not.toContain('revokeTenantLicense');
  expect(src).not.toContain('THE WHOLE POINT');

  expect(src).toContain("from './tenant-status-gate'");
  expect(src).toContain('assertTenantActive(req, user)');
});

test('⛔ RATCHET: the gate call precedes licenseCallerTenant inside validateAuth (comments stripped)', async () => {
  const src = strippedSource('../src/middleware/auth.ts');
  const body = src.slice(src.indexOf('export async function validateAuth'));
  expect(body.length).toBeGreaterThan(0);
  const gateAt = body.indexOf('assertTenantActive(req, user)');
  const licenceAt = body.indexOf('licenseCallerTenant(req, user)');
  expect(gateAt).toBeGreaterThan(-1);
  expect(licenceAt).toBeGreaterThan(-1);
  expect(gateAt).toBeLessThan(licenceAt);
});

test('RATCHET: the no-JWT routes gate their resolved tenant (comments stripped)', async () => {
  // routes/agent.ts and routes/mcp.ts never reach validateAuth — they authenticate with an
  // agent-session token / an MCP API key / AUTH_BYPASS. Without these calls a suspended tenant
  // keeps the entire copilot and the entire MCP tool surface while every browser route 403s.
  for (const rel of ['../src/routes/agent.ts', '../src/routes/mcp.ts']) {
    const src = strippedSource(rel);
    expect(src, `${rel} must import the gate`).toContain(
      "from '../middleware/tenant-status-gate'",
    );
    expect(src, `${rel} must call the gate`).toContain('assertTenantNotSuspended(');
  }
});
