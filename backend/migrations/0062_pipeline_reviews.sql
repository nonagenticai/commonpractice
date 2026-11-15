-- 0062_pipeline_reviews.sql — make "2 reviewers approved this" a fact the database holds,
-- instead of a number the browser typed.
--
--
-- THE DEFECT — IT IS A CLIENT-SUPPLIED AUTHORIZATION INPUT, NOT A COUNTING BUG
-- ---------------------------------------------------------------------------
-- The promotion gate in routes/pipeline.ts refuses to move a card into Production until
-- `promotion.required_reviewers` reviewers have approved it. The number it compares against came
-- off the wire:
--
--     frontend/src/routes/pipeline/+page.svelte:64
--         pipelineApi.move(card.id, { reviewed: true, reviewerCount: 2 })   <- a LITERAL
--     backend/src/routes/pipeline.ts:148
--         const reviewerCount = body.reviewerCount ?? item.reviewer_count;
--     backend/src/routes/pipeline.ts:175
--         if (snapshot.mandatoryReview && reviewerCount < snapshot.requiredReviewers) …
--
-- So the quantity gating a production deploy was chosen by the caller. ONE click by ONE admin
-- satisfied "2 reviewers required", because the client asserted the 2. `reviewerCount` was
-- accepted from an unvalidated `.strict()` field with `min(0)` and no upper bound, so any value
-- at all cleared any policy — the gate could be passed by typing a bigger number.
--
-- Prod carries the evidence (measurement reported with the change request, 2026-08-07; not
-- independently re-run from this worktree, which has no prod DB access): pipeline card
-- `b5a0327c` reads `reviewed = t, reviewer_count = 2, reviewed_by = fr-test` — two reviewers
-- recorded, one human, one click, and only one identity was ever captured because the schema has
-- exactly one `reviewed_by` column and no way to hold a second name.
--
-- The mirror-image failure is just as bad and is what makes this a correctness bug in BOTH
-- directions rather than only a bypass. `promotion.required_reviewers` is a `select` policy
-- offering ['1','2','3'], but nothing in the product can ever write a 3: the only writer of
-- `reviewer_count` was that one hard-coded literal. Choosing 3 on the Governance screen therefore
-- DEADLOCKS promotion permanently — no card can ever reach Production again — and the entire test
-- suite stays green, because every test also went through the same literal.
--
--
-- THE FIX — a per-reviewer row, and a UNIQUE constraint doing the actual work
-- --------------------------------------------------------------------------
-- This table is deliberately NOT a new invention. It is the same shape the product already uses
-- for the identical problem (one action per user per target, with a denormalised parent counter):
-- `votes` (0006_marketplace.sql:75-81) + host/vote-service.ts `castVote`. Same UNIQUE natural key,
-- same `onConflictDoNothing` inside a transaction, same self-action guard raised before the
-- transaction opens.
--
-- THE UNIQUE CONSTRAINT IS THE WHOLE GUARANTEE. "Two DISTINCT people approved this" is enforced by
-- `pipeline_reviews_item_reviewer_uq`, in the database, not by application logic — so one admin
-- clicking Approve twice cannot increment the count even under concurrency, and no future route,
-- script, backfill or console session can produce a card with two reviews by one person. Remove
-- the constraint and the feature silently degrades back into "count of clicks", i.e. exactly the
-- defect above, with every test still passing. The shape guard at the bottom of this file exists
-- to make that specific silent degradation impossible.
--
--
-- WHAT THE GATE READS, AND WHY THE CACHE COLUMNS SURVIVE
-- -----------------------------------------------------
-- `pipeline_items.reviewed` / `.reviewer_count` / `.reviewed_by` / `.reviewed_at` are NOT dropped
-- and are NOT authoritative. They remain as DISPLAY CACHES, maintained in the same transaction as
-- the review row (host/pipeline-service.ts `recacheReviewFields`), and the promotion gate never
-- reads them: it runs `SELECT count(*) FROM pipeline_reviews WHERE pipeline_item_id = $1` inside
-- the same transaction as the stage write.
--
-- That split is the point, and it is a security property, not a style preference. If the gate read
-- the cache, then ANY drift in the cache — a backend image rollback to a build that still wrote
-- the literal, a hand-edit, an interrupted transaction in some future code path — would become an
-- AUTHORIZATION BYPASS. With the gate reading the rows, the worst a corrupted cache can do is
-- render the wrong number on a card. A display bug can never become a deploy that nobody approved.
-- (tests/pipeline.test.ts T6 hand-corrupts the cache to `reviewed = true, reviewer_count = 5` on a
-- card with zero review rows and asserts the promote is still refused with `(have 0)`.)
--
-- The transaction is load-bearing for a second reason: two concurrent promote requests that each
-- counted OUTSIDE a transaction would both read count = 1 and both pass.
--
--
-- NO BACKFILL. NO SYNTHESISED ROWS. THE TABLE STARTS EMPTY.
-- --------------------------------------------------------
-- Every `reviewer_count` in prod today is that fabricated literal, so there is no true prior state
-- to reconstruct. The 18 fabricated pipeline cards are being deleted by a sibling change before
-- this ships, so there is nothing left to reconcile either.
--
-- Even if there were, synthesising rows would be the wrong answer on principle: inserting a
-- `pipeline_reviews` row for `reviewed_by` would put a REAL, NAMED PERSON on record as the
-- approver of a production deploy they never approved, and would put a SECOND, INVENTED approver
-- on record to make the count reach 2. Manufacturing an approval trail to make a governance gate
-- look satisfied is worse than the bug. Every card correctly reads 0 reviews on day one and has to
-- be genuinely re-approved.
--
--
-- WHY THIS TABLE IS OUTSIDE RLS — DELIBERATE, SO THE NEXT AUDIT DOES NOT READ IT AS AN OMISSION
-- --------------------------------------------------------------------------------------------
-- ⛔ `pipeline_reviews` has NO tenant_id and NO RLS policy, ON PURPOSE. It mirrors its parent
-- `pipeline_items`, which 0028_rls.sql:24 names on the explicit platform-exemption list: "the
-- PLATFORM Operate pipeline (pipeline_items — requireRole 'platform', a super_admin cross-tenant
-- surface reached via the narrow platform path, Part 3.6) stay OUTSIDE RLS".
--
-- The reasoning carries over unchanged. The Production pipeline is a platform-global board, not a
-- tenant artefact; every route that touches it calls `requireSuperAdmin`; a reviewer is a platform
-- super-admin acting on the platform's own deploy queue, and there is no tenant whose scope the
-- row could sensibly be filed under. Giving it a tenant column would mean inventing an owner for a
-- global object, and an RLS policy keyed on a GUC that this surface deliberately does not set
-- would be fail-closed — it would hide every review row from the only code that reads them.
--
-- A tenant-scoped table that is missing from the RLS regime is a finding. This one is not missing;
-- it is exempt for the same stated reason as its parent. rls-coverage.test.ts enumerates the
-- exemption list — if this table is ever given a tenant column, it must move into the regime.
--
--
-- THE ALTERNATIVES THAT WERE CONSIDERED, AND WHY EACH LOSES
-- --------------------------------------------------------
-- (a) VALIDATE `reviewerCount` INSTEAD — bound it, or require it to equal the policy.
--     It does not fix anything. The number is still asserted by the caller; bounding a
--     self-reported claim leaves it self-reported. Any client can send the bounded value, and the
--     product still cannot distinguish one admin from two. It also still cannot ever produce a 3,
--     so the `required_reviewers = 3` deadlock survives untouched.
--
-- (b) A COUNTER COLUMN ONLY — keep `reviewer_count`, have the route do `reviewer_count + 1`.
--     This is the "count of clicks" design. With no per-user row there is nothing to be unique
--     ON, so one admin clicking Approve twice increments to 2 and promotes alone — the same
--     one-human-two-reviewers outcome, reached by a different route. Distinctness of reviewers is
--     not expressible without a per-reviewer row. It also still records only one name.
--
-- (c) A `reviewer_ids uuid[]` COLUMN on pipeline_items.
--     No UNIQUE constraint is possible over array ELEMENTS, so distinctness returns to being
--     application logic that a concurrent request can interleave through (both requests read the
--     array, both append, last write wins, one reviewer recorded twice or one lost). No FK to
--     `users`, so a reviewer id can dangle. No per-review timestamp, so "when was this approved"
--     is unanswerable. It is strictly weaker than a table in every respect and saves one join.
--
-- (d) DERIVE THE COUNT FROM `audit_log` (`pipeline.review` rows).
--     `audit_log` is an append-only narrative feed, not a state table: a withdrawn review leaves
--     its approval row in place forever, so the count could never go down. It carries a seeded
--     "fidelity baseline" of fabricated historical rows (0028 coverage note) that would be counted
--     as real approvals. And it has no uniqueness of any kind — the same admin clicking twice
--     writes two rows. Deriving an authorization decision from a log is the wrong direction.
--
--
-- WHAT THIS FILE DELIBERATELY DOES **NOT** CHANGE
-- ----------------------------------------------
--   * The four cache columns on `pipeline_items` stay. Dropping `reviewer_count` would break every
--     replica still running old code the moment this applies (migrations run at backend STARTUP
--     with replicas rolling — 0058/0059's standing constraint), and the columns have a real
--     ongoing job as the card's display fields.
--   * `promotion.required_reviewers` and `promotion.mandatory_review` stay two separate policies,
--     with `required_reviewers` still only consulted when `mandatory_review` is on. Decoupling
--     them is a real argued follow-up; it is not this change.
--   * No stage-order enforcement. A card can still be dragged from `review` straight to
--     `production`; this file governs WHO approved it, not the path it took. Separate follow-up.
--   * `pipeline_items.solution_id` gets no unique index here. Separate follow-up.
--   * No new endpoint. Approve/withdraw stay on the existing `PATCH /api/pipeline/:id` — a new
--     `POST /api/pipeline/:id/reviews` would 404 for a new frontend talking to a not-yet-rolled
--     old backend, breaking the very button this fixes for the duration of every deploy.
--
--
-- WHY `SET LOCAL lock_timeout`, ON A FILE THAT ONLY CREATES A NEW TABLE
-- --------------------------------------------------------------------
-- `CREATE TABLE` itself contends with nothing (the relation does not exist yet), but the FOREIGN
-- KEYS do: adding an FK takes a SHARE ROW EXCLUSIVE lock on the REFERENCED tables, `pipeline_items`
-- and `users`, and acquiring it queues behind any open reader of those tables. `users` is read by
-- essentially every authenticated request. The runner (db/migration-runner.ts:48-73) applies EVERY
-- pending file inside ONE outer transaction with per-file savepoints, so a lock waited on here is a
-- lock held until the LAST pending file commits — an unbounded wait would queue writes against
-- `users` behind this file for the whole rollout. Failing fast instead rolls back this file's
-- savepoint, leaves the schema at 0061, and the pod retries on its next boot. A retried migration
-- beats a wedged fleet.

SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is scoped to the TRANSACTION, and the runner
-- applies every pending file inside ONE outer transaction with a savepoint per file — `RELEASE
-- SAVEPOINT` does not undo a SET LOCAL. Without the reset this 5s ceiling would silently apply to
-- 0063 and everything after it in the same boot, so a later migration that legitimately needs to
-- wait on a lock would fail for a reason nobody wrote down. This is not hypothetical bookkeeping:
-- 0061 leaked exactly this GUC into whatever followed it until its own RESET was added, which is
-- why its header explains the rule.

-- ---------------------------------------------------------------------------
-- 1. The table. One row = one named human approved one card, once.
--
--    `reviewer_id` has NO `ON DELETE` clause — the default NO ACTION — and that is deliberate,
--    not an oversight. 0050_users_soft_delete.sql made offboarding a TOMBSTONE precisely because
--    14 FKs reference `users.id` with NO ACTION and hard-deleting a member would have erased the
--    authorship of everything they made. A review IS authorship: "Jane approved this deploy" must
--    survive Jane leaving the company, exactly as "Jane authored this solution" does. ON DELETE
--    CASCADE here would silently retro-un-approve every card an offboarded reviewer had approved,
--    which could drop a live card below its required-reviewer count with no event anywhere; ON
--    DELETE SET NULL is not available (the column is NOT NULL, and it must be — a review by nobody
--    is not a review, and a NULL would break the UNIQUE constraint's distinctness guarantee).
--
--    `pipeline_item_id` DOES cascade: deleting a card is deleting the thing being reviewed, so its
--    reviews are meaningless afterwards and would otherwise block the delete outright. This is the
--    path the sibling change removing the 18 fabricated cards relies on.
--
--    `source` records HOW the review was recorded ('app' = a click in the pipeline UI). It exists
--    so a future non-UI path (an MCP tool, a CI-signed approval, an import) is distinguishable
--    from a human click WITHOUT a schema change — the audit question "was this approved by a
--    person or by a machine" should never require a migration to answer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_reviews (
  id               UUID PRIMARY KEY DEFAULT uuidv7(),
  pipeline_item_id UUID NOT NULL REFERENCES pipeline_items(id) ON DELETE CASCADE,
  reviewer_id      UUID NOT NULL REFERENCES users(id),
  source           TEXT NOT NULL DEFAULT 'app',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_reviews_item_reviewer_uq UNIQUE (pipeline_item_id, reviewer_id)
);

-- The gate's hot query is `count(*) … WHERE pipeline_item_id = $1`, which the UNIQUE constraint's
-- backing index already serves (pipeline_item_id is its leading column). No extra index.

COMMENT ON TABLE pipeline_reviews IS
  'One row = one distinct human approved one pipeline card, once. THE AUTHORITY for the '
  'Production promotion gate: routes/pipeline.ts counts THESE ROWS inside the same transaction as '
  'the stage write and compares against promotion.required_reviewers. It never reads '
  'pipeline_items.reviewer_count, which is a display cache only — so cache drift is a rendering '
  'bug and can never become an authorization bypass (migration 0062). Distinctness of reviewers is '
  'guaranteed by pipeline_reviews_item_reviewer_uq, a DATABASE constraint, so one admin clicking '
  'Approve twice cannot increment the count even under concurrency. Shaped after `votes` + '
  'host/vote-service.ts castVote, which solves the identical one-action-per-user-per-target '
  'problem. DELIBERATELY OUTSIDE RLS, mirroring its parent pipeline_items (0028_rls.sql:24): a '
  'platform-global super_admin surface with no tenant column and no tenant it could belong to.';

COMMENT ON COLUMN pipeline_reviews.reviewer_id IS
  'The human who approved. NO ON DELETE clause (NO ACTION) on purpose: 0050 made offboarding a '
  'tombstone so authorship survives a departure, and an approval is authorship. CASCADE would '
  'silently retro-un-approve every card an offboarded reviewer had approved — potentially dropping '
  'a live card below its required-reviewer count with no event anywhere.';

COMMENT ON COLUMN pipeline_reviews.source IS
  'How the review was recorded: ''app'' = a click in the pipeline UI. Exists so a future non-UI '
  'approval path (MCP tool, CI-signed approval, import) is distinguishable from a human click '
  'without a schema change.';

-- ---------------------------------------------------------------------------
-- 2. Recompute the display caches from the authoritative table.
--
--    This is a RECOMPUTE, not a backfill — it derives the caches FROM `pipeline_reviews`, in the
--    same direction the application does. Against an empty table it resolves every card to the
--    honest `reviewed = false, reviewer_count = 0, reviewed_by = NULL`. It does not invent a review
--    row anywhere; see the NO BACKFILL section above.
--
--    ⛔ WHAT THIS DOES **NOT** DO — CORRECTED 2026-08-09 AFTER MEASUREMENT, THE EARLIER CLAIM HERE
--    WAS WRONG. This paragraph used to say the recompute leaves seeded CI/dev cards coherent "from
--    the first boot". IT DOES NOT, and the ordering makes that impossible: CI (and local dev) runs
--    `bun run migrate && bun run seed`, so at migrate time `pipeline_items` is EMPTY and this
--    statement touches ZERO rows. `seed` then runs and re-fabricates the caches. Measured on a
--    freshly created database immediately after both steps:
--
--        pipeline_items                     -> 18 rows
--        …with reviewed = true              -> 11 rows (reviewer_count 2 and 3)
--        pipeline_reviews                   ->  0 rows
--
--    So a seeded database DOES carry incoherent caches, and this statement is a no-op there. It
--    earns its place only for a database that already held cards when 0062 was applied — i.e. prod
--    and any long-lived dev DB — which is exactly where the fabricated literals actually live.
--
--    THE SECOND HALF OF THE OLD CLAIM STANDS, and it is the one that matters: those incoherent
--    seeded caches CANNOT pass the promotion gate, because the gate never reads them. A seeded card
--    showing `reviewed = t, reviewer_count = 3` has zero review rows and is refused with `(have 0)`
--    — see tests/pipeline.test.ts T6, which constructs precisely that state by hand.
--
--    The fabricated `reviewed`/`reviewerCount` literals are being removed from the CARDS data in
--    db/seed-platform.ts by a parallel workstream that owns that file exclusively; this change
--    deliberately does not touch it. Until that lands, a seeded board renders approvals that were
--    never granted — a display defect, not a governance one.
-- ---------------------------------------------------------------------------
UPDATE pipeline_items p
SET reviewed      = (agg.n > 0),
    reviewer_count = agg.n,
    reviewed_by   = agg.last_reviewer,
    reviewed_at   = agg.last_at,
    updated_at    = now()
FROM (
  SELECT p2.id AS item_id,
         count(r.id) AS n,
         (SELECT r2.reviewer_id FROM pipeline_reviews r2
           WHERE r2.pipeline_item_id = p2.id ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1) AS last_reviewer,
         (SELECT r2.created_at   FROM pipeline_reviews r2
           WHERE r2.pipeline_item_id = p2.id ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1) AS last_at
    FROM pipeline_items p2
    LEFT JOIN pipeline_reviews r ON r.pipeline_item_id = p2.id
   GROUP BY p2.id
) agg
WHERE p.id = agg.item_id
  AND (p.reviewed      IS DISTINCT FROM (agg.n > 0)
    OR p.reviewer_count IS DISTINCT FROM agg.n
    OR p.reviewed_by   IS DISTINCT FROM agg.last_reviewer
    OR p.reviewed_at   IS DISTINCT FROM agg.last_at);

DO $$
DECLARE fabricated int;
BEGIN
  SELECT count(*) INTO fabricated FROM pipeline_items WHERE reviewer_count <> 0 OR reviewed;
  RAISE NOTICE '[0062] pipeline_items with a non-zero review cache after recompute: % (expected 0 — pipeline_reviews starts empty)', fabricated;
END $$;

-- ---------------------------------------------------------------------------
-- 3. GRANT to cp_app — role-existence-guarded, the 0043 §GRANT shape (itself following 0037 §5).
--
-- ⛔ THIS IS THE HIGHEST-SEVERITY LATENT TRAP IN THE WHOLE CHANGE, AND IT IS INVISIBLE TO CI.
--    0028 issued `GRANT … ON ALL TABLES IN SCHEMA public TO cp_app`. `ON ALL TABLES` is NOT a
--    standing rule — it expands to the tables that existed AT THAT MOMENT and confers nothing on
--    any table created afterwards. `pipeline_reviews` is created here, four years of migrations
--    later, so it is not covered.
--
--    CI runs the whole suite as the `postgres` SUPERUSER, which bypasses privilege checks
--    entirely. A missing GRANT is therefore GREEN ACROSS EVERY TEST — including every test in this
--    change — and then throws `permission denied for table pipeline_reviews` in PRODUCTION on the
--    very first Approve click, because prod's runtime connects as the non-owner, NOBYPASSRLS
--    `cp_app` role. The failure would land on the exact button this migration exists to fix, and
--    nothing in the test suite could have predicted it.
--
--    The role-existence guard is required because `cp_app` genuinely does not exist in every
--    environment: 0028 creates it only gracefully (the owner may lack CREATEROLE), and a bare
--    GRANT against a missing role is a hard ERROR that would roll this file's savepoint back and
--    wedge boot on exactly the environments least able to debug it. Owner default privileges cover
--    the case where the role is absent.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_reviews TO cp_app;
    RAISE NOTICE '[0062] granted cp_app DML on pipeline_reviews';
  ELSE
    RAISE NOTICE '[0062] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Shape guard — this file's own non-vacuity proof.
--
--    `CREATE TABLE IF NOT EXISTS` is a SILENT NO-OP against a pre-existing table of ANY shape. An
--    environment that already carries a hand-made `pipeline_reviews` — without the UNIQUE
--    constraint, or with it over the wrong columns, or with a nullable column — would have this
--    migration report success and then run the feature in its BROKEN form:
--
--      * no UNIQUE constraint  → `onConflictDoNothing` has no arbiter to match, one admin clicking
--        twice inserts two rows, and the gate counts CLICKS. That is precisely the defect this
--        whole change exists to remove, restored silently, with every test still passing (the
--        tests approve once per identity, so they never exercise the duplicate path against a
--        constraint-less table).
--      * a nullable reviewer_id → two rows with NULL reviewer_id do not violate a UNIQUE
--        constraint in Postgres (NULLs are distinct by default), so anonymous "reviews" would
--        stack and the distinctness guarantee evaporates for exactly the rows that name nobody.
--      * a nullable pipeline_item_id → same NULL-distinctness hole, plus reviews attached to no
--        card at all.
--
--    So assert the shape rather than assume it. Exactly one UNIQUE (or PK) constraint covering
--    exactly (pipeline_item_id, reviewer_id), in either column order, and both columns NOT NULL.
--    Anything else is a hard stop with an explanation, not a silent success.
--    (tests/pipeline-reviews-schema.test.ts re-asserts the same facts from pg_constraint against
--    the live database, so the guarantee is checked both at apply time and at test time.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  uq_cols   text[];
  n_matching int;
  n_nullable int;
BEGIN
  -- Every UNIQUE/PRIMARY KEY constraint on the table, as its column-name array.
  SELECT count(*) INTO n_matching
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE ns.nspname = 'public'
     AND t.relname  = 'pipeline_reviews'
     AND c.contype IN ('u', 'p')
     -- `attname` is `name`, not `text`, and there is no `name[] = text[]` operator — cast the
     -- element, and sort by it, so the comparison is order-insensitive (the constraint is
     -- equally correct declared in either column order).
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
            FROM unnest(c.conkey) AS k(attnum)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
         = ARRAY['pipeline_item_id', 'reviewer_id']::text[];

  IF n_matching <> 1 THEN
    SELECT array_agg(c.conname ORDER BY c.conname) INTO uq_cols
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE ns.nspname = 'public' AND t.relname = 'pipeline_reviews' AND c.contype IN ('u', 'p');
    RAISE EXCEPTION
      'pipeline_reviews: expected EXACTLY ONE UNIQUE/PK constraint over (pipeline_item_id, '
      'reviewer_id), found %. Constraints present: %. The CREATE TABLE above should have '
      'guaranteed this — CREATE TABLE IF NOT EXISTS is a SILENT NO-OP against a pre-existing '
      'table of another shape, so this environment is carrying a hand-made pipeline_reviews. '
      'Without that constraint the promotion gate degrades to counting CLICKS instead of distinct '
      'reviewers — the exact defect 0062 exists to fix — and every test still passes. Fix the '
      'table by hand, then re-run.',
      n_matching, coalesce(uq_cols::text, '(none)');
  END IF;

  -- Both key columns must be NOT NULL. A nullable column would let duplicate NULL-keyed rows
  -- coexist (Postgres treats NULLs as distinct in a UNIQUE constraint), voiding the guarantee.
  SELECT count(*) INTO n_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'pipeline_reviews'
     AND column_name IN ('pipeline_item_id', 'reviewer_id')
     AND is_nullable  = 'YES';

  IF n_nullable <> 0 THEN
    RAISE EXCEPTION
      'pipeline_reviews: % of (pipeline_item_id, reviewer_id) are NULLABLE; both must be NOT NULL. '
      'Postgres treats NULLs as DISTINCT inside a UNIQUE constraint, so nullable key columns let '
      'duplicate rows coexist and the distinct-reviewer guarantee silently evaporates for exactly '
      'the rows that name nobody. Fix the columns by hand, then re-run.', n_nullable;
  END IF;

  RAISE NOTICE '[0062] shape guard OK — UNIQUE (pipeline_item_id, reviewer_id), both NOT NULL';
END $$;

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
