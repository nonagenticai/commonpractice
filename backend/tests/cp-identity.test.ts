// tests/cp-identity.test.ts — Keycloak authenticates, CP authorizes, through the REAL token path.
//
// Real RS256 tokens are minted with jose and verified by the production `keycloak` singleton (its
// JWKS swapped for a local key set), then hydrated by `authenticateWithoutLicense` →
// `hydrateCpIdentity`. No auth override is installed, so what is asserted here is what a browser
// request gets: the `tenant_id` claim and the realm tenant roles mean nothing; `users.tenant_id` /
// `users.tenant_role` decide the workspace and the role; the `super_admin` realm role survives.
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { inArray } from 'drizzle-orm';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from 'jose';
import { db, users, tenants } from '../src/db/client';
import { config } from '../src/config';
import { keycloak } from '../src/services/keycloak';
import { authenticateWithoutLicense } from '../src/middleware/auth';
import { __resetCpIdentityForTests } from '../src/services/cp-identity';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { registerMeRoutes } from '../src/routes/me';

const KID = 'cp-identity-test-key';
const TENANT_A = '00000000-0000-4000-8000-0000c1d70a01'; // what the CLAIM says
const TENANT_B = '00000000-0000-4000-8000-0000c1d70b01'; // what CP's row says
const NO_ROW = '00000000-0000-4000-8000-0000c1d7a001'; // claim + realm tenant_admin, no CP row
const HOMED_B = '00000000-0000-4000-8000-0000c1d7a002'; // claim A, CP row B as developer
const SUPER = '00000000-0000-4000-8000-0000c1d7a003'; // super_admin realm role, no CP row
const SUPER_HOMED = '00000000-0000-4000-8000-0000c1d7a004'; // super_admin + CP row B member
const TOMBSTONED = '00000000-0000-4000-8000-0000c1d7a005'; // CP row B, deleted_at set
const USER_IDS = [NO_ROW, HOMED_B, SUPER, SUPER_HOMED, TOMBSTONED];

const router = new Router();
registerAdminRoutes(router);
registerMeRoutes(router);

let signingKey: CryptoKey;
let savedJwks: JWTVerifyGetKey;
let savedBypass: string | undefined;
const kcSeam = keycloak as unknown as { jwks: JWTVerifyGetKey };

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  signingKey = privateKey;
  savedJwks = kcSeam.jwks;
  kcSeam.jwks = createLocalJWKSet({ keys: [jwk] });
  savedBypass = process.env.AUTH_BYPASS;
  process.env.AUTH_BYPASS = 'false';
}, 30_000);

afterAll(async () => {
  kcSeam.jwks = savedJwks;
  if (savedBypass === undefined) delete process.env.AUTH_BYPASS;
  else process.env.AUTH_BYPASS = savedBypass;
  await cleanup();
}, 30_000);

async function cleanup(): Promise<void> {
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
}

beforeEach(async () => {
  __resetCpIdentityForTests();
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'CPID Claim Tenant', slug: 'cpid-claim-tenant' },
    { id: TENANT_B, name: 'CPID Row Tenant', slug: 'cpid-row-tenant' },
  ]);
  await db.insert(users).values([
    { id: HOMED_B, email: 'cpid.homed@test.dev', name: 'Homed', tenant_id: TENANT_B, tenant_role: 'developer' },
    { id: SUPER_HOMED, email: 'cpid.superhomed@test.dev', name: 'SH', tenant_id: TENANT_B, tenant_role: 'member' },
    {
      id: TOMBSTONED,
      email: 'cpid.gone@test.dev',
      name: 'Gone',
      tenant_id: TENANT_B,
      tenant_role: 'tenant_admin',
      deleted_at: new Date(),
    },
  ]);
}, 30_000);

function mint(sub: string, realmRoles: string[], extra: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    sub,
    email: `${sub.slice(-4)}@cpid.test.dev`,
    email_verified: true,
    name: `User ${sub.slice(-4)}`,
    realm_access: { roles: realmRoles },
    tenant_id: TENANT_A,
    ...extra,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(config.keycloak.issuer)
    .setExpirationTime('5m')
    .sign(signingKey);
}

function req(path: string, token: string): Request {
  return new Request(`http://t${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function call(path: string, token: string): Promise<Response> {
  const m = router.match('GET', path);
  if (!m) throw new Error(`no route for GET ${path}`);
  return m.handler(req(path, token), ...m.params);
}

test('claim tenant + realm tenant_admin but no CP row → no workspace, no tenant role', async () => {
  const token = await mint(NO_ROW, ['tenant_admin', 'developer', 'member', 'offline_access']);
  const user = await authenticateWithoutLicense(req('/x', token));
  expect(user.id).toBe(NO_ROW);
  expect(user.tenantId).toBeUndefined();
  expect(user.tenantRole).toBeUndefined();
  expect(user.roles).not.toContain('tenant_admin');
  expect(user.roles).not.toContain('developer');
  expect(user.roles).not.toContain('member');
  expect(user.roles).not.toContain('offline_access');

  const res = await call('/api/tenant', token);
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe('no_workspace');
});

test('GET /api/me answers 200 with hasWorkspace false for a caller with no CP row', async () => {
  const token = await mint(NO_ROW, ['tenant_admin']);
  const res = await call('/api/me', token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    id: string;
    tenantId: string | null;
    tenantRole: string | null;
    hasWorkspace: boolean;
    isSuperAdmin: boolean;
    roles: string[];
    pendingInvites: unknown[];
  };
  expect(body.id).toBe(NO_ROW);
  expect(body.hasWorkspace).toBe(false);
  expect(body.tenantId).toBeNull();
  expect(body.tenantRole).toBeNull();
  expect(body.isSuperAdmin).toBe(false);
  expect(body.roles).not.toContain('tenant_admin');
  expect(body.pendingInvites).toEqual([]);
});

test('claim says tenant A, CP row says tenant B as developer → B and developer win', async () => {
  const token = await mint(HOMED_B, ['tenant_admin']);
  const user = await authenticateWithoutLicense(req('/x', token));
  expect(user.tenantId).toBe(TENANT_B);
  expect(user.tenantRole).toBe('developer');
  expect(user.roles).toContain('developer');
  expect(user.roles).not.toContain('tenant_admin');

  const res = await call('/api/tenant', token);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { tenant: { id: string } }).tenant.id).toBe(TENANT_B);

  const me = (await (await call('/api/me', token)).json()) as {
    tenantId: string;
    tenantRole: string;
    hasWorkspace: boolean;
  };
  expect(me).toMatchObject({ tenantId: TENANT_B, tenantRole: 'developer', hasWorkspace: true });
});

test('the super_admin realm role survives hydration, with and without a CP row', async () => {
  const bare = await authenticateWithoutLicense(req('/x', await mint(SUPER, ['super_admin', 'tenant_admin'])));
  expect(bare.roles).toEqual(['super_admin']);
  expect(bare.tenantId).toBeUndefined();

  const homed = await authenticateWithoutLicense(
    req('/x', await mint(SUPER_HOMED, ['super_admin', 'tenant_admin'])),
  );
  expect(homed.roles.sort()).toEqual(['member', 'super_admin']);
  expect(homed.tenantId).toBe(TENANT_B);
  expect(homed.tenantRole).toBe('member');
});

test('a tombstoned CP row is no workspace (tenant routes 403 user_offboarded), whatever the claim says', async () => {
  const token = await mint(TOMBSTONED, ['tenant_admin']);
  const user = await authenticateWithoutLicense(req('/x', token));
  expect(user.tenantId).toBeUndefined();
  expect(user.roles).not.toContain('tenant_admin');
  const res = await call('/api/tenant', token);
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe('user_offboarded');
});
