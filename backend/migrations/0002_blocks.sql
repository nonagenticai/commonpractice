-- 0002_blocks.sql — Session 1: building blocks library + versioning.
-- Matches src/db/schema.ts (building_blocks + block_versions + 3 enums).

DO $$ BEGIN
  CREATE TYPE block_category AS ENUM ('data', 'ai', 'logic', 'output', 'ui');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE block_status AS ENUM ('draft', 'beta', 'stable', 'deprecated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE block_language AS ENUM ('typescript');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS building_blocks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  category           block_category NOT NULL,
  current_version_id UUID,
  maintainer_id      UUID REFERENCES users(id),
  region             TEXT,
  cost_class         TEXT,
  license            TEXT,
  archived           BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS block_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id      UUID NOT NULL REFERENCES building_blocks(id) ON DELETE CASCADE,
  version       TEXT NOT NULL,
  status        block_status NOT NULL DEFAULT 'draft',
  language      block_language NOT NULL DEFAULT 'typescript',
  docs_md       TEXT NOT NULL DEFAULT '',
  source_ts     TEXT NOT NULL DEFAULT '',
  descriptor    JSONB NOT NULL,
  examples      JSONB NOT NULL DEFAULT '[]'::jsonb,
  changelog     TEXT NOT NULL DEFAULT '',
  tests_passing BOOLEAN NOT NULL DEFAULT false,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  published_by  UUID REFERENCES users(id),
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT block_versions_block_version_uq UNIQUE (block_id, version)
);

-- Two-way FK: added after both tables exist to avoid a circular create.
DO $$ BEGIN
  ALTER TABLE building_blocks
    ADD CONSTRAINT building_blocks_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES block_versions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS block_versions_block_id_idx ON block_versions(block_id);
CREATE INDEX IF NOT EXISTS building_blocks_category_idx ON building_blocks(category);
