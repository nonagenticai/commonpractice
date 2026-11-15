// src/db/seed-datasets.ts — Phase 2.0 sample test data so the app works out of the
// box (no hand-loading). Seeds, owned by the dev/bypass user so they appear in the
// Datasets screen immediately:
//   • two sample datasets (claims + customers) with typed columns;
//   • a `load-dataset` block whose dataset-typed `source` input reads ctx.dataset();
//   • a demo flow wiring that block to the claims dataset, so Test-run streams REAL
//     rows end-to-end (the runner gets them via the host-injected init frame).
// Idempotent: datasets matched by (owner, slug), the block by slug, the flow by
// (owner, name) — re-running skips what already exists.
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  db,
  users,
  buildingBlocks,
  blockVersions,
  blockTests,
  flows,
  datasets,
  tenants,
  challenges,
  challengeDatasets,
  ontologyEntities,
  datasetMappings,
} from './client';
import type { AssertMode } from './block-types';
import type { BlockDescriptor } from './block-types';
import type { FlowGraph } from './flow-types';
import { DEMO_TENANT_ID } from '../config';
import { weekString } from '../host/cycle-service';
import { parseJsonValue } from '../datasets/parse/json';
import { createDataset } from '../datasets/dataset-service';
import { bindEntitySample, listEntitySamples } from '../ontology/sample-service';
import { requireScannedSource } from '../blocks/source-gate';

const DEV_OWNER = process.env.AUTH_BYPASS_USER_ID ?? '00000000-0000-0000-0000-000000000000';

/** The one global block this file seeds. Single source for blocks/seeded-global-blocks.ts. */
export const DATASET_BLOCK_SLUG = 'load-dataset';

interface SampleDataset {
  slug: string;
  name: string;
  rows: Record<string, unknown>[];
}

const SAMPLES: SampleDataset[] = [
  {
    slug: 'sample-claims',
    name: 'Sample Claims',
    rows: [
      { claim_id: 'CLM-1001', type: 'auto', amount: 2500, status: 'open', filed: '2026-01-15' },
      { claim_id: 'CLM-1002', type: 'home', amount: 5400, status: 'review', filed: '2026-02-03' },
      { claim_id: 'CLM-1003', type: 'auto', amount: 780, status: 'approved', filed: '2026-02-19' },
      { claim_id: 'CLM-1004', type: 'travel', amount: 1200, status: 'open', filed: '2026-03-02' },
      { claim_id: 'CLM-1005', type: 'home', amount: 9800, status: 'escalated', filed: '2026-03-21' },
    ],
  },
  {
    slug: 'sample-customers',
    name: 'Sample Customers',
    rows: [
      { id: 'CUST-1', name: 'Alice Brandt', email: 'alice@example.invalid', tier: 'gold', dob: '1986-04-12' },
      { id: 'CUST-2', name: 'Bram de Vries', email: 'bram@example.invalid', tier: 'silver', dob: '1991-09-30' },
      { id: 'CUST-3', name: 'Chloe Martens', email: 'chloe@example.invalid', tier: 'bronze', dob: '1979-12-01' },
    ],
  },
];

const LOAD_DATASET_DESCRIPTOR: BlockDescriptor = {
  inputs: {
    source: {
      type: 'dataset',
      required: true,
      description: 'The dataset to load (pick one in the config panel).',
    },
  },
  outputs: {
    rows: { type: 'json' },
    count: { type: 'number' },
  },
  // ⛔ `dataset`, NOT `mockData`, AND THE DIFFERENCE IS WHAT THE CUSTOMER IS TOLD. `run()` below is
  // one `ctx.dataset(inputs.source)` — it returns the TENANT'S OWN UPLOADED ROWS and never calls
  // `ctx.mockData`. It declared `mockData: true` only because the executor's dataset gate used to be
  // spelled `if (!caps.mockData)`; once the "Simulated" badge started rendering from that same flag,
  // the first node of most demo flows was about to tell a customer their real data was fabricated.
  // See db/block-types.ts for the split. Migration 0077 repairs the descriptors already in the DB.
  capabilities: { network: false, dataset: true },
};

const LOAD_DATASET_SOURCE = `export default {
  descriptor: ${JSON.stringify(LOAD_DATASET_DESCRIPTOR)},
  async run(inputs, ctx) {
    const rows = await ctx.dataset(inputs.source);
    ctx.log('info', 'loaded dataset rows', { slug: inputs.source, count: rows.length });
    return { rows, count: rows.length };
  },
};
`;

// Phase 2-B: runnable, dataset-backed tests for the load-dataset block so the
// Testing tab + the publish gate demo out of the box. NOT run at seed time (seedAll
// runs on boot — spawning runner subprocesses there would be wrong); the rows are
// inserted unrun and execute on the first in-app "Run tests" / publish.
interface SeedTest {
  name: string;
  description: string;
  inputs: Record<string, unknown>;
  datasets: string[];
  expected: Record<string, unknown> | null;
  assert_mode: AssertMode;
  expect_error: boolean;
  expected_error_kind: string | null;
}

const LOAD_DATASET_TESTS: SeedTest[] = [
  {
    name: 'loads sample-claims rows',
    description: 'Loading the seeded claims dataset returns all 5 rows.',
    inputs: { source: 'sample-claims' },
    datasets: [],
    expected: { count: 5 },
    assert_mode: 'subset',
    expect_error: false,
    expected_error_kind: null,
  },
  {
    name: 'missing source input errors',
    description: 'Running without the required dataset input fails descriptor validation.',
    inputs: {},
    datasets: [],
    expected: null,
    assert_mode: 'subset',
    expect_error: true,
    expected_error_kind: 'validation',
  },
];

// Phase 3.6: make the three-role test-data flow real. Test data is a shared, org-level
// resource: IT (the demo org's tenant_admin, Tom) owns it; a regular employee (the Demo Owner, a
// member) raises a challenge tagging the relevant subset; any other member (e.g. Lisa,
// the builder) browses ALL of it. Seeds, in the demo org tenant ('common-practice-demo',
// created by seedPlatform which runs before seedDatasets):
//   • the sample datasets owned by Tom (admin), tenant-scoped to the demo org;
//   • a Demo-Owner-authored challenge in that org tagging those datasets.
// (Phase C.1: the Demo Owner's membership of the demo org is now its users.tenant_id, set by
//  seedPlatform — there is no tenant_members table.)
// Best-effort + idempotent: if the demo tenant / users aren't seeded, it no-ops.
const DEMO_TENANT_SLUG = 'common-practice-demo'; // mirrors seed-platform.ts
const DEMO_CHALLENGE_TITLE = 'Flag high-value claims for faster review';
/** The CH-nnn display badge stamped on that challenge — and, with the tenant, its idempotency KEY.
 *  `challenges_tenant_code_key` (schema.ts) is UNIQUE over (tenant_id, code) wherever
 *  `code IS NOT NULL`, so a non-null literal here can match at most one row; the title can match
 *  any number. Kept as a named constant because the lookup and the INSERT must never drift apart —
 *  two literals would let one be edited alone, and the seeder would then insert a second row every
 *  boot. Same key `seed-marketplace-i18n.ts` resolves challenges by, deliberately: two seeders
 *  keyed on different columns can disagree about which row is "the" challenge. */
const DEMO_CHALLENGE_CODE = 'CH-297';

async function userIdByEmail(email: string): Promise<string | null> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return u?.id ?? null;
}

async function seedDemoOrgData(): Promise<{ datasets: number; challenge: number }> {
  const [demo] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, DEMO_TENANT_SLUG));
  const tomId = await userIdByEmail('tom@commonpractice.local'); // demo-org tenant_admin (IT)
  const demoOwnerId = await userIdByEmail('demo-owner@commonpractice.local'); // Claims employee
  if (!demo || !tomId || !demoOwnerId) return { datasets: 0, challenge: 0 };
  const demoTenantId = demo.id;

  // IT-owned datasets, scoped to the org (owner = Tom; tenant = the demo org).
  let dsCreated = 0;
  for (const s of SAMPLES) {
    const [existing] = await db
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.tenant_id, demoTenantId), eq(datasets.slug, s.slug)));
    if (existing) continue;
    await createDataset({
      ownerId: tomId,
      tenantId: demoTenantId,
      name: s.name,
      sourceType: 'json',
      parsed: parseJsonValue(s.rows),
    });
    dsCreated++;
  }

  // The Demo Owner raises a challenge in the org, tagging the relevant subset of IT's data.
  let challengeCreated = 0;
  const [existingCh] = await db
    .select({ id: challenges.id })
    .from(challenges)
    // ⛔ TENANT-SCOPED **AND KEYED ON A COLUMN THE DATABASE MAKES UNIQUE.** `challenges.title` is
    // unique in no sense the database enforces, and this lookup guards an INSERT that stamps
    // `demoTenantId` — so an unscoped match would let a same-titled challenge in ANY other tenant
    // suppress the demo org's own row (and, the other way round, hand this seeder a foreign row to
    // tag IT's datasets onto). Same defect class as the marketplace i18n seeder; see
    // seed-marketplace-i18n.ts's header.
    //
    // The tenant predicate alone was NOT enough, and that is the second half of this fix. Nothing
    // stops the SAME tenant holding two rows with this title — `routes/challenges.ts` inserts with
    // no duplicate guard — so `(tenant_id, title)` picked whichever one Postgres returned first,
    // i.e. heap order: a function of the last UPDATE or VACUUM, not of anything a reader could
    // name. `(tenant_id, code)` carries the partial unique index `challenges_tenant_code_key`, so
    // AT MOST ONE ROW CAN MATCH and the result is deterministic by construction rather than by
    // hope. `asc(challenges.id)` is defence in depth, not the guarantee: if that index is ever
    // dropped the pick degrades to "oldest uuidv7 wins", which is still a rule a reader can state,
    // instead of degrading back to heap order.
    .where(and(eq(challenges.tenant_id, demoTenantId), eq(challenges.code, DEMO_CHALLENGE_CODE)))
    .orderBy(asc(challenges.id))
    .limit(1);
  let challengeId = existingCh?.id ?? null;
  if (!challengeId) {
    const [ch] = await db
      .insert(challenges)
      .values({
        title: DEMO_CHALLENGE_TITLE,
        description:
          'Adjusters spend hours triaging claims by hand. Surface the high-value ones (amount > €2,500) so they get reviewed first.',
        business_impact: 'Faster turnaround on the claims that carry the most risk.',
        work_area: 'Claims',
        submitter_id: demoOwnerId,
        tenant_id: demoTenantId,
        status: 'voting',
        // A real ISO week, not '': a challenge stamped with the empty week can never be picked
        // up by the weekly close (`where week = '2026-W30'`), so it would sit in `voting` forever
        // while the demo's own cadence strip counts down. Same defect the create routes carried.
        week: weekString(new Date()),
        // Distinct from every other seeded demo code (unique per tenant since 0047). The SAME
        // constant the lookup above keys on — see DEMO_CHALLENGE_CODE for why it must not be
        // re-spelled as a literal here.
        code: DEMO_CHALLENGE_CODE,
        tags: ['claims', 'triage'],
      })
      .returning({ id: challenges.id });
    challengeId = ch!.id;
    challengeCreated = 1;
  }
  // Tag the org datasets the Demo Owner knows are relevant (idempotent via the composite PK).
  await db
    .insert(challengeDatasets)
    .values([
      {
        challenge_id: challengeId,
        dataset_slug: 'sample-claims',
        note: 'The amount column matters — flag > €2,500.',
        added_by: demoOwnerId,
      },
      { challenge_id: challengeId, dataset_slug: 'sample-customers', note: '', added_by: demoOwnerId },
    ])
    .onConflictDoNothing();

  return { datasets: dsCreated, challenge: challengeCreated };
}

/**
 * Bind the demo org's datasets to ontology entities as test data, so the ontology→data-block path
 * AND the run-time data contract are visibly wired out of the box. Runs LAST — after ontology,
 * datasets AND `seedExampleBlocks` (which writes the confirmed dataset→entity mappings this reads).
 * Idempotent via bindEntitySample's upsert. Runs on the system path (owner pool) so RLS is
 * bypassed; we pass the demo tenant explicitly.
 *
 * Two kinds of binding, and the difference is the point:
 *   • `sample-claims` → the insurance/Claims `Claim` entity. No mapping exists for that pair (the
 *     Claims-dept overlay's attributes — reserve, fraud_score, adjuster_notes — are not
 *     sample-claims columns), so this one stays `mapping_id` NULL and the validator SKIPS it.
 *     That is correct, not a gap: there is genuinely nothing to validate against.
 *   • every demo dataset that ALREADY HAS a human-confirmed mapping (`example-claims`,
 *     `example-policies`, `example-customers` — written by seedExampleBlocks) → the entity it is
 *     mapped to. These bindings are LIVE: corrupt one of those datasets and `POST /api/runs`
 *     produces a real finding.
 * Before this, only the first kind existed, so the three confirmed mappings seedExampleBlocks had
 * just written were reachable by nothing and a seeded tenant could not trip the contract.
 *
 * ⚠️ THE BINDINGS STORE NO `mapping_id`, AND MUST NOT. This passes `{datasetId, isPrimary}` and
 * names no mapping, so `bindEntitySample` writes NULL — which is not "unmapped": the RUN resolves
 * the confirmed mapping (datasets/ontology-validation.ts). Resolving it here instead would make the
 * bindings depend on this function running after every future mapping edit, which is the exact
 * staleness that made the contract inert. See ontology/sample-service.ts.
 */
export async function seedEntitySamples(): Promise<{ bound: number }> {
  const [demo] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEMO_TENANT_SLUG));
  if (!demo) return { bound: 0 };
  const demoTenantId = demo.id;
  let bound = 0;

  /** Bind, keeping the entity's existing primary if another dataset already holds it. */
  const bind = async (entityId: string, datasetId: string): Promise<void> => {
    const existing = await listEntitySamples(demoTenantId, entityId);
    // `s.datasetId !== datasetId` matters on a RE-seed: without it the row would see itself as
    // "the other primary" and demote itself to non-primary on every boot.
    const otherHoldsPrimary = existing.some((s) => s.isPrimary && s.datasetId !== datasetId);
    await bindEntitySample(demoTenantId, entityId, { datasetId, isPrimary: !otherHoldsPrimary });
    bound++;
  };

  // The most specific Claim entity (the insurance/Claims cell the demo challenge lives in).
  const [claim] = await db
    .select({ id: ontologyEntities.id })
    .from(ontologyEntities)
    .where(
      and(
        eq(ontologyEntities.scope, 'industry_dept'),
        eq(ontologyEntities.industry, 'insurance'),
        eq(ontologyEntities.department, 'Claims'),
        eq(ontologyEntities.name, 'Claim'),
        isNull(ontologyEntities.tenant_id),
      ),
    );
  const [ds] = await db
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(eq(datasets.tenant_id, demoTenantId), eq(datasets.slug, 'sample-claims')));
  if (claim && ds) await bind(claim.id, ds.id);

  // Every (demo dataset, entity) pair a human-confirmed mapping already covers. These are the rows
  // the review found "sitting unreachable": the mapping existed, nothing linked it to a sample.
  // ⛔ ORDER BY IS LOAD-BEARING, not tidiness. `bind` sets `isPrimary: !otherHoldsPrimary`, so
  // WHICH dataset ends up primary for an entity is decided by whichever row this query yields
  // first. Postgres has no default order, and a plan flip (or a plain re-seed) can change it. It is
  // latent today only because the four demo bindings land on four DISTINCT entities, so no entity
  // has a contest to lose — the first demo dataset to share an entity with another makes "which
  // dataset is the primary sample" non-deterministic, and the primary is what
  // `deriveDataBlock` compiles into a block version.
  const mapped = await db
    .select({ datasetId: datasetMappings.dataset_id, entityId: datasetMappings.entity_id })
    .from(datasetMappings)
    .innerJoin(datasets, eq(datasets.id, datasetMappings.dataset_id))
    .where(and(eq(datasets.tenant_id, demoTenantId), eq(datasetMappings.confirmed, true)))
    .orderBy(datasets.slug, datasetMappings.entity_id);
  const seen = new Set<string>();
  for (const m of mapped) {
    const key = `${m.entityId}:${m.datasetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await bind(m.entityId, m.datasetId);
  }
  return { bound };
}

export async function seedDatasets(): Promise<{
  datasets: number;
  block: number;
  flow: number;
  tests: number;
}> {
  await db
    .insert(users)
    .values({ id: DEV_OWNER, email: 'dev@localhost', name: 'Dev User' })
    .onConflictDoNothing({ target: users.id });

  // ---- sample datasets ----
  let createdDatasets = 0;
  for (const s of SAMPLES) {
    const [existing] = await db
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.owner_id, DEV_OWNER), eq(datasets.slug, s.slug)));
    if (existing) continue;
    const parsed = parseJsonValue(s.rows);
    // createDataset derives the slug from the name; our names map 1:1 to the slugs.
    await createDataset({ ownerId: DEV_OWNER, tenantId: DEV_OWNER, name: s.name, sourceType: 'json', parsed });
    createdDatasets++;
  }

  // ---- the load-dataset block ----
  let createdBlock = 0;
  let versionId: string;
  const [existingBlock] = await db
    .select({ id: buildingBlocks.id, current: buildingBlocks.current_version_id })
    .from(buildingBlocks)
    .where(eq(buildingBlocks.slug, DATASET_BLOCK_SLUG));
  if (existingBlock?.current) {
    versionId = existingBlock.current;
  } else {
    versionId = await db.transaction(async (tx) => {
      const [block] = await tx
        .insert(buildingBlocks)
        .values({
          slug: DATASET_BLOCK_SLUG,
          name: 'Load dataset',
          description: 'Loads one of the organisation’s datasets, chosen in the block settings, and returns its rows and the number of rows.',
          category: 'data',
          region: 'eu-west',
          cost_class: 'low',
        })
        .returning();
      const [version] = await tx
        .insert(blockVersions)
        .values({
          block_id: block!.id,
          version: '1.0.0',
          status: 'stable',
          docs_md: '# load-dataset\n\nReads a dataset (selected in the config panel) and returns its `rows` and `count`.',
          source_ts: requireScannedSource(LOAD_DATASET_SOURCE),
          descriptor: LOAD_DATASET_DESCRIPTOR,
          tests_passing: true,
          published_at: new Date(),
        })
        .returning();
      await tx
        .update(buildingBlocks)
        .set({ current_version_id: version!.id })
        .where(eq(buildingBlocks.id, block!.id));
      return version!.id;
    });
    createdBlock = 1;
  }

  // ---- the demo flow (load-dataset → sample-claims) ----
  let createdFlow = 0;
  const FLOW_NAME = 'Dataset demo · claims';
  const [existingFlow] = await db
    .select({ id: flows.id })
    .from(flows)
    .where(and(eq(flows.owner_id, DEV_OWNER), eq(flows.name, FLOW_NAME)));
  if (!existingFlow) {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'n1',
          blockId: 'load-dataset',
          blockVersionId: versionId,
          slug: 'load-dataset',
          label: 'load-dataset',
          category: 'data',
          config: { source: 'sample-claims' },
          position: { x: 240, y: 160 },
        },
      ],
      edges: [],
    };
    await db.insert(flows).values({ name: FLOW_NAME, owner_id: DEV_OWNER, tenant_id: DEMO_TENANT_ID, graph, description: 'Loads the Sample Claims dataset.' });
    createdFlow = 1;
  }

  // ---- block tests for load-dataset (Phase 2-B; idempotent by block_id + name) ----
  let createdTests = 0;
  const [loadBlock] = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(eq(buildingBlocks.slug, DATASET_BLOCK_SLUG));
  if (loadBlock) {
    for (const t of LOAD_DATASET_TESTS) {
      const [existing] = await db
        .select({ id: blockTests.id })
        .from(blockTests)
        .where(and(eq(blockTests.block_id, loadBlock.id), eq(blockTests.name, t.name)));
      if (existing) continue;
      await db.insert(blockTests).values({
        block_id: loadBlock.id,
        name: t.name,
        description: t.description,
        inputs: t.inputs,
        datasets: t.datasets,
        expected: t.expected,
        assert_mode: t.assert_mode,
        expect_error: t.expect_error,
        expected_error_kind: t.expected_error_kind,
        enabled: true,
        created_by: DEV_OWNER,
      });
      createdTests++;
    }
  }

  // Phase 3.6: the shared demo-org test data (best-effort; no-ops if its tenant/users
  // aren't seeded — e.g. a datasets-only seed).
  const demo = await seedDemoOrgData();

  return {
    datasets: createdDatasets + demo.datasets,
    block: createdBlock,
    flow: createdFlow,
    tests: createdTests,
  };
}
