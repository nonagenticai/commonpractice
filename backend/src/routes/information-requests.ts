// src/routes/information-requests.ts — W8/P5: member requests about a challenge's information, and
// the approval queue an approver works through.
//
// A MEMBER (any reader of the tenant) can, on a challenge:
//   • POST /api/challenges/:id/information-requests          — "missing information": a name, a short
//     description, optional example field names;
//   • POST /api/challenges/:id/information-requests/upload   — a few example records (CSV/XLSX), under
//     the SAME byte and row caps as a dataset upload;
//   • GET  /api/challenges/:id/information-requests          — their own requests and each one's status
//     (an approver sees everyone's).
// An APPROVER — tenant_admin, developer or super_admin (`isDeveloper`; owner decision W8.3) — can:
//   • GET  /api/information-requests?status=                 — the queue, with the pending count;
//   • GET  /api/information-requests/:id                     — one request (records unmasked);
//   • GET  /api/information-requests/:id/records             — the stored records, for the dataset
//     screen's prefill;
//   • POST /api/information-requests/:id/approve | /reject   — record the decision (+ a note).
//
// ⛔ APPROVING WRITES NOTHING BUT THE DECISION. It answers with `next` — the EXISTING admin screen to
// open, prefilled (`/ontology?fromRequest=` / `/datasets?fromRequest=`) — and the entity or dataset is
// created there, through `requireOntologyManager` / `requireDataManager`, exactly as before. No
// ontology or dataset write path, and no role gate on one, is touched by this file.
//
// ⛔ UPLOADED RECORDS NEVER REACH A RUN OR THE AI. They live in `information_request_rows`, which no
// run path (runs inject from `datasets` by slug) and no AI path (MCP tools, the build agent, the
// suggestion prompt) reads. Personal data is redacted AT REST on the way in, two ways: a column the
// NAME heuristic flags is blanked whole, and every other cell is scanned for personal VALUES
// (e-mail, phone, IBAN, BSN, postcode, a date in a birth column — datasets/pii-values.ts) and each
// match replaced in place. What neither catches (a bare name in a "klant" column, say) is stored as
// typed and shown only to approvers, who see raw data by owner decision; the uploader sees column
// names and masked values.
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  challenges,
  informationRequests,
  informationRequestRows,
  users,
} from '../db/client';
import { resolveTenant, type TenantContext } from '../middleware/tenant';
import { isDeveloper } from '../middleware/admin-guards';
import { challengeInTenant } from '../challenges/challenge-information';
import { parseDataset } from '../datasets/parse';
import { redactPii } from '../datasets/dataset-service';
import { scrubPiiRow } from '../datasets/pii-values';
import { neutralizeRow } from '../utils/spreadsheet-safe';
import { DATASET_MAX_BYTES, PII_REDACTION, type DatasetColumn } from '../db/dataset-types';
import { readBoundedBody, resolveUploadSourceType } from './datasets';
import { recordAudit } from '../host/audit-service';
import { jsonResponse, readJson, readJsonOptional, route, notFound, badRequest, forbidden, conflict, tooManyRequests } from '../utils/http';
import type { Router } from '../utils/router';
import type { User } from '../types';

type RequestRow = typeof informationRequests.$inferSelect;

/** Who may review requests (owner decision W8.3): tenant_admin, developer — and super_admin. */
function canManageRequests(user: User): boolean {
  return isDeveloper(user);
}

/** How many stored rows the request detail shows. */
const DETAIL_ROWS = 20;
/** Rows inserted per statement on upload. */
const INSERT_BATCH = 500;

/** Member request limits (W8 abuse guard): open (pending) requests per member per challenge, and
 *  requests per member in any 24 hours. Reviewers are exempt — they decide the queue. */
export const MAX_PENDING_PER_CHALLENGE = 5;
export const MAX_REQUESTS_PER_DAY = 20;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Refuse (429 `information_request_limit`) when this member is over either limit.
 *
 * Called twice for an upload: once BEFORE the file is read (a cheap early answer, no lock) and once
 * INSIDE the insert transaction under a per-user advisory lock, so two concurrent requests cannot
 * both pass a count of 4 and land a 6th. `pg_advisory_xact_lock` is transaction-scoped, so it is
 * safe behind pgbouncer's transaction pooling and releases on commit/rollback.
 */
async function assertRequestQuota(
  user: User,
  challengeId: string,
  tenantId: string,
  tx?: Tx,
): Promise<void> {
  if (canManageRequests(user)) return;
  const q = tx ?? db;
  if (tx) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'information_request:' + user.id}, 0))`);
  const [counts] = await q
    .select({
      pending: sql<number>`count(*) filter (where ${informationRequests.challenge_id} = ${challengeId} and ${informationRequests.status} = 'pending')::int`,
      today: sql<number>`count(*) filter (where ${informationRequests.created_at} > now() - interval '24 hours')::int`,
    })
    .from(informationRequests)
    .where(
      and(
        eq(informationRequests.tenant_id, tenantId),
        eq(informationRequests.created_by, user.id),
      ),
    );
  const pending = counts?.pending ?? 0;
  const today = counts?.today ?? 0;
  if (pending >= MAX_PENDING_PER_CHALLENGE) {
    throw tooManyRequests('information_request_limit', 'Too many open requests on this challenge', {
      reason: 'pending',
      limit: MAX_PENDING_PER_CHALLENGE,
    });
  }
  if (today >= MAX_REQUESTS_PER_DAY) {
    throw tooManyRequests('information_request_limit', 'Daily request limit reached', {
      reason: 'daily',
      limit: MAX_REQUESTS_PER_DAY,
    });
  }
}

const missingSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    fieldNames: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  })
  .strict();

const decisionSchema = z.object({ note: z.string().trim().max(2000).optional() }).strict();
const rejectSchema = z.object({ note: z.string().trim().min(1).max(2000) }).strict();

/** One request as the wire carries it. `rows` only on the detail read. */
function requestOut(
  r: RequestRow,
  extra: { challengeTitle?: string | null; createdByName?: string | null; mine?: boolean } = {},
) {
  return {
    id: r.id,
    challengeId: r.challenge_id,
    challengeTitle: extra.challengeTitle ?? null,
    kind: r.kind,
    status: r.status,
    name: r.name,
    description: r.description,
    fieldNames: r.field_names ?? [],
    fileName: r.file_name,
    columns: (r.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
    rowCount: r.row_count,
    createdByName: extra.createdByName ?? null,
    mine: extra.mine ?? false,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
  };
}

/** Where an approver continues after approving: the existing create screen, prefilled. */
function nextFor(r: RequestRow): { href: string } {
  return {
    href:
      r.kind === 'missing_information'
        ? `/ontology?fromRequest=${encodeURIComponent(r.id)}`
        : `/datasets?fromRequest=${encodeURIComponent(r.id)}`,
  };
}

/** The request, only when it belongs to `tenantId` — else 404. Explicit predicate on top of RLS. */
async function requestInTenant(id: string, tenantId: string): Promise<RequestRow> {
  if (!z.guid().safeParse(id).success) throw notFound('request_not_found', `No request '${id}'`);
  const [r] = await db
    .select()
    .from(informationRequests)
    .where(and(eq(informationRequests.id, id), eq(informationRequests.tenant_id, tenantId)));
  if (!r) throw notFound('request_not_found', `No request '${id}'`);
  return r;
}

async function requireReviewer(req: Request): Promise<TenantContext> {
  const ctx = await resolveTenant(req);
  if (!canManageRequests(ctx.user)) {
    throw forbidden('forbidden', 'Only an admin or developer can review requests');
  }
  return ctx;
}

// ---- member side --------------------------------------------------------------------------------

// POST /api/challenges/:id/information-requests — "missing information".
const createMissing = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  const body = missingSchema.parse(await readJson(req));
  const c = await challengeInTenant(id!, ctx.tenantId);
  const fieldNames = [...new Set(body.fieldNames ?? [])];
  const r = await db.transaction(async (tx) => {
    await assertRequestQuota(ctx.user, c.id, c.tenant_id, tx);
    const [row] = await tx
      .insert(informationRequests)
      .values({
        tenant_id: c.tenant_id,
        challenge_id: c.id,
        kind: 'missing_information',
        name: body.name,
        description: body.description || null,
        field_names: fieldNames,
        created_by: ctx.user.id,
      })
      .returning();
    return row;
  });
  await recordAudit({
    actorId: ctx.user.id,
    action: 'information_request.create',
    category: 'data',
    targetType: 'challenge',
    targetId: c.title,
    result: `Requested missing information · ${body.name}`,
    resultTone: 'ok',
  });
  return jsonResponse(requestOut(r!, { challengeTitle: c.title, mine: true }), 201);
});

// POST /api/challenges/:id/information-requests/upload — example records (multipart: file, name?).
const createUpload = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  const c = await challengeInTenant(id!, ctx.tenantId);
  // Early, lock-free answer before the file is read; re-checked under a lock in the insert below.
  await assertRequestQuota(ctx.user, c.id, c.tenant_id);
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) throw badRequest('no_file', 'Expected a "file" field');
  // The same ceilings as POST /api/datasets: the body, then the file itself.
  const raw = await readBoundedBody(req, DATASET_MAX_BYTES + 1_048_576);
  const form = await new Response(raw, { headers: { 'content-type': contentType } }).formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('no_file', 'Expected a "file" field');
  if (file.size > DATASET_MAX_BYTES) {
    const limitMb = DATASET_MAX_BYTES / 1_048_576;
    throw badRequest('dataset_too_large', `File exceeds the ${limitMb} MB dataset limit`, { reason: 'file', limitMb });
  }
  const fname = file.name || 'upload';
  const sourceType = resolveUploadSourceType(fname, null);
  // Example records are a spreadsheet: CSV or Excel, nothing else.
  if (sourceType !== 'csv' && sourceType !== 'xlsx') {
    throw badRequest('unsupported_file_type', `Example records must be a CSV or Excel file`, {
      reason: 'extension',
      extension: fname.slice(fname.lastIndexOf('.')).toLowerCase(),
      name: fname,
    });
  }
  const binary = new Uint8Array(await file.arrayBuffer());
  const parsed = await parseDataset({
    sourceType,
    binary,
    ...(sourceType === 'csv' ? { text: new TextDecoder().decode(binary) } : {}),
  });
  if (parsed.rows.length === 0) throw badRequest('dataset_empty', 'No rows were parsed from the input');
  const nameField = form.get('name');
  const name = ((typeof nameField === 'string' ? nameField : '').trim() || fname.replace(/\.[^.]+$/, '')).slice(0, 120);

  // ⛔ MASKED AT REST: a column the parser flags as personal data is stored redacted, and every
  // other cell is value-scrubbed (`scrubPiiRow`), so a detected value never lands in this table —
  // not even for the approver. The column `sample` (a real cell) is not stored at all.
  const piiCols = parsed.columns.filter((col) => col.pii).map((col) => col.name);
  const columns: DatasetColumn[] = parsed.columns.map((col) => ({ name: col.name, type: col.type, ...(col.pii ? { pii: true } : {}) }));

  let scrubbedRows = 0;
  const atRest = (row: Record<string, unknown>): Record<string, unknown> => {
    const named = redactPii(row, piiCols);
    const out = scrubPiiRow(named);
    if (out !== named) scrubbedRows++;
    // Last: a cell that would start a spreadsheet formula is stored inert (utils/spreadsheet-safe.ts).
    return neutralizeRow(out);
  };

  const created = await db.transaction(async (tx) => {
    await assertRequestQuota(ctx.user, c.id, c.tenant_id, tx);
    const [r] = await tx
      .insert(informationRequests)
      .values({
        tenant_id: c.tenant_id,
        challenge_id: c.id,
        kind: 'example_records',
        name,
        file_name: fname.slice(0, 200),
        columns,
        row_count: parsed.rows.length,
        created_by: ctx.user.id,
      })
      .returning();
    for (let i = 0; i < parsed.rows.length; i += INSERT_BATCH) {
      await tx.insert(informationRequestRows).values(
        parsed.rows.slice(i, i + INSERT_BATCH).map((row, j) => ({
          request_id: r!.id,
          tenant_id: c.tenant_id,
          idx: i + j,
          data: atRest(row),
        })),
      );
    }
    return r!;
  });
  await recordAudit({
    actorId: ctx.user.id,
    action: 'information_request.upload',
    category: 'data',
    targetType: 'challenge',
    targetId: c.title,
    result: `Uploaded example records · ${parsed.rows.length} rows`,
    resultTone: 'ok',
    metadata: { truncated: parsed.truncated, redactedColumns: piiCols.length, valueRedactedRows: scrubbedRows },
  });
  return jsonResponse(
    { ...requestOut(created, { challengeTitle: c.title, mine: true }), truncated: parsed.truncated },
    201,
  );
});

// GET /api/challenges/:id/information-requests — the reader's own requests (an approver: all).
const listForChallenge = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  const c = await challengeInTenant(id!, ctx.tenantId);
  const reviewer = canManageRequests(ctx.user);
  const rows = await db
    .select()
    .from(informationRequests)
    .where(
      and(
        eq(informationRequests.challenge_id, c.id),
        eq(informationRequests.tenant_id, c.tenant_id),
        ...(reviewer ? [] : [eq(informationRequests.created_by, ctx.user.id)]),
      ),
    )
    .orderBy(desc(informationRequests.created_at));
  return jsonResponse({
    items: rows.map((r) => requestOut(r, { challengeTitle: c.title, mine: r.created_by === ctx.user.id })),
    canReview: reviewer,
  });
});

// ---- approver side ------------------------------------------------------------------------------

const STATUSES = ['pending', 'approved', 'rejected'] as const;

// GET /api/information-requests?status=pending|approved|rejected|all
const listQueue = route(async (req) => {
  const ctx = await requireReviewer(req);
  const status = new URL(req.url).searchParams.get('status') ?? 'pending';
  const filter = (STATUSES as readonly string[]).includes(status) ? status : null;
  const rows = await db
    .select({ r: informationRequests, challengeTitle: challenges.title, createdByName: users.name })
    .from(informationRequests)
    .innerJoin(challenges, eq(challenges.id, informationRequests.challenge_id))
    .leftJoin(users, eq(users.id, informationRequests.created_by))
    .where(
      and(
        eq(informationRequests.tenant_id, ctx.tenantId),
        ...(filter ? [eq(informationRequests.status, filter as RequestRow['status'])] : []),
      ),
    )
    .orderBy(desc(informationRequests.created_at))
    .limit(200);
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(informationRequests)
    .where(and(eq(informationRequests.tenant_id, ctx.tenantId), eq(informationRequests.status, 'pending')));
  return jsonResponse({
    items: rows.map(({ r, challengeTitle, createdByName }) =>
      requestOut(r, { challengeTitle, createdByName, mine: r.created_by === ctx.user.id }),
    ),
    pendingCount: pending?.n ?? 0,
  });
});

async function storedRows(requestId: string, tenantId: string, limit?: number) {
  const q = db
    .select({ data: informationRequestRows.data })
    .from(informationRequestRows)
    .where(and(eq(informationRequestRows.request_id, requestId), eq(informationRequestRows.tenant_id, tenantId)))
    .orderBy(asc(informationRequestRows.idx));
  const rows = limit ? await q.limit(limit) : await q;
  return rows.map((r) => r.data);
}

/** Every value blanked — what the uploader (not an approver) sees of their own records. */
function maskAll(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(Object.keys(row).map((k) => [k, PII_REDACTION])));
}

// GET /api/information-requests/:id — an approver: the request + its first rows (as stored); the
// member who made it: the same, with every value masked. Anyone else: 404.
const getOne = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  const r = await requestInTenant(id!, ctx.tenantId);
  const reviewer = canManageRequests(ctx.user);
  const mine = r.created_by === ctx.user.id;
  if (!reviewer && !mine) throw notFound('request_not_found', `No request '${id}'`);
  const [c] = await db.select({ title: challenges.title }).from(challenges).where(eq(challenges.id, r.challenge_id));
  const rows = r.kind === 'example_records' ? await storedRows(r.id, r.tenant_id, DETAIL_ROWS) : [];
  return jsonResponse({
    ...requestOut(r, { challengeTitle: c?.title ?? null, mine }),
    rows: reviewer ? rows : maskAll(rows),
    masked: !reviewer,
    canReview: reviewer,
  });
});

// GET /api/information-requests/:id/records — approver only: every stored row, for the dataset
// screen's prefill (which then goes through the existing, gated POST /api/datasets).
const getRecords = route(async (req, id) => {
  const ctx = await requireReviewer(req);
  const r = await requestInTenant(id!, ctx.tenantId);
  if (r.kind !== 'example_records') throw notFound('request_not_found', `No records for request '${id}'`);
  return jsonResponse({ name: r.name, columns: requestOut(r).columns, rows: await storedRows(r.id, r.tenant_id) });
});

async function decide(req: Request, id: string, status: 'approved' | 'rejected', note: string | null) {
  const ctx = await requireReviewer(req);
  const r = await requestInTenant(id, ctx.tenantId);
  // Only a pending request can be decided; the WHERE makes a concurrent second decision a no-op.
  const [updated] = await db
    .update(informationRequests)
    .set({ status, reviewed_by: ctx.user.id, reviewed_at: new Date(), review_note: note })
    .where(
      and(
        eq(informationRequests.id, r.id),
        eq(informationRequests.tenant_id, ctx.tenantId),
        eq(informationRequests.status, 'pending'),
      ),
    )
    .returning();
  if (!updated) throw conflict('request_not_pending', 'This request has already been decided');
  await recordAudit({
    actorId: ctx.user.id,
    action: `information_request.${status === 'approved' ? 'approve' : 'reject'}`,
    category: 'data',
    targetType: 'information_request',
    targetId: r.name,
    result: status === 'approved' ? 'Approved' : 'Not approved',
    resultTone: status === 'approved' ? 'ok' : 'warn',
  });
  return updated;
}

// POST /api/information-requests/:id/approve { note? } — records the decision ONLY; `next` is the
// existing admin screen where the approver creates the entity / dataset themselves.
const approve = route(async (req, id) => {
  const body = decisionSchema.parse(await readJsonOptional(req));
  const updated = await decide(req, id!, 'approved', body.note || null);
  return jsonResponse({ item: requestOut(updated), next: nextFor(updated) });
});

// POST /api/information-requests/:id/reject { note } — a note is required: the member reads it.
const reject = route(async (req, id) => {
  const body = rejectSchema.parse(await readJson(req));
  const updated = await decide(req, id!, 'rejected', body.note);
  return jsonResponse({ item: requestOut(updated) });
});

export function registerInformationRequestRoutes(router: Router): void {
  router.add('POST', '/api/challenges/:id/information-requests', createMissing);
  router.add('POST', '/api/challenges/:id/information-requests/upload', createUpload);
  router.add('GET', '/api/challenges/:id/information-requests', listForChallenge);
  router.add('GET', '/api/information-requests', listQueue);
  router.add('GET', '/api/information-requests/:id/records', getRecords);
  router.add('POST', '/api/information-requests/:id/approve', approve);
  router.add('POST', '/api/information-requests/:id/reject', reject);
  router.add('GET', '/api/information-requests/:id', getOne);
}
