// src/challenges/sample-test.ts — W8/P4 "Test with this challenge's sample data" in /build.
//
// A member opens /build with a challenge in context and presses ONE button. `POST /api/runs` with
// `sampleChallengeId` then runs the flow on that challenge's linked sample data, without the member
// wiring a node by hand:
//   1. `pickSampleBinding` decides which dataset input reads which dataset (pure, unit-testable);
//   2. the run executes a COPY of the graph with that one config value set — the stored flow is not
//      written here (the browser applies the same binding to its canvas so the member sees it);
//   3. for a reader who is not a data manager, the injected rows are masked with the SAME rule as
//      the sample-data previews (`maskInjectedForReader`, datasets/member-view.ts) — as they are
//      for EVERY run by a non-manager, so the run's results can only echo values the member may
//      already see.
//
// ⛔ WHAT THIS NEVER DOES: derive a data block. Deriving stays developer-only
// (`requireOntologyManager` → routes/ontology.ts `derive-block`). A data block for a linked type of
// information is only USED when a developer has already derived it — either it is on the canvas
// already, or it is offered by name so the member can drop the existing block in.
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  db as defaultDb,
  buildingBlocks,
  blockVersions,
  challengeDatasets,
  datasets,
  ontologyEntities,
} from '../db/client';
import type { FlowGraph } from '../db/flow-types';
import type { BlockDescriptor } from '../db/block-types';
import { entityKey } from '../ontology/ontology-service';
import { dataBlockSlug } from '../ontology/data-block-compiler';
import { challengeInTenant, entityIdsFromChallengeData, linkedEntityIds } from './challenge-information';
import { unprocessable } from '../utils/http';

type Db = typeof defaultDb;

/** Which dataset input the test reads, and why that one. */
export interface SampleBinding {
  nodeId: string;
  input: string;
  slug: string;
  /** `challenge` = this run binds the challenge's dataset into an empty/other input;
   *  `already` = an input already reads one of the challenge's datasets;
   *  `entity_block` = a data block a developer derived for a linked type of information. */
  source: 'challenge' | 'already' | 'entity_block';
}

export type SampleBindingResult =
  | { kind: 'bound'; binding: SampleBinding }
  | { kind: 'no_data_input' }
  | { kind: 'none_linked' };

interface DatasetInputSite {
  nodeId: string;
  input: string;
  blockId: string;
  /** What the input reads today: the node config, else the descriptor default. */
  current: string | null;
}

/** Every dataset-typed input in graph order that a node-config value can set (not fed by an edge). */
function datasetInputSites(graph: FlowGraph, descriptors: Map<string, BlockDescriptor>): DatasetInputSite[] {
  const fed = new Set(graph.edges.map((e) => `${e.target}\u0000${e.targetHandle}`));
  const out: DatasetInputSite[] = [];
  for (const node of graph.nodes) {
    if (node.kind === 'foreach') continue;
    const d = descriptors.get(node.blockVersionId);
    if (!d) continue;
    for (const [input, spec] of Object.entries(d.inputs ?? {})) {
      if (spec.type !== 'dataset') continue;
      if (fed.has(`${node.id}\u0000${input}`)) continue;
      const cfg = node.config?.[input];
      const current = typeof cfg === 'string' && cfg ? cfg : typeof spec.default === 'string' && spec.default ? spec.default : null;
      out.push({ nodeId: node.id, input, blockId: node.blockId, current });
    }
  }
  return out;
}

/**
 * Pick the input the sample test reads. In order:
 *   1. an input that already reads one of the challenge's datasets — nothing to change;
 *   2. a data block a developer derived for one of the challenge's types of information — it
 *      already reads that information's sample, so it is used as it is;
 *   3. the FIRST dataset input in graph order, bound to the challenge's first dataset.
 * No dataset input at all → `no_data_input`; nothing linked and no derived block → `none_linked`.
 */
export function pickSampleBinding(
  graph: FlowGraph,
  descriptors: Map<string, BlockDescriptor>,
  challengeSlugs: string[],
  entityBlockIds: ReadonlySet<string>,
): SampleBindingResult {
  const sites = datasetInputSites(graph, descriptors);
  if (!sites.length) return { kind: 'no_data_input' };
  const linked = new Set(challengeSlugs);
  const already = sites.find((s) => s.current && linked.has(s.current));
  if (already) return { kind: 'bound', binding: { nodeId: already.nodeId, input: already.input, slug: already.current!, source: 'already' } };
  const entityBlock = sites.find((s) => entityBlockIds.has(s.blockId) && s.current);
  if (entityBlock) {
    return {
      kind: 'bound',
      binding: { nodeId: entityBlock.nodeId, input: entityBlock.input, slug: entityBlock.current!, source: 'entity_block' },
    };
  }
  const first = challengeSlugs[0];
  if (!first) return { kind: 'none_linked' };
  const site = sites[0]!;
  return { kind: 'bound', binding: { nodeId: site.nodeId, input: site.input, slug: first, source: 'challenge' } };
}

/** The graph a sample test executes: a copy with the binding's one config value set. */
export function applySampleBinding(graph: FlowGraph, binding: SampleBinding): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === binding.nodeId ? { ...n, config: { ...(n.config ?? {}), [binding.input]: binding.slug } } : n,
    ),
  };
}

/** A published data block a developer derived for a type of information, as the member sees it. */
export interface EntityDataBlock {
  blockId: string;
  slug: string;
  name: string;
}

/** The challenge's datasets that exist in the tenant, in link order. */
async function challengeDatasetSlugs(challengeId: string, tenantId: string, database: Db): Promise<string[]> {
  const rows = await database
    .select({ slug: challengeDatasets.dataset_slug })
    .from(challengeDatasets)
    .innerJoin(datasets, and(eq(datasets.slug, challengeDatasets.dataset_slug), eq(datasets.tenant_id, tenantId)))
    .where(eq(challengeDatasets.challenge_id, challengeId))
    .orderBy(challengeDatasets.created_at);
  return rows.map((r) => r.slug);
}

/** Data blocks ALREADY derived (by a developer) for the challenge's types of information: the
 *  tenant's own blocks at each entity's deterministic slug, with at least one published version. */
async function entityDataBlocks(challengeId: string, tenantId: string, database: Db): Promise<EntityDataBlock[]> {
  const ids = [
    ...new Set([
      ...(await linkedEntityIds(challengeId, tenantId, database)),
      ...(await entityIdsFromChallengeData(challengeId, tenantId, database)),
    ]),
  ];
  if (!ids.length) return [];
  const entities = await database.select().from(ontologyEntities).where(inArray(ontologyEntities.id, ids));
  const slugs = [...new Set(entities.map((e) => dataBlockSlug(entityKey(e))))];
  if (!slugs.length) return [];
  const blocks = await database
    .selectDistinct({ blockId: buildingBlocks.id, slug: buildingBlocks.slug, name: buildingBlocks.name })
    .from(buildingBlocks)
    .innerJoin(blockVersions, eq(blockVersions.block_id, buildingBlocks.id))
    .where(
      and(
        inArray(buildingBlocks.slug, slugs),
        eq(buildingBlocks.tenant_id, tenantId),
        eq(buildingBlocks.archived, false),
        isNotNull(blockVersions.published_at),
      ),
    );
  // In the order the information was linked.
  const order = new Map(slugs.map((s, i) => [s, i]));
  return blocks.sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
}

/**
 * Resolve a sample test for `POST /api/runs`: the graph to execute and the binding. Throws 404 for a
 * challenge outside the tenant, and a 422 the browser turns into plain words when there is nothing
 * to test with (`sample_none_linked`) or nowhere to put it (`sample_no_data_input`, naming an
 * already-derived data block the member can add, when there is one).
 */
export async function prepareSampleTest(
  args: { tenantId: string; challengeId: string; graph: FlowGraph; descriptors: Map<string, BlockDescriptor> },
  database: Db = defaultDb,
): Promise<{ graph: FlowGraph; binding: SampleBinding }> {
  const c = await challengeInTenant(args.challengeId, args.tenantId, database);
  const slugs = await challengeDatasetSlugs(c.id, c.tenant_id, database);
  const blocks = await entityDataBlocks(c.id, c.tenant_id, database);
  const picked = pickSampleBinding(args.graph, args.descriptors, slugs, new Set(blocks.map((b) => b.blockId)));
  if (picked.kind === 'no_data_input') {
    const block = blocks[0];
    throw unprocessable('sample_no_data_input', 'The flow has no step that reads data yet.', {
      ...(block ? { dataBlock: { slug: block.slug, name: block.name } } : {}),
    });
  }
  if (picked.kind === 'none_linked') {
    throw unprocessable('sample_none_linked', 'No sample data is linked to this challenge.', { challengeId: c.id });
  }
  return { graph: applySampleBinding(args.graph, picked.binding), binding: picked.binding };
}

