// scripts/offboard-tenant.ts — offboard a workspace server-side, without minting a production
// super_admin JWT for a one-off lifecycle change.
//
// ⛔ IT DOES EXACTLY WHAT `POST /api/tenants/:id/offboard` DOES, BY CALLING THE SAME CODE. The work is
// `services/offboarding.ts offboardTenantFully` and the guards are `loadOffboardTarget` (404
// `tenant_not_found`, 409 `system_tenant`) and `assertOffboardConfirmed` (400 `confirm_mismatch`) —
// the route and this script call the same three functions and nothing else, so they cannot drift.
// (This used to be a hand copy that did only the DB writes and the tenant licence: pending invites
// stayed live, IdPs enabled, every member seat billable, the inference credential valid and the
// licences-registry tenant active. It also refused tenants with live members, because the route once
// deleted Keycloak identities; the route no longer touches Keycloak — the portal realm is shared with
// fr — so that guard is gone too.)
//
// GUARDS, before any write — the route's own:
//   1. The tenant exists, and is not the nil-UUID system tenant.
//   2. `confirmSlug` equals the tenant's own slug — "this cannot be undone", and the slug rather than
//      the id because the operator has to have READ the workspace's name to type it.
//
// THE AUDIT ROW: `actorId: null` (a System action — this script authenticates as nobody, and no user
// id is invented), the operator's OS user in `metadata.operator`, `metadata.via` naming this script.
//
// FAILURES: a licences outage on the tenant licence THROWS (exit 1) after the DB writes committed —
// re-run; everything is idempotent. Seat / IdP / inference / archive failures are reported (exit 2)
// with the workspace offboarded; re-running retries what remains.
//
// DRY RUN BY DEFAULT: without `--apply` this prints the tenant, its members, pending invites, IdPs and
// whether a licence is stored, then exits without writing anything.
//
// Run (dry run):
//   bun run scripts/offboard-tenant.ts <tenantId> <confirmSlug> [--reason "<text>"]
// Run for real:
//   bun run scripts/offboard-tenant.ts <tenantId> <confirmSlug> --apply [--reason "<text>"]
import { and, eq, isNull } from 'drizzle-orm';
import { closeConnection, db, identityProviders, runAsSystem, tenants, users } from '../src/db/client';
import { tenantInvites } from '../src/db/schema';
import {
  assertOffboardConfirmed,
  loadOffboardTarget,
  offboardTenantFully,
  type OffboardTarget,
  type OffboardTenantResult,
} from '../src/services/offboarding';
import { HttpError } from '../src/utils/http';

export const SCRIPT_VIA = 'scripts/offboard-tenant.ts';

export interface OffboardPlan {
  target: OffboardTarget;
  status: string;
  offboardedAt: Date | null;
  hasLicense: boolean;
  liveMembers: number;
  pendingInvites: number;
  idps: number;
}

/** What an offboard WOULD touch — read-only (the dry run). */
export async function planOffboard(target: OffboardTarget): Promise<OffboardPlan> {
  return runAsSystem('platform-admin', async () => {
    const [t] = await db
      .select({ status: tenants.status, offboardedAt: tenants.offboarded_at, token: tenants.license_token_encrypted })
      .from(tenants)
      .where(eq(tenants.id, target.id));
    const members = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenant_id, target.id), isNull(users.deleted_at)));
    const invites = await db
      .select({ id: tenantInvites.id })
      .from(tenantInvites)
      .where(and(eq(tenantInvites.tenant_id, target.id), eq(tenantInvites.status, 'pending')));
    const idps = await db
      .select({ id: identityProviders.id })
      .from(identityProviders)
      .where(eq(identityProviders.tenant_id, target.id));
    return {
      target,
      status: t?.status ?? 'unknown',
      offboardedAt: t?.offboardedAt ?? null,
      hasLicense: (t?.token ?? null) !== null,
      liveMembers: members.length,
      pendingInvites: invites.length,
      idps: idps.length,
    };
  });
}

/**
 * The script's whole decision, importable for tests: the route's guards, then either the plan (dry
 * run) or `offboardTenantFully` as a System actor. Throws the guards' HttpErrors unchanged.
 */
export async function runOffboardScript(args: {
  tenantId: string;
  confirmSlug: string;
  apply: boolean;
  reason?: string | null;
  operator?: string | null;
}): Promise<{ plan: OffboardPlan; result: OffboardTenantResult | null }> {
  const target = await loadOffboardTarget(args.tenantId);
  assertOffboardConfirmed(target, args.confirmSlug);
  const plan = await planOffboard(target);
  if (!args.apply) return { plan, result: null };
  const result = await offboardTenantFully(
    target,
    { actorId: null, operator: args.operator ?? null, via: SCRIPT_VIA },
    { reason: args.reason ?? null },
  );
  return { plan, result };
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const reason = argValue('--reason');
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--reason');
  const [tenantId, confirmSlug] = positional;
  const apply = process.argv.includes('--apply');
  if (!tenantId || !confirmSlug) {
    console.error(
      'usage: bun run scripts/offboard-tenant.ts <tenantId> <confirmSlug> [--apply] [--reason "<text>"]\n' +
        '  Without --apply: dry run — prints the plan, writes nothing.\n' +
        '  With --apply: offboards exactly as POST /api/tenants/:id/offboard does.',
    );
    return 1;
  }

  let out: Awaited<ReturnType<typeof runOffboardScript>>;
  try {
    out = await runOffboardScript({
      tenantId,
      confirmSlug,
      apply,
      reason: reason ?? null,
      operator: process.env.USER ?? process.env.LOGNAME ?? null,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      console.error(`[offboard] ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const { plan, result } = out;
  console.log(`[offboard] tenant    ${plan.target.id}`);
  console.log(`[offboard] name      ${plan.target.name}`);
  console.log(`[offboard] slug      ${plan.target.slug}`);
  console.log(`[offboard] status    ${plan.status}${plan.offboardedAt ? ` (offboarded ${plan.offboardedAt.toISOString()})` : ''}`);
  console.log(`[offboard] licence   ${plan.hasLicense ? 'stored (will be revoked)' : 'none stored'}`);
  console.log(`[offboard] members   ${plan.liveMembers} live (tombstoned, seats revoked; Keycloak untouched)`);
  console.log(`[offboard] invites   ${plan.pendingInvites} pending (revoked)`);
  console.log(`[offboard] IdPs      ${plan.idps} (disabled)`);

  if (!result) {
    console.log('\n[offboard] DRY RUN — nothing written. Re-run with --apply to perform the offboard.');
    return 0;
  }

  console.log(
    `[offboard] done: alreadyOffboarded=${result.alreadyOffboarded} usersOffboarded=${result.usersOffboarded} ` +
      `keysRevoked=${result.keysRevoked} sessionsRevoked=${result.sessionsRevoked} ` +
      `invitesRevoked=${result.invitesRevoked} idpsDisabled=${result.idpsDisabled} ` +
      `residualLicencesRevoked=${result.residualLicencesRevoked} ` +
      `offboardedAt=${result.offboardedAt.toISOString()}`,
  );
  if (result.archiveSkipped) {
    console.log(`[offboard] central archive NOT attempted: ${result.archiveSkipped}`);
  }
  const leftovers = [
    ...result.seatFailures.map((f) => `seat ${f.email} (${f.userId}): ${f.message}`),
    ...result.idpDisableFailures.map((f) => `IdP ${f.alias}: ${f.message}`),
    ...result.residualLicenceFailures.map(
      (f) => `licence ${f.licenseId ?? '(listing)'}${f.appKey ? ` [${f.appKey}]` : ''}: ${f.message}`,
    ),
    ...(result.inferenceRevokeError ? [`inference credential: ${result.inferenceRevokeError}`] : []),
    ...(result.archiveFailure ? [`central archive: ${result.archiveFailure}`] : []),
  ];
  if (leftovers.length > 0) {
    console.error(`[offboard] OFFBOARDED, but ${leftovers.length} step(s) need a re-run:\n  ${leftovers.join('\n  ')}`);
    return 2;
  }
  return 0;
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main();
  } finally {
    await closeConnection();
  }
  process.exit(code);
}
