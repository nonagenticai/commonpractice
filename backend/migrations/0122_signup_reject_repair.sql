-- 0122 — a rejected signup's cleanup, made observable and automatic (early-access v2, 2026-10-19).
--
--   reject_repair — set when a REJECT has something to undo, and what became of it:
--            { state: 'pending' | 'blocked' | 'done', tenantId, attempts, lastAttemptAt, nextAttemptAt,
--              lastError, blockers, keycloakIdentity, claimedUntil }.
--            'pending' = the founded workspace is not fully offboarded / its licence not revoked / the
--            minted identity not retired / an existing-mode seat or invite not revoked yet: the
--            onboarding-integrity tick (host/onboarding-integrity.ts `repairRejectedSignups`) retries it.
--            'blocked' = the workspace is in use (other members / user data): nothing destroyed,
--            shown on the super_admin signup screen until a super_admin retries. NULL = nothing to undo.
--            `claimedUntil` is a short lease so the tick, the screen and Telegram never run it twice
--            at once (services/signup-reject-repair.ts).
--   approve_effects — what an `existing`-mode approve of this signup did in a CUSTOMER workspace
--            before it aborted (a seat it created, an invite it sent): [{ tenantId, seatedUserId?,
--            inviteId? }, …]. A reject revokes exactly these and nothing else.
--
-- Additive, nullable, no backfill (pre-prod, forward-only). Idempotent. Platform-scoped like the rest of
-- signup_approvals (0027): outside tenant RLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS reject_repair jsonb;
ALTER TABLE signup_approvals ADD COLUMN IF NOT EXISTS approve_effects jsonb;

CREATE INDEX IF NOT EXISTS signup_approvals_reject_repair_state_idx
  ON signup_approvals ((reject_repair->>'state'))
  WHERE reject_repair IS NOT NULL;
