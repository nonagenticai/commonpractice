-- 0115_demo_owner_rename.sql — rename the seeded demo user "Mary Smit" to an obviously fictional
-- "Demo Owner".
--
-- WHY: a seed person with a realistic Dutch name reads as a real employee wherever she shows up as
-- an owner (challenge submitter, dataset tagger) in the demo workspace. This repo once displayed
-- invented events attributed to a real named person; seeded people must not look real.
--
-- SCOPE — exactly the seed-owned rows, nothing else:
--   * `users`: the ONE row whose email is the seed's own `mary.smit@commonpractice.local`
--     (`.local` is the seed's reserved domain; users.id is random, so the email IS the seed's
--     fixed identity — seed-ops.ts looks users up by it). Name, email and initials all change, so
--     the next seed run finds the renamed row by its new email instead of creating a second user.
--   * `sandboxes`: the ONE row carrying the seed's fixed `seed_key = 'ops:sandbox:mary'`. Its
--     slug/label change so the seed's slug-keyed upsert matches it again; without this, seed-ops
--     would insert `demo-owner-9d12` for the same owner and trip `sandboxes_primary_owner_uq`.
-- No other table stores the name: every owner/submitter column is a FK to users.id and renders the
-- name through it.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica; a second run matches nothing). The
-- NOT EXISTS guards make it a no-op rather than a unique-violation if the new identity is already
-- present. Numbered 0115: 0114 is taken by an open branch.

UPDATE users
   SET name = 'Demo Owner',
       email = 'demo-owner@commonpractice.local',
       avatar_initials = 'DO',
       updated_at = now()
 WHERE email = 'mary.smit@commonpractice.local'
   AND keycloak_sub IS NULL
   AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'demo-owner@commonpractice.local');

UPDATE sandboxes
   SET slug = 'demo-owner-9d12',
       label = 'Demo Owner''s sandbox',
       seed_key = 'ops:sandbox:demoOwner'
 WHERE seed_key = 'ops:sandbox:mary'
   AND NOT EXISTS (SELECT 1 FROM sandboxes s2 WHERE s2.slug = 'demo-owner-9d12' OR s2.seed_key = 'ops:sandbox:demoOwner');
