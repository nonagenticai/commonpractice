// tests/config-validation.test.ts — the production fail-fast gate. Pure (no DB /
// network): validateProductionConfig only inspects the passed cfg object. Guards the
// hardening that a weak/short CP_SECRET_KEY or AGENT_JWT_SECRET (silently scrypt-derived
// into a low-entropy key) is rejected before a prod boot, not just the dev sentinel.
import { test, expect } from 'bun:test';
import {
  config,
  validateProductionConfig,
  meteringOutboxIntervalMs,
  METERING_OUTBOX_DEFAULT_INTERVAL_MS,
  METERING_OUTBOX_MIN_INTERVAL_MS,
} from '../src/config';
import { TICK_MIN_INTERVAL_MS, tickClaimWindowMs } from '../src/host/tick-locks';

const HEX_KEY = 'a'.repeat(64); // 32-byte hex — a real key
const B64_KEY = Buffer.alloc(32, 7).toString('base64'); // 32-byte base64 — a real key
const STRONG_SECRET = 's3cret-passphrase-long-enough'; // ≥16 chars

/** A minimal, otherwise-valid production config with leaf overrides. */
function prodCfg(over: Partial<{
  authBypass: boolean;
  keycloakUrl: string;
  jwtSecret: string;
  masterKey: string;
  env: string;
  userRealmAdminClientId: string;
  userRealmAdminClientSecret: string;
  migrateUrlExplicit: boolean;
  license: Partial<typeof config.license>;
  fr: Partial<typeof config.fr>;
  llm: Partial<typeof config.llm>;
}> = {}): typeof config {
  return {
    ...config,
    env: over.env ?? 'production',
    authBypass: over.authBypass ?? false,
    database: {
      ...config.database,
      url: 'postgresql://u:p@db/cp',
      migrateUrl: 'postgresql://owner:p@db/cp',
      // D.1.2: prod must set MIGRATE_DATABASE_URL explicitly (owner DSN for DDL/runAsSystem).
      migrateUrlExplicit: over.migrateUrlExplicit ?? true,
    },
    keycloak: {
      ...config.keycloak,
      url: over.keycloakUrl ?? 'https://auth.example',
      // The Keycloak admin client (client_credentials service account) is prod-required (invites).
      userRealmAdminClientId: over.userRealmAdminClientId ?? 'commonpractice-admin',
      userRealmAdminClientSecret: over.userRealmAdminClientSecret ?? 'kc-admin-secret',
    },
    agent: { ...config.agent, jwtSecret: over.jwtSecret ?? STRONG_SECRET },
    secrets: { masterKey: over.masterKey ?? HEX_KEY },
    // Production brokers to the inference-router; the mock LLM is refused.
    llm: {
      ...config.llm,
      mode: 'openai_compatible',
      openaiBaseUrl: 'http://inference-router.example:8150/api',
      ...(over.llm ?? {}),
    },
    // Published/user-authored blocks require a VM-isolated runtime in production.
    run: {
      ...config.run,
      backend: 'k8s',
      k8s: {
        ...config.run.k8s,
        runtimeClass: 'kata',
        image: 'registry.example/commonpractice-runner:test',
      },
    },
    license: { ...config.license, ...(over.license ?? {}) },
    // Phase 5 / 5D: the fr-bridge is live → its SA creds + a Gate-2 introspect URL are prod-required.
    fr: { ...config.fr, ...FR_OK, ...(over.fr ?? {}) },
  } as typeof config;
}

/** A fully-provisioned fr-bridge config (Phase 5 / 5D go-live). */
const FR_OK: Partial<typeof config.fr> = {
  licenseIntrospectUrl: 'https://licenses.example.com/license/introspect',
  sa: {
    tokenUrl: 'https://auth.example/realms/portal/protocol/openid-connect/token',
    clientId: 'commonpractice-bridge',
    clientSecret: 'shh',
  },
};

/** A fully-provisioned license-issuance SA config (Phase 4 / F.2). */
const ISSUANCE_OK: Partial<typeof config.license> = {
  issuanceEnabled: true,
  adminBaseUrl: 'https://licenses.example.com',
  sa: { tokenUrl: 'https://auth.example/realms/secure-apps/token', clientId: 'cp', clientSecret: 'shh' },
};

test('a fully-configured production config passes (hex or base64 key)', () => {
  expect(() => validateProductionConfig(prodCfg())).not.toThrow();
  expect(() => validateProductionConfig(prodCfg({ masterKey: B64_KEY }))).not.toThrow();
});

test('non-production short-circuits — weak secrets are allowed in dev', () => {
  expect(() =>
    validateProductionConfig(prodCfg({ env: 'development', masterKey: 'weak', jwtSecret: 'weak' })),
  ).not.toThrow();
});

test('production refuses same-pod or unisolated user-code execution', () => {
  const valid = prodCfg();
  expect(() =>
    validateProductionConfig({ ...valid, run: { ...valid.run, backend: 'subprocess' } }),
  ).toThrow(/RUN_BACKEND=k8s/);
  expect(() =>
    validateProductionConfig({
      ...valid,
      run: { ...valid.run, k8s: { ...valid.run.k8s, runtimeClass: 'runc' } },
    }),
  ).toThrow(/RUN_RUNTIME_CLASS/);
});

test('⛔ production refuses the MOCK LLM — a stale/typo LLM_MODE must not boot on canned answers', () => {
  expect(() => validateProductionConfig(prodCfg({ llm: { mode: 'mock' } }))).toThrow(
    /LLM_MODE=openai_compatible/,
  );
});

test('production refuses openai_compatible with no OPENAI_BASE_URL (keyless calls would hit the stub)', () => {
  expect(() => validateProductionConfig(prodCfg({ llm: { openaiBaseUrl: '' } }))).toThrow(/OPENAI_BASE_URL/);
  expect(() => validateProductionConfig(prodCfg({ llm: { openaiBaseUrl: '   ' } }))).toThrow(/OPENAI_BASE_URL/);
});

test('NON-VACUITY — the mock LLM with no router URL is still fine outside production (dev/CI)', () => {
  expect(() =>
    validateProductionConfig(prodCfg({ env: 'development', llm: { mode: 'mock', openaiBaseUrl: '' } })),
  ).not.toThrow();
});

test('a too-short CP_SECRET_KEY is rejected in production', () => {
  expect(() => validateProductionConfig(prodCfg({ masterKey: 'changeme' }))).toThrow(/CP_SECRET_KEY/);
});

test('the dev-sentinel CP_SECRET_KEY is rejected in production', () => {
  expect(() =>
    validateProductionConfig(prodCfg({ masterKey: 'dev-secret-key-change-me' })),
  ).toThrow(/CP_SECRET_KEY/);
});

test('a too-short AGENT_JWT_SECRET is rejected in production', () => {
  expect(() => validateProductionConfig(prodCfg({ jwtSecret: 'short' }))).toThrow(/AGENT_JWT_SECRET/);
});

test('AUTH_BYPASS=true is still rejected in production', () => {
  expect(() => validateProductionConfig(prodCfg({ authBypass: true }))).toThrow(/AUTH_BYPASS/);
});

test('a missing KEYCLOAK_URL is rejected in production', () => {
  expect(() => validateProductionConfig(prodCfg({ keycloakUrl: '' }))).toThrow(/KEYCLOAK_URL/);
});

test('an implicit MIGRATE_DATABASE_URL (fallback to DATABASE_URL) is rejected in production', () => {
  expect(() => validateProductionConfig(prodCfg({ migrateUrlExplicit: false }))).toThrow(
    /MIGRATE_DATABASE_URL/,
  );
});

test('missing Keycloak user-realm admin service-account creds are rejected in production (invites)', () => {
  expect(() => validateProductionConfig(prodCfg({ userRealmAdminClientId: '' }))).toThrow(
    /KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID/,
  );
  expect(() => validateProductionConfig(prodCfg({ userRealmAdminClientSecret: '' }))).toThrow(
    /KEYCLOAK_USER_REALM_ADMIN_CLIENT_SECRET/,
  );
});

test('the retired portal-realm admin SA is not required to boot (realm-per-app P7)', () => {
  // KEYCLOAK_ADMIN_CLIENT_ID/SECRET no longer exist in config; a prod config carrying only the
  // user-realm SA must validate. Non-vacuity: the test above proves the user-realm pair is checked.
  const cfg = prodCfg();
  expect('adminClientId' in cfg.keycloak).toBe(false);
  expect('adminClientSecret' in cfg.keycloak).toBe(false);
  expect(() => validateProductionConfig(cfg)).not.toThrow();
});

// ---- Phase 4 / F.2: license issuance SA creds are gated behind LICENSE_ISSUANCE_ENABLED ----

test('issuance OFF (the F.2 ship state) needs no SA creds — prod stays valid', () => {
  // default config.license.issuanceEnabled is false → the SA-cred checks don't apply
  expect(() => validateProductionConfig(prodCfg())).not.toThrow();
});

test('issuance ON with full SA creds passes', () => {
  expect(() => validateProductionConfig(prodCfg({ license: ISSUANCE_OK }))).not.toThrow();
});

test('issuance ON but missing SA creds is rejected in production', () => {
  expect(() =>
    validateProductionConfig(prodCfg({ license: { ...ISSUANCE_OK, adminBaseUrl: '' } })),
  ).toThrow(/LICENSE_ADMIN_BASE_URL/);
  expect(() =>
    validateProductionConfig(
      prodCfg({ license: { ...ISSUANCE_OK, sa: { tokenUrl: '', clientId: 'cp', clientSecret: 'shh' } } }),
    ),
  ).toThrow(/LICENSE_SA_TOKEN_URL/);
  expect(() =>
    validateProductionConfig(
      prodCfg({ license: { ...ISSUANCE_OK, sa: { tokenUrl: 'u', clientId: '', clientSecret: 'shh' } } }),
    ),
  ).toThrow(/LICENSE_SA_CLIENT_ID/);
  expect(() =>
    validateProductionConfig(
      prodCfg({ license: { ...ISSUANCE_OK, sa: { tokenUrl: 'u', clientId: 'cp', clientSecret: '' } } }),
    ),
  ).toThrow(/LICENSE_SA_CLIENT_SECRET/);
});

// ---- Phase 5 / 5D: the fr-bridge is live ('fr' ∈ SUPPORTED_FORWARD_KINDS) → its SA creds + a
// Gate-2 introspect URL are unconditionally prod-required (every fr forward mints the SA JWT + runs Gate 2).

test('fr bridge: a fully-provisioned fr config passes', () => {
  expect(() => validateProductionConfig(prodCfg())).not.toThrow();
});

test('fr bridge: missing SA token URL / secret is rejected in production', () => {
  expect(() =>
    validateProductionConfig(prodCfg({ fr: { ...FR_OK, sa: { ...FR_OK.sa!, tokenUrl: '' } } })),
  ).toThrow(/FR_BRIDGE_TOKEN_URL/);
  expect(() =>
    validateProductionConfig(prodCfg({ fr: { ...FR_OK, sa: { ...FR_OK.sa!, clientSecret: '' } } })),
  ).toThrow(/FR_BRIDGE_CLIENT_SECRET/);
});

test('fr bridge: no Gate-2 introspect URL (neither fr nor license) is rejected in production', () => {
  expect(() =>
    validateProductionConfig(prodCfg({ fr: { ...FR_OK, licenseIntrospectUrl: '' } })),
  ).toThrow(/FR_LICENSE_INTROSPECT_URL or LICENSE_INTROSPECT_URL/);
});

test('fr bridge: license.introspectUrl alone satisfies Gate-2 (fr override empty)', () => {
  expect(() =>
    validateProductionConfig(
      prodCfg({
        fr: { ...FR_OK, licenseIntrospectUrl: '' },
        license: { introspectUrl: 'https://licenses.example.com/license/introspect' },
      }),
    ),
  ).not.toThrow();
});

// ---- Phase 4 / F.1: "gate 2 enabled ⇒ introspect URL required" is ENVIRONMENT-INDEPENDENT ------
//
// ⛔ THE DEFECT. This pair used to sit INSIDE `validateProductionConfig`'s prod-only block, behind
// `if (cfg.env !== 'production') return;`. So a staging / preview / dev pod could boot cleanly with
// `LICENSE_GATE_2_ENABLED=true` and an empty `LICENSE_INTROSPECT_URL`, report healthy, and then fail
// EVERY non-exempt request forever: `services/license-client.ts` throws `LicenseClientError(500,
// 'license introspect URL not configured')` per request, and `middleware/license-gate.ts` cannot
// distinguish that from the 503 transport case — so every tenant receives `402 license_unavailable`,
// which the SPA renders as "we can't complete the licence check right now; access resumes
// automatically as soon as it succeeds". It never does. One unset variable bricks the whole
// environment behind a message telling everybody to wait.
//
// The check is a statement about the CONFIG, not about the deployment tier: the flag combination is
// unusable everywhere it is set. So it runs everywhere.

test('⛔ gate 2 ON with no introspect URL is rejected OUTSIDE production too', () => {
  // The exact shape that used to boot happily. `staging` is the tier that actually did this.
  expect(() =>
    validateProductionConfig(
      prodCfg({ env: 'staging', license: { enforceGate2: true, introspectUrl: '' } }),
    ),
  ).toThrow(/LICENSE_INTROSPECT_URL/);
  // …and in development, which is where a developer meets it first.
  expect(() =>
    validateProductionConfig(
      prodCfg({ env: 'development', license: { enforceGate2: true, introspectUrl: '' } }),
    ),
  ).toThrow(/LICENSE_INTROSPECT_URL/);
});

test('gate 2 ON with no app key is rejected outside production too', () => {
  expect(() =>
    validateProductionConfig(
      prodCfg({
        env: 'staging',
        license: {
          enforceGate2: true,
          introspectUrl: 'https://licenses.example.com/license/introspect',
          appKey: '',
        },
      }),
    ),
  ).toThrow(/LICENSE_APP_KEY/);
});

test('⛔ NON-VACUITY — gate 2 OFF outside production still boots with nothing configured', () => {
  // Without this, "throw whenever the licence config is empty" would satisfy the two tests above
  // while making every dev machine and every `bun test` run unbootable — the flag is DEFAULT-OFF
  // (F.1) and an unconfigured gate is the normal state everywhere except prod.
  expect(() =>
    validateProductionConfig(
      prodCfg({
        env: 'development',
        masterKey: 'weak',
        jwtSecret: 'weak',
        license: { enforceGate2: false, introspectUrl: '', appKey: '' },
      }),
    ),
  ).not.toThrow();
});

test('gate 2 ON and fully configured is fine in any environment', () => {
  // The other half of non-vacuity: the check must be about the MISSING URL, not about the flag.
  expect(() =>
    validateProductionConfig(
      prodCfg({
        env: 'staging',
        license: {
          enforceGate2: true,
          introspectUrl: 'https://licenses.example.com/license/introspect',
          appKey: 'commonpractice',
        },
      }),
    ),
  ).not.toThrow();
  expect(() => validateProductionConfig(prodCfg({ license: { enforceGate2: true, introspectUrl: 'https://licenses.example.com/license/introspect' } }))).not.toThrow();
});

test('production still rejects the same pair — hoisting the check did not lose the prod guard', () => {
  expect(() =>
    validateProductionConfig(prodCfg({ license: { enforceGate2: true, introspectUrl: '' } })),
  ).toThrow(/LICENSE_INTROSPECT_URL/);
});

// ---- METERING_OUTBOX_INTERVAL_MS: the drain period, and the clamp that is a PRECONDITION ---------
//
// The period was a bare literal in host/metering-outbox-drainer.ts — the one knob deciding how long
// already-committed LLM spend sits undelivered to billing, changeable only by a code deploy. Making
// it configurable creates an obligation that `host/tick-locks.ts tickClaimWindowMs` states in its own
// docblock: its "the window is strictly below the period" guarantee is NOT unconditional — it fails
// for `periodMs <= 0` and `NaN` — and it ends "⇒ A THIRD CALLER MUST CLAMP ITS OWN PERIOD." The
// drainer is now that third caller, so the clamp ships with the knob rather than after an incident.
//
// ⚠️ `int()` accepts "0" and "-1" VERBATIM (only unparseable garbage falls back to the default), so
// without the clamp `METERING_OUTBOX_INTERVAL_MS=0` genuinely reaches `setTimeout(fn, 0)`: an
// unbounded re-arm loop firing two DB queries per event-loop turn, on every replica, forever.
//
// Tested through the exported pure helper rather than `config.metering.outboxIntervalMs`, which is
// frozen at module load from an env this process cannot re-read.

test('METERING_OUTBOX_INTERVAL_MS defaults to 30 000 when unset or unparseable', () => {
  // Unset is the normal state everywhere but a deployment that deliberately tunes it, and the
  // default must equal the literal it replaced or this "configurable" change silently re-cadences
  // every existing deployment on its next roll.
  expect(meteringOutboxIntervalMs(undefined)).toBe(METERING_OUTBOX_DEFAULT_INTERVAL_MS);
  expect(METERING_OUTBOX_DEFAULT_INTERVAL_MS).toBe(30_000);
  expect(meteringOutboxIntervalMs('')).toBe(30_000);
  expect(meteringOutboxIntervalMs('thirty seconds')).toBe(30_000);
});

test('⛔ zero and negative are CLAMPED — setTimeout(fn, 0) would busy-drain every replica', () => {
  // ⚠️ MUTATION TARGET: drop the `Math.max(METERING_OUTBOX_MIN_INTERVAL_MS, …)` and these read 0 and
  // -1. Nothing downstream rejects them: `setTimeout` accepts both as "next tick", the pod stays
  // Ready, and the only symptom is a DB and a Redis being hammered by a scheduler nobody suspects.
  expect(meteringOutboxIntervalMs('0')).toBe(METERING_OUTBOX_MIN_INTERVAL_MS);
  expect(meteringOutboxIntervalMs('-1')).toBe(METERING_OUTBOX_MIN_INTERVAL_MS);
  expect(METERING_OUTBOX_MIN_INTERVAL_MS).toBeGreaterThan(0);
});

test('a deliberate interval is honoured VERBATIM — the clamp is a floor, not an opinion', () => {
  // Non-vacuity for the case above: "clamp everything to 30 000" would satisfy both tests before
  // this one while making the knob inert, which is the failure mode that reads as a working feature.
  expect(meteringOutboxIntervalMs('5000')).toBe(5_000);
  expect(meteringOutboxIntervalMs('120000')).toBe(120_000);
});

test('⛔ the claim window stays strictly BELOW the period at every settable value', () => {
  // THE INVARIANT THE WHOLE CLAMP EXISTS FOR, asserted end to end rather than trusted. A window that
  // reaches or exceeds the period means one pod's early tick suppresses every other pod's legitimate
  // drain — and it does so SILENTLY: the scheduled path calls `claimTick` with `refusal:'expected'`,
  // so the refusals log at `info` and are indistinguishable from ordinary leader election. The
  // symptom is a drainer running at a fraction of its configured rate with nothing saying so.
  //
  // `TICK_MIN_INTERVAL_MS.meteringOutbox` (25 s) was written against a hard-coded 30 s period; at
  // 20 s a fixed window would EXCEED the period, which is precisely why the drainer derives it.
  for (const raw of ['0', '-1', '1000', '5000', '20000', undefined, '30000', '120000']) {
    const period = meteringOutboxIntervalMs(raw);
    const window = tickClaimWindowMs(period, TICK_MIN_INTERVAL_MS.meteringOutbox);
    expect(window).toBeLessThan(period);
  }
  // …and at the DEFAULT period the registry entry still decides the window, so this change is
  // behaviour-preserving for every deployment that sets nothing.
  expect(
    tickClaimWindowMs(METERING_OUTBOX_DEFAULT_INTERVAL_MS, TICK_MIN_INTERVAL_MS.meteringOutbox),
  ).toBe(TICK_MIN_INTERVAL_MS.meteringOutbox);
});
