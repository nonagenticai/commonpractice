// src/blocks/seeded-global-blocks.ts — the ONE committed list of slugs that the seeders create as
// GLOBAL blocks (`building_blocks.tenant_id IS NULL`).
//
// WHY IT EXISTS. Migration 0073 ships a localized `name`/`description`/`docs_md` row for every one
// of these in all 7 non-en locales, and tests/block-i18n-coverage.test.ts asserts that coverage.
// A hand-copied fourth list would drift the moment someone adds a block: the seed would create it,
// 0073 would not cover it, and the guard would keep reporting green on the set it happens to know
// about. So the list is COMPOSED from the seed literals themselves rather than restated — adding a
// block to any seeder automatically widens the guard, which is the point.
//
// The three sources, and why there are three:
//   * src/db/seed.ts                — the base catalogue (12 blocks, the original marketplace demo);
//   * src/db/seed-example-blocks.ts — the hand-authored showcase blocks (8) plus the ontology-
//                                     derived `example-*-data` blocks (3);
//   * src/db/seed-datasets.ts       — `load-dataset`, seeded alongside the sample datasets it reads.
//
// ⛔ GLOBAL ONLY. Tenant-authored blocks are deliberately absent: they are keyed under
// `content_translations.entity_type = 'block_tenant'` with `tenantId||':'||slug` (migration 0060),
// their prose is written by the tenant, and no platform migration may author it.
import { SEED_CATALOG_BLOCK_SLUGS } from '../db/seed';
import { EXAMPLE_BLOCK_SLUGS, DATA_BLOCK_SLUGS } from '../db/seed-example-blocks';
import { DATASET_BLOCK_SLUG } from '../db/seed-datasets';

export const SEEDED_GLOBAL_BLOCK_SLUGS: readonly string[] = [
  ...SEED_CATALOG_BLOCK_SLUGS,
  ...EXAMPLE_BLOCK_SLUGS,
  ...DATA_BLOCK_SLUGS,
  DATASET_BLOCK_SLUG,
];
