// scripts/backfill-flow-translations.ts — one-shot: enqueue the 7 non-`en` locale cells for every
// flow that predates `flow` becoming a translatable entity type.
//
// WHY A SCRIPT AND NOT `POST /api/admin/translations/queue`.
//
// The admin route is correct and must stay as it is — it runs `backfillTranslations` in the
// CALLER'S OWN RLS scope and meters the jobs to the CALLER. That is exactly right for an operator
// backfilling their own workspace, and the long note in `routes/translations.ts` explains why
// widening its read would be a cross-tenant BILLING bug: `translation_jobs` has no `tenant_id`, so
// spend is charged downstream as `tenantOf(job.requested_by)`.
//
// But the flows this exists to fix are spread across MANY tenants (measured on prod at the time of
// writing: 23 flows over 11 tenants, mostly one seeded persona tenant each). Driving the route once
// per tenant — even with the super_admin `X-Active-Tenant-Id` scope switch — would still stamp
// `requested_by` with the OPERATOR, producing exactly the content-tenant != metered-tenant split
// that `tests/translations-backfill-billing-tenant.test.ts` exists to catch.
//
// So this script does the one thing the HTTP surface cannot: it enters EACH tenant's own RLS scope
// AND meters that tenant's jobs to a user who actually lives in that tenant. Same production code
// path (`backfillTranslations`), same edit-aware upsert, no schema change, no widened read.
//
// SAFE TO RE-RUN. `enqueueTranslations` upserts with `source_hash <> EXCLUDED.source_hash`, so a
// flow whose prose has not changed is a no-op. Nothing here deletes or overwrites a translation;
// the drain is done separately by `host/translation-scheduler.ts` on its own timer.
//
// Run (dry run — reports what it WOULD queue, writes nothing):
//   bun run scripts/backfill-flow-translations.ts
// Run for real:
//   bun run scripts/backfill-flow-translations.ts --apply
import { and, eq, isNull } from 'drizzle-orm';
import {
  closeConnection,
  db,
  flows,
  runAsSystem,
  users,
  withTenantDb,
} from '../src/db/client';
import { backfillTranslations } from '../src/host/translation-service';

interface TenantPlan {
  tenantId: string;
  flowCount: number;
  actorId: string | null;
  actorReason: string;
}

async function plan(): Promise<TenantPlan[]> {
  // A genuine platform-wide read across tenants — one of the four uses `runAsSystem` is documented
  // for. It reads ids only; no tenant prose is pulled into this process.
  const rows = await runAsSystem('platform-admin', () =>
    db.select({ id: flows.id, tenantId: flows.tenant_id, ownerId: flows.owner_id }).from(flows),
  );

  const byTenant = new Map<string, { count: number; ownerIds: string[] }>();
  for (const r of rows) {
    if (!r.tenantId) continue;
    const e = byTenant.get(r.tenantId) ?? { count: 0, ownerIds: [] };
    e.count += 1;
    if (r.ownerId && !e.ownerIds.includes(r.ownerId)) e.ownerIds.push(r.ownerId);
    byTenant.set(r.tenantId, e);
  }

  const plans: TenantPlan[] = [];
  for (const [tenantId, e] of byTenant) {
    // ⛔ THE ACTOR MUST LIVE IN THIS TENANT. `requested_by` is the BILLING key, not a display
    // column: `processPendingBatch` charges `tenantOf(job.requested_by)`. An actor from another
    // tenant would drain correctly and bill the wrong party, silently — the failure mode this
    // whole script exists to avoid. So verify membership rather than assuming `flows.owner_id`
    // implies it, and skip the tenant loudly if no member can be found.
    let actorId: string | null = null;
    let actorReason = 'no user found in this tenant — SKIPPED';

    // Tombstones excluded (0050): a tombstone keeps its `tenant_id`, so without this filter a
    // single-person tenant whose sole (now offboarded) member authored a flow would still match
    // as `owningMember` — falsely reported "verified member of this tenant" — instead of falling
    // through to the "no user found in this tenant — SKIPPED" branch this comment promises.
    const owners = await runAsSystem('platform-admin', () =>
      db
        .select({ id: users.id, tenantId: users.tenant_id })
        .from(users)
        .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at))),
    );
    const owningMember = owners.find((u) => e.ownerIds.includes(u.id));
    if (owningMember) {
      actorId = owningMember.id;
      actorReason = 'flow owner, verified member of this tenant';
    } else if (owners.length > 0) {
      actorId = owners[0]!.id;
      actorReason = 'flow owner is not a member of this tenant; using another member';
    }

    plans.push({ tenantId, flowCount: e.count, actorId, actorReason });
  }
  return plans.sort((a, b) => b.flowCount - a.flowCount);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const plans = await plan();

  const totalFlows = plans.reduce((n, p) => n + p.flowCount, 0);
  const skipped = plans.filter((p) => !p.actorId);
  console.log(
    `[flow-i18n] ${totalFlows} flow(s) across ${plans.length} tenant(s); ` +
      `${skipped.length} tenant(s) have no usable metering actor`,
  );
  for (const p of plans) {
    console.log(`  ${p.tenantId}  flows=${p.flowCount}  actor=${p.actorId ?? '-'}  (${p.actorReason})`);
  }

  if (!apply) {
    console.log('\n[flow-i18n] DRY RUN — nothing written. Re-run with --apply to enqueue.');
    return;
  }

  let queuedTotal = 0;
  let matchedTotal = 0;
  for (const p of plans) {
    if (!p.actorId) continue;
    // Each tenant is entered on its OWN reserved connection with its own `app.current_tenant`, so
    // `backfillTranslations`' unfiltered SELECT sees that tenant's flows and no others.
    const { queued, matched } = await withTenantDb(p.tenantId, () =>
      backfillTranslations({ entityType: 'flow' }, p.actorId!),
    );
    queuedTotal += queued;
    matchedTotal += matched;
    console.log(`  ${p.tenantId}  matched=${matched}  queued=${queued}`);
  }
  console.log(
    `\n[flow-i18n] queued ${queuedTotal} locale cell(s) from ${matchedTotal} flow(s). ` +
      'The scheduler (host/translation-scheduler.ts) drains them on its own timer.',
  );
}

main()
  .then(() => closeConnection())
  .catch(async (err) => {
    console.error('[flow-i18n] FAILED', err);
    await closeConnection();
    process.exit(1);
  });
