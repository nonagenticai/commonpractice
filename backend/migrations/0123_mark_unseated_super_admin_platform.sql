-- 0123 — mark the one measured workspace-less super_admin row as platform staff.
--
-- `ensureUser` (services/user-service.ts) never queues a workspace-less super_admin (platform staff,
-- not a signup), and since this PR it marks that row `role = 'platform'`, which census C
-- (host/onboarding-integrity.ts) excludes. The code fix is forward-only: it fires on that person's
-- next request. This row is the one already in production that fired
-- `CommonPracticeSignupStrandedUnqueued` from 2026-10-25T19:51Z: users.id
-- c93ea1fd-50ab-451c-94cd-2bf5f35ba6da, created 2026-10-25T19:51:04Z, tenant_id NULL, no
-- signup_approvals row. Measured 2026-10-31: the same id is the `commonpractice`-realm Keycloak user
-- holding the realm role `super_admin` — i.e. exactly what the new code marks on its own.
--
-- Keyed on the id (the Keycloak sub), guarded on still being workspace-less and `employee`, so it
-- is a no-op everywhere else (CI, fresh databases) and idempotent.
UPDATE users
   SET role = 'platform'
 WHERE id = 'c93ea1fd-50ab-451c-94cd-2bf5f35ba6da'
   AND tenant_id IS NULL
   AND deleted_at IS NULL
   AND role = 'employee';
