// keycloak-import-safety.test.ts — importing the Keycloak service must not require KEYCLOAK_URL.
//
// ⛔ WHAT THIS PINS. `services/keycloak.ts` used to build `createRemoteJWKSet(new URL(JWKS_URL))`
// at MODULE SCOPE. `new URL()` throws `ERR_INVALID_URL` on a relative string, and with
// `KEYCLOAK_URL` unset `JWKS_URL` is exactly that — `/realms/portal/protocol/openid-connect/certs`.
// At module scope that throw lands at IMPORT time, so the process dies before `server.ts` runs.
// Measured 2026-08-12 standing up a local `AUTH_BYPASS=true` stack: the backend exited with
// `ERR_INVALID_URL` at `keycloak.ts:19` and never listened.
//
// ⚠️ WHY THIS IS NOT "WEAKENING A PRODUCTION GUARD". `config.ts`'s `validateProductionConfig`
// already requires `KEYCLOAK_URL` when `env === 'production'`, and its docblock states the intended
// asymmetry outright — "In dev with AUTH_BYPASS the Keycloak URL is allowed to be a placeholder; in
// production it is required." The module-scope throw fired in EVERY mode and so contradicted the
// only layer that knows the mode. That prod requirement is asserted below too, so this file goes
// red in BOTH directions: if the eager URL returns, and if the prod check is ever dropped.
//
// ⛔⛔ WHY THIS SPAWNS A SUBPROCESS INSTEAD OF JUST `delete process.env.KEYCLOAK_URL` + `import()`.
// THE FIRST DRAFT DID EXACTLY THAT AND WAS SILENTLY VACUOUS — it passed against the DEFECT.
// `tests/setup-env.ts` runs `process.env.KEYCLOAK_URL ||= 'http://localhost:8080'` before anything
// imports, and `config` is evaluated ONCE per process. So by the time a test body deletes the
// variable, `config.keycloak.url` is already a valid absolute URL and `new URL()` can never throw,
// eager or lazy. Measured: with the eager construction restored, that draft reported 3 pass / 0 fail.
//
// The defect is a property of PROCESS BOOT, so the only honest test boots a process. Same lesson,
// same session, as the frontend locale guard — see memory `a-non-vacuity-proof-can-itself-be-vacuous`.
import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, '../src/services/keycloak.ts');

/**
 * Import the module in a FRESH bun process with a controlled environment, and report how it exited.
 * `KEYCLOAK_URL` is removed from the inherited env rather than set to '' so this covers the real
 * deployment shape (variable simply absent).
 */
async function importInFreshProcess(env: Record<string, string | undefined>) {
  const child = Bun.spawn(
    ['bun', '-e', `await import(${JSON.stringify(MODULE)}); console.log('IMPORT_OK');`],
    {
      env: { ...process.env, ...env } as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('keycloak service — importing it must not need a Keycloak URL', () => {
  it('THE DEFECT — a fresh process importing it with KEYCLOAK_URL ABSENT must not die', async () => {
    const r = await importInFreshProcess({ KEYCLOAK_URL: undefined, AUTH_BYPASS: 'true' });
    // The precise pre-fix failure, asserted by name so a future regression is unmistakable.
    expect(r.stderr).not.toContain('ERR_INVALID_URL');
    expect(r.stderr).not.toContain('cannot be parsed as a URL');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('IMPORT_OK');
  }, 30_000);

  it('an EMPTY-STRING KEYCLOAK_URL is the same hazard and is also survived', async () => {
    const r = await importInFreshProcess({ KEYCLOAK_URL: '', AUTH_BYPASS: 'true' });
    expect(r.stderr).not.toContain('ERR_INVALID_URL');
    expect(r.exitCode).toBe(0);
  }, 30_000);

  it('a VALID KEYCLOAK_URL still imports — the fix is not "never build the resolver"', async () => {
    // ⛔ NON-VACUITY. Without this, deleting the resolver entirely would keep the two cases above
    // green. This asserts the normal path still works, in the same harness.
    const r = await importInFreshProcess({
      KEYCLOAK_URL: 'https://auth.example.test',
      AUTH_BYPASS: 'true',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('IMPORT_OK');
  }, 30_000);

  it('⛔ the resolver keeps jose\'s own properties — a bare wrapper silently narrows them', async () => {
    // ⛔ NON-VACUITY FOR THE DEFERRAL ITSELF. `createRemoteJWKSet` does not return a plain function:
    // on jose@5.10.0 it carries ["coolingDown","fresh","reload","reloading","jwks"]. A naive
    // `(h, t) => realmJWKS()(h, t)` wrapper typechecks fine — `JWTVerifyGetKey` is a call signature
    // only — while dropping every one of them. This asserts the forwarding block is present, so the
    // wrapper cannot be "simplified" back into a shape-narrowing one.
    //
    // Compared against the LIVE jose export rather than a hardcoded list, so a jose upgrade that
    // adds or renames a property surfaces here instead of years later at a key rotation.
    const { createRemoteJWKSet } = await import('jose');
    const real = createRemoteJWKSet(new URL('https://auth.example.test/certs'));
    const expected = Object.getOwnPropertyNames(real).filter(
      (k) => !['length', 'name', 'prototype'].includes(k),
    );
    expect(expected.length).toBeGreaterThan(0); // guard: if jose ever returns a bare fn, say so loudly

    // No env fiddling needed: `setup-env.ts` already supplies a valid KEYCLOAK_URL in-process, and
    // `in` does not invoke the getters, so this never builds a resolver or touches the network.
    const { defaultJWKS } = await import('../src/services/keycloak');
    // Asserted as a SET rather than key-by-key so a failure names every missing property at once
    // and reads in the natural direction (received = what the wrapper actually has).
    const got = expected.filter((k) => k in (defaultJWKS as unknown as object));
    expect(got.sort()).toEqual([...expected].sort());
  });

  it('⛔ the PRODUCTION requirement is untouched — validateProductionConfig still demands it', async () => {
    // ⛔ NON-VACUITY IN THE OTHER DIRECTION: deleting the config check would make production
    // genuinely more permissive while every case above stayed green. That is the real risk of this
    // change and the thing a reviewer should ask about.
    //
    // ⚠️ Spread the REAL config rather than hand-rolling one — a literal omits fields this function
    // reads on the way down (it died on `cfg.agent.jwtSecret` before reaching the Keycloak branch),
    // so it would have asserted nothing. `missing` is joined into ONE message, so other absent prod
    // values cannot mask this one.
    const { config, validateProductionConfig } = await import('../src/config');
    const cfg = {
      ...config,
      env: 'production',
      authBypass: false,
      keycloak: { ...config.keycloak, url: '' },
    } as typeof config;
    expect(() => validateProductionConfig(cfg)).toThrow(/KEYCLOAK_URL/);

    const ok = { ...cfg, keycloak: { ...config.keycloak, url: 'https://auth.example/' } };
    let msg = '';
    try {
      validateProductionConfig(ok as typeof config);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toMatch(/KEYCLOAK_URL(?![_A-Z])/);
  });
});
