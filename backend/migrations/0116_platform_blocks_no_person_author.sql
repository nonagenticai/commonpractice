-- 0116_platform_blocks_no_person_author.sql — platform-shipped building blocks stop crediting
-- invented people as their maintainer / publisher.
--
-- WHY: seed.ts stamped each of the 12 GLOBAL catalog blocks with one of four seeded "maintainers"
-- (Mo Hassan, Tom Kemper, Peter Janssen, Hannah Vos) as `maintainer_id` and as the version's
-- `published_by`. Every tenant — including a brand-new external org on its first login — saw those
-- names on the shared block cards and in the version history, as if a colleague had written them.
-- Tom Kemper is a REAL person (see the 2026-08-09 fabricated-history purge). Platform blocks are
-- authored by the platform: with `maintainer_id` NULL the UI already renders "CommonPractice"
-- (`blocks_maintainer_platform` / `blockedit_meta_platform`). seed.ts no longer writes these ids.
--
-- SCOPE — exactly the seed-owned attribution, nothing else:
--   * only GLOBAL blocks (`tenant_id IS NULL`) and their versions — a tenant's own blocks keep
--     their real author;
--   * only when the referenced user is one of the four seed identities, keyed by the seed's fixed
--     emails (users.id is random; the `.local` email IS the seed's identity — seed.ts finds them by
--     it) AND has no Keycloak identity, so a real account can never match.
-- The users themselves are untouched: other demo-tenant seeders still reference tom@….
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica; a second run matches nothing).
-- Measured on prod 2026-10-16 before writing: 12 global blocks + 12 global versions carried these
-- four ids; zero tenant blocks did.

UPDATE building_blocks
   SET maintainer_id = NULL
 WHERE tenant_id IS NULL
   AND maintainer_id IN (
         SELECT id FROM users
          WHERE email IN ('mo@commonpractice.local', 'tom@commonpractice.local',
                          'peter@commonpractice.local', 'hannah@commonpractice.local')
            AND keycloak_sub IS NULL);

UPDATE block_versions v
   SET published_by = NULL
  FROM building_blocks b
 WHERE b.id = v.block_id
   AND b.tenant_id IS NULL
   AND v.published_by IN (
         SELECT id FROM users
          WHERE email IN ('mo@commonpractice.local', 'tom@commonpractice.local',
                          'peter@commonpractice.local', 'hannah@commonpractice.local')
            AND keycloak_sub IS NULL);
