-- 0050_users_soft_delete.sql
--
-- Offboarding a member was IMPOSSIBLE for anyone real, and the attempt stranded a ghost.
--
-- `DELETE /api/tenants/:id/users/:userId` deleted the Keycloak identity FIRST and only then the
-- local row. But 14 foreign keys reference `users.id` with ON DELETE NO ACTION — including
-- `usage_counters.user_id`, which means ANY member who has ever made a metered LLM call is
-- undeletable, not merely those who authored a dataset or a solution. So the delete raised
-- 23503, the request died on a raw Postgres error, and what remained was a member whose realm
-- identity was gone but whose `users` row survived. From then on their address answered
-- `400 email_exists` on every re-invite, forever, with no identity behind it.
--
-- Hard delete was never viable against this FK graph, and making the 14 FKs cascade would be
-- worse: it would erase the authorship of datasets, flows, solutions, comments and votes, plus
-- the `usage_counters` spend ledger, every time an employee left.
--
-- So offboarding becomes a TOMBSTONE. The row stays and keeps satisfying every FK, so
-- "authored by Jane" still renders on the work Jane did; what she loses is her realm identity
-- and her seat. Reads that mean "who is IN this workspace" — the seat count, the members
-- roster, the invitability check — filter `deleted_at IS NULL`; reads that mean "who MADE
-- this" deliberately do not. Precedent: the Phase 3.7 ontology tombstone (0024).
--
-- Nullable, no backfill: every existing row is a live member and must stay one. `users` is
-- outside the RLS regime (0028 §COVERAGE), so no policy changes.

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 0048 added `users_tenant_id_idx` because the seat count is a hot path that an over-cap
-- tenant re-enters on every request. That count now carries `AND deleted_at IS NULL`, so it
-- needs a matching PARTIAL index or the planner falls back to the full-table scan 0048 removed.
-- Same reasoning as 0048 on CONCURRENTLY: migrations run at startup inside one transaction with
-- a per-file SAVEPOINT (db/migration-runner.ts), and CREATE INDEX CONCURRENTLY cannot run in a
-- transaction block. One row per human user — the build is milliseconds.
CREATE INDEX IF NOT EXISTS users_tenant_id_active_idx
  ON users (tenant_id)
  WHERE deleted_at IS NULL;
