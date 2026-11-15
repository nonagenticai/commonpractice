// src/ontology/data-block-compiler.ts — Phase 3: the PURE compiler that turns an ontology entity
// (+ its bound primary sample's dataset slug and column_map) into a runnable category='data' block.
//
// No DB, no I/O — entirely unit-testable. The DB-aware orchestration (resolve the entity, its
// primary sample, the mapping; persist + publish) lives in data-block-derivation.ts.
//
// SHAPE (per the P3 locked decisions):
//  • OUTPUTS = one scalar port PER ontology attribute (typed via mapOntologyType, carrying pii +
//    description) — the representative record (the FIRST projected row) — PLUS auxiliary `rows`
//    (json, the full projected rowset) + `count` (number) so a downstream foreach (P5) has a
//    rowset to iterate.
//  • INPUT = a single OPTIONAL `dataset`-typed `source` defaulted to the bound slug. The host
//    injects descriptor-default dataset slugs (run-controller), so the block reads its primary
//    sample out of the box; a developer can override the dataset via the node config panel.
//  • The source REFERENCES the dataset by slug (ctx.dataset) — no rows (and no PII) are baked into
//    source_ts; the host caps + PII-redacts on inject exactly as for any dataset-typed block.
import type { BlockDescriptor, FieldSpec, FieldType } from '../db/block-types';

export interface CompilerAttribute {
  name: string;
  type: string;
  pii: boolean;
  description: string | null;
}

export interface CompilerEntity {
  /** Reseed-stable natural key ("scope:industry:department:name") — provenance + deterministic slug. */
  key: string;
  name: string;
  label: string;
  description: string | null;
  attributes: CompilerAttribute[];
}

export interface DerivationInput {
  entity: CompilerEntity;
  /** The bound primary sample's dataset slug — the block's default data source. */
  datasetSlug: string;
  /** { datasetColumn: attributeName } from the sample's mapping; {} = identity passthrough. */
  columnMap: Record<string, string>;
}

export interface CompiledDataBlock {
  slug: string;
  name: string;
  description: string;
  category: 'data';
  descriptor: BlockDescriptor;
  source_ts: string;
}

/** Reserved auxiliary output ports (an attribute literally named these is rare; if it happens the
 *  attribute keeps the key and the run() still returns the same value shape). */
const ROWS_PORT = 'rows';
const COUNT_PORT = 'count';

/** Map an ontology attribute type (free-form text) → a block FieldType. Default 'json' accepts any
 *  scalar/structured value, so an unknown/custom type never produces an invalid port. */
export function mapOntologyType(type: string): FieldType {
  switch (type.trim().toLowerCase()) {
    case 'string':
    case 'text':
    case 'date':
    case 'datetime':
    case 'timestamp':
    case 'enum':
    case 'email':
    case 'phone':
    case 'url':
    case 'uuid':
      return 'string';
    case 'number':
    case 'integer':
    case 'int':
    case 'float':
    case 'decimal':
    case 'currency':
      return 'number';
    case 'boolean':
    case 'bool':
      return 'boolean';
    case 'string[]':
    case 'text[]':
      return 'string[]';
    case 'json':
    case 'object':
    case 'array':
      return 'json';
    default:
      return 'json';
  }
}

/** Deterministic kebab slug for a derived data block: `data-<slugified entity key>`, capped at 64. */
export function dataBlockSlug(entityKey: string): string {
  const body = entityKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const full = `data-${body || 'entity'}`;
  // Cap at the slug column's app limit; trim a trailing '-' a truncation could leave.
  return full.length <= 64 ? full : full.slice(0, 64).replace(/-+$/g, '');
}

export function compileDataBlock(input: DerivationInput): CompiledDataBlock {
  const { entity, datasetSlug, columnMap } = input;

  const outputs: Record<string, FieldSpec> = {};
  for (const a of entity.attributes) {
    const spec: FieldSpec = { type: mapOntologyType(a.type) };
    if (a.pii) spec.pii = true;
    if (a.description) spec.description = a.description;
    outputs[a.name] = spec;
  }
  // Auxiliary rowset ports (only if an attribute hasn't already claimed the name).
  if (!(ROWS_PORT in outputs)) outputs[ROWS_PORT] = { type: 'json', description: 'All projected sample rows.' };
  if (!(COUNT_PORT in outputs)) outputs[COUNT_PORT] = { type: 'number', description: 'Number of rows emitted.' };

  const descriptor: BlockDescriptor = {
    inputs: {
      source: {
        type: 'dataset',
        default: datasetSlug,
        description: "The entity's bound primary sample (override to load another dataset).",
      },
    },
    outputs,
    // ⛔ `dataset`, NOT `mockData` — AND THIS IS THE GENERATOR, SO IT IS THE WIDEST INSTANCE OF THE
    // DEFECT. `renderSource` below emits `await ctx.dataset(slug)` and nothing else; there is no
    // `ctx.mockData` call anywhere in a derived data block. It declared `mockData: true` only to
    // satisfy the executor's old shared gate. Every block this compiler has ever produced — the
    // three seeded `example-*-data` blocks AND every block a tenant derives from an ontology entity
    // at run time (data-block-derivation.ts) — reads that tenant's REAL bound dataset, so badging
    // them "Simulated" off this flag mislabels real customer data. See db/block-types.ts.
    capabilities: { network: false, dataset: true },
  };

  const description = entity.description?.trim()
    ? entity.description.trim()
    : `Sample data for the ${entity.label} entity.`;

  return {
    slug: dataBlockSlug(entity.key),
    name: `${entity.label} data`,
    description,
    category: 'data',
    descriptor,
    source_ts: renderSource(entity, datasetSlug, columnMap, descriptor),
  };
}

/** The block module source. Reads the dataset by slug (host-injected), applies the frozen column_map
 *  projection, and emits the per-attribute first-row scalars + the full `rows` + `count`. */
function renderSource(
  entity: CompilerEntity,
  datasetSlug: string,
  columnMap: Record<string, string>,
  descriptor: BlockDescriptor,
): string {
  const attrReturns = entity.attributes
    .map((a) => `      ${JSON.stringify(a.name)}: first[${JSON.stringify(a.name)}] ?? null,`)
    .join('\n');
  return `// Derived data block — generated from ontology entity ${JSON.stringify(entity.key)}.
// Edit the ontology entity + its primary sample and re-derive rather than hand-editing this.
export default {
  descriptor: ${JSON.stringify(descriptor)},
  async run(inputs, ctx) {
    const COLMAP = ${JSON.stringify(columnMap)};
    const slug = (inputs && typeof inputs.source === 'string' && inputs.source)
      ? inputs.source
      : ${JSON.stringify(datasetSlug)};
    const raw = await ctx.dataset(slug);
    const project = (r) => {
      const keys = Object.keys(COLMAP);
      if (keys.length === 0) return r;
      const o = {};
      for (const k of keys) { if (k in r) o[COLMAP[k]] = r[k]; }
      return o;
    };
    const rows = Array.isArray(raw) ? raw.map(project) : [];
    const first = rows[0] || {};
    ctx.log('info', 'entity data emitted', { entity: ${JSON.stringify(entity.name)}, slug: slug, count: rows.length });
    return {
${attrReturns}${attrReturns ? '\n' : ''}      rows: rows,
      count: rows.length,
    };
  },
};
`;
}
