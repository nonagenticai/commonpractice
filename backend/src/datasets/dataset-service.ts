// src/datasets/dataset-service.ts — dataset persistence + read helpers shared by the
// routes, the seed CLI, and the run-controller injection path. Keeps the SQL/caps/
// PII logic in one place so the REST surface, the seeder, and the runner stay
// consistent. Rows are stored one-per-idx in dataset_rows (JSONB), loaded back as a
// capped, optionally PII-redacted {columns, rows} for the runner init frame.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db as defaultDb, datasets, datasetRows } from '../db/client';
import type { Dataset } from '../db/schema';
import {
  type DatasetColumn,
  type DatasetSourceType,
  type InjectedDataset,
  type ParsedDataset,
  DATASET_INJECT_ROW_CAP,
  PII_REDACTION,
} from '../db/dataset-types';
import { byteSize } from './parse/infer';

type Db = typeof defaultDb;
const ROW_INSERT_CHUNK = 500;
/** Sequential slug probes before falling back to a random suffix. */
export const SLUG_PROBE_LIMIT = 50;
let beforeRowChunkForTests: ((chunkIndex: number) => void | Promise<void>) | undefined;

/** Fault-injection seam used to prove dataset metadata and row chunks commit atomically. */
export function __setDatasetPersistHookForTests(
  hook: ((chunkIndex: number) => void | Promise<void>) | undefined,
): void {
  beforeRowChunkForTests = hook;
}

/** kebab-case a display name into a URL-safe slug stem. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'dataset';
}

export interface CreateDatasetArgs {
  /** Who uploaded it (audit). */
  ownerId: string;
  /** The org the dataset belongs to — the scope key. Required (Phase 3.6). */
  tenantId: string;
  sandboxId?: string | null;
  name: string;
  sourceType: DatasetSourceType;
  parsed: ParsedDataset;
}

/** Insert a dataset + its rows (chunked). Returns the persisted dataset row. */
export async function createDataset(
  args: CreateDatasetArgs,
  database: Db = defaultDb,
): Promise<Dataset> {
  const stem = slugify(args.name);
  return database.transaction(async (tx) => {
    let dataset: Dataset | undefined;
    // Bounded: a handful of sequential probes, then a random suffix. Looping to 10k would mean
    // 10k round trips inside one transaction on a pathological name.
    for (let suffix = 1; suffix <= SLUG_PROBE_LIMIT + 1; suffix++) {
      const slug =
        suffix === 1
          ? stem
          : suffix > SLUG_PROBE_LIMIT
            ? `${stem}-${crypto.randomUUID().slice(0, 8)}`
            : `${stem}-${suffix}`;
      const [row] = await tx
        .insert(datasets)
        .values({
          owner_id: args.ownerId,
          tenant_id: args.tenantId,
          sandbox_id: args.sandboxId ?? null,
          name: args.name,
          slug,
          source_type: args.sourceType,
          columns: args.parsed.columns,
          row_count: args.parsed.rows.length,
          size_bytes: byteSize(args.parsed.rows),
          status: 'ready',
        })
        .onConflictDoNothing({ target: [datasets.tenant_id, datasets.slug] })
        .returning();
      if (row) {
        dataset = row;
        break;
      }
    }
    if (!dataset) throw new Error(`could not allocate a dataset slug for '${args.name}'`);

    for (let i = 0; i < args.parsed.rows.length; i += ROW_INSERT_CHUNK) {
      await beforeRowChunkForTests?.(i / ROW_INSERT_CHUNK);
      const chunk = args.parsed.rows.slice(i, i + ROW_INSERT_CHUNK).map((data, j) => ({
        dataset_id: dataset!.id,
        idx: i + j,
        data,
      }));
      if (chunk.length) await tx.insert(datasetRows).values(chunk);
    }
    return dataset;
  });
}

/** Replace a dataset's rows (used by the PATCH-reparse path; not the common edit). */
export async function replaceRows(
  datasetId: string,
  rows: Record<string, unknown>[],
  database: Db = defaultDb,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(datasetRows).where(eq(datasetRows.dataset_id, datasetId));
    for (let i = 0; i < rows.length; i += ROW_INSERT_CHUNK) {
      const chunk = rows.slice(i, i + ROW_INSERT_CHUNK).map((data, j) => ({
        dataset_id: datasetId,
        idx: i + j,
        data,
      }));
      if (chunk.length) await tx.insert(datasetRows).values(chunk);
    }
  });
}

/** Read a page of a dataset's rows in idx order. */
export async function readRows(
  datasetId: string,
  limit: number,
  offset = 0,
  database: Db = defaultDb,
): Promise<Record<string, unknown>[]> {
  const rows = await database
    .select({ data: datasetRows.data })
    .from(datasetRows)
    .where(eq(datasetRows.dataset_id, datasetId))
    .orderBy(asc(datasetRows.idx))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => r.data);
}

/** A dataset's schema as any AI-facing reader may see it: name, type and the personal-data flag —
 *  never `sample` (a real cell value) and never a row. Owner decision W8 (2026-10-14): example data
 *  is not sent to the external AI. Used by the MCP `list_datasets` / `describe_data` tools and the
 *  `data://dataset` resource, so one shape decides what reaches a provider. */
export function schemaForAi(
  columns: DatasetColumn[] | null | undefined,
): { name: string; type: DatasetColumn['type']; pii: boolean }[] {
  return (columns ?? []).map((c) => ({ name: c.name, type: c.type, pii: !!c.pii }));
}

/** Redact PII column values in-place for one row (host-side, pre-injection). Exported
 *  so every raw-row-reading caller (run-controller's inject path AND the MCP
 *  describe_data tool / data://dataset resource) shares ONE redaction implementation
 *  — a second reimplementation is exactly how these drift apart (see FIX 2). */
export function redactPii(row: Record<string, unknown>, piiCols: string[]): Record<string, unknown> {
  if (!piiCols.length) return row;
  const out = { ...row };
  for (const c of piiCols) if (c in out) out[c] = PII_REDACTION;
  return out;
}

export interface LoadInjectedResult {
  datasets: Record<string, InjectedDataset>;
  /** Per-slug truncation counts (rows dropped at the inject cap), for logging. */
  truncated: Record<string, number>;
}

/**
 * Load the referenced datasets (by slug, tenant-scoped) as injectable {columns, rows},
 * capped at DATASET_INJECT_ROW_CAP and — when `redact` — PII-masked at the host so the
 * untrusted runner never sees raw PII. Unknown slugs are skipped (a flow may name a
 * dataset that was deleted; the block then sees no rows).
 */
export async function loadInjectedDatasets(
  tenantId: string,
  slugs: string[],
  redact: boolean,
  database: Db = defaultDb,
): Promise<LoadInjectedResult> {
  const out: LoadInjectedResult = { datasets: {}, truncated: {} };
  const unique = [...new Set(slugs.filter(Boolean))];
  if (!unique.length) return out;

  const metas = await database
    .select()
    .from(datasets)
    .where(and(eq(datasets.tenant_id, tenantId), inArray(datasets.slug, unique)));

  for (const meta of metas) {
    const piiCols = redact
      ? (meta.columns ?? []).filter((c) => c.pii).map((c) => c.name)
      : [];
    const rawRows = await readRows(meta.id, DATASET_INJECT_ROW_CAP, 0, database);
    if (meta.row_count > DATASET_INJECT_ROW_CAP) {
      out.truncated[meta.slug] = meta.row_count - DATASET_INJECT_ROW_CAP;
    }
    const rows = piiCols.length ? rawRows.map((r) => redactPii(r, piiCols)) : rawRows;
    out.datasets[meta.slug] = { columns: meta.columns ?? [], rows };
  }
  return out;
}

/** API/agent-facing projection of a dataset row (no internal owner/tenant ids). */
export function datasetOut(d: Dataset): {
  id: string;
  slug: string;
  name: string;
  sourceType: DatasetSourceType;
  columns: DatasetColumn[];
  rowCount: number;
  sizeBytes: number;
  status: string;
  sandboxId: string | null;
  createdAt: Date;
  updatedAt: Date;
} {
  return {
    id: d.id,
    slug: d.slug,
    name: d.name,
    sourceType: d.source_type,
    columns: d.columns ?? [],
    rowCount: d.row_count,
    sizeBytes: d.size_bytes,
    status: d.status,
    sandboxId: d.sandbox_id,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}
