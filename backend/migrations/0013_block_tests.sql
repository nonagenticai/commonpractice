-- 0013_block_tests.sql — Phase 2-B: per-block tests (dataset-backed, gate publish).
-- Matches src/db/schema.ts (block_tests + block_test_results + block_assert_mode /
-- block_test_status enums). `examples` (docs) stays untouched; tests are first-class,
-- runnable, gating. The suite (block_tests) is BLOCK-scoped so it persists across
-- versions; a result (block_test_results) is recorded per (version, test) so the
-- publish gate checks the specific version's source. block_versions.tests_passing
-- (already present) becomes the cached rollup, set true only when every enabled test
-- has a `pass` result for that version. The test runner executes a block as a 1-node
-- graph through the real runner subprocess (see src/blocks/test-runner.ts).

DO $$ BEGIN
  CREATE TYPE block_assert_mode AS ENUM ('exact', 'subset');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE block_test_status AS ENUM ('pass', 'fail', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS block_tests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id            UUID NOT NULL REFERENCES building_blocks(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  inputs              JSONB NOT NULL DEFAULT '{}'::jsonb,
  datasets            TEXT[] NOT NULL DEFAULT '{}',
  expected            JSONB,
  assert_mode         block_assert_mode NOT NULL DEFAULT 'subset',
  expect_error        BOOLEAN NOT NULL DEFAULT false,
  expected_error_kind TEXT,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE block_tests ADD CONSTRAINT block_tests_block_name_uq UNIQUE (block_id, name);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS block_tests_block_id_idx ON block_tests(block_id);

CREATE TABLE IF NOT EXISTS block_test_results (
  version_id  UUID NOT NULL REFERENCES block_versions(id) ON DELETE CASCADE,
  test_id     UUID NOT NULL REFERENCES block_tests(id) ON DELETE CASCADE,
  status      block_test_status NOT NULL,
  actual      JSONB,
  error       TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT block_test_results_pk UNIQUE (version_id, test_id)
);

CREATE INDEX IF NOT EXISTS block_test_results_test_id_idx ON block_test_results(test_id);
