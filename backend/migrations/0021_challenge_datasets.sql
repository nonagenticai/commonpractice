-- 0021_challenge_datasets.sql — Phase 3.0 (Pillar A): the challenge → applicable-datasets
-- link table. The person who raised a challenge (e.g. Mary in Claims) is the only one
-- who knows WHICH test data the challenge is about + WHY ("the amount column matters;
-- flag > €2,500"). This captures that binding so the builder + agent (3.1) can surface it.
--
-- We store dataset_slug (TEXT), not an FK to datasets.id, to match the slug-addressed app
-- (datasets.slug is only unique per (owner_id, slug); the link is resolved owner-scoped at
-- write time). note carries the creator's free-text guidance. added_by = who linked it.
-- PK(challenge_id, dataset_slug) makes a re-link idempotent; cascade on the challenge.
-- Matches src/db/schema.ts (challenge_datasets).

CREATE TABLE IF NOT EXISTS challenge_datasets (
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  dataset_slug TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  added_by     UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT challenge_datasets_pk PRIMARY KEY (challenge_id, dataset_slug)
);

CREATE INDEX IF NOT EXISTS challenge_datasets_challenge_id_idx ON challenge_datasets(challenge_id);
