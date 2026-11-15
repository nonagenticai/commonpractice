-- 0088_backfill_pre_0027_signup_approvals.sql — queue the stranded users 0027 never saw.
--
-- WHY THIS EXISTS
-- `signup_approvals` — the super_admin approval queue — was created by 0027_signup_onboarding.sql,
-- first committed 2026-06-11T12:32Z. EVERY producer of a row in it is a live code path that fires
-- at signup / first-touch time:
--   * routes/onboarding.ts `notifySelf` (self-signup) and the super_admin invite path,
--   * services/user-service.ts `recordSignupStrand`, the no-claim branch of `ensureUser`
--     (pinned by tests/stranded-signup-is-visible.test.ts).
-- All of them are FORWARD-ONLY by construction. Nothing has ever walked the `users` rows that
-- already existed when 0027 landed, so a person whose row predates it — and who has not
-- authenticated since the no-claim branch shipped — holds `tenant_id IS NULL` and has no queue row
-- at all. They are not "waiting for a decision": they are invisible to the one screen
-- (`GET /api/signup-approvals`) whose entire job is to surface exactly this case.
--
-- Measured on production 2026-09-05: THREE such users. TWO carry an address in the reserved
-- `.local` TLD and are excluded below; the third is a real external address created
-- 2026-06-11T07:41:05Z — five hours before 0027 was committed, and stranded 86 days. That set of
-- three is what `commonpractice_users_without_tenant{queued="false"}` counted when
-- `CommonPracticeSignupStrandedUnqueued` began firing at 2026-09-04T14:56Z. ⚠️ The gauge now
-- excludes undeliverable domains too (see below), so it reads ONE — the one row a human can
-- actually answer, and the one row this migration queues.
--
-- ⛔ UNDELIVERABLE ADDRESSES ARE EXCLUDED — `.local` AND `.invalid`, BY DOMAIN, NOT BY NAME.
-- RFC 6762 §3 reserves `.local` for link-local multicast DNS; RFC 2606 §2 reserves `.invalid` for
-- names guaranteed never to resolve. Neither is a globally resolvable domain, neither has an MX and
-- neither can ever be given one, so an address inside them CANNOT RECEIVE MAIL. Every step past the
-- queue needs that mail to work: an approval provisions a realm identity the person must confirm,
-- and consumes a seat (`users.tenant_id`, counted by services/seat-limit.ts) against
-- `tenants.max_members`. Such an account therefore cannot complete onboarding no matter what a
-- super_admin decides — approve and reject are equally meaningless — so queueing it manufactures a
-- row NO HUMAN CAN EVER ANSWER, in the one screen whose value is that everything on it is
-- answerable. The predicate is on the DOMAIN and nothing else. It names no address, because a
-- name-based exclusion covers only the addresses that exist today and admits the next one silently.
--
-- ⛔ `.test` AND `.example` ARE RESERVED TOO AND ARE DELIBERATELY *NOT* EXCLUDED. This repo uses
-- `.test` as its stand-in for a DELIVERABLE address (`@m0088.test` in this migration's own test
-- file, `@onboarding-integrity.test`, `@stranded.test`) — those fixtures are what prove a real
-- person still gets queued. Excluding `.test` would make every one of those assertions vacuously
-- true, which is the same class of unanswerable-signal bug one level up. Only the two labels that
-- are genuinely unroutable AND are never used here as a proxy for a real address are excluded.
--
-- ⛔ THE ALTERNATIVE NOT TAKEN. The rows this skips are demo seed fixtures (src/db/seed-*.ts) that
-- arguably SHOULD NOT EXIST IN THE PRODUCTION DATABASE AT ALL. Removing them — or gating the demo
-- seeds out of prod — would empty this predicate's population rather than filter it, and is very
-- likely the better fix. It is also a much larger question (what the demo tenants are for, who
-- depends on them, what a prod seed run may write) and this migration does not settle it.
--
-- ⚠️ THIS PREDICATE AND THE EXPORTER'S ARE NOW THE SAME SET, AND MUST STAY THAT WAY.
-- host/onboarding-integrity.ts carries the character-for-character identical exclusion as
-- `UNDELIVERABLE_EMAIL_DOMAIN_PATTERN`, so census C measures only what a human can act on and
-- `commonpractice_users_without_tenant{queued="false"}` REACHES 0 once this runs. Changing either
-- side alone re-opens the bug both exist to close: a wider census leaves the alert firing after a
-- complete backfill, a narrower one writes queue rows nobody is counting.
-- `tests/migration-0088-signup-backfill.test.ts` pins the equality in both directions.
--
-- ⛔ WHAT THIS MIGRATION MUST NOT DO — AND DOES NOT DO.
-- Tenant assignment is a HUMAN decision, by design (PR #350). This migration:
--   * does not write the `users` table at all. No tenant, no tombstone, no seat — a seat IS a
--     `users.tenant_id` (that is what services/seat-limit.ts counts), so `tenants.max_members`
--     cannot be crossed by anything here.
--   * writes `status = 'pending'` only. It never approves and never rejects.
--   * leaves BOTH `matched_tenant_id` and `assigned_tenant_id` NULL. `recordSignupStrand` fills
--     `matched_tenant_id` from `matchTenantByEmail` (free-mail blocklist + `email_domain_tenants`),
--     and that is deliberately NOT reimplemented here: `approve` resolves
--     `body.tenantId ?? assigned_tenant_id ?? matched_tenant_id` (routes/onboarding.ts:332), so a
--     matched value is a default an approver can accept by omission. A backfilled row is evidence
--     that nobody has EVER looked at this person; it must not arrive carrying a pre-filled answer.
--     NULL forces the super_admin to name the tenant explicitly. `notifySelf`'s own rows are
--     legitimately NULL there too ("NULL for free-mail/unknown", 0027), so this is an ordinary row
--     shape, not a special case the approve flow has to learn about.
--   * leaves `keycloak_sub` NULL, the same as every `notifySelf` row — 0027 documents that spelling
--     ("NULL for a self-signup that only notified"). `approve` treats it as nullable:
--     `assertApprovalAdmitsUser` falls back to matching on `lower(email)` when it is null, and
--     `provisionRealmUser(mode: 'reuse')` resolves the realm identity by email. Copying `users.id`
--     into it would be a GUESS that the local id is the realm sub — true for JIT rows, not
--     guaranteed for a pre-0027 one — and a WRONG sub is a failed approve, where a NULL one is the
--     documented path.
--
-- ⛔ SET-BASED, NOT THREE EMAIL LITERALS. Hardcoding today's three addresses would clear today's
-- alert, leave the identical hole open for the next pre-0027 row anyone finds, and not be
-- re-runnable. The predicate below is the exporter's own predicate — census C in
-- host/onboarding-integrity.ts: `users` with `tenant_id IS NULL AND deleted_at IS NULL`, minus
-- those with any `signup_approvals` row on `lower(email)`, minus the undeliverable domains argued
-- above — which the exporter now excludes too. Same rows in, so the gauge reaches 0 on the next
-- scrape rather than stopping one row short of clearing the alert.
--
-- ⚠️ THE JOIN IS ON `lower(email)` AND CARRIES NO STATUS FILTER — deliberate on both counts.
-- `lower(email)` is the key `signup_approvals`' own partial unique index uses
-- (`signup_approvals_pending_email`, 0027) and the key the exporter joins on; `keycloak_sub` is
-- nullable on that table and cannot serve. NO status filter because THE EXPORTER HAS NONE: a person
-- whose request was already rejected counts as `queued` there. Filtering to `status = 'pending'`
-- here would insert a row the metric never asked for and would silently resurrect a decision a
-- human had already made.
--
-- IDEMPOTENT ACROSS RE-RUNS: `NOT EXISTS`. A second apply selects nothing, because the first
-- apply's own rows now satisfy the very join it tests. This matters because the file is read at
-- every backend boot until `_migrations` records it, and because a partly-failed run replays.
--
-- SAFE AGAINST A CASE COLLISION — and here is what each guard ACTUALLY does, measured on
-- postgres 18 rather than assumed. `users.email` carries NO unique constraint (only
-- `keycloak_sub` does), so two stranded rows can legally differ only in case, and
-- `signup_approvals_pending_email` (0027) is unique on `lower(email) WHERE status = 'pending'`.
-- One statement offering both halves of such a pair to that index is the hazard.
--   * `ON CONFLICT DO NOTHING` alone already prevents the raise, INCLUDING for two rows inside the
--     SAME statement: DO NOTHING uses speculative insertion and skips the second (this is the
--     documented difference from DO UPDATE, which errors with "cannot affect row a second time").
--     Verified against a real unique index on `lower(email)` before this file was written — do not
--     take it on trust from the paragraph above, it is a subtle behaviour and it is the reason
--     this migration cannot wedge a boot.
--   * `DISTINCT ON (lower(u.email))` is therefore NOT what stops the error, and the comment here
--     must not claim it is. It does two other things: it makes WHICH half of the pair is queued a
--     decision this file makes (`ORDER BY lower(email), created_at ASC, id` — the older row wins)
--     instead of a plan detail, and it keeps the statement correct if the `ON CONFLICT` clause is
--     ever narrowed to a targeted one. Either guard alone prevents the error; both are kept, and
--     `tests/migration-0088-signup-backfill.test.ts` pins exactly that — it asserts the raise only
--     when BOTH are removed, so neither is credited with work it does not do.
-- Why any of this is worth the words: the runner applies every pending file inside ONE
-- transaction, so a raise here aborts the boot and crash-loops the pod — the 0077 scar recorded in
-- src/db/migration-runner.ts.
--
-- `ON CONFLICT DO NOTHING` also covers the live-pod race: `recordSignupStrand` can insert the same
-- `lower(email)` between this statement's read and its write. Untargeted, exactly as
-- `recordSignupStrand` and `notifySelf` both spell it.
--
-- WHY `note` IS WRITTEN even though no route reads it today. The new row's `created_at` is `now()`
-- — the moment of the backfill — so read alone it dates the ROW, not the account. `note` is the
-- only place the `users` row's own creation timestamp survives for whoever reads the queue table
-- directly.
-- ⚠️ IT RECORDS ONLY WHAT THIS STATEMENT MEASURED, and every clause maps to a column this SELECT
-- actually read: that the account had `tenant_id IS NULL` and no `signup_approvals` row at the
-- moment 0088 ran, and the value of `users.created_at`. It deliberately does NOT say the account
-- predates 0027 (true of today's rows, but the predicate is generic and will also catch anyone
-- stranded for a different reason), and it deliberately does NOT say a PERSON HAS BEEN WAITING for
-- that span. Waiting is a claim about a human's intent and attention that no column here can
-- support: the same two timestamps are produced by an abandoned signup, an automated fixture, or a
-- duplicate account, and this statement cannot tell those apart from someone actively expecting an
-- answer. A note that states more than the query tested is a fabrication the next operator reads
-- as fact — and it would be read by the one person whose job is to decide the row.
--
-- No `SET LOCAL` of any kind — this takes a RowShareLock on `users` and a RowExclusiveLock on
-- `signup_approvals` and needs no timeout ceiling. See MIGRATION_RESET_GUCS in
-- src/db/migration-runner.ts for why an unpaired GUC here would leak into every later file.

INSERT INTO signup_approvals (email, name, status, note)
SELECT DISTINCT ON (lower(u.email))
       u.email,
       u.name,
       'pending',
       'Backfilled by migration 0088. At backfill time this account had tenant_id NULL and no '
         || 'signup_approvals row at all, so no super_admin had ever seen it. The local users row '
         || 'was created '
         || to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         || '; this approval row''s own created_at is the moment of the backfill, not that date. '
         || 'Those two timestamps are the whole of what was measured. '
         || 'No tenant has been proposed or assigned; the routing decision is entirely open.'
  FROM users u
 WHERE u.tenant_id IS NULL
   AND u.deleted_at IS NULL
   -- ⛔ RFC 6762 reserves `.local` for mDNS and RFC 2606 reserves `.invalid` for names guaranteed
   -- not to resolve: no MX, no deliverable mail, so an account there can never confirm a realm
   -- identity and can never complete onboarding. Queueing one creates a row no super_admin can
   -- answer either way. Matched on the DOMAIN — `@local`, `@<anything>.local`, `@example.invalid` —
   -- anchored to the end of the address so a local-part like `a.local@example.com` is untouched,
   -- and case-insensitively (`!~*`), because `users.email` is not normalised on write.
   -- ⛔ NEVER replace this with a list of addresses: that clears today's rows and admits tomorrow's.
   -- ⚠️ CHARACTER-FOR-CHARACTER IDENTICAL to UNDELIVERABLE_EMAIL_DOMAIN_PATTERN in
   -- src/host/onboarding-integrity.ts. Change one and you MUST change the other.
   AND u.email !~* '@([^@]+\.)?(local|invalid)$'
   AND NOT EXISTS (
         SELECT 1 FROM signup_approvals sa WHERE lower(sa.email) = lower(u.email)
       )
 -- The `DISTINCT ON` key must lead the ORDER BY. The rest makes WHICH duplicate survives
 -- deterministic (oldest row wins, id as the tie-break) rather than whatever the plan emits first.
 ORDER BY lower(u.email), u.created_at ASC, u.id ASC
ON CONFLICT DO NOTHING;
