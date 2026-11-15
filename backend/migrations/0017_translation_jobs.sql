-- 0017_translation_jobs.sql — Phase 2-G: deep i18n content pipeline.
-- Matches src/db/schema.ts (translation_jobs table).
--
-- §5B shipped the READ side of user-generated-content i18n: content_translations
-- (PK entity_type,entity_id,locale,field) + getTranslation/getTranslationsBatch,
-- wired into challenges + solutions. But the WRITE side was seed-only: a real
-- (non-seeded) challenge/solution got NO translations, and block docs were never
-- localized at all. translation_jobs is the QUEUE that makes the write side real:
-- on content create/edit (or an admin backfill) one row is enqueued per
-- translatable cell × target locale; a boot-only interval drainer
-- (host/translation-scheduler.ts) translates each via the metered LLM broker and
-- UPSERTs the result into content_translations.
--
-- Idempotency + staleness are carried by UNIQUE(entity_type,entity_id,field,
-- target_locale) + source_hash: enqueue is INSERT … ON CONFLICT DO UPDATE guarded
-- by `source_hash <> EXCLUDED.source_hash`, so an unchanged cell is never
-- re-translated and an edited cell re-enters the queue exactly once. requested_by
-- is the metering actor (the content creator for auto-enqueue, the admin for a
-- backfill) — the broker locks that user's usage_counters row, so a daily-cap
-- reject simply DEFERS the batch (jobs stay 'pending'), never fails content.

CREATE TABLE IF NOT EXISTS translation_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'challenge' | 'solution' | 'block' — the content_translations.entity_type.
  entity_type    TEXT NOT NULL,
  -- the row id (uuid as text) or, for blocks, the slug — matches the read overlay.
  entity_id      TEXT NOT NULL,
  -- 'title' | 'description' | 'business_impact' | 'name' | 'docs_md' | …
  field          TEXT NOT NULL,
  -- one of the 7 non-default locales (en is the base, never a target).
  target_locale  TEXT NOT NULL,
  -- snapshot of the en value at enqueue → translate a STABLE value.
  source_text    TEXT NOT NULL,
  -- sha256(source_text): the staleness key. On re-enqueue, an unchanged hash is a
  -- no-op; a changed hash resets the job to 'pending' (re-translate the new text).
  source_hash    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed | skipped
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  -- the metering actor (FK users): creator for auto-enqueue, admin for backfill.
  requested_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one job per translatable cell × target locale (the enqueue claim key).
  UNIQUE (entity_type, entity_id, field, target_locale)
);

-- the drainer selects WHERE status='pending' ORDER BY created_at.
CREATE INDEX IF NOT EXISTS translation_jobs_status_idx ON translation_jobs (status);
