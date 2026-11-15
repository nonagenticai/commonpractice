-- 0065_flow_runs_solution_id.sql
-- Which SOLUTION a run was a demo of. Nullable: /build draft runs and block tests have no solution.
--
-- ⛔ READ THIS BEFORE DELETING IT AS A REPEAT OF 0056. It is not one.
--
-- `0056_drop_flows_solution_id.sql` dropped `flows.solution_id`, and it was right to. That column
-- pointed the wrong way down a one-to-many: ONE flow can back SEVERAL solutions (the author
-- resubmits the same canvas to a second challenge — `routes/flows.ts:165-167` uses `.limit(1)`
-- precisely because the reverse lookup is ambiguous), so a single `flows.solution_id` could only
-- ever name one of them. It was also a DUPLICATE: `solutions.flow_id` already carried the identical
-- fact from the side that can hold it, and the two halves drifted until viewer authorization read
-- one while writes went to the other.
--
-- THIS column is neither. It records a fact about a RUN — "this execution was the live demo of
-- solution X" — that no existing column carries and that cannot be derived:
--
--   • `flow_runs.flow_id` cannot stand in for it. `routes/flows.ts:119-126` lets a `submitted` flow
--     keep being edited while `solutions.published_graph` is frozen by the 0055 trigger, so a run
--     joined through `flow_id` may have executed a DIFFERENT graph than the one published — quite
--     possibly a graph that predates the solution entirely.
--   • With several solutions on one flow, a `flow_id` join attributes a sibling's demo to this
--     solution, and draft `/build` runs land in the same bucket as published demos.
--
-- The direction is the many side (runs) pointing at the one side (solutions), which is the only
-- direction that can be correct. ON DELETE SET NULL, not CASCADE: a deleted solution must not take
-- the tenant's run history and its cost ledger with it — the run happened, and `usage_events`
-- reconciles against it.
--
-- Written EXPAND-only (add column + add index), so it is safe under the rolling deploy the 0056
-- header describes: old replicas never name the column, new ones write it, and nothing reads a
-- value that is not there yet (absent ⇒ the DTO says `null`, never `0`).
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS solution_id uuid REFERENCES solutions(id) ON DELETE SET NULL;

-- The one query this column exists for: `host/solution-demo.ts` `demoMsForSolutions`, a
-- DISTINCT ON (solution_id) … ORDER BY solution_id, finished_at DESC over a handful of ids.
--
-- PARTIAL on `status = 'ok'` because that predicate is in the query and is highly selective —
-- ⚠️ 'ok' is the SUCCESS value of the `flow_run_status` enum ('running' | 'ok' | 'partial' |
-- 'failed'); there is no 'succeeded'. `partial` is deliberately OUT: a run that half-failed is not
-- a demo whose duration should be advertised beside a solution.
CREATE INDEX IF NOT EXISTS flow_runs_solution_finished_idx
  ON flow_runs (solution_id, finished_at DESC)
  WHERE status = 'ok';
