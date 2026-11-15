// src/datasets/connector-refresh.ts — the host-side connector refresh worker.
// Materialize-on-refresh: fetch the live source read-only (through the egress guard),
// parse to typed {columns, rows}, replaceRows() into dataset_rows, and update the
// connector's status/last_synced_at/sync_error. The runner is untouched — it serves
// the cached rows via ctx.dataset(slug) like any dataset.
//
// Concurrency: a Postgres SESSION advisory lock ensures two replicas — or an event + a
// manual sync racing — never double-fetch the same connector. A NOTIFY on completion
// drives the SSE UI update.
//
// ⛔ POOL BUDGET — WHY THE LOCK RIDES THE TENANT SESSION INSTEAD OF OWNING A CONNECTION.
// A session advisory lock has to be held on a specific connection, so this used to
// `queryClient.reserve()` one purely for the lock — and then ran the work under
// `withTenantDb`, which reserved a THIRD (the request already holds one). Three of the six
// request-pool slots for ONE in-flight sync, and `reserve()` queues forever with no timeout,
// so two concurrent syncs wedged the pod permanently — measured on a live PG18: 0/2 refreshes
// completed, and nothing ever released, so EVERY authenticated request on that pod hung until
// restart (the liveness probe cannot see it; /health is unauthenticated). Now the lock is taken
// on the connection the tenant session ALREADY holds — `withConnectorSession` reuses the
// request's when the tenant matches — so a sync adds ZERO request-pool connections on the
// request path, and exactly one on the detached listener path, which holds nothing else and
// therefore always drains. Same reasoning as host/tick-locks.ts (a lock must not cost a
// connection the work then needs) and host/run-controller.ts.
import { eq } from 'drizzle-orm';
import type { ReservedSql } from 'postgres';
import { db, datasets, queryClient, runAsSystem, withTenantDb } from '../db/client';
import { currentDbContext } from '../db/tenant-context';
import { getSnapshot } from '../host/policy-store';
import { recordAudit } from '../host/audit-service';
import { EgressBlockedError } from '../host/egress-guard';
import { HttpError } from '../utils/http';
import { log } from '../host/logger';
import { isConnectorSource, mergeRefreshedColumns } from '../db/dataset-types';
import { replaceRows } from './dataset-service';
import { byteSize } from './parse/infer';
import { fetchConnector } from './connectors';
import { loadConnectorConfig } from './connector-service';

/** Advisory-lock namespace (arbitrary, constant) for connector refreshes. */
const LOCK_NS = 0x6370; // 'cp'
export const CHANNEL_REFRESH = 'cp_connector_refresh';
export const CHANNEL_SYNCED = 'cp_connector_synced';

export interface RefreshOutcome {
  ok: boolean;
  skipped?: boolean;
  rowCount?: number;
  truncated?: number;
  reason?: string;
}

/**
 * Establish a tenant-scoped DB session for the refresh, REUSING the caller's reserved connection
 * when it is already bound to this exact tenant instead of reserving a second one.
 *
 * Both request-path call sites (`routes/connectors.ts` — create-then-sync and the manual sync
 * route) run inside server.ts's `withTenantDb`, which has already reserved one of the six request
 * connections and set `app.current_tenant` to this same tenant. Re-binding it is a pure no-op, so
 * the nested reserve bought nothing and cost a slot.
 *
 * ⛔ WHY THIS REUSE IS LOCAL AND NOT A CHANGE TO `withTenantDb` ITSELF. AsyncLocalStorage
 * propagates into DETACHED work, so a generic reuse inside withTenantDb is unsafe: the run pump is
 * launched as `void spawnAndPump(...)` (host/run-controller.ts) and keeps running after its request
 * returns, so its `withTenantDb(handle.tenantId, …)` would reuse a connection the request has
 * already GUC-reset and released. That was measured — it fails 12 of runs.test.ts. Refreshes are
 * safe precisely because BOTH call sites `await` this to completion inside the request's own scope,
 * so the connection cannot be released underneath us.
 *
 * `enforceRuntimeRole` contexts (integration tests that SET ROLE cp_app) are deliberately excluded:
 * reusing would silently run the refresh under a different role than it does today. Production is
 * unaffected — DATABASE_URL is already cp_app there, so the flag is always false.
 */
async function withConnectorSession<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const outer = currentDbContext();
  if (
    outer &&
    !outer.system &&
    outer.reserved &&
    outer.tenantId === tenantId &&
    !outer.enforceRuntimeRole
  ) {
    return fn();
  }
  return withTenantDb(tenantId, fn);
}

/** The connection the current tenant session holds. `withConnectorSession` always establishes one,
 *  so this is only ever undefined if called outside that scope — a programming error, surfaced
 *  loudly rather than silently reserving a connection nobody budgeted for. */
function sessionConnection(): ReservedSql {
  const reserved = currentDbContext()?.reserved;
  if (!reserved) throw new Error('connector refresh requires an active tenant DB session');
  return reserved;
}

/** Run `fn` while holding the per-connector session advisory lock, or skip if another holder has
 *  it (returns {skipped}). The lock rides the tenant session's existing connection — see the pool
 *  note at the top of this file — so it is held for the whole fetch without costing a connection
 *  and without pinning a transaction open across the network call.
 *
 *  MUST be called inside `withConnectorSession`: the lock and the work it guards then share one
 *  connection, so the lock cannot outlive (or starve) the work. */
async function withConnectorLock(
  connectorId: string,
  fn: () => Promise<RefreshOutcome>,
): Promise<RefreshOutcome> {
  const reserved = sessionConnection();
  const got = await reserved<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${LOCK_NS}, hashtext(${connectorId})) AS locked`;
  if (!got[0]?.locked) return { ok: false, skipped: true, reason: 'locked' };
  try {
    return await fn();
  } finally {
    await reserved`SELECT pg_advisory_unlock(${LOCK_NS}, hashtext(${connectorId}))`;
  }
}

/** Send a NOTIFY on the connection the caller already holds, falling back to the pool only when
 *  there is no tenant session (the secret-authed event ingress carries no JWT, so it has none).
 *
 *  ⛔ NOT `queryClient.notify`: that asks the request pool for a connection, and inside a refresh
 *  every slot can already be reserved — this was the third holder that turned the sync wedge into
 *  a hang at just TWO concurrent syncs, and it hung in the one place a failure is invisible (a
 *  best-effort notify at the very end of a successful sync). */
async function pgNotify(channel: string, payload: string): Promise<void> {
  const reserved = currentDbContext()?.reserved;
  if (reserved) {
    await reserved`SELECT pg_notify(${channel}, ${payload})`;
    return;
  }
  await queryClient.notify(channel, payload);
}

/** Emit the "this connector finished syncing" event for the SSE fan-out. */
async function notifySynced(connectorId: string): Promise<void> {
  try {
    await pgNotify(CHANNEL_SYNCED, connectorId);
  } catch (err) {
    log.error('notify_synced_failed', { component: 'connector', err });
  }
}

/**
 * Refresh one connector. Safe to call from the create path, the manual-sync route, and
 * the event listener — it claims the advisory lock and no-ops if already running.
 */
export async function refreshConnector(
  connectorId: string,
  opts: { actorId?: string } = {},
): Promise<RefreshOutcome> {
  // refreshConnector is called from the request path (manual sync / create — already tenant-scoped)
  // AND from the detached NOTIFY listener (no request → no tenant GUC). Resolve the connector's
  // tenant as SYSTEM first, then run the whole refresh under withTenantDb so every datasets
  // read/update passes RLS and the dataset_rows inserts (tenant_id defaults to the GUC) stamp the
  // right tenant. On the request path that re-bind is a no-op and now reuses the request's own
  // connection rather than reserving a second one (see withConnectorSession).
  //
  // The tenant lookup is a single statement on the OWNER pool, holding nothing. Resolving it before
  // the lock (it used to be after) is deliberate: the lock has to live on the tenant session's
  // connection, and we cannot open that session until we know the tenant. Mutual exclusion is
  // unaffected — the lock still spans the entirety of `doRefresh`, which is the only thing that
  // reads the source or writes rows.
  const tenantId = await runAsSystem('platform-admin', async () => {
    const [row] = await db
      .select({ tenantId: datasets.tenant_id })
      .from(datasets)
      .where(eq(datasets.id, connectorId));
    return row?.tenantId ?? null;
  });
  if (!tenantId) return { ok: false, reason: 'not_found' };
  return withConnectorSession(tenantId, () =>
    withConnectorLock(connectorId, () => doRefresh(connectorId, opts)),
  );
}

/** The tenant-scoped refresh body (always invoked inside withConnectorSession + the advisory
 *  lock — see refreshConnector). */
async function doRefresh(
  connectorId: string,
  opts: { actorId?: string },
): Promise<RefreshOutcome> {
    const [conn] = await db.select().from(datasets).where(eq(datasets.id, connectorId));
    if (!conn) return { ok: false, reason: 'not_found' };
    if (!isConnectorSource(conn.source_type) || !conn.connection_config_encrypted) {
      return { ok: false, reason: 'not_a_connector' };
    }
    const actorId = opts.actorId ?? conn.owner_id;
    const connMeta = conn.connection_meta;
    const host = connMeta?.host;
    // Non-secret target identifiers — WHAT was read — so a sync audit row alone can
    // reconstruct an incident (e.g. a path-traversal exploit like #170) without needing the
    // encrypted config. Mirrors connector.create's audit metadata (routes/connectors.ts).
    const storageTarget =
      connMeta?.kind === 'storage' ? { bucket: connMeta.bucket, key: connMeta.key } : {};

    await db
      .update(datasets)
      .set({ status: 'syncing', updated_at: new Date() })
      .where(eq(datasets.id, connectorId));

    try {
      const cfg = loadConnectorConfig(conn);
      const snapshot = await getSnapshot();
      const parsed = await fetchConnector(cfg, snapshot);
      if (parsed.truncated > 0) {
        log.warn('connector_truncated_rows', {
          component: 'connector',
          slug: conn.slug,
          truncated: parsed.truncated,
        });
      }
      await replaceRows(connectorId, parsed.rows);
      // Merge, don't overwrite: a human may have PATCHed pii:true on a column via
      // PATCH /api/datasets/:slug (or the UI's "PII" toggle), and this refresh runs on
      // every manual sync AND the webhook ingress (routes/connectors.ts, secret-authed
      // only). Re-inferring from scratch on every sync must never silently discard
      // that correction — see mergeRefreshedColumns' doc for the exact contract.
      const merged = mergeRefreshedColumns(conn.columns, parsed.columns);
      await db
        .update(datasets)
        .set({
          columns: merged.columns,
          row_count: parsed.rows.length,
          size_bytes: byteSize(parsed.rows),
          status: 'ready',
          // All THREE clear together. A success that left `sync_error_code` behind would render
          // last week's refusal beside a green "ready" badge — the state the English column was
          // always careful to clear.
          sync_error: null,
          sync_error_code: null,
          sync_error_detail: null,
          last_synced_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(datasets.id, connectorId));

      await recordAudit({
        actorId,
        action: 'connector.sync',
        category: 'data',
        targetType: 'dataset',
        targetId: conn.slug,
        result: `Synced · ${parsed.rows.length} rows`,
        resultTone: 'ok',
        metadata: {
          kind: conn.source_type,
          host,
          rowCount: parsed.rows.length,
          truncated: parsed.truncated,
          // Only present when the source's shape actually changed / a human PII flag
          // had to be protected from being dropped — keeps routine syncs quiet.
          ...(merged.added.length ? { columnsAdded: merged.added } : {}),
          ...(merged.removed.length ? { columnsRemoved: merged.removed } : {}),
          ...(merged.piiPreserved.length ? { piiPreserved: merged.piiPreserved } : {}),
          // A live source can grow a duplicate column name between syncs (a SELECT joining two
          // tables that both have `id`, a re-exported sheet). Disambiguated at parse like an
          // upload; recorded here so a schema that changed shape on its own is never silent.
          ...(parsed.renamedColumns.length ? { renamedColumns: parsed.renamedColumns } : {}),
          ...storageTarget,
        },
      });
      await notifySynced(connectorId);
      return { ok: true, rowCount: parsed.rows.length, truncated: parsed.truncated };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof EgressBlockedError
          ? err.code
          : err instanceof HttpError
            ? err.code
            : 'sync_failed';
      await db
        .update(datasets)
        .set({
          status: 'error',
          // ⛔ ENGLISH PROSE, PERSISTED — and KEPT, not replaced. This column is served to the MCP
          // reader (ai/mcp/tools.ts `describe_data`), where English is the right answer, and it is
          // the fall-through for any code whose catalog entry needs a field the bag below does not
          // carry. What it must NOT be any more is the only thing /connectors has to render: the
          // browser was handed this sentence verbatim inside an otherwise fully-Dutch page, and
          // because this is a COLUMN and not a response it stayed English across reloads until the
          // next successful sync. See migration 0074.
          sync_error: `${code}: ${reason}`.slice(0, 500),
          // The machine half — the reader's browser composes the sentence from these
          // (frontend/src/lib/api/error-message.ts `syncErrorText`). `code` is exactly what the
          // audit row two calls below already records, so the two cannot drift apart.
          sync_error_code: code,
          // ⛔ THE RAISE SITE'S OWN FIELDS, SPREAD LAST. `{ host, reason }` alone is not enough for
          // every code: three of the catalog entries behind `syncErrorText` need a field only the
          // THROWER knew, and an entry that cannot find its field returns null, which lands the
          // reader back on the English `sync_error` column above. The fields were never missing —
          // this catch was discarding them. `HttpError.details` is exactly what `route()` already
          // forwards to a 4xx body and what `/api/connectors/test` re-emits as `params`, so the
          // sync path now carries the same shape the other two do.
          //
          // ⛔ SPREAD ORDER IS LOAD-BEARING. `reason` above is `err.message` (English prose); a
          // thrower that supplies its own snake_case `reason` DISCRIMINATOR must win, because that
          // is what `byReason()` switches on. Spreading last does that, and leaves the prose in
          // place for every thrower that supplies none.
          //
          // ⚠️ WHAT THIS ACTUALLY REACHES ON A SYNC — verified per raise site, not assumed:
          //   • `storage_format_unknown` ({ key }) — connectors/storage.ts, inside `fetchStorage`.
          //   • `xlsx_too_large` ({ actualMb, limitMb }) — parse/xlsx.ts, inside the parse path.
          //   • `bad_config` — `validateConnectorConfig` is called ONLY from routes/connectors.ts
          //     (the save and test endpoints), so 7 of its 8 reasons CANNOT occur on a sync. The
          //     8th, `reason: 'key_escapes_bucket'` ({ reason, resolved }), is re-asserted at
          //     request time inside `fetchStorage` and IS reachable here.
          // `EgressBlockedError` carries no `details` at all and is unaffected by this.
          sync_error_detail: {
            host,
            reason,
            ...(err instanceof HttpError ? (err.details ?? {}) : {}),
          },
          updated_at: new Date(),
        })
        .where(eq(datasets.id, connectorId));
      await recordAudit({
        actorId,
        action: 'connector.sync',
        category: 'data',
        targetType: 'dataset',
        targetId: conn.slug,
        result: `Sync failed · ${code}`,
        resultTone: 'error',
        metadata: { kind: conn.source_type, host, code, reason, ...storageTarget },
      });
      await notifySynced(connectorId);
      return { ok: false, reason: code };
    }
}

/** Emit a refresh-request event (used by the event ingress so any replica picks it up
 *  via LISTEN, and the work is serialized by the advisory lock). */
export async function requestRefresh(connectorId: string): Promise<void> {
  await pgNotify(CHANNEL_REFRESH, connectorId);
}
