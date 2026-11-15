// scripts/backfill-licenses.ts — Phase 4 / F.2 go-live: issue a `commonpractice` license + token
// for every tenant that was onboarded BEFORE LICENSE_ISSUANCE_ENABLED was flipped on.
//
// Issuance is normally triggered inside onboarding (approve/invite/tenant-user-add). A tenant that
// already existed when the flag flips has no token and would 402 the moment Gate 2 (F.1) is
// enforced. This one-shot closes that gap: it binds each tenant's license to its OLDEST user and
// stores the encrypted token on the tenant row, reusing the exact production path
// (`ensureTenantLicense`) so behaviour is identical to a fresh onboard. Idempotent — a tenant that
// already has a token is skipped — so it is safe to re-run.
//
// MUST run AFTER the app+plan are registered in licenses.example.com and the SA creds are set, with
// LICENSE_ISSUANCE_ENABLED=true, and BEFORE flipping LICENSE_GATE_2_ENABLED (Spec §9.5 C→F).
//
// Also the repair tool for the licenses-registry gap: `ensureTenantLicense` now registers the
// tenant id in the licenses registry before minting (the service refuses to mint for an
// unregistered tenant), so re-running this backfills BOTH the registry row and the token for every
// tenant created while that registration step was missing.
//
// Run: `LICENSE_ISSUANCE_ENABLED=true ... bun run scripts/backfill-licenses.ts`
import { and, asc, eq, isNull } from 'drizzle-orm';
import { config } from '../src/config';
import { db, closeConnection, runAsSystem, tenants, users } from '../src/db/client';
import { ensureTenantLicense } from '../src/services/license-provisioning';

async function backfill(): Promise<{ issued: number; skippedNoUsers: number; alreadyLicensed: number }> {
  // Explicit guard: ensureTenantLicense is itself a no-op when the flag is off, so without this the
  // script would "succeed" having issued nothing. Fail loud instead of silently doing nothing.
  if (!config.license.issuanceEnabled) {
    throw new Error(
      'LICENSE_ISSUANCE_ENABLED is not set — refusing to run (would be a silent no-op). ' +
        'Register the app+plan + set the SA creds, then re-run with the flag on.',
    );
  }

  // Platform-wide read across tenants → runAsSystem (owner pool, bypasses RLS).
  const pending = await runAsSystem('platform-admin', () =>
    db
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(isNull(tenants.license_token_encrypted)),
  );
  console.log(`[backfill] ${pending.length} tenant(s) without a stored license token`);

  let issued = 0;
  let skippedNoUsers = 0;
  for (const t of pending) {
    // Tombstones excluded (0050): a tombstone keeps its `tenant_id` and stays OLDEST by
    // `created_at`, so a tenant whose founding member has been offboarded would otherwise bind
    // its licence to a subject Keycloak no longer has — silently corrupting the licence's audit
    // trail rather than failing. Match `reissueTenantLicense` / `licenseSubjectFor`.
    const [oldest] = await runAsSystem('platform-admin', () =>
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenant_id, t.id), isNull(users.deleted_at)))
        .orderBy(asc(users.created_at))
        .limit(1),
    );
    if (!oldest) {
      // An empty tenant has nobody in the DB to bind the license to, and this script has no acting
      // identity of its own to substitute — so it still cannot license one.
      //
      // What is NO LONGER true is the old note here ("its first onboard will issue"). That was the
      // assumption that stranded live tenants: a tenant created by a super-admin is empty, and
      // anyone arriving via SSO/JIT rather than through a CP onboarding route never triggers
      // issuance — they just get 402 on every screen. Tenants created from now on are licensed at
      // birth (routes/admin.ts createTenant); the ones listed below predate that and must be
      // repaired explicitly by a super_admin: `POST /api/tenants/<id>/license` (idempotent; binds
      // the licence to the acting admin when the tenant has no members yet).
      console.warn(
        `[backfill] SKIP ${t.id} (${t.name}) — no users; UNLICENSED and will 402. ` +
          `Repair with POST /api/tenants/${t.id}/license as a super_admin.`,
      );
      skippedNoUsers++;
      continue;
    }
    // Same production path as onboarding: idempotent, fail-loud (throws HttpError 502 on outage).
    await ensureTenantLicense(t.id, oldest.id);
    console.log(`[backfill] OK   ${t.id} (${t.name}) — issued, bound to ${oldest.id}`);
    issued++;
  }

  // `pending` filtered on IS NULL, so nothing in this run was already licensed; the field is kept
  // for callers/readers who reason about the full population.
  return { issued, skippedNoUsers, alreadyLicensed: 0 };
}

if (import.meta.main) {
  const r = await backfill();
  console.log(`[backfill] done — issued=${r.issued} skipped_no_users=${r.skippedNoUsers}`);
  if (r.skippedNoUsers) {
    console.warn(
      `[backfill] ${r.skippedNoUsers} EMPTY tenant(s) remain unlicensed — they are 402-trapped ` +
        `until repaired via POST /api/tenants/<id>/license (see the SKIP lines above)`,
    );
  }
  await closeConnection();
  process.exit(0);
}

export { backfill };
