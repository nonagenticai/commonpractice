// src/db/seed-flow-templates.ts — load the platform STARTER flow templates (src/templates/flow-seed/*.json)
// into `flow_templates` (0108) as global rows (tenant_id NULL), keyed by `seed_key`.
//
// ⛔ WHAT THE UPSERT MAY TOUCH. `ON CONFLICT (seed_key) WHERE tenant_id IS NULL` — the partial unique
// index — so the only rows it can ever reach are platform rows carrying a seed key this seeder owns.
// A tenant's template (tenant_id set) cannot conflict, and a starter a super_admin saved from a flow
// has no seed_key, so it cannot conflict either. That is the difference from the seeders that once
// overwrote real metering with `DO UPDATE`: the rows here are the seeder's own content, and updating
// them is how a corrected starter ships. `archived_at` is deliberately NOT in the update set, so a
// starter a platform admin removed stays removed on the next boot.
//
// The update is guarded by IS DISTINCT FROM, so a re-run with unchanged JSON writes nothing (no
// `updated_at` churn) — that is what "idempotent" means in tests/flow-templates.test.ts.
//
// ⛔ TRANSLATIONS ARE INSERT-IF-MISSING, never upserted. `content_translations` records no
// provenance — nothing tells a seeded cell from one a translator corrected (the translation editor
// and the queue drainer write the same table) — so an upsert would rewrite 56 rows per boot per
// replica AND silently revert any human correction. A corrected seed translation therefore ships as a
// migration (the 0076 precedent), not by editing the JSON and waiting for a boot.
//
// Seed graphs name blocks by SLUG only (blockId/blockVersionId are '' in the JSON). They are bound to
// real block rows when a reader uses the template (flow-templates/service.ts `rebindGraph`), so the
// seed does not depend on block ids, which differ per database.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eq, isNull, and, sql } from 'drizzle-orm';
import { db, flowTemplates, contentTranslations } from './client';
import type { FlowGraph, FlowNode } from './flow-types';
import { FLOW_TEMPLATE_I18N, deriveBlockSlugs } from '../flow-templates/service';

const DIR = path.join(import.meta.dir, '..', 'templates', 'flow-seed');

interface SeedNode extends Omit<FlowNode, 'blockId' | 'blockVersionId' | 'label'> {
  label?: string;
}
export interface FlowSeedFile {
  seed_key: string;
  category: string;
  name: string;
  description: string;
  i18n: Record<string, { name: string; description: string }>;
  graph: { nodes: SeedNode[]; edges: FlowGraph['edges'] };
}

export function loadFlowSeedFiles(): FlowSeedFile[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as FlowSeedFile);
}

export function seedGraph(file: FlowSeedFile): FlowGraph {
  return {
    nodes: file.graph.nodes.map((n) => ({ ...n, label: n.label ?? '', blockId: '', blockVersionId: '' })),
    edges: file.graph.edges,
  };
}

export async function seedFlowTemplates(): Promise<{ total: number; created: number; updated: number; translations: number }> {
  // `translations` counts cells actually INSERTED (0 on a re-run), not cells the files carry.
  let created = 0;
  let updated = 0;
  let translations = 0;
  const files = loadFlowSeedFiles();
  for (const file of files) {
    const graph = seedGraph(file);
    const values = {
      tenant_id: null,
      seed_key: file.seed_key,
      name: file.name,
      description: file.description,
      category: file.category,
      graph,
      block_slugs: deriveBlockSlugs(graph),
    };
    const [before] = await db
      .select({ id: flowTemplates.id })
      .from(flowTemplates)
      .where(and(eq(flowTemplates.seed_key, file.seed_key), isNull(flowTemplates.tenant_id)));
    const written = await db
      .insert(flowTemplates)
      .values(values)
      .onConflictDoUpdate({
        target: flowTemplates.seed_key,
        targetWhere: sql`tenant_id IS NULL`,
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          category: sql`excluded.category`,
          graph: sql`excluded.graph`,
          block_slugs: sql`excluded.block_slugs`,
          updated_at: sql`now()`,
        },
        setWhere: sql`(flow_templates.name, flow_templates.description, flow_templates.category, flow_templates.graph, flow_templates.block_slugs)
          IS DISTINCT FROM (excluded.name, excluded.description, excluded.category, excluded.graph, excluded.block_slugs)`,
      })
      .returning({ id: flowTemplates.id });
    if (!before) created++;
    else if (written.length) updated++;
    const [row] = await db
      .select({ id: flowTemplates.id })
      .from(flowTemplates)
      .where(and(eq(flowTemplates.seed_key, file.seed_key), isNull(flowTemplates.tenant_id)));
    const cells = Object.entries(file.i18n ?? {}).flatMap(([locale, t]) => [
      { entity_type: FLOW_TEMPLATE_I18N, entity_id: row!.id, locale, field: 'name', value: t.name },
      { entity_type: FLOW_TEMPLATE_I18N, entity_id: row!.id, locale, field: 'description', value: t.description },
    ]);
    if (cells.length) {
      const inserted = await db
        .insert(contentTranslations)
        .values(cells)
        .onConflictDoNothing()
        .returning({ locale: contentTranslations.locale });
      translations += inserted.length;
    }
  }
  return { total: files.length, created, updated, translations };
}
