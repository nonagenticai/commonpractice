-- 0041_weekly_winner_tenant_unique.sql
--
-- weekly_winners is a PER-TENANT table (tenant_id, RLS-scoped since 0028), but `week`
-- carried a GLOBAL unique constraint. That meant only ONE tenant could ever own a given
-- ISO week: the showcase seed's `2026-W23` insert for the fr-test tenant silently no-opped
-- because the demo tenant already owned that week — so the fr-test "This week's winner"
-- page rendered its empty state forever. Winners are per-tenant, so the uniqueness must be
-- per (tenant_id, week), not global week.
--
-- Drop the global unique, add the composite. Idempotent.

ALTER TABLE weekly_winners DROP CONSTRAINT IF EXISTS weekly_winners_week_key;

DO $$ BEGIN
  ALTER TABLE weekly_winners ADD CONSTRAINT weekly_winners_tenant_week_key UNIQUE (tenant_id, week);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
