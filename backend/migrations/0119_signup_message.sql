-- 0119 — the applicant's free-text message on an early-access signup.
--
-- POST /api/signup-approvals/intake (server-to-server, called by the nonagentic.ai form handler)
-- accepts an optional `message`; the super_admin reads it on /onboarding before approving.
--
--   message — free text, line breaks kept, other control / format characters stripped by the
--             route (utils/untrusted-text.ts `multiLineText`). NULL = not given, or another writer.
--
-- ⛔ Personal data: it is NOT sent in the Telegram notice and NOT logged.
-- Platform-scoped like the rest of signup_approvals (0027): outside tenant RLS; a new column on an
-- existing table, so no policy changes.
-- ADDITIVE, FORWARD-ONLY, idempotent (runs at startup on every replica; old pods never read it).

ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS message text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'signup_approvals_message_length_check'
       AND conrelid = 'signup_approvals'::regclass
  ) THEN
    ALTER TABLE signup_approvals
      ADD CONSTRAINT signup_approvals_message_length_check
      CHECK (message IS NULL OR char_length(message) <= 2000);
  END IF;
END $$;
