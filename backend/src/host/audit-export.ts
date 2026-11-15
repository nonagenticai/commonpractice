// src/host/audit-export.ts — Phase 2-F compliance export builder.
// Archives one UTC day of the append-only audit_log as a tamper-evident NDJSON bundle
// (+ a manifest carrying its sha256) into object storage. The audit_exports row is both
// the durable record AND the day-claim: a success row makes a re-run idempotent (the
// scheduler skips it); a manual trigger may force a re-export. Best-effort — a failure
// is persisted to the row and audited, never thrown into the scheduler.
import { createHash } from 'node:crypto';
import { and, asc, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  db as defaultDb,
  auditLog,
  auditExports,
  policyChanges,
} from '../db/client';
import { config } from '../config';
import { auditActorId, recordAudit } from './audit-service';
import { uploadObject, type StorageWriterConfig } from './storage-writer';
import { log } from './logger';

type Db = typeof defaultDb;

const PAGE = 1000;
const SCHEMA_VERSION = 1;

/** A storage put: (objectKey, body, contentType) → void. Injectable for tests. */
export type Uploader = (objectKey: string, body: string, contentType: string) => Promise<void>;

export interface ExportDeps {
  db?: Db;
  uploader?: Uploader;
  now?: () => Date;
}

export interface RunExportArgs {
  /** UTC day to export, 'YYYY-MM-DD'. */
  date: string;
  triggeredBy: 'scheduler' | 'manual';
  actorId?: string | null;
  /** Manual re-export even if a success row already exists. */
  force?: boolean;
}

export interface ExportResult {
  date: string;
  status: 'success' | 'error' | 'skipped';
  reason?: string;
  rowCount?: number;
  policyChangeCount?: number;
  objectKey?: string;
  bucket?: string;
  sha256?: string;
  bytes?: number;
  error?: string;
}

/** Pad a number to 2 digits. */
function p2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 'YYYY-MM-DD' for a Date in UTC. */
export function utcDayString(d: Date): string {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** The UTC [start, end) instants for a 'YYYY-MM-DD' day. Throws on a malformed date. */
export function dayWindowUtc(date: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid export date '${date}' (expected YYYY-MM-DD)`);
  }
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid export date '${date}'`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** The object-key prefix for a day: `<prefix>/YYYY/MM/DD`. */
function dayPrefix(keyPrefix: string, date: string): string {
  const [y, m, d] = date.split('-');
  return `${keyPrefix.replace(/\/+$/, '')}/${y}/${m}/${d}`;
}

/** The 'YYYY-MM-DD' one UTC day BEFORE `date`. */
function prevDay(date: string): string {
  return utcDayString(new Date(dayWindowUtc(date).start.getTime() - 24 * 60 * 60 * 1000));
}

/** How many missed days a single tick will back-fill. A long outage should self-heal without one
 *  tick trying to page + upload months of audit_log history. It also bounds how far back a hole
 *  stays healable: a day that falls out of this trailing window needs a manual `force` export.
 *  Mirrors cycle-service.ts's `MAX_BACKFILL_WEEKS` — same shape, daily instead of weekly. */
export const MAX_BACKFILL_DAYS = 14;

/**
 * Every UTC day in the trailing MAX_BACKFILL_DAYS window before `throughDate` (exclusive — the
 * caller exports that one separately) that has NO success row, i.e. was missed. Oldest-first.
 *
 * ⛔ This deliberately enumerates the window and subtracts what succeeded, rather than walking
 * forward from `max(export_date)`. Walking forward from the newest success is the obvious
 * implementation and it is WRONG: it can only ever see holes at the END of the sequence, so an
 * INTERIOR hole — a single missed day that later days then leapfrogged — is invisible forever and
 * never heals. That is not hypothetical. Prod on 2026-08-04 held a success for every day from
 * 07-17 to 08-02 EXCEPT 07-30; with a forward walk from 08-02, `missing` is `[]` and 07-30 stays a
 * permanent compliance hole no matter how many ticks run. Interior holes are in fact the NORMAL
 * shape here, because the per-day claim means one starved day does not stop later days succeeding.
 *
 * Days before the OLDEST success are excluded: they predate the export system and there is no
 * archive owed for them. A fresh install (nothing ever succeeded) returns `[]` for the same reason
 * — same reasoning as `backfillMissedCycles` returning early on an empty `marketplace_cycles`.
 */
export async function missingExportDays(
  throughDate: string,
  database: Db = defaultDb,
): Promise<string[]> {
  const [bounds] = await database
    .select({
      newest: sql<string | null>`max(${auditExports.export_date})`,
      oldest: sql<string | null>`min(${auditExports.export_date})`,
    })
    .from(auditExports)
    .where(eq(auditExports.status, 'success'));
  if (!bounds?.newest || !bounds.oldest) return [];

  // Candidate window: the MAX_BACKFILL_DAYS days ending just before throughDate, clamped so we
  // never propose a day older than the first archive that ever succeeded.
  const candidates: string[] = [];
  let d = throughDate;
  for (let i = 0; i < MAX_BACKFILL_DAYS; i++) {
    d = prevDay(d);
    // 'YYYY-MM-DD' is fixed-width and zero-padded, so `<` is chronological.
    if (d < bounds.oldest) break;
    candidates.push(d);
  }
  if (!candidates.length) return [];

  const done = await database
    .select({ date: auditExports.export_date })
    .from(auditExports)
    .where(and(eq(auditExports.status, 'success'), inArray(auditExports.export_date, candidates)));
  const succeeded = new Set(done.map((r) => r.date));

  // candidates was built newest-first; the caller exports oldest-first.
  const missing = candidates.filter((c) => !succeeded.has(c)).reverse();
  if (missing.length) {
    log.warn('audit_export_days_missing', {
      component: 'audit-export',
      missingCount: missing.length,
      maxBackfillDays: MAX_BACKFILL_DAYS,
      throughDate,
      missing,
    });
  }
  return missing;
}

export interface ExportBundle {
  ndjson: string;
  manifest: Record<string, unknown>;
  manifestJson: string;
  sha256: string;
  rowCount: number;
  policyChangeCount: number;
  bytes: number;
}

/**
 * Page audit_log for the day → NDJSON (one JSON row per line, ordered by created_at,id),
 * compute its sha256, and build the manifest. Paging keeps memory bounded; the row count
 * is reported (never a silent truncation).
 */
export async function buildExportBundle(
  date: string,
  generatedAt: Date,
  database: Db = defaultDb,
): Promise<ExportBundle> {
  const { start, end } = dayWindowUtc(date);
  const window = and(gte(auditLog.created_at, start), lt(auditLog.created_at, end));

  const lines: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await database
      .select()
      .from(auditLog)
      .where(window)
      .orderBy(asc(auditLog.created_at), asc(auditLog.id))
      .limit(PAGE)
      .offset(offset);
    for (const row of rows) lines.push(JSON.stringify(row));
    if (rows.length < PAGE) break;
  }
  // Trailing newline so the file is a clean NDJSON stream (and empty days → '').
  const ndjson = lines.length ? lines.join('\n') + '\n' : '';
  const sha256 = createHash('sha256').update(ndjson, 'utf8').digest('hex');
  const bytes = Buffer.byteLength(ndjson, 'utf8');

  const pcRows = await database
    .select({ value: count() })
    .from(policyChanges)
    .where(and(gte(policyChanges.created_at, start), lt(policyChanges.created_at, end)));
  const policyChangeCount = Number(pcRows[0]?.value ?? 0);

  const manifest: Record<string, unknown> = {
    app: 'commonpractice',
    artifact: 'audit_log_export',
    schema_version: SCHEMA_VERSION,
    date,
    generated_at: generatedAt.toISOString(),
    audit_row_count: lines.length,
    policy_change_count: policyChangeCount,
    sha256,
    bytes,
    body_object: 'audit_log.ndjson',
  };
  return {
    ndjson,
    manifest,
    manifestJson: JSON.stringify(manifest, null, 2),
    sha256,
    rowCount: lines.length,
    policyChangeCount,
    bytes,
  };
}

/** The default uploader: storage_service via the egress-gated writer, from config. */
function defaultUploader(): Uploader {
  const cfg: StorageWriterConfig = {
    baseUrl: config.auditExport.storageUrl,
    bucket: config.auditExport.bucket,
    token: config.auditExport.token || undefined,
  };
  return async (objectKey, body, contentType) => {
    await uploadObject(cfg, objectKey, body, contentType);
  };
}

/**
 * Export one day end-to-end: gate on idempotency → claim the row (status=running) →
 * build the bundle → upload NDJSON + manifest → mark success/error → audit. Returns a
 * structured result; never throws on an export failure (it is recorded instead).
 */
export async function runExport(args: RunExportArgs, deps: ExportDeps = {}): Promise<ExportResult> {
  const database = deps.db ?? defaultDb;
  const now = deps.now ?? (() => new Date());
  const uploader = deps.uploader ?? defaultUploader();
  const { date, triggeredBy, actorId = null, force = false } = args;

  // Idempotency: a prior SUCCESS for this day short-circuits (unless a manual force).
  const [existing] = await database
    .select()
    .from(auditExports)
    .where(eq(auditExports.export_date, date));
  if (existing?.status === 'success' && !force) {
    return {
      date,
      status: 'skipped',
      reason: 'already_exported',
      rowCount: existing.row_count,
      objectKey: existing.object_key ?? undefined,
      bucket: existing.bucket ?? undefined,
      sha256: existing.sha256 ?? undefined,
    };
  }

  // Claim the day: insert-or-reset to running (UNIQUE(export_date) makes this the guard).
  const startedAt = now();

  // ⛔ `audit_exports.actor_id` IS A FK TO `users.id` (schema.ts:1191) AND THIS INSERT SITS OUTSIDE
  // THE TRY BLOCK BELOW. A super_admin granted directly in Keycloak has no local `users` row
  // (`requireSuperAdmin` runs `authenticateWithoutLicense`, which never calls `ensureUser`), so the
  // 23503 propagated unhandled: `POST /api/audit/export` returned a bare 500 AND — because the
  // claim is what creates the row — left NO `audit_exports` row, so the attempt was invisible the
  // moment the response was gone. `auditActorId` degrades that actor to System (a NULL the FK
  // accepts) instead of losing the whole run; the acting subject is carried in the audit row's
  // metadata below, which is where `auditActorId`'s contract says it belongs.
  const claimActorId = await auditActorId(actorId, database);

  try {
    await database
      .insert(auditExports)
      .values({ export_date: date, status: 'running', triggered_by: triggeredBy, actor_id: claimActorId, started_at: startedAt })
      .onConflictDoUpdate({
        target: auditExports.export_date,
        set: { status: 'running', triggered_by: triggeredBy, actor_id: claimActorId, started_at: startedAt, error: null },
      });
  } catch (err) {
    // Belt AND braces: `auditActorId` removes the known cause, but the claim is the ONE statement
    // whose failure destroys the evidence of its own failure, so it must not be able to 500 the
    // endpoint for ANY reason. Leave the only trace still available (an audit row) and report the
    // failure as a result, the same way every other export failure is reported.
    const message = err instanceof Error ? err.message : String(err);
    await recordAudit(
      {
        actorId: claimActorId,
        action: 'audit.export',
        category: 'system',
        targetType: 'audit_export',
        targetId: date,
        result: 'Export claim failed',
        resultTone: 'error',
        metadata: { date, error: message, triggeredBy, actorSub: actorId },
      },
      database,
    );
    log.error('audit_export_claim_failed', { component: 'audit-export', date, error: message });
    return { date, status: 'error', reason: 'claim_failed', error: message };
  }

  const prefix = dayPrefix(config.auditExport.keyPrefix, date);
  const bodyKey = `${prefix}/audit_log.ndjson`;
  const manifestKey = `${prefix}/manifest.json`;
  const bucket = config.auditExport.bucket;

  try {
    const bundle = await buildExportBundle(date, startedAt, database);
    await uploader(bodyKey, bundle.ndjson, 'application/x-ndjson');
    await uploader(manifestKey, bundle.manifestJson, 'application/json');

    await database
      .update(auditExports)
      .set({
        status: 'success',
        row_count: bundle.rowCount,
        object_key: manifestKey,
        bucket,
        sha256: bundle.sha256,
        bytes: bundle.bytes,
        error: null,
        finished_at: now(),
      })
      .where(eq(auditExports.export_date, date));

    await recordAudit(
      {
        // Already resolved against `users` for the claim — reuse it rather than let the same FK
        // cost this row too. `actorSub` keeps the acting subject when it degraded to System.
        actorId: claimActorId,
        action: 'audit.export',
        category: 'system',
        targetType: 'audit_export',
        targetId: date,
        result: `Exported ${bundle.rowCount} rows`,
        resultTone: 'ok',
        metadata: { date, bucket, objectKey: manifestKey, sha256: bundle.sha256, triggeredBy, actorSub: actorId },
      },
      database,
    );

    log.info('audit_export_exported', {
      component: 'audit-export',
      rowCount: bundle.rowCount,
      date,
      bucket,
      manifestKey,
    });
    return {
      date,
      status: 'success',
      rowCount: bundle.rowCount,
      policyChangeCount: bundle.policyChangeCount,
      objectKey: manifestKey,
      bucket,
      sha256: bundle.sha256,
      bytes: bundle.bytes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await database
      .update(auditExports)
      .set({ status: 'error', error: message, finished_at: now() })
      .where(eq(auditExports.export_date, date));
    await recordAudit(
      {
        actorId: claimActorId,
        action: 'audit.export',
        category: 'system',
        targetType: 'audit_export',
        targetId: date,
        result: 'Export failed',
        resultTone: 'error',
        metadata: { date, bucket, error: message, triggeredBy, actorSub: actorId },
      },
      database,
    );
    log.error('audit_export_failed', { component: 'audit-export', date, error: message });
    return { date, status: 'error', error: message };
  }
}
