// src/challenges/challenge-data-service.ts — Phase 3.0/3.1/3.6 (Pillar A): resolve a
// challenge's applicable datasets (the challenge_datasets link table, 0021) into the
// tenant-scoped dataset rows the UI + agent consume.
//
// Phase 3.6: test data is a shared, org-level resource (IT provisions it; the creator
// only *tags* the relevant subset). dataset_slug is unique per (tenant_id, slug), so
// resolution is scoped to the challenge's tenant — NOT the submitter, who need not own
// the data they tag. Write-validation (POST/PATCH) and read-resolution (GET / agent /
// §B6 chip) stay symmetric on tenant: a slug is accepted only if it exists in the
// challenge's tenant, so a stored link always resolves back. Datasets deleted after
// linking are dropped silently.
import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb, challengeDatasets, challenges, datasets, solutions } from '../db/client';
import type { DatasetColumn } from '../db/dataset-types';
import { listMappings } from '../datasets/mapping-service';
import { maskColumns, memberMasks } from '../datasets/member-view';
import { DEFAULT_LOCALE } from '../utils/locale';

type Db = typeof defaultDb;

export interface ChallengeDatasetOut {
  slug: string;
  name: string;
  columns: DatasetColumn[];
  rowCount: number;
  note: string;
}

/** The datasets a challenge's creator marked applicable, joined to the tenant's dataset
 *  rows for name/columns/rowCount. Ordered by link creation. tenantId = challenge.tenant_id. */
export async function resolveChallengeDatasets(
  challengeId: string,
  tenantId: string,
  database: Db = defaultDb,
): Promise<ChallengeDatasetOut[]> {
  return (await resolveWithIds(challengeId, tenantId, database)).map(({ id: _id, ...d }) => d);
}

/** A challenge dataset as a BROWSER reader may see it: `maskedColumns` lists the columns whose
 *  values a non-manager must not see, and their column `sample` is blanked (W8/P7 — rule in
 *  datasets/member-view.ts). `raw` = the reader is a data manager. */
export interface ChallengeDatasetView extends ChallengeDatasetOut {
  maskedColumns: string[];
}

export async function resolveChallengeDatasetsForReader(
  challengeId: string,
  tenantId: string,
  raw: boolean,
  database: Db = defaultDb,
): Promise<ChallengeDatasetView[]> {
  const list = await resolveWithIds(challengeId, tenantId, database);
  const masks = await memberMasks(tenantId, list, raw, database);
  return list.map(({ id, ...d }) => {
    const masked = masks.get(id) ?? [];
    return { ...d, columns: maskColumns(d.columns, masked, raw), maskedColumns: masked };
  });
}

async function resolveWithIds(
  challengeId: string,
  tenantId: string,
  database: Db,
): Promise<(ChallengeDatasetOut & { id: string })[]> {
  const links = await database
    .select({ slug: challengeDatasets.dataset_slug, note: challengeDatasets.note })
    .from(challengeDatasets)
    .where(eq(challengeDatasets.challenge_id, challengeId))
    .orderBy(challengeDatasets.created_at);
  if (!links.length) return [];

  const slugs = links.map((l) => l.slug);
  const dsRows = await database
    .select({
      id: datasets.id,
      slug: datasets.slug,
      name: datasets.name,
      columns: datasets.columns,
      rowCount: datasets.row_count,
    })
    .from(datasets)
    .where(and(eq(datasets.tenant_id, tenantId), inArray(datasets.slug, slugs)));
  const bySlug = new Map(dsRows.map((d) => [d.slug, d]));

  const out: (ChallengeDatasetOut & { id: string })[] = [];
  for (const l of links) {
    const d = bySlug.get(l.slug);
    if (!d) continue; // dataset deleted after linking — drop silently
    out.push({ id: d.id, slug: d.slug, name: d.name, columns: d.columns ?? [], rowCount: d.rowCount, note: l.note });
  }
  return out;
}

/** SPEC §B6: the distinct ontology entities a challenge "involves" — derived from the
 *  confirmed (human) mappings (3.3) of its applicable datasets. Powers the challenge-detail
 *  "This challenge involves: Claim, Policy" chip. Returns entity display labels, deduped,
 *  in first-seen order. Empty when no dataset is mapped yet.
 *
 *  `locale` is the reader's language for those labels, and defaults to en. ⚠️ The DEFAULT IS THE
 *  BEHAVIOUR, not an oversight: the other caller is the delivery payload
 *  (routes/delivery.ts:618 → buildDeliveryPayload), which is agent input rather than something a
 *  person reads, and this repo keeps agent-facing concept vocabulary canonical en on purpose (see
 *  the "Predicates and attribute names stay canonical en" note in ontology-service). Only the
 *  challenge-detail route passes a negotiated locale.
 *
 *  ⚠️ The chips render only for a dataset with a CONFIRMED mapping (`if (!m.confirmed) continue`
 *  below), so an empty chip row in a browser is not evidence about this function at all. */
export async function resolveChallengeEntities(
  challengeId: string,
  tenantId: string,
  database: Db = defaultDb,
  locale: string = DEFAULT_LOCALE,
): Promise<string[]> {
  const links = await database
    .select({ slug: challengeDatasets.dataset_slug })
    .from(challengeDatasets)
    .where(eq(challengeDatasets.challenge_id, challengeId));
  if (!links.length) return [];

  const slugs = links.map((l) => l.slug);
  const dsRows = await database
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(eq(datasets.tenant_id, tenantId), inArray(datasets.slug, slugs)));
  if (!dsRows.length) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dsRows) {
    const mappings = await listMappings(d.id, database, { locale, tenantId });
    for (const m of mappings) {
      if (!m.confirmed) continue;
      const label = m.entityLabel || m.entityName;
      if (!seen.has(label)) {
        seen.add(label);
        out.push(label);
      }
    }
  }
  return out;
}

/** Phase 5B: the distinct blocks used across existing solutions to a challenge — concrete reuse
 *  exemplars for the build/authoring agent ("these blocks already solved this challenge"). Deduped,
 *  in first-seen order across all of the challenge's solutions. Empty when no solution exists yet.
 *  Tenant-safe: solutions are FK-bound to the (tenant-owned) challenge + RLS-scoped. */
export async function resolveChallengeSolutionBlocks(
  challengeId: string,
  database: Db = defaultDb,
): Promise<string[]> {
  const rows = await database
    .select({ blocks_used: solutions.blocks_used })
    .from(solutions)
    .where(eq(solutions.challenge_id, challengeId));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    for (const slug of r.blocks_used ?? []) {
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        out.push(slug);
      }
    }
  }
  return out;
}

/** Phase 3.1 + 5B: a compact system-prompt context block telling the build/authoring agent which
 *  datasets apply to the challenge it is working AND which blocks past solutions already used —
 *  composing with 3.4's (industry × department) cell resolution. Returns null only when there's no
 *  challenge, or no datasets AND no past-solution blocks to surface. */
export async function buildAgentChallengeContext(
  challengeId: string,
  database: Db = defaultDb,
): Promise<string | null> {
  const [c] = await database
    .select({ title: challenges.title, tenantId: challenges.tenant_id })
    .from(challenges)
    .where(eq(challenges.id, challengeId));
  if (!c) return null;

  const ds = await resolveChallengeDatasets(challengeId, c.tenantId, database);
  const solutionBlocks = await resolveChallengeSolutionBlocks(challengeId, database);
  if (!ds.length && !solutionBlocks.length) return null;

  const sections: string[] = [`This flow targets the challenge "${c.title}".`];

  if (ds.length) {
    const lines = ds.map((d) => {
      const cols = d.columns.map((col) => col.name).join(', ');
      const note = d.note ? ` — ${d.note}` : '';
      return `- \`${d.slug}\` (${d.name})${note}${cols ? ` [columns: ${cols}]` : ''}`;
    });
    sections.push(
      ['The applicable test datasets are:', ...lines].join('\n'),
      'Prefer these datasets when composing the flow. Call `describe_data` / `map_dataset` for column detail and the ontology tools (`get_ontology`, `explain_relations`) to reason about their meaning and relations rather than raw column names.',
    );
  }

  if (solutionBlocks.length) {
    sections.push(
      `Blocks used in existing solutions to this challenge (consider reusing or composing these before authoring a new block): ${solutionBlocks
        .map((s) => `\`${s}\``)
        .join(', ')}. Call \`get_block\` to inspect one.`,
    );
  }

  return sections.join('\n\n');
}

/** Subset of `slugs` that exist in tenantId's shared data — used to validate the
 *  creator-supplied links (the creator tags from the org's data, need not own it). */
export async function tenantSlugs(
  tenantId: string,
  slugs: string[],
  database: Db = defaultDb,
): Promise<Set<string>> {
  if (!slugs.length) return new Set();
  const rows = await database
    .select({ slug: datasets.slug })
    .from(datasets)
    .where(and(eq(datasets.tenant_id, tenantId), inArray(datasets.slug, slugs)));
  return new Set(rows.map((r) => r.slug));
}
