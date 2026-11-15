-- 0120 — a fourth signup source: 'invite', the super_admin's pre-approved early-access invite.
--
-- POST /api/signup-approvals/invite (routes/onboarding.ts `inviteEarlyAccess`, George 2026-10-19)
-- records a signup row for a person the owner invites directly — they never submitted the public
-- form — and approves it in the same request (new workspace, invite email). The row is stamped
-- `source = 'invite'` so the queue history says how it arrived.
--
--   source — 'web' | 'chat' (intake) | 'app' (notify-self) | 'invite' (super_admin invite).
--            NULL = written by another path (unchanged from 0105).
--
-- Widens 0105's `signup_approvals_source_check`. Drop + re-add in ONE statement is idempotent
-- (runs at startup on every replica) and never leaves a window without the CHECK. Every existing
-- row satisfies the wider set, so the re-validation cannot fail. An old pod never writes 'invite'.
-- Platform-scoped like the rest of signup_approvals (0027): outside tenant RLS.
-- FORWARD-ONLY. Replacing a CHECK takes ACCESS EXCLUSIVE (and re-validates the rows), so the same
-- fail-fast ceiling as 0107/0109 rather than queueing every signup query behind a long reader.
SET LOCAL lock_timeout = '5s';

ALTER TABLE signup_approvals
  DROP CONSTRAINT IF EXISTS signup_approvals_source_check,
  ADD CONSTRAINT signup_approvals_source_check
    CHECK (source IS NULL OR source IN ('web', 'chat', 'app', 'invite'));
