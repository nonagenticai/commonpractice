// tests/auth-bypass-guard.test.ts — the AUTH_BYPASS flag's NON-bypass branch.
//
// ⛔ THE DEFECT THIS FILE EXISTS FOR. `middleware/auth.ts` decides whether an anonymous request
// is answered as a synthetic **super_admin in the demo tenant** from one expression:
//
//     if (process.env.AUTH_BYPASS === 'true') return bypassUser();
//
// Until this file, ZERO tests read `process.env.AUTH_BYPASS` at all. `tests/setup-env.ts:3` pins it
// to 'true' for the whole suite, so all 1618 tests only ever exercised the branch that IS taken —
// the branch that refuses is what production runs, and nothing covered it. Widen the comparison by
// one token (`=== 'true'` → `!== 'false'`) and production, where the var is simply UNSET, hands
// every unauthenticated caller a super_admin session. The suite stayed green.
//
// ⛔ AND THE PRODUCTION FAIL-FAST COULD NOT SEE IT EITHER. `config.ts` reads the same var a SECOND,
// independent time (`authBypass: AUTH_BYPASS === 'true'`), and `validateProductionConfig` gates on
// THAT copy — never on the middleware's own expression. So the mutated build boots clean: the gate
// computes `false` from an unset var while the middleware computes `true` from the same unset var.
// Two readings of one flag, free to disagree, with an anonymous-super_admin hole in the gap. Both
// now call `authBypassEnabled()` in config.ts, and the last test here pins that they cannot drift:
// no env value may both bypass the middleware AND pass the production gate.
//
// ⛔ BEHAVIOUR, NEVER SPELLING. Nothing below greps the source for `=== 'true'` — that would ban a
// spelling, not a property. Every case drives the real middleware with a real Request and asserts
// what the caller gets: an identity, or a refusal.
//
// ⛔ THE ENV IS SHARED WITH THE REST OF THE SUITE, which relies on the bypass being on. Every case
// restores AUTH_BYPASS in a `finally`, and `afterAll` re-asserts the setup-env value.
import { test, expect, afterAll } from 'bun:test';
import {
  authenticateWithoutLicense,
  __setAuthOverridesForTests,
} from '../src/middleware/auth';
import {
  authBypassEnabled,
  config,
  validateProductionConfig,
  DEMO_TENANT_ID,
} from '../src/config';
import { UnauthorizedError } from '../src/types';

const SUITE_BYPASS = process.env.AUTH_BYPASS;

/** No Authorization header — the exact shape of an anonymous public request. */
const anonymousRequest = () => new Request('http://cp.test/api/solutions');

/**
 * Run `fn` with AUTH_BYPASS set to `raw` (or DELETED, which is what production actually looks
 * like — the var is absent from the deployment, not set to 'false'), then put the suite's value
 * back whatever happens.
 */
async function withBypassEnv<T>(raw: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.AUTH_BYPASS;
  // The test override seam short-circuits ahead of the flag; an earlier file that leaked one
  // would make every case below vacuous, so the clean state is asserted rather than assumed.
  __setAuthOverridesForTests(undefined);
  if (raw === undefined) delete process.env.AUTH_BYPASS;
  else process.env.AUTH_BYPASS = raw;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.AUTH_BYPASS;
    else process.env.AUTH_BYPASS = before;
  }
}

/** Did the middleware answer an anonymous request with an identity? */
async function bypassed(): Promise<boolean> {
  try {
    await authenticateWithoutLicense(anonymousRequest());
    return true;
  } catch (e) {
    // Only the "no credentials" refusal counts as a refusal; anything else is a broken test.
    expect(e, 'the middleware failed for a reason other than refusing the caller').toBeInstanceOf(
      UnauthorizedError,
    );
    return false;
  }
}

afterAll(() => {
  expect(
    process.env.AUTH_BYPASS,
    'this file leaked its env mutation into the rest of the suite',
  ).toBe(SUITE_BYPASS);
});

// ---- the branch nothing covered ----

test('THE DEFECT: with AUTH_BYPASS UNSET (production), an anonymous request is refused', async () => {
  await withBypassEnv(undefined, async () => {
    expect(await bypassed()).toBe(false);
  });
});

test('an explicit AUTH_BYPASS=false refuses too', async () => {
  await withBypassEnv('false', async () => {
    expect(await bypassed()).toBe(false);
  });
});

test('NO LOOK-ALIKE VALUE opens the bypass — only the exact string does', async () => {
  // Kills the "helpful" widenings: `!!AUTH_BYPASS`, `!== 'false'`, a case-insensitive compare, a
  // truthy-string parser. A deploy that typed `AUTH_BYPASS=1` must get a CLOSED door, not an open
  // one, because the operator who typed it is not the one who reads this line.
  for (const raw of ['1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ', '']) {
    await withBypassEnv(raw, async () => {
      expect(await bypassed(), `AUTH_BYPASS=${JSON.stringify(raw)} opened the bypass`).toBe(false);
    });
  }
});

// ---- the branch the whole suite runs on, so the cases above cannot be vacuously green ----

test('AUTH_BYPASS=true still synthesises the dev super_admin in the demo tenant', async () => {
  await withBypassEnv('true', async () => {
    const user = await authenticateWithoutLicense(anonymousRequest());
    expect(user.roles).toEqual(['super_admin']);
    expect(user.tenantId).toBe(DEMO_TENANT_ID);
    expect(user.email).toBe('dev@localhost');
  });
});

// ---- the two independent reads ----

test('the middleware and config read AUTH_BYPASS identically at every input', async () => {
  // `config.authBypass` is a boot-time SNAPSHOT and cannot be re-read here; `authBypassEnabled()`
  // is the expression it is built from, and is what the middleware now calls too. Comparing the
  // middleware's live decision against that one function at each input is what makes "the two
  // reads cannot diverge" a test rather than a comment.
  for (const raw of [undefined, 'true', 'false', 'TRUE', '1', '']) {
    await withBypassEnv(raw, async () => {
      expect(await bypassed(), `disagreement at AUTH_BYPASS=${JSON.stringify(raw)}`).toBe(
        authBypassEnabled(),
      );
    });
  }
});

/** An otherwise-fully-valid production config (mirrors tests/config-validation.ts's `prodCfg`)
 *  whose ONE live field is `authBypass`, taken from the same helper the middleware consults. */
function prodCfgFromEnv(): typeof config {
  return {
    ...config,
    env: 'production',
    authBypass: authBypassEnabled(),
    database: {
      ...config.database,
      url: 'postgresql://u:p@db/cp',
      migrateUrl: 'postgresql://owner:p@db/cp',
      migrateUrlExplicit: true,
    },
    keycloak: {
      ...config.keycloak,
      url: 'https://auth.example',
      userRealmAdminClientId: 'commonpractice-admin',
      userRealmAdminClientSecret: 'kc-admin-secret',
    },
    agent: { ...config.agent, jwtSecret: 's3cret-passphrase-long-enough' },
    secrets: { masterKey: 'a'.repeat(64) },
    llm: {
      ...config.llm,
      mode: 'openai_compatible',
      openaiBaseUrl: 'http://inference-router.example:8150/api',
    },
    run: {
      ...config.run,
      backend: 'k8s',
      k8s: {
        ...config.run.k8s,
        runtimeClass: 'kata',
        image: 'registry.example/commonpractice-runner:test',
      },
    },
    fr: {
      ...config.fr,
      licenseIntrospectUrl: 'https://licenses.example.com/license/introspect',
      sa: {
        tokenUrl: 'https://auth.example/realms/portal/protocol/openid-connect/token',
        clientId: 'commonpractice-bridge',
        clientSecret: 'shh',
      },
    },
  } as typeof config;
}

test('NO env value both bypasses the middleware and passes the production fail-fast', async () => {
  // The security property, stated end to end: a build in which an anonymous caller becomes
  // super_admin must not be able to boot in production. Before the shared helper, AUTH_BYPASS
  // unset satisfied both halves of that sentence at once — the middleware opened the door and the
  // gate, reading its own separate copy, saw nothing to complain about.
  //
  // Non-vacuity: the config is otherwise valid, so `AUTH_BYPASS=true` is the ONLY reason it can
  // throw, and the un-bypassed values must leave it booting cleanly.
  for (const raw of [undefined, 'true', 'false', 'TRUE', '1', 'yes', '']) {
    await withBypassEnv(raw, async () => {
      const label = `AUTH_BYPASS=${JSON.stringify(raw)}`;
      if (await bypassed()) {
        expect(
          () => validateProductionConfig(prodCfgFromEnv()),
          `${label} bypasses auth yet boots production`,
        ).toThrow(/AUTH_BYPASS/);
      } else {
        expect(
          () => validateProductionConfig(prodCfgFromEnv()),
          `${label} refuses anonymous callers yet is rejected as a bypass build`,
        ).not.toThrow();
      }
    });
  }
});
