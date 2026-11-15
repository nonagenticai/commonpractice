// tests/keycloak-admin.test.ts — the Keycloak admin client (services/keycloak-admin.ts), tested
// against an injected `fetch` (no live Keycloak). Proves: client_credentials auth in the TARGET
// realm with a 60s token cache, Location-header id parse / 409, read-non-fatal vs write-fatal
// error semantics, and that the client has no realm-role / user-attribute write surface at all
// (the `portal` realm is shared with fr; CP owns tenancy in its own DB).
import { test, expect } from 'bun:test';
import {
  KeycloakAdminService,
  KeycloakAdminError,
  DuplicateUserError,
  DuplicateIdpError,
} from '../src/services/keycloak-admin';

const BASE = 'http://kc.test';
const TOKEN_URL = `${BASE}/realms/portal/protocol/openid-connect/token`;

interface Recorded {
  url: string;
  method: string;
  body?: string;
}

/**
 * Build a fake fetch. `handler(url, method, init)` returns a Response (or undefined
 * to 404). Records every call + counts token requests.
 */
function makeFetch(
  handler: (url: string, method: string, init: RequestInit) => Response | undefined,
) {
  const calls: Recorded[] = [];
  let tokenRequests = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init.body as string | undefined });
    if (url === TOKEN_URL) {
      tokenRequests++;
      return new Response(JSON.stringify({ access_token: `tok-${tokenRequests}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return handler(url, method, init) ?? new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, tokenReqs: () => tokenRequests };
}

function svc(
  fetchImpl: typeof fetch,
  now: () => number = () => 1000,
): KeycloakAdminService {
  return new KeycloakAdminService({
    baseUrl: BASE,
    targetRealm: 'portal',
    clientId: 'commonpractice-admin',
    clientSecret: 'svc-secret',
    fetchImpl,
    now,
  });
}

// ---- client_credentials in the target realm ----

test('the admin token is a client_credentials grant against the TARGET realm, never master/password', async () => {
  const f = makeFetch(() => new Response('{}', { status: 200 }));
  await svc(f.fetchImpl).getAdminToken();
  expect(f.calls.length).toBe(1);
  expect(f.calls[0]!.url).toBe(TOKEN_URL);
  expect(f.calls[0]!.url).not.toContain('/realms/master/');
  const form = new URLSearchParams(String(f.calls[0]!.body));
  expect(form.get('grant_type')).toBe('client_credentials');
  expect(form.get('client_id')).toBe('commonpractice-admin');
  expect(form.get('client_secret')).toBe('svc-secret');
  expect(form.has('username')).toBe(false);
  expect(form.has('password')).toBe(false);
});

test('a rejected token grant is FATAL (KeycloakAdminError carrying the status)', async () => {
  const fetchImpl = (async () => new Response('unauthorized_client', { status: 401 })) as unknown as typeof fetch;
  const err = (await svc(fetchImpl).getAdminToken().catch((e) => e)) as KeycloakAdminError;
  expect(err).toBeInstanceOf(KeycloakAdminError);
  expect(err.status).toBe(401);
});

test('the client exposes NO realm-role or user-attribute write methods (realm shared with fr)', () => {
  const s = svc(makeFetch(() => undefined).fetchImpl) as unknown as Record<string, unknown>;
  for (const m of [
    'assignRealmRole',
    'removeRealmRole',
    'getRealmRole',
    'requireRealmRole',
    'setUserAttributes',
    'clearUserAttribute',
  ]) {
    expect(typeof s[m], m).toBe('undefined');
  }
  // Non-vacuity: the probe does see methods that do exist.
  expect(typeof s.createRealmUser).toBe('function');
});

// ---- token 60s cache ----

test('admin token is cached for 60s, refreshed after expiry', async () => {
  const clock = { t: 1000 };
  const f = makeFetch(() => new Response('{}', { status: 200 }));
  const s = svc(f.fetchImpl, () => clock.t);

  expect(await s.getAdminToken()).toBe('tok-1');
  expect(await s.getAdminToken()).toBe('tok-1'); // cached — no new request
  expect(f.tokenReqs()).toBe(1);

  clock.t += 59_000; // still inside the 60s window
  expect(await s.getAdminToken()).toBe('tok-1');
  expect(f.tokenReqs()).toBe(1);

  clock.t += 2_000; // now past 60s
  expect(await s.getAdminToken()).toBe('tok-2');
  expect(f.tokenReqs()).toBe(2);
});

// ---- create user: Location parse + 409 ----

test('createRealmUser returns the sub from the Location header', async () => {
  const f = makeFetch((url, method) => {
    if (method === 'POST' && url === `${BASE}/admin/realms/portal/users`) {
      return new Response(null, {
        status: 201,
        headers: { location: `${BASE}/admin/realms/portal/users/new-sub-123` },
      });
    }
    return undefined;
  });
  const id = await svc(f.fetchImpl).createRealmUser({ username: 'a', email: 'a@t' });
  expect(id).toBe('new-sub-123');
});

test('createRealmUser maps 409 to DuplicateUserError', async () => {
  const f = makeFetch((url, method) =>
    method === 'POST' && url.endsWith('/users')
      ? new Response('exists', { status: 409 })
      : undefined,
  );
  await expect(
    svc(f.fetchImpl).createRealmUser({ username: 'a', email: 'a@t' }),
  ).rejects.toBeInstanceOf(DuplicateUserError);
});

// ---- logoutUser: ending a REALM session, which nothing here could do ----

test('logoutUser POSTs the realm logout endpoint and tolerates 404 (no such realm user)', async () => {
  // CP's own `revokeSessionsFor` only tombstones `agent_sessions` rows — the browser's Keycloak
  // refresh chain survived it and kept minting tokens naming the OLD workspace after a move.
  // 404-tolerant for the same reason `deleteRealmUser` is: CP holds `users` rows with no realm
  // identity by design (the showcase seed), and "no such user" means there is no session to end.
  const f = makeFetch((url, method) =>
    method === 'POST' && url.endsWith('/users/u1/logout')
      ? new Response(null, { status: 204 })
      : new Response('nope', { status: 404 }),
  );
  await svc(f.fetchImpl).logoutUser('u1');
  expect(f.calls.filter((c) => c.url.endsWith('/logout')).map((c) => `${c.method} ${c.url}`)).toEqual([
    `POST ${BASE}/admin/realms/portal/users/u1/logout`,
  ]);

  const f404 = makeFetch(() => new Response('gone', { status: 404 }));
  await svc(f404.fetchImpl).logoutUser('u1'); // does not throw

  const f500 = makeFetch(() => new Response('boom', { status: 500 }));
  await expect(svc(f500.fetchImpl).logoutUser('u1')).rejects.toBeInstanceOf(KeycloakAdminError);
});

// ---- read non-fatal vs write fatal ----

test('listRealmUsers is non-fatal — returns [] on error', async () => {
  const f = makeFetch(() => new Response('boom', { status: 500 }));
  expect(await svc(f.fetchImpl).listRealmUsers()).toEqual([]);
});

// ---- delete is 404-tolerant ----

test('deleteRealmUser treats 404 as success', async () => {
  const f = makeFetch((url, method) =>
    method === 'DELETE' ? new Response(null, { status: 404 }) : undefined,
  );
  await expect(svc(f.fetchImpl).deleteRealmUser('gone')).resolves.toBeUndefined();
});

// ---- Identity Providers (Phase 4 / E.1) ----

const IDP_BASE = `${BASE}/admin/realms/portal/identity-provider/instances`;

test('createIdentityProvider POSTs to the target realm; 201 succeeds', async () => {
  let body: Record<string, unknown> | undefined;
  const f = makeFetch((url, method, init) => {
    if (method === 'POST' && url === IDP_BASE) {
      body = JSON.parse(init.body as string);
      return new Response(null, { status: 201 });
    }
    return undefined;
  });
  await svc(f.fetchImpl).createIdentityProvider({
    alias: 'entra-acme', providerId: 'oidc', config: { clientId: 'c' },
  });
  expect(body?.alias).toBe('entra-acme');
  expect(body?.providerId).toBe('oidc');
});

test('createIdentityProvider maps 409 to DuplicateIdpError', async () => {
  const f = makeFetch((url, method) =>
    method === 'POST' && url === IDP_BASE ? new Response('exists', { status: 409 }) : undefined,
  );
  await expect(
    svc(f.fetchImpl).createIdentityProvider({ alias: 'entra-acme', providerId: 'oidc', config: {} }),
  ).rejects.toBeInstanceOf(DuplicateIdpError);
});

test('createIdentityProvider is fatal on a non-2xx (not 409)', async () => {
  const f = makeFetch((url, method) =>
    method === 'POST' && url === IDP_BASE ? new Response('boom', { status: 500 }) : undefined,
  );
  await expect(
    svc(f.fetchImpl).createIdentityProvider({ alias: 'entra-acme', providerId: 'oidc', config: {} }),
  ).rejects.toBeInstanceOf(KeycloakAdminError);
});

test('createIdpMapper POSTs under the alias; getIdentityProvider is non-fatal (null on miss)', async () => {
  let mapperUrl: string | undefined;
  const f = makeFetch((url, method) => {
    if (method === 'POST' && url === `${IDP_BASE}/entra-acme/mappers`) {
      mapperUrl = url;
      return new Response(null, { status: 201 });
    }
    if (method === 'GET' && url === `${IDP_BASE}/ghost`) return new Response('no', { status: 404 });
    return undefined;
  });
  const s = svc(f.fetchImpl);
  await s.createIdpMapper('entra-acme', {
    name: 'tenant_id', identityProviderAlias: 'entra-acme',
    identityProviderMapper: 'hardcoded-attribute-idp-mapper', config: { attribute: 'tenant_id' },
  });
  expect(mapperUrl).toBe(`${IDP_BASE}/entra-acme/mappers`);
  expect(await s.getIdentityProvider('ghost')).toBeNull(); // read degrades, no throw
});

test('deleteIdentityProvider treats 404 as success', async () => {
  const f = makeFetch((url, method) =>
    method === 'DELETE' && url.startsWith(IDP_BASE) ? new Response(null, { status: 404 }) : undefined,
  );
  await expect(svc(f.fetchImpl).deleteIdentityProvider('gone')).resolves.toBeUndefined();
});

// ---- duplicate resolution (the onboarding-502 root cause) ----

const USERS_BASE = `${BASE}/admin/realms/portal/users`;

test('findRealmUserByUsernameOrEmail resolves a user whose EMAIL attribute is unset', async () => {
  // The exact production state that produced a permanent 502: the portal realm held
  // `george@nonagentic.ai` as a USERNAME with no email attribute, so `POST /users` 409'd on the
  // username while an email-only lookup returned nothing — "duplicate but not resolvable".
  const f = makeFetch((url, method) => {
    if (method !== 'GET' || !url.startsWith(USERS_BASE)) return undefined;
    if (url.includes('username=')) {
      return new Response(JSON.stringify([{ id: 'sub-1', username: 'ghost@acme.test' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const hit = await svc(f.fetchImpl).findRealmUserByUsernameOrEmail(
    'ghost@acme.test',
    'ghost@acme.test',
  );
  expect(hit?.id).toBe('sub-1');
  // It asked Keycloak an EXACT question rather than paging the whole realm.
  expect(f.calls.some((c) => c.url.includes('exact=true'))).toBe(true);
});

test('it falls through to an EMAIL lookup when the username does not match', async () => {
  const f = makeFetch((url, method) => {
    if (method !== 'GET' || !url.startsWith(USERS_BASE)) return undefined;
    const body = url.includes('email=')
      ? JSON.stringify([{ id: 'sub-2', username: 'legacy-handle', email: 'moved@acme.test' }])
      : '[]';
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const hit = await svc(f.fetchImpl).findRealmUserByUsernameOrEmail(
    'moved@acme.test',
    'moved@acme.test',
  );
  expect(hit?.id).toBe('sub-2');
});

test('a NEAR-miss never binds an onboarding to the wrong account', async () => {
  // Keycloak's `exact=true` is still case-insensitive on these fields, so the client re-checks.
  // A prefix/substring hit must NOT be accepted.
  const f = makeFetch((url, method) => {
    if (method !== 'GET' || !url.startsWith(USERS_BASE)) return undefined;
    return new Response(JSON.stringify([{ id: 'other', username: 'ann@acme.test.uk' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  expect(await svc(f.fetchImpl).findRealmUserByUsernameOrEmail('ann@acme.test')).toBeNull();
});

test('a case difference DOES match (Keycloak stores usernames case-insensitively)', async () => {
  const f = makeFetch((url, method) => {
    if (method !== 'GET' || !url.startsWith(USERS_BASE)) return undefined;
    return new Response(JSON.stringify([{ id: 'sub-3', username: 'Ann@Acme.Test' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  expect((await svc(f.fetchImpl).findRealmUserByUsernameOrEmail('ann@acme.test'))?.id).toBe('sub-3');
});

test('a FAILED lookup throws — "could not ask" must not read as "no such user"', async () => {
  // This is the whole point of not reusing listRealmUsers here: a swallowed failure would let the
  // caller conclude the user does not exist and fail the onboarding with a misleading error.
  const f = makeFetch((url, method) =>
    method === 'GET' && url.startsWith(USERS_BASE) ? new Response('boom', { status: 500 }) : undefined,
  );
  await expect(
    svc(f.fetchImpl).findRealmUserByUsernameOrEmail('x@acme.test'),
  ).rejects.toBeInstanceOf(KeycloakAdminError);
});

test('the email query is URL-encoded (a + in an address must not become a space)', async () => {
  const f = makeFetch((url, method) => {
    if (method !== 'GET' || !url.startsWith(USERS_BASE)) return undefined;
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await svc(f.fetchImpl).findRealmUserByUsernameOrEmail('ann+cp@acme.test');
  expect(f.calls.some((c) => c.url.includes('ann%2Bcp%40acme.test'))).toBe(true);
});

test('backfillUserEmail GET-merge-PUTs only when the email is missing, and never throws', async () => {
  const puts: string[] = [];
  const f = makeFetch((url, method, init) => {
    if (url === `${USERS_BASE}/sub-1`) {
      if (method === 'GET') {
        return new Response(JSON.stringify({ id: 'sub-1', username: 'ghost@acme.test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'PUT') {
        puts.push(init.body as string);
        return new Response(null, { status: 204 });
      }
    }
    if (url === `${USERS_BASE}/sub-2` && method === 'GET') {
      return new Response(
        JSON.stringify({ id: 'sub-2', username: 'has@acme.test', email: 'has@acme.test' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return undefined;
  });
  const s = svc(f.fetchImpl);

  await s.backfillUserEmail('sub-1', 'ghost@acme.test');
  expect(puts.length).toBe(1);
  const sent = JSON.parse(puts[0]!);
  expect(sent.email).toBe('ghost@acme.test');
  expect(sent.username).toBe('ghost@acme.test'); // merged, not a partial body (KC rejects those)

  // A user that already has an email is left alone.
  await s.backfillUserEmail('sub-2', 'other@acme.test');
  expect(puts.length).toBe(1);

  // Non-fatal: the identity is usable without the backfill, so a failure must not break onboarding.
  const bad = makeFetch(() => new Response('nope', { status: 500 }));
  await expect(svc(bad.fetchImpl).backfillUserEmail('sub-9', 'x@y.z')).resolves.toBeUndefined();
});

test('backfillUserNames fills ONLY empty names, GET-merge-PUT keeps every attribute, never throws', async () => {
  const puts: string[] = [];
  const rep = (id: string, extra: Record<string, unknown>) =>
    new Response(
      JSON.stringify({ id, username: `${id}@acme.test`, email: `${id}@acme.test`, attributes: { locale: ['nl'] }, ...extra }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const f = makeFetch((url, method, init) => {
    if (method === 'PUT') {
      puts.push(init.body as string);
      return new Response(null, { status: 204 });
    }
    if (url === `${USERS_BASE}/blank`) return rep('blank', { firstName: '' });
    if (url === `${USERS_BASE}/half`) return rep('half', { firstName: 'Kept' });
    if (url === `${USERS_BASE}/full`) return rep('full', { firstName: 'A', lastName: 'B' });
    return undefined;
  });
  const s = svc(f.fetchImpl);

  await s.backfillUserNames('blank', 'Jan', 'van der Berg');
  expect(puts.length).toBe(1);
  const sent = JSON.parse(puts[0]!);
  expect(sent).toMatchObject({ firstName: 'Jan', lastName: 'van der Berg', email: 'blank@acme.test' });
  // Merged from the GET, not a partial body: the attributes round-trip untouched, nothing added.
  expect(sent.attributes).toEqual({ locale: ['nl'] });

  // A name someone set is never overwritten — only the empty half is filled.
  await s.backfillUserNames('half', 'Other', 'Filled');
  expect(JSON.parse(puts[1]!)).toMatchObject({ firstName: 'Kept', lastName: 'Filled' });

  // Both set → no write at all.
  await s.backfillUserNames('full', 'X', 'Y');
  expect(puts.length).toBe(2);

  const bad = makeFetch(() => new Response('nope', { status: 500 }));
  await expect(svc(bad.fetchImpl).backfillUserNames('sub-9', 'a', 'b')).resolves.toBeUndefined();
});

test('backfillUserNames never throws but is never SILENT: a refused read and a refused write both log', async () => {
  const lines: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (t: unknown) => void lines.push(String(t));
  console.error = (t: unknown) => void lines.push(String(t));
  try {
    // The SA lost view-users: the GET is refused.
    const noRead = makeFetch(() => new Response('forbidden', { status: 403 }));
    await svc(noRead.fetchImpl).backfillUserNames('sub-r', 'a', 'b');
    // The SA can read but lost manage-users: the PUT is refused.
    const noWrite = makeFetch((url, method) =>
      method === 'PUT'
        ? new Response('forbidden', { status: 403 })
        : new Response(JSON.stringify({ id: 'sub-w', firstName: '', lastName: '' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
    await svc(noWrite.fetchImpl).backfillUserNames('sub-w', 'a', 'b');
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
  const failed = lines.filter((l) => l.includes('backfill_names_failed'));
  expect(failed.some((l) => l.includes('sub-r') && l.includes('403'))).toBe(true);
  expect(failed.some((l) => l.includes('sub-w') && l.includes('403'))).toBe(true);
});

test('getRealmRolesForUsers reports an unresolved user as null, never as "no roles"', async () => {
  // Read-only (used by the one-off membership backfill). `[]` would make a Keycloak outage
  // indistinguishable from "holds no roles".
  const f = makeFetch((url, method) => {
    if (method !== 'GET' || !url.includes('/role-mappings/realm')) return undefined;
    if (url.includes('good')) {
      return new Response(JSON.stringify([{ id: 'r', name: 'tenant_admin' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('down', { status: 503 });
  });
  const out = await svc(f.fetchImpl).getRealmRolesForUsers(['good', 'bad']);
  expect(out.get('good')).toEqual(['tenant_admin']);
  expect(out.get('bad')).toBeNull(); // NOT []
});

test('getRealmRolesForUsers maps a 404 to [] — an absent user is an ANSWER, not an outage', async () => {
  // This is the distinction whose absence broke offboarding in prod. `null` means "ask again
  // later"; a user this realm does not have will 404 forever, so callers that fail closed on
  // `null` failed closed PERMANENTLY. CP holds `users` rows with no realm identity by design
  // (the showcase seed inserts members and never provisions one) — 21 of prod's 24 live rows —
  // so `tenantAdminIds`' last-admin guard raised 502 for essentially every tenant and
  // `DELETE /api/tenants/:id/users/:userId` could not complete at all.
  //
  // Both branches are asserted together on purpose: the fix must NOT be "treat every failure as
  // no-roles", which is the older bug it replaced (an outage would silently under-count admins).
  const f = makeFetch((url, method) => {
    if (method !== 'GET' || !url.includes('/role-mappings/realm')) return undefined;
    if (url.includes('lives')) {
      return new Response(JSON.stringify([{ id: 'r', name: 'tenant_admin' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('absent')) return new Response('no such user', { status: 404 });
    return new Response('down', { status: 503 });
  });
  const out = await svc(f.fetchImpl).getRealmRolesForUsers(['lives', 'absent', 'unreachable']);
  expect(out.get('lives')).toEqual(['tenant_admin']);
  expect(out.get('absent')).toEqual([]); // definitive: no such user ⇒ holds no roles
  expect(out.get('unreachable')).toBeNull(); // still unknown ⇒ callers may fail closed
});

// ---- unconfigured admin client must not reach the network ----
//
// WHY THIS EXISTS. `.env.example` ships KEYCLOAK_URL=https://auth.nonagentic.ai —
// live PRODUCTION auth — as the dev default, while config.ts defaults the admin client
// secret to ''. An empty-credential grant from an unconfigured dev box once kept
// KeycloakAuthFailuresPersistent lit for three days (2026-08-18).
//
// The assertion that matters is `tokenReqs() === 0` — that no request LEFT. A test
// that only checked the thrown status would still pass while hammering production,
// which is the entire defect.

test('unconfigured admin client throws 503 WITHOUT sending a request', async () => {
  const f = makeFetch(() => new Response('{}', { status: 200 }));
  const s = new KeycloakAdminService({
    baseUrl: BASE,
    targetRealm: 'portal',
    clientId: '',
    clientSecret: '', // the config.ts default when KEYCLOAK_ADMIN_CLIENT_SECRET is unset
    fetchImpl: f.fetchImpl,
    now: () => 1000,
  });

  await expect(s.getAdminToken()).rejects.toThrow(KeycloakAdminError);
  await expect(s.getAdminToken()).rejects.toThrow(/not configured/);

  // THE load-bearing assertion: nothing was sent, to production or anywhere.
  expect(f.tokenReqs()).toBe(0);
  expect(f.calls.length).toBe(0);
});

test('a blank client secret alone is also refused before the network', async () => {
  // Half-configured is the likelier real-world state: the client id has a non-empty default
  // (`commonpractice-admin`), so an unset secret is the common case and must be refused on its own.
  const f = makeFetch(() => new Response('{}', { status: 200 }));
  const s = new KeycloakAdminService({
    baseUrl: BASE,
    targetRealm: 'portal',
    clientId: 'commonpractice-admin',
    clientSecret: '',
    fetchImpl: f.fetchImpl,
    now: () => 1000,
  });

  await expect(s.getAdminToken()).rejects.toThrow(/not configured/);
  expect(f.tokenReqs()).toBe(0);
});

test('a fully configured client is unaffected (the guard is not a blanket block)', async () => {
  // Non-vacuity: proves the guard discriminates rather than refusing everything.
  const f = makeFetch(() => new Response('{}', { status: 200 }));
  const s = svc(f.fetchImpl);
  expect(await s.getAdminToken()).toBe('tok-1');
  expect(f.tokenReqs()).toBe(1);
});
