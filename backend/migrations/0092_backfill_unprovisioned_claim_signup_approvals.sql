-- 0092_backfill_unprovisioned_claim_signup_approvals.sql — queue users stranded by a claim that
-- named a tenant CP never provisioned.
--
-- WHY THIS EXISTS
-- `ensureUser` (services/user-service.ts) queued a `signup_approvals` row only on its NO-CLAIM
-- branch. A user whose JWT carried a `tenant_id` claim for a tenant CP has NOT provisioned (an fr /
-- portal tenant with no CP workspace) went down the seat path instead: `claimJitSeat`'s FK-safe
-- nested SELECT resolved to NULL, the row stayed `tenant_id IS NULL`, and nothing was queued —
-- invisible to the super_admin queue on every request, forever. Measured on production 2026-10-07:
-- ONE such user (created 2026-10-06T13:25Z), which is what fired
-- `CommonPracticeSignupStrandedUnqueued` (`commonpractice_users_without_tenant{queued="false"}` = 1).
-- The code fix in the same PR makes that branch call `recordSignupStrand`, but it is forward-only:
-- it fires only when the person authenticates again. This file queues whoever is already stranded.
--
-- THE STATEMENT IS 0088's, UNCHANGED EXCEPT FOR `note`. Every argument made in
-- 0088_backfill_pre_0027_signup_approvals.sql applies verbatim and is not repeated here: the
-- predicate is census C's own (host/onboarding-integrity.ts), the undeliverable-domain pattern is
-- CHARACTER-FOR-CHARACTER identical to UNDELIVERABLE_EMAIL_DOMAIN_PATTERN, the join is on
-- `lower(email)` with no status filter, it writes `status = 'pending'` only, leaves
-- `matched_tenant_id` / `assigned_tenant_id` / `keycloak_sub` NULL (tenant assignment is a HUMAN
-- decision, PR #350), never touches `users`, and is idempotent (`NOT EXISTS` + `ON CONFLICT DO
-- NOTHING`, `DISTINCT ON` for the case-collision pair). Change the predicate here and you must
-- change it in 0088's test and the exporter too — tests/migration-0092-signup-backfill.test.ts pins
-- that this file still selects the exporter's set.

INSERT INTO signup_approvals (email, name, status, note)
SELECT DISTINCT ON (lower(u.email))
       u.email,
       u.name,
       'pending',
       'Backfilled by migration 0092. At backfill time this account had tenant_id NULL and no '
         || 'signup_approvals row at all, so no super_admin had ever seen it. The local users row '
         || 'was created '
         || to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         || '; this approval row''s own created_at is the moment of the backfill, not that date. '
         || 'Those two timestamps are the whole of what was measured. '
         || 'No tenant has been proposed or assigned; the routing decision is entirely open.'
  FROM users u
 WHERE u.tenant_id IS NULL
   AND u.deleted_at IS NULL
   -- ⚠️ CHARACTER-FOR-CHARACTER IDENTICAL to UNDELIVERABLE_EMAIL_DOMAIN_PATTERN in
   -- src/host/onboarding-integrity.ts and to 0088. Change one and you MUST change the others.
   AND u.email !~* '@([^@]+\.)?(local|invalid)$'
   AND NOT EXISTS (
         SELECT 1 FROM signup_approvals sa WHERE lower(sa.email) = lower(u.email)
       )
 ORDER BY lower(u.email), u.created_at ASC, u.id ASC
ON CONFLICT DO NOTHING;
