// tests/licenses-admin.test.ts — Phase 4 / F.2: the licenses-service ADMIN write client
// (services/licenses-admin.ts). Tested against an injected `fetch` (no live licenses service).
// Proves the load-bearing behaviours: client_credentials 60s token cache, the X-Tenant-Id-bound
// create-license call + license_id parse, mint-token, revoke-by-token, and throw-on-non-2xx.
import { config } from '../src/config';
import { test, expect } from 'bun:test';
import {
  LicensesAdminService,
  LicensesAdminError,
  LicencesAccessRefusedError,
  LicencesNameConflictError,
  LicencesTenantOwnedByOtherAppError,
  PlanRetireUnsupportedError,
  adminMethod,
  licencesAdminConfigured,
  NEW_TENANT_BYO_MODE,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';

const BASE = 'http://licenses.test';
const TOKEN_URL = 'http://kc.test/realms/secure-apps/protocol/openid-connect/token';

interface Recorded {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/** Fake fetch: records every call, mints a fresh access_token per token request, delegates the
 *  rest to `handler` (undefined → 404). */
function makeFetch(
  handler: (url: string, method: string, init: RequestInit) => Response | undefined,
) {
  const calls: Recorded[] = [];
  let tokenRequests = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: init.body as string | undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    if (url === TOKEN_URL) {
      tokenRequests++;
      return new Response(JSON.stringify({ access_token: `sa-${tokenRequests}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return handler(url, method, init) ?? new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, tokenReqs: () => tokenRequests };
}

function svc(fetchImpl: typeof fetch, now: () => number = () => 1000): LicensesAdminService {
  return new LicensesAdminService({
    adminBaseUrl: BASE,
    tokenUrl: TOKEN_URL,
    clientId: 'cp-licenses-admin',
    clientSecret: 'shh',
    appKey: 'commonpractice',
    planCode: 'standard',
    fetchImpl,
    now,
  });
}

// The licenses API is UUID-keyed: createLicense first resolves (app_id, plan_id) via
// GET /apps/{key} + /apps/{key}/plans. These canned ids + the resolve wrapper let the write tests
// focus on the POST while still exercising the real (resolve → create) path.
const APP_ID = '00000000-0000-0000-0000-0000000000aa';
const PLAN_ID = '00000000-0000-0000-0000-0000000000bb';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Wrap a handler so the two app/plan resolution GETs answer with the canned ids. */
function resolveOr(
  handler: (url: string, method: string, init: RequestInit) => Response | undefined,
) {
  return (url: string, method: string, init: RequestInit): Response | undefined => {
    if (method === 'GET' && url === `${BASE}/apps/commonpractice`) {
      return jsonRes({ id: APP_ID, key: 'commonpractice', name: 'Common Practice' });
    }
    if (method === 'GET' && url === `${BASE}/apps/commonpractice/plans`) {
      return jsonRes([
        { id: '00000000-0000-0000-0000-0000000000cc', code: 'free', name: 'Free' },
        { id: PLAN_ID, code: 'standard', name: 'Standard' },
      ]);
    }
    return handler(url, method, init);
  };
}

// ---- token: client_credentials grant + 60s cache ----

test('service token uses client_credentials, cached 60s, refreshed after expiry', async () => {
  const clock = { t: 1000 };
  const f = makeFetch(() => new Response('{}', { status: 200 }));
  const s = svc(f.fetchImpl, () => clock.t);

  expect(await s.getServiceToken()).toBe('sa-1');
  expect(await s.getServiceToken()).toBe('sa-1'); // cached
  expect(f.tokenReqs()).toBe(1);
  // the grant body is client_credentials (NOT password); body is a URLSearchParams → stringify
  expect(String(f.calls[0]!.body)).toContain('grant_type=client_credentials');
  expect(String(f.calls[0]!.body)).toContain('client_id=cp-licenses-admin');

  clock.t += 59_000;
  await s.getServiceToken();
  expect(f.tokenReqs()).toBe(1);

  clock.t += 2_000; // past 60s
  expect(await s.getServiceToken()).toBe('sa-2');
  expect(f.tokenReqs()).toBe(2);
});

// ---- createLicense: resolve (app_id, plan_id) → POST /licenses/user/{sub} + X-Tenant-Id ----

test('createLicense resolves app_id/plan_id and posts them (NOT keys) with the X-Tenant-Id header', async () => {
  const f = makeFetch(
    resolveOr((url, method) =>
      method === 'POST' && url === `${BASE}/licenses/user/sub-123`
        ? jsonRes({ license_id: 'lic-789', subject_id: 'subj-789' }, 201)
        : undefined,
    ),
  );
  const s = svc(f.fetchImpl);
  const { licenseId, subjectId } = await s.createLicense('sub-123', 'tenant-abc');
  expect(licenseId).toBe('lic-789');
  // ⛔ THE RESPONSE'S `subject_id`, NOT THE KEYCLOAK SUB IN THE PATH. They are different
  // identifiers and conflating them is what made 100% of this service's central spend land as
  // `attribution_status='unlicensed'`. Asserting the negative too, so a future "simplification"
  // that echoes the argument back cannot pass this test.
  expect(subjectId).toBe('subj-789');
  expect(subjectId).not.toBe('sub-123');

  const call = f.calls.find((c) => c.url.endsWith('/licenses/user/sub-123'))!;
  expect(call.headers['X-Tenant-Id']).toBe('tenant-abc');
  expect(call.headers['Authorization']).toBe('Bearer sa-1');
  // the UUID-keyed LicenseCreate contract — app_id/plan_id, never app_key/plan_code
  expect(call.body).toContain(`"app_id":"${APP_ID}"`);
  expect(call.body).toContain(`"plan_id":"${PLAN_ID}"`);
  expect(call.body).not.toContain('app_key');
  expect(call.body).not.toContain('plan_code');
  // The EMPLOYEE's realm, not whatever realm this service's SA token came from.
  expect(JSON.parse(call.body!).subject_realm).toBe(config.keycloak.realm);
});

test('createLicense also accepts an `id` field for the license id', async () => {
  const f = makeFetch(resolveOr(() => jsonRes({ id: 'lic-alt', subject_id: 'subj-alt' })));
  const { licenseId } = await svc(f.fetchImpl).createLicense('s', 't');
  expect(licenseId).toBe('lic-alt');
});

test('createLicense REFUSES a response with no subject_id rather than falling back to the sub', async () => {
  // ⛔ THE REGRESSION THIS PINS. `subject_id` (the licences-service Subject UUID) and the Keycloak
  // `sub` in the request path are DIFFERENT identifiers. Substituting one for the other does not
  // degrade attribution gracefully — it reproduces the exact defect this field was added to end
  // (six billing_cost_daily rows, 696 requests, $1.0008, all `attribution_status='unlicensed'`)
  // while looking like it worked. So a response missing it is a contract break, not a default.
  const f = makeFetch(resolveOr(() => jsonRes({ license_id: 'lic-nosubj' }, 201)));
  await expect(svc(f.fetchImpl).createLicense('sub-123', 'tenant-abc')).rejects.toThrow(
    /missing subject_id/,
  );
});

test('createLicense caches the resolved app/plan — only one resolve pair across two issues', async () => {
  const f = makeFetch(resolveOr(() => jsonRes({ license_id: 'lic-1', subject_id: 'subj-1' }, 201)));
  const s = svc(f.fetchImpl);
  await s.createLicense('sub-1', 'tenant-1');
  await s.createLicense('sub-2', 'tenant-2');
  expect(f.calls.filter((c) => c.url === `${BASE}/apps/commonpractice`).length).toBe(1);
  expect(f.calls.filter((c) => c.url === `${BASE}/apps/commonpractice/plans`).length).toBe(1);
});

test('createLicense throws if the configured plan code is not registered for the app', async () => {
  // resolve returns plans WITHOUT 'standard'
  const f = makeFetch((url, method) => {
    if (method === 'GET' && url === `${BASE}/apps/commonpractice`) {
      return jsonRes({ id: APP_ID, key: 'commonpractice' });
    }
    if (method === 'GET' && url === `${BASE}/apps/commonpractice/plans`) {
      return jsonRes([{ id: 'x', code: 'free' }]);
    }
    return undefined;
  });
  await expect(svc(f.fetchImpl).createLicense('s', 't')).rejects.toBeInstanceOf(LicensesAdminError);
});

// ---- createToken: POST /licenses/{id}/tokens + X-Tenant-Id (ownership check) ----

test('createToken returns the raw token and sends the X-Tenant-Id ownership header', async () => {
  const f = makeFetch((url, method) =>
    method === 'POST' && url === `${BASE}/licenses/lic-789/tokens`
      ? jsonRes({ token: 'raw-token-xyz' }, 201)
      : undefined,
  );
  const { token } = await svc(f.fetchImpl).createToken('lic-789', 'tenant-abc');
  expect(token).toBe('raw-token-xyz');
  const call = f.calls.find((c) => c.url.endsWith('/licenses/lic-789/tokens'))!;
  expect(call.headers['X-Tenant-Id']).toBe('tenant-abc');
});

// ---- revokeByToken: POST /license/revoke + X-Tenant-Id (ownership check) ----

test('revokeByToken posts the token to /license/revoke with the X-Tenant-Id header', async () => {
  // ⚠️ THIS FIXTURE USED TO BE `new Response('{}', ...)` AND THAT ENCODED THE BUG AS THE SPEC.
  // An empty 200 body is exactly what a wrong-tenant revoke does NOT look like, but it is also
  // what a *failed* revoke looks like to a caller that only reads the status — so the test passed
  // while the function could not distinguish the two. The real success body carries `revoked:true`.
  const f = makeFetch((url, method) =>
    method === 'POST' && url === `${BASE}/license/revoke`
      ? jsonRes({ revoked: true, message: 'Token revoked successfully' })
      : undefined,
  );
  const s = svc(f.fetchImpl);
  await s.revokeByToken('raw-token-xyz', 'tenant-abc');
  const call = f.calls.find((c) => c.url.endsWith('/license/revoke'))!;
  expect(call.body).toContain('"token":"raw-token-xyz"');
  expect(call.headers['X-Tenant-Id']).toBe('tenant-abc');
});

test('a 200 revoke with revoked=false throws — a 2xx is not a revoke', async () => {
  // The wrong-tenant / unknown-token body, verbatim from licenses/main.py:3003. HTTP 200, so
  // `res.ok` is true; only the body says the licence is still active. Before the body check this
  // resolved, and `revokeTenantLicense` then nulled `license_token_encrypted` — losing the only
  // handle on a licence that was never revoked.
  const f = makeFetch((url, method) =>
    method === 'POST' && url === `${BASE}/license/revoke`
      ? jsonRes({ revoked: false, message: 'Token not found or already invalid' })
      : undefined,
  );
  await expect(svc(f.fetchImpl).revokeByToken('t', 'tenant-abc')).rejects.toBeInstanceOf(
    LicensesAdminError,
  );
  // The carried status is the UPSTREAM one (200), not 502: `as502` makes the response a flat 502
  // regardless and records this number as `details.upstreamStatus`. A 502 here would both misreport
  // what happened and make `admin.ts`'s `isTransientLicenseError` retry a permanent condition.
  await expect(svc(f.fetchImpl).revokeByToken('t', 'tenant-abc')).rejects.toMatchObject({
    status: 200,
  });
});

test('a 200 revoke with no revoked field throws — cannot confirm, must not report success', async () => {
  const f = makeFetch((url, method) =>
    method === 'POST' && url === `${BASE}/license/revoke` ? jsonRes({}) : undefined,
  );
  await expect(svc(f.fetchImpl).revokeByToken('t', 'tenant-abc')).rejects.toBeInstanceOf(
    LicensesAdminError,
  );
});

test('an ALREADY-revoked token still succeeds — a retried offboard must stay recoverable', async () => {
  // licenses/main.py answers `{"revoked": true, "message": "Token was already revoked"}` for the
  // idempotent case. This is what makes the strict `revoked !== true` check above safe: if the
  // service had returned false here, failing loud would make every retry permanently unrecoverable.
  const f = makeFetch((url, method) =>
    method === 'POST' && url === `${BASE}/license/revoke`
      ? jsonRes({ revoked: true, message: 'Token was already revoked' })
      : undefined,
  );
  await svc(f.fetchImpl).revokeByToken('t', 'tenant-abc');
});

// ---- fail-loud: non-2xx throws ----

test('a non-2xx create-license throws LicensesAdminError carrying the status', async () => {
  // resolve succeeds; the POST create 503s
  const f = makeFetch(
    resolveOr((url, method) =>
      method === 'POST' && url.includes('/licenses/user/') ? new Response('nope', { status: 503 }) : undefined,
    ),
  );
  const s = svc(f.fetchImpl);
  await expect(s.createLicense('s', 't')).rejects.toBeInstanceOf(LicensesAdminError);
  await expect(s.createLicense('s', 't')).rejects.toMatchObject({ status: 503 });
});

test('a 200 create-license missing license_id throws (no silent empty id)', async () => {
  const f = makeFetch(resolveOr(() => jsonRes({})));
  await expect(svc(f.fetchImpl).createLicense('s', 't')).rejects.toBeInstanceOf(LicensesAdminError);
});

// =================================================================================================
// TENANT-REGISTRY LIFECYCLE — archive / registration probe / BYO posture
//
// These three exist because the registry TENANT ROW has its own lifecycle that per-licence calls
// never touch: a workspace can be offboarded in CP and still be `active` centrally, or exist in CP
// and be unknown centrally (which `byo-posture.ts` turns into a hard refusal of the platform
// credential). Every test below names the mutation that would put that state back.
// =================================================================================================

const T = 'tenant-abc';

/** What licences ACTUALLY answers for an absent tenant: FastAPI's `detail` envelope. */
const NESTED_NOT_FOUND = { detail: { error: 'tenant_not_found_in_registry', tenant_selector: T } };

test('archiveTenant PATCHes /tenants/{id}/archive with the archived flag and the SA bearer', async () => {
  const f = makeFetch((url, method) =>
    method === 'PATCH' && url === `${BASE}/tenants/${T}/archive` ? jsonRes({ archived: true }) : undefined,
  );
  await svc(f.fetchImpl).archiveTenant(T);

  const call = f.calls.find((c) => c.url.endsWith(`/tenants/${T}/archive`))!;
  // ⚠️ MUTATION TARGET: change the verb to POST (or the path to `/tenants/{id}` with a body), and
  // licences answers 405/404 — which this client reports as a failure, so an offboard would warn
  // forever rather than silently skipping. That is the intended failure shape; the assertion pins
  // the path that was measured against `set_tenant_archived` rather than inferred.
  expect(call.method).toBe('PATCH');
  expect(JSON.parse(call.body!).archived).toBe(true);
  expect(call.headers['Authorization']).toBe('Bearer sa-1');
});

test('archiveTenant treats ONLY the registry 404 literal as "nothing to archive"', async () => {
  // A tenant created before central registration existed genuinely has no registry row, and that is
  // a real state for this deployment — so it must not make an offboard warn forever.
  // The REAL licences body: FastAPI wraps every HTTPException in `detail` (commonpractice#417 — the
  // flat mock below was the only shape tested, which is why reading `body.error` looked correct).
  const nested404 = makeFetch(() => jsonRes(NESTED_NOT_FOUND, 404));
  await svc(nested404.fetchImpl).archiveTenant(T); // resolves
  const known404 = makeFetch(() => jsonRes({ error: 'tenant_not_found_in_registry' }, 404));
  await svc(known404.fetchImpl).archiveTenant(T); // flat shape still accepted

  // A literal-less 404 (the generic tenant read's body) is NOT "nothing to archive".
  const generic404 = makeFetch(() => jsonRes({ detail: 'Tenant not found' }, 404));
  await expect(svc(generic404.fetchImpl).archiveTenant(T)).rejects.toMatchObject({ status: 404 });

  // ⛔ MUTATION TARGET: replace the body check with a bare `if (res.status === 404) return` and this
  // test goes green while the archive step becomes a gate that cannot fail — an unmatched ROUTE is a
  // 404 too, so a wrong path would report every tenant as archived and archive nothing, forever.
  const routeMiss = makeFetch(() => new Response('Not Found', { status: 404 }));
  await expect(svc(routeMiss.fetchImpl).archiveTenant(T)).rejects.toBeInstanceOf(LicensesAdminError);
  await expect(svc(routeMiss.fetchImpl).archiveTenant(T)).rejects.toMatchObject({ status: 404 });
});

test('isTenantRegistered: 2xx → true, registry 404 literal → false, ANY other failure THROWS', async () => {
  // ⛔ MUTATION TARGET: probe `GET /tenants/{id}` again and this stub answers 404 — that route's 404
  // is the GENERIC `{"detail":"Tenant not found"}` (also returned for a foreign tenant), so it can
  // never carry the literal and every unregistered tenant throws forever (commonpractice#417).
  const yes = makeFetch((url, method) =>
    method === 'GET' && url === `${BASE}/tenants/${T}/byo-mode?on_unresolved=error`
      ? jsonRes({ byo_mode: 'local_allowed' })
      : undefined,
  );
  expect(await svc(yes.fetchImpl).isTenantRegistered(T)).toBe(true);
  const probe = yes.calls.find((c) => c.url.startsWith(`${BASE}/tenants/`))!;
  expect(new URL(probe.url).pathname).toBe(`/tenants/${T}/byo-mode`);
  expect(new URL(probe.url).searchParams.has('app')).toBe(false);

  const no = makeFetch(() => jsonRes(NESTED_NOT_FOUND, 404));
  expect(await svc(no.fetchImpl).isTenantRegistered(T)).toBe(false);
  const noFlat = makeFetch(() => jsonRes({ error: 'tenant_not_found_in_registry' }, 404));
  expect(await svc(noFlat.fetchImpl).isTenantRegistered(T)).toBe(false);

  // The generic / foreign-tenant 404 has no literal: absent and hidden are indistinguishable → THROW.
  const generic = makeFetch(() => jsonRes({ detail: 'Tenant not found' }, 404));
  await expect(svc(generic.fetchImpl).isTenantRegistered(T)).rejects.toMatchObject({ status: 404 });

  // ⛔ MUTATION TARGET, AND THE EXPENSIVE ONE: make the catch-all `return false` instead of throwing.
  // The probe's single consumer is the reconciler's `if (!registered) ensureTenantRegistered(...)`,
  // so a licences outage answered `false` would make the sweep re-PUT the ENTIRE FLEET's names every
  // five minutes against a service that is already failing — and re-assert the BYO posture over any
  // deliberate central `byo_required`. An outage must be `failed`, never "unregistered".
  const down = makeFetch(() => new Response('boom', { status: 503 }));
  await expect(svc(down.fetchImpl).isTenantRegistered(T)).rejects.toBeInstanceOf(LicensesAdminError);
  const unmatched = makeFetch(() => new Response('Not Found', { status: 404 }));
  await expect(svc(unmatched.fetchImpl).isTenantRegistered(T)).rejects.toBeInstanceOf(
    LicensesAdminError,
  );
});

test('getTenantByoMode: registry 404 literal (nested or flat) → byo_required, literal-less 404 THROWS', async () => {
  const ok = makeFetch((url, method) =>
    method === 'GET' &&
    url === `${BASE}/tenants/${T}/byo-mode?app=commonpractice&on_unresolved=error`
      ? jsonRes({ byo_mode: 'local_allowed' })
      : undefined,
  );
  expect(await svc(ok.fetchImpl).getTenantByoMode(T)).toBe('local_allowed');

  // ⛔ MUTATION TARGET: read a top-level `body.error` again and the nested case throws — the real
  // licences envelope is `{"detail": {"error": …}}` (commonpractice#417).
  const nested = makeFetch(() => jsonRes(NESTED_NOT_FOUND, 404));
  expect(await svc(nested.fetchImpl).getTenantByoMode(T)).toBe('byo_required');
  const flat = makeFetch(() => jsonRes({ error: 'tenant_not_found_in_registry' }, 404));
  expect(await svc(flat.fetchImpl).getTenantByoMode(T)).toBe('byo_required');

  const generic = makeFetch(() => jsonRes({ detail: 'Tenant not found' }, 404));
  await expect(svc(generic.fetchImpl).getTenantByoMode(T)).rejects.toMatchObject({ status: 404 });
  const routeMiss = makeFetch(() => jsonRes({ detail: 'Not Found' }, 404));
  await expect(svc(routeMiss.fetchImpl).getTenantByoMode(T)).rejects.toBeInstanceOf(LicensesAdminError);
});

test('setTenantByoMode PUTs the posture scoped to THIS app, and a non-2xx throws', async () => {
  // ⛔ THE STUB ONLY ANSWERS THE PER-APP PATH, deliberately. Verified against licences `main.py`:
  // the per-product override is PUT `/tenants/{id}/apps/{app_key}/byo-mode`; the tenant-WIDE value
  // is a PATCH on `/tenants/{id}/byo-mode`. A stub that matched `/byo-mode` loosely would go green
  // against the tenant-wide path too — and FastAPI DROPS an unknown query parameter, so the earlier
  // `?app=` spelling would have returned 200 having changed the posture of every product the
  // customer holds.
  const f = makeFetch((url, method) =>
    method === 'PUT' && url === `${BASE}/tenants/${T}/apps/commonpractice/byo-mode`
      ? jsonRes({ byo_mode: 'local_allowed' })
      : undefined,
  );
  await svc(f.fetchImpl).setTenantByoMode(T, NEW_TENANT_BYO_MODE);

  const call = f.calls.find((c) => c.url.includes('/byo-mode'))!;
  // ⚠️ MUTATION TARGET: write to `/tenants/{id}/byo-mode` and this fails — that route sets the
  // tenant-WIDE posture, a different commercial statement about a customer who may hold several
  // products, and one nothing in CP would ever notice.
  expect(call.url).toBe(`${BASE}/tenants/${T}/apps/commonpractice/byo-mode`);
  expect(JSON.parse(call.body!).byo_mode).toBe('local_allowed');

  const refused = makeFetch(() => new Response('nope', { status: 403 }));
  await expect(svc(refused.fetchImpl).setTenantByoMode(T, 'byo_required')).rejects.toMatchObject({
    status: 403,
  });
});

test('NEW_TENANT_BYO_MODE is local_allowed — a byo_required default would forbid the welcome budget', async () => {
  // ⛔ MUTATION TARGET: set this to `byo_required` and every workspace CP creates is refused the
  // platform credential by `assertPlatformCredentialAllowed`, including against the welcome budget
  // the SAME request grants it. The constant is asserted directly because there is no other place
  // the commercial default is written down.
  expect(NEW_TENANT_BYO_MODE).toBe('local_allowed');
});

test('adminMethod THROWS 501 for a client missing the method — it never resolves to a no-op', async () => {
  // A fake predating these methods: exactly the shape every existing test file's fake still has.
  const legacy = {
    async ensureTenantRegistered() {},
    async createLicense() {
      return { licenseId: 'l', subjectId: 's' };
    },
    async createToken() {
      return { token: 't' };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  } as unknown as LicensesAdminClient;

  // ⛔ MUTATION TARGET, AND THE REASON THIS HELPER EXISTS. Replace every call site's
  // `adminMethod(client, 'archiveTenant')(id)` with `client.archiveTenant?.(id)` and this throw
  // becomes a clean `undefined`: the offboard route would report `archiveFailure: null` for a client
  // that cannot archive at all, i.e. announce success for a call it never made. `?.` on an optional
  // method is indistinguishable from the method succeeding, which is the whole hazard.
  expect(() => adminMethod(legacy, 'archiveTenant')).toThrow(LicensesAdminError);
  expect(() => adminMethod(legacy, 'setTenantByoMode')).toThrow(/does not implement/);

  // …and it resolves to a BOUND, working function when the client does implement it (non-vacuity:
  // the test above cannot pass merely because `adminMethod` always throws).
  const f = makeFetch(() => jsonRes({ archived: true }));
  const real = svc(f.fetchImpl);
  await adminMethod(real, 'archiveTenant')(T);
  expect(f.calls.some((c) => c.url.endsWith(`/tenants/${T}/archive`))).toBe(true);
});

test('licencesAdminConfigured asks about REACHABILITY, never about the issuance flag', async () => {
  const lic = config.license as {
    adminBaseUrl: string;
    issuanceEnabled: boolean;
    sa: { tokenUrl: string };
  };
  const was = {
    base: lic.adminBaseUrl,
    token: lic.sa.tokenUrl,
    issuance: lic.issuanceEnabled,
  };
  try {
    lic.adminBaseUrl = '';
    lic.sa.tokenUrl = '';
    expect(licencesAdminConfigured()).toBe(false);

    // ⛔ MUTATION TARGET: rewrite this as `config.license.issuanceEnabled` and tenant REGISTRATION
    // becomes conditional on licence MINTING again — the exact conflation that left every tenant
    // created while issuance was off unknown to the registry, with no BYO posture and therefore
    // refused the platform credential. Issuance OFF + a configured service must still register.
    lic.issuanceEnabled = false;
    lic.adminBaseUrl = BASE;
    lic.sa.tokenUrl = TOKEN_URL;
    expect(licencesAdminConfigured()).toBe(true);

    // Half-configured is NOT configured: without a token URL `getServiceToken` throws before any
    // request is built, so "configured" would promise a call that can never be made.
    lic.sa.tokenUrl = '';
    expect(licencesAdminConfigured()).toBe(false);
  } finally {
    lic.adminBaseUrl = was.base;
    lic.sa.tokenUrl = was.token;
    lic.issuanceEnabled = was.issuance;
  }
});

test('a missing token URL throws rather than calling fetch', async () => {
  const s = new LicensesAdminService({ adminBaseUrl: BASE, tokenUrl: '' });
  await expect(s.getServiceToken()).rejects.toBeInstanceOf(LicensesAdminError);
});

// ---- getActiveLicense: GET /licenses/active (tenant-level licences, ruling 2026-09-28) ----

const T_ACTIVE = '00000000-0000-4000-8000-0000000ac701';

test('getActiveLicense: GET /licenses/active?tenant_id&app_key with the SA bearer, returns the body', async () => {
  const body = { active: true, tenant_id: T_ACTIVE, app: { key: 'commonpractice' }, subject_match: true };
  const f = makeFetch((url, method) =>
    method === 'GET' && url.startsWith(`${BASE}/licenses/active?`) ? jsonRes(body) : undefined,
  );
  const r = await svc(f.fetchImpl).getActiveLicense(T_ACTIVE, { subjectId: `svc:${T_ACTIVE}:commonpractice` });
  expect(r).toEqual(body);
  const call = f.calls.find((c) => c.url.startsWith(`${BASE}/licenses/active?`))!;
  const q = new URL(call.url).searchParams;
  expect(q.get('tenant_id')).toBe(T_ACTIVE);
  expect(q.get('app_key')).toBe('commonpractice');
  expect(q.get('subject_id')).toBe(`svc:${T_ACTIVE}:commonpractice`);
  expect(call.headers.Authorization).toBe('Bearer sa-1');
});

test('getActiveLicense: the service\'s no_active_license 404 → null; any OTHER 404 THROWS', async () => {
  const none = makeFetch(() =>
    jsonRes({ detail: { error: 'no_active_license', tenant_id: T_ACTIVE, app_key: 'commonpractice' } }, 404),
  );
  expect(await svc(none.fetchImpl).getActiveLicense(T_ACTIVE)).toBeNull();
  // An unmatched route is also a 404 — reading it as "no licence" would make the lookup unfailable.
  const route404 = makeFetch(() => undefined); // plain-text 404
  await expect(svc(route404.fetchImpl).getActiveLicense(T_ACTIVE)).rejects.toBeInstanceOf(LicensesAdminError);
  const down = makeFetch(() => new Response('x', { status: 503 }));
  await expect(svc(down.fetchImpl).getActiveLicense(T_ACTIVE)).rejects.toBeInstanceOf(LicensesAdminError);
});

// ---- A2: per-tenant terms, plan catalogue, rename ------------------------------------------------

test('createLicense mints on the REQUESTED plan code (not the default) and sends starts_at/expires_at', async () => {
  const f = makeFetch(
    resolveOr((url, method) =>
      method === 'POST' && url === `${BASE}/licenses/user/sub-9`
        ? jsonRes({ license_id: 'lic-9', subject_id: 'subj-9', plan_id: '00000000-0000-0000-0000-0000000000cc', expires_at: '2027-01-01T00:00:00+00:00' }, 201)
        : undefined,
    ),
  );
  const out = await svc(f.fetchImpl).createLicense('sub-9', 't-9', {
    planCode: 'free',
    startsAt: new Date('2026-11-01T00:00:00Z'),
    expiresAt: new Date('2027-01-01T00:00:00Z'),
  });
  const body = JSON.parse(f.calls.find((c) => c.url.endsWith('/licenses/user/sub-9'))!.body!);
  // ⛔ the per-tenant plan, resolved by ITS code — the old single cache always sent `standard`.
  expect(body.plan_id).toBe('00000000-0000-0000-0000-0000000000cc');
  expect(body.starts_at).toBe('2026-11-01T00:00:00.000Z');
  expect(body.expires_at).toBe('2027-01-01T00:00:00.000Z');
  expect(out.termsMatch).toBe(true);
});

test('createLicense reports termsMatch:false when licences hands back an EXISTING licence on other terms', async () => {
  // licences' idempotency: the active licence for (tenant, app, subject) comes back, old plan and all.
  const f = makeFetch(
    resolveOr((url, method) =>
      method === 'POST' && url === `${BASE}/licenses/user/sub-9`
        ? jsonRes({ license_id: 'lic-old', subject_id: 'subj-9', plan_id: PLAN_ID, expires_at: null }, 201)
        : undefined,
    ),
  );
  const out = await svc(f.fetchImpl).createLicense('sub-9', 't-9', { planCode: 'free' });
  expect(out.licenseId).toBe('lic-old');
  expect(out.termsMatch).toBe(false);
});

test('plan ids are cached PER CODE: two codes → two resolutions, a repeat → none', async () => {
  const f = makeFetch(resolveOr(() => jsonRes({ license_id: 'l', subject_id: 's' }, 201)));
  const s = svc(f.fetchImpl);
  await s.createLicense('a', 't', { planCode: 'free' });
  await s.createLicense('b', 't', { planCode: 'standard' });
  await s.createLicense('c', 't', { planCode: 'free' });
  expect(f.calls.filter((c) => c.url === `${BASE}/apps/commonpractice/plans`).length).toBe(2);
  expect(f.calls.filter((c) => c.url === `${BASE}/apps/commonpractice`).length).toBe(1);
});

test('renameTenant: a name another of CP\'s own tenants holds → LicencesNameConflictError WITHOUT sending the PATCH', async () => {
  // The owner-scoped lookup finds CP's OWN tenant holding the name, so CP refuses before writing.
  const f = makeFetch((url, method) => {
    if (method === 'GET' && url === `${BASE}/tenants/taken-name`) return jsonRes({ id: 'other-id', name: 'taken-name' });
    return undefined;
  });
  await expect(svc(f.fetchImpl).renameTenant('my-id', 'taken-name')).rejects.toBeInstanceOf(LicencesNameConflictError);
  expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
});

test('renameTenant: a free name → PATCH /tenants/{id} {name}; a 409 → LicencesNameConflictError', async () => {
  const f = makeFetch((url, method) => {
    if (method === 'GET') return jsonRes({ detail: 'Tenant not found' }, 404);
    if (method === 'PATCH' && url === `${BASE}/tenants/my-id`) return jsonRes({ id: 'my-id', name: 'free-name' });
    return undefined;
  });
  await svc(f.fetchImpl).renameTenant('my-id', 'free-name');
  const patch = f.calls.find((c) => c.method === 'PATCH')!;
  expect(JSON.parse(patch.body!)).toEqual({ name: 'free-name' });

  const g = makeFetch((_url, method) =>
    method === 'GET'
      ? jsonRes({ detail: 'Tenant not found' }, 404)
      : jsonRes({ detail: { error: 'tenant_name_taken', name: 'raced', message: 'taken' } }, 409),
  );
  await expect(svc(g.fetchImpl).renameTenant('my-id', 'raced')).rejects.toBeInstanceOf(LicencesNameConflictError);

  // A 409 WITHOUT licences' `tenant_name_taken` literal is not read as a name clash.
  const h = makeFetch((_url, method) =>
    method === 'GET' ? jsonRes({ detail: 'Tenant not found' }, 404) : jsonRes({ detail: 'something else' }, 409),
  );
  const err = await svc(h.fetchImpl).renameTenant('my-id', 'x').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LicensesAdminError);
  expect(err).not.toBeInstanceOf(LicencesNameConflictError);
});

// ---- licences migration 050: tenant ownership per app -------------------------------------------

test('ensureTenantRegistered: PUT /tenants/{id} {name}; 201 and 200 both succeed', async () => {
  for (const status of [201, 200]) {
    const f = makeFetch((url, method) =>
      method === 'PUT' && url === `${BASE}/tenants/my-id` ? jsonRes({ id: 'my-id', name: 'acme' }, status) : undefined,
    );
    await svc(f.fetchImpl).ensureTenantRegistered('my-id', 'acme');
    const put = f.calls.find((c) => c.method === 'PUT')!;
    // The OWNER is never sent: licences derives it from CP's client.
    expect(JSON.parse(put.body!)).toEqual({ name: 'acme' });
  }
});

test('ensureTenantRegistered: 409 tenant_name_taken → LicencesNameConflictError (CP already holds the name)', async () => {
  const f = makeFetch(() =>
    jsonRes({ detail: { error: 'tenant_name_taken', name: 'acme', message: "tenant name already in use by this app: 'acme'" } }, 409),
  );
  const err = await svc(f.fetchImpl).ensureTenantRegistered('my-id', 'acme').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LicencesNameConflictError);
  expect((err as LicencesNameConflictError).tenantName).toBe('acme');
  expect((err as LicencesNameConflictError).status).toBe(409);
});

test('ensureTenantRegistered: 409 tenant_owned_by_other_app → LicencesTenantOwnedByOtherAppError, never a name clash', async () => {
  const f = makeFetch(() =>
    jsonRes({ detail: { error: 'tenant_owned_by_other_app', message: 'registered to a different owning app' } }, 409),
  );
  const err = await svc(f.fetchImpl).ensureTenantRegistered('my-id', 'acme').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LicencesTenantOwnedByOtherAppError);
  expect(err).not.toBeInstanceOf(LicencesNameConflictError);
  expect((err as LicencesTenantOwnedByOtherAppError).tenantId).toBe('my-id');
});

test('ensureTenantRegistered: a 409 with no recognised literal is a plain LicensesAdminError(409)', async () => {
  const f = makeFetch(() => jsonRes({ detail: "name 'acme' already belongs to tenant 0190" }, 409));
  const err = await svc(f.fetchImpl).ensureTenantRegistered('my-id', 'acme').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LicensesAdminError);
  expect(err).not.toBeInstanceOf(LicencesNameConflictError);
  expect(err).not.toBeInstanceOf(LicencesTenantOwnedByOtherAppError);
  expect((err as LicensesAdminError).status).toBe(409);
});

test('ensureTenantRegistered: 403 unknown_api_client → LicencesAccessRefusedError naming the code', async () => {
  const f = makeFetch(() => jsonRes({ detail: { error: 'unknown_api_client', message: 'not an owning app' } }, 403));
  const err = await svc(f.fetchImpl).ensureTenantRegistered('my-id', 'acme').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LicencesAccessRefusedError);
  expect((err as LicencesAccessRefusedError).code).toBe('unknown_api_client');
  expect((err as LicencesAccessRefusedError).status).toBe(403);
});

test('createLicense: 403 tenant_not_accessible / app_not_issuable_by_caller → LicencesAccessRefusedError with the code', async () => {
  for (const code of ['tenant_not_accessible', 'app_not_issuable_by_caller'] as const) {
    const f = makeFetch(
      resolveOr((url, method) =>
        method === 'POST' && url.includes('/licenses/user/')
          ? jsonRes({ detail: { error: code, message: 'refused' } }, 403)
          : undefined,
      ),
    );
    const err = await svc(f.fetchImpl).createLicense('s', 't').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LicencesAccessRefusedError);
    expect((err as LicencesAccessRefusedError).code).toBe(code);
    expect((err as Error).message).toContain(code);
  }
});

test('createLicense: a 403 WITHOUT an ownership literal (a role refusal) stays a plain LicensesAdminError(403)', async () => {
  const f = makeFetch(
    resolveOr((url, method) =>
      method === 'POST' && url.includes('/licenses/user/') ? jsonRes({ detail: 'Requires role license-admin' }, 403) : undefined,
    ),
  );
  const err = await svc(f.fetchImpl).createLicense('s', 't').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LicensesAdminError);
  expect(err).not.toBeInstanceOf(LicencesAccessRefusedError);
  expect((err as LicensesAdminError).status).toBe(403);
});

test('createToken and revoke: a 403 tenant_not_accessible → LicencesAccessRefusedError', async () => {
  const f = makeFetch(() => jsonRes({ detail: { error: 'tenant_not_accessible', message: 'refused' } }, 403));
  const s = svc(f.fetchImpl);
  await expect(s.createToken('lic', 't')).rejects.toBeInstanceOf(LicencesAccessRefusedError);
  await expect(s.revokeByToken('tok', 't')).rejects.toBeInstanceOf(LicencesAccessRefusedError);
  await expect(s.revokeByLicenseId('lic', 't')).rejects.toBeInstanceOf(LicencesAccessRefusedError);
});

test('listPlans asks THIS app only, with include_revoked when asked, and camel-cases', async () => {
  const f = makeFetch((url) =>
    url === `${BASE}/apps/commonpractice/plans?include_revoked=true`
      ? jsonRes([{ id: 'p1', code: 'old', name: 'Old', revoked: true, quota_monthly: 5, token_budget_monthly: null }])
      : undefined,
  );
  const plans = await svc(f.fetchImpl).listPlans({ includeRevoked: true });
  expect(plans).toEqual([
    {
      id: 'p1',
      code: 'old',
      name: 'Old',
      description: null,
      durationDays: null,
      rateLimitRpm: null,
      rateLimitBurst: null,
      quotaMonthly: 5,
      tokenBudgetMonthly: null,
      revoked: true,
      createdAt: null,
    },
  ]);
});

test('updatePlan {revoked}: a licences that rejects it (400) or ignores it (2xx, not revoked) → PlanRetireUnsupportedError', async () => {
  const rejects = makeFetch((url, method) =>
    method === 'PATCH' && url === `${BASE}/plans/p1` ? jsonRes({ detail: 'No fields to update' }, 400) : undefined,
  );
  await expect(svc(rejects.fetchImpl).updatePlan('p1', { revoked: true })).rejects.toBeInstanceOf(
    PlanRetireUnsupportedError,
  );
  const ignores = makeFetch((url, method) =>
    method === 'PATCH' && url === `${BASE}/plans/p1` ? jsonRes({ id: 'p1', code: 'x', name: 'x', revoked: false }) : undefined,
  );
  await expect(svc(ignores.fetchImpl).updatePlan('p1', { revoked: true })).rejects.toBeInstanceOf(
    PlanRetireUnsupportedError,
  );
  const supports = makeFetch((url, method) =>
    method === 'PATCH' && url === `${BASE}/plans/p1` ? jsonRes({ id: 'p1', code: 'x', name: 'x', revoked: true }) : undefined,
  );
  expect((await svc(supports.fetchImpl).updatePlan('p1', { revoked: true })).revoked).toBe(true);
});

test('createPlan posts app_id (resolved from the key) + snake-cased fields', async () => {
  const f = makeFetch(
    resolveOr((url, method) =>
      method === 'POST' && url === `${BASE}/plans` ? jsonRes({ id: 'p2', code: 'pro', name: 'Pro', revoked: false }, 201) : undefined,
    ),
  );
  await svc(f.fetchImpl).createPlan({ code: 'pro', name: 'Pro', quotaMonthly: 10, rateLimitRpm: 60 });
  const body = JSON.parse(f.calls.find((c) => c.method === 'POST' && c.url === `${BASE}/plans`)!.body!);
  expect(body).toEqual({ app_id: APP_ID, code: 'pro', name: 'Pro', quota_monthly: 10, rate_limit_rpm: 60 });
});

test('⛔ clearing a FUTURE start: requested start null vs an existing licence starting in 2031 → termsMatch:false', async () => {
  // The auditor's probe: a 2031 start cleared to null came back as the OLD future-dated licence
  // while CP showed `startsAt: null`, because a null request skipped the start comparison.
  const f = makeFetch(
    resolveOr((url, method) =>
      method === 'POST' && url === `${BASE}/licenses/user/sub-9`
        ? jsonRes({ license_id: 'lic-2031', subject_id: 's', plan_id: PLAN_ID, starts_at: '2031-01-01T00:00:00+00:00', expires_at: null }, 201)
        : undefined,
    ),
  );
  const out = await svc(f.fetchImpl).createLicense('sub-9', 't-9', { planCode: 'standard', startsAt: null });
  expect(out.termsMatch).toBe(false);
});

test('a null start is satisfied by a start already reached (a fresh mint stamps now)', async () => {
  const f = makeFetch(
    resolveOr((url, method) =>
      method === 'POST' && url === `${BASE}/licenses/user/sub-9`
        ? jsonRes({ license_id: 'lic-now', subject_id: 's', plan_id: PLAN_ID, starts_at: new Date(1000).toISOString(), expires_at: null }, 201)
        : undefined,
    ),
  );
  const out = await svc(f.fetchImpl).createLicense('sub-9', 't-9', { planCode: 'standard', startsAt: null });
  expect(out.termsMatch).toBe(true);
});

test('a CP tenant-licence holder (`cp-tenant:`) is minted with its own realm label, never as a portal person', async () => {
  const f = makeFetch(resolveOr(() => jsonRes({ license_id: 'l', subject_id: 's' }, 201)));
  await svc(f.fetchImpl).createLicense('cp-tenant:00000000-0000-4000-8000-000000000001:a', 't');
  await svc(f.fetchImpl).createLicense('sub-person', 't');
  const posts = f.calls.filter((c) => c.method === 'POST' && c.url.includes('/licenses/user/'));
  expect(JSON.parse(posts[0]!.body!).subject_realm).toBe('cp-tenant');
  expect(JSON.parse(posts[1]!.body!).subject_realm).toBe(config.keycloak.realm);
});

test('getTenant carries the registry owner_key (migration 050) — and null, never a guess, when absent', async () => {
  const owned = makeFetch((url, method) =>
    method === 'GET' && url === `${BASE}/tenants/t-1`
      ? jsonRes({ id: 't-1', name: 'acme', owner_key: 'platform' })
      : undefined,
  );
  // ⛔ The offboard's archive gate reads this field: dropping it from the mapping makes every
  // tenant "owner unknown" (archive never runs); defaulting it would make every tenant "ours".
  expect(await svc(owned.fetchImpl).getTenant('t-1')).toEqual({ id: 't-1', name: 'acme', ownerKey: 'platform' });

  const legacy = makeFetch((url, method) =>
    method === 'GET' && url === `${BASE}/tenants/t-2` ? jsonRes({ id: 't-2', name: 'old' }) : undefined,
  );
  expect(await svc(legacy.fetchImpl).getTenant('t-2')).toEqual({ id: 't-2', name: 'old', ownerKey: null });
});

test('listTenantLicences: GET /licenses?status=active with X-Tenant-Id; app key + metadata.bundle carried; non-2xx throws', async () => {
  const TEN = '00000000-0000-4000-8000-0000000b0001';
  const f = makeFetch((url, method) =>
    method === 'GET' && url === `${BASE}/licenses?status=active`
      ? jsonRes([
          { id: 'l1', tenant_id: TEN, status: 'active', app: { key: 'workers' }, metadata: { bundle: 'early-access' } },
          // adopted into a bundle: no metadata.bundle
          { id: 'l2', tenant_id: TEN, status: 'active', app: { key: 'kanban' }, metadata: null },
          { tenant_id: TEN, status: 'active' }, // no id → dropped
        ])
      : undefined,
  );
  const rows = await svc(f.fetchImpl).listTenantLicences(TEN);
  expect(rows).toEqual([
    { id: 'l1', tenantId: TEN, status: 'active', appKey: 'workers', bundle: 'early-access' },
    { id: 'l2', tenantId: TEN, status: 'active', appKey: 'kanban', bundle: null },
  ]);
  // ⛔ MUTATION TARGET: drop the header and licences lists the CALLER's tenant, not this one.
  const call = f.calls.find((c) => c.url === `${BASE}/licenses?status=active`)!;
  expect(call.headers['X-Tenant-Id']).toBe(TEN);

  const down = makeFetch(() => jsonRes({ detail: 'boom' }, 503));
  await expect(svc(down.fetchImpl).listTenantLicences(TEN)).rejects.toBeInstanceOf(LicensesAdminError);
  // A 200 that is not a list is a contract break, never "nothing to revoke".
  const odd = makeFetch(() => jsonRes({ detail: 'x' }));
  await expect(svc(odd.fetchImpl).listTenantLicences(TEN)).rejects.toThrow(/not a list/);
});
