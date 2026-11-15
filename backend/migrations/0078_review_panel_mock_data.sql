-- 0078_review_panel_mock_data.sql — a terminal block that threw on every single run.
--
-- WHAT WAS WRONG
-- --------------
-- `review-panel` ships with a `run()` whose entire body is
--
--     const decision = await ctx.mockData("review_decision", { item: inputs.item });
--
-- and a descriptor that declares `capabilities: { network: false }` — no `mockData`.
-- `exec/flow-executor.ts`'s `ctx.mockData` gate is `if (!caps.mockData) throw productError(
-- 'capability_missing_mock_data', …)`, so the FIRST line of the block's body raised, every time,
-- on every database this repo has ever seeded. The block is `category: 'output'`, i.e. a terminal
-- node, so a flow containing it could not finish either.
--
-- ⛔ THIS IS NOT THE `dataset` SPLIT AGAIN, IT IS ITS MIRROR IMAGE, AND THE DISTINCTION IS THE
-- WHOLE JUSTIFICATION FOR THIS FILE. 0077 DELETED `mockData` from four blocks because they only
-- ever called `ctx.dataset()` — they were claiming a fabrication they did not commit. This file
-- ADDS `mockData` to one block because it does nothing BUT fabricate. Both changes move the
-- persisted bit towards the same invariant: `capabilities.mockData` is true exactly when the
-- block's output is invented. Neither is a widening of a trust boundary for its own sake.
--
-- ⚠️ THE REPO HAD BEEN ROUTING AROUND THIS RATHER THAN FIXING IT. `db/seed-marketplace.ts` carried
-- the line "review-panel is deliberately excluded because its descriptor omits the mockData
-- capability its code uses" above `LISA_FLOW_SLUGS` — a correct diagnosis of a DEFECT, recorded as
-- if it were a design constraint — while the `SOLUTIONS` literal 35 lines above it kept listing
-- `review-panel` in a solution's `blocksUsed` and `db/seed-tenant-showcase.ts` did the same. The
-- catalogue advertised a block the seeder itself knew could not run. That comment is deleted in
-- the same commit as this file.
--
-- ⛔ THE RETROACTIVE SIDE EFFECT, STATED THE WAY 0076 AND 0077 STATE THEIRS, BECAUSE IT IS
-- OTHERWISE SILENT AND IT IS USER-VISIBLE.
-- `capabilities.mockData` is not only an executor gate. Two other readers consume this exact bit:
--
--   1. DISPLAY. `routes/blocks.ts` projects `mock_data: v?.descriptor?.capabilities?.mockData ===
--      true` from the `descriptor` COLUMN this file rewrites, and the browser renders the
--      "Simulated" badge from it on the catalogue card, the build palette, the canvas node and the
--      run output. After this migration `review-panel` carries that badge where it did not before.
--   2. POLICY. `host/run-policy.ts` uses the same bit as the ENTIRE taint-by-source test for
--      `data.pii_scrubbing`: a `pii`-marked input fed by an upstream node is allowed only when that
--      PRODUCER declares `capabilities.mockData === true`. After this migration `review-panel`
--      becomes an accepted mock SOURCE, so a flow wiring its `decision`/`edited` output into a
--      `pii` input under pii_scrubbing goes from REFUSED to ALLOWED.
--
-- ⛔ AND FOR THIS BLOCK BOTH ARE CORRECT, WHICH IS WHY THEY ARE NOT COLLATERAL.
-- `exec/mock-data.ts`'s `review_decision` case picks `accept`/`edit`/`reject` off a seeded counter
-- (`['accept','edit','reject'][seed % 3]`) and, for `edit`, returns the input item with
-- `reviewed: true` stapled on. No human is consulted, `inputs.item` is never examined, and nothing
-- is persisted. The block's name is "Review panel" and its description says "Inline accept/edit/
-- reject UI for human-in-the-loop steps" — so the "Simulated" badge is the ONLY thing on any of
-- those four screens that tells the reader the approval they are looking at was invented by a
-- modulus. It should be on. And the flow output genuinely is fabricated, so it is a legitimate
-- source at a taint gate whose whole content is "this value must be invented".
--
-- Direction of the change #2, spelled out so nobody has to infer it: it makes the PII rail MORE
-- permissive for one block. That is the opposite direction from 0077's, and it is only defensible
-- because the premise the rail tests — "the producer fabricates" — is, for this block, verifiably
-- true from its source. It is LATENT today for the same reason 0077's was: no seeded descriptor
-- marks any input `pii: true`.
--
-- ⛔ WHY THIS IS A MIGRATION AND NOT JUST A SEED EDIT, AND WHY IT IS BOTH.
-- The same split 0073, 0076 and 0077 all state, and it is the ONLY thing that reaches production
-- here: `server.ts:108-116` refuses to seed unless `SEED_DEMO_DATA` is true, and production runs it
-- false. Even where the seeder DOES run, `upsertGlobalBlock` skips a slug that already exists — so
-- the corrected literal in `src/db/seed.ts` (both copies of it: the descriptor object AND the
-- descriptor baked into the `source` string) repairs only databases where the row does not exist
-- yet, i.e. a fresh CI database, where `bun run migrate` runs BEFORE `bun run seed` and the UPDATEs
-- below therefore match 0 rows. This file is what repairs the row that already exists. Neither half
-- is redundant, and neither half alone fixes anything for an existing tenant.
--
-- ⚠️ `block_versions`, NOT `building_blocks` — THERE IS NO `building_blocks.descriptor`.
-- `migrations/0002_blocks.sql` puts `descriptor JSONB NOT NULL` and `source_ts TEXT NOT NULL` on
-- `block_versions`; `building_blocks` holds only slug/name/category/`current_version_id`/tenant.
-- The join below is how the slug reaches the versions.
--
-- ⚠️ EVERY VERSION, NOT JUST `current_version_id` — 0076's and 0077's reasoning applies unchanged.
-- The version picker serves any row and `displayVersion` may pick a non-current one, so repairing
-- only the current version leaves a version that still throws one click away. Today `review-panel`
-- has exactly one version (1.0.0); the statement does not depend on that.
--
-- ⛔ SCOPE: ONE GLOBAL SLUG, AND THE PROPERTY MATCH IS DELIBERATELY NOT DONE.
-- 0077 part 2 matched on a PROPERTY ("declares mockData, source only reads a dataset") because a
-- GENERATOR mints rows whose slugs did not exist when the file was written. Nothing generates
-- `review-panel`; it is one hand-written seed literal. The tempting generalisation here would be
-- "every version whose source calls `ctx.mockData(` while its descriptor omits the bit" — and it is
-- REJECTED, for the reason 0077's header gives for rejecting NORMALISE: setting `mockData` is not
-- only unbreaking an executor gate, it MINTS A CLAIM that two other readers act on. Reader (2)
-- above is a governance rail, and this bit is the only thing that opens it — so a property-wide
-- UPDATE would hand a pii_scrubbing pass to every tenant-authored block whose source happens to
-- contain that token, including ones whose authors never declared it and whose sources this file
-- cannot read. A row it skips keeps EXACTLY today's behaviour: the block still throws
-- `capability_missing_mock_data`, loudly, as a `block_throw` the author sees in /block-edit's
-- result panel — a visible defect in the author's own block, not a silent one. That is the correct
-- place for it to be fixed, and the correct fix is the author declaring the capability.
--
-- ⚠️ `tenant_id IS NULL` FOR THE SAME REASON. A tenant row carrying this slug is that tenant's own
-- code under a colliding name, not a copy of ours to repair.
--
-- PURE DML. No DDL, no GUC is set, so nothing here needs a `RESET` (`MIGRATION_RESET_GUCS` +
-- tests/migration-guc-reset.test.ts scan every file in this directory).
--
-- ⛔ NO `WHERE`-GUARD IS AN EXCEPTION HANDLER, AND PART 3 BELOW IS NOT ONE EITHER — 0077's header,
-- extended rather than contradicted. `runMigrations` applies every pending file inside ONE
-- `sql.begin()` and its catch RETHROWS, so a statement that RAISEs rolls back the whole run —
-- including the `_migrations` rows of every file that already succeeded in it. Nothing is recorded,
-- the next boot replays the identical files against the identical rows, and the failure is
-- deterministic: a PERMANENT boot wedge, not a degraded boot. That is why the migration numbered
-- 0069 was WITHDRAWN before it merged (commit 948a341: "a repair migration must skip a row it
-- cannot handle with a WARNING, never abort the boot"), and it is the reason every guard in parts 1
-- and 2 is a `WHERE` filter: a row this file cannot safely rewrite is SKIPPED.
--
-- ⛔ SO WHY PART 3 RAISES AT ALL, AND WHAT IT IS ALLOWED TO RAISE ON. Part 2 is a bare `replace()`
-- with no verification: if the literal it keys on is ever spelled differently the replace matches
-- NOTHING, part 1 still flips the descriptor, and the result is the worst of both — the "Simulated"
-- badge ON over a block that still throws `capability_missing_mock_data`, silently. So part 3
-- checks. It distinguishes two states that look alike and are not:
--
--   1. IMPOSSIBLE → `RAISE EXCEPTION`. A global `review-panel` version whose descriptor now
--      declares `mockData: true` while its source STILL carries the exact pre-repair literal. Part 2
--      covers precisely that row set with precisely that literal, so this cannot be true after part
--      2 has run. It is true only if part 2 was deleted, mis-scoped, or its search string mistyped —
--      i.e. every way this file can silently no-op. It CANNOT be reached by a differently-spelled
--      source (which does not contain the literal), and it cannot be reached by a second apply
--      (which the first destroyed). A wedge here would be a wedge on this file's own bug, on a
--      database it has not yet touched, which is the one place a wedge is the right answer.
--
--   2. DRIFT → `RAISE WARNING`, never an exception. The descriptor says `mockData` and the source
--      literal GRANTS it nowhere — a source spelled some third way (a republished version, an
--      author edit). "Grants" is `mockData\s*:\s*true`, never `%mockData%`: the block's own run
--      body calls `ctx.mockData(...)`, so the bare token is in every review-panel source and a
--      substring test would be a guard that can never fire.
--      That IS the badge-over-a-throwing-block state and it must not be silent, but it is a
--      REACHABLE state produced by data this file did not write, so raising on it is exactly the
--      0069 wedge. It warns and lets the boot continue.
--
--      ⚠️ AND THE WARNING'S CHANNEL, STATED RATHER THAN ASSUMED. `applyMigrations` builds its client
--      with `onnotice: () => {}` (migration-runner.ts), so the pod's own log will NOT carry this
--      line. It reaches the POSTGRES SERVER log, where `log_min_messages` defaults to `warning` —
--      a durable record on worker4, and the only channel available to a statement that must not
--      abort. A caller that wants it in the pod log has to stop swallowing notices, which is a
--      change to the runner and not to this file.
--
-- ⚠️ THE STRUCTURAL ALTERNATIVE, CONSIDERED AND NOT TAKEN HERE: narrow PART 1 so it only flips the
-- descriptor on a version whose source either already grants `mockData` or matches the literal part
-- 2 repairs — which would make state 2 unreachable instead of merely reported. That is a change to
-- which ROWS this migration rewrites, not a verification of what it did, and it would silently
-- redefine the "every version, not just current" property the BADGE case pins. It belongs in a
-- follow-up with its own cases, not smuggled into a check.
--
-- ⚠️ THIS FILE IS EDITED IN PLACE RATHER THAN SUPERSEDED BY 0079, AND THAT IS ONLY LEGITIMATE
-- BECAUSE IT HAS NEVER BEEN APPLIED ANYWHERE. `_migrations` is keyed on FILENAME with no checksum,
-- so an applied file is never read again and editing it reaches only clusters that have not booted
-- yet — precisely not the ones already wrong (tests/migration-guc-reset.test.ts:20-23 states this as
-- a rule). 0078 landed on this branch (3cf27dc), is unmerged, and is pending on every database that
-- matters. The moment it merges and rolls, this paragraph stops applying and the next correction is
-- a new file.
--
-- IDEMPOTENT, ALL THREE PARTS:
--   • part 1 is an ABSOLUTE assignment (`capabilities || '{"mockData": true}'`), so a second apply
--     recomputes the identical value — it re-writes the row but cannot change it;
--   • part 2 keys on the pre-repair literal, which the first apply destroys, so a second apply
--     selects ZERO rows;
--   • part 3 asserts a POST-STATE, not a row count — which is what makes it survive that. A check
--     phrased as "part 2 must have changed N rows" would pass on the first apply and RAISE on the
--     second, turning the verification itself into the boot wedge it exists to avoid.
-- Net: `rows_changed_on_second_apply = 0` for part 2, value-identical for part 1, and part 3 quiet
-- on both.

-- ---------------------------------------------------------------------------
-- 1. The descriptor COLUMN — what /blocks, the palette, the canvas and run-policy read.
--
--    ⚠️ `COALESCE(..., '{}'::jsonb)` and the two `jsonb_typeof` guards are 0077's, verbatim and for
--    its reasons: `jsonb_set` returns SQL NULL if any argument is NULL and `descriptor` is NOT NULL,
--    so an absent `capabilities` key would abort the whole run with a not-null violation; a
--    `capabilities` that is present-but-not-an-object is not covered by the COALESCE at all
--    (`descriptor -> 'capabilities'` is SQL NULL only when the key is MISSING) and reaches `||`,
--    where a jsonb ARRAY is silently wrapped into `["x",{"mockData":true}]` with no error. Hence a
--    POSITIVE `= 'object'` test on both levels rather than a negative list of remembered shapes.
--    These rows are reachable through the product: `ai/mcp/tools.ts` types the descriptor as
--    `z.record(z.string(), z.unknown())` and casts it straight into `blocks/authoring-service.ts`,
--    which INSERTs it verbatim — `z.record` constrains the TOP level only.
-- ---------------------------------------------------------------------------

UPDATE block_versions
SET descriptor = jsonb_set(
      descriptor,
      '{capabilities}',
      (COALESCE(descriptor -> 'capabilities', '{}'::jsonb)) || '{"mockData": true}'::jsonb,
      true
    )
WHERE block_id IN (
  SELECT id FROM building_blocks
  WHERE tenant_id IS NULL
    AND slug = 'review-panel'
)
  -- `jsonb_set` needs an object to set a path in.
  AND jsonb_typeof(descriptor) = 'object'
  -- …and `||` needs an object to merge into. NULL here means the key is ABSENT, which is the one
  -- non-object case that IS handled — by the COALESCE above.
  AND (
    descriptor -> 'capabilities' IS NULL
    OR jsonb_typeof(descriptor -> 'capabilities') = 'object'
  );

-- ---------------------------------------------------------------------------
-- 2. The SECOND copy of the same fact: the descriptor literal inside the module source.
--
--    ⛔ AND THIS IS THE HALF THAT ACTUALLY STOPS THE THROW. 0077 part 3 could call its equivalent
--    "not required for correctness"; this one is the opposite. `runBlockNode` does
--    `deps.loadBlock(node.blockVersionId, source_ts, …)` and then reads `block.descriptor` — the
--    descriptor of the MODULE, transpiled out of `source_ts`. `buildContext` gates `ctx.mockData`
--    on THAT object (`const caps = block.descriptor.capabilities ?? {}`), never on the column. So
--    part 1 alone repairs the badge and the policy and leaves the block throwing exactly as before;
--    part 2 alone unbreaks the run while the card keeps claiming the output is real. Both.
--
--    ⚠️ A `replace()` ON A HAND-WRITTEN LITERAL, WHICH IS WHY IT IS SCOPED BY SLUG AND NOT BY TEXT.
--    Unlike 0077 part 3 — which matched `JSON.stringify` output from two generators — this string
--    is authored by hand in `db/seed.ts`'s `src()` template, and `capabilities: { network: false },`
--    is ALSO the literal in `if-else`, `format-output` and every other pure seeded block. A
--    text-only match would hand `mockData` to all of them. The `block_id IN (…)` subquery is the
--    predicate that makes this safe; the `LIKE` beside it only keeps the statement from touching
--    rows it would not change.
--
--    A source spelled any other way (a re-published version, an author's edit) fails the LIKE and is
--    left alone rather than corrupted — `replace()` on a non-matching string is a no-op anyway, but
--    the LIKE keeps `xmin` still on rows this file has nothing to say about.
-- ---------------------------------------------------------------------------

UPDATE block_versions
SET source_ts = replace(
      source_ts,
      'capabilities: { network: false },',
      'capabilities: { network: false, mockData: true },'
    )
WHERE block_id IN (
  SELECT id FROM building_blocks
  WHERE tenant_id IS NULL
    AND slug = 'review-panel'
)
  AND source_ts LIKE '%capabilities: { network: false },%';

-- ---------------------------------------------------------------------------
-- 3. VERIFY WHAT PARTS 1 AND 2 ACTUALLY DID. See the two numbered states in the header for why one
--    of these raises and the other does not; the short version is that one of them is this file's
--    own bug on an untouched database, and the other is data this file did not write.
--
--    ⚠️ `descriptor -> 'capabilities' ->> 'mockData'` IS SAFE ON EVERY MALFORMED ROW IN THE TARGET
--    SET, which matters because those rows hang off the same `block_id`. Measured on postgres 18:
--    `->` on a jsonb SCALAR, and `->>` with a text key on a jsonb ARRAY, both return SQL NULL rather
--    than raising (unlike `jsonb_set`, which is why part 1 needs its `jsonb_typeof` guards and this
--    does not). A NULL fails both `= 'true'` tests, so a row part 1 skipped is a row part 3 ignores.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  unrepaired int;
  drifted    int;
BEGIN
  -- STATE 1 — IMPOSSIBLE. Part 2 just rewrote exactly this row set, keyed on exactly this literal.
  SELECT count(*) INTO unrepaired
    FROM block_versions v
    JOIN building_blocks b ON b.id = v.block_id
   WHERE b.tenant_id IS NULL
     AND b.slug = 'review-panel'
     AND v.descriptor -> 'capabilities' ->> 'mockData' = 'true'
     AND v.source_ts LIKE '%capabilities: { network: false },%';

  IF unrepaired > 0 THEN
    RAISE EXCEPTION
      '0078: % global review-panel version(s) have the mockData descriptor but still carry the '
      'pre-repair capabilities literal in source_ts. Part 2 did not apply to rows part 1 changed — '
      'the badge is on over a block that still throws capability_missing_mock_data. This is not a '
      'data condition: it means part 2 was removed, mis-scoped, or its search string no longer '
      'matches the seed template in db/seed.ts.', unrepaired;
  END IF;

  -- STATE 2 — REACHABLE. A source spelled some third way. Reported, never fatal: raising here is
  -- the 0069 wedge, on data this file did not write.
  SELECT count(*) INTO drifted
    FROM block_versions v
    JOIN building_blocks b ON b.id = v.block_id
   WHERE b.tenant_id IS NULL
     AND b.slug = 'review-panel'
     AND v.descriptor -> 'capabilities' ->> 'mockData' = 'true'
     -- ⛔ `mockData\s*:\s*true`, NOT `LIKE '%mockData%'`, AND THE DIFFERENCE IS THE WHOLE GUARD.
     -- This block's RUN BODY calls `ctx.mockData("review_decision", …)` — the token is in EVERY
     -- review-panel source, repaired or not, so a `%mockData%` test is satisfied by every row and
     -- the warning could never fire. What is being asked is whether the DESCRIPTOR LITERAL GRANTS
     -- the capability, which is the `mockData: true` pair; the regex tolerates the whitespace a
     -- re-spelling would vary (`mockData:true`, `mockData : true`) so a source that genuinely
     -- grants it is not reported as drift.
     AND v.source_ts !~ 'mockData\s*:\s*true';

  IF drifted > 0 THEN
    RAISE WARNING
      '0078: % global review-panel version(s) were left with the mockData descriptor over a source '
      'that grants no mockData capability — their source_ts matches neither the pre-repair nor the '
      'repaired seed literal, so part 2 skipped them and they will still throw '
      'capability_missing_mock_data at run time. SKIPPED, not failed: aborting here would roll back '
      'the whole migration transaction and wedge the boot (see 0069). Repair the source by hand or '
      'republish the block.', drifted;
  END IF;
END $$;
