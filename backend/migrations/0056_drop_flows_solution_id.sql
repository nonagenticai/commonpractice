-- 0056_drop_flows_solution_id.sql
-- The CONTRACT half of the expand/contract started in 0054.
--
-- `flows.solution_id` was a duplicate of the canonical `solutions.flow_id`: writes went to one side
-- and viewer authorization read the other, so a normally-submitted solution rendered a Run button
-- that 404'd. 0054 backfilled the canonical side and the application stopped reading this column
-- entirely; it has been dead weight since that release shipped.
--
-- It is dropped in a SEPARATE release on purpose. Migrations run at pod STARTUP and the HPA keeps
-- 2-4 replicas, so dropping it in 0054 would have run the new pod's migration while old pods were
-- still serving — and drizzle emits explicit column lists, so every `select().from(flows)` on an old
-- replica would have failed 42703 for the whole rollout window. By now every replica runs code that
-- never names the column, so the drop is invisible to running traffic.
--
-- Dropping the column also drops `flows_solution_id_fk` and any index over it; the explicit
-- constraint drop below just makes a partially-applied older state converge cleanly.
ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_solution_id_fk;
ALTER TABLE flows DROP COLUMN IF EXISTS solution_id;
