-- 0015_audit_exports.sql — Phase 2-F: observability + compliance export.
-- Matches src/db/schema.ts (audit_exports table, audit_export_status /
-- audit_export_trigger enums).
--
-- A nightly job archives the append-only audit_log (plus the day's policy_changes
-- count) as a tamper-evident NDJSON bundle in object storage — the durable evidence a
-- compliance reviewer (ISO 27001 / GDPR / DORA, named on the governance screen) asks
-- for, instead of audit history living only in Postgres. This table is the durable
-- RECORD of each export run AND the concurrency guard: UNIQUE(export_date) lets a run
-- "claim the day" via INSERT … ON CONFLICT DO NOTHING, so a missed/double/multi-replica
-- fire is harmless (no row returned ⇒ already claimed ⇒ skip).

DO $$ BEGIN
  CREATE TYPE audit_export_status AS ENUM ('running', 'success', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE audit_export_trigger AS ENUM ('scheduler', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS audit_exports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the UTC day whose audit_log rows this export covers; the day-claim key.
  export_date   DATE NOT NULL UNIQUE,
  status        audit_export_status NOT NULL DEFAULT 'running',
  row_count     INTEGER NOT NULL DEFAULT 0,
  -- where the bundle landed (the manifest object key) + which bucket.
  object_key    TEXT,
  bucket        TEXT,
  -- sha256 over the NDJSON body — tamper-evidence for the archive.
  sha256        TEXT,
  bytes         INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  triggered_by  audit_export_trigger NOT NULL DEFAULT 'scheduler',
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_exports_export_date_idx ON audit_exports(export_date);
