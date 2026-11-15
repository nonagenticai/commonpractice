// src/db/seed.ts — faithful reproduction of the 12 demo building blocks
// (demo.html:3442–3685). Idempotent (`bun run seed` is safe to re-run): blocks
// are matched by slug and skipped if present. Each version carries REAL TS source
// conforming to the SPEC §5 SDK contract so Session 3's runner can execute them.
import { and, eq, isNull } from 'drizzle-orm';
import { db, closeConnection, runAsSystem, buildingBlocks, blockVersions, users } from './client';
import type { BlockCategory, BlockDescriptor } from './block-types';
import { seedOps } from './seed-ops';
// ⛔ The seeders write `published`/`stable` versions that no lint had ever seen. `source_ts` is now
// branded (db/schema.ts) so these calls are not optional — a seed source that trips the safety scan
// fails `bun run seed`, which is where a bad shipped example belongs: in CI, not in a tenant's DB.
import { requireScannedSource } from '../blocks/source-gate';
import { seedMarketplace } from './seed-marketplace';
import { seedMarketplaceI18n } from './seed-marketplace-i18n';
import { seedPlatform, ensureDemoTenant } from './seed-platform';
import { seedAi } from './seed-ai';
import { seedDatasets, seedEntitySamples } from './seed-datasets';
import { seedExampleBlocks } from './seed-example-blocks';
import { seedTemplates } from './seed-templates';
import { seedFlowTemplates } from './seed-flow-templates';
import { seedBlockPortLabels } from './seed-block-port-labels';
import { seedOntology } from './seed-ontology';
import { seedOntologyI18n } from './seed-ontology-i18n';
import { seedOntologyTenant } from './seed-ontology-tenant';
import { seedTenantShowcase } from './seed-tenant-showcase';
import { config } from '../config';
import { log } from '../host/logger';

interface SeedMaintainer {
  key: string;
  name: string;
  email: string;
  initials: string;
}

const MAINTAINERS: SeedMaintainer[] = [
  { key: 'mo', name: 'Mo Hassan', email: 'mo@commonpractice.local', initials: 'MO' },
  { key: 'tk', name: 'Tom Kemper', email: 'tom@commonpractice.local', initials: 'TK' },
  { key: 'pj', name: 'Peter Janssen', email: 'peter@commonpractice.local', initials: 'PJ' },
  { key: 'hv', name: 'Hannah Vos', email: 'hannah@commonpractice.local', initials: 'HV' },
];

interface SeedBlock {
  slug: string;
  name: string;
  description: string;
  category: BlockCategory;
  version: string;
  status: 'beta' | 'stable';
  usage: number;
  region: string;
  cost_class: string;
  descriptor: BlockDescriptor;
  source: string;
  docs: string;
}

const src = (body: string) => `export default {\n${body}\n};\n`;

/** Look up a seeded block's runnable source + descriptor by slug (test/seed helpers). */
export function getSeedBlock(slug: string): { source: string; descriptor: BlockDescriptor; category: BlockCategory } {
  const b = BLOCKS.find((x) => x.slug === slug);
  if (!b) throw new Error(`getSeedBlock: no seeded block '${slug}'`);
  return { source: b.source, descriptor: b.descriptor, category: b.category };
}

const BLOCKS: SeedBlock[] = [
  {
    slug: 'read-claim-form',
    name: 'Read claim form',
    description:
      // ⛔ THE SECOND BLOCK THAT PROMISED A PARSER IT DOES NOT HAVE. It read "Parses claim PDFs
      // (typed or scanned). Auto-OCRs when needed." — but `run()` never opens `inputs.file`; it
      // asks `ctx.mockData("claim_pdf", …)` for fixture pages, and `ocr_used` is computed from the
      // fixture's own `scanned` flag, so even that boolean is a property of the sample rather than
      // of any document. Same class as `ocr-scan` below; corrected in the same change, with its 7
      // locale rows in migrations/0076_ocr_block_honest_copy.sql.
      'Demonstration block. Returns deterministic sample claim-form pages from ctx.mockData — no PDF is opened and no OCR engine runs; `ocr_used` reports the sample’s own flag.',
    category: 'data',
    version: '2.3.0',
    status: 'stable',
    usage: 1240,
    region: 'eu-west',
    cost_class: 'low',
    descriptor: {
      inputs: {
        file: { type: 'json', required: true, description: 'PDF file reference' },
        force_ocr: { type: 'boolean', description: 'Force OCR even for typed PDFs' },
      },
      outputs: {
        text: { type: 'string' },
        pages: { type: 'json' },
        ocr_used: { type: 'boolean' },
      },
      capabilities: { network: false, mockData: true },
    },
    docs: '# read-claim-form\n\nDemonstration block. Returns deterministic sample claim-form pages from `ctx.mockData("claim_pdf")`; the `file` input is used only as the fixture key. No PDF is opened and no OCR engine runs.\n\n**Returns** `text`, `pages`, and `ocr_used` — where `ocr_used` is the sample’s own `scanned` flag (or `force_ocr`), not a measurement of any document.',
    source: src(`  descriptor: {
    inputs: { file: { type: "json", required: true }, force_ocr: { type: "boolean" } },
    outputs: { text: { type: "string" }, pages: { type: "json" }, ocr_used: { type: "boolean" } },
    capabilities: { network: false, mockData: true },
  },
  async run(inputs, ctx) {
    const doc = await ctx.mockData("claim_pdf", { ref: inputs.file });
    const needsOcr = Boolean(inputs.force_ocr) || doc.scanned;
    const pages = doc.pages;
    const text = pages.map((p) => p.text).join("\\n");
    ctx.log("info", "parsed claim form", { pages: pages.length, ocr: needsOcr });
    return { text, pages, ocr_used: needsOcr };
  }`),
  },
  {
    slug: 'ai-summarize',
    name: 'Summarize with AI',
    description:
      'Calls the configured LLM to produce a length-controlled summary. Configurable: tone, max lines, language.',
    category: 'ai',
    version: '3.1.0',
    status: 'stable',
    usage: 1082,
    region: 'eu-west',
    cost_class: 'medium',
    descriptor: {
      inputs: {
        text: { type: 'string', required: true },
        max_lines: { type: 'number' },
        tone: { type: 'enum', enum: ['neutral', 'formal', 'friendly'] },
      },
      outputs: { summary: { type: 'string' } },
      capabilities: { network: false, llm: true },
    },
    docs: '# ai-summarize\n\nProduces a length-controlled summary via the configured LLM. Configure `tone` and `max_lines`.',
    source: src(`  descriptor: {
    inputs: { text: { type: "string", required: true }, max_lines: { type: "number" }, tone: { type: "enum", enum: ["neutral", "formal", "friendly"] } },
    outputs: { summary: { type: "string" } },
    capabilities: { network: false, llm: true },
  },
  async run(inputs, ctx) {
    const tone = inputs.tone ?? "neutral";
    const max = inputs.max_lines ?? 5;
    const res = await ctx.llm({ prompt: \`Summarize in a \${tone} tone, max \${max} lines:\\n\\n\${inputs.text}\` });
    return { summary: res.text };
  }`),
  },
  {
    slug: 'extract-fields',
    name: 'Extract fields',
    description:
      'Uses AI to pull named fields out of a document and marks each field as found or not found.',
    category: 'ai',
    version: '1.8.0',
    status: 'stable',
    usage: 892,
    region: 'eu-west',
    cost_class: 'medium',
    descriptor: {
      inputs: {
        document: { type: 'string', required: true },
        fields: { type: 'string[]', required: true },
      },
      outputs: { values: { type: 'json' }, confidence: { type: 'json' } },
      capabilities: { network: false, llm: true },
    },
    docs: '# extract-fields\n\nExtracts the requested `fields` from a `document`, returning values + per-field confidence.',
    source: src(`  descriptor: {
    inputs: { document: { type: "string", required: true }, fields: { type: "string[]", required: true } },
    outputs: { values: { type: "json" }, confidence: { type: "json" } },
    capabilities: { network: false, llm: true },
  },
  async run(inputs, ctx) {
    const res = await ctx.llm({ prompt: \`Extract fields \${inputs.fields.join(", ")} as JSON from:\\n\${inputs.document}\` });
    const values = JSON.parse(res.text);
    const confidence = Object.fromEntries(inputs.fields.map((f) => [f, values[f] == null ? 0 : 0.9]));
    return { values, confidence };
  }`),
  },
  {
    slug: 'lookup-policy',
    name: 'Look up policy',
    description:
      'Demonstration block. Looks up a policy in the sample data and returns its coverage and deductible.',
    category: 'data',
    version: '4.0.0',
    status: 'stable',
    usage: 671,
    region: 'eu-west',
    cost_class: 'low',
    descriptor: {
      inputs: { policy_id: { type: 'string', required: true } },
      outputs: { coverage: { type: 'json' }, deductible: { type: 'number' } },
      capabilities: { network: false, mockData: true },
    },
    docs: '# lookup-policy\n\nLooks up a policy in the sandboxed insurance dataset. Returns `coverage` + `deductible`.',
    source: src(`  descriptor: {
    inputs: { policy_id: { type: "string", required: true } },
    outputs: { coverage: { type: "json" }, deductible: { type: "number" } },
    capabilities: { network: false, mockData: true },
  },
  async run(inputs, ctx) {
    const policy = await ctx.mockData("policy", { id: inputs.policy_id });
    return { coverage: policy.coverage, deductible: policy.deductible };
  }`),
  },
  {
    slug: 'flag-anomalies',
    name: 'Flag anomalies',
    description:
      'Flags the records whose score, positive or negative, reaches a set threshold.',
    category: 'logic',
    version: '2.0.0',
    status: 'beta',
    usage: 512,
    region: 'eu-west',
    cost_class: 'medium',
    descriptor: {
      inputs: {
        records: { type: 'json', required: true },
        threshold: { type: 'number' },
      },
      outputs: { flagged: { type: 'json' } },
      capabilities: { network: false, llm: true },
    },
    docs: '# flag-anomalies\n\nFlags outlier records. Threshold mode is deterministic; LLM mode judges ambiguous rows.',
    source: src(`  descriptor: {
    inputs: { records: { type: "json", required: true }, threshold: { type: "number" } },
    outputs: { flagged: { type: "json" } },
    capabilities: { network: false, llm: true },
  },
  async run(inputs, ctx) {
    const threshold = inputs.threshold ?? 3;
    const flagged = inputs.records.filter((r) => Math.abs(r.score ?? 0) >= threshold);
    ctx.log("info", "flagged anomalies", { count: flagged.length });
    return { flagged };
  }`),
  },
  {
    slug: 'format-output',
    name: 'Format output',
    description:
      'Prepares text as plain Markdown, a simple HTML paragraph or a Slack message.',
    category: 'output',
    version: '1.4.0',
    status: 'stable',
    usage: 470,
    region: 'eu-west',
    cost_class: 'low',
    descriptor: {
      inputs: {
        content: { type: 'string', required: true },
        format: { type: 'enum', enum: ['markdown', 'html', 'slack', 'note'] },
      },
      outputs: { rendered: { type: 'string' } },
      capabilities: { network: false },
    },
    docs: '# format-output\n\nRenders `content` to markdown, HTML email, a case-file note, or a Slack message.',
    source: src(`  descriptor: {
    inputs: { content: { type: "string", required: true }, format: { type: "enum", enum: ["markdown", "html", "slack", "note"] } },
    outputs: { rendered: { type: "string" } },
    capabilities: { network: false },
  },
  async run(inputs) {
    const fmt = inputs.format ?? "markdown";
    if (fmt === "html") return { rendered: \`<p>\${inputs.content}</p>\` };
    if (fmt === "slack") return { rendered: \`:memo: \${inputs.content}\` };
    return { rendered: inputs.content };
  }`),
  },
  {
    // ⛔ THE COPY BELOW USED TO ADVERTISE AN OCR ENGINE THIS BLOCK DOES NOT HAVE.
    // It named a third-party OCR engine and called itself a hybrid of it while `run()` is one line —
    // `ctx.mockData("scan", …)` — which returns "Scanned document text (sample N). Lorem ipsum
    // dolor sit amet." (exec/mock-data.ts). A demo reader ran it, got Lorem ipsum, and had nothing
    // on screen telling them it was a fixture: neither the card, nor the palette, nor the run
    // output said so. Both halves are fixed, and they are separate fixes:
    //   * the GENERIC half — any descriptor declaring `capabilities.mockData` now renders a
    //     "Simulated" badge on the catalogue card, the build palette, the canvas node and the run
    //     output (frontend `block_simulated_badge`), so a block added tomorrow is labelled without
    //     anyone remembering to write prose about it; and
    //   * the SPECIFIC half — this block's own name/description/docs, which claimed a named
    //     third-party engine and a publication story. A badge does not repair a sentence that
    //     states a falsehood.
    // ⚠️ `slug` DOES NOT CHANGE. It is a stable identifier: seed-marketplace.ts's SOLUTIONS
    // (`blocksUsed`) and seed-tenant-showcase.ts both reference `ocr-scan` by name, and
    // `SEED_CATALOG_BLOCK_SLUGS` is derived from this list. Only the display prose moves.
    // ⚠️ The 7 non-`en` `name`/`description`/`docs_md` rows migration 0073 promoted into git carry
    // the SAME claim in seven languages; correcting only this literal would leave a Dutch reader
    // still reading the retracted engine claim in Dutch. They are corrected together, in
    // migrations/0076_ocr_block_honest_copy.sql.
    slug: 'ocr-scan',
    name: 'OCR scan (sample)',
    description:
      'Demonstration block. Returns deterministic sample document text from ctx.mockData — no OCR engine runs and the image is never opened.',
    category: 'data',
    version: '1.2.0',
    status: 'stable',
    usage: 94,
    region: 'eu-west',
    cost_class: 'medium',
    descriptor: {
      inputs: { image: { type: 'json', required: true } },
      outputs: { text: { type: 'string' } },
      capabilities: { network: false, mockData: true, llm: true },
    },
    docs: '# ocr-scan\n\nDemonstration block. Returns deterministic sample text from `ctx.mockData("scan")`; the `image` input is used only as the fixture key. No OCR engine runs and nothing is read from the image.',
    source: src(`  descriptor: {
    inputs: { image: { type: "json", required: true } },
    outputs: { text: { type: "string" } },
    capabilities: { network: false, mockData: true, llm: true },
  },
  async run(inputs, ctx) {
    const scan = await ctx.mockData("scan", { ref: inputs.image });
    return { text: scan.text };
  }`),
  },
  {
    slug: 'classify',
    name: 'Classify text',
    description:
      'Uses AI to sort text into one of a fixed list of labels, with a confidence and a short reason.',
    category: 'ai',
    version: '2.7.0',
    status: 'stable',
    usage: 388,
    region: 'eu-west',
    cost_class: 'medium',
    descriptor: {
      inputs: {
        text: { type: 'string', required: true },
        labels: { type: 'string[]', required: true },
      },
      outputs: {
        label: { type: 'string' },
        confidence: { type: 'number' },
        reasoning: { type: 'string' },
      },
      capabilities: { network: false, llm: true },
    },
    docs: '# classify\n\nClassifies `text` into one of `labels`, with confidence + reasoning.',
    source: src(`  descriptor: {
    inputs: { text: { type: "string", required: true }, labels: { type: "string[]", required: true } },
    outputs: { label: { type: "string" }, confidence: { type: "number" }, reasoning: { type: "string" } },
    capabilities: { network: false, llm: true },
  },
  async run(inputs, ctx) {
    const res = await ctx.llm({ prompt: \`Classify into one of [\${inputs.labels.join(", ")}]. Reply JSON {label, confidence, reasoning}:\\n\${inputs.text}\` });
    return JSON.parse(res.text);
  }`),
  },
  {
    slug: 'if-else',
    name: 'If / else',
    description:
      'Picks one of two values depending on whether a condition is true.',
    category: 'logic',
    version: '1.1.0',
    status: 'stable',
    usage: 342,
    region: 'eu-west',
    cost_class: 'low',
    descriptor: {
      inputs: {
        condition: { type: 'boolean', required: true },
        if_true: { type: 'json' },
        if_false: { type: 'json' },
      },
      outputs: { result: { type: 'json' } },
      capabilities: { network: false },
    },
    docs: '# if-else\n\nReturns `if_true` or `if_false` based on `condition`.',
    source: src(`  descriptor: {
    inputs: { condition: { type: "boolean", required: true }, if_true: { type: "json" }, if_false: { type: "json" } },
    outputs: { result: { type: "json" } },
    capabilities: { network: false },
  },
  async run(inputs) {
    return { result: inputs.condition ? inputs.if_true : inputs.if_false };
  }`),
  },
  {
    slug: 'review-panel',
    name: 'Review panel',
    description:
      'Demonstration block. Returns a sample accept, edit or reject decision in place of a review by a person.',
    category: 'output',
    version: '1.0.0',
    status: 'stable',
    usage: 287,
    region: 'eu-west',
    cost_class: 'low',
    descriptor: {
      inputs: { item: { type: 'json', required: true } },
      outputs: {
        decision: { type: 'enum', enum: ['accept', 'edit', 'reject'] },
        edited: { type: 'json' },
      },
      // ⛔ `mockData: true` IS NOT A WIDENING HERE, IT IS THE CORRECTION OF A LIE OF OMISSION.
      // This block's `run()` is one line: `await ctx.mockData("review_decision", …)`. The descriptor
      // declared `{ network: false }` and nothing else, so `exec/flow-executor.ts`'s `ctx.mockData`
      // gate threw `capability_missing_mock_data` on EVERY run — and because `category: 'output'`
      // makes this a terminal node, a flow containing it could never finish. The repo had been
      // routing around it rather than fixing it (see the comment this change deletes above
      // LISA_FLOW_SLUGS in seed-marketplace.ts) while `seed-marketplace.ts` kept listing the slug
      // in a solution's `blocksUsed`, so the catalogue advertised a block that could not run.
      //
      // ⚠️ AND THE BIT IS USER-VISIBLE COPY, WHICH IS THE POINT — 0077's header explains that
      // `capabilities.mockData` is a FABRICATION CLAIM: `routes/blocks.ts` projects it as
      // `mock_data` and the browser renders the "Simulated" badge from it, and
      // `host/run-policy.ts` reads it as the entire taint-by-source test for `data.pii_scrubbing`.
      // For THIS block both readings are correct and wanted. `exec/mock-data.ts`'s
      // `review_decision` case picks accept/edit/reject off a seeded counter; no human ever sees
      // the item. The decision this block returns genuinely is fabricated, so it should say so on
      // the card and it should count as a mock source at the PII gate. Contrast `load-dataset`,
      // which 0077 had to strip this bit FROM because it returns the tenant's real rows.
      capabilities: { network: false, mockData: true },
    },
    docs: '# review-panel\n\nHuman-in-the-loop accept / edit / reject step.',
    source: src(`  descriptor: {
    inputs: { item: { type: "json", required: true } },
    outputs: { decision: { type: "enum", enum: ["accept", "edit", "reject"] }, edited: { type: "json" } },
    capabilities: { network: false, mockData: true },
  },
  async run(inputs, ctx) {
    const decision = await ctx.mockData("review_decision", { item: inputs.item });
    return { decision: decision.kind, edited: decision.edited ?? inputs.item };
  }`),
  },
  {
    slug: 'compare-docs',
    name: 'Compare documents',
    description:
      'Uses AI to show what changed in meaning between two documents. Useful for contract changes and policy renewals.',
    category: 'ai',
    version: '0.9.0',
    status: 'beta',
    usage: 142,
    region: 'eu-west',
    cost_class: 'medium',
    descriptor: {
      inputs: {
        doc_a: { type: 'string', required: true },
        doc_b: { type: 'string', required: true },
      },
      outputs: { diff: { type: 'json' } },
      capabilities: { network: false, llm: true },
    },
    docs: '# compare-docs\n\nSemantic diff of two documents with an audit trail.',
    source: src(`  descriptor: {
    inputs: { doc_a: { type: "string", required: true }, doc_b: { type: "string", required: true } },
    outputs: { diff: { type: "json" } },
    capabilities: { network: false, llm: true },
  },
  async run(inputs, ctx) {
    const res = await ctx.llm({ prompt: \`Semantic diff as JSON between A and B.\\nA:\\n\${inputs.doc_a}\\nB:\\n\${inputs.doc_b}\` });
    return { diff: JSON.parse(res.text) };
  }`),
  },
  {
    slug: 'read-customer-record',
    name: 'Read customer record',
    description:
      'Demonstration block. Returns a customer’s details from the sample data.',
    category: 'data',
    version: '3.4.0',
    status: 'stable',
    usage: 412,
    region: 'eu-west',
    cost_class: 'low',
    descriptor: {
      inputs: { customer_id: { type: 'string', required: true } },
      outputs: { record: { type: 'json', pii: true } },
      capabilities: { network: false, mockData: true },
    },
    docs: '# read-customer-record\n\nLooks up a customer record from mock data. Output is PII — stays in the sandbox.',
    source: src(`  descriptor: {
    inputs: { customer_id: { type: "string", required: true } },
    outputs: { record: { type: "json", pii: true } },
    capabilities: { network: false, mockData: true },
  },
  async run(inputs, ctx) {
    const record = await ctx.mockData("customer", { id: inputs.customer_id });
    return { record };
  }`),
  },
];

/** The slugs this file seeds as GLOBAL blocks. Single source for blocks/seeded-global-blocks.ts —
 *  never hand-copy this list. */
export const SEED_CATALOG_BLOCK_SLUGS: readonly string[] = BLOCKS.map((b) => b.slug);

async function ensureMaintainers(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const m of MAINTAINERS) {
    const [existing] = await db.select().from(users).where(eq(users.email, m.email));
    if (existing) {
      ids.set(m.key, existing.id);
      continue;
    }
    const [created] = await db
      .insert(users)
      .values({
        email: m.email,
        name: m.name,
        avatar_initials: m.initials,
        role: 'platform',
      })
      .returning();
    ids.set(m.key, created!.id);
  }
  return ids;
}

export async function seed(): Promise<{ created: number; skipped: number }> {
  // The seeded people still exist (demo-tenant seeders own datasets as tom@…), but they are NOT
  // the authors of platform blocks. A GLOBAL block is shipped by the platform: `maintainer_id` and
  // `published_by` stay NULL, which every surface renders as "CommonPractice". Crediting an
  // invented person here showed "Tom Kemper" — a real person's name — to every tenant, including a
  // brand-new external org. Prod rows corrected by migrations/0116.
  await ensureMaintainers();
  let created = 0;
  let skipped = 0;

  for (const b of BLOCKS) {
    // ⛔ GLOBAL-SCOPED, and this one failed the INVERSE way to seed-example-blocks.ts's lookup.
    // Unscoped, a TENANT block that happens to carry this slug matched, the loop counted it as
    // `skipped`, and the GLOBAL block this seeder exists to create was then never created at all —
    // a tenant row silently suppressing a platform row, and `skipped++` reporting it as a healthy
    // no-op. (It is the mirror of the write-side bug: there the platform seeder overwrote a tenant
    // row, here a tenant row deletes a platform row from existence.) The INSERT below leaves
    // `tenant_id` at its NULL default, so the predicate covers exactly what this loop can create.
    // Same predicate as blocks/authoring-service.ts:162's global-dup check.
    const [existing] = await db
      .select({ id: buildingBlocks.id })
      .from(buildingBlocks)
      .where(and(eq(buildingBlocks.slug, b.slug), isNull(buildingBlocks.tenant_id)));
    if (existing) {
      skipped++;
      continue;
    }

    await db.transaction(async (tx) => {
      const [block] = await tx
        .insert(buildingBlocks)
        .values({
          slug: b.slug,
          name: b.name,
          description: b.description,
          category: b.category,
          maintainer_id: null,
          region: b.region,
          cost_class: b.cost_class,
          license: 'internal',
        })
        .returning();
      const [version] = await tx
        .insert(blockVersions)
        .values({
          block_id: block!.id,
          version: b.version,
          status: b.status,
          docs_md: b.docs,
          source_ts: requireScannedSource(b.source),
          descriptor: b.descriptor,
          examples: [],
          tests_passing: true,
          usage_count: b.usage,
          published_by: null,
          published_at: new Date(),
        })
        .returning();
      await tx
        .update(buildingBlocks)
        .set({ current_version_id: version!.id })
        .where(eq(buildingBlocks.id, block!.id));
    });
    created++;
  }

  return { created, skipped };
}

/**
 * Run the full idempotent seed (blocks + ops + marketplace + platform + ai).
 * Safe to call repeatedly — every sub-seed matches on slug/email and skips/updates
 * existing rows. Does NOT close the DB connection (the caller owns its lifecycle),
 * so it is safe to invoke from the server boot path as well as the CLI.
 */
export async function seedAll(): Promise<void> {
  // D.1.1: the demo tenant must exist before any tenant-scoped sub-seed stamps it (FK + the 0029
  // NOT NULL). seedTenants (in seedPlatform) later sets users.tenant_id + the demo extras.
  await ensureDemoTenant();
  const result = await seed();
  log.info('seed_blocks_done', { component: 'seed', created: result.created, skipped: result.skipped });
  const ops = await seedOps();
  log.info('seed_ops_done', { component: 'seed', users: ops.users, sandboxes: ops.sandboxes, runs: ops.runs });
  const market = await seedMarketplace();
  log.info('seed_marketplace_done', { component: 'seed', challenges: market.challenges, solutions: market.solutions, winners: market.winners });
  const i18n = await seedMarketplaceI18n();
  log.info('seed_marketplace_i18n_done', { component: 'seed', rows: i18n.rows, locales: 7 });
  const platform = await seedPlatform();
  log.info('seed_platform_done', { component: 'seed', policies: platform.policies, pipeline: platform.pipeline, audit: platform.audit });
  log.info('seed_platform_tenants_done', { component: 'seed', tenants: platform.tenants, usageEvents: platform.usageEvents });
  const ai = await seedAi();
  log.info('seed_ai_done', { component: 'seed', prompts: ai.prompts, settings: ai.settings });
  const ds = await seedDatasets();
  log.info('seed_datasets_done', { component: 'seed', datasets: ds.datasets, blocks: ds.block, flows: ds.flow, tests: ds.tests });
  const onto = await seedOntology();
  log.info('seed_ontology_done', { component: 'seed', entities: onto.entities, attributes: onto.attributes, relations: onto.relations });
  const ontoI18n = await seedOntologyI18n();
  log.info('seed_ontology_i18n_done', { component: 'seed', rows: ontoI18n.rows, locales: 7 });
  const ontoTenant = await seedOntologyTenant();
  log.info('seed_ontology_tenant_override_done', { component: 'seed', entities: ontoTenant.entities, relations: ontoTenant.relations, tenant: ontoTenant.tenant ?? 'none' });
  // Wave A: realistic example blocks of all 5 categories (needs ontology + datasets seeded above).
  const examples = await seedExampleBlocks();
  log.info('seed_example_blocks_done', { component: 'seed', blocks: examples.blocks, datasets: examples.datasets, flows: examples.flows });
  // Last: bind demo test data to ontology entities.
  // ⛔ MUST RUN AFTER `seedExampleBlocks`, NOT BEFORE. `seedEntitySamples` binds every demo dataset
  // that `seedExampleBlocks` has written a confirmed mapping for; run first, it queries for those
  // mappings before they exist and binds only `sample-claims`.
  //
  // ⚠️ WHAT THIS BUYS, MEASURED — because an earlier version of this comment claimed more. On a
  // FRESH database, before: 1 binding, 0 with a mapping. After: 4 bindings, 3 mapped. On the SECOND
  // boot both orders reach 4/3, since the mappings written by boot #1 are there by the time boot #2
  // binds. So the reorder converts "dead until the next pod boot" into "live on the first boot" —
  // real, worth keeping, and NOT "the reason the seed could never link anything". That was
  // read-time mapping resolution (ontology/sample-service.ts + datasets/ontology-validation.ts).
  // Pinned by tests/seed-first-boot-order.test.ts, which seeds a throwaway database to see boot #1;
  // every other test runs against an already-seeded one, where this defect is invisible.
  const samples = await seedEntitySamples();
  log.info('seed_entity_samples_done', { component: 'seed', bound: samples.bound });
  // Block-template starter catalog (logic/ui/ai). Self-contained; global rows; idempotent.
  const templates = await seedTemplates();
  log.info('seed_templates_done', { component: 'seed', created: templates.created, total: templates.total });
  // Starter FLOW templates (0108). Global rows keyed by seed_key; blocks are bound by slug at use time,
  // so order relative to the block seeders above does not matter. Also run at every boot (server.ts).
  const flowTemplatesSeeded = await seedFlowTemplates();
  log.info('seed_flow_templates_done', { component: 'seed', ...flowTemplatesSeeded });
  // Port labels for the global blocks above (insert-if-missing; also run at every boot, server.ts).
  const portLabels = await seedBlockPortLabels();
  log.info('seed_block_port_labels_done', { component: 'seed', ...portLabels });

  // Optional single-tenant showcase (env-gated; OFF in CI so the deterministic
  // count-asserting route tests don't see its extra rows). Runs after the base catalogue
  // so its flows can resolve the global blocks. Re-running refreshes the time-relative
  // IT-dashboard rows (today's usage + last-24h runs) on each boot.
  if (config.seedTenantShowcase) {
    const sc = await seedTenantShowcase(config.tenantShowcaseId);
    log.info('seed_tenant_showcase_done', {
      component: 'seed',
      tenantId: sc.tenantId,
      members: sc.members,
      challengesCreated: sc.challengesCreated,
      solutionsCreated: sc.solutionsCreated,
      runs: sc.runs,
      sandboxes: sc.sandboxes,
      winnerWeek: sc.winnerWeek,
    });
  }
}

if (import.meta.main) {
  // Seed is a SYSTEM operation (owner pool, bypasses RLS) — see seedAll's use in server.ts.
  await runAsSystem('boot-seed', () => seedAll());
  await closeConnection();
  process.exit(0);
}
