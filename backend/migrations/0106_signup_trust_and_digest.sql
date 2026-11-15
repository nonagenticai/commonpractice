-- 0106 — which TRUSTED path admitted a signup, and when an untrusted one was last digested.
--
-- George's Telegram is told about a new pending signup ONE BY ONE only when its source is trusted
-- (routes/onboarding.ts `admitAndRecord`):
--   'intake'         — POST /api/signup-approvals/intake (the website/chat service account)
--   'verified_email' — notify-self whose token proves the address (the row carries keycloak_sub)
--   'turnstile'      — anonymous notify-self that PASSED Cloudflare Turnstile verification
--   NULL             — anything else (anonymous notify-self without Turnstile, and every row written
--                      by other paths or before this column). Still queued, never announced singly.
-- The NULL population is summarised by the periodic digest (host/signup-digest-scheduler.ts),
-- which stamps `digested_at` on the rows it has counted as "new" so the next digest only fires
-- when something new arrived.
--
-- Platform-scoped like the rest of signup_approvals (0027): outside tenant RLS.
-- FORWARD-ONLY, idempotent (runs at startup on every replica).

ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS trust text;
ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS digested_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'signup_approvals_trust_check'
       AND conrelid = 'signup_approvals'::regclass
  ) THEN
    ALTER TABLE signup_approvals
      ADD CONSTRAINT signup_approvals_trust_check
      CHECK (trust IS NULL OR trust IN ('intake', 'verified_email', 'turnstile'));
  END IF;
END $$;

-- Backfill: a row from the server-to-server intake (0105 `source` 'web' | 'chat') was always
-- trusted. Every other existing row stays NULL — nothing recorded at the time vouches for it.
UPDATE signup_approvals SET trust = 'intake' WHERE trust IS NULL AND source IN ('web', 'chat');

-- The digest's two counts read exactly this population (pending AND untrusted).
CREATE INDEX IF NOT EXISTS signup_approvals_pending_untrusted_idx
  ON signup_approvals (created_at)
  WHERE status = 'pending' AND trust IS NULL;
