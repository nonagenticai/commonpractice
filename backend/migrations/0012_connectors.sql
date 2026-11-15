-- 0012_connectors.sql — Phase 2-A: real data connectors (read-only live sources).
-- A connector is a `dataset` whose source_type is live (postgres / storage / http):
-- the HOST fetches the source read-only (through the egress allowlist + SSRF guard),
-- parses it, and materializes the rows into dataset_rows via replaceRows(). The
-- runner is unchanged — it still only ever sees the cached rows served by
-- ctx.dataset(slug). Refresh is event-driven (Postgres NOTIFY + a token-authed
-- ingress), never polled. See src/datasets/connectors/ + src/host/egress-guard.ts.
--
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS is idempotent and runs fine inside the
-- migration runner's single outer transaction on PG12+ (verified on PG18); the only
-- rule — not USING the new literal in the same tx — holds here (we add columns only;
-- the seed/runtime use the literals later, in separate transactions).

ALTER TYPE dataset_source_type ADD VALUE IF NOT EXISTS 'postgres';
ALTER TYPE dataset_source_type ADD VALUE IF NOT EXISTS 'storage';
ALTER TYPE dataset_source_type ADD VALUE IF NOT EXISTS 'http';
ALTER TYPE dataset_status      ADD VALUE IF NOT EXISTS 'syncing';

-- Live-connector columns on datasets (all NULL for hand-uploaded datasets).
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS connection_config_encrypted TEXT;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS connection_meta             JSONB;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS event_source               TEXT;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS event_secret_encrypted     TEXT;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS last_synced_at             TIMESTAMPTZ;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS sync_error                 TEXT;
