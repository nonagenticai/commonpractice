// src/db/boot-seeds.ts — the product-content seeds that run at EVERY boot, independent of
// SEED_DEMO_DATA (false in prod). server.ts calls `runBootSeeds()` once after migrations.
//
// ⛔ WHY THIS IS A NAMED STEP AND NOT INLINE IN server.ts: CI seeds through `bun run seed`
// (seedAll), never through server.ts, so a boot seed deleted from server.ts kept CI green while prod
// silently stopped getting it. tests/boot-seeds.test.ts runs this function AND asserts server.ts
// calls it.
//
// Each step is best-effort: a failure is logged and the next step still runs; the server comes up.
import { runAsSystem } from './client';
import { log } from '../host/logger';
import { seedFlowTemplates } from './seed-flow-templates';
import { seedBlockPortLabels } from './seed-block-port-labels';

export interface BootSeedResult {
  flowTemplates: Awaited<ReturnType<typeof seedFlowTemplates>> | 'failed';
  blockPortLabels: Awaited<ReturnType<typeof seedBlockPortLabels>> | 'failed';
}

export async function runBootSeeds(): Promise<BootSeedResult> {
  // The platform STARTER flow templates (0108): without them the builder's "Pick a template" gallery
  // is empty in prod. The upsert can reach only platform rows that carry a seed_key (see
  // seed-flow-templates.ts), and a starter whose blocks are absent on this database is shown as
  // unavailable, never broken.
  let flowTemplates: BootSeedResult['flowTemplates'] = 'failed';
  try {
    flowTemplates = await runAsSystem('boot-seed', () => seedFlowTemplates());
  } catch (err) {
    log.error('flow_template_seed_failed', { component: 'server', err });
  }

  // Port labels of the platform blocks (content_translations `block_port`), in all 8 locales.
  // INSERT-IF-MISSING: an existing row — including one a translator corrected — is never rewritten
  // (seed-block-port-labels.ts).
  let blockPortLabels: BootSeedResult['blockPortLabels'] = 'failed';
  try {
    blockPortLabels = await runAsSystem('boot-seed', () => seedBlockPortLabels());
  } catch (err) {
    log.error('block_port_label_seed_failed', { component: 'server', err });
  }

  return { flowTemplates, blockPortLabels };
}
