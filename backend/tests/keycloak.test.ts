// tests/keycloak.test.ts — the JWT validation boundary every protected route relies
// on. Pure (no live Keycloak): we mint real RS256 tokens with `jose` and inject a
// local JWKS through KeycloakService's `jwks` seam, then assert accept/reject for the
// issuer, expiry, signature, and JWKS-miss paths. Mirrors how the LLM adapter tests
// inject a transport seam instead of reaching the network.
import { test, expect, beforeAll } from 'bun:test';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  // jose v6 removed `KeyLike`. `generateKeyPair` is WebCrypto-first there and hands back
  // `CryptoKey`, which jose re-exports — so this is the same type by a new name, not a widening.
  type CryptoKey,
} from 'jose';
import { KeycloakService } from '../src/services/keycloak';
import { config } from '../src/config';

const KID = 'cp-test-key-1';

// RS256 keypair generation is expensive (~hundreds of ms, and spiky under load). Doing it
// inline in every test made this file flaky: under full-suite CPU + DB contention the
// per-test keygen intermittently blew bun's default per-test timeout (the failures vanished
// in isolation). Generate the keys ONCE in beforeAll (generous timeout) and reuse them, so
// each test only signs/verifies (sub-millisecond). `validKey`'s public half is in `jwks`;
// `otherKey` is deliberately NOT, for the bad-signature path.
let validKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  validKey = privateKey;
  jwks = createLocalJWKSet({ keys: [jwk] });
  ({ privateKey: otherKey } = await generateKeyPair('RS256'));
}, 30_000);

function mint(
  signingKey: CryptoKey,
  claims: Record<string, unknown>,
  opts: { issuer?: string; exp?: string | number } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? config.keycloak.issuer)
    .setExpirationTime(opts.exp ?? '5m')
    .sign(signingKey);
}

test('a valid token is accepted; only the super_admin realm role flows into the user', async () => {
  const svc = new KeycloakService({ jwks });
  const token = await mint(validKey, {
    sub: 'user-123',
    email: 'jane@example.com',
    name: 'Jane Doe',
    // The realm is shared with fr: tenant roles and fr's own roles mean nothing to CP, and the
    // tenant_id claim is not read (CP's `users` row decides — services/cp-identity.ts).
    realm_access: { roles: ['platform', 'employee', 'tenant_admin', 'developer', 'member', 'super_admin'] },
    tenant_id: '00000000-0000-4000-8000-0000000c1a1f',
  });

  const user = await svc.validateToken(token);
  expect(user.id).toBe('user-123');
  expect(user.email).toBe('jane@example.com');
  expect(user.name).toBe('Jane Doe');
  expect(user.roles).toEqual(['super_admin']);
  expect(user.tenantId).toBeUndefined();
});

test('a token without realm_access yields no roles (not a crash)', async () => {
  const svc = new KeycloakService({ jwks });
  const token = await mint(validKey, { sub: 'u', email: 'a@b.c', name: 'A' });
  const user = await svc.validateToken(token);
  expect(user.roles).toEqual([]);
});

test('a wrong-issuer token is rejected', async () => {
  const svc = new KeycloakService({ jwks });
  const token = await mint(validKey, { sub: 'u' }, { issuer: 'https://evil.example/realms/portal' });
  await expect(svc.validateToken(token)).rejects.toThrow();
});

test('an expired token is rejected', async () => {
  const svc = new KeycloakService({ jwks });
  // iat now, exp in the past.
  const token = await mint(validKey, { sub: 'u' }, { exp: Math.floor(Date.now() / 1000) - 60 });
  await expect(svc.validateToken(token)).rejects.toThrow();
});

test('a token signed by a key NOT in the JWKS is rejected (bad signature)', async () => {
  const svc = new KeycloakService({ jwks });
  // Sign with a different private key but the same kid → KID resolves to the legit
  // public key, signature verification fails.
  const token = await mint(otherKey, { sub: 'u' });
  await expect(svc.validateToken(token)).rejects.toThrow();
});

test('extractToken parses Bearer and rejects a missing/malformed header', () => {
  const svc = new KeycloakService();
  expect(svc.extractToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  expect(() => svc.extractToken(null)).toThrow();
  expect(() => svc.extractToken('Basic xyz')).toThrow();
});

test('the signup-intake SA token: `azp` is carried and the intake realm role is honoured', async () => {
  const svc = new KeycloakService({ jwks });
  const token = await mint(validKey, {
    sub: 'service-account-sub',
    azp: 'cp-signup-intake',
    aud: ['cp-signup-intake', 'account'],
    realm_access: { roles: ['cp-signup-intake', 'offline_access', 'uma_authorization'] },
  });
  const user = await svc.validateToken(token);
  expect(user.azp).toBe('cp-signup-intake');
  expect(user.aud).toEqual(['cp-signup-intake', 'account']);
  // Only the roles CP honours survive — the intake role is one of them, the realm defaults are not.
  expect(user.roles).toEqual(['cp-signup-intake']);
});

test('the signup-decider SA token: the decider realm role is honoured (else the guard can never pass)', async () => {
  const svc = new KeycloakService({ jwks });
  const token = await mint(validKey, {
    sub: 'service-account-decider-sub',
    azp: 'chat-bridge-signup-decider',
    aud: ['chat-bridge-signup-decider'],
    realm_access: { roles: ['cp-signup-decide', 'agent-signup-decide', 'offline_access'] },
  });
  const user = await svc.validateToken(token);
  expect(user.azp).toBe('chat-bridge-signup-decider');
  expect(user.aud).toEqual(['chat-bridge-signup-decider']);
  // Only CP's own decider role survives; another app's decider role is not honoured here.
  expect(user.roles).toEqual(['cp-signup-decide']);
});

test('a token without `azp` yields no azp (the intake guard then refuses it)', async () => {
  const svc = new KeycloakService({ jwks });
  const user = await svc.validateToken(await mint(validKey, { sub: 'u2' }));
  expect(user.azp).toBeUndefined();
});

test('a single-string `aud` becomes a one-item list; no `aud` yields none', async () => {
  const svc = new KeycloakService({ jwks });
  expect((await svc.validateToken(await mint(validKey, { sub: 's', aud: 'cp-signup-intake' }))).aud).toEqual(['cp-signup-intake']);
  expect((await svc.validateToken(await mint(validKey, { sub: 's' }))).aud).toBeUndefined();
});
