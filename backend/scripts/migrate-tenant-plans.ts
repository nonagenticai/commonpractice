// scripts/migrate-tenant-plans.ts — move the estate onto the `local-llm` / `byo` plans and retire
// `standard` / `tenant-pooled` (Part B). Thin wrapper over services/plan-migration.ts, which reuses the
// same services as the Plans page and the per-tenant licence editor.
//
// DRY RUN BY DEFAULT: prints every step it WOULD take and writes nothing — not to CP, not to licences.
// `--apply` performs them. Idempotent: a re-run plans only what is still left to do.
//
// Run (dry run):   bun run scripts/migrate-tenant-plans.ts
// Run for real:    bun run scripts/migrate-tenant-plans.ts --apply
//
// Needs the licences admin API configured (LICENSE_ADMIN_BASE_URL + LICENSE_SA_*), and for the
// local-llm tenants OPENAI_BASE_URL at the inference-router (the smoke call). Run it IN a CP pod.
import { userInfo } from 'node:os';
import { closeConnection } from '../src/db/client';
import { licencesAdminConfigured } from '../src/services/licenses-admin';
import { applyTenantMigration, planTenantMigration } from '../src/services/plan-migration';

function describe(step: Awaited<ReturnType<typeof planTenantMigration>>[number]): string {
  switch (step.kind) {
    case 'create_plan':
      return `create plan '${step.code}' (limits copied from ${step.copyLimitsFrom ?? 'nothing'})`;
    case 'provision_inference':
      return `provision inference-router licence + token for ${step.name} (${step.tenantId}), smoke-tested`;
    case 'change_plan':
      return `change plan of ${step.name} (${step.tenantId}): ${step.from} → ${step.to}`;
    case 'set_posture':
      return `set BYO posture of ${step.name} (${step.tenantId}): ${step.from ?? 'unknown'} → ${step.to}`;
    case 'retire_plan':
      return `retire plan '${step.code}' (${step.planId})`;
    case 'retire_blocked':
      return `NOT retiring plan '${step.code}': ${step.reason}`;
    case 'skip':
      return `skip ${step.name} (${step.tenantId}): ${step.reason}`;
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (!licencesAdminConfigured()) {
    console.error('[plans] no licences admin API configured (LICENSE_ADMIN_BASE_URL / LICENSE_SA_TOKEN_URL)');
    await closeConnection();
    process.exit(1);
  }
  const steps = await planTenantMigration();
  for (const s of steps) console.log(`[plans] ${apply ? 'DO ' : 'PLAN'} ${describe(s)}`);
  if (!apply) {
    console.log(`\n[plans] DRY RUN — ${steps.length} step(s), nothing written. Re-run with --apply.`);
    await closeConnection();
    return;
  }
  const operator = `script:migrate-tenant-plans:${userInfo().username}`;
  const results = await applyTenantMigration(steps, operator);
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`[plans] ${r.ok ? 'OK  ' : 'FAIL'} ${describe(r.step)}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  await closeConnection();
  if (failed > 0) {
    console.error(`[plans] ${failed} step(s) failed — re-run after fixing; done steps are skipped.`);
    process.exit(1);
  }
}

await main();
