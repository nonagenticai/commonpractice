// tests/sso.test.ts — Phase 4 / E.1: per-tenant Entra OIDC SSO (routes/sso.ts + sso-service.ts).
//
// Exercises the LIVE routes against the :5433 CI postgres, identity injected via
// __setAuthOverridesForTests and the Keycloak admin client replaced by an injected FAKE that
// records the IdP + mapper calls. Proves the load-bearing behaviours:
//   • KC-first chain: createIdentityProvider → the attribute mappers → the CP mirror row.
//   • TENANT BINDING (Part 8.6): the alias == entra-<own-slug> EVEN when the body smuggles another
//     tenant/alias, and NO tenant_id / role mapper is authored in the shared realm — a brokered
//     first login is seated by CP (services/cp-identity.ts) from the alias → identity_providers row.
//   • Secret hygiene: the Entra client_secret is never returned by a read; stored encrypted.
//   • Scope: a tenant_admin can't act on another tenant (403/404); super_admin platform overview
//     reads across tenants (runAsSystem); a tenant_admin is denied the platform overview (403).
//   • KC write failure is fatal (502) and writes no CP row; a second create is a 409.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray, eq, sql } from 'drizzle-orm';
import { db, tenants, users, identityProviders, auditLog } from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerSsoRoutes } from '../src/routes/sso';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  __setKeycloakAdminForTests,
  KeycloakAdminError,
  type KeycloakAdminClient,
  type IdpRepresentation,
  type IdpMapperRepresentation,
} from '../src/services/keycloak-admin';
import { decryptSecret } from '../src/host/secret-box';
import type { User } from '../src/types';

const TENANT = '00000000-0000-4000-8000-00000000e101';
const OTHER_TENANT = '00000000-0000-4000-8000-00000000e102';
const TADMIN_ID = '00000000-0000-4000-8000-00000000e110';
const SADMIN_ID = '00000000-0000-4000-8000-00000000e120';
const TENANT_IDS = [TENANT, OTHER_TENANT];
const ACTOR_IDS = [TADMIN_ID, SADMIN_ID];
const A_SLUG = 'acme-e1';
const A_ALIAS = `entra-${A_SLUG}`;
const GUID = '11111111-2222-3333-4444-555555555555';
const SECRET = 'super-secret-entra-value';

const tenantAdmin: User = {
  id: TADMIN_ID, email: 'ta-e1@t', name: 'TA', roles: ['employee', 'tenant_admin'], tenantId: TENANT,
};
const superAdmin: User = {
  id: SADMIN_ID, email: 'sa-e1@t', name: 'SA', roles: ['super_admin'], tenantId: TENANT,
};

// ---- fake Keycloak admin client (records IdP + mapper calls) ----
interface KcCall { op: string; args: unknown[] }
function makeKc(opts: { idpThrows?: Error } = {}): { kc: KeycloakAdminClient; calls: KcCall[] } {
  const calls: KcCall[] = [];
  const noop = async () => {};
  const kc: KeycloakAdminClient = {
    createRealmUser: async () => 'x',
    logoutUser: noop,
    executeActionsEmail: noop,
    deleteRealmUser: noop,
    listRealmUsers: async () => [],
    findRealmUserByUsernameOrEmail: async () => null,
    backfillUserEmail: noop,
    getRealmRolesForUsers: async (ids) => new Map(ids.map((u) => [u, []])),
    async createIdentityProvider(rep: IdpRepresentation) {
      calls.push({ op: 'createIdentityProvider', args: [rep] });
      if (opts.idpThrows) throw opts.idpThrows;
    },
    getIdentityProvider: async () => null,
    async updateIdentityProvider(alias, rep) {
      calls.push({ op: 'updateIdentityProvider', args: [alias, rep] });
    },
    async deleteIdentityProvider(alias) {
      calls.push({ op: 'deleteIdentityProvider', args: [alias] });
    },
    async createIdpMapper(alias: string, mapper: IdpMapperRepresentation) {
      calls.push({ op: 'createIdpMapper', args: [alias, mapper] });
    },
    listIdpMappers: async () => [],
    async deleteIdpMapper(alias, mapperId) {
      calls.push({ op: 'deleteIdpMapper', args: [alias, mapperId] });
    },
  };
  return { kc, calls };
}

const router = new Router();
registerSsoRoutes(router);

let currentUser: User | null = tenantAdmin;
function as(u: User | null) { currentUser = u; }

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const m = router.match(method, path.split('?')[0]!);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  return m.handler(
    new Request(`http://t${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ...m.params,
  );
}

async function cleanup() {
  await db.delete(auditLog).where(inArray(auditLog.actor_id, ACTOR_IDS));
  await db.delete(identityProviders).where(inArray(identityProviders.tenant_id, TENANT_IDS));
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, ACTOR_IDS));
  await db.delete(users).where(inArray(users.id, ACTOR_IDS));
  await db.delete(tenants).where(inArray(tenants.id, TENANT_IDS));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setAuthOverridesForTests({
    validateAuth: async () => {
      if (!currentUser) {
        const { UnauthorizedError } = await import('../src/types');
        throw new UnauthorizedError('no auth');
      }
      return currentUser;
    },
  });
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT, name: 'Acme E1', slug: A_SLUG },
    { id: OTHER_TENANT, name: 'Beta E1', slug: 'beta-e1' },
  ]).onConflictDoNothing({ target: tenants.id });
  // The audit_log.actor_id FK → users requires the acting admins to exist.
  await db.insert(users).values([
    { id: TADMIN_ID, email: tenantAdmin.email, name: tenantAdmin.name, tenant_id: TENANT },
    { id: SADMIN_ID, email: superAdmin.email, name: superAdmin.name, tenant_id: TENANT },
  ]).onConflictDoNothing({ target: users.id });
  __setKeycloakAdminForTests(makeKc().kc);
  as(tenantAdmin);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  await cleanup();
}, 30_000);

const validBody = () => ({ entraTenantGuid: GUID, clientId: 'app-client-id', clientSecret: SECRET });

// ---- create: KC-first chain + tenant binding ----

test('create: KC-first chain (createIdentityProvider → attribute mappers) then the CP mirror row + audit', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/sso/providers`, validBody());
  expect(res.status).toBe(201);

  // IdP created FIRST, then the three attribute importers (email / given / family name).
  expect(calls[0]!.op).toBe('createIdentityProvider');
  const mapperOps = calls.filter((c) => c.op === 'createIdpMapper');
  expect(mapperOps.length).toBe(3);
  const idpRep = calls[0]!.args[0] as IdpRepresentation;
  expect(idpRep.alias).toBe(A_ALIAS);
  expect(idpRep.providerId).toBe('oidc');

  // The CP mirror row exists, scoped to TENANT.
  const [row] = await db.select().from(identityProviders).where(eq(identityProviders.tenant_id, TENANT));
  expect(row?.alias).toBe(A_ALIAS);

  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'idp.create'));
  expect(audits.length).toBe(1);
});

test('TENANT BINDING: alias is entra-<own-slug> even if the body smuggles another tenant/alias; no tenant or role mapper is authored', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  // Attacker echoes a foreign tenantId + alias; both must be ignored (stripped / backend-derived).
  const res = await call('POST', `/api/tenants/${TENANT}/sso/providers`, {
    ...validBody(),
    tenantId: OTHER_TENANT,
    alias: 'entra-beta-e1',
  });
  expect(res.status).toBe(201);

  // The realm is shared with fr: CP authors no hardcoded tenant_id attribute and no role mapper.
  const mappers = calls
    .filter((c) => c.op === 'createIdpMapper')
    .map((c) => c.args[1] as IdpMapperRepresentation);
  for (const m of mappers) {
    expect(m.identityProviderMapper).not.toBe('hardcoded-attribute-idp-mapper');
    expect(m.identityProviderMapper).not.toBe('hardcoded-role-idp-mapper');
    expect(m.config.attribute).not.toBe('tenant_id');
    expect(JSON.stringify(m.config)).not.toContain(TENANT);
    expect(JSON.stringify(m.config)).not.toContain(OTHER_TENANT);
  }

  // The IdP alias is derived from the OWN slug, never the smuggled one — and the alias is what
  // binds a brokered login to this tenant (identity_providers row).
  const idpRep = calls[0]!.args[0] as IdpRepresentation;
  expect(idpRep.alias).toBe(A_ALIAS); // NOT entra-beta-e1
  const [row] = await db.select().from(identityProviders).where(eq(identityProviders.tenant_id, TENANT));
  expect(row?.tenant_id).toBe(TENANT);
  expect(row?.alias).toBe(A_ALIAS);
});

test('create: a second IdP for the same tenant is a 409 (one Entra IdP per tenant)', async () => {
  __setKeycloakAdminForTests(makeKc().kc);
  expect((await call('POST', `/api/tenants/${TENANT}/sso/providers`, validBody())).status).toBe(201);
  expect((await call('POST', `/api/tenants/${TENANT}/sso/providers`, validBody())).status).toBe(409);
});

test('create: a Keycloak write failure is 502 and writes NO CP row', async () => {
  const { kc } = makeKc({ idpThrows: new KeycloakAdminError(500, 'kc down') });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/sso/providers`, validBody());
  expect(res.status).toBe(502);
  const rows = await db.select().from(identityProviders).where(eq(identityProviders.tenant_id, TENANT));
  expect(rows.length).toBe(0);
});

// ---- secret hygiene ----

test('secret hygiene: the client_secret is never returned by a read; stored encrypted', async () => {
  __setKeycloakAdminForTests(makeKc().kc);
  const created = await (await call('POST', `/api/tenants/${TENANT}/sso/providers`, validBody())).json() as {
    provider: Record<string, unknown>;
  };
  // The create response carries no secret, but flags that one is set.
  expect(JSON.stringify(created.provider)).not.toContain(SECRET);
  expect(created.provider.hasSecret).toBe(true);
  expect(created.provider.redirectUri).toContain(`/broker/${A_ALIAS}/endpoint`);

  // The GET list response carries no secret either.
  const list = await (await call('GET', `/api/tenants/${TENANT}/sso/providers`)).json() as {
    providers: Record<string, unknown>[];
  };
  expect(JSON.stringify(list.providers)).not.toContain(SECRET);

  // At rest the column is a secret-box blob (not plaintext) that decrypts back to the secret.
  const [row] = await db.select().from(identityProviders).where(eq(identityProviders.tenant_id, TENANT));
  expect(row?.client_secret_encrypted).toBeTruthy();
  expect(row?.client_secret_encrypted).not.toBe(SECRET);
  expect(decryptSecret(row!.client_secret_encrypted!)).toBe(SECRET);
});

// ---- scope ----

test('scope: a tenant_admin of A cannot act on tenant B (path mismatch → 403)', async () => {
  __setKeycloakAdminForTests(makeKc().kc);
  const res = await call('POST', `/api/tenants/${OTHER_TENANT}/sso/providers`, validBody());
  expect(res.status).toBe(403);
});

test('scope: PATCH/DELETE of an IdP belonging to another tenant → 404', async () => {
  // Seed an IdP under OTHER_TENANT directly.
  const [other] = await db.insert(identityProviders).values({
    tenant_id: OTHER_TENANT, alias: 'entra-beta-e1', display_name: 'Beta',
    config: { discovery_url: 'https://x/.well-known', client_id: 'c', scopes: 'openid', trust_email: true },
    client_secret_encrypted: null,
  }).returning();
  __setKeycloakAdminForTests(makeKc().kc);
  // The tenant_admin of A targets B's IdP id but via A's path → not found in A.
  const patch = await call('PATCH', `/api/tenants/${TENANT}/sso/providers/${other!.id}`, { enabled: false });
  expect(patch.status).toBe(404);
  const del = await call('DELETE', `/api/tenants/${TENANT}/sso/providers/${other!.id}`);
  expect(del.status).toBe(404);
});

// ---- platform overview ----

test('platform overview: super_admin lists IdPs across tenants; tenant_admin is denied (403)', async () => {
  // One IdP in each tenant.
  await db.insert(identityProviders).values([
    { tenant_id: TENANT, alias: A_ALIAS, display_name: 'Acme',
      config: { discovery_url: 'https://a/.well-known', client_id: 'a', scopes: 'openid', trust_email: true } },
    { tenant_id: OTHER_TENANT, alias: 'entra-beta-e1', display_name: 'Beta',
      config: { discovery_url: 'https://b/.well-known', client_id: 'b', scopes: 'openid', trust_email: true } },
  ]);

  as(tenantAdmin);
  expect((await call('GET', '/api/admin/sso/providers')).status).toBe(403);

  as(superAdmin);
  const res = await call('GET', '/api/admin/sso/providers');
  expect(res.status).toBe(200);
  const body = await res.json() as { providers: { tenantId: string; tenantName?: string }[] };
  const tenantsSeen = new Set(body.providers.map((p) => p.tenantId));
  expect(tenantsSeen.has(TENANT)).toBe(true);
  expect(tenantsSeen.has(OTHER_TENANT)).toBe(true);
  expect(JSON.stringify(body.providers)).not.toContain(SECRET);

  // ⛔ THE OVERVIEW CARRIES THE TENANT **NAME**, NOT JUST THE ID. `/sso-overview` rendered
  // `p.tenantId` — a raw UUID — in the column that is the entire reason the screen exists.
  // `listAllIdps` now leftJoins `tenants`, so the name arrives with the row.
  //
  // ⛔ THE `not.toBe(tenantId)` HALF IS LOAD-BEARING, DO NOT DROP IT. Without it a lazy
  // implementation (`tenantName: row.tenant_id`, or the client-side fallback `(tenant)/sso`
  // already ships) satisfies "tenantName is defined" and passes this test while putting the
  // same unreadable UUID back on the screen.
  const byTenant = new Map(body.providers.map((p) => [p.tenantId, p]));
  for (const [id, name] of [[TENANT, 'Acme E1'], [OTHER_TENANT, 'Beta E1']] as const) {
    const p = byTenant.get(id)!;
    expect(p.tenantName).toBe(name);
    expect(p.tenantName).not.toBe(p.tenantId);
  }
});

// ⛔ THE LEFT HALF OF `listAllIdps`' leftJoin — THE ORPHAN ROW. This case exists because the
// source comment on that join used to justify itself with "it is not reachable to seed", which is
// FALSE: `identity_providers_tenant_id_fkey` is a plain constraint, and dropping it for the length
// of one insert seeds the orphan in two statements. What the join actually buys is measured here:
// the platform's list of every broker does NOT become silently conditional on that FK holding.
//
// The three halves, and all three matter:
//   • the orphan row IS RETURNED (count === before + 1) — an INNER join loses it entirely, which
//     is the failure this join shape exists to prevent, and it is silent;
//   • its `tenantName` is UNDEFINED, not the string "null", not the uuid — that is what makes the
//     frontend's `?? p.tenantId` fallback the thing that runs;
//   • every OTHER row still carries its name — a left join that spilled a null across the result
//     would satisfy the first two assertions on its own.
//
// The constraint is restored in the same test rather than left dropped, so a failure here cannot
// leak a broken schema into the files that run after this one.
test('platform overview: an orphaned IdP (no tenants row) is still listed, with no tenantName', async () => {
  const ORPHAN_TENANT = '00000000-0000-4000-8000-00000000e1ff';
  await db.insert(identityProviders).values([
    { tenant_id: TENANT, alias: A_ALIAS, display_name: 'Acme',
      config: { discovery_url: 'https://a/.well-known', client_id: 'a', scopes: 'openid', trust_email: true } },
  ]);

  as(superAdmin);
  const before = await (await call('GET', '/api/admin/sso/providers')).json() as {
    providers: { tenantId: string; tenantName?: string }[];
  };

  await db.execute(
    sql`ALTER TABLE identity_providers DROP CONSTRAINT identity_providers_tenant_id_fkey`,
  );
  try {
    await db.insert(identityProviders).values([
      { tenant_id: ORPHAN_TENANT, alias: 'entra-orphan-e1', display_name: 'Orphan',
        config: { discovery_url: 'https://o/.well-known', client_id: 'o', scopes: 'openid', trust_email: true } },
    ]);
    // The tenant really is absent — otherwise the join would find a name and this is vacuous.
    const [t] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM tenants WHERE id = ${ORPHAN_TENANT}`,
    )) as unknown as { n: number }[];
    expect(Number(t!.n), 'the orphan tenant exists — nothing is orphaned').toBe(0);

    const after = await (await call('GET', '/api/admin/sso/providers')).json() as {
      providers: { tenantId: string; tenantName?: string }[];
    };
    // 1. THE ROW SURVIVES. This is the assertion an INNER join fails.
    expect(after.providers.length).toBe(before.providers.length + 1);
    const orphan = after.providers.find((p) => p.tenantId === ORPHAN_TENANT);
    expect(orphan, 'the orphaned IdP was dropped from the platform overview').toBeDefined();
    // 2. No name, and specifically not the uuid dressed up as one.
    expect(orphan!.tenantName).toBeUndefined();
    expect(orphan!.tenantName).not.toBe(ORPHAN_TENANT);
    // 3. THE POSITIVE HALF — the named rows are untouched by the orphan's presence.
    const named = after.providers.find((p) => p.tenantId === TENANT);
    expect(named!.tenantName).toBe('Acme E1');
  } finally {
    await db.delete(identityProviders).where(eq(identityProviders.tenant_id, ORPHAN_TENANT));
    await db.execute(
      sql`ALTER TABLE identity_providers
          ADD CONSTRAINT identity_providers_tenant_id_fkey
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`,
    );
  }
  // The schema really is back — a later file inheriting a missing FK would fail somewhere else.
  const [c] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'identity_providers'::regclass
          AND conname = 'identity_providers_tenant_id_fkey'`,
  )) as unknown as { n: number }[];
  expect(Number(c!.n), 'the FK was not restored — later test files will fail for the wrong reason').toBe(1);
});

// ---- update ----

test('update: toggles enabled + re-PUTs the IdP to Keycloak (mappers untouched)', async () => {
  __setKeycloakAdminForTests(makeKc().kc);
  const created = await (await call('POST', `/api/tenants/${TENANT}/sso/providers`, validBody())).json() as {
    provider: { id: string };
  };
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('PATCH', `/api/tenants/${TENANT}/sso/providers/${created.provider.id}`, { enabled: false });
  expect(res.status).toBe(200);
  const body = await res.json() as { provider: { enabled: boolean } };
  expect(body.provider.enabled).toBe(false);
  expect(calls.some((c) => c.op === 'updateIdentityProvider')).toBe(true);
  expect(calls.some((c) => c.op === 'createIdpMapper')).toBe(false); // mappers not re-authored
});

// ---- SSO first login: seated by CP from the idp_alias claim (services/cp-identity.ts) ----

const JIT_SUB = '00000000-0000-4000-8000-00000000e130';

async function cleanupJit() {
  await db.delete(auditLog).where(eq(auditLog.target_id, JIT_SUB));
  await db.update(users).set({ tenant_id: null }).where(eq(users.id, JIT_SUB));
  await db.delete(users).where(eq(users.id, JIT_SUB));
}

function brokered(alias: string, extraRoles: string[] = []): User {
  // A token's tenant role / tenant_id claim is never honoured; pass them to prove it.
  return {
    id: JIT_SUB, email: 'jit-e1@acme.test', name: 'JIT', roles: [...extraRoles], tenantId: OTHER_TENANT,
    emailVerified: true, idpAlias: alias,
  };
}

test('SSO first login: a brokered user with an enabled alias is seated as member of the tenant that owns it', async () => {
  await cleanupJit();
  await db.insert(identityProviders).values({
    tenant_id: TENANT, alias: A_ALIAS, display_name: 'Acme', enabled: true,
    config: { discovery_url: 'https://a/.well-known', client_id: 'a', scopes: 'openid', trust_email: true },
  });
  try {
    const { hydrateCpIdentity } = await import('../src/services/cp-identity');
    const u = await hydrateCpIdentity(brokered(A_ALIAS, ['tenant_admin']));
    expect(u.tenantId).toBe(TENANT); // NOT the claim's OTHER_TENANT
    expect(u.tenantRole).toBe('member');
    expect(u.roles).toContain('member');
    expect(u.roles).not.toContain('tenant_admin'); // the realm role is not honoured

    const [row] = await db.select().from(users).where(eq(users.id, JIT_SUB));
    expect(row?.tenant_id).toBe(TENANT);
    expect(row?.tenant_role).toBe('member');
  } finally {
    await cleanupJit();
  }
});

test('SSO first login: a disabled or unknown alias seats nobody (no workspace, no CP row)', async () => {
  await cleanupJit();
  await db.insert(identityProviders).values({
    tenant_id: TENANT, alias: A_ALIAS, display_name: 'Acme', enabled: false,
    config: { discovery_url: 'https://a/.well-known', client_id: 'a', scopes: 'openid', trust_email: true },
  });
  try {
    const { hydrateCpIdentity } = await import('../src/services/cp-identity');
    for (const alias of [A_ALIAS, 'entra-nobody-e1']) {
      const u = await hydrateCpIdentity(brokered(alias));
      expect(u.tenantId).toBeUndefined();
      expect(u.tenantRole).toBeUndefined();
    }
    const rows = await db.select().from(users).where(eq(users.id, JIT_SUB));
    expect(rows.length).toBe(0);
  } finally {
    await cleanupJit();
  }
});
