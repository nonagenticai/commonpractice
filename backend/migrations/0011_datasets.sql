-- 0011_datasets.sql — Phase 2.0: datasets / test-data subsystem.
-- Matches src/db/schema.ts (datasets + dataset_rows + dataset_source_type/status
-- enums). Developer-supplied test data (CSV / Excel / SQL-paste / text / JSON),
-- parsed into a typed column schema + JSONB rows so blocks + the agent run over
-- realistic inputs instead of the 5 baked mock-data kinds. Owner-scoped (= tenant
-- in this app); sandbox_id NULL = owner/tenant-shared, set = scoped to one sandbox.
-- dataset_rows holds one JSONB row object per idx (cascade-deleted with its dataset).

DO $$ BEGIN
  CREATE TYPE dataset_source_type AS ENUM ('csv', 'xlsx', 'sql', 'text', 'json');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dataset_status AS ENUM ('ready', 'parsing', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS datasets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID NOT NULL REFERENCES users(id),
  tenant_id   TEXT,
  sandbox_id  UUID REFERENCES sandboxes(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  source_type dataset_source_type NOT NULL,
  columns     JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_count   INTEGER NOT NULL DEFAULT 0,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  status      dataset_status NOT NULL DEFAULT 'ready',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE datasets ADD CONSTRAINT datasets_owner_slug_uq UNIQUE (owner_id, slug);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS datasets_owner_id_idx ON datasets(owner_id);
CREATE INDEX IF NOT EXISTS datasets_sandbox_id_idx ON datasets(sandbox_id);

CREATE TABLE IF NOT EXISTS dataset_rows (
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  data       JSONB NOT NULL,
  CONSTRAINT dataset_rows_pk UNIQUE (dataset_id, idx)
);

CREATE INDEX IF NOT EXISTS dataset_rows_dataset_id_idx ON dataset_rows(dataset_id);
