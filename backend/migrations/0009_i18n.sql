-- 0009_i18n.sql — §5B internationalization: persist a per-user UI locale.
-- content_translations + mcp_prompts.locale already exist (0008); only the
-- users.locale preference column is missing. Idempotent (re-runnable).
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en';
