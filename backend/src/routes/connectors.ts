// src/routes/connectors.ts — the live data-connector API (Phase 2-A). A connector is a
// dataset with a live source (postgres/storage/http) the host materializes on refresh.
// Owner-scoped CRUD + manual sync + event-secret rotation, all audited (category
// 'data'). Refresh is event-driven: POST /events (token-authed, NOT Keycloak) verifies
// a per-connector secret and asks any replica to refresh via Postgres NOTIFY. A GET
// /stream SSE pushes status changes to the UI so it never polls.
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, datasets, datasetRows, runAsSystem } from '../db/client';
import { ensureUser } from '../services/user-service';
import type { Dataset } from '../db/schema';
import { resolveTenant, type TenantContext } from '../middleware/tenant';
import { isSuperAdmin } from '../middleware/admin-guards';
import { assertTenantNotSuspended } from '../middleware/tenant-status-gate';
import { recordAudit } from '../host/audit-service';
import { log } from '../host/logger';
import { jsonResponse, readJson, route, notFound, badRequest, forbidden, unprocessable, HttpError } from '../utils/http';
import { likeTerm } from '../utils/search';
import { getSnapshot } from '../host/policy-store';
import {
  CONNECTOR_SOURCE_TYPES,
  isConnectorSource,
  type ConnectorEventSource,
  type ConnectorMeta,
  type ConnectorSourceType,
  DATASET_PREVIEW_ROWS,
} from '../db/dataset-types';
import { readRows } from '../datasets/dataset-service';
import { maskColumns, maskRows, memberMasks } from '../datasets/member-view';
// The DATASETS data-manager predicate (developer / tenant_admin / super_admin), NOT this file's
// connector-manager gate: raw VALUES follow who may classify the data, and a connector's rows are
// the same `dataset_rows` a dataset's are. See datasets/member-view.ts.
import { canManageData as canReadRawData } from './datasets';
import {
  validateConnectorConfig,
  metaFromConfig,
  fetchConnector,
  httpMetaOut,
} from '../datasets/connectors';
import {
  createConnector,
  rotateEventSecret,
  verifyEventSecret,
  findConnectorsByBucket,
  listStorageWebhookConnectorsInTenant,
  listAllStorageWebhookConnectors,
} from '../datasets/connector-service';
import { refreshConnector, requestRefresh } from '../datasets/connector-refresh';
import { EgressBlockedError } from '../host/egress-guard';
import { subscribeConnectorSynced } from '../datasets/connector-listener';
import { incCounter } from '../host/metrics';
import { connectorNotificationsConfig } from '../config';
import {
  registerConnectorNotification,
  deregisterConnectorNotification,
  bucketNotificationStatus,
} from '../host/storage-notify-client';
import type { Router } from '../utils/router';

// Buckets eligible for self-serve MinIO notification auto-registration. Only `cp-*` is
// covered by storage_service's wildcard IAM grant + the shared webhook target, so a
// webhook storage connector on any other bucket cannot be auto-wired (manual sync only).
const CP_BUCKET_RE = /^cp-[a-z0-9][a-z0-9-]{1,61}$/;

// Per-tenant bucket isolation (gated by CP_BUCKET_PER_TENANT_ISOLATION). A tenant's
// auto-registered storage buckets are namespaced `cp-<tenantToken>-<name>` so one tenant can
// never name (or auto-register against) another tenant's bucket. The token is a short, stable
// hash of the tenant UUID — 12 hex chars leave ~47 for the dataset name within MinIO's 63-char
// limit; collisions are negligible. storage_service's `cp-*` IAM grant covers it unchanged.
const TENANT_BUCKET_PREFIX_RE = /^cp-[0-9a-f]{12}-/;

function tenantBucketToken(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 12);
}

/**
 * Refuse a bucket that is namespaced to a DIFFERENT tenant.
 *
 * Unconditional by design — no feature flag gates it. `deriveTenantBucket` below already re-keys a
 * foreign prefix under the caller's own token, but that only runs when per-tenant isolation is
 * enabled; this is the floor that holds even with every flag off, and it fails LOUD (a 403 the
 * caller can see) rather than silently rewriting what they asked for.
 *
 * Legacy buckets stay grandfathered: they predate namespacing, carry no tenant token, and are
 * shared by design.
 */
function assertNotForeignTenantBucket(
  tenantId: string,
  bucket: string,
  legacyBuckets: readonly string[],
): void {
  if (legacyBuckets.includes(bucket)) return;
  const m = TENANT_BUCKET_PREFIX_RE.exec(bucket.trim().toLowerCase());
  if (!m) return; // not namespaced at all — nothing to compare against
  const own = `cp-${tenantBucketToken(tenantId)}-`;
  if (!bucket.trim().toLowerCase().startsWith(own)) {
    throw forbidden(
      'foreign_bucket',
      'That bucket belongs to another workspace. Use a bucket name of your own.',
    );
  }
}

/**
 * Resolve the bucket a storage connector may actually touch, for THIS caller.
 *
 * ⛔ SINGLE CHOKEPOINT, and it exists because fixing this in one route was not enough. #179 closed
 * the tenant-bucket hole in `createConnectorRoute` — and left `testConnectorRoute` wide open. That
 * route takes the same caller-supplied config, runs the same real `governedFetch` against
 * storage_service, and returned "Connected — read N columns, M rows" for ANOTHER TENANT'S OBJECT:
 * a working read-oracle over foreign data, independent of every feature flag, because it never
 * consulted the tenant at all. Fixing the bug where it was found rather than the THREAT across
 * every entry point is how that happened; both routes now go through here, so a third caller
 * cannot quietly reintroduce it.
 *
 * Behaviour matches what create persists, deliberately: with isolation ON a foreign/plain name is
 * re-keyed under the caller's OWN token (so a copy-pasted name quietly becomes theirs — friendlier
 * than a 403, and it means a `/test` probe predicts exactly what `create` would do); with isolation
 * OFF there is no re-keying, so a foreign namespaced bucket is refused outright. Legacy shared
 * buckets stay grandfathered in both modes.
 *
 * Returns the effective bucket. Callers MUST use the returned value, not `config.bucket`.
 */
function resolveOwnedStorageBucket(
  tenantId: string,
  bucket: string,
  notifyCfg: { perTenantIsolation: boolean; legacyBuckets: readonly string[] },
): string {
  if (notifyCfg.legacyBuckets.includes(bucket)) return bucket;
  if (!notifyCfg.perTenantIsolation) {
    assertNotForeignTenantBucket(tenantId, bucket, notifyCfg.legacyBuckets);
    return bucket;
  }
  return deriveTenantBucket(tenantId, bucket);
}

/** Test seam: this is a tenant boundary and it was silently unenforced on the default path, so it
 *  gets pinned directly rather than only through a route. */
export const __bucketOwnershipForTests = assertNotForeignTenantBucket;

/** Derive a tenant-namespaced bucket from a user-supplied name. Strips a leading `cp-` and any
 *  tenant prefix (including a FOREIGN one) so the result is always re-keyed under the caller's
 *  own token, then sanitizes to a MinIO-safe slug. Throws on an empty/over-long result. */
function deriveTenantBucket(tenantId: string, rawBucket: string): string {
  const token = tenantBucketToken(tenantId);
  const name = rawBucket
    .trim()
    .toLowerCase()
    .replace(TENANT_BUCKET_PREFIX_RE, '') // drop our own or a foreign cp-<token>- prefix
    .replace(/^cp-/, '') // drop a bare cp-
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // `bucket_convention` carries four distinct sentences; `reason` is what tells them apart.
  if (!name) throw badRequest('bucket_convention', 'a dataset name is required', { reason: 'name_required' });
  const bucket = `cp-${token}-${name}`;
  if (bucket.length > 63) {
    throw badRequest('bucket_convention', 'dataset name is too long for a bucket', {
      reason: 'name_too_long',
    });
  }
  return bucket;
}

const PAGE_SIZE = 12;
const CONNECTOR_TYPES = [...CONNECTOR_SOURCE_TYPES];


/** Resolve a connector by slug within the caller's tenant, or 404. Phase 3.5: connectors
 *  are a tenant-shared resource (a connector is a dataset with a live source), so reads
 *  scope by tenant_id — mirroring the 3.6 datasets model. */
async function loadConnectorInTenant(tenantId: string, slug: string): Promise<Dataset> {
  const [d] = await db
    .select()
    .from(datasets)
    .where(
      and(
        eq(datasets.tenant_id, tenantId),
        eq(datasets.slug, slug),
        inArray(datasets.source_type, CONNECTOR_TYPES),
      ),
    );
  if (!d) throw notFound('connector_not_found', `No connector '${slug}'`);
  return d;
}

/** May the caller manage live connectors? A connector materializes a TEST source into the org's
 *  shared data pool, so only an org admin (IT) / platform may add/sync/rotate/delete one.
 *  SPEC §5: connectors are governance-gated, test-source-only.
 *
 *  ⛔ NOT "the same gate as datasets", though this comment said so for a long time and the two
 *  functions share a NAME. `routes/datasets.ts`'s `canManageData` is `isDeveloper(ctx.user)`,
 *  which is `tenant_admin || super_admin || developer` (middleware/admin-guards.ts:39-41). This
 *  one deliberately EXCLUDES `developer`. Measured 2026-08-26 against a `member,developer`
 *  identity: `POST /api/datasets` → 422 (allowed, body invalid) while `POST /api/connectors` →
 *  403. The divergence is intended — a dataset is local test data, a connector reaches a LIVE
 *  external source over the egress allowlist — but the false claim was an invitation to
 *  "harmonize" the two, which would either hand every developer a live egress connector or lock
 *  developers out of their own test data. Both files also throw the SAME `data_manager_required`
 *  code, so the wire cannot tell them apart either; the shared localized copy
 *  (`error_data_manager_required`) is deliberately worded to cover both. */
function canManageData(ctx: TenantContext): boolean {
  return ctx.role === 'tenant_admin' || isSuperAdmin(ctx.user);
}

async function requireDataManager(req: Request): Promise<TenantContext> {
  const ctx = await resolveTenant(req);
  if (!canManageData(ctx)) {
    throw forbidden('data_manager_required', 'Only an org admin (IT) may manage live connectors');
  }
  return ctx;
}

/** Sanitize on read too, belt-and-braces: `metaFromConfig` now derives an `http` connector's meta
 *  as host+format only (see `httpMetaOut`'s design comment in datasets/connectors/index.ts), but
 *  a row written before that redesign — or by some future path that bypasses `metaFromConfig` —
 *  could still carry a `url` key (raw, or partially redacted by the blocklist that redesign
 *  replaced) in `connection_meta`. `httpMetaOut` only ever reads `host`/`format` off its input and
 *  constructs a fresh object, so applying it here unconditionally drops any such `url` regardless
 *  of what's actually stored — idempotent and costs nothing for already-clean rows. */
function redactMeta(meta: Dataset['connection_meta']): Dataset['connection_meta'] {
  if (meta?.kind === 'http') {
    return httpMetaOut(meta);
  }
  return meta;
}

/** Client projection of a connector (NEVER includes the secret config/event secret). */
function connectorOut(d: Dataset) {
  return {
    id: d.id,
    slug: d.slug,
    name: d.name,
    sourceType: d.source_type as ConnectorSourceType,
    status: d.status,
    eventSource: (d.event_source ?? 'none') as ConnectorEventSource,
    meta: redactMeta(d.connection_meta) ?? null,
    columns: d.columns ?? [],
    rowCount: d.row_count,
    sizeBytes: d.size_bytes,
    sandboxId: d.sandbox_id,
    lastSyncedAt: d.last_synced_at,
    // ⛔ ALL THREE, AND THE ENGLISH ONE IS NOT DEPRECATED. `syncError` is the server's own sentence
    // and stays on the wire as the reader's fall-through (every row written before 0074 has no
    // code, and a code whose catalog entry needs a field `syncErrorDetail` does not carry lands
    // there too). `syncErrorCode` + `syncErrorDetail` are what let the BROWSER write the sentence
    // instead of rendering English inside a Dutch page — see error-message.ts `syncErrorText`.
    syncError: d.sync_error,
    syncErrorCode: d.sync_error_code,
    syncErrorDetail: d.sync_error_detail ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function ingestUrl(req: Request, connectorId: string): string {
  const origin = new URL(req.url).origin;
  return `${origin}/api/connectors/events?connector=${connectorId}`;
}

// ---- POST /api/connectors ----
const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    sourceType: z.enum(['postgres', 'storage', 'http']),
    config: z.record(z.string(), z.unknown()),
    eventSource: z.enum(['webhook', 'pg_notify', 'none']).optional(),
    sandboxId: z.string().uuid().nullable().optional(),
  })
  .strict();

// ---- POST /api/connectors/test (validate-before-save, non-persisting) ----
// Runs the SAME read-only fetch a real sync would (egress-gated inside fetchConnector), against
// the supplied draft config — WITHOUT creating a connector or storing anything. Lets an admin
// confirm a Postgres/HTTP/storage source works before committing it. Returns 200 {ok, detail}: a
// bad config or unreachable source is a normal test result (ok:false), not an HTTP error.
const testSchema = z
  .object({
    sourceType: z.enum(['postgres', 'storage', 'http']),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

const testConnectorRoute = route(async (req) => {
  const ctx = await requireDataManager(req);
  const body = testSchema.parse(await readJson(req));
  let cfg;
  try {
    cfg = validateConnectorConfig(body.sourceType, body.config);
  } catch (e) {
    // ⛔ THE CODE IS ALREADY MACHINE-READABLE HERE — `HttpError.code` is exactly the stable token
    // this endpoint's contract asks for, so it is forwarded rather than re-invented. The frontend
    // localizes the ones it knows and falls back to `detail` for the rest; that code space belongs
    // to `validateConnectorConfig` and is genuinely open, which is why the wire type is `string`.
    //
    // ⛔ `details` MUST BE FORWARDED AS `params`, and dropping it silently defeated the whole fix.
    // `bad_config` is ONE code over EIGHT different sentences, so `code` alone cannot choose a
    // localized string — `connection-test-label.ts` needs `params.reason` (and `params.field`) to
    // know which of the eight it is. This site forwarded `code` and `detail` only, so the label
    // module fell through to `detail` and a Dutch admin kept reading `'query' is required`. Caught
    // by probing the live endpoint after the throw sites had already been fixed; the unit tests
    // could not see it, because both halves were individually correct.
    if (e instanceof HttpError)
      return jsonResponse({
        ok: false,
        code: e.code,
        ...(e.details ? { params: e.details } : {}),
        detail: e.message ?? e.code,
      });
    throw e;
  }
  // ⛔ THE TENANT BOUNDARY APPLIES HERE TOO, and it did not until now.
  //
  // #179 closed the foreign-bucket hole in `createConnectorRoute` and left THIS route open. It
  // takes the same caller-supplied config, runs the same real `governedFetch` against
  // storage_service (a host that is legitimately egress-allowlisted, and which does NOT authorise
  // per-tenant in-cluster), and returned `Connected — read N columns, M rows` for ANOTHER TENANT'S
  // OBJECT. That is a working read-oracle over foreign data — existence, structure, row and column
  // counts — reachable by any tenant_admin, and independent of every feature flag, because this
  // route never consulted the tenant at all.
  //
  // Persisting nothing is NOT a defence: the fetch is real and its result is returned to the caller.
  // Both routes now resolve through the one chokepoint, so `/test` probes exactly what `create`
  // would persist — which also makes the probe's answer honest rather than misleading.
  if (cfg.kind === 'storage') {
    try {
      cfg.bucket = resolveOwnedStorageBucket(ctx.tenantId, cfg.bucket, connectorNotificationsConfig());
    } catch (e) {
      // Same forwarding as the config branch above, `params` included; here the code is
      // `foreign_bucket`, which `error-message.ts` already has localized copy for on its 403 path.
      if (e instanceof HttpError)
        return jsonResponse({
          ok: false,
          code: e.code,
          ...(e.details ? { params: e.details } : {}),
          detail: e.message ?? e.code,
        });
      throw e;
    }
  }
  // This is a REAL outbound fetch against a caller-supplied, never-persisted config — the
  // same egress-gated read a real sync would do. Without an audit row this endpoint is a
  // silent, repeatable probe: a bad actor can tune a payload against it (e.g. a storage
  // path-traversal attempt) and leave no trace, only auditing once they commit to a real
  // `connector.create`. Audit the ACTION + non-secret shape (kind/host, and bucket/key for
  // storage — never the config itself, which is exactly what carries the credential).
  //
  // ⛔ THIS LINE WAS A 500, AND IT SITS BETWEEN TWO BLOCKS THAT ALREADY GOT THIS RIGHT.
  // `metaFromConfig` → `parseTarget` throws `EgressBlockedError` on a URL the parser cannot read.
  // A half-typed address — `https://`, a scheme and nothing else — clears
  // `validateConnectorConfig`'s `/^https?:\/\//` check and then kills `new URL()`.
  // `EgressBlockedError extends Error`, NOT `HttpError`, and `route()` (utils/http.ts) maps only
  // HttpError / ZodError / UnauthorizedError / pg 22P02 — so it fell through to server.ts's bare
  // catch-all and this endpoint answered `500 {"error":"Internal Server Error"}`. On the endpoint
  // whose header says, in as many words, that "a bad config or unreachable source is a normal test
  // result (ok:false), not an HTTP error".
  let meta: ConnectorMeta;
  try {
    meta = metaFromConfig(cfg);
  } catch (e) {
    // Same forwarding shape as its two neighbours, so all three refusals leave this endpoint
    // looking identical on the wire: `ok:false` + a stable machine `code` + the diagnostic text.
    if (e instanceof EgressBlockedError)
      return jsonResponse({ ok: false, code: e.code, detail: e.message });
    throw e;
  }
  const auditMeta: Record<string, unknown> = { kind: body.sourceType, host: meta.host };
  if (meta.kind === 'storage') {
    auditMeta.bucket = meta.bucket;
    auditMeta.key = meta.key;
  }
  try {
    const snapshot = await getSnapshot();
    const result = await fetchConnector(cfg, snapshot);
    const cols = result.columns?.length ?? 0;
    const rows = result.rows?.length ?? 0;
    await recordAudit({
      actorId: ctx.user.id,
      action: 'connector.test',
      category: 'data',
      targetType: 'connector_draft',
      result: `Test ok · ${cols} col${cols === 1 ? '' : 's'}, ${rows} row${rows === 1 ? '' : 's'}`,
      resultTone: 'ok',
      metadata: auditMeta,
    });
    // ⛔ THE SUCCESS PATH IS THE ONE THAT MATTERED MOST, AND IT WAS THE LAST PLACE ANYONE LOOKED.
    // This response is HTTP 200 with `ok: true` — nothing throws, so the frontend's `errorText`
    // helper never runs — and it was a hand-built English sentence with hand-built English plurals
    // (`column${cols === 1 ? '' : 's'}`). A Dutch tenant admin testing a connector that WORKS read
    // "Connected — read 5 columns, 3 sample rows." The counts are the only facts here; the words
    // and the pluralisation belong to the reader's locale, and `${...=== 1 ? '' : 's'}` is not a
    // pluralisation rule that survives translation to Polish or Arabic anyway.
    return jsonResponse({
      ok: true,
      code: 'connector_test_ok',
      params: { cols, rows },
      detail: `Connected — read ${cols} column${cols === 1 ? '' : 's'}, ${rows} sample row${rows === 1 ? '' : 's'}.`,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await recordAudit({
      actorId: ctx.user.id,
      action: 'connector.test',
      category: 'data',
      targetType: 'connector_draft',
      result: `Test failed · ${detail}`.slice(0, 500),
      resultTone: 'warn',
      metadata: auditMeta,
    });
    // ⚠️ `detail` IS A PARAMETER HERE, NOT A FALLBACK, and that is a deliberate difference from
    // every other site. What `fetchConnector` throws is an arbitrary driver/transport message
    // ("connect ECONNREFUSED 10.0.0.4:5432") that no catalog can ever contain and that is the most
    // useful thing on the screen. Dropping it for a generic localized sentence would make the
    // message worse; so the FRAME is localized and the technical text is interpolated into it,
    // isolated for RTL by the frontend. Same call the graph-validation labels make.
    //
    // ⛔ BUT AN `HttpError` FROM `fetchConnector` IS NOT A DRIVER MESSAGE, and flattening it here
    // made three localized branches unreachable. `fetchConnector` raises its OWN typed refusals —
    // `unknown_connector` (datasets/connectors/index.ts), `storage_format_unknown` and
    // `bad_config`/`key_escapes_bucket` (datasets/connectors/storage.ts). Rewriting all of them to
    // `connector_test_failed` meant the catalog entries for those codes could never render on the
    // one screen that consumes them: dead copy in eight locale files, and a frontend test that
    // passed only because it hand-built the params bag this route never sends.
    //
    // The two catches above were given this forwarding and this one was missed — the same defect
    // class, one `try` further down. A typed refusal keeps its code and its facts; only an
    // untyped driver/transport failure becomes `connector_test_failed`.
    if (e instanceof HttpError)
      return jsonResponse({
        ok: false,
        code: e.code,
        ...(e.details ? { params: e.details } : {}),
        detail: e.message ?? e.code,
      });
    return jsonResponse({ ok: false, code: 'connector_test_failed', params: { detail }, detail });
  }
});

const createConnectorRoute = route(async (req) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  await ensureUser(user);
  const body = createSchema.parse(await readJson(req));

  const config = validateConnectorConfig(body.sourceType, body.config);
  const eventSource: ConnectorEventSource = body.eventSource ?? 'none';

  // Self-serve auto-registration applies to storage+webhook connectors when the feature is
  // enabled. Such connectors share the platform events secret (so the MinIO shared target's
  // bearer verifies) and require the `cp-*` bucket convention (IAM + shared-target covered).
  const notifyCfg = connectorNotificationsConfig();
  const autoRegister =
    config.kind === 'storage' && eventSource === 'webhook' && notifyCfg.enabled && !!notifyCfg.secret;
  // Per-tenant isolation: rewrite the requested bucket to cp-<tenantToken>-<name> BEFORE deriving
  // meta, so the stored bucket + the registered MinIO rule are both namespaced. Legacy buckets
  // (the cp-datasets demo) are grandfathered. Only runs on create; existing rows are untouched.
  //
  // ⛔ THIS IS A TENANT BOUNDARY, AND IT USED TO BE GATED ON `autoRegister`.
  //
  // `autoRegister` requires `eventSource === 'webhook'`, and `eventSource` DEFAULTS TO 'none'
  // (above). So every storage connector created without explicitly asking for webhooks — the
  // default, and the only option when notifications are off — took `config.bucket` VERBATIM from
  // client input, with no ownership check of any kind. A tenant_admin in tenant A could simply
  // TYPE tenant B's bucket name (`cp-<B-token>-datasets`); `refreshConnector` runs synchronously
  // on create and materialised B's object into A's own dataset rows, readable via
  // `GET /api/connectors/:slug`. No traversal, no encoding trick — just the front door, which the
  // `..`-traversal fix (#170) did not touch because it is a different bug entirely.
  //
  // PROVEN, not theorised: `storage_service` does NOT authorise per-tenant on the in-cluster path
  // (its own header calls it "trusted-network pass-through", and `cfg.token` is optional here).
  // An UNAUTHENTICATED in-cluster GET for a real namespaced object returned `200` with content.
  // CP is therefore the SOLE enforcement point for this boundary.
  //
  // Two layers now, deliberately:
  //  1. an UNCONDITIONAL rejection of a foreign tenant's namespaced bucket — it depends on no
  //     feature flag, because this repo has repeatedly been bitten by boundaries that turned out
  //     to hang off a switch someone could turn off (or that defaulted off and never ran);
  //  2. the existing re-keying, now applied to EVERY storage connector rather than only the
  //     webhook path, so a caller's bucket is always namespaced under their own token.
  if (config.kind === 'storage') {
    config.bucket = resolveOwnedStorageBucket(ctx.tenantId, config.bucket, notifyCfg);
  }
  // Derive the non-secret meta AFTER any bucket rewrite so it records the effective bucket.
  //
  // ⛔ SAME UNGUARDED THROW AS `/test`, DIFFERENT ANSWER. `metaFromConfig` → `parseTarget` throws
  // `EgressBlockedError` on an unparseable address, which `route()` cannot map, so a mistyped URL
  // was a bare 500 with no code the UI could localize and nothing persisted to explain it. Here a
  // refusal IS an HTTP error (unlike `/test`, whose whole contract is the opposite), so it maps to
  // 422 — the same status routes/delivery.ts:446 gives the same error class, for the same reason.
  //
  // ⛔ WHY THE CLASS IS NOT PROMOTED TO `HttpError` INSTEAD. `EgressBlockedError` is minted in
  // host/egress-guard.ts, shared by the connector-refresh path, the delivery path and the LLM
  // egress fetch; it knows about none of them. delivery.ts:446 maps it at the CALL SITE precisely
  // so it can attach `{ kind: target.kind }`, and connector-refresh.ts:259 reads `.code` off it
  // before its `HttpError` branch. Giving the class a baked-in status would hand every future call
  // site a silent default and delete the seam those two sites deliberately use.
  let meta: ConnectorMeta;
  try {
    meta = metaFromConfig(config);
  } catch (e) {
    if (e instanceof EgressBlockedError) throw unprocessable(e.code, e.message);
    throw e;
  }
  if (autoRegister && !CP_BUCKET_RE.test(config.bucket)) {
    throw badRequest(
      'bucket_convention',
      `storage webhook connectors require a 'cp-*' bucket for notification auto-registration`,
      { reason: 'webhook_needs_cp_bucket' },
    );
  }

  const { dataset, eventSecret } = await createConnector({
    ownerId: user.id,
    tenantId: ctx.tenantId,
    sandboxId: body.sandboxId ?? null,
    name: body.name.trim(),
    kind: body.sourceType,
    config,
    meta,
    eventSource,
    // Storage+webhook → reuse the shared platform secret (not a per-connector one) so a
    // single MinIO target can authenticate every storage connector's refresh trigger.
    eventSecret: autoRegister ? notifyCfg.secret : undefined,
  });

  // Best-effort: register the bucket-notification rule. A failure does NOT fail create —
  // the connector still syncs manually and can be re-registered later.
  const notifyRegistered =
    autoRegister && config.kind === 'storage'
      ? await registerConnectorNotification(config.bucket, config.key)
      : false;

  // Best-effort auto-register can silently fail (network/SSRF/non-2xx) without blocking create —
  // the connector still syncs manually. Surface that fallback in the logs so on-call has a signal.
  if (autoRegister && config.kind === 'storage' && !notifyRegistered) {
    // ⛔ THIS MESSAGE STRING IS PINNED BY A TEST, do not "tidy" it to snake_case in isolation.
    // `tests/connectors-self-serve.test.ts` intercepts `console.warn` and asserts the emitted line
    // includes the literal `notification auto-register failed` — that is the whole non-vacuity of
    // its "does not block create but IS logged" case. It is still a STABLE CONSTANT with every
    // variable part in fields, which is what makes it aggregatable; only the separator differs.
    // Renaming it needs the test changed in the same commit.
    log.warn('connector notification auto-register failed', {
      slug: dataset.slug,
      bucket: config.bucket,
      key: config.key,
    });
  }

  // Persist the registration outcome onto the row (plaintext JSONB, no migration) so the
  // connector list can show per-connector notify state and offer a manual re-register.
  if (autoRegister && config.kind === 'storage' && meta.kind === 'storage') {
    await db
      .update(datasets)
      .set({ connection_meta: { ...meta, notifyRegistered } })
      .where(eq(datasets.id, dataset.id));
  }

  await recordAudit({
    actorId: user.id,
    action: 'connector.create',
    category: 'data',
    targetType: 'dataset',
    targetId: dataset.slug,
    result: `Created · ${body.sourceType}`,
    resultTone: 'ok',
    // governance: connectors are test-source-only by policy (SPEC §5) — recorded for audit.
    // notifyRegistered (only for auto-register storage+webhook) records whether the MinIO
    // bucket-notification rule was wired, so a silent best-effort fallback is auditable.
    // bucket/key (storage only): the non-secret target identifiers — WHAT was read — so a
    // future incident (e.g. a path-traversal exploit like #170) is reconstructable from the
    // audit trail alone, without needing the encrypted config.
    metadata: {
      kind: body.sourceType,
      host: meta.host,
      eventSource,
      governance: 'test-source-only',
      ...(meta.kind === 'storage' ? { bucket: meta.bucket, key: meta.key } : {}),
      ...(autoRegister ? { notifyRegistered } : {}),
    },
  });

  // Materialize the first snapshot synchronously so the response reflects the result.
  const outcome = await refreshConnector(dataset.id, { actorId: user.id });
  const [fresh] = await db.select().from(datasets).where(eq(datasets.id, dataset.id));

  return jsonResponse(
    {
      ...connectorOut(fresh ?? dataset),
      // Auto-registered storage connectors use the SHARED platform secret and are wired
      // automatically, so we never echo that secret or an ingest URL to the client. Other
      // webhook connectors still surface their per-connector secret ONCE (not recoverable).
      eventSecret: autoRegister ? null : eventSecret,
      ingestUrl: eventSource === 'webhook' && !autoRegister ? ingestUrl(req, dataset.id) : null,
      notifyRegistered: autoRegister ? notifyRegistered : undefined,
      firstSync: outcome,
    },
    201,
  );
});

// ---- GET /api/connectors?q=&qSource=&source=&page= ----
const listConnectors = route(async (req) => {
  const ctx = await resolveTenant(req);
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

  // ⛔ `source` EXISTS BECAUSE THE SEARCH BOX COULD NOT FIND THE WORD IT PRINTS. The table renders
  // the source column through `sourceLabel()` — `m.connectors_source_storage()` is "Opslagdienst"
  // in the demo locale — and the `q` predicate below matches the stored ENUM (`storage`). A Dutch
  // reader typing the word on their own screen got "no match" with three rows carrying that badge
  // in front of them. The comment that used to sit over the `q` block said fixing this "means
  // giving the enum labels a DB-side representation, which is a schema change"; it is corrected in
  // the same commit, because there are exactly three enum members and the browser already owns
  // their translations. The page resolves the typed text against its OWN catalog and sends the
  // enum; nothing about the labels needs to reach Postgres.
  //
  // ⛔ A CLOSED ENUM, REFUSED RATHER THAN IGNORED, AND VALIDATED AGAINST THE EXPORTED CONSTANT.
  // Silently dropping an unrecognised `source` would answer a filtered request with an UNFILTERED
  // list — the failure mode where the reader is shown more than they asked for and told nothing.
  // `isConnectorSource` is `dataset-types.ts`'s own guard over `CONNECTOR_SOURCE_TYPES`, which is
  // the same constant `CONNECTOR_TYPES` above spreads, so a fourth connector kind is accepted here
  // the moment it exists and cannot drift from the list this route already filters on.
  //
  // ⚠️ AND IT IS AN `AND`, NOT A WIDENING OF `q`. `?source=storage&q=claims` must mean "storage
  // connectors whose text matches claims" — two independent narrowings. The PAGE never sends both
  // (a whole-input label match is a filter, not text to search for), but the API is a contract of
  // its own and the composable reading is the one a caller will assume.
  const parseSource = (raw: string | undefined, param: 'source' | 'qSource') => {
    if (!raw) return undefined;
    // The narrowing is the point: the result reaches the `eq()` below as a member of the enum,
    // not as an arbitrary string that happened to typecheck.
    if (!isConnectorSource(raw)) {
      throw badRequest(
        'invalid_source',
        `${param} must be one of ${CONNECTOR_SOURCE_TYPES.join(', ')}`,
        { reason: 'unknown_source', param },
      );
    }
    return raw;
  };
  const sourceParam = parseSource(url.searchParams.get('source')?.trim() || undefined, 'source');

  // ⛔ `qSource` IS `q` READ AS A CATEGORY, AND IT EXISTS BECAUSE `source` ALONE SWALLOWED A
  // LEGITIMATE NAME SEARCH. The /connectors box resolves the typed word against its own label
  // catalog; for "Opslagdienst" that is the only way to reach the `storage` rows, so the first fix
  // sent `?source=storage` INSTEAD of `?q=`. But **"Postgres" is BOTH the enum value and its
  // localized label in all eight catalogs** — so typing it stopped being a text search, and an
  // `http` connector literally named "Postgres bridge" became UNFINDABLE by the word printed in
  // its own name row. It was findable before that change. Replacing a text search with a filter
  // can only ever LOSE rows the reader could previously reach.
  //
  // ⛔ SO THE TWO READINGS ARE UNIONED, NOT SUBSTITUTED. `qSource` is an extra ARM of the `q`
  // predicate below, never an extra AND: "rows whose text matches `q` **or** whose kind is
  // `qSource`". A reader who types one word that has two meanings gets both meanings, and no row
  // that the plain text search would have found can be narrowed away by the category reading.
  //
  // ⚠️ AND `source` KEEPS ITS `AND`, DELIBERATELY. Widening `source` itself would have been the
  // smaller diff and the wrong one: `?source=storage&q=claims` is a two-narrowing contract that
  // `connector-source-filter.test.ts` pins and any API caller will assume, and flipping it to an
  // OR would silently answer every such request with MORE rows than were asked for. The two
  // parameters are different questions — "restrict to this kind" vs "…or is of this kind" — so
  // they are different parameters. The page sends only `q`+`qSource`; `source` is the API's.
  //
  // ⚠️ A HEURISTIC WAS CONSIDERED AND REJECTED: only map a label to its enum when the label is not
  // already matched by the text predicate (which `source_type::text ILIKE` makes true for exactly
  // "Postgres"). That repairs the one word and leaves the CLASS open — a `postgres` connector
  // named "Opslagdienst-monitor" is swallowed by `?source=storage` the same way. The union closes
  // the class: a name match is never narrowed away, whatever the word happens to mean.
  const qSourceParam = parseSource(url.searchParams.get('qSource')?.trim() || undefined, 'qSource');

  const filters = [
    eq(datasets.tenant_id, ctx.tenantId),
    inArray(datasets.source_type, CONNECTOR_TYPES),
  ];
  if (sourceParam) filters.push(eq(datasets.source_type, sourceParam));
  // ⛔ THE SEARCH BOX MATCHES WHAT THE READER CAN SEE. /connectors used to filter `q` in the
  // BROWSER, over the twelve rows page one had fetched, across four fields: name, slug, the
  // rendered source label and the host. The page now sends `q` here instead — it has to, because a
  // client-side filter cannot see a connector that never left the database — and this `where`
  // matched only name and slug. Moving the filter server-side while narrowing it would have
  // DELETED host search from the product: searching a connector by its hostname worked before that
  // change and returned nothing after it. Every column the table renders and can be matched in SQL
  // is matched here.
  //   * `source_type` needs the `::text` cast — it is a pgEnum, and `dataset_source_type ILIKE
  //     unknown` has no operator.
  //   * `host` lives inside the `connection_meta` jsonb and is present on all three ConnectorMeta
  //     variants (postgres/storage/http). `->>` yields NULL when the key is absent, and a NULL arm
  //     of an OR is simply not a match — no COALESCE needed.
  //
  // ⚠️ WHAT IS STILL NARROWER THAN THE OLD CLIENT FILTER, stated rather than glossed: the browser
  // matched the LOCALIZED source label (`m.connectors_source_storage()` → "Storage service", and
  // its seven translations), while this matches the stored enum — `storage`, `postgres`, `http`.
  // Those labels live in the paraglide catalog, not in a column, so there is nothing here to match
  // them against; `translatedMatchSql` covers `content_translations` rows, which enum labels are
  // not.
  //
  // ⛔ AND THE CONCLUSION THAT USED TO FOLLOW WAS WRONG, SO IT IS RETRACTED HERE RATHER THAN LEFT
  // TO MISLEAD THE NEXT READER. This comment ended "Fixing that means giving the enum labels a
  // DB-side representation, which is a schema change and not this change." It does not. The label
  // set is CLOSED — exactly three members, `CONNECTOR_SOURCE_TYPES` — and the browser already
  // holds all eight translations of each. The reader's word never has to reach SQL: the page
  // resolves it against its own catalog and sends `?source=storage`, handled above. No column, no
  // migration, no `content_translations` row. The residue is real but much smaller than the old
  // sentence claimed: matching is against the CURRENT locale's labels only, so a Dutch reader
  // typing the ENGLISH "Storage service" still gets nothing, and a PARTIAL label ("Opslag") is
  // treated as ordinary text rather than a filter — deliberately, since silently converting six
  // typed letters into a whole-category filter is its own surprise.
  //
  // ⛔ AND THE SENTENCE THAT SAID THE PAGE "sends `?source=storage`" IS RETRACTED ONE LINE ABOVE:
  // it sends `?q=` AND `?qSource=`, unioned here, because substituting the filter for the text lost
  // "Postgres bridge". See the `qSource` block.
  //
  // ⛔ `likeTerm`, NOT `%${q}%`. This route interpolated the raw query into the pattern, so a
  // user's `%` and `_` were WILDCARDS: `100%` matched every connector containing `100`. See
  // utils/search.ts.
  //
  // ⚠️ ONE `or()`, BUILT AS A LIST, RATHER THAN TWO `filters.push`es. Pushing `qSource` separately
  // would AND it — the exact bug this parameter exists to avoid — so the arms are assembled first
  // and pushed once. With neither `q` nor `qSource` the list is empty and nothing is pushed, which
  // is what makes an absent search an unfiltered list rather than `or()` of nothing.
  const textArms: SQL[] = [];
  if (q) {
    const term = likeTerm(q);
    textArms.push(
      ilike(datasets.name, term),
      ilike(datasets.slug, term),
      sql`${datasets.source_type}::text ILIKE ${term}`,
      sql`${datasets.connection_meta}->>'host' ILIKE ${term}`,
    );
  }
  if (qSourceParam) textArms.push(eq(datasets.source_type, qSourceParam));
  if (textArms.length) filters.push(or(...textArms)!);
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
    // `id` LAST and it is not decoration: `updated_at` alone is not unique (a batch write stamps
    // one transaction clock across every row it touches), and a non-total ORDER BY lets Postgres
    // order tied rows differently per page query — the page-1 and page-2 sorts run at different
    // top-N depths — so a connector can land on two pages or on none. See the long note over
    // routes/challenges' `orderForSort` for the measured version of this.
    .orderBy(desc(datasets.updated_at), asc(datasets.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const masks = await memberMasks(ctx.tenantId, rows, canReadRawData(ctx));
  return jsonResponse({
    // W8/P7: a non-manager gets masked column samples + the list of masked columns.
    items: rows.map((d) => {
      const masked = masks.get(d.id) ?? [];
      const c = connectorOut(d);
      return { ...c, columns: maskColumns(c.columns, masked, canReadRawData(ctx)), maskedColumns: masked };
    }),
    total,
    page,
    pageSize: PAGE_SIZE,
    canManage: canManageData(ctx),
    // ⛔ A CAPABILITY THE CLIENT COULD NOT SEE, NEXT TO ONE IT ALREADY COULD. Three controls on
    // this screen — Verify, Re-register and Reconcile — are refused `400 notifications_disabled`
    // whenever `CP_CONNECTOR_NOTIFICATIONS_ENABLED` is not `'true'` (:857, :1020, :1065), and the
    // flag ships dark: it is absent from `.env`, `.env.example`, `.env.local` and
    // `docker-compose.yml`. The SPA had no channel to learn that — no `/api/config`, no flags on
    // `/api/me` — so it rendered all three live and the only way to discover the truth was to press
    // one and read a refusal.
    //
    // `canManage` on the line above is the precedent this follows exactly: a server-computed
    // capability shipped in the list body so the client needs no second expression that can drift
    // from the server's. This is deliberately NOT the whole config — only whether the feature is on
    // at all. `storageUrl`, `tenant` and `secret` are infrastructure and never leave the host.
    notificationsEnabled: connectorNotificationsConfig().enabled,
  });
});

// ---- GET /api/connectors/:slug?offset=&limit= ----
const getConnector = route(async (req, slug) => {
  const ctx = await resolveTenant(req);
  const d = await loadConnectorInTenant(ctx.tenantId, slug!);
  // ⛔ THE WINDOW IS THE CALLER'S, WITHIN A CEILING — and it used to be neither. This route read
  // `readRows(d.id, DATASET_PREVIEW_ROWS, 0)` with no query parameters at all, while the SAME
  // response carried `rowCount`: a 10 000-row connector answered with 50 rows beside a field
  // saying 10 000, and nothing on the wire admitted the other 9 950 existed. That is the dataset
  // picker's silent stop-at-12 (PR #309) on a different screen — a hardcoded cap hiding user data
  // behind a number that contradicts it.
  //
  // The contract is deliberately IDENTICAL to `GET /api/datasets/:slug` (routes/datasets.ts), down
  // to the ceiling and the floor, because /connectors and /datasets render the same drawer over the
  // same `dataset_rows` table — two different windows would be a difference with no reason behind
  // it. `limit` and `offset` are ECHOED so the client can say "showing N of M" rather than present
  // a truncated table as the whole thing.
  //   * ceiling `DATASET_PREVIEW_ROWS * 4` — an unbounded `?limit` is an unbounded jsonb read;
  //   * floor 1 — `?limit=0` must not mean "everything" (Postgres `LIMIT 0` means "nothing", and
  //     either reading of a caller's zero is a guess);
  //   * unparseable falls back to the default, NOT to NaN/0 (`|| DATASET_PREVIEW_ROWS`).
  const url = new URL(req.url);
  const limit = Math.min(
    DATASET_PREVIEW_ROWS * 4,
    Math.max(
      1,
      Number.parseInt(url.searchParams.get('limit') ?? String(DATASET_PREVIEW_ROWS), 10) ||
        DATASET_PREVIEW_ROWS,
    ),
  );
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  // The paging above changes WHICH rows and HOW MANY, never whether they are masked.
  // ⚠️ MASKED FOR NON-MANAGERS since 2026-10-14 (owner decision, PLAN-2026-10-14-ux-cleanup.md
  // §W8.1) — the same masked view as `GET /api/datasets/:slug`; datasets/member-view.ts has the rule.
  const masked = (await memberMasks(ctx.tenantId, [d], canReadRawData(ctx))).get(d.id) ?? [];
  const rows = maskRows(await readRows(d.id, limit, offset), masked, canReadRawData(ctx));
  const out = connectorOut(d);
  return jsonResponse({
    ...out,
    columns: maskColumns(out.columns, masked, canReadRawData(ctx)),
    maskedColumns: masked,
    rows,
    offset,
    limit,
    canManage: canManageData(ctx),
  });
});

// ---- POST /api/connectors/:slug/sync (manual refresh, owner-scoped) ----
const syncConnector = route(async (req, slug) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  const d = await loadConnectorInTenant(ctx.tenantId, slug!);
  await recordAudit({
    actorId: user.id,
    action: 'connector.sync_manual',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: 'Manual sync requested',
    resultTone: 'ok',
    metadata: { kind: d.source_type },
  });
  const outcome = await refreshConnector(d.id, { actorId: user.id });
  const [fresh] = await db.select().from(datasets).where(eq(datasets.id, d.id));
  return jsonResponse({ ...connectorOut(fresh ?? d), sync: outcome });
});

// ---- POST /api/connectors/:slug/rotate-secret ----
const rotateSecret = route(async (req, slug) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  const d = await loadConnectorInTenant(ctx.tenantId, slug!);
  if (d.source_type === 'storage' && connectorNotificationsConfig().enabled) {
    // Storage connectors share the platform events secret; rotating would desync them from
    // the single MinIO target. Block it (the secret is managed centrally, not per-connector).
    throw badRequest(
      'shared_secret',
      'storage connectors use the shared platform events secret and cannot rotate',
    );
  }
  if ((d.event_source ?? 'none') !== 'webhook') {
    throw badRequest('not_webhook', 'only webhook connectors have an event secret');
  }
  const secret = await rotateEventSecret(d.id);
  await recordAudit({
    actorId: user.id,
    action: 'connector.rotate_secret',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: 'Event secret rotated',
    resultTone: 'warn',
    metadata: { kind: d.source_type },
  });
  return jsonResponse({ eventSecret: secret, ingestUrl: ingestUrl(req, d.id) });
});

// ---- POST /api/connectors/:slug/register-notifications ----
// Manually (re)register the MinIO bucket-notification rule for a storage+webhook connector
// whose auto-registration failed (or was never attempted). Best-effort auto-register at create
// can silently fall back to manual-sync-only; this lets the owner retry without recreating the
// connector. Persists the outcome onto connection_meta so the UI reflects it.
const registerNotifications = route(async (req, slug) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  const d = await loadConnectorInTenant(ctx.tenantId, slug!);
  const notifyCfg = connectorNotificationsConfig();
  if (!notifyCfg.enabled || !notifyCfg.secret) {
    throw badRequest('notifications_disabled', 'self-serve notifications are not enabled');
  }
  const meta = d.connection_meta;
  if (
    d.source_type !== 'storage' ||
    (d.event_source ?? 'none') !== 'webhook' ||
    meta?.kind !== 'storage'
  ) {
    // `reason` splits the register route's sentence from the status route's (`read`).
    throw badRequest('not_storage_webhook', 'only storage webhook connectors register notifications', {
      reason: 'register',
    });
  }
  if (!CP_BUCKET_RE.test(meta.bucket)) {
    throw badRequest('bucket_convention', `connector bucket '${meta.bucket}' is not a 'cp-*' bucket`, {
      reason: 'not_cp_bucket',
      bucket: meta.bucket,
    });
  }
  const notifyRegistered = await registerConnectorNotification(meta.bucket, meta.key);
  if (!notifyRegistered) {
    // Kept symmetric with the auto-register message above (which a test pins verbatim).
    log.warn('connector notification re-register failed', {
      slug: d.slug,
      bucket: meta.bucket,
      key: meta.key,
    });
  }
  await db
    .update(datasets)
    .set({ connection_meta: { ...meta, notifyRegistered } })
    .where(eq(datasets.id, d.id));
  await recordAudit({
    actorId: user.id,
    action: 'connector.register_notifications',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: notifyRegistered ? 'Notifications registered' : 'Notification registration failed',
    resultTone: notifyRegistered ? 'ok' : 'warn',
    metadata: { kind: d.source_type, bucket: meta.bucket, notifyRegistered },
  });
  const [fresh] = await db.select().from(datasets).where(eq(datasets.id, d.id));
  return jsonResponse({ ...connectorOut(fresh ?? d), notifyRegistered });
});

type StorageMeta = Extract<ConnectorMeta, { kind: 'storage' }>;

// Probe storage_service for a storage+webhook connector's LIVE MinIO rule and reconcile the
// stored `notifyRegistered` flag to ground truth. The stored flag is write-time only and can
// silently lie ("false-green") if the rule was lost out-of-band (MinIO restart, mc event
// remove, bucket recreate). `reachable=false` means storage couldn't be queried — we NEVER
// flip a stored `true`→false on a transient unreachable (avoids false alarms); a reachable-but-
// absent rule IS real drift and flips the flag to false.
async function verifyConnectorNotification(
  d: Dataset,
  meta: StorageMeta,
): Promise<{ reachable: boolean; live: boolean; stored: boolean }> {
  const stored = meta.notifyRegistered === true;
  const status = await bucketNotificationStatus(meta.bucket);
  const reachable = status !== null;
  const live = reachable && status.prefixes.includes(meta.key);
  if (reachable && live !== stored) {
    await db
      .update(datasets)
      .set({ connection_meta: { ...meta, notifyRegistered: live } })
      .where(eq(datasets.id, d.id));
  }
  return { reachable, live, stored };
}

interface ReconcileItem {
  slug: string;
  bucket: string;
  wasLive: boolean;
  nowLive: boolean;
  reachable: boolean;
}
interface ReconcileReport {
  checked: number;
  repaired: number;
  failed: number;
  items: ReconcileItem[];
}

// Re-assert each connector's MinIO rule: verify ground truth, and where the rule is missing
// (reachable but not live) re-register it. Used by the tenant-scoped reconcile route AND the
// opt-in boot pass. Skips non-storage / non-`cp-*` rows. Never throws per-connector — an
// unreachable connector is counted as `failed`, not fatal.
async function reconcileConnectorNotifications(connectors: Dataset[]): Promise<ReconcileReport> {
  const items: ReconcileItem[] = [];
  let repaired = 0;
  let failed = 0;
  for (const d of connectors) {
    const meta = d.connection_meta;
    if (meta?.kind !== 'storage' || !CP_BUCKET_RE.test(meta.bucket)) continue;
    const { reachable, live } = await verifyConnectorNotification(d, meta);
    let nowLive = live;
    if (!reachable) {
      failed += 1;
    } else if (!live) {
      const ok = await registerConnectorNotification(meta.bucket, meta.key);
      nowLive = ok;
      if (ok) {
        await db
          .update(datasets)
          .set({ connection_meta: { ...meta, notifyRegistered: true } })
          .where(eq(datasets.id, d.id));
        repaired += 1;
      } else {
        failed += 1;
      }
    }
    items.push({ slug: d.slug, bucket: meta.bucket, wasLive: live, nowLive, reachable });
  }
  return { checked: items.length, repaired, failed, items };
}

/** Opt-in boot pass (gated by `CP_CONNECTOR_NOTIFY_RECONCILE_ON_BOOT`): re-assert EVERY
 *  storage+webhook connector's MinIO rule once at startup (SYSTEM / RLS-bypass), recovering
 *  rules lost after a MinIO restart. Best-effort: logs a summary, never throws into boot. */
export async function bootReconcileConnectorNotifications(): Promise<void> {
  const cfg = connectorNotificationsConfig();
  if (!cfg.enabled || !cfg.reconcileOnBoot) return;
  try {
    const report = await runAsSystem('boot-seed', async () => {
      const result = await reconcileConnectorNotifications(await listAllStorageWebhookConnectors());
      // Only audit when boot-reconcile actually changed or failed something; a
      // clean pass (repaired:0 failed:0) happens on every pod roll and would
      // otherwise flood the audit log. System actor (actorId null).
      if (result.repaired > 0 || result.failed > 0) {
        await recordAudit({
          actorId: null,
          action: 'connector.boot_reconcile_notifications',
          category: 'data',
          targetType: 'dataset',
          targetId: 'connectors',
          result: `Checked ${result.checked}, repaired ${result.repaired}, failed ${result.failed}`,
          resultTone: result.failed > 0 ? 'warn' : 'ok',
          metadata: { checked: result.checked, repaired: result.repaired, failed: result.failed },
        });
      }
      return result;
    });
    log.info('connector_boot_reconcile_complete', {
      checked: report.checked,
      repaired: report.repaired,
      failed: report.failed,
    });
  } catch (e) {
    // The Error goes through as a field, NOT pre-stringified: `logger.ts safeValue` unpacks it to
    // `{name, message, stack}`, and the stack is the whole reason this line is worth reading.
    log.warn('connector_boot_reconcile_failed', { err: e });
  }
}

// ---- GET /api/connectors/:slug/notifications/status ----
// Probe the LIVE MinIO rule for one storage+webhook connector and self-heal the stored flag.
// Lets the UI show ground truth (and detect a false-green) instead of the last write-time flag.
const notificationStatus = route(async (req, slug) => {
  const ctx = await requireDataManager(req);
  const d = await loadConnectorInTenant(ctx.tenantId, slug!);
  const notifyCfg = connectorNotificationsConfig();
  if (!notifyCfg.enabled) {
    throw badRequest('notifications_disabled', 'self-serve notifications are not enabled');
  }
  const meta = d.connection_meta;
  if (
    d.source_type !== 'storage' ||
    (d.event_source ?? 'none') !== 'webhook' ||
    meta?.kind !== 'storage'
  ) {
    throw badRequest('not_storage_webhook', 'only storage webhook connectors have notifications', {
      reason: 'read',
    });
  }
  if (!CP_BUCKET_RE.test(meta.bucket)) {
    throw badRequest('bucket_convention', `connector bucket '${meta.bucket}' is not a 'cp-*' bucket`, {
      reason: 'not_cp_bucket',
      bucket: meta.bucket,
    });
  }
  const { reachable, live, stored } = await verifyConnectorNotification(d, meta);
  const drift = reachable && stored !== live;
  await recordAudit({
    actorId: ctx.user.id,
    action: 'connector.verify_notifications',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: !reachable
      ? 'Storage unreachable'
      : live
        ? 'Notification rule present'
        : 'Notification rule missing (drift)',
    resultTone: reachable && live ? 'ok' : 'warn',
    metadata: { kind: d.source_type, bucket: meta.bucket, notifyLive: live, reachable, drift },
  });
  const [fresh] = await db.select().from(datasets).where(eq(datasets.id, d.id));
  return jsonResponse({ ...connectorOut(fresh ?? d), notifyLive: live, reachable, drift });
});

// ---- POST /api/connectors/notifications/reconcile ----
// Re-assert all of the caller's storage+webhook connectors' MinIO rules (tenant-scoped recovery
// after a MinIO restart). Idempotent; returns a per-connector report.
const reconcileNotifications = route(async (req) => {
  const ctx = await requireDataManager(req);
  const notifyCfg = connectorNotificationsConfig();
  if (!notifyCfg.enabled || !notifyCfg.secret) {
    throw badRequest('notifications_disabled', 'self-serve notifications are not enabled');
  }
  const connectors = await listStorageWebhookConnectorsInTenant(ctx.tenantId);
  const report = await reconcileConnectorNotifications(connectors);
  await recordAudit({
    actorId: ctx.user.id,
    action: 'connector.reconcile_notifications',
    category: 'data',
    targetType: 'dataset',
    targetId: 'connectors',
    result: `Checked ${report.checked}, repaired ${report.repaired}, failed ${report.failed}`,
    resultTone: report.failed > 0 ? 'warn' : 'ok',
    metadata: { checked: report.checked, repaired: report.repaired, failed: report.failed },
  });
  return jsonResponse(report);
});

// ---- DELETE /api/connectors/:slug ----
const deleteConnector = route(async (req, slug) => {
  const ctx = await requireDataManager(req);
  const user = ctx.user;
  const d = await loadConnectorInTenant(ctx.tenantId, slug!);

  // Self-serve: drop the MinIO notification rule if this is the LAST storage connector on its
  // bucket+key. The ref-count runs as SYSTEM (RLS-bypass) so connectors in OTHER tenants that
  // share the bucket are counted — we must not remove a rule another tenant still relies on.
  const meta = d.connection_meta as { bucket?: string; key?: string } | null;
  if (d.source_type === 'storage' && connectorNotificationsConfig().enabled && meta?.bucket) {
    const bucket = meta.bucket;
    const key = meta.key ?? '';
    // `cross-tenant-aggregate`, NOT `platform-admin`: this route's gate is `requireDataManager`,
    // not `requireSuperAdmin`. The read is deliberately unfiltered — the whole point is to see
    // whether ANY OTHER TENANT still points at this bucket+key before deregistering the shared
    // MinIO rule — but only `others.length` is ever consumed below, so no foreign row crosses back.
    const others = (await runAsSystem('cross-tenant-aggregate', () => findConnectorsByBucket(bucket))).filter(
      (o) => o.id !== d.id && ((o.connection_meta as { key?: string } | null)?.key ?? '') === key,
    );
    if (others.length === 0) {
      // KNOWN GAP, accepted: deregister is best-effort (it returns false rather than throwing) and
      // we delete the connector row regardless — a delete must not be blocked by an unreachable
      // storage_service. The cost is an ORPHANED MinIO rule: reconcileConnectorNotifications
      // iterates connector ROWS, so once this row is gone there is nothing left to reconcile from
      // and no code path can ever repair it. Harmless in practice — the rule fires webhooks whose
      // secret no longer matches any connector, so events are rejected, not misrouted — but it
      // accumulates until an operator prunes MinIO by hand. Fixing it needs a tombstone/sweeper
      // keyed on (bucket, key) rather than on the connector row; deliberately not built yet.
      await deregisterConnectorNotification(bucket, key);
    }
  }

  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  await db.delete(datasets).where(eq(datasets.id, d.id));
  await recordAudit({
    actorId: user.id,
    action: 'connector.delete',
    category: 'data',
    targetType: 'dataset',
    targetId: d.slug,
    result: 'Deleted',
    resultTone: 'warn',
    metadata: { kind: d.source_type, rowCount: d.row_count },
  });
  return jsonResponse({ ok: true });
});

// ---- POST /api/connectors/events — token-authed event ingress (NOT Keycloak) ----
// Accepts either:
//   • an explicit { connector: <id> } (query or body) authenticated by the connector's
//     event secret in `Authorization: Bearer <secret>` (or ?token= / body.secret), or
//   • a MinIO bucket-notification body { Records: [{ s3: { bucket: { name } } }] } —
//     each matching storage connector is verified against the same presented secret.
// On a verified event we NOTIFY the refresh channel (any replica then refreshes).
function presentedSecret(req: Request, url: URL, body: Record<string, unknown>): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1]!.trim();
  if (typeof body.secret === 'string' && body.secret) return body.secret;
  return url.searchParams.get('token');
}

function bucketsFromPayload(body: Record<string, unknown>): string[] {
  const recs = Array.isArray((body as { Records?: unknown }).Records)
    ? ((body as { Records: unknown[] }).Records as Array<Record<string, unknown>>)
    : [];
  const out: string[] = [];
  for (const r of recs) {
    const name = (r?.s3 as { bucket?: { name?: unknown } } | undefined)?.bucket?.name;
    if (typeof name === 'string' && name) out.push(name);
  }
  return out;
}

/**
 * Is the connector's OWNING tenant still active? Returns false for a suspended workspace.
 *
 * ⚠️ WHY THIS INGRESS BYPASSED THE GATE, recorded so the next person adding a webhook sees the
 * pattern. `middleware/tenant-status-gate.ts` is entered from `validateAuth`. This route is
 * authenticated by a per-connector event SECRET and never calls `validateAuth` at all, so it never
 * reached the gate by any path. Measured: with the tenant suspended and every browser route
 * answering 403, a MinIO bucket notification still came back `{accepted:true,triggered:1}` and
 * issued the refresh NOTIFY — a suspended workspace went on ingesting live data from its source.
 * Any FUTURE secret-authed ingress in this file has exactly the same shape and needs this call.
 *
 * ⛔ THE TENANT COMES OFF THE CONNECTOR ROW, NEVER OFF THE CALLER. `d.tenant_id` belongs to the row
 * whose secret we just verified; `?connector=`, `body.connector` and the bucket name are all
 * attacker-chosen and must never select which tenant gets judged.
 *
 * ⛔ A SUSPENDED TENANT IS SKIPPED SILENTLY — IT DOES NOT 403, AND THAT IS THE DELIBERATE CHOICE.
 * `connectorEvents` answers a CONSTANT `202 {accepted:true, triggered:N}` for every outcome
 * precisely so the endpoint is not an oracle for valid connector ids/secrets (see its own note at
 * the return). A 403 would fire ONLY after BOTH a real connector id AND a matching secret, so it
 * would confirm both to a prober — and it would tell an external storage provider a commercial
 * fact about our customer. Skipping keeps the refusal indistinguishable from an unknown id or a
 * wrong secret, while `triggered` honestly drops to 0: nothing was triggered.
 *
 * ⛔ A LOOKUP FAILURE STILL PROPAGATES (503 `tenant_status_unavailable`). Only `tenant_suspended`
 * is converted to a skip. Swallowing the 503 as well would quietly turn the gate's fail-CLOSED
 * decision into fail-open on the one path with no human watching it, and 5xx is the answer a
 * webhook sender knows how to retry — so the event is deferred, not lost.
 */
async function connectorTenantActive(d: { id: string; tenant_id: string | null }): Promise<boolean> {
  try {
    await assertTenantNotSuspended(d.tenant_id);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.code === 'tenant_suspended') {
      // Silent on the wire, NOT silent on the server: a skip that leaves no record is how an
      // ingest outage gets attributed to the storage provider for a week.
      log.warn('connector_event_ignored_tenant_suspended', { connectorId: d.id });
      incCounter('connector_event_suspended_skips_total');
      return false;
    }
    throw err;
  }
}

const connectorEvents = route(async (req) => {
  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  try {
    // ⛔ `readJson`, NOT a bare `req.json()`. This was the ONE call site in the service still
    // reading a body directly, so it bypassed BOTH halves of the shared cap (the `content-length`
    // early refusal AND the streaming accumulator that is the one which actually enforces it) on
    // an ingress that never calls `validateAuth` and is reachable by anyone who can address the
    // pod. The DEFAULT 1 MiB limit is the right one here and this is deliberately NOT an
    // upload/import route: the payload is a MinIO bucket notification (`{Records:[…]}`) or a
    // `{connector, secret}` pair — kilobytes. Dataset CONTENT never comes through here; it has its
    // own much larger `readBoundedBody` in routes/datasets.ts.
    body = (await readJson(req)) as Record<string, unknown>;
  } catch (err) {
    // ⚠️ ONLY the parse failure is swallowed, and that is the UNCHANGED pre-existing behaviour: the
    // secret can still arrive on `Authorization` / `?token=` with `?connector=` naming the row, so
    // a malformed body is treated as absent rather than refused. A body OVER THE CAP is not the
    // same thing — letting `request_body_too_large` fall into `{}` here would silently downgrade
    // the 413 to a `no_secret` 400 and leave the cap advisory on the one route that needed it
    // most. Anything that is not `invalid_json` propagates.
    if (err instanceof HttpError && err.code !== 'invalid_json') throw err;
    body = {};
  }
  const secret = presentedSecret(req, url, body);
  if (!secret) throw badRequest('no_secret', 'an event secret is required');

  const explicitId = url.searchParams.get('connector') ?? (body.connector as string | undefined);
  const triggered: string[] = [];

  // This ingress is webhook-authed (per-connector secret), NOT Keycloak — there is no tenant
  // context, so the connector LOOKUP must run as SYSTEM (RLS-bypass); under D.1.2's cp_app role a
  // plain `db` read here is RLS-scoped with no `app.current_tenant` GUC and silently returns zero
  // rows (a MinIO bucket-notification would then never match a connector). The presented secret is
  // the authorization; only after verifying it do we trigger a refresh (which re-establishes the
  // connector's own tenant context via runAsSystem→withTenantDb inside refreshConnector).
  if (explicitId) {
    const d = await runAsSystem('credential-auth', async () => {
      const [row] = await db.select().from(datasets).where(eq(datasets.id, explicitId));
      return row;
    });
    // The suspension check runs AFTER the secret, never before: an unauthenticated caller must not
    // be able to make us query `tenants` at all, and the tenant we judge is the verified row's.
    if (d && verifyEventSecret(d, secret) && (await connectorTenantActive(d))) {
      await requestRefresh(d.id);
      triggered.push(d.id);
    }
  } else {
    const buckets = bucketsFromPayload(body);
    for (const bucket of [...new Set(buckets)]) {
      const matches = await runAsSystem('credential-auth', () => findConnectorsByBucket(bucket));
      for (const d of matches) {
        // Per-connector, not per-request: one bucket can carry connectors from several tenants
        // (the lookup is RLS-bypassing), so one suspended tenant must not suppress the others.
        if (verifyEventSecret(d, secret) && (await connectorTenantActive(d))) {
          await requestRefresh(d.id);
          triggered.push(d.id);
        }
      }
    }
  }

  // Constant response shape regardless of match, so the endpoint is not an oracle for
  // valid connector ids/secrets. 202 = accepted-for-processing.
  return jsonResponse({ accepted: true, triggered: triggered.length }, 202);
});

// ---- GET /api/connectors/stream — SSE of connector status changes (no polling) ----
const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

/** The keepalive period, and therefore ALSO the tenant-status re-check period — see the long note
 *  in `streamConnectors`. One interval, deliberately: a second timer would double the wakeups per
 *  open stream to enforce a state ~0% of rows carry. */
const SSE_HEARTBEAT_DEFAULT_MS = 15000;
let sseHeartbeatMs = SSE_HEARTBEAT_DEFAULT_MS;

/** Test seam, same idiom as `__setAuthOverridesForTests` / `__setLicenseClientForTests`. The
 *  suspension-mid-stream defect cannot be observed without at least ONE tick, and a 15s tick makes
 *  that a 15-second test. Pass `undefined` to restore the production period. */
export function __setSseHeartbeatMsForTests(ms: number | undefined): void {
  sseHeartbeatMs = ms ?? SSE_HEARTBEAT_DEFAULT_MS;
}

const streamConnectors = route(async (req) => {
  const ctx = await resolveTenant(req);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let hb: ReturnType<typeof setInterval>;
      const onSynced = (connectorId: string) => {
        void (async () => {
          try {
            // ⚠️ THIS RUNS ON THE NOTIFY HANDLER'S STACK, NOT THE REQUEST'S. connector-listener.ts
            // fans out from a postgres NOTIFY callback, which carries no AsyncLocalStorage store —
            // so `db` finds no context and falls back to the pool (db/client.ts: `ctx?.boundDb ??
            // target`). In production the pool is role `cp_app`, NOBYPASSRLS, with no
            // `app.current_tenant` GUC, and `datasets` has RLS enabled — the policy matched
            // nothing, `d` came back undefined, and this handler took the silent `return`. `event:
            // synced` therefore never reached a browser in production; the Datasets screen's
            // advertised reactive update was dead from the RLS cutover. It looked fine locally
            // only because AUTH_BYPASS plus an owner DSN hides the whole mechanism.
            //
            // `runAsSystem` binds the OWNER pool for this one lookup, which is the correct shape:
            // the fan-out is genuinely cross-tenant (one NOTIFY reaches every subscribed stream on
            // the pod), so no single tenant GUC can express it.
            //
            // ⛔ THAT MAKES THE TENANT SCOPE THIS ROUTE'S OWN JOB. Before the fix, RLS was an
            // accidental second layer — with no GUC the query returned nothing, so even a missing
            // tenant check could not leak. The owner role BYPASSES RLS, so nothing below the
            // database is filtering any more, and one NOTIFY is delivered to EVERY subscribed
            // stream on the pod regardless of tenant. Two layers, deliberately, in this order:
            //   1. the WHERE scopes the lookup itself, so a foreign connector is fail-closed at the
            //      query and never becomes a row in this closure at all;
            //   2. the `!d` guard turns that miss into a silent return.
            // Neither is redundant decoration and neither should be "simplified" away — 1 is what
            // makes the boundary structural rather than a comparison a later edit can drop.
            // tests/connector-sse-cross-tenant.test.ts holds this: two streams, two tenants, one
            // NOTIFY, and B must receive nothing.
            const d = await runAsSystem('tenant-parameterised', async () => {
              const [row] = await db
                .select()
                .from(datasets)
                .where(and(eq(datasets.id, connectorId), eq(datasets.tenant_id, ctx.tenantId)));
              return row;
            });
            if (!d) return;
            controller.enqueue(
              enc.encode(`event: synced\ndata: ${JSON.stringify(connectorOut(d))}\n\n`),
            );
          } catch (err) {
            // ⛔ THE LOG AND THE FRAME ARE THE ONLY TWO RECORDS THIS FAILURE CAN HAVE. We are inside
            // a detached `void (async () => …)` running on the NOTIFY handler's stack, long after
            // the SSE response headers went out — nothing upstream (the route wrapper, the access
            // log, `fanoutSynced`'s own try/catch, which this promise never reaches) ever sees the
            // throw. The bare `catch {}` that used to sit here therefore produced no log, no metric
            // and no frame, and the page's optimistic "Syncing" pill (routes/connectors/
            // +page.svelte's `syncNow`) only ever leaves that state on a frame: the row span
            // forever and the server-side explanation was nothing at all. Same shape, same reason,
            // as the test-run stream in routes/blocks.ts:961 — see its header.
            log.error('connector_sync_push_failed', { connectorId, err });
            incCounter('connector_sse_push_failures_total');
            // ⛔ NO DETAIL ON THE WIRE, DELIBERATELY, AND IT IS A TENANT BOUNDARY NOT A STYLE CHOICE.
            // One NOTIFY reaches EVERY subscribed stream on the pod (see the long note at the
            // lookup above), so this frame is delivered to tenants that have no business knowing
            // the connector even exists. `connectorId` is the NOTIFY payload and a Postgres error
            // text quotes the value it choked on — putting either on the frame would hand tenant B
            // tenant A's connector id, which is exactly what tests/connector-sse-cross-tenant.test.ts
            // exists to forbid. The id lives in the log line above, which is tenant-neutral by
            // being server-side. The client needs no detail: `code` tells it a push was lost, and
            // its answer is to re-read its OWN RLS-scoped list.
            try {
              controller.enqueue(enc.encode('event: error\ndata: {"code":"push_failed"}\n\n'));
            } catch {
              // The stream is already gone (client hung up, or the enqueue above is what threw).
              // Nothing to tell anyone — the `log.error` above is the record. This nested catch
              // is not decoration: an unguarded second enqueue would throw INSIDE the detached
              // continuation and surface as an unhandled rejection with no request to attach to.
            }
          }
        })();
      };
      const unsub = subscribeConnectorSynced(onSynced);
      const cleanup = () => {
        clearInterval(hb);
        unsub();
        req.signal.removeEventListener('abort', onAbort);
      };
      function onAbort() {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
      /**
       * ⛔ THE TENANT GATE IS PER-REQUEST, AND AN SSE STREAM IS ONE REQUEST THAT NEVER ENDS.
       * `resolveTenant(req)` above runs `validateAuth` → `assertTenantActive` exactly ONCE, at
       * CONNECT. Nothing in the process re-reads `tenants.status` for a connection that already
       * exists. Measured before this tick: a stream opened while the tenant was active went on
       * delivering `event: synced` frames 10s and 25s after the workspace was suspended, while
       * every browser route answered 403. Suspension has to reach connections that are already
       * open, not merely the next one — the same is true of any long-lived stream added later.
       *
       * IT RIDES THE EXISTING KEEPALIVE rather than adding a timer of its own: one primary-key
       * SELECT per tick per open stream — at the production 15s period that is 4 queries/min per
       * open stream, against an indexed `uuid` on a table this pod already reads on every request.
       * There is deliberately no cached answer (the gate's Decision 2: CP runs 2–4 replicas and the
       * suspending PATCH lands on exactly one of them, so a per-process cache enforces nothing).
       *
       * ⛔ A FAILED LOOKUP LEAVES THE STREAM OPEN — THE OPPOSITE OF THE REQUEST PATH, ON PURPOSE.
       * The request gate fails CLOSED because a denied request is retried by the client instantly
       * and costs one page load. A stream is not symmetrical: a dropped SSE connection reconnects
       * with backoff and LOSES every `synced` event in the gap, and one DB blip would drop every
       * listener on the pod at once — a self-inflicted disconnect storm, to enforce a state ~0% of
       * rows carry. Staying open costs at most one more tick of status frames the tenant could
       * already see, and the next tick re-checks. It is not silence either: the failure is already
       * counted by the gate itself (`tenant_status_lookup_failures_total`).
       */
      let recheckInFlight = false;
      const tick = () => {
        try {
          controller.enqueue(enc.encode(': ping\n\n'));
        } catch {
          cleanup();
          return;
        }
        // A lookup slower than one period must not stack up one query per tick.
        if (recheckInFlight) return;
        recheckInFlight = true;
        void (async () => {
          try {
            await assertTenantNotSuspended(ctx.tenantId);
          } catch (err) {
            if (!(err instanceof HttpError) || err.code !== 'tenant_suspended') return; // see above
            try {
              // Same `event: error` + code-only convention as the push-failure frame above, so the
              // SPA's existing error handler needs no new shape. A terminal frame BEFORE the close
              // is what stops the client treating this as a transport drop and reconnecting.
              controller.enqueue(
                enc.encode('event: error\ndata: {"code":"tenant_suspended"}\n\n'),
              );
            } catch {
              /* client already hung up — closing below is still correct */
            }
            cleanup();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          } finally {
            recheckInFlight = false;
          }
        })();
      };
      hb = setInterval(tick, sseHeartbeatMs);
      req.signal.addEventListener('abort', onAbort);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
});

export function registerConnectorRoutes(router: Router): void {
  router.add('GET', '/api/connectors', listConnectors);
  router.add('POST', '/api/connectors', createConnectorRoute);
  router.add('POST', '/api/connectors/test', testConnectorRoute);
  router.add('POST', '/api/connectors/events', connectorEvents);
  router.add('GET', '/api/connectors/stream', streamConnectors);
  router.add('GET', '/api/connectors/:slug', getConnector);
  router.add('POST', '/api/connectors/:slug/sync', syncConnector);
  router.add('POST', '/api/connectors/:slug/rotate-secret', rotateSecret);
  router.add('POST', '/api/connectors/:slug/register-notifications', registerNotifications);
  router.add('POST', '/api/connectors/notifications/reconcile', reconcileNotifications);
  router.add('GET', '/api/connectors/:slug/notifications/status', notificationStatus);
  router.add('DELETE', '/api/connectors/:slug', deleteConnector);
}
