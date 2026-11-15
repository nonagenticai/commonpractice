-- 0006_marketplace.sql — Session 5: the marketplace (Challenges & Solutions).
-- Matches src/db/schema.ts. Turns the demo's Discover half into real data:
-- challenges (problems posted from a work area) → solutions (built on a flow) →
-- votes (one upvote per user per target) → weekly_winners. Plus a comments table
-- for the challenge-detail discussion thread.
--
-- votes_count on challenges/solutions is a DENORMALIZED leaderboard counter: it
-- carries a seeded fidelity baseline (the demo's 284/316/…) and is bumped ±1 by
-- the live vote toggle inside a transaction. The `votes` table holds ONLY genuine
-- per-user upvote rows — we never fabricate live votes (same posture as S4's 312).

DO $$ BEGIN
  CREATE TYPE challenge_status AS ENUM ('voting', 'solution_phase', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE solution_status AS ENUM ('draft', 'voting', 'shipping', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE vote_target_type AS ENUM ('challenge', 'solution');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- challenges ----
CREATE TABLE IF NOT EXISTS challenges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  business_impact TEXT NOT NULL DEFAULT '',
  work_area       TEXT NOT NULL,
  submitter_id    UUID NOT NULL REFERENCES users(id),
  status          challenge_status NOT NULL DEFAULT 'voting',
  week            TEXT NOT NULL DEFAULT '',
  metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  code            TEXT,
  votes_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS challenges_status_idx ON challenges(status);
CREATE INDEX IF NOT EXISTS challenges_submitter_id_idx ON challenges(submitter_id);
CREATE INDEX IF NOT EXISTS challenges_work_area_idx ON challenges(work_area);

-- ---- solutions ----
-- flow_id is the built flow on the Build canvas (S2). ON DELETE SET NULL so an
-- archived/removed flow never cascades away a solution's leaderboard history.
CREATE TABLE IF NOT EXISTS solutions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id        UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  author_id           UUID NOT NULL REFERENCES users(id),
  flow_id             UUID REFERENCES flows(id) ON DELETE SET NULL,
  status              solution_status NOT NULL DEFAULT 'voting',
  week                TEXT NOT NULL DEFAULT '',
  build_time_minutes  INTEGER,
  demo_seconds        INTEGER,
  blocks_used         JSONB NOT NULL DEFAULT '[]'::jsonb,
  votes_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS solutions_challenge_id_idx ON solutions(challenge_id);
CREATE INDEX IF NOT EXISTS solutions_author_id_idx ON solutions(author_id);
CREATE INDEX IF NOT EXISTS solutions_status_idx ON solutions(status);

-- ---- votes (one upvote per user per target) ----
-- target_id is a loose UUID (challenge or solution per target_type) — there is no
-- single FK because it points at two tables; the app maintains votes_count.
CREATE TABLE IF NOT EXISTS votes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  target_type vote_target_type NOT NULL,
  target_id   UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT votes_user_target_uq UNIQUE (user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS votes_target_idx ON votes(target_type, target_id);

-- ---- comments (challenge-detail discussion) ----
CREATE TABLE IF NOT EXISTS comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  author_id    UUID NOT NULL REFERENCES users(id),
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comments_challenge_id_idx ON comments(challenge_id);

-- ---- weekly_winners ----
CREATE TABLE IF NOT EXISTS weekly_winners (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week         TEXT NOT NULL UNIQUE,
  solution_id  UUID NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  challenge_id UUID REFERENCES challenges(id) ON DELETE SET NULL,
  stats        JSONB,
  announced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Now that `solutions` exists, wire the forward FK the flows table reserved in S2
-- (schema.ts:139 — column was added without a FK). Idempotent.
DO $$ BEGIN
  ALTER TABLE flows
    ADD CONSTRAINT flows_solution_id_fk
    FOREIGN KEY (solution_id) REFERENCES solutions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
