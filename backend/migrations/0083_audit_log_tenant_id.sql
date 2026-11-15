-- 0083_audit_log_tenant_id.sql — make audit rows tenant-attributable.
--
-- WHY
-- ---
-- `audit_log` (0007_ops.sql:88-99) has columns id, actor_id, action, category, target_type,
-- target_id, result, result_tone, metadata, created_at — and no `tenant_id`. No later migration
-- adds one. For a multi-tenant product that is a compliance problem rather than a leak: you cannot
-- answer "show me everything that happened in THIS workspace" without joining through `users` and
-- hoping nobody ever changed tenant, and you cannot hand one tenant its own trail without
-- recomputing that join every time.
--
-- ⚠️ THIS DOES NOT PUT audit_log UNDER RLS, AND THAT IS DELIBERATE. `0028_rls.sql:21-25` lists it
-- explicitly, alongside `tenants`, `users` and `signup_approvals`, as a PLATFORM/GLOBAL table that
-- stays OUTSIDE RLS. Platform actions legitimately have no tenant, and an RLS policy here would
-- make the super-admin console's own audit view depend on whichever tenant an operator happened to
-- be scoped into. The column makes rows ATTRIBUTABLE and FILTERABLE; enforcement stays where it is.
--
-- ⚠️ NO FOREIGN KEY TO `tenants`, ON PURPOSE. An audit row must outlive the thing it describes: a
-- tenant offboarding deletes the tenant row, and an FK would then either delete the audit trail
-- (ON DELETE CASCADE — destroying exactly the record you need after an offboarding dispute) or
-- block the offboarding (RESTRICT). A dangling uuid is the correct trade for an append-only trail.
-- `actor_id`'s existing FK is `ON DELETE SET NULL` for the same family of reasons.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id uuid;

-- ⛔ BEST-EFFORT, AND MEASURABLY PARTIAL — do not read this backfill as history.
--
-- Measured in production before writing this: 323 rows, of which 116 have an `actor_id` that joins
-- to `users`. So this can attribute at most ~36% of existing rows; the remaining 207 have a NULL
-- actor (system actions, plus the orphan-actor fallback in host/audit-service.ts that deliberately
-- rewrites actor_id to NULL and preserves the subject in `metadata.actorSub`).
--
-- ⚠️ AND EVEN THOSE 116 ARE APPROXIMATE. `users.tenant_id` is a user's CURRENT tenant, not their
-- tenant at the time of the event, and `PATCH /api/admin/users/:userId/tenant` exists precisely so
-- people can be moved. A user who moved workspaces will have their old rows attributed to their new
-- tenant. That is strictly better than NULL for the operational question this column answers, and
-- strictly worse than the truth — so it is recorded here rather than presented as history.
--
-- New rows do not have this problem: host/audit-service.ts stamps the tenant from the live request
-- context at write time, which is accurate by construction.
UPDATE audit_log a
SET tenant_id = u.tenant_id
FROM users u
WHERE a.actor_id = u.id
  AND a.tenant_id IS NULL
  AND u.tenant_id IS NOT NULL;

-- The access pattern this column exists for is "this tenant's trail, newest first" — which is also
-- exactly how routes/audit.ts pages (PAGE_SIZE = 25, ordered by created_at). A partial index keeps
-- it off the platform rows, which are the majority today and are never queried by tenant.
CREATE INDEX IF NOT EXISTS audit_log_tenant_created_idx
  ON audit_log (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;
