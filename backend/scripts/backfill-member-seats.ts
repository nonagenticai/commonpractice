// scripts/backfill-member-seats.ts — rollout gate 1: give every live member their OWN central
// licence, so a seat becomes a person rather than a workspace.
//
// Per-member entitlements (migration 0089) are minted by the onboarding paths and repaired by
// `repairUnseatedMembers` on a tick. Everybody who was already in a workspace when that landed has
// neither: they hold a seat locally and nothing centrally, so `human_subjects` under-counts and the
// invoice under-bills — and the moment LICENSE_GATE_PER_MEMBER flips they are all refused with
// `license_seat_required`. This one-shot closes that gap in one pass instead of waiting for the
// sweep to walk the estate.
//
// ⛔ DRY RUN BY DEFAULT. It reports exactly what it would mint and changes nothing; pass `--apply`
// to write. A mint registers a Subject in the licences service AND starts billing a seat, so the
// default must not be the one that spends the customer's money.
//
// ⛔ IT WILL NOT INVENT AN IDENTITY. A row with no `keycloak_sub` is REPORTED and SKIPPED, never
// minted for — `db/seed-tenant-showcase.ts` inserts `role:'employee'` rows whose id is a plain
// `uuidv7()` and is not a realm subject at all, and minting for one registers a Subject that can
// never authenticate and bills the customer for it. This is the same predicate
// `repairUnseatedMembers` fails closed on, and the skip list is the point of the report: those rows
// need a human to decide whether they are people.
//
// Platform staff are excluded on the same basis the seat count uses (`users.role = 'platform'`):
// an operator is not somebody the customer bought a seat for.
//
// Idempotent — `ensureMemberEntitlement` claims, mints once, and reports an existing seat as
// already-licensed — so it is safe to re-run after fixing the skips.
//
// Run: `LICENSE_ISSUANCE_ENABLED=true … bun run scripts/backfill-member-seats.ts [--apply]`
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { config } from '../src/config';
import { db, closeConnection, runAsSystem, tenants, users } from '../src/db/client';
import { ensureMemberEntitlement } from '../src/services/license-provisioning';

interface Report {
  seated: number;
  alreadySeated: number;
  failed: number;
  skippedNoSub: Array<{ tenantId: string; userId: string; email: string }>;
}

async function backfillMemberSeats(apply: boolean): Promise<Report> {
  // Same guard, same reason as `backfill-licenses.ts`: `ensureMemberEntitlement` is itself a no-op
  // with the flag off, so without this the script reports success having minted nothing.
  if (apply && !config.license.issuanceEnabled) {
    throw new Error(
      'LICENSE_ISSUANCE_ENABLED is not set — refusing to --apply (would be a silent no-op).',
    );
  }

  // Platform-wide read across tenants → runAsSystem (owner pool, bypasses RLS).
  const members = await runAsSystem('platform-admin', () =>
    db
      .select({
        tenantId: users.tenant_id,
        userId: users.id,
        email: users.email,
        keycloakSub: users.keycloak_sub,
      })
      .from(users)
      .innerJoin(tenants, eq(tenants.id, users.tenant_id))
      .where(
        and(
          isNull(users.deleted_at),
          ne(users.role, 'platform'),
          eq(tenants.status, 'active'),
          isNull(tenants.offboarded_at),
          // Only rows with NO live entitlement. `revoking` is deliberately NOT here: that member is
          // being offboarded and re-minting would hand back the seat we are releasing.
          sql`not exists (
            select 1 from member_entitlements me
             where me.tenant_id = ${users.tenant_id}
               and me.user_id = ${users.id}
               and me.status in ('active', 'pending', 'revoking')
          )`,
        ),
      ),
  );

  const report: Report = { seated: 0, alreadySeated: 0, failed: 0, skippedNoSub: [] };
  console.log(
    `[seats] ${members.length} member(s) with no live entitlement (${apply ? 'APPLY' : 'DRY RUN'})`,
  );

  for (const m of members) {
    if (!m.tenantId) continue; // no home tenant = no seat to hold
    if (!m.keycloakSub) {
      report.skippedNoSub.push({ tenantId: m.tenantId, userId: m.userId, email: m.email ?? '' });
      console.warn(
        `[seats] SKIP ${m.userId} (${m.email}) in ${m.tenantId} — no keycloak_sub recorded; ` +
          'nobody has ever authenticated as this row, so it gets no licence and no seat.',
      );
      continue;
    }
    if (!apply) {
      console.log(`[seats] WOULD MINT ${m.userId} (${m.email}) in ${m.tenantId}`);
      report.seated++;
      continue;
    }
    try {
      const out = await ensureMemberEntitlement(m.tenantId, m.userId, m.keycloakSub);
      if (out.state === 'active') {
        report.seated++;
        console.log(`[seats] OK   ${m.userId} (${m.email}) in ${m.tenantId}`);
      } else {
        // `pending` is not a failure — another caller holds the claim lease, or the mint is
        // mid-flight. The sweep finishes it. Counted apart from a hard failure so a re-run's
        // numbers mean something.
        report.alreadySeated++;
        console.log(`[seats] ..   ${m.userId} in ${m.tenantId} — state=${out.state}`);
      }
    } catch (err) {
      // One member's licences outage must not abort the pass for everyone behind them — the same
      // per-member try/catch `repairUnseatedMembers` uses, for the same reason.
      report.failed++;
      console.error(`[seats] FAIL ${m.userId} in ${m.tenantId} —`, err);
    }
  }
  return report;
}

if (import.meta.main) {
  const apply = process.argv.includes('--apply');
  const r = await backfillMemberSeats(apply);
  console.log(
    `[seats] done — ${apply ? 'seated' : 'would_seat'}=${r.seated} pending=${r.alreadySeated} ` +
      `failed=${r.failed} skipped_no_sub=${r.skippedNoSub.length}`,
  );
  if (r.skippedNoSub.length) {
    console.warn(
      `[seats] ${r.skippedNoSub.length} row(s) have no keycloak_sub and were NOT minted for. ` +
        'They will also be skipped by the sweep. Decide per row whether they are real people ' +
        '(a real person gets a sub the next time they sign in) before rollout gate 2.',
    );
  }
  if (!apply) console.log('[seats] DRY RUN — nothing was written. Re-run with --apply.');
  await closeConnection();
  process.exit(r.failed > 0 ? 1 : 0);
}

export { backfillMemberSeats };
