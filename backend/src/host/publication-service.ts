// Immutable publication/run manifest validation. A node may execute only a published version of
// the exact block identity written into the graph, and the parent block must remain visible and
// non-archived. Both solution submission and ordinary Build runs use this same boundary.
import { eq, inArray } from 'drizzle-orm';
import { db, blockVersions, buildingBlocks } from '../db/client';
import type { BlockVersion } from '../db/schema';
import type { FlowGraph } from '../db/flow-types';
import type { BlockDescriptor } from '../db/block-types';
import { unprocessable } from '../utils/http';

export interface PublishedBlockManifestEntry {
  nodeId: string;
  blockId: string;
  versionId: string;
  slug: string;
  descriptor: BlockDescriptor;
}

export interface ResolvedExecutableBlocks {
  versions: BlockVersion[];
  manifest: PublishedBlockManifestEntry[];
}

export async function resolveExecutableBlocks(graph: FlowGraph): Promise<ResolvedExecutableBlocks> {
  const nodes = graph.nodes.filter((node) => node.kind !== 'foreach');
  const versionIds = [...new Set(nodes.map((node) => node.blockVersionId))];
  if (!versionIds.length) return { versions: [], manifest: [] };

  const rows = await db
    .select({ version: blockVersions, block: buildingBlocks })
    .from(blockVersions)
    .innerJoin(buildingBlocks, eq(blockVersions.block_id, buildingBlocks.id))
    .where(inArray(blockVersions.id, versionIds));
  const byVersion = new Map(rows.map((row) => [row.version.id, row]));

  // ⛔ `blockSlug` IS PART OF THE REFUSAL, NOT DEBUG DECORATION. Every message below NAMES the
  // offending node or block, and the frontend replaces these English sentences with localized copy
  // (frontend/src/lib/api/error-message.ts `VALIDATION_MESSAGES`). A localized sentence that cannot
  // reach the name degrades "Block 'llm-summarize' is archived" into "a block in this flow" — on a
  // graph of up to 40 nodes (routes/solutions.ts `createSolutionSchema`), that is not actionable,
  // and it trades a named offender for an anonymous one. The ids already in this bag cannot fix it:
  // `nodeId` is `n_a1b2c3d4` and `blockId` is a uuid. The SLUG is what the author sees on canvas.
  //
  // ⚠️ The frontend treats an absent slug as "I cannot name it" and falls back to THIS sentence, so
  // an older API against a newer SPA degrades to the pre-existing English rather than to a blank.
  for (const node of nodes) {
    const row = byVersion.get(node.blockVersionId);
    if (!row) {
      throw unprocessable(
        'missing_block_version',
        `Block version '${node.blockVersionId}' is unavailable for node '${node.slug}'.`,
        { nodeId: node.id, blockId: node.blockId, versionId: node.blockVersionId, blockSlug: node.slug },
      );
    }
    if (row.version.block_id !== node.blockId || row.block.id !== node.blockId) {
      throw unprocessable(
        'block_version_mismatch',
        `Node '${node.slug}' pins a version that belongs to a different block.`,
        { nodeId: node.id, blockId: node.blockId, versionId: node.blockVersionId, blockSlug: node.slug },
      );
    }
    if (row.block.archived) {
      throw unprocessable(
        'block_archived',
        `Block '${row.block.slug}' is archived and cannot be published or run.`,
        { nodeId: node.id, blockId: node.blockId, versionId: node.blockVersionId, blockSlug: row.block.slug },
      );
    }
    if (
      row.version.published_at == null ||
      (row.version.status !== 'beta' && row.version.status !== 'stable')
    ) {
      throw unprocessable(
        'block_version_unpublished',
        `Version ${row.version.version} of '${row.block.slug}' has not passed the publish gate.`,
        { nodeId: node.id, blockId: node.blockId, versionId: node.blockVersionId, blockSlug: row.block.slug },
      );
    }
  }

  return {
    versions: [...new Map(rows.map((row) => [row.version.id, row.version])).values()],
    manifest: nodes.map((node) => {
      const row = byVersion.get(node.blockVersionId)!;
      return {
        nodeId: node.id,
        blockId: row.block.id,
        versionId: row.version.id,
        slug: row.block.slug,
        descriptor: row.version.descriptor,
      };
    }),
  };
}

export async function graphContentHash(graph: FlowGraph): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(graph));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
