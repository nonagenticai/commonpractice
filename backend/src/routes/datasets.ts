// src/routes/datasets.ts — the Datasets API (Phase 2.0 / 3.6). Tenant-scoped test-data:
// upload CSV/Excel or paste text/JSON/SQL-result → parse → infer a typed schema →
// persist datasets + dataset_rows; list/preview; edit columns (rename/retype/toggle-PII)
// + rescope; delete. Every mutation is audited (category 'data').
// Phase 3.6: test data is shared within an org. READS scope by the caller's active
// tenant (any member browses all of it; the agent reads the same rows over MCP and the
// runner gets them via the init frame). WRITES (create/edit/delete) require a data
// manager — a `developer` (the dedicated authoring role), or an admin (tenant_admin, the
// "IT department", / super_admin). Mapping READS and suggestions stay open to every member;
// mapping WRITES (PUT confirm / DELETE) need a data manager since 2026-10-15: a confirmed mapping
// to a non-PII attribute UNMASKS that column for every member (datasets/member-view.ts), so who
// may confirm one is who may decide what members see — owner decision W8, "admins keep control".
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, datasets, datasetRows } from '../db/client';
import type { Dataset } from '../db/schema';
import { resolveTenant, type TenantContext } from '../middleware/tenant';
import { negotiateLocale } from '../utils/locale';
import { likeTerm } from '../utils/search';
import { isDeveloper } from '../middleware/admin-guards';
import { recordAudit } from '../host/audit-service';
import { jsonResponse, readJson, route, notFound, badRequest, forbidden } from '../utils/http';
import { log } from '../host/logger';
import {
  type DatasetColumn,
  type DatasetColumnType,
  type DatasetSourceType,
  DATASET_SOURCE_TYPES,
  DATASET_PREVIEW_ROWS,
  DATASET_MAX_BYTES,
  DATASET_INJECT_ROW_CAP,
} from '../db/dataset-types';
import { suggestNonPersonalColumns } from '../datasets/column-suggestions';
import { parseDataset } from '../datasets/parse';
import {
  createDataset,
  datasetOut,
  readRows,
} from '../datasets/dataset-service';
import {
  listMappings,
  suggestMappings,
  upsertMapping,
  pruneCellMappings,
  deleteMapping,
  MAPPING_CONFIDENCE_THRESHOLD,
} from '../datasets/mapping-service';
import type { Router } from '../utils/router';
import { maskColumns, maskRows, memberColumnClassification, memberMasks } from '../datasets/member-view';

const PAGE_SIZE = 12;
const COLUMN_TYPES: DatasetColumnType[] = ['string', 'number', 'boolean', 'date', 'json'];

/** Resolve a dataset by slug within the caller's tenant, or 404. */
async function loadInTenant(tenantId: string, slug: string): Promise<Dataset> {
  const [d] = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.tenant_id, tenantId), eq(datasets.slug, slug)));
  if (!d) throw notFound('dataset_not_found', `No dataset '${slug}'`);
  return d;
}

/** May the caller manage (create/edit/delete) the org's test data? = a `developer`, or an
 *  admin (tenant_admin "IT department" / super_admin) — `isDeveloper` is composite.
 *
 *  ⛔ This used to read `ctx.role === 'tenant_admin' || isSuperAdmin(ctx.user)`, which locked
 *  the `developer` role out of the data it exists to author against. `ctx.role` is a BINARY
 *  (`middleware/tenant.ts:44,90` maps every non-tenant_admin realm role to `'member'`), so a
 *  developer never matched. The result was incoherent: a developer may edit the ontology
 *  (`ontology.ts:38` = isDeveloper) and may bind a dataset to an entity as test data
 *  (`bindEntitySample`, behind the same isDeveloper gate) — but could not CREATE the dataset
 *  it binds. Every dataset had to be routed through a tenant_admin.
 *
 *  Deliberately NOT changed: the identically-named gate in `routes/connectors.ts:176`. A
 *  connector materializes a LIVE external source, with stored credentials, into the org's
 *  shared pool — SPEC §5 makes that an IT/admin decision, and that comment says so. This is
 *  the local-test-data gate, not the live-source one. */
export function canManageData(ctx: Pick<TenantContext, 'user'>): boolean {
  return isDeveloper(ctx.user);
}

/** Resolve the caller's tenant and assert they may manage test data, else 403. */
async function requireDataManager(req: Request): Promise<TenantContext> {
  const ctx = await resolveTenant(req);
  if (!canManageData(ctx)) {
    throw forbidden('data_manager_required', 'Only an org admin (IT) may add or change test data');
  }
  return ctx;
}

const EXT_TO_TYPE: Record<string, DatasetSourceType> = {
  csv: 'csv',
  tsv: 'csv',
  xlsx: 'xlsx',
  xls: 'xlsx',
  json: 'json',
  txt: 'text',
  text: 'text',
};

/** The dotted extension of a file name (`'.pdf'`), or `null` when the name carries none.
 *  A leading dot is not an extension — `.gitignore` is a NAME, so `'.gitignore'.split('.')` must
 *  not yield `gitignore` as its type. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : null;
}

function sourceTypeFromName(name: string): DatasetSourceType | null {
  const ext = extensionOf(name);
  return ext ? (EXT_TO_TYPE[ext.slice(1)] ?? null) : null;
}

/**
 * Resolve a multipart upload's source type — WITHOUT EVER GUESSING.
 *
 * ⛔ THE DEFECT THIS REPLACES. This was
 *     `(declared valid ? declared : sourceTypeFromName(fname)) ?? 'csv'`
 * and `sourceTypeFromName` answers `null` for any extension it does not know. So `?? 'csv'` was a
 * GUESS ON NO EVIDENCE: drag `report.pdf` onto /datasets and the bytes were decoded as UTF-8, line 1
 * (`%PDF-1.7`) became the header row, and the API answered **201 with a dataset that looked
 * successfully imported**. The frontend's only guard was `accept=` on the hidden <input>, which the
 * drag-and-drop `onDrop` path never consults. Nothing anywhere told the reader.
 *
 * The precedence is unchanged and deliberate — an EXPLICIT, VALID `sourceType` still wins over the
 * file name, because a caller that asserts the format knows more than its extension does (that is
 * also the escape hatch for the two refusals below). Only the invented fallback is gone.
 *
 * ⚠️ `.txt` AND `.text` ARE UNAFFECTED, and that is worth being explicit about because it is the
 * "ambiguous but working" case: they are KNOWN extensions mapping to `text`, so a `.txt` file that
 * happens to be valid CSV keeps landing on `parseText` exactly as it did before this change — one
 * row per line, `{line, text}`. Nothing about that path moves.
 *
 * ⚠️ AN EXTENSIONLESS FILE IS NOW REFUSED, and that IS a behaviour change on a path that "worked":
 * `export` (a valid CSV with no extension) used to become a CSV dataset. It is refused on purpose.
 * An extensionless file is exactly as unknowable as `report.pdf` — the only difference is which way
 * the coin landed — and guessing on no evidence is the whole defect. The trade is asymmetric: a
 * wrong guess ships silent garbage that reads as a successful import, while a refusal costs the
 * reader one rename (or the Paste tab, which takes an explicit type, or `sourceType` on the form).
 * It is a LOUD, self-describing break with a named repair, not a silent one — `reason` carries
 * `no_extension` so the catalog can say which of the two happened.
 */
export function resolveUploadSourceType(fname: string, declared: unknown): DatasetSourceType {
  if (
    typeof declared === 'string' &&
    (DATASET_SOURCE_TYPES as readonly string[]).includes(declared)
  ) {
    return declared as DatasetSourceType;
  }
  const fromName = sourceTypeFromName(fname);
  if (fromName) return fromName;

  // ONE code, TWO sentences, chosen by `details.reason` — the seam utils/http.ts documents. The
  // interpolated value ships as a named field so a catalog can rebuild the sentence in any language
  // instead of regexing it out of the English one.
  const ext = extensionOf(fname);
  const supported = DATASET_SOURCE_TYPES.join(', ');
  throw ext
    ? badRequest(
        'unsupported_file_type',
        `Cannot import '${ext}' files; supported dataset sources are ${supported}`,
        { reason: 'extension', extension: ext, name: fname },
      )
    : badRequest(
        'unsupported_file_type',
        `'${fname}' has no file extension, so its format cannot be determined`,
        { reason: 'no_extension', name: fname },
      );
}

/** Read an upload with a hard byte ceiling before any multipart/JSON parser sees it. This covers
 * both Content-Length and chunked transfer; `Request.formData()` alone buffers an unbounded body. */
export async function readBoundedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  // `reason: 'upload'` discriminates the whole-BODY ceiling from the per-FILE one below (`file`)
  // and from the parser's own limit (`input`, datasets/parse/index.ts) — one code, three sentences.
  const limitMb = Math.floor(DATASET_MAX_BYTES / 1_048_576);
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw badRequest('dataset_too_large', `Upload exceeds the ${limitMb} MB dataset limit`, {
      reason: 'upload',
      limitMb,
    });
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw badRequest('dataset_too_large', `Upload exceeds the ${limitMb} MB dataset limit`, {
        reason: 'upload',
        limitMb,
      });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---- POST /api/datasets ----
// multipart (file upload, CSV/Excel) OR JSON body { name, sourceType, content, sandboxId? }.
const createDatasetRoute = route(async (req) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  const contentType = req.headers.get('content-type') ?? '';

  let name: string;
  let sourceType: DatasetSourceType;
  let sandboxId: string | null = null;
  let sheet: string | undefined;
  let text: string | undefined;
  let binary: Uint8Array | undefined;

  if (contentType.includes('multipart/form-data')) {
    // Boundary/field overhead gets 1 MiB; the file itself remains capped at DATASET_MAX_BYTES.
    const body = await readBoundedBody(req, DATASET_MAX_BYTES + 1_048_576);
    const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('no_file', 'Expected a "file" field');
    if (file.size > DATASET_MAX_BYTES) {
      // `reason: 'file'` — the multipart part itself, not the body ceiling (`upload`) above.
      const limitMb = DATASET_MAX_BYTES / 1_048_576;
      throw badRequest('dataset_too_large', `File exceeds the ${limitMb} MB dataset limit`, {
        reason: 'file',
        limitMb,
      });
    }
    const fname = file.name || 'upload';
    sourceType = resolveUploadSourceType(fname, form.get('sourceType'));
    name = (form.get('name') as string)?.trim() || fname.replace(/\.[^.]+$/, '');
    sandboxId = (form.get('sandboxId') as string) || null;
    sheet = (form.get('sheet') as string) || undefined;
    binary = new Uint8Array(await file.arrayBuffer());
    if (sourceType !== 'xlsx') text = new TextDecoder().decode(binary);
  } else {
    const bytes = await readBoundedBody(req, DATASET_MAX_BYTES);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw badRequest('invalid_json', 'Request body is not valid JSON');
    }
    const body = z
      .object({
        name: z.string().min(1).max(120),
        sourceType: z.enum(['csv', 'json', 'text', 'sql']),
        content: z.string(),
        sandboxId: z.string().uuid().nullable().optional(),
      })
      .strict()
      .parse(raw);
    name = body.name.trim();
    sourceType = body.sourceType;
    text = body.content;
    sandboxId = body.sandboxId ?? null;
  }

  const parsed = await parseDataset({ sourceType, text, binary, sheet });
  if (parsed.truncated > 0) {
    log.warn('dataset_truncated_at_row_cap', { name, truncatedRows: parsed.truncated });
  }
  // NEVER SILENT, same rule as `truncated` (SPEC §2.7). A repeated header is disambiguated at parse
  // time so no column's data is lost, but the uploader has to be told which one became `Amount_1`
  // or the schema they get back is not the schema they think they uploaded.
  if (parsed.renamedColumns.length > 0) {
    // The WHICH-columns detail stays (that is the point of the line, per the note above) — it just
    // moves off the message and into a field, so the message aggregates and the detail is still there.
    log.warn('dataset_duplicate_columns_renamed', {
      name,
      renamedCount: parsed.renamedColumns.length,
      renamed: parsed.renamedColumns.map((r) => `${r.from}→${r.to}`),
    });
  }
  if (parsed.rows.length === 0) throw badRequest('dataset_empty', 'No rows were parsed from the input');

  const dataset = await createDataset({
    ownerId: user.id,
    tenantId: ctx.tenantId,
    sandboxId,
    name,
    sourceType,
    parsed,
  });

  await recordAudit({
    actorId: user.id,
    action: 'dataset.create',
    category: 'data',
    targetType: 'dataset',
    targetId: dataset.slug,
    result: `Created · ${dataset.row_count} rows`,
    resultTone: 'ok',
    metadata: {
      sourceType,
      rowCount: dataset.row_count,
      truncated: parsed.truncated,
      // Only when it actually happened — keeps an ordinary upload's audit row quiet, the same way
      // connector.sync omits columnsAdded/columnsRemoved (datasets/connector-refresh.ts).
      ...(parsed.renamedColumns.length ? { renamedColumns: parsed.renamedColumns } : {}),
    },
  });

  return jsonResponse(
    {
      ...datasetOut(dataset),
      preview: parsed.rows.slice(0, DATASET_PREVIEW_ROWS),
      truncated: parsed.truncated,
      // ⚠️ ADDED ALONGSIDE, never in place of anything — an OLD frontend served by this NEW backend
      // for the length of a rolling deploy simply ignores it. The reverse skew (new frontend, OLD
      // backend) is why the frontend type marks it optional with a defined empty fallback.
      renamedColumns: parsed.renamedColumns,
    },
    201,
  );
});

// ---- GET /api/datasets?sandbox=&q=&page= ----
const listDatasets = route(async (req) => {
  const ctx = await resolveTenant(req);
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim();
  const sandbox = url.searchParams.get('sandbox');
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

  const filters = [eq(datasets.tenant_id, ctx.tenantId)];
  // ⛔ `likeTerm`, NOT `%${q}%` — dataset names routinely contain `%` (`Uplift 100%`) and `_`
  // (`omzet_q1`), the two ILIKE metacharacters. utils/search.ts owns the escape.
  const like = q ? likeTerm(q) : '';
  if (q) filters.push(or(ilike(datasets.name, like), ilike(datasets.slug, like))!);
  if (sandbox === 'none') filters.push(isNull(datasets.sandbox_id));
  else if (sandbox) filters.push(eq(datasets.sandbox_id, sandbox));
  const where = and(...filters);

  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(datasets)
    .where(where);
  const total = countRows[0]?.n ?? 0;

  const rows = await db
    .select()
    .from(datasets)
    .where(where)
    // `id` LAST — `updated_at` is not unique (one transaction stamps one clock across every row it
    // writes), and a non-total ORDER BY under limit/offset lets Postgres order the tied rows
    // differently for the page-1 and page-2 queries, so a dataset can appear twice or vanish. Same
    // fix, same reason, as routes/challenges' `orderForSort` — its header carries the measurement.
    .orderBy(desc(datasets.updated_at), asc(datasets.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  // W8/P7: a non-manager gets each column's `sample` blanked for the columns they may not see, and
  // the list of those columns so the browser can show "•••" instead of a value.
  const masks = await memberMasks(ctx.tenantId, rows, canManageData(ctx));
  return jsonResponse({
    items: rows.map((d) => {
      const masked = masks.get(d.id) ?? [];
      const out = datasetOut(d);
      return { ...out, columns: maskColumns(out.columns, masked, canManageData(ctx)), maskedColumns: masked };
    }),
    total,
    page,
    pageSize: PAGE_SIZE,
    // Lets the UI gate the upload/edit/delete affordances; the server enforces it too.
    canManage: canManageData(ctx),
  });
});

// ---- GET /api/datasets/:slug?offset=&limit= ----
const getDataset = route(async (req, slug) => {
  const ctx = await resolveTenant(req);
  const d = await loadInTenant(ctx.tenantId, slug!);
  const url = new URL(req.url);
  const limit = Math.min(
    DATASET_PREVIEW_ROWS * 4,
    Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? String(DATASET_PREVIEW_ROWS), 10) || DATASET_PREVIEW_ROWS),
  );
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  // MASKED FOR NON-MANAGERS — owner decision 2026-10-14 (PLAN-2026-10-14-ux-cleanup.md §W8.1),
  // which settles the "product call" this comment used to leave open. Data managers
  // (`canManageData`, the predicate behind `requireDataManager`) still get raw rows: they classify
  // columns, and you cannot classify a column you are not allowed to look at. Everyone else gets
  // the masked view from datasets/member-view.ts — read its header for the rule (unmapped columns
  // are masked too). `data.pii_scrubbing` is unrelated: it still governs run injection and the MCP
  // paths, not this human preview.
  const raw = canManageData(ctx);
  const masked = (await memberMasks(ctx.tenantId, [d], raw)).get(d.id) ?? [];
  const rows = maskRows(await readRows(d.id, limit, offset), masked, raw);
  const out = datasetOut(d);
  // DATA MANAGERS ONLY: columns SUGGESTED as not personal (datasets/column-suggestions.ts) — still
  // hidden from members until a data manager confirms them (`nonPersonal` via PATCH below). Members
  // never receive suggestions. Computed over the first DATASET_INJECT_ROW_CAP rows (what a run reads).
  let suggested: string[] | undefined;
  if (raw) {
    const cls = (await memberColumnClassification(ctx.tenantId, [d])).get(d.id);
    suggested = cls
      ? suggestNonPersonalColumns(out.columns, await readRows(d.id, DATASET_INJECT_ROW_CAP), cls.classified)
      : [];
  }
  return jsonResponse({
    ...out,
    columns: maskColumns(out.columns, masked, raw),
    maskedColumns: masked,
    ...(suggested ? { suggestedNonPersonal: suggested } : {}),
    rows,
    offset,
    limit,
  });
});

const columnSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'date', 'json']),
  pii: z.boolean().optional(),
  nonPersonal: z.boolean().optional(),
  sample: z.unknown().optional(),
});
const patchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    columns: z.array(columnSchema).optional(),
    sandboxId: z.string().uuid().nullable().optional(),
  })
  .strict();

// ---- PATCH /api/datasets/:slug ----
const patchDataset = route(async (req, slug) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  const d = await loadInTenant(ctx.tenantId, slug!);
  const body = patchSchema.parse(await readJson(req));

  const update: Partial<Dataset> = { updated_at: new Date() };
  if (body.name) update.name = body.name.trim();
  if (body.sandboxId !== undefined) update.sandbox_id = body.sandboxId;
  if (body.columns) {
    // Retype/rename/PII-toggle must keep the SAME column set (names match existing). Compare SETS,
    // not the array length: `[a, a, b]` against a stored `{a, b, c}` matched on both length and
    // membership, so the PATCH was accepted and `c` was quietly dropped from the schema — its row
    // values still in the table, no longer addressable.
    const existing = new Set((d.columns ?? []).map((c) => c.name));
    const submitted = new Set(body.columns.map((c) => c.name));
    if (submitted.size !== body.columns.length) {
      throw badRequest('duplicate_column', 'columns must not repeat a column name');
    }
    if (submitted.size !== existing.size || ![...submitted].every((n) => existing.has(n))) {
      throw badRequest('columns_mismatch', 'columns must cover exactly the existing column names');
    }
    for (const c of body.columns) {
      if (!COLUMN_TYPES.includes(c.type))
        throw badRequest('bad_column_type', `Unknown type '${c.type}'`, { type: c.type });
    }
    update.columns = body.columns as DatasetColumn[];
  }

  const [updated] = await db
    .update(datasets)
    .set(update)
    .where(eq(datasets.id, d.id))
    .returning();

  await recordAudit({
    actorId: user.id,
    action: 'dataset.update',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: 'Updated',
    resultTone: 'ok',
    metadata: {
      renamed: !!body.name,
      retyped: !!body.columns,
      rescoped: body.sandboxId !== undefined,
    },
  });

  return jsonResponse(datasetOut(updated!));
});

// ---- DELETE /api/datasets/:slug ----
const deleteDataset = route(async (req, slug) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  const d = await loadInTenant(ctx.tenantId, slug!);
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  await db.delete(datasets).where(eq(datasets.id, d.id));
  await recordAudit({
    actorId: user.id,
    action: 'dataset.delete',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: 'Deleted',
    resultTone: 'warn',
    metadata: { rowCount: d.row_count },
  });
  return jsonResponse({ ok: true });
});

// ---- Phase 3.3: dataset → ontology mapping (the Pillar A ↔ B bridge) ----
// Sub-routes under /api/datasets/:slug/mappings. Tenant-scoped read (loadInTenant) so
// mapping works on the org's shared data; kept member-writable by decision (mapping a
// dataset's columns to ontology concepts is collaborative ontology curation, not data
// provisioning). Reads compileEffective (3.2); the LLM path is metered through the
// broker. All mutations audited (category 'data').

// ---- GET /api/datasets/:slug/mappings ----
const getMappings = route(async (req, slug) => {
  const ctx = await resolveTenant(req);
  const d = await loadInTenant(ctx.tenantId, slug!);
  // ⛔ LOCALIZED, because this response has a READER. `mappings[].entityLabel` is rendered in
  // exactly one place in the product — the flow builder's dataset panel,
  // NodeConfigPanel.svelte:197, inside `nodecfg_ontology_coverage` → nl "{mapped} van {total}
  // kolommen gekoppeld aan {entity}". Left en, a Dutch builder read "gekoppeld aan Broker Note"
  // while /ontology called the same row "Tussenpersoon-notitie".
  //   ⚠️ This does NOT contradict keeping the MCP tool en. The distinction is the CONSUMER, not
  // the route: `ai/mcp/tools.ts` hands mappings to an agent, whose concept vocabulary stays
  // canonical. /datasets itself is unaffected either way — it renders `entityName` (the canonical
  // id), never `entityLabel`.
  return jsonResponse({
    mappings: await listMappings(d.id, undefined, { locale: negotiateLocale(req), tenantId: ctx.tenantId }),
  });
});

const suggestSchema = z
  .object({
    industry: z.string().min(1),
    department: z.string().min(1),
    useLlm: z.boolean().optional(),
  })
  .strict();

// ---- POST /api/datasets/:slug/mappings/suggest ----
// Returns proposals (NOT persisted). useLlm adds a metered LLM pass for unmatched cols.
const suggestMappingsRoute = route(async (req, slug) => {
  const ctx = await resolveTenant(req);
  const user = ctx.user;
  const d = await loadInTenant(ctx.tenantId, slug!);
  const body = suggestSchema.parse(await readJson(req));
  const suggestions = await suggestMappings({
    columns: d.columns ?? [],
    industry: body.industry,
    department: body.department,
    userId: user.id,
    tenantId: ctx.tenantId,
    useLlm: body.useLlm ?? false,
  });
  await recordAudit({
    actorId: user.id,
    action: 'dataset-mapping.suggest',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: `${suggestions.length} suggestion(s)`,
    resultTone: 'ok',
    metadata: { industry: body.industry, department: body.department, useLlm: body.useLlm ?? false },
  });
  return jsonResponse({ suggestions, threshold: MAPPING_CONFIDENCE_THRESHOLD });
});

const putMappingsSchema = z
  .object({
    mappings: z
      .array(
        z.object({
          entityId: z.string().uuid(),
          industry: z.string().min(1),
          department: z.string().min(1),
          columnMap: z.record(z.string(), z.string()),
          confidence: z.number().min(0).max(1).optional(),
        }),
      )
      .max(100),
  })
  .strict();

// ---- PUT /api/datasets/:slug/mappings ----
// Persist confirmed mappings (source='human', confirmed=true); idempotent per (dataset, entity).
// Data managers only: confirming a mapping is what unmasks a column for members (member-view.ts).
const putMappings = route(async (req, slug) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  const d = await loadInTenant(ctx.tenantId, slug!);
  const body = putMappingsSchema.parse(await readJson(req));
  // Replace-for-cell: a save is authoritative for each (industry × department) cell it covers, so
  // first prune mappings the user removed/re-pointed (else re-mapping a column to another entity
  // leaves the old mapping orphaned and the runner injects both). Then upsert the confirmed set.
  const cells = new Map<string, { industry: string; department: string; entityIds: string[] }>();
  for (const m of body.mappings) {
    // ⛔ `\x00` — the ESCAPE, never the raw byte. A literal U+0000 used to sit here, which made
    // this entire FILE binary: `file` reported it as `data`, and GNU/BSD grep treats a binary file
    // as one unsplittable blob, so `grep 'router.add' routes/datasets.ts` printed nothing and
    // exited 1. Every grep-based audit of the route surface — route inventories, auth-gate sweeps,
    // "which routes touch tenant scope" — silently skipped all 9 dataset routes and reported
    // clean. The escape is byte-identical at runtime and keeps the source text. See
    // host/metrics.ts:71, which uses the same separator and does it correctly.
    const key = `${m.industry}\x00${m.department}`;
    const c = cells.get(key) ?? { industry: m.industry, department: m.department, entityIds: [] };
    c.entityIds.push(m.entityId);
    cells.set(key, c);
  }
  for (const c of cells.values()) {
    // ⛔ `ctx.tenantId`, not the omitted-and-therefore-global scope this used to run in. See the
    // TENANT SCOPE block in datasets/mapping-service.ts: under `cp_app` a global-scoped write
    // matches 0 rows / is refused outright, and every one of these three calls reported success.
    await pruneCellMappings(d.id, c.industry, c.department, c.entityIds, ctx.tenantId);
  }
  for (const m of body.mappings) {
    await upsertMapping({
      datasetId: d.id,
      entityId: m.entityId,
      industry: m.industry,
      department: m.department,
      columnMap: m.columnMap,
      confidence: m.confidence ?? 0,
      source: 'human',
      confirmed: true,
      tenantId: ctx.tenantId,
    });
  }
  await recordAudit({
    actorId: user.id,
    action: 'dataset-mapping.update',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: `Saved ${body.mappings.length} mapping(s)`,
    resultTone: 'ok',
    metadata: { count: body.mappings.length },
  });
  // Same reader as GET above — the panel re-reads this response after a save.
  return jsonResponse({
    mappings: await listMappings(d.id, undefined, { locale: negotiateLocale(req), tenantId: ctx.tenantId }),
  });
});

// ---- DELETE /api/datasets/:slug/mappings/:entityId ----
// Data managers only, like PUT: removing a mapping changes what members see.
const deleteMappingRoute = route(async (req, slug, entityId) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  const d = await loadInTenant(ctx.tenantId, slug!);
  const removed = await deleteMapping(d.id, entityId!, ctx.tenantId);
  if (!removed) throw notFound('mapping_not_found', `No mapping for entity '${entityId}'`);
  await recordAudit({
    actorId: user.id,
    action: 'dataset-mapping.delete',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: 'Deleted',
    resultTone: 'warn',
    metadata: { entityId },
  });
  return jsonResponse({ ok: true });
});

export function registerDatasetRoutes(router: Router): void {
  router.add('GET', '/api/datasets', listDatasets);
  router.add('POST', '/api/datasets', createDatasetRoute);
  router.add('GET', '/api/datasets/:slug', getDataset);
  router.add('PATCH', '/api/datasets/:slug', patchDataset);
  router.add('DELETE', '/api/datasets/:slug', deleteDataset);
  // Phase 3.3 — ontology mapping sub-routes.
  router.add('GET', '/api/datasets/:slug/mappings', getMappings);
  router.add('POST', '/api/datasets/:slug/mappings/suggest', suggestMappingsRoute);
  router.add('PUT', '/api/datasets/:slug/mappings', putMappings);
  router.add('DELETE', '/api/datasets/:slug/mappings/:entityId', deleteMappingRoute);
}
