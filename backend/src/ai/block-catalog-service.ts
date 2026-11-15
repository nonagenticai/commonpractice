// src/ai/block-catalog-service.ts — DB-backed block/data lookups that feed the MCP
// knowledge surface (resources/tools) and the flow-edit service. Read-only; reuses
// the same "display version" rule as routes/blocks.ts (current_version_id, else the
// newest version). No auth here — callers (MCP host) are already authed; blocks are
// readable by any authenticated user.
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { db as defaultDb, buildingBlocks, blockVersions } from '../db/client';
import type { BlockVersion, BuildingBlock } from '../db/schema';
import type { BlockCategory, BlockDescriptor } from '../db/block-types';
import { likeTerm } from '../utils/search';

type Db = typeof defaultDb;

/** A catalogue entry the agent sees: identity + typed port names + capabilities. */
export interface CatalogBlock {
  slug: string;
  name: string;
  category: BlockCategory;
  description: string;
  /** 'global' = platform-shipped; 'tenant' = authored by the caller's tenant (0037 dual ownership). */
  owner: 'global' | 'tenant';
  version: string | null;
  status: string | null;
  inputs: string[];
  outputs: string[];
  // `dataset` travels too: the agent picks blocks partly on what they may reach, and omitting the
  // grant here would make every dataset-reading block look capability-less to it.
  capabilities: { network?: boolean; llm?: boolean; mockData?: boolean; dataset?: boolean };
}

/** Everything add_node needs to instantiate a node from a slug. */
export interface ResolvedBlockEntry {
  blockId: string;
  blockVersionId: string;
  slug: string;
  name: string;
  category: BlockCategory;
  descriptor: BlockDescriptor;
}

/** The version a catalogue card displays: current if pinned, else newest. */
function displayVersion(
  block: Pick<BuildingBlock, 'current_version_id'>,
  versions: BlockVersion[],
): BlockVersion | undefined {
  if (block.current_version_id) {
    const cur = versions.find((v) => v.id === block.current_version_id);
    if (cur) return cur;
  }
  return versions[0]; // newest-first
}

function toCatalogBlock(block: BuildingBlock, v: BlockVersion | undefined): CatalogBlock {
  const d = v?.descriptor;
  return {
    slug: block.slug,
    name: block.name,
    category: block.category,
    description: block.description,
    owner: block.tenant_id === null ? 'global' : 'tenant',
    version: v?.version ?? null,
    status: v?.status ?? null,
    inputs: d ? Object.keys(d.inputs) : [],
    outputs: d ? Object.keys(d.outputs) : [],
    capabilities: d?.capabilities ?? {},
  };
}

async function versionsFor(
  blockIds: string[],
  db: Db,
): Promise<Map<string, BlockVersion[]>> {
  const all = blockIds.length
    ? await db
        .select()
        .from(blockVersions)
        .where(inArray(blockVersions.block_id, blockIds))
        .orderBy(desc(blockVersions.created_at))
    : [];
  const byBlock = new Map<string, BlockVersion[]>();
  for (const v of all) {
    const arr = byBlock.get(v.block_id) ?? [];
    arr.push(v);
    byBlock.set(v.block_id, arr);
  }
  return byBlock;
}

export interface SearchOpts {
  category?: string;
  limit?: number;
}

/** search_blocks tool / data resource: name/slug/description match, newest display
 *  version's ports + capabilities. */
export async function searchBlocks(
  query: string,
  opts: SearchOpts = {},
  db: Db = defaultDb,
): Promise<{ items: CatalogBlock[] }> {
  const filters = [eq(buildingBlocks.archived, false)];
  const q = query.trim();
  if (q) {
    // ⛔ `likeTerm`, NOT a raw `%…%` interpolation — see utils/search.ts. The agent-facing
    // catalogue takes its query straight from a model/tool argument, which is exactly the input
    // most likely to contain a literal `%` or `_`.
    const like = likeTerm(q);
    filters.push(
      or(
        ilike(buildingBlocks.name, like),
        ilike(buildingBlocks.slug, like),
        ilike(buildingBlocks.description, like),
      )!,
    );
  }
  if (opts.category) {
    filters.push(
      eq(buildingBlocks.category, opts.category as BlockCategory),
    );
  }

  const blocks = await db
    .select()
    .from(buildingBlocks)
    .where(and(...filters));
  const byBlock = await versionsFor(
    blocks.map((b) => b.id),
    db,
  );

  let items = blocks.map((b) => toCatalogBlock(b, displayVersion(b, byBlock.get(b.id) ?? [])));
  // Alphabetical. The comment here used to promise "most-used first (proxy: usage_count on the
  // display version)" — the sort never did that, and `block_versions.usage_count` could not have
  // delivered it anyway: it is a frozen seed literal nothing increments (see realUsageBySlug in
  // routes/blocks.ts). Anyone restoring a usage sort here must take it from the flow-run traces.
  items.sort((a, b) => a.name.localeCompare(b.name));
  const limit = opts.limit ?? 20;
  items = items.slice(0, Math.max(1, Math.min(limit, 100)));
  return { items };
}

/** get_block tool / block resource: full descriptor + docs for one slug. */
export async function getBlockDetail(
  slug: string,
  db: Db = defaultDb,
): Promise<(CatalogBlock & { docs_md: string; descriptor: BlockDescriptor | null }) | null> {
  const [block] = await db
    .select()
    .from(buildingBlocks)
    .where(eq(buildingBlocks.slug, slug))
    .orderBy(asc(buildingBlocks.tenant_id)); // tenant row wins over a global of the same slug
  if (!block) return null;
  const byBlock = await versionsFor([block.id], db);
  const v = displayVersion(block, byBlock.get(block.id) ?? []);
  return {
    ...toCatalogBlock(block, v),
    docs_md: v?.docs_md ?? '',
    descriptor: v?.descriptor ?? null,
  };
}

/** Resolve a slug to the entry add_node needs. Throws if the block has no version
 *  (a draft-only block can't be instantiated). */
export async function resolveBlockEntry(
  slug: string,
  db: Db = defaultDb,
): Promise<ResolvedBlockEntry> {
  const [block] = await db
    .select()
    .from(buildingBlocks)
    .where(eq(buildingBlocks.slug, slug))
    .orderBy(asc(buildingBlocks.tenant_id)); // tenant row wins over a global of the same slug
  if (!block) throw new Error(`No block '${slug}'`);
  const byBlock = await versionsFor([block.id], db);
  const v = displayVersion(block, byBlock.get(block.id) ?? []);
  if (!v) throw new Error(`Block '${slug}' has no published version`);
  return {
    blockId: block.id,
    blockVersionId: v.id,
    slug: block.slug,
    name: block.name,
    category: block.category,
    descriptor: v.descriptor,
  };
}
