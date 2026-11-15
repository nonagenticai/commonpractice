-- 0121 — the requester's language, so the approval email speaks it (early-access v2, 2026-10-19).
--
-- The homepage form sends `locale` (its <html lang> / na_lang cookie), the intake handler forwards
-- it, and the super_admin invite form picks one. On approve CP writes it onto the Keycloak user as
-- the `locale` attribute, which is what Keycloak renders the set-password email (and its pages) in.
--
--   locale — one of the eight languages CP and the nonagentic.ai site ship
--            ('ar','de','en','es','fr','he','nl','pl'); NULL = not told (the email falls back to en).
--
--   approving_until — a short claim taken by whoever is APPROVING the row right now (the super_admin
--            screen, or a Telegram decision via chat-bridge, possibly on another replica). One
--            conditional UPDATE takes it; while it is live nobody else can approve or reject the row,
--            so two deciders can never found two workspaces for one signup. NULL / past = free.
--            Renewed by a heartbeat while the approve runs (30-min ceiling).
--   approving_claim — the claim holder's token: only the holder renews or releases the claim, and
--            the final `approved` write requires it.
--
-- Additive, nullable, no backfill: every existing row is NULL, which already means "en".
-- Idempotent (runs at startup on every replica): ADD COLUMN IF NOT EXISTS + a guarded constraint.
-- Platform-scoped like the rest of signup_approvals (0027): outside tenant RLS.
-- FORWARD-ONLY. Adding a CHECK on a nullable column that every row satisfies takes ACCESS EXCLUSIVE
-- briefly (the validation scan), so the same fail-fast ceiling as 0107/0109/0120.
SET LOCAL lock_timeout = '5s';

ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS locale text;
ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS approving_until timestamptz;
ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS approving_claim uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'signup_approvals_locale_check'
       AND conrelid = 'signup_approvals'::regclass
  ) THEN
    ALTER TABLE signup_approvals
      ADD CONSTRAINT signup_approvals_locale_check
      CHECK (locale IS NULL OR locale IN ('ar', 'de', 'en', 'es', 'fr', 'he', 'nl', 'pl'));
  END IF;
END $$;
