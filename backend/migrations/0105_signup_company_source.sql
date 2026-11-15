-- 0105 — where an early-access signup came from, and the company it named.
--
-- Early-access self-registration (George 2026-10-14): signups arrive from the nonagentic.ai website
-- form and the signup chat, server-to-server through POST /api/signup-approvals/intake, and from the
-- CP app itself through POST /api/signup-approvals/notify-self. George approves each one from a
-- Telegram notification, which shows both fields; approve uses `company` as the default workspace
-- name (routes/onboarding.ts `defaultTenantName`).
--
--   company — free text the requester typed (≤160 chars, enforced by the route). NULL = not given.
--   source  — 'web' | 'chat' (intake) | 'app' (notify-self). NULL = written by another path
--             (user-service.ts recordSignupStrand, the 0088/0092 backfills) or before this column.
--
-- Platform-scoped like the rest of signup_approvals (0027): outside tenant RLS.
-- FORWARD-ONLY, idempotent (runs at startup on every replica).

ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'signup_approvals_source_check'
       AND conrelid = 'signup_approvals'::regclass
  ) THEN
    ALTER TABLE signup_approvals
      ADD CONSTRAINT signup_approvals_source_check
      CHECK (source IS NULL OR source IN ('web', 'chat', 'app'));
  END IF;
END $$;
