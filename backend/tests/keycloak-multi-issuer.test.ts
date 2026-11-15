// tests/keycloak-multi-issuer.test.ts — realm-per-app P0 (~/.claude/plans/program/realm-per-app-design.md).
//
// The backend must ACCEPT tokens from an allowlist of issuers (KEYCLOAK_TRUSTED_ISSUERS), verify each
// against ITS OWN realm's keys with `iss` pinned, refuse secure-apps tokens on user routes, and change
// nothing at all until gitops sets the new env. Pure: real RS256 tokens, one local JWKS per realm.
import { test, expect, beforeAll, afterEach } from 'bun:test';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from 'jose';
import { KeycloakService, isServiceOnlyIssuer, jwksUrlForIssuer } from '../src/services/keycloak';
import { KeycloakAdminService } from '../src/services/keycloak-admin';
import { redirectUriForAlias } from '../src/services/sso-service';
import { config, keycloakTrustedIssuers, realmOfIssuer, validateProductionConfig } from '../src/config';

const HOST = 'https://auth.example.test';
const PORTAL = config.keycloak.issuer; // the default issuer (KEYCLOAK_ISSUER)
const CP = `${HOST}/realms/commonpractice`;
const SECURE = `${HOST}/realms/secure-apps`;
const STRANGER = `${HOST}/realms/someone-else`;

interface RealmKeys {
  priv: CryptoKey;
  jwks: JWTVerifyGetKey;
}
const keys: Record<string, RealmKeys> = {};

beforeAll(async () => {
  for (const iss of [PORTAL, CP, SECURE, STRANGER]) {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = `kid-${iss}`;
    jwk.alg = 'RS256';
    keys[iss] = { priv: privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
  }
}, 60_000);

const ENV = [
  'KEYCLOAK_TRUSTED_ISSUERS',
  'KEYCLOAK_SERVICE_ONLY_REALMS',
  'CP_SIGNUP_INTAKE_ISSUER',
  'CP_SIGNUP_DECIDER_ISSUER',
] as const;
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

/** Sign with `signer`'s key (and kid) but claim `iss` — lets a test forge a cross-realm token. */
function mint(iss: string, claims: Record<string, unknown> = {}, signer: string = iss): Promise<string> {
  return new SignJWT({ sub: `sub-${realmOfIssuer(iss)}`, email: 'u@example.test', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: `kid-${signer}` })
    .setIssuedAt()
    .setIssuer(iss)
    .setExpirationTime('5m')
    .sign(keys[signer]!.priv);
}

/** Per-issuer key lookup — the production shape (each realm verified against its own JWKS). */
const svc = () => new KeycloakService({ jwksForIssuer: (iss) => keys[iss]!.jwks });

test('default (env unset): the trusted list is exactly [KEYCLOAK_ISSUER] and its JWKS URL is unchanged', async () => {
  expect(keycloakTrustedIssuers()).toEqual([config.keycloak.issuer]);
  expect(jwksUrlForIssuer(config.keycloak.issuer)).toBe(
    `${config.keycloak.url}/realms/${config.keycloak.realm}/protocol/openid-connect/certs`,
  );
  const user = await svc().validateToken(await mint(PORTAL));
  expect(user.issuer).toBe(PORTAL);
  expect(user.realm).toBe(config.keycloak.realm);
  // …and every other realm is a 401, however validly signed by its own realm.
  for (const iss of [CP, SECURE, STRANGER]) {
    await expect(svc().validateToken(await mint(iss))).rejects.toThrow('Invalid or expired token');
  }
});

test('a commonpractice-realm user token is accepted once allowlisted, with its realm attached', async () => {
  process.env.KEYCLOAK_TRUSTED_ISSUERS = `${PORTAL}, ${CP}/`; // spaces + a stray trailing slash tolerated
  const user = await svc().validateToken(
    await mint(CP, { realm_access: { roles: ['super_admin', 'tenant_admin'] } }),
  );
  expect(user.issuer).toBe(CP);
  expect(user.realm).toBe('commonpractice');
  expect(user.id).toBe('sub-commonpractice');
  expect(user.roles).toEqual(['super_admin']);
  // portal still works alongside it.
  expect((await svc().validateToken(await mint(PORTAL))).issuer).toBe(PORTAL);
});

test('⛔ the claimed iss only SELECTS keys: a token claiming one trusted realm but signed by another is refused', async () => {
  process.env.KEYCLOAK_TRUSTED_ISSUERS = `${PORTAL},${CP}`;
  // Claims commonpractice, signed with portal's key (kid points at portal's key, absent from CP's JWKS).
  await expect(svc().validateToken(await mint(CP, {}, PORTAL))).rejects.toThrow();
  await expect(svc().validateToken(await mint(PORTAL, {}, CP))).rejects.toThrow();
});

test('a non-allowlisted issuer is 401 and its JWKS is never consulted', async () => {
  process.env.KEYCLOAK_TRUSTED_ISSUERS = `${PORTAL},${CP}`;
  const asked: string[] = [];
  const s = new KeycloakService({
    jwksForIssuer: (iss) => {
      asked.push(iss);
      return keys[iss]!.jwks;
    },
  });
  await expect(s.validateToken(await mint(STRANGER))).rejects.toThrow('Invalid or expired token');
  await expect(s.validateToken('not-a-jwt')).rejects.toThrow('Invalid or expired token');
  expect(asked).toEqual([]);
});

test('⛔ a secure-apps token is refused on user routes even when secure-apps is trusted; S2S doors may verify it', async () => {
  process.env.KEYCLOAK_TRUSTED_ISSUERS = `${PORTAL},${CP},${SECURE}`;
  expect(isServiceOnlyIssuer(SECURE)).toBe(true);
  expect(isServiceOnlyIssuer(CP)).toBe(false);
  // A HUMAN in secure-apps (billing dashboard, license-admin) holding super_admin must not become a CP session.
  const human = await mint(SECURE, { realm_access: { roles: ['super_admin', 'license-admin'] } });
  await expect(svc().validateToken(human)).rejects.toThrow('Invalid or expired token');
  // The S2S path verifies it — and the S2S guards then pin issuer/azp/aud/role (signup-early-access*.test.ts).
  const sa = await svc().validateToken(human, { allowServiceRealms: true });
  expect(sa.issuer).toBe(SECURE);
  expect(sa.realm).toBe('secure-apps');
});

test('KEYCLOAK_SERVICE_ONLY_REALMS is honoured (read live)', async () => {
  process.env.KEYCLOAK_TRUSTED_ISSUERS = `${PORTAL},${CP}`;
  process.env.KEYCLOAK_SERVICE_ONLY_REALMS = 'commonpractice';
  await expect(svc().validateToken(await mint(CP))).rejects.toThrow();
});

test('non-default issuers fetch JWKS through KEYCLOAK_URL with their own realm', () => {
  expect(jwksUrlForIssuer(CP)).toBe(`${config.keycloak.url}/realms/commonpractice/protocol/openid-connect/certs`);
  expect(jwksUrlForIssuer(SECURE)).toBe(`${config.keycloak.url}/realms/secure-apps/protocol/openid-connect/certs`);
});

test('defaults: S2S issuer pins and the user realm all equal today’s values', () => {
  expect(config.keycloak.userRealm).toBe(config.keycloak.realm);
  expect(config.keycloak.userRealmIssuer).toBe(config.keycloak.issuer);
  expect(redirectUriForAlias('entra-x')).toBe(`${config.keycloak.issuer}/broker/entra-x/endpoint`);
});

test('production config refuses an S2S issuer pin that is not in the trusted list', () => {
  const cfg = { ...config, env: 'production' as const };
  const missingFor = (): string => {
    try {
      validateProductionConfig(cfg as typeof config);
      return '';
    } catch (e) {
      return String((e as Error).message);
    }
  };
  process.env.CP_SIGNUP_DECIDER_ISSUER = SECURE;
  expect(missingFor()).toContain('CP_SIGNUP_DECIDER_ISSUER');
  process.env.KEYCLOAK_TRUSTED_ISSUERS = `${PORTAL},${SECURE}`;
  expect(missingFor()).not.toContain('CP_SIGNUP_DECIDER_ISSUER');
});

// ---- admin API: KEYCLOAK_USER_REALM drives the administered realm; the credential follows only when configured ----

function recordingFetch() {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    bodies.push(String(init.body ?? ''));
    if (url.endsWith('/protocol/openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  return { urls, bodies, fetchImpl };
}

test('admin API: administers AND authenticates in KEYCLOAK_USER_REALM with its own SA', async () => {
  const kc = config.keycloak as unknown as Record<string, string>;
  const saved = { ...kc };
  try {
    kc.userRealm = 'commonpractice';
    kc.userRealmAdminClientId = 'cp-realm-admin';
    kc.userRealmAdminClientSecret = 'cp-secret';
    const f = recordingFetch();
    await new KeycloakAdminService({ baseUrl: 'http://kc.test', fetchImpl: f.fetchImpl }).findRealmUserByUsernameOrEmail('a@b.c');
    expect(f.urls[0]).toBe('http://kc.test/realms/commonpractice/protocol/openid-connect/token');
    expect(f.bodies[0]).toContain('client_id=cp-realm-admin');
    expect(f.urls[1]).toStartWith('http://kc.test/admin/realms/commonpractice/users?');
  } finally {
    Object.assign(kc, saved);
  }
});

test('admin API: no user-realm SA ⇒ unconfigured, never a fallback to the retired portal SA', async () => {
  const kc = config.keycloak as unknown as Record<string, string>;
  const saved = { ...kc };
  try {
    // Simulate a leftover legacy credential: it must NOT be picked up.
    kc.adminClientId = 'commonpractice-admin';
    kc.adminClientSecret = 'portal-secret';
    kc.userRealmAdminClientId = '';
    kc.userRealmAdminClientSecret = '';
    const f = recordingFetch();
    await expect(
      new KeycloakAdminService({ baseUrl: 'http://kc.test', fetchImpl: f.fetchImpl }).getAdminToken(),
    ).rejects.toThrow(/not configured/);
    expect(f.urls.length).toBe(0);
  } finally {
    for (const k of Object.keys(kc)) if (!(k in saved)) delete kc[k];
    Object.assign(kc, saved);
  }
});
