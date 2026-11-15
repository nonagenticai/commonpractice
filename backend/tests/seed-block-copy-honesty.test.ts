// tests/seed-block-copy-honesty.test.ts — a seeded block must not advertise machinery it does not
// have, in ANY of the 8 editions.
//
// ⛔ THE DEFECT. `ocr-scan` shipped with `capabilities.mockData: true` and a `run()` consisting of
// `ctx.mockData("scan", { ref: inputs.image })` — which `exec/mock-data.ts` answers with the literal
// "Scanned document text (sample N). Lorem ipsum dolor sit amet." Its name was "OCR scan", its
// description "Tesseract+Claude hybrid OCR for messy scans. Published by Mo after #CH-284 solution
// week.", its docs "Hybrid Tesseract + Claude OCR for messy scans." There is no Tesseract in this
// repository, the `image` input is never read, and the string is a fixture. `read-claim-form`
// carried the same shape — "Parses claim PDFs (typed or scanned). Auto-OCRs when needed." against
// `ctx.mockData("claim_pdf", …)`.
//
// ⛔ WHY THE SWEEP IS OVER `content_translations` AND NOT JUST THE SEED LITERAL. Migration 0073
// promoted 504 block translation rows into git, including seven faithful translations of the false
// sentence ("Tesseract+Claude hybrid OCR voor rommelige scans", "Hybrid Tesseract + Claude OCR für
// unordentliche Scans", …). Correcting `src/db/seed.ts` alone leaves every non-English reader —
// including the Dutch demo audience — reading the retracted claim, which is precisely the
// one-surface fix this repo keeps shipping. Migration 0076 corrects those rows; this file is what
// notices if a future one reintroduces them, in any locale, on any block.
//
// ⛔ AND A SOURCE-LEVEL ASSERTION FOR THE SEED LITERALS THEMSELVES, DECLARED AS SUCH. The database
// half above only observes rows that exist. On a fresh cluster `bun run migrate` runs BEFORE
// `bun run seed`, so 0076's UPDATEs match nothing and the `en` base comes from the seed literal —
// a literal that could be reverted without the DB sweep noticing on any database where 0076 had
// already run and `upsertGlobalBlock` then skipped the existing slug. The literal is therefore
// asserted directly, by reading `src/db/seed.ts` as text. It is a source assertion, not a
// behavioural one, and that is a deliberate and stated limitation: it pins the STRING, not what any
// screen does with it. The screens are covered by the frontend badge sweeps
// (frontend/src/lib/components/block-simulated-badge.surfaces.render.test.ts and
// frontend/src/routes/blocks/blocks-page.simulated-badge.render.test.ts).
//
// ⛔ HONESTY CUTS BOTH WAYS, AND THE SECOND DIRECTION WAS ADDED LATER. Everything above is about a
// block CLAIMING MORE than it does. The last two tests in this file guard the opposite and worse
// error: a block being labelled a simulation when it returns the tenant's REAL data. `load-dataset`
// declared `capabilities.mockData` — not to describe itself, but because `ctx.dataset` used to be
// gated on that same bit — and the "Simulated" badge renders from it, so the first node of most demo
// flows was one deploy away from telling a customer their own uploaded rows were invented. The
// capability is now two bits (`mockData` = fabricates, `dataset` = may read real datasets); these
// tests pin that no seeded block claims the first when its source only ever does the second.
//
// NEGATIVE CONTROL, by name: restore `'Tesseract+Claude hybrid OCR for messy scans. Published by Mo
// after #CH-284 solution week.'` as `ocr-scan`'s description in src/db/seed.ts and
// "⛔ no seed literal names an OCR engine this repo does not ship" reds. Restore the 0073 wording in
// any locale row and "⛔ no block translation names an OCR engine this repo does not ship" reds.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, buildingBlocks, blockVersions, contentTranslations } from '../src/db/client';
import { SEEDED_GLOBAL_BLOCK_SLUGS } from '../src/blocks/seeded-global-blocks';
import type { BlockDescriptor } from '../src/db/block-types';

/**
 * Engines and parsers this repository does not ship, in the spelling they were claimed in. Latin
 * script even inside the `ar`/`he` rows — the pipeline transliterated nothing, it left the product
 * name verbatim — so one case-insensitive list covers all seven non-en editions.
 *
 * ⚠️ THIS IS A LIST OF PROPER NOUNS, NOT A LIST OF FORBIDDEN WORDS. "OCR" itself is legitimate
 * prose: `ocr-scan` may say it does NOT run one, and `read-claim-form` names its `ocr_used` output.
 * A ban on the acronym would forbid the honest sentence along with the dishonest one.
 */
const UNSHIPPED_ENGINES = ['tesseract', 'pytesseract', 'poppler', 'pdfminer', 'ghostscript'];

function offendingEngine(text: string): string | null {
  const lower = text.toLowerCase();
  return UNSHIPPED_ENGINES.find((e) => lower.includes(e)) ?? null;
}

test('⛔ no seed literal names an OCR engine this repo does not ship', () => {
  // The seed files that author global block prose. Read as TEXT on purpose: importing the module
  // would only expose the values, and the point is that no such string is present at all.
  const files = ['src/db/seed.ts', 'src/db/seed-datasets.ts', 'src/db/seed-example-blocks.ts'];
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(resolve(import.meta.dir, '..', f), 'utf8');
    // NON-VACUITY: a renamed or moved seed file would make this loop assert nothing.
    expect(text.length, `${f} is empty or unreadable — this assertion would pass over nothing`).toBeGreaterThan(1000);
    const hit = offendingEngine(text);
    if (hit) offenders.push(`${f} mentions "${hit}"`);
  }
  expect(
    offenders,
    offenders.length
      ? `a seed literal advertises an engine this repo does not ship: ${JSON.stringify(offenders)}. ` +
          `The block returns ctx.mockData() fixtures; say so instead.`
      : undefined,
  ).toEqual([]);
});

test('⛔ no block translation names an OCR engine this repo does not ship', async () => {
  const rows = await db
    .select({
      entity_id: contentTranslations.entity_id,
      locale: contentTranslations.locale,
      field: contentTranslations.field,
      value: contentTranslations.value,
    })
    .from(contentTranslations)
    .where(eq(contentTranslations.entity_type, 'block'));

  // NON-VACUITY: an empty translation table (an unmigrated database) would pass this for free.
  expect(
    rows.length,
    'no block translations in this database — run `bun run migrate`; this assertion would pass over nothing',
  ).toBeGreaterThan(100);

  const offenders = rows
    .map((r) => ({ r, hit: offendingEngine(r.value) }))
    .filter((x) => x.hit !== null)
    .map((x) => `${x.r.entity_id}/${x.r.locale}/${x.r.field} mentions "${x.hit}"`);

  expect(
    offenders,
    offenders.length
      ? `block translations advertise an engine this repo does not ship: ${JSON.stringify(offenders)}. ` +
          `Correcting only the en base leaves these readers with the retracted claim — see ` +
          `migrations/0076_ocr_block_honest_copy.sql.`
      : undefined,
  ).toEqual([]);
});

test('⛔ ocr-scan describes itself as a demonstration block returning sample text', async () => {
  const [row] = await db
    .select({
      name: buildingBlocks.name,
      description: buildingBlocks.description,
      docs_md: blockVersions.docs_md,
      descriptor: blockVersions.descriptor,
    })
    .from(buildingBlocks)
    .leftJoin(blockVersions, eq(blockVersions.id, buildingBlocks.current_version_id))
    .where(and(isNull(buildingBlocks.tenant_id), eq(buildingBlocks.slug, 'ocr-scan')));

  expect(row, "the seeded global block 'ocr-scan' is absent — run `bun run seed`").toBeDefined();

  // The premise: this block really does answer from a fixture. If the descriptor ever stopped
  // declaring `mockData`, the honest copy below would itself become wrong, so assert the premise
  // rather than assuming it.
  const caps = (row!.descriptor as BlockDescriptor | null)?.capabilities ?? {};
  expect(caps.mockData, 'ocr-scan no longer declares capabilities.mockData — recheck its prose').toBe(true);

  for (const [field, value] of [
    ['name', row!.name ?? ''],
    ['description', row!.description ?? ''],
    ['docs_md', row!.docs_md ?? ''],
  ] as const) {
    expect(offendingEngine(value), `ocr-scan.${field} names an unshipped engine: ${value}`).toBeNull();
  }

  // POSITIVE, not merely the absence of a word: the copy has to SAY it is a demonstration. Deleting
  // the false claim and leaving "OCR scan." behind would satisfy every negative above.
  expect(row!.description.toLowerCase()).toContain('demonstration block');
  expect(row!.description.toLowerCase()).toContain('ctx.mockdata');
  expect((row!.docs_md ?? '').toLowerCase()).toContain('ctx.mockdata');
  // The name carries the qualification too — the card title is read on its own in the grid.
  expect(row!.name.toLowerCase()).toContain('sample');
});

test('⛔ every seeded block that declares mockData is discoverable as such (the sweep is non-empty)', async () => {
  const rows = await db
    .select({ slug: buildingBlocks.slug, descriptor: blockVersions.descriptor })
    .from(buildingBlocks)
    .leftJoin(blockVersions, eq(blockVersions.id, buildingBlocks.current_version_id))
    .where(
      and(isNull(buildingBlocks.tenant_id), inArray(buildingBlocks.slug, [...SEEDED_GLOBAL_BLOCK_SLUGS])),
    );

  const simulated = rows.filter((r) => (r.descriptor as BlockDescriptor | null)?.capabilities?.mockData === true);
  // The whole badge mechanism keys off this bit. If no seeded block declared it, every frontend
  // sweep in this change would be exercising an empty set on a real database.
  expect(
    simulated.map((r) => r.slug).sort(),
    'no seeded global block declares capabilities.mockData — the "Simulated" badge would be unreachable',
  ).toContain('ocr-scan');
  // ⚠️ THIS BOUND NOW HAS ZERO SLACK, AND THAT IS A CONSEQUENCE OF THE mockData/dataset SPLIT, NOT
  // AN ACCIDENT. It used to hold with four to spare: `load-dataset` and the three `example-*-data`
  // blocks all declared `mockData` — none of them truthfully, all of them only to reach the old
  // shared `ctx.dataset` gate. With those four correctly moved to `dataset`, the seeded global
  // blocks that genuinely fabricate their output are EXACTLY four, all in src/db/seed.ts:
  // `read-claim-form`, `lookup-policy`, `ocr-scan`, `read-customer-record`.
  // So 4 == 4: the next honest retraction of any one of them reds this line. That is the correct
  // outcome — it is a tripwire, not slack — but do NOT "fix" it by lowering the number. Either the
  // block really is a simulation (keep the bit) or it is not (then this sweep, and the badge it
  // guards, genuinely have one fewer subject and the whole assertion needs rethinking).
  expect(simulated.length).toBeGreaterThanOrEqual(4);

  // ⛔ AND THE OTHER DIRECTION, WHICH IS THE ONE THAT MISLABELS A CUSTOMER'S OWN DATA. The sweep
  // above only proves the badge is REACHABLE. `load-dataset` proves it is not OVER-reaching: its
  // `run()` is one `ctx.dataset(inputs.source)` over the tenant's REAL uploaded rows and it never
  // calls `ctx.mockData`, so a `mockData` declaration here would badge it "Simulated" and tell a
  // customer their own data is fabricated — on the first node of most demo flows.
  const loadDataset = rows.find((r) => r.slug === 'load-dataset');
  // ⛔ NOT `if (loadDataset)`. `DATASET_BLOCK_SLUG` is part of `SEEDED_GLOBAL_BLOCK_SLUGS` by
  // construction (blocks/seeded-global-blocks.ts composes it from the seed literals), so an absent
  // row means the database was not seeded — and a conditional would then skip the assertion and
  // report green, which is the failure mode this whole file exists to catch.
  expect(loadDataset, "the seeded global block 'load-dataset' is absent — run `bun run seed`").toBeDefined();
  const dsCaps = (loadDataset!.descriptor as BlockDescriptor | null)?.capabilities ?? {};
  expect(
    dsCaps.mockData,
    "'load-dataset' declares capabilities.mockData, but it returns the tenant's REAL dataset rows " +
      '— the "Simulated" badge renders from this bit and would call that data fake. It needs ' +
      '`dataset: true` instead; see migrations/0077_split_dataset_capability.sql.',
  ).not.toBe(true);
  // POSITIVE half: dropping `mockData` without granting `dataset` would leave the block unable to
  // call ctx.dataset at all, which the negative assertion alone would happily accept.
  expect(dsCaps.dataset, "'load-dataset' must declare the dataset capability").toBe(true);
});

test('⛔ no seeded block declares mockData while its source only ever calls ctx.dataset', async () => {
  // ⛔ THE CLASS, NOT THE INSTANCE. Blocklisting the `load-dataset` slug would have left the next
  // dataset-only block to be mislabelled silently — and there already WAS a next one: every
  // ontology-derived data block, generated by ontology/data-block-compiler.ts, carried the same
  // overload. This asserts the PROPERTY: a block may only claim to fabricate its output if its
  // source actually asks for fabricated data.
  const rows = await db
    .select({
      slug: buildingBlocks.slug,
      descriptor: blockVersions.descriptor,
      source_ts: blockVersions.source_ts,
    })
    .from(buildingBlocks)
    .leftJoin(blockVersions, eq(blockVersions.id, buildingBlocks.current_version_id))
    .where(
      and(isNull(buildingBlocks.tenant_id), inArray(buildingBlocks.slug, [...SEEDED_GLOBAL_BLOCK_SLUGS])),
    );

  // ⛔ NON-VACUITY. An empty or descriptor-less result set satisfies the assertion below while
  // proving nothing — exactly the failure mode of a sweep run before `bun run seed`.
  expect(rows.length, 'no seeded global blocks found — run `bun run migrate && bun run seed`').toBeGreaterThan(0);
  expect(rows.some((r) => (r.descriptor as BlockDescriptor | null)?.capabilities?.mockData === true)).toBe(true);

  const liars = rows
    .filter((r) => (r.descriptor as BlockDescriptor | null)?.capabilities?.mockData === true)
    .filter((r) => {
      const src = r.source_ts ?? '';
      // Declares the fabrication bit, but the source never asks for fabricated data.
      return !src.includes('ctx.mockData') && src.includes('ctx.dataset');
    })
    .map((r) => r.slug)
    .sort();

  expect(
    liars,
    liars.length
      ? `these seeded blocks declare capabilities.mockData but their source only calls ctx.dataset: ` +
          `${JSON.stringify(liars)}. They return the tenant's REAL rows, and the "Simulated" badge ` +
          `renders off that bit — so each one tells a customer their own data is fabricated. Declare ` +
          `\`dataset: true\` instead (the executor still accepts \`mockData\` for back-compat, which ` +
          `is exactly why this drifts silently).`
      : undefined,
  ).toEqual([]);
});

/**
 * ⛔ THE INVERSE OF THE TEST ABOVE. THE LIST IS EMPTY NOW — READ THE NON-VACUITY NOTE AT THE END.
 *
 * The sweep above catches a block that CLAIMS to fabricate and does not. This one catches the
 * opposite and, for a reader, the worse direction: a block that FABRICATES and does not claim it.
 * The badge on all five presentation surfaces renders off `capabilities.mockData`, so a block
 * calling `ctx.mockData(...)` without declaring the bit is displayed as a real result on every
 * screen in the product. The declared-and-honest case is loud; this one is silent by construction.
 *
 * ⚠️ THIS IS AN EXCEPTION LIST, NOT A BLOCKLIST, AND IT IS ASSERTED BY EXACT EQUALITY.
 * Same shape as `KNOWN_INDIRECT_THROWS` (frontend error-message.backend-contract.test.ts) and
 * `KNOWN` (fixture-id-collisions.test.ts): a NEW violator reds as an unexpected entry, and a
 * REMOVED violator reds as a stale one. A `not.toContain` or a subset check would have only the
 * first property. The list was expected to shrink to empty, and it now has.
 *
 * ⛔ WHY A LIST AND NOT `test.todo` / `test.skip`. Neither appears anywhere in this repository —
 * zero uses across `backend/` and `frontend/` — and this very file argues against the shape at
 * line 193: a conditional that skips an assertion "would then report green, which is the failure
 * mode this whole file exists to catch". A skipped test states nothing about any slug and would
 * not notice a block acquiring the defect. The list does both.
 *
 * ⛔ THE LAST ENTRY WAS `review-panel`, AND IT WAS CLOSED THE WAY ITS NOTE DEMANDED. That note said
 * the block was INERT — `exec/flow-executor.ts` threw `capability_missing_mock_data` on the first
 * line of its `run()`, on every run — and that granting the bit is a PRODUCT decision, because it
 * takes a block that cannot execute and makes it execute, shipping a fabricated human approval for
 * the first time. That decision was taken and written down in 3cf27dc: both descriptor copies in
 * `src/db/seed.ts` (which repairs FRESH databases only) AND `migrations/0078_review_panel_mock_data.sql`
 * (the only half that reaches prod — `upsertGlobalBlock` skips an existing slug and prod runs
 * `SEED_DEMO_DATA=false`), with the badge and the `host/run-policy.ts` PII-taint consequences of
 * the bit stated rather than discovered later. `tests/review-panel-runs.test.ts` drives the real
 * loadBlock + executeFlow and asserts node_success. The entry is deleted here because the
 * violation is GONE, not because the list was in the way.
 *
 * ⛔⛔ AN EMPTY EXCEPTION LIST VOIDS THE OLD NON-VACUITY ARGUMENT, WHICH IS WHY THE GUARD BELOW
 * GREW A THIRD ASSERTION. While the list was non-empty, an unseeded database — or one whose
 * `source_ts` column was empty — failed LOUDLY: the expected value held an entry that a scan over
 * nothing could not produce, and the comment inside the test said exactly that. It is no longer
 * true. `[]` is precisely what a scan over nothing yields, so the equality would pass while
 * reading zero rows of source. The filter's own token is therefore pinned directly: at least one
 * seeded block's `source_ts` must contain the literal `ctx.mockData(` that the sweep filters on.
 * Do NOT re-add a slug here to get green — read the message on whichever assertion failed.
 */
const KNOWN_UNDECLARED_MOCK_DATA: string[] = [];

test('⛔ no seeded block calls ctx.mockData while OMITTING capabilities.mockData', async () => {
  const rows = await db
    .select({
      slug: buildingBlocks.slug,
      descriptor: blockVersions.descriptor,
      source_ts: blockVersions.source_ts,
    })
    .from(buildingBlocks)
    .leftJoin(blockVersions, eq(blockVersions.id, buildingBlocks.current_version_id))
    .where(
      and(isNull(buildingBlocks.tenant_id), inArray(buildingBlocks.slug, [...SEEDED_GLOBAL_BLOCK_SLUGS])),
    );

  // ⛔ NON-VACUITY, IN ALL THREE HALVES OF THE PREDICATE — AND THE THIRD IS LOAD-BEARING SINCE THE
  // EXCEPTION LIST EMPTIED. An unseeded database, or one whose rows carry no source text, satisfies
  // the equality below while measuring nothing. That used to fail LOUDLY on its own because the
  // expected value held `review-panel` and a scan over nothing cannot produce it; with the list at
  // `[]` the empty scan produces exactly the expected value and reports green. So the sweep's own
  // token is pinned: at least one seeded block's source must contain the literal `ctx.mockData(`
  // the filter matches on. `includes('ctx.')` is kept as the weaker, more diagnostic guard — it
  // fires first and names "the source column is empty" rather than "nobody fabricates any more".
  expect(rows.length, 'no seeded global blocks found — run `bun run migrate && bun run seed`').toBeGreaterThan(0);
  expect(
    rows.filter((r) => (r.source_ts ?? '').includes('ctx.')).length,
    'no seeded block source mentions ctx at all — the source column is empty, so this scan sees nothing',
  ).toBeGreaterThan(0);
  expect(
    rows.filter((r) => (r.source_ts ?? '').includes('ctx.mockData(')).length,
    'no seeded block source calls ctx.mockData( at all — the sweep below filters on that exact ' +
      'literal, so it would compare an empty set against an empty exception list and pass while ' +
      'measuring nothing. Either the seed no longer fabricates anywhere (then this whole sweep, ' +
      'and the "Simulated" badge it guards, have no subject and need rethinking) or the source ' +
      'column is not what this test thinks it is.',
  ).toBeGreaterThan(0);

  const undeclared = rows
    .filter((r) => (r.source_ts ?? '').includes('ctx.mockData('))
    .filter((r) => (r.descriptor as BlockDescriptor | null)?.capabilities?.mockData !== true)
    .map((r) => r.slug)
    .sort();

  const unexpected = undeclared.filter((s) => !KNOWN_UNDECLARED_MOCK_DATA.includes(s));
  const stale = KNOWN_UNDECLARED_MOCK_DATA.filter((s) => !undeclared.includes(s));

  expect(
    undeclared,
    unexpected.length
      ? `these seeded blocks call ctx.mockData(...) but do NOT declare capabilities.mockData: ` +
          `${JSON.stringify(unexpected)}. The "Simulated" badge renders off that bit on all five ` +
          `presentation surfaces, so each one fabricates its output and is displayed as a real ` +
          `result — and since the capability split, exec/flow-executor.ts also throws ` +
          `capability_missing_mock_data the moment ctx.mockData is called, so the block cannot run ` +
          `either. Decide which the block is: if it genuinely fabricates and should exist, declare ` +
          `\`mockData: true\` AND correct its prose (see the ocr-scan case at the top of this file); ` +
          `if it should not fabricate, change its run(). Do NOT add it to ` +
          `KNOWN_UNDECLARED_MOCK_DATA to get green — that list is a record of a decision already ` +
          `taken, with the reason written next to it.`
      : `an entry in KNOWN_UNDECLARED_MOCK_DATA no longer violates the rule: ${JSON.stringify(stale)}. ` +
          `If the block was fixed or removed, delete its entry — and read the entry's note first: ` +
          `granting the capability MAKES A CURRENTLY-INERT BLOCK RUNNABLE, which is a product ` +
          `decision, not a test fix.`,
  ).toEqual([...KNOWN_UNDECLARED_MOCK_DATA].sort());
});
