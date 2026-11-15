-- 0077_split_dataset_capability.sql — stop telling customers their own data is simulated.
--
-- WHAT WAS WRONG
-- --------------
-- `capabilities.mockData` carried TWO meanings that had to come apart:
--   1. "this block may call ctx.mockData()" — a FABRICATION CLAIM about the output, and
--   2. "this block may call ctx.dataset()"  — an ACCESS GRANT to the tenant's REAL uploaded rows.
-- Meaning (2) was never intended as a claim; `exec/flow-executor.ts` simply gated `ctx.dataset` on
-- `if (!caps.mockData)` with the comment "Same trust class as mockData (test/sample data) → reuse
-- that capability." The trust argument was fine. The OVERLOAD was not, because meaning (1) had
-- meanwhile become USER-VISIBLE COPY: `routes/blocks.ts` projects `mock_data` from this exact bit
-- and the browser renders the "Simulated" badge from it on the catalogue card, the build palette,
-- the canvas node and the run output (the same badge 0076's header describes).
--
-- So every block whose `run()` is nothing but `await ctx.dataset(slug)` had to declare a
-- FABRICATION bit purely to get through an ACCESS gate — and the badge then read that bit back and
-- told the reader the block returns sample data. `load-dataset` is the first node of most demo
-- flows and returns the tenant's OWN uploaded rows. Badging it "Simulated" is the exact inverse of
-- the honesty work 0076 started: 0076 stopped a block claiming to do something real when it was
-- faking, and this one stops a block being labelled fake when it is real.
--
-- THE FIX IS THE MODEL, NOT A SLUG BLOCKLIST. `BlockCapabilities` gains a separate `dataset` bit
-- (db/block-types.ts, mirrored in frontend/src/lib/types/blocks.ts and allowed through the
-- `.strict()` zod object in blocks/descriptor-schema.ts). The executor gate becomes
-- `if (!caps.mockData && !caps.dataset)` — ADDITIVE FOR THAT GATE: `mockData` keeps opening
-- `ctx.dataset()` forever, so no block loses its dataset ACCESS. Only the DISPLAY bit moves.
--
-- ⛔ "ADDITIVE" IS TRUE OF THE `ctx.dataset()` GATE AND OF NOTHING ELSE. THIS FILE HAS ONE
-- RETROACTIVE BEHAVIOUR CHANGE AND IT IS WRITTEN DOWN HERE BECAUSE IT IS OTHERWISE SILENT.
-- The `mockData` bit was never read by the executor gate alone. `host/run-policy.ts` reads it too,
-- as the ENTIRE test for `data.pii_scrubbing`: a `pii`-marked input fed by an upstream node is
-- allowed only when THAT PRODUCER declares `capabilities.mockData === true` (taint-by-source). The
-- UPDATEs below DELETE `mockData` from the persisted descriptor, and run-policy reads the
-- `descriptor` COLUMN these statements rewrite. So, precisely:
--
--     A flow that (a) has `data.pii_scrubbing` ON, and (b) wires a block repaired here into an
--     input whose FieldSpec carries `pii: true`, RAN BEFORE THIS MIGRATION AND IS REFUSED AFTER IT
--     with `policy_pii_violation`.
--
-- That is a real, user-visible, retroactive refusal — not a display change — and it applies to
-- BOTH parts below: the four global slugs in part 1 as much as the tenant-derived rows in part 2.
-- It is LATENT at the time of writing (no seeded descriptor declares `pii: true` on any input, so
-- the number of flows this changes today is zero), but `ontology/data-block-compiler.ts` copies
-- `pii` straight from the ontology attribute onto its OUTPUT ports, so the first tenant to mark an
-- attribute PII and wire it into a `pii` input meets it.
--
-- ⛔ AND THE REFUSAL IS THE INTENDED OUTCOME, NOT COLLATERAL — see the argued decision in
-- `host/run-policy.ts` (the `data.pii_scrubbing` branch). Short form: `pii_scrubbing` exists to keep
-- REAL rows out of a PII port, and `dataset` is exactly the grant to read real rows. The pre-split
-- pass was an ARTIFACT of the overload this file removes, never a decision anyone made. The bug is
-- what those flows were allowed to do yesterday.
--
-- ⛔ WHY THIS IS A MIGRATION AND NOT JUST A SEED EDIT, AND WHY IT IS BOTH.
-- Same split 0073 and 0076 both state. `upsertGlobalBlock`/`seedAll` skip a slug that already
-- exists, so the corrected seed literals (src/db/seed-datasets.ts and
-- src/ontology/data-block-compiler.ts, both changed in this commit) repair only databases where
-- the rows do not exist yet — a fresh CI database, where `bun run migrate` runs BEFORE
-- `bun run seed` and every UPDATE below therefore matches 0 rows. This file is what repairs the
-- descriptors that ALREADY exist as JSONB in prod. Neither half is redundant.
--
-- ⚠️ EVERY VERSION, NOT JUST `current_version_id` — 0076's reasoning applies unchanged. The version
-- picker serves any row, and `displayVersion` may pick a non-current one, so repairing only the
-- current version leaves the false badge reachable one click away.
--
-- SCOPE, AND WHY IT IS IN TWO PARTS.
-- Part 1 names the four GLOBAL slugs (`tenant_id IS NULL`) that ship with this defect.
-- Part 2 is a PROPERTY match, and it is not optional: `ontology/data-block-compiler.ts` is a
-- GENERATOR. Besides the three seeded `example-*-data` blocks it produces a fresh block every time
-- a tenant derives one from an ontology entity (`ontology/data-block-derivation.ts`), each with a
-- tenant-specific `data-<entity>` slug that did not exist when this file was written. Those rows
-- are precisely the ones only a migration can reach, and every one of them reads that tenant's own
-- bound dataset. Naming slugs alone would have left the widest instance of the defect in place.
--
-- PURE DML. No DDL, no `DO`, no `RAISE`, and no GUC is set, so nothing here needs a `RESET`
-- (`MIGRATION_RESET_GUCS` + tests/migration-guc-reset.test.ts scan every file in this directory).
--
-- ⛔ AND NO `DO`/EXCEPTION HANDLER *DELIBERATELY*, WHICH IS WHY THE ROBUSTNESS BELOW IS A `WHERE`.
-- `runMigrations` applies every pending file inside ONE `sql.begin()`. A statement that RAISEs takes
-- the whole migration transaction down, and because the failure is deterministic it recurs on every
-- boot — the pod wedges rather than degrades. So this file must not contain a statement that CAN
-- raise on data it did not expect. The guards are all filters: a row this file cannot safely rewrite
-- is SKIPPED, silently and forward-compatibly, never made to abort the run.
--
-- IDEMPOTENT, AND THE GUARDS PRESERVE IT because they are pure filters over the row's CURRENT state:
--   • the jsonb rewrite is an ABSOLUTE assignment — deleting an absent key is a no-op, re-setting
--     `dataset` to true is a no-op — so a second apply of part 1 recomputes the identical value;
--   • parts 2 and 3 additionally re-test the bit they just changed (`->>'mockData' = 'true'`,
--     `LIKE '%…mockData":true%'`), so on a second apply they select ZERO rows;
--   • every predicate added for robustness is a `jsonb_typeof(...)`/`!~` test on the row as it
--     stands, so it evaluates the same way on the first and the tenth apply.
-- Net: `rows_changed_on_second_apply = 0` still holds.
--
-- ⚠️ KNOWN BOUND, RECORDED RATHER THAN CLOSED — THE POSITIVE `source_ts LIKE '%ctx.dataset(%'` IN
-- PART 2 IS SPELLING-SENSITIVE. `ctx . dataset(`, `ctx["dataset"](` and `const d = ctx.dataset` all
-- evade it. This is ACCEPTED, and the reason is the direction of the failure: a miss on the POSITIVE
-- predicate SKIPS the row, and a skipped row keeps `mockData: true` — it keeps running (the executor
-- gate still opens on `mockData`), keeps its old PII-policy behaviour, and merely keeps a "Simulated"
-- badge it should not have. The cost of a miss is the pre-existing cosmetic defect, unfixed for that
-- row. Both generators that produce these rows emit the canonical `await ctx.dataset(slug)` — this is
-- a text match on GENERATED source, not on hand-written source. The NEGATIVE predicate is the half
-- where a miss is expensive, and that one is NOT left as a bound: see part 2.

-- ---------------------------------------------------------------------------
-- 1. The four global blocks that declare `mockData` while their run() only ever
--    calls ctx.dataset().
--
--    ⚠️ `COALESCE(..., '{}'::jsonb)` IS LOAD-BEARING, NOT DEFENSIVE NOISE. `jsonb_set` returns
--    SQL NULL if any argument is NULL, and `descriptor` is `NOT NULL` — so a single row whose
--    descriptor happened to carry no `capabilities` key would abort the whole migration with a
--    not-null violation rather than skipping. The type says `capabilities` is required; the column
--    is unvalidated jsonb and does not.
--
--    ⛔ AND `COALESCE` COVERS EXACTLY ONE OF THE FOUR WAYS THIS CAN GO WRONG — THE ABSENT KEY.
--    It is a NULL test, and `descriptor -> 'capabilities'` is SQL NULL only when the key is MISSING.
--    A key that is PRESENT and non-object sails straight past it into operators that RAISE:
--
--      capabilities   descriptor->'capabilities'   COALESCE gives   what the rewrite then does
--      ------------   --------------------------   --------------   -------------------------------
--      absent         SQL NULL                     '{}'::jsonb      {"dataset":true}        ← covered
--      JSON null      'null'::jsonb (NOT SQL NULL) 'null'::jsonb    ERROR: cannot delete from scalar
--      "x" / 7 / true a jsonb scalar               itself           ERROR: cannot delete from scalar
--      [ "x" ]        a jsonb array                itself           ⚠️ NO ERROR — SILENT CORRUPTION
--
--    ⚠️ AND THE ARRAY ROW IS THE ONE TO READ TWICE, BECAUSE IT IS NOT THE FAILURE THE REST OF THIS
--    COMMENT IS ABOUT. `jsonb - text` is DEFINED on an array (it removes matching string ELEMENTS),
--    and `array || object` wraps the object as a one-element array, so `["x"]` becomes
--    `["x", {"dataset": true}]` and is written back as the block's `capabilities` WITHOUT any error.
--    A guard aimed only at "the statement must not raise" would have let that through. The predicate
--    below is a positive `= 'object'` test rather than a negative list for exactly this reason.
--
--    …and a `descriptor` that is itself a non-object raises in `jsonb_set` before any of the above,
--    with TWO different messages depending on the shape — measured, not assumed:
--      '"x"'::jsonb / '7'::jsonb  → ERROR: cannot set path in scalar
--      '[1,2]'::jsonb             → ERROR: path element at position 1 is not an integer: "capabilities"
--    Either one is fatal in the same way, which is why the guard tests `jsonb_typeof(descriptor) =
--    'object'` positively rather than excluding a list of shapes someone remembered.
--
--    ⛔ AND THESE ROWS ARE REACHABLE THROUGH THE PRODUCT, NOT MERELY "NOT FORBIDDEN BY THE DB".
--    The HTTP path is safe: `blocks/descriptor-schema.ts` makes `capabilities` REQUIRED inside a
--    `.strict()` object and `routes/blocks.ts` runs it on create/add-version/save. The MCP agent path
--    is NOT: `ai/mcp/tools.ts` types the descriptor as `z.record(z.string(), z.unknown())` and then
--    casts it (`descriptor: i.descriptor as unknown as BlockDescriptor`) straight into
--    `blocks/authoring-service.ts`, which INSERTs it verbatim. `z.record` constrains the TOP level
--    only — `capabilities: null`, `"x"` or `["mockData"]` all pass. `addVersionCore` then forks
--    `base?.descriptor` without re-validating, so one such row propagates into every later version.
--    THAT is where a malformed descriptor should be refused, and it is not this file's job to do it.
--
--    ⛔ SO THE GUARD IS A `WHERE` PREDICATE, AND IT HAS TO BE. One such row would raise, and a raise
--    here rolls back the whole migration transaction (see the header) and wedges the pod's boot on
--    every retry — a permanent outage caused by one malformed descriptor.
--
--    ⛔ WHAT HAPPENS TO A ROW THE GUARD SKIPS — DECIDED, NOT LEFT UNSAID, BECAUSE "SILENTLY LEFT
--    BEHIND" IS ITS OWN DEFECT AND THE OBVIOUS-SOUNDING ANSWERS ARE BOTH WRONG.
--
--      SKIP (what this file does). A skipped row is ALREADY INERT, everywhere, before this migration
--      exists — measured, not argued:
--        • `exec/flow-executor.ts:840` does `const caps = block.descriptor.capabilities ?? {}`, so a
--          JSON-null becomes `{}` and a scalar/array yields `caps.mockData === undefined`. EVERY
--          capability gate is already closed for that block (`:878` mockData, `:903` dataset).
--        • `routes/blocks.ts:412` projects `mock_data: v?.descriptor?.capabilities?.mockData === true`
--          — optional chaining short-circuits on null and misses on a scalar/array, so the row
--          already renders `mock_data: false`.
--        • `host/run-policy.ts` tests `srcDesc?.capabilities?.mockData !== true`, so it already fails
--          the `data.pii_scrubbing` gate.
--      ⚠️ NOTE WHAT THAT CORRECTS: a skipped row does NOT "keep its stale Simulated badge". It never
--      had one. 0077 leaves such a row EXACTLY as broken as it was, in both directions, and its
--      brokenness is orthogonal to the mockData/dataset split this file repairs.
--
--      NORMALISE (rewrite the bad `capabilities` into a valid object) — REJECTED. For `["mockData"]`
--      it means guessing an author's intent; for a non-object `descriptor` there is no `capabilities`
--      to normalise at all. Either way it would MINT AN ACCESS GRANT (`dataset: true` is permission
--      to read the tenant's real uploaded rows) onto a row whose meaning we cannot read. A repair
--      migration must not invent a capability.
--
--      REFUSE LOUDLY (`RAISE`, or a `DO` block that aborts) — REJECTED, and this is the one that
--      looks responsible and is not. `db/migration-runner.ts:101-130` wraps ALL pending files in one
--      `sql.begin()` with a savepoint per file, and the catch at `:125-128` RETHROWS — so the outer
--      transaction rolls back including every `_migrations` INSERT. Nothing is recorded, the next
--      boot replays the identical files against the identical data, and the failure is deterministic:
--      a PERMANENT boot wedge, total outage, from one row that was already doing nothing. Trading a
--      dead row for a dead cluster is not a safety measure.
--
--    DECIDED: SKIP. The migration's contract is "repair the rows I can prove the shape of, corrupt
--    none, and always finish". A row it cannot read is not its to fix — the fix belongs at the MCP
--    write path named above. Pinned by the ROBUST cases in
--    tests/migration-0077-dataset-capability.test.ts, which assert the skipped rows are byte-identical
--    afterwards AND that a good row sharing the same statement's target set was still repaired (a
--    `WHERE false` guard would satisfy the first half alone).
--
--    Not a `DO`/`EXCEPTION` block, which is the other obvious shape and is banned here for exactly
--    the reason above. It costs one index-free predicate on a table with tens of rows per tenant.
-- ---------------------------------------------------------------------------

UPDATE block_versions
SET descriptor = jsonb_set(
      descriptor,
      '{capabilities}',
      ((COALESCE(descriptor -> 'capabilities', '{}'::jsonb)) - 'mockData') || '{"dataset": true}'::jsonb,
      true
    )
WHERE block_id IN (
  SELECT id FROM building_blocks
  WHERE tenant_id IS NULL
    AND slug IN ('load-dataset', 'example-claim-data', 'example-policy-data', 'example-customer-data')
)
  -- `jsonb_set` needs an object to set a path in.
  AND jsonb_typeof(descriptor) = 'object'
  -- …and `-` / `||` need an object to delete a key from. NULL here means the key is ABSENT, which is
  -- the one non-object case that IS handled — by the COALESCE above. Every other typeof
  -- ('null', 'string', 'number', 'boolean', 'array') is skipped rather than raised on.
  AND (
    descriptor -> 'capabilities' IS NULL
    OR jsonb_typeof(descriptor -> 'capabilities') = 'object'
  );

-- ---------------------------------------------------------------------------
-- 2. Every OTHER block version with the same shape, tenant rows included: it declares the
--    fabrication bit, but its source demonstrably never asks for fabricated data and does read a
--    dataset. This is the compiler's output for tenant-derived data blocks.
--
--    ⛔ THE TWO `source_ts` PREDICATES ARE BOTH REQUIRED, AND THE NEGATIVE ONE IS THE IMPORTANT
--    HALF. A block that calls BOTH `ctx.mockData` and `ctx.dataset` is honestly described by
--    `mockData: true` — its output really is partly invented — and must keep the badge. Matching on
--    "reads a dataset" alone would strip the claim from exactly those blocks and reintroduce the
--    original defect pointing the other way.
--
--    ⚠️ A TEXT MATCH ON SOURCE, BECAUSE THERE IS NOTHING BETTER TO MATCH ON. The capability the
--    descriptor declares is the thing being repaired, so it cannot also be the evidence; the source
--    is the only record of what the block actually does. It is deliberately CONSERVATIVE: a block
--    that reaches `ctx.mockData` by some spelling this LIKE misses keeps its badge (safe — it stays
--    labelled "Simulated"), and a block matched here provably contains no `ctx.mockData` call at
--    all. `source_ts` is NOT NULL (default ''), so there is no NULL case to reason about: an empty
--    source simply fails the positive LIKE and is skipped.
--
--    ⛔ `NOT LIKE '%ctx.mockData(%'` ALONE DOES NOT MEAN "CONTAINS NO ctx.mockData CALL", AND THE
--    CLAIM ABOVE IS ONLY TRUE BECAUSE OF THE `!~` BESIDE IT. `ctx["mockData"](rows)` and
--    `ctx . mockData(rows)` both call it and both pass a `NOT LIKE '%ctx.mockData(%'` test — so the
--    LIKE alone would strip the fabrication bit from a genuine fabricator, and because
--    `ctx.mockData()` is gated on `caps.mockData` ALONE in flow-executor.ts (unlike `ctx.dataset()`,
--    which the split gave a second key), that block then throws `capability_missing_mock_data` at
--    run time. THIS half is the expensive one to miss, so it is tightened rather than documented.
--
--    THE REGEX MATCHES THE REFERENCE, NOT THE `ctx.` SPELLING: `mockData` followed by at most four
--    non-identifier characters and then `(`. It covers `ctx.mockData(`, `ctx . mockData (`,
--    `ctx["mockData"](`, `ctx['mockData'](`, `ctx[ "mockData" ](` and a destructured
--    `const { mockData } = ctx; mockData(x)` — the last of which is invisible to any `ctx.`-anchored
--    pattern. `const m = ctx.mockData; m(x)` still evades it; a rename cannot be caught by text and
--    that residue is accepted for the same reason as the positive predicate's bound in the header —
--    a miss here SKIPS the row, leaving today's behaviour untouched.
--
--    ⛔ AND IT MUST NOT MATCH THE DESCRIPTOR LITERAL BAKED INTO THE SAME COLUMN, WHICH IS WHY IT IS
--    NOT THE OBVIOUS `NOT LIKE '%mockData%'`. Part 3 below shows the source of every row this
--    statement targets contains `"capabilities":{"network":false,"mockData":true}` — a bare
--    substring test on `mockData` would exclude EVERY row and silently turn part 2 into a no-op that
--    still reports success. The bound `{0,4}` is what separates them: after `mockData` the literal
--    runs `"`, `:`, `t` and hits an identifier character before any `(`.
--
--    The original `NOT LIKE` is kept beside it. The regex strictly implies it, but the LIKE is the
--    predicate a reader checks by eye and it is free.
-- ---------------------------------------------------------------------------

UPDATE block_versions
SET descriptor = jsonb_set(
      descriptor,
      '{capabilities}',
      ((COALESCE(descriptor -> 'capabilities', '{}'::jsonb)) - 'mockData') || '{"dataset": true}'::jsonb,
      true
    )
WHERE descriptor -> 'capabilities' ->> 'mockData' = 'true'
  -- ⚠️ REDUNDANT BY IMPLICATION, WRITTEN ANYWAY. `->` with a text key RETURNS NULL on a jsonb
  -- scalar/array rather than raising (only `-` and `jsonb_set` raise), so the `= 'true'` above
  -- already cannot be satisfied unless both `descriptor` and `capabilities` are objects. That is a
  -- two-hop inference about operator semantics; the next person to edit this WHERE should not have
  -- to reconstruct it to know the `- 'mockData'` below is safe. Same guard as part 1, stated locally.
  AND jsonb_typeof(descriptor) = 'object'
  AND jsonb_typeof(descriptor -> 'capabilities') = 'object'
  AND source_ts LIKE '%ctx.dataset(%'
  AND source_ts NOT LIKE '%ctx.mockData(%'
  AND source_ts !~ 'mockData[^A-Za-z0-9_]{0,4}\(';

-- ---------------------------------------------------------------------------
-- 3. The SECOND copy of the same fact: the descriptor literal baked into `source_ts`.
--
--    ⛔ THERE ARE TWO COPIES OF EVERY DESCRIPTOR AND THEY ARE READ BY DIFFERENT CODE. The badge
--    reads the `descriptor` COLUMN (routes/blocks.ts), which parts 1-2 above have now repaired. The
--    RUNTIME capability gate reads the descriptor embedded in the module source — `runBlockNode`
--    does `deps.loadBlock(...)` and then consults `block.descriptor`, never the column. Both
--    seed-datasets.ts and data-block-compiler.ts `JSON.stringify` the descriptor straight into the
--    source they generate, so without this statement a repaired row would carry `dataset: true` in
--    the column and `mockData: true` in its own source.
--
--    ⚠️ NOT REQUIRED FOR CORRECTNESS, AND THAT IS WHY IT IS SAFE TO DO WITH `replace()`. The
--    executor accepts `mockData` for the dataset gate permanently, so the stale literal breaks
--    nothing at run time; this only stops the two copies from disagreeing, which would otherwise
--    surface the moment anyone re-published a block from its stored source. `replace()` on a
--    non-matching string is a no-op, so a source whose literal is spelled any other way is simply
--    left alone rather than corrupted. Key order is deterministic — `JSON.stringify` preserves
--    insertion order, and both generators write `{ network: false, mockData: true }`.
-- ---------------------------------------------------------------------------

UPDATE block_versions
SET source_ts = replace(
      source_ts,
      '"capabilities":{"network":false,"mockData":true}',
      '"capabilities":{"network":false,"dataset":true}'
    )
WHERE descriptor -> 'capabilities' ->> 'dataset' = 'true'
  AND source_ts LIKE '%"capabilities":{"network":false,"mockData":true}%';
