// tests/license-token-unreadable.test.ts
//
// ⛔ A LICENCE WE CANNOT READ IS NOT A LICENCE THE CUSTOMER NEVER BOUGHT.
//
// `tenantLicenseToken` used to end in `tryDecryptSecret(...)`, which swallows the decrypt failure
// and returns `null`. Two completely different facts arrived at the enforcement gate as the same
// value:
//
//     (a) this tenant has NO stored licence blob        → genuinely unlicensed
//     (b) this tenant HAS one and we cannot decrypt it  → an infrastructure fault
//
// The gate maps `null` to `402 license_required`, which the SPA renders as the terminal
// "your workspace has no active Common Practice licence — contact your administrator" wall with a
// Renew CTA. So a wrong or rotated `CP_SECRET_KEY` de-licenses EVERY TENANT AT ONCE behind a
// message accusing all of them of not paying, and renewing cannot fix it. The same conflation on
// the platform `/tenants` list labelled such a tenant `none` — on the screen an operator uses to
// decide whether to chase a customer for money.
//
// ⚠️ THESE TESTS DRIVE THE REAL LOADERS AND THE REAL GATE ON PURPOSE. `license-status.ts` has a
// dependency-injection seam (`__setLicenseStatusDepsForTests`) and using it here would be VACUOUS:
// `loadToken`/`loadTokens` ARE the broken code, so stubbing them tests the stub. These write real
// rows and real secret-box blobs.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { db, tenants } from '../src/db/client';
import { config } from '../src/config';
import { encryptSecret } from '../src/host/secret-box';
import {
  tenantLicenseToken,
  tenantLicenseTokens,
  LicenseTokenUnreadableError,
  LICENSE_TOKEN_UNREADABLE,
  licenseStatesForTenants,
  __setLicenseStatusDepsForTests,
  __resetLicenseStatusDepsForTests,
  type BatchToken,
} from '../src/lib/license-status';
import { assertTenantLicensed } from '../src/middleware/license-gate';
import {
  __setLicenseClientForTests,
  type LicenseClient,
} from '../src/services/license-client';
import { HttpError } from '../src/utils/http';
import { renderMetrics } from '../src/host/metrics';
import { revokeTenantLicense } from '../src/services/license-provisioning';

/**
 * Current value of `license_token_unreadable_total` (0 when unseen). `renderMetrics` prefixes every
 * name with `commonpractice_`, hence the leading `\\w*` — an anchored bare-name regex silently
 * matches nothing and makes every before/after comparison read `0 === 0`.
 */
function unreadableCount(): number {
  const m = /^\w*license_token_unreadable_total (\d+)$/m.exec(renderMetrics());
  return m ? Number(m[1]) : 0;
}

const T_UNREADABLE = '00000000-0000-0000-0000-0000000f7a01'; // holds a blob that will not decrypt
const T_NOTOKEN = '00000000-0000-0000-0000-0000000f7a02'; // genuinely has none
const T_GOOD = '00000000-0000-0000-0000-0000000f7a03'; // holds a readable blob

const ALL = [T_UNREADABLE, T_NOTOKEN, T_GOOD];

/** A syntactically valid base64 blob that is long enough to reach GCM tag verification and fail it
 *  — i.e. exactly what a row encrypted under a DIFFERENT master key looks like to us. */
const CORRUPT_BLOB = Buffer.alloc(64, 7).toString('base64');

const originalGate = config.license.enforceGate2;
const originalKey = config.secrets.masterKey;

/** `config` is deep-readonly by type; these are the repo's sanctioned narrow casts for flipping a
 *  single knob in a test (same idiom as tests/license-gate.test.ts:53). */
const setGate = (on: boolean): void => {
  (config.license as { enforceGate2: boolean }).enforceGate2 = on;
};
const setMasterKey = (key: string): void => {
  (config.secrets as { masterKey: string }).masterKey = key;
};

beforeEach(async () => {
  await db.delete(tenants).where(inArray(tenants.id, ALL));
  await db.insert(tenants).values([
    { id: T_UNREADABLE, name: 'unreadable', slug: 'lic-unreadable', license_token_encrypted: CORRUPT_BLOB },
    { id: T_NOTOKEN, name: 'notoken', slug: 'lic-notoken', license_token_encrypted: null },
    { id: T_GOOD, name: 'good', slug: 'lic-good', license_token_encrypted: encryptSecret('tok-good') },
  ]);
  setGate(originalGate);
  setMasterKey(originalKey);
}, 30_000);

afterAll(async () => {
  setGate(originalGate);
  setMasterKey(originalKey);
  __setLicenseClientForTests(undefined);
  await db.delete(tenants).where(inArray(tenants.id, ALL));
}, 30_000);

// ── the loader itself ─────────────────────────────────────────────────────────────────────────

test('THE DEFECT — an unreadable blob THROWS; it must not masquerade as "no licence"', async () => {
  // Before the fix this resolved to `null`, indistinguishable from T_NOTOKEN below.
  await expect(tenantLicenseToken(T_UNREADABLE)).rejects.toBeInstanceOf(LicenseTokenUnreadableError);
});

test('a tenant with NO blob still returns null — the genuine license_required case is untouched', async () => {
  // ⛔ NON-VACUITY. Making the loader throw for everything would satisfy the test above while
  // breaking the real "this tenant was never licensed" path, which MUST stay a terminal state.
  await expect(tenantLicenseToken(T_NOTOKEN)).resolves.toBeNull();
});

test('a readable blob still decrypts to its token', async () => {
  await expect(tenantLicenseToken(T_GOOD)).resolves.toBe('tok-good');
});

// ── what the enforcement gate does with it ────────────────────────────────────────────────────

test('THE CONSEQUENCE — the gate answers the terminal license_unreadable, NOT license_required, AND counts the unreadable blob', async () => {
  setGate(true);
  const before = unreadableCount();
  // The licences service is never even reached, so no client is needed; if the gate DID reach it,
  // this fake would throw and we would still not get `license_required` — hence the explicit
  // assertion on the code below rather than on the status alone.
  const client: LicenseClient = {
    async introspect() {
      throw new Error('the gate must not get this far — it cannot read the token');
    },
  };
  __setLicenseClientForTests(client);

  const err = await assertTenantLicensed(new Request('http://x/api/flows'), T_UNREADABLE).then(
    () => null,
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(HttpError);
  const http = err as HttpError;
  expect(http.status).toBe(402);
  // ⛔ THE ASSERTION THAT IS THE ACTUAL FIX, AND IT STILL HOLDS: NOT `license_required`.
  // `license_required` renders "you have no licence, contact your administrator" + a Renew CTA.
  // That is false here — a blob demonstrably exists — and it was what every tenant saw at once
  // after a `CP_SECRET_KEY` rotation. This is the regression this test has always guarded.
  expect(http.code).not.toBe('license_required');

  // ⛔ AND IT IS THE TERMINAL CODE, NOT THE TRANSIENT ONE. `license_unavailable` renders copy whose
  // last sentence is a PROMISE — "access resumes automatically as soon as it succeeds" — plus a
  // Retry CTA. For a blob that will not decrypt that promise can never come true: the condition is
  // standing until an operator repairs `CP_SECRET_KEY`, and a rotated key breaks every tenant at
  // once, so the entire customer base would sit behind "hang on, this fixes itself" while nobody
  // looks for a fault. `license_unreadable` says an operator is needed and offers no CTA that lies.
  //
  // ⚠️ This assertion read `license_unavailable` for exactly one deploy, and that was deliberate,
  // not an oversight: the SPA half (#255) had to be live on every client before the backend could
  // emit a code an older cached bundle would not recognise — an unknown 402 is not in
  // `LICENSE_BLOCK_CODES`, so the interceptor never fires and NO block screen renders at all. The
  // full reasoning lives in src/middleware/license-gate.ts; frontend's
  // `error-message.backend-contract.test.ts` now enforces it mechanically for the next code.
  expect(http.code).toBe('license_unreadable');

  // ⛔ THE DISCRIMINATOR THAT OUTLIVED THE DEPLOY THAT NEEDED IT. This counter was the ONLY way to
  // separate "we cannot decrypt the blob" (standing, needs an operator) from "the licences DB
  // blipped" (self-healing) while the wire code answered `license_unavailable` for both. The wire
  // code now separates them too, which is exactly when a counter looks redundant and gets deleted —
  // it is not: alerting reads metrics, not 402 bodies, and a fleet-wide key rotation is a spike here
  // before it is a support ticket. Deleting the `incCounter` reddens on this line.
  expect(unreadableCount()).toBe(before + 1);
});

test('⛔ NON-VACUITY — an ORDINARY lookup failure does NOT bump license_token_unreadable_total', async () => {
  // Without this, moving `incCounter` out of the `instanceof` branch (or dropping the branch and
  // counting every catch) would satisfy the test above while making the counter mean "the licence
  // lookup failed somehow" — i.e. exactly the conflation the whole change exists to undo, moved
  // from the wire code into the metric.
  setGate(true);
  __setLicenseClientForTests({ async introspect() { throw new Error('unreached'); } });
  const before = unreadableCount();

  const err = await assertTenantLicensed(new Request('http://x/api/flows'), 'not-a-uuid').then(
    () => null,
    (e: unknown) => e,
  );
  expect((err as HttpError).code).toBe('license_unavailable');
  expect(unreadableCount()).toBe(before);
});

test('a NON-decrypt lookup failure is still the TRANSIENT license_unavailable', async () => {
  // ⛔ NON-VACUITY for the split above. Turning the whole catch block into `license_unreadable`
  // would satisfy the assertions above while relabelling a genuine DB blip — which DOES resolve on
  // its own — as a standing fault needing an operator. Only `LicenseTokenUnreadableError` is
  // terminal; every other throw out of the lookup keeps the retry-able code.
  setGate(true);
  __setLicenseClientForTests({ async introspect() { throw new Error('unreached'); } });

  const err = await assertTenantLicensed(new Request('http://x/api/flows'), 'not-a-uuid').then(
    () => null,
    (e: unknown) => e,
  );
  // A malformed tenant id makes the `runAsSystem` SELECT throw (invalid input syntax for uuid) —
  // a real, non-decrypt failure of the lookup, produced without stubbing the code under test.
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(402);
  expect((err as HttpError).code).toBe('license_unavailable');
});

test('a tenant with genuinely no token STILL gets license_required — the terminal case survives', async () => {
  setGate(true);
  __setLicenseClientForTests({ async introspect() { throw new Error('unreached'); } });

  const err = await assertTenantLicensed(new Request('http://x/api/flows'), T_NOTOKEN).then(
    () => null,
    (e: unknown) => e,
  );
  expect((err as HttpError).code).toBe('license_required');
});

// ── the platform /tenants list ────────────────────────────────────────────────────────────────

test('the batch SIGNALS unreadable per row instead of throwing — one bad row must not blank the page', async () => {
  const map = await tenantLicenseTokens(ALL);

  // Before the fix all three of these were `null` for the first two rows.
  expect(map.get(T_UNREADABLE)).toBe(LICENSE_TOKEN_UNREADABLE);
  expect(map.get(T_NOTOKEN)).toBeNull();
  // ⛔ The page survives: the healthy rows in the SAME batch still resolve.
  expect(map.get(T_GOOD)).toBe('tok-good');
});

// ── the fleet-wide case that made this worth fixing ───────────────────────────────────────────

test('⛔ A ROTATED CP_SECRET_KEY MUST NOT DE-LICENSE THE FLEET', async () => {
  // Every tenant's blob was written under the old key. Under the new one NONE of them decrypt —
  // which is precisely the scenario in which the old code told every paying customer, simultaneously,
  // that they had no licence and should contact their administrator.
  setMasterKey('a-completely-different-master-key-value');

  await expect(tenantLicenseToken(T_GOOD)).rejects.toBeInstanceOf(LicenseTokenUnreadableError);

  const map = await tenantLicenseTokens(ALL);
  expect(map.get(T_GOOD)).toBe(LICENSE_TOKEN_UNREADABLE);
  // The tenant that genuinely has no licence is unaffected by a key rotation — it has nothing to
  // decrypt. Its state is a fact about the customer, not about our key material.
  expect(map.get(T_NOTOKEN)).toBeNull();
});

// ── the CONSUMER of that signal, which is where the /tenants screen gets its label ────────────
//
// ⛔ THIS BRANCH WAS THE ONE UNGUARDED PIECE OF THIS FIX, AND ADVERSARIAL REVIEW FOUND IT.
// The tests above prove the LOADER returns the symbol. Nothing proved that `licenseStatesForTenants`
// turns it into `unknown` — so replacing that branch with `if (false)` left the whole 1461-test
// suite GREEN while restoring the original bug on the platform screen. A signal nobody reads is not
// a fix.
//
// ⚠️ Here the DI seam IS the right tool, unlike above: the code under test is the CONSUMER, and the
// loader it consumes is already covered by the real-DB tests above.
test('⛔ the /tenants screen reports `unknown` for an unreadable token — never `none`', async () => {
  setGate(true);
  const tokens = new Map<string, BatchToken>([
    [T_UNREADABLE, LICENSE_TOKEN_UNREADABLE],
    [T_NOTOKEN, null],
  ]);
  // ⛔ THIS FAKE MUST SUCCEED, NOT THROW, AND THAT IS THE WHOLE TEST.
  // A Symbol is TRUTHY. The first version of this test made `introspect` throw — so when the
  // symbol→`unknown` branch was deleted, the symbol fell through the `!token` check into
  // `introspect`, the fake threw, and the error path produced `unknown` ANYWAY. The test passed
  // against the bug for entirely the wrong reason (verified: mutating the branch to `if (false)`
  // left it green). Returning a healthy licence makes the mutation observable — the row would read
  // `active`, the most dangerous possible answer for a tenant we cannot verify at all.
  const introspected: string[] = [];
  __setLicenseStatusDepsForTests({
    loadTokens: async () => tokens,
    introspect: async (token) => {
      introspected.push(String(token));
      return {
        active: true,
        tenant_id: T_UNREADABLE,
        app: { key: 'commonpractice' },
        status: 'active',
        expires_at: null,
      };
    },
    now: () => new Date('2026-06-24T00:00:00Z'),
  });
  try {
    const states = await licenseStatesForTenants([T_UNREADABLE, T_NOTOKEN]);

    // ⛔ An unreadable token is never introspected — there is nothing to send.
    expect(introspected).toEqual([]);

    // The tenant whose blob we hold but cannot read.
    expect(states.get(T_UNREADABLE)?.state).toBe('unknown');
    expect(states.get(T_UNREADABLE)?.state).not.toBe('none');
    // ⛔ And it must NOT claim we have no token — a blob demonstrably exists, and this field is what
    // decides whether the repair needs `force` (routes/admin.ts: `if (t.token && !forced)`).
    expect(states.get(T_UNREADABLE)?.hasToken).toBe(true);

    // ⛔ NON-VACUITY: the genuinely unlicensed tenant must still read `none`, or "everything is
    // unknown" would satisfy the assertions above while destroying the screen's actual purpose.
    expect(states.get(T_NOTOKEN)?.state).toBe('none');
    expect(states.get(T_NOTOKEN)?.hasToken).toBe(false);
  } finally {
    __resetLicenseStatusDepsForTests();
  }
});

// ── the fail-OPEN site: revoke ────────────────────────────────────────────────────────────────
//
// ⛔ EVERYWHERE ELSE THIS CONFLATION DENIED ACCESS WRONGLY. HERE IT GRANTED IT.
// `revokeTenantLicense` did `tryDecryptSecret(blob)` then `if (!token) return; // nothing to
// revoke`. An unreadable blob took that path, so suspending or offboarding a tenant after a key
// rotation NEVER revoked the licence at licenses.example.com and never cleared the column — silently,
// while the platform believed the suspend had succeeded. Its own docblock promises the opposite:
// "Fail-loud (502) so a suspend can never silently leave an active license behind."
test('⛔ revoke REFUSES to report success when it cannot read the token it must revoke', async () => {
  const originalIssuance = config.license.issuanceEnabled;
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  try {
    const err = await revokeTenantLicense(T_UNREADABLE).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    // 502, not a raw 500: `as502` only converts LicensesAdminError, so this is thrown directly.
    expect((err as HttpError).status).toBe(502);

    // ⛔ AND THE COLUMN IS UNTOUCHED. Clearing it would destroy the only evidence that an upstream
    // licence exists, stranding it active forever with nothing left to revoke it with.
    const [row] = await db
      .select({ token: tenants.license_token_encrypted })
      .from(tenants)
      .where(eq(tenants.id, T_UNREADABLE));
    expect(row?.token).toBe(CORRUPT_BLOB);
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = originalIssuance;
  }
});

test('revoke is still a silent no-op when the tenant genuinely has no token', async () => {
  // ⛔ NON-VACUITY: making revoke throw unconditionally would satisfy the test above while breaking
  // every ordinary offboard of an unlicensed tenant.
  const originalIssuance = config.license.issuanceEnabled;
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  try {
    await expect(revokeTenantLicense(T_NOTOKEN)).resolves.toBeUndefined();
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = originalIssuance;
  }
});
