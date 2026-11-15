// src/host/allowlist-reconcile.ts — additive-only boot self-heal for the `models.allowlist`
// governance policy (closes the class behind #161).
//
// THE BUG: `models.allowlist` is seeded ONCE from the provider catalog (seed-platform.ts
// CATALOG_MODELS, `ON CONFLICT DO NOTHING`) and never reconciled afterwards.
// `ai/llm/provider-catalog.ts` keeps evolving, so every catalog addition made after a tenant's
// first boot silently produces a model that is selectable in the tenant LLM-settings dropdown,
// saves cleanly, and is then refused on EVERY call by the broker (`model_not_allowed`,
// `host/llm-broker.ts reserveCall`). #161 added a boot WARN (`pricing.ts
// findUnallowlistedCatalogModels`, wired in server.ts) and a save-time gate
// (`routes/llm-settings.ts`) — this module closes the class by self-healing instead of only
// warning.
//
// WHY ADDITIVE-ONLY, AND WHY GATED ON `updated_by IS NULL`:
//
// `models.allowlist` is a governance CONTROL, not a cache — an operator who deliberately removes
// a model (say, to forbid `gpt-4o`) must have that decision stick. A blind "reset to the current
// catalog" would silently RE-PERMIT something a human forbade, which is worse than the bug this
// closes. So the only safe automatic move is additive: never remove, never reorder-destructively,
// never overwrite.
//
// That still leaves the hard part: telling "the operator deliberately removed this id" apart from
// "the catalog gained this id after the row was seeded and no one has looked since". The `policies`
// row carries exactly the signal needed, already in schema, no migration required:
//
//   - `routes/governance.ts` PATCH /api/governance/:key is the ONLY code path that ever sets
//     `updated_by`, and its `list`-control validation (`validateValue`) always takes the
//     operator's COMPLETE submitted array — never a partial diff. GET returns the full current
//     list before every edit, so whatever they submit is a considered statement of the intended
//     membership, not an accidental subset.
//   - `updated_by IS NULL` → the row is still EXACTLY what seed-platform.ts inserted. No human has
//     ever reviewed this list and made a membership decision about it. Safe to additively add
//     catalog ids the operator never had the chance to see or reject.
//   - `updated_by IS NOT NULL` → an operator has, at least once, reviewed and submitted the
//     complete list. From that point the row is human-owned: we CANNOT tell "the catalog gained
//     this after their edit" apart from "they saw it and left it out on purpose". Per the task's
//     own framing, that ambiguity must resolve to NOT auto-adding — so once a row has EVER been
//     operator-edited, reconciliation permanently stops for it. The boot WARN
//     (`findUnallowlistedCatalogModels`) keeps firing so the gap stays visible; a human has to
//     act on it via the Governance screen, exactly as before this module existed.
//
// This is a real limitation, not a corner cut around one: after a single operator edit, the row
// never self-heals again, even for models the catalog gains long after that edit and the operator
// never had an opportunity to consider. That is the honest, defensible line — reconciling in that
// case would require guessing at intent from data that doesn't encode it (no per-model provenance
// exists, only a single row-level `updated_by`), and guessing is exactly what requirement 1 rules
// out.
//
// ⛔ THE PROVENANCE SIGNAL IS BYPASSED BY A DIRECT SQL EDIT, and that has already happened once.
// `updated_by` is set ONLY by the governance PATCH route, so an operator (or an agent) who edits
// `policies` straight through `psql` leaves it NULL — and this module will then read that
// deliberate, considered hand-edit as "no human has ever reviewed this row" and additively re-add
// anything they removed. Prod's own `models.allowlist` is in exactly that state right now: it was
// widened from 7 ids to the full catalog by direct SQL on 2026-07-30, so it reads as
// never-operator-edited. That is harmless in this instance (the hand-edit set it to the full
// catalog, so reconcile finds nothing missing and is a no-op), but it will NOT be harmless the
// first time someone removes a model that way. **Governance changes belong in the Governance
// screen / PATCH route**, which records `updated_by`, a `policy_changes` diff, and an audit row.
// If out-of-band edits ever become routine, this gate needs a stronger signal than `updated_by`
// — per-model provenance, or a "reconcile opt-out" marker on the row.
//
// ABSENT/EMPTY IS LEFT ALONE: the broker's own semantics (`llm-broker.ts reserveCall`, mirrored in
// `findUnallowlistedCatalogModels`) treat an absent or empty allowlist as "no restriction".
// Reconciling an empty list would flip that to "only these catalog ids allowed" — a genuine
// behaviour change (imposing a restriction that does not exist today), not a fix. So an
// empty/absent list is a no-op here, by design, not an oversight.
//
// ⚠️ AN OPERATOR CAN NO LONGER *CREATE* THAT STATE FROM THE GOVERNANCE SCREEN, and this module is
// unchanged by that. `routes/governance.ts` `NON_EMPTY_LISTS` now refuses a PATCH that would empty
// `models.allowlist` with a 400, because "no restriction" reached by clearing a text input is a
// governance gate switched off by accident. It is still a legitimate STORED state — a freshly
// seeded row that predates any edit, or a direct `psql` UPDATE (see the provenance note above) —
// so `skipped_empty` below stays reachable and stays a no-op. Read the two files together: this
// one says what an empty list MEANS to the enforcer, that one says who is allowed to write it.
import { and, eq, isNull } from 'drizzle-orm';
import { db as defaultDb, policies, policyChanges } from '../db/client';
import type { Policy, PolicyValue } from '../db/schema';
import { providerCatalog } from '../ai/llm/provider-catalog';
import { invalidatePolicyCache } from './policy-store';
import { recordAudit } from './audit-service';
import { log } from './logger';

type Db = typeof defaultDb;

export const MODELS_ALLOWLIST_KEY = 'models.allowlist';

export type AllowlistReconcileReason =
  | 'reconciled'
  | 'skipped_row_absent'
  | 'skipped_empty'
  | 'skipped_operator_edited'
  | 'skipped_no_missing'
  /** The guarded UPDATE matched no row: between our SELECT and our UPDATE, someone else changed
   *  this policy — an operator PATCH, or the other replica booting at the same time. We lose, by
   *  design, and write nothing at all (no value, no diff, no audit row). */
  | 'skipped_lost_race';

export interface AllowlistReconcileResult {
  reconciled: boolean;
  added: string[];
  reason: AllowlistReconcileReason;
}

/**
 * Pure decision function — no DB, no I/O. Given the current row and the current catalog model
 * ids, decide whether/what to add. Exported so the policy in the header comment can be pinned in
 * tests without a DB fixture.
 */
export function planAllowlistReconcile(
  row: Pick<Policy, 'value' | 'updated_by'> | undefined,
  catalogModels: string[],
): AllowlistReconcileResult {
  if (!row) return { reconciled: false, added: [], reason: 'skipped_row_absent' };
  const current = Array.isArray(row.value) ? (row.value as string[]) : [];
  // Absent/empty = "no restriction" (broker semantics). Reconciling would IMPOSE a restriction
  // that doesn't exist today — a behaviour change, not a fix. Leave it alone.
  // ⚠️ NOT REACHABLE VIA THE GOVERNANCE PATCH ROUTE ANY MORE — `routes/governance.ts`
  // `NON_EMPTY_LISTS` 400s an empty `models.allowlist` — but still reachable from a never-edited
  // seed row and from direct SQL, which is why this branch stays.
  if (current.length === 0) return { reconciled: false, added: [], reason: 'skipped_empty' };
  // An operator has, at least once, submitted the complete intended list. Their governance
  // decision on membership stands — do not second-guess it, not even additively.
  if (row.updated_by != null) {
    return { reconciled: false, added: [], reason: 'skipped_operator_edited' };
  }
  const currentSet = new Set(current);
  const added = catalogModels.filter((m) => !currentSet.has(m));
  if (added.length === 0) return { reconciled: false, added: [], reason: 'skipped_no_missing' };
  return { reconciled: true, added, reason: 'reconciled' };
}

/**
 * Apply the reconcile against the DB for one policy row (defaults to the real
 * `models.allowlist` key; a test may pass a different key to exercise the logic against a
 * throwaway row instead of the shared fixture). Idempotent: a second call once there is nothing
 * missing reports `skipped_no_missing` and touches nothing.
 *
 * Deliberately does NOT set `updated_by` / `updated_at` on the row — doing so would make this
 * look, to the very check above, like an operator edit and permanently disable future
 * reconciliation. This is a SYSTEM action, recorded as one (see below), not a human governance
 * decision.
 */
export async function reconcileModelsAllowlist(
  database: Db = defaultDb,
  key: string = MODELS_ALLOWLIST_KEY,
): Promise<AllowlistReconcileResult> {
  const [row] = await database.select().from(policies).where(eq(policies.key, key));
  const catalogModels = [...new Set(providerCatalog().flatMap((p) => p.models))];
  const plan = planAllowlistReconcile(row, catalogModels);
  if (!plan.reconciled || !row) return plan;

  const oldValue = row.value as PolicyValue;
  const newValue = [...(oldValue as string[]), ...plan.added] as PolicyValue;

  // ⛔ SELF-SERIALIZING, GUARDED WRITE. The decision above was made from a SELECT snapshot; the
  // UPDATE must re-assert every precondition that decision rested on, or the module's whole safety
  // premise inverts. Two concrete failures an unguarded `WHERE key = ?` allows:
  //
  //  1. LOST OPERATOR INTENT. Pod boots and reads `value=[m1,m2], updated_by=NULL`. Milliseconds
  //     later an admin PATCHes the Governance screen to `[m1]` — deliberately forbidding `m2` — which
  //     commits and sets `updated_by`. A blind UPDATE then writes `[m1,m2,m3]` from the stale
  //     snapshot, silently REINSTATING the model the human just forbade, and leaves `updated_by`
  //     pointing at that human — so the row now looks operator-owned (and is frozen from future
  //     healing) while holding a value that contradicts what they submitted. An admin poking
  //     Governance right after a deploy is not exotic; it is the likeliest moment for this.
  //  2. DUPLICATE AUDIT TRAIL. Prod runs 2+ replicas (HPA min 2) that boot together. Both read the
  //     same pre-heal snapshot, both compute the same `newValue` — harmless for the value, but each
  //     writes its own `policy_changes` + `audit_log` row for ONE healing event. The sibling
  //     `bootReconcileConnectorNotifications` reasons about exactly this ("would otherwise flood the
  //     audit log"); this module has to as well.
  //
  // Both close with one change: guard on `updated_by IS NULL` **and** on the value still being the
  // one we read, then let `RETURNING` tell us whether we won. The second replica's UPDATE matches
  // zero rows because the value has already moved, so exactly one pod writes exactly one diff and
  // one audit row. Same self-serializing `UPDATE … WHERE … RETURNING` shape as `host/tick-locks.ts`,
  // which exists because an advisory lock cannot work behind PgBouncer's transaction pooler — and
  // for the same reason, this must not depend on connection identity either.
  //
  // Wrapped in a transaction so a widened allowlist can never end up with no diff and no audit row:
  // the human PATCH route is non-transactional in the same way, but it runs in front of someone who
  // would notice a failed save, and this runs unattended on every boot.
  const won = await database.transaction(async (tx) => {
    const updated = await tx
      .update(policies)
      .set({ value: newValue })
      .where(
        and(
          eq(policies.key, key),
          isNull(policies.updated_by), // still never operator-edited
          eq(policies.value, oldValue), // still the exact value the decision was made from
        ),
      )
      .returning({ key: policies.key });
    if (updated.length === 0) return false; // someone else moved it — write NOTHING
    await tx.insert(policyChanges).values({
      policy_key: key,
      old_value: oldValue,
      new_value: newValue,
      changed_by: null, // System actor — boot reconcile, not a human PATCH (mirrors the house
      // pattern in routes/connectors.ts bootReconcileConnectorNotifications / routes/delivery.ts).
    });
    await recordAudit(
      {
        actorId: null,
        action: 'policy.boot_reconcile_allowlist',
        category: 'policy',
        targetType: 'policy',
        targetId: key,
        result: `Added ${plan.added.length} catalog model(s)`,
        resultTone: 'warn',
        metadata: { added: plan.added, oldValue, newValue },
      },
      tx as unknown as Db,
    );
    return true;
  });

  if (!won) {
    return { reconciled: false, added: [], reason: 'skipped_lost_race' };
  }

  // Only AFTER the transaction commits — invalidating earlier would let a concurrent reader
  // repopulate the cache from the pre-commit value.
  invalidatePolicyCache();

  return plan;
}

/**
 * server.ts boot hook. Never throws — a failure here must warn and continue, exactly like the
 * existing allowlist/pricing drift check it runs alongside (migrations already ran; the server
 * must still come up on a Postgres that is reachable but has some other problem with this row).
 */
export async function bootReconcileModelsAllowlist(database: Db = defaultDb): Promise<void> {
  try {
    const result = await reconcileModelsAllowlist(database);
    if (result.reconciled) {
      log.warn('models_allowlist_boot_reconciled', {
        component: 'models',
        key: MODELS_ALLOWLIST_KEY,
        addedCount: result.added.length,
        added: result.added,
      });
    }
  } catch (err) {
    log.error('models_allowlist_boot_reconcile_failed', { component: 'models', err });
  }
}
