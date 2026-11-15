-- 0040_pipeline_reviewed_by.sql — capture WHO approved a pipeline card, not just a count.
--
-- The kanban "approve" action recorded only reviewer_count (and the UI hardcoded it to 2),
-- so a reviewed card could not attribute the approval. Add reviewed_by (the acting admin)
-- + reviewed_at so the card can show "Approved by <name>". Forward-only, additive,
-- nullable: existing reviewed rows keep their count and simply have no attribution until
-- the next approval. Identity capture only — the promotion gate (reviewer_count vs
-- promotion.required_reviewers) is unchanged.

ALTER TABLE pipeline_items
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
