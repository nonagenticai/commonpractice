-- 0118_drop_purge_snapshots.sql — drop the 19 `_purge_*` snapshot tables left behind on prod by
-- the 2026-08-07 seeder-meter purge and the 2026-08-09 fabricated-history purge.
--
-- WHY. Those purges snapshotted every deleted row into `_purge_<date>_<table>` "until the live
-- screens have been reviewed" (scripts/purge-fabricated-history.ts). They were reviewed; the tables
-- are debris, read by no code on main and depended on by nothing (no view, FK, function, trigger,
-- policy or publication — checked on prod 2026-10-16). One of them, `_purge_20260809b_users`, still
-- holds 2 personal email addresses, which is the reason not to keep them indefinitely.
--
-- APPROVAL. The product owner approved dropping them on 2026-10-16.
--
-- ⛔ THIS IS A ONE-WAY DOOR. After this runs the only copy of these rows is in the nightly backups on
-- `air`, which keep a copy for up to 14 days; after that the data is gone for good.
--
-- OWNERSHIP. 15 of the 19 (the `_purge_20260807_*` and `_purge_20260809b_*` families) were created
-- by hand as `postgres`, not by the migration role. The drop still works: schema `public` is owned
-- by `pg_database_owner`, i.e. by `commonpractice_user` as the database owner, and a schema's owner
-- may drop any table in it. Proven on prod 2026-10-16 in a rolled-back transaction under
-- `SET LOCAL ROLE commonpractice_user` with ownership untouched: all 19 dropped, 0 left.
--
-- WHY AN EXPLICIT LIST AND NOT A `LIKE '\_purge\_%'` LOOP: the list is reviewable, and a dynamic
-- pattern could silently drop a future table nobody approved. CI databases never contained these
-- tables (no migration ever created them), so `IF EXISTS` makes this a no-op there.

-- 2026-08-07 seeder-meter purge (owner on prod: postgres)
DROP TABLE IF EXISTS public._purge_20260807_flow_run_events;
DROP TABLE IF EXISTS public._purge_20260807_flow_runs;
DROP TABLE IF EXISTS public._purge_20260807_usage_counters;
DROP TABLE IF EXISTS public._purge_20260807_usage_events;

-- 2026-08-09 fabricated-history purge, script run (owner on prod: commonpractice_user)
DROP TABLE IF EXISTS public._purge_20260809_audit_log;
DROP TABLE IF EXISTS public._purge_20260809_pipeline_items;
DROP TABLE IF EXISTS public._purge_20260809_policy_changes;
DROP TABLE IF EXISTS public._purge_20260809_usage_events;

-- 2026-08-09 fabricated-history purge, second pass (owner on prod: postgres)
DROP TABLE IF EXISTS public._purge_20260809b_challenges;
DROP TABLE IF EXISTS public._purge_20260809b_comments;
DROP TABLE IF EXISTS public._purge_20260809b_flow_runs;
DROP TABLE IF EXISTS public._purge_20260809b_flows;
DROP TABLE IF EXISTS public._purge_20260809b_llm_settings;
DROP TABLE IF EXISTS public._purge_20260809b_sandboxes;
DROP TABLE IF EXISTS public._purge_20260809b_solutions;
DROP TABLE IF EXISTS public._purge_20260809b_tenants;
DROP TABLE IF EXISTS public._purge_20260809b_usage_events;
DROP TABLE IF EXISTS public._purge_20260809b_users;
DROP TABLE IF EXISTS public._purge_20260809b_weekly_winners;
