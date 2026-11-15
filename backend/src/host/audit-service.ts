// src/host/audit-service.ts — the append-only audit trail (Session 6).
// recordAudit writes one row per mutating action; it is called from every
// enforcement point and mutating route (the run-gate, the broker outcome, the
// idle sweep, sandbox pause/resume, block publish, challenge/solution submit +
// vote, pipeline moves, governance edits). It NEVER throws into its caller — a
// failed audit insert must not break the mutation it records (best-effort log).
import { eq } from 'drizzle-orm';
import { db as defaultDb, auditLog, users } from '../db/client';
import { incCounter } from './metrics';
import { currentRequestContext } from './request-context';
import { log } from './logger';

type Db = typeof defaultDb;

export interface AuditEntry {
  actorId?: string | null; // null/omitted = a System action
  action: string; // e.g. 'sandbox.run', 'policy.change', 'run.blocked'
  // Filter chip: sandbox|block|policy|deploy|auth|data|system|tenant. A value outside that set
  // still WRITES (this column is free text, not a pg enum) and still renders in the feed — but it
  // is unfilterable and counts only into `all`, so add it to `CATEGORIES` in routes/audit.ts and
  // to `AUDIT_CATEGORIES` in the frontend at the same time.
  category: string;
  targetType?: string;
  targetId?: string | null;
  result?: string | null; // display: 'Success · 2.31s', 'Applied', 'Blocked'
  resultTone?: 'ok' | 'warn' | 'error';
  metadata?: Record<string, unknown>;
  /**
   * 0083. Override the workspace this row is attributed to. Almost never needed — the default
   * (the live request context) is right for every in-request write. Set it explicitly when the
   * action is ABOUT a tenant other than the one the request is scoped to: a super-admin acting
   * from the platform console, or a scheduler doing per-tenant work, where the context tenant is
   * null or is the operator's own.
   */
  tenantId?: string | null;
}

/**
 * The value to put in `actorId` for a caller who MIGHT NOT HAVE A LOCAL `users` ROW: the id when
 * the row exists, `null` (a System action) when it does not.
 *
 * ⛔ WHY THIS IS NEEDED AT ALL. `audit_log.actor_id` is a foreign key to `users.id`, and
 * `recordAudit` is best-effort by design — it swallows its own failure so a broken audit never
 * breaks the mutation it records. Together those two facts mean an actor with no `users` row does
 * not produce a degraded audit row; it produces NO audit row, a 23503 in the log and a bumped
 * `audit_write_failures_total`. That is exactly the shape of a production super_admin:
 * `requireSuperAdmin` runs `authenticateWithoutLicense`, which never calls `ensureUser`, and
 * super_admins are granted directly in Keycloak (see `claimJitSeat`'s bypass note) — so the
 * platform's most privileged, most cross-tenant actions were the ones least likely to be recorded.
 *
 * The caller keeps the acting subject in `metadata` (there is nowhere else for it to go — the
 * column is a FK, not free text), so a System-attributed row still names who did it.
 *
 * ONE indexed primary-key lookup, on routes that already do several. Not for the hot path.
 */
export async function auditActorId(
  userId: string | null | undefined,
  database: Db = defaultDb,
): Promise<string | null> {
  if (!userId) return null;
  try {
    const [row] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.id ?? null;
  } catch {
    // Could not ask — attribute to System rather than lose the row to a FK we cannot verify.
    return null;
  }
}

/**
 * The counter `recordAudit`'s FK fallback bumps when it re-attributes a degraded audit row to System.
 *
 * ⛔ EXPORTED SO IT CANNOT DRIFT OUT OF `PRESEEDED_COUNTERS`. This condition used to be counted by
 * `audit_write_failures_total`, which gitops alerts on through `sum(rate(…[5m])) > 0`. Splitting it
 * onto its own counter only INCREASES visibility if the new series is registered at 0 — a lazy
 * counter's first bump is an absent -> 1 rise, which `increase()`/`rate()` evaluate as 0 (see the
 * long note in host/metrics.ts). host/metrics.ts cannot import this module (it would be a cycle),
 * so tests/metrics-counter-preseed.test.ts pins the two together.
 */
export const ORPHAN_ACTOR_COUNTER = 'audit_actor_orphan_total';

/**
 * True when `err` is the `audit_log.actor_id` → `users.id` FK violation and nothing else.
 *
 * Drizzle wraps the driver error, so the postgres-js `PostgresError` (which carries `code` and
 * `constraint_name`) sits on `.cause`. Matching the CONSTRAINT NAME, not just SQLSTATE 23503, is
 * deliberate: `metadata` could one day reference something else, and a fallback that blanks the
 * actor for an unrelated FK failure would be a fix that lies.
 */
function isActorFkViolation(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e && hops < 5; hops++) {
    const c = e as { code?: string; constraint_name?: string; cause?: unknown };
    if (c.code === '23503' && c.constraint_name === 'audit_log_actor_id_fkey') return true;
    e = c.cause;
  }
  return false;
}

export async function recordAudit(
  entry: AuditEntry,
  database: Db = defaultDb,
): Promise<void> {
  try {
    await database.insert(auditLog).values({
      actor_id: entry.actorId ?? null,
      // 0083. From the LIVE REQUEST CONTEXT, not from a lookup on the actor: this file's own
      // orphan-actor note forbids putting a PK lookup on every audit write, and the context already
      // holds the tenant `peekEffectiveTenant` resolved for this request — so it is free and it is
      // accurate at write time. Null outside a request (schedulers, boot, CLI), which is honest:
      // those actions have no single tenant.
      tenant_id: entry.tenantId ?? currentRequestContext()?.tenantId ?? null,
      action: entry.action,
      category: entry.category,
      target_type: entry.targetType ?? '',
      target_id: entry.targetId ?? null,
      result: entry.result ?? null,
      result_tone: entry.resultTone ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    // ⛔ THE ORPHAN-ACTOR FALLBACK, and why it lives HERE rather than at the call sites.
    //
    // `auditActorId()` above is the documented fix for an actor with no `users` row, and it was
    // adopted at exactly ONE of the ~100 `recordAudit` call sites. Hand-listing the rest is the
    // wrong shape twice over: it puts a PK lookup on every audit write including the hot ones (the
    // helper's own docstring forbids that), and an explicit register silently omits the call site
    // added next week. This catch costs nothing on the happy path and covers every site there is.
    //
    // A super_admin granted directly in Keycloak has no local `users` row (`requireSuperAdmin`
    // runs `authenticateWithoutLicense`, which never calls `ensureUser`), so the platform's most
    // privileged actions were the ones LEAST likely to be recorded: a 23503 and no row at all.
    // Re-attributing to System with the acting subject preserved in `metadata.actorSub` is the
    // same degraded shape `auditActorId` + routes/tenant-users.ts:534 already produce on purpose —
    // a row that names who acted beats no row.
    //
    // NB when `database` is a transaction handle the retry cannot succeed (the tx is already
    // aborted); it falls through to the counter + log below, i.e. exactly today's behaviour.
    if (entry.actorId && isActorFkViolation(err)) {
      try {
        await database.insert(auditLog).values({
          actor_id: null,
          // Kept on the degraded path too — losing the actor must not also lose the workspace.
          tenant_id: entry.tenantId ?? currentRequestContext()?.tenantId ?? null,
          action: entry.action,
          category: entry.category,
          target_type: entry.targetType ?? '',
          target_id: entry.targetId ?? null,
          result: entry.result ?? null,
          result_tone: entry.resultTone ?? null,
          metadata: { ...(entry.metadata ?? {}), actorSub: entry.actorId },
        });
        // Recorded, but DEGRADED — the trail says System where a person acted. Distinct from
        // `audit_write_failures_total` (a lost row) so the two can be alerted on differently.
        incCounter(ORPHAN_ACTOR_COUNTER);
        return;
      } catch {
        // fall through to the loss path below — the original failure is the one worth logging.
      }
    }
    // Best-effort: never break the mutation we're recording. Surface as a metric so a gap in the
    // append-only audit trail (a compliance signal) is alertable rather than silent.
    incCounter('audit_write_failures_total');
    log.error('audit_record_failed', { component: 'audit', action: entry.action, err });
  }
}
