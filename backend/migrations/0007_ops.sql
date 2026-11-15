-- 0007_ops.sql — Session 6: the platform governance triad (Operate half).
-- Matches src/db/schema.ts. Turns the demo's Pipeline / Governance / Audit
-- screens into real data + a live enforcement spine:
--   policies        — the editable governance rails. THE LIVE SOURCE OF TRUTH:
--                     the LLM broker, the idle-sweep watchdog, and the run-gate
--                     read these (behind getGovernanceLimits()/getSandboxLimits()/
--                     enforceRunPolicies) instead of config constants. Editing a
--                     row here changes runtime behaviour.
--   policy_changes  — old→new diff per policy edit (the governance "Recent changes").
--   pipeline_items  — the production-pipeline kanban cards (review → hardening →
--                     staging → production). Promotion is gated by the promotion.*
--                     policies. Winning solutions auto-enqueue into 'review'.
--   audit_log       — append-only feed; every mutating action writes one row. The
--                     seeded historical rows are a labelled fidelity baseline (same
--                     posture as S4's 312 / S5 votes); live actions append genuine rows.

DO $$ BEGIN
  CREATE TYPE pipeline_stage AS ENUM ('review', 'hardening', 'staging', 'production');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- policies (the governance rails — live source of truth) ----
-- `value` jsonb holds the live value per control: a bool (toggle), a number, a
-- string (select), or a string[] (list). `control` tells the UI which widget to
-- render and the API which zod shape to validate against. Seeded to the demo's
-- displayed values; config.governance.* is the code-level fallback if a row is absent.
CREATE TABLE IF NOT EXISTS policies (
  key         TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  label       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  control     TEXT NOT NULL,
  value       JSONB NOT NULL,
  options     JSONB,
  unit        TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policies_category_idx ON policies(category);

-- ---- policy_changes (governance sidebar "Recent changes" + audit detail) ----
CREATE TABLE IF NOT EXISTS policy_changes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key TEXT NOT NULL REFERENCES policies(key) ON DELETE CASCADE,
  old_value  JSONB,
  new_value  JSONB,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policy_changes_created_at_idx ON policy_changes(created_at DESC);
CREATE INDEX IF NOT EXISTS policy_changes_policy_key_idx ON policy_changes(policy_key);

-- ---- pipeline_items (the production-pipeline kanban) ----
-- solution_id links a card to a built marketplace solution (Lisa's winner = the
-- featured #CH-284 card). SET NULL keeps a card's pipeline history if its solution
-- is later removed. `progress` is {day, ofDays} for hardening cards; rollout_pct is
-- the canary percent on staging/production. reviewed + reviewer_count back the
-- promotion gate (promotion.mandatory_review / promotion.required_reviewers).
CREATE TABLE IF NOT EXISTS pipeline_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id    UUID REFERENCES solutions(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  author_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  stage          pipeline_stage NOT NULL DEFAULT 'review',
  week           TEXT,
  rollout_pct    INTEGER NOT NULL DEFAULT 0,
  progress       JSONB,
  reviewed       BOOLEAN NOT NULL DEFAULT FALSE,
  reviewer_count INTEGER NOT NULL DEFAULT 0,
  featured       BOOLEAN NOT NULL DEFAULT FALSE,
  live           BOOLEAN NOT NULL DEFAULT FALSE,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_items_stage_idx ON pipeline_items(stage);
CREATE INDEX IF NOT EXISTS pipeline_items_solution_id_idx ON pipeline_items(solution_id);

-- ---- audit_log (append-only platform feed) ----
-- actor_id NULL = a System action (the nightly job / watchdog). `category` is the
-- audit-screen filter chip (sandbox|block|policy|deploy|auth|system). result +
-- result_tone drive the dot-status cell (ok=emerald, warn=amber, error=rose).
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'system',
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT,
  result      TEXT,
  result_tone TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_category_idx ON audit_log(category);
CREATE INDEX IF NOT EXISTS audit_log_actor_id_idx ON audit_log(actor_id);
