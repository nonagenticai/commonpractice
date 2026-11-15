-- 0097_tenant_licence_revoke_pending.sql — a durable SET of "old licences still to be revoked".
--
-- A tenant-licence swap (re-home of a pre-A2 tenant, a plan/date change) compare-and-sets the new
-- licence in FIRST and revokes the old one AFTER. A failure of that revoke used to be a log line:
-- the tenant was already on its new cp-tenant holder, nothing selected it again, and the old licence
-- (e.g. one bound to a super_admin) stayed active forever.
--
-- A SET, not one id: a second failed revoke must not overwrite the first (the first id would be lost
-- and stay active). Ids are appended (deduplicated) in the SAME compare-and-set as the swap; an id is
-- removed only when licences confirms its revoke — or when it turns out to be the licence the
-- tenant now STORES, or a live member's seat in this tenant, which must never be revoked from here.
-- Every path that stores licence X as the tenant licence removes X in its own CAS. The
-- onboarding-integrity sweep settles the set under the per-tenant licence lease (0096).
--
-- A column on `tenants` (outside RLS, like every other tenant-licence column) rather than a table:
-- no policy, no grant, and the append/remove rides inside the swap's own UPDATE.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS licence_revoke_pending uuid[] NOT NULL DEFAULT '{}';
