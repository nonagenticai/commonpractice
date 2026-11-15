// scripts/backfill-cp-membership.ts — one-shot move of the workspace LEVEL from Keycloak realm
// roles into CP's own `users.tenant_role` (0093), plus a read-only report of what the old
// claim-based model leaves behind.
//
// Dry-run by default: prints the JSON report and writes nothing.
//   --apply                      write `tenant_role` (only where it is NULL)
//   --force                      with --apply: overwrite a non-NULL `tenant_role` too
//   --strip-idp-tenant-mappers   with --apply: delete the old `tenant_id` / `default-role` mappers
//                                from every IdP CP mirrors in `identity_providers`
//
// Level = `roleFromRealmRoles` (tenant_admin > developer > member). A member whose realm roles
// cannot be read (Keycloak 5xx/transport → null) is SKIPPED and listed, never defaulted.
//
// `claim_only` = realm users whose `tenant_id` attribute names an existing CP tenant but who have
// no live CP row there: under the CP-owned model they have NO workspace until invited. Read-only.
//
// Run: `bun run scripts/backfill-cp-membership.ts [--apply] [--force] [--strip-idp-tenant-mappers]`
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, closeConnection, runAsSystem, tenants, users, identityProviders } from '../src/db/client';
import { keycloakAdmin } from '../src/services/keycloak-admin';
import { roleFromRealmRoles } from '../src/services/cp-identity';
import type { TenantRole } from '../src/types';

/** Mapper names `buildKeystoneMappers` used to author (sso-service.ts, before CP-owned tenancy). */
const OLD_TENANT_MAPPER_NAMES = new Set(['tenant_id', 'default-role']);

export interface BackfillReport {
  mode: 'dry-run' | 'apply';
  force: boolean;
  scanned: number;
  updated: Record<TenantRole, number>;
  /** Would be / were updated, per role (dry-run shows what --apply would write). */
  planned: Record<TenantRole, number>;
  unchangedAlreadySet: number;
  rolesUnknown: string[];
  superAdmins: { id: string; email: string; tenantId: string | null }[];
  nullTenantUsers: { id: string; email: string }[];
  claimOnly: { sub: string; email: string | undefined; tenantId: string }[];
  idpMappers: { alias: string; deleted: string[]; wouldDelete: string[]; error?: string }[];
}

export async function backfill(opts: {
  apply: boolean;
  force: boolean;
  stripIdpTenantMappers: boolean;
}): Promise<BackfillReport> {
  const kc = keycloakAdmin();
  const report: BackfillReport = {
    mode: opts.apply ? 'apply' : 'dry-run',
    force: opts.force,
    scanned: 0,
    updated: { member: 0, developer: 0, tenant_admin: 0 },
    planned: { member: 0, developer: 0, tenant_admin: 0 },
    unchangedAlreadySet: 0,
    rolesUnknown: [],
    superAdmins: [],
    nullTenantUsers: [],
    claimOnly: [],
    idpMappers: [],
  };

  const live = await runAsSystem('platform-admin', () =>
    db
      .select({ id: users.id, email: users.email, tenantId: users.tenant_id, role: users.tenant_role })
      .from(users)
      .where(isNull(users.deleted_at)),
  );
  const homed = live.filter((u) => u.tenantId);
  report.nullTenantUsers = live.filter((u) => !u.tenantId).map((u) => ({ id: u.id, email: u.email }));
  report.scanned = homed.length;

  const rolesBySub = await kc.getRealmRolesForUsers(live.map((u) => u.id));
  for (const u of live) {
    const realm = rolesBySub.get(u.id);
    if (realm?.includes('super_admin')) {
      report.superAdmins.push({ id: u.id, email: u.email, tenantId: u.tenantId });
    }
  }

  for (const u of homed) {
    const realm = rolesBySub.get(u.id);
    if (realm === null || realm === undefined) {
      report.rolesUnknown.push(u.id);
      continue;
    }
    if (u.role !== null && !opts.force) {
      report.unchangedAlreadySet++;
      continue;
    }
    const level = roleFromRealmRoles(realm);
    report.planned[level]++;
    if (!opts.apply) continue;
    const rows = await runAsSystem('platform-admin', () =>
      db
        .update(users)
        .set({ tenant_role: level, updated_at: new Date() })
        .where(
          opts.force
            ? and(eq(users.id, u.id), isNull(users.deleted_at))
            : and(eq(users.id, u.id), isNull(users.deleted_at), isNull(users.tenant_role)),
        )
        .returning({ id: users.id }),
    );
    if (rows.length) report.updated[level]++;
  }

  // claim_only: realm users homed (by the old attribute) in a CP tenant with no live CP row there.
  const tenantIds = new Set(
    (await runAsSystem('platform-admin', () => db.select({ id: tenants.id }).from(tenants))).map((t) =>
      t.id.toLowerCase(),
    ),
  );
  const liveHome = new Map(homed.map((u) => [u.id, u.tenantId!.toLowerCase()]));
  for (const ru of await kc.listRealmUsers()) {
    const attr = ru.attributes?.tenant_id;
    const claimed = (Array.isArray(attr) ? attr[0] : attr)?.trim().toLowerCase();
    if (!claimed || !tenantIds.has(claimed)) continue;
    if (liveHome.get(ru.id) === claimed) continue;
    report.claimOnly.push({ sub: ru.id, email: ru.email, tenantId: claimed });
  }

  if (opts.stripIdpTenantMappers) {
    const idps = await runAsSystem('platform-admin', () =>
      db.select({ alias: identityProviders.alias }).from(identityProviders).where(isNotNull(identityProviders.alias)),
    );
    for (const { alias } of idps) {
      const entry: BackfillReport['idpMappers'][number] = { alias, deleted: [], wouldDelete: [] };
      try {
        const mappers = await kc.listIdpMappers(alias);
        for (const m of mappers) {
          if (!m.id || !OLD_TENANT_MAPPER_NAMES.has(m.name)) continue;
          if (opts.apply) {
            await kc.deleteIdpMapper(alias, m.id);
            entry.deleted.push(m.name);
          } else {
            entry.wouldDelete.push(m.name);
          }
        }
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
      report.idpMappers.push(entry);
    }
  }

  return report;
}

if (import.meta.main) {
  const argv = new Set(process.argv.slice(2));
  const known = new Set(['--apply', '--force', '--strip-idp-tenant-mappers']);
  const unknown = [...argv].filter((a) => !known.has(a));
  if (unknown.length) {
    console.error(`unknown argument(s): ${unknown.join(' ')}`);
    process.exit(2);
  }
  const report = await backfill({
    apply: argv.has('--apply'),
    force: argv.has('--force'),
    stripIdpTenantMappers: argv.has('--strip-idp-tenant-mappers'),
  });
  console.log(JSON.stringify(report, null, 2));
  await closeConnection();
  // Unknown realm roles mean the run is incomplete: exit non-zero so an operator re-runs it.
  process.exit(report.rolesUnknown.length ? 1 : 0);
}
