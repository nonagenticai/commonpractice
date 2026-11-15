// src/datasets/connector-service.ts — connector persistence + secret handling.
// A connector is a `datasets` row whose source_type is a live kind (postgres/storage/
// http). The SECRET config is encrypted at rest (secret-box) and decrypted only on the
// host at refresh time; the event secret authenticates the /api/connectors/events
// ingress (constant-time compared). None of these secrets is ever returned to a client.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db as defaultDb, datasets } from '../db/client';
import type { Dataset } from '../db/schema';
import { encryptSecret, decryptSecret, tryDecryptSecret } from '../host/secret-box';
import { slugify, SLUG_PROBE_LIMIT } from './dataset-service';
import type {
  ConnectorConfig,
  ConnectorMeta,
  ConnectorEventSource,
  ConnectorSourceType,
} from '../db/dataset-types';

type Db = typeof defaultDb;

export interface CreateConnectorArgs {
  ownerId: string;
  tenantId?: string | null;
  sandboxId?: string | null;
  name: string;
  kind: ConnectorSourceType;
  config: ConnectorConfig;
  meta: ConnectorMeta;
  eventSource: ConnectorEventSource;
  /** Override the minted event secret. Storage+webhook connectors pass the SHARED platform
   *  events secret here (so the MinIO shared-target bearer verifies); webhook connectors
   *  without an override get a freshly minted per-connector secret. Ignored when not webhook. */
  eventSecret?: string | null;
}

/** A high-entropy event secret (shown to the creator once, stored encrypted). */
export function mintEventSecret(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Insert a connector dataset (status 'syncing' — the caller kicks the first refresh).
 * Returns the row + the freshly minted plaintext event secret (webhook connectors
 * only) so the route can surface it ONCE; it is never recoverable afterwards.
 */
export async function createConnector(
  args: CreateConnectorArgs,
  database: Db = defaultDb,
): Promise<{ dataset: Dataset; eventSecret: string | null }> {
  // Slug uniqueness is tenant-scoped (3.6 datasets model); allocate it with INSERT conflict
  // handling so concurrent connector creation cannot choose the same select-then-insert slug.
  const tenantId = args.tenantId ?? args.ownerId;
  const stem = slugify(args.name);
  const eventSecret =
    args.eventSource === 'webhook' ? (args.eventSecret ?? mintEventSecret()) : null;
  let row: Dataset | undefined;
  // Bounded probes, then a random suffix — see the same guard in dataset-service.
  for (let suffix = 1; suffix <= SLUG_PROBE_LIMIT + 1; suffix++) {
    const slug =
      suffix === 1
        ? stem
        : suffix > SLUG_PROBE_LIMIT
          ? `${stem}-${crypto.randomUUID().slice(0, 8)}`
          : `${stem}-${suffix}`;
    [row] = await database
      .insert(datasets)
      .values({
        owner_id: args.ownerId,
        tenant_id: tenantId,
        sandbox_id: args.sandboxId ?? null,
        name: args.name,
        slug,
        source_type: args.kind,
        columns: [],
        row_count: 0,
        size_bytes: 0,
        status: 'syncing',
        connection_config_encrypted: encryptSecret(JSON.stringify(args.config)),
        connection_meta: args.meta,
        event_source: args.eventSource,
        event_secret_encrypted: eventSecret ? encryptSecret(eventSecret) : null,
      })
      .onConflictDoNothing({ target: [datasets.tenant_id, datasets.slug] })
      .returning();
    if (row) break;
  }
  if (!row) throw new Error(`could not allocate a connector slug for '${args.name}'`);
  return { dataset: row!, eventSecret };
}

/** Decrypt + parse a connector's secret config (host-side only). */
export function loadConnectorConfig(d: Dataset): ConnectorConfig {
  if (!d.connection_config_encrypted) {
    throw new Error('connector has no stored configuration');
  }
  return JSON.parse(decryptSecret(d.connection_config_encrypted)) as ConnectorConfig;
}

/** Constant-time check of a presented event secret against the stored one. */
export function verifyEventSecret(d: Dataset, presented: string): boolean {
  const stored = tryDecryptSecret(d.event_secret_encrypted);
  if (!stored || !presented) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Rotate a connector's event secret; returns the new plaintext (shown once). */
export async function rotateEventSecret(
  connectorId: string,
  database: Db = defaultDb,
): Promise<string> {
  const secret = mintEventSecret();
  await database
    .update(datasets)
    .set({ event_secret_encrypted: encryptSecret(secret), updated_at: new Date() })
    .where(eq(datasets.id, connectorId));
  return secret;
}

/** Find a connector by the bucket it watches (used by storage bucket-notification
 *  events that name a bucket, not a connector slug). Owner-agnostic — an event source
 *  is trusted via its per-connector secret, matched in the route. */
export async function findConnectorsByBucket(
  bucket: string,
  database: Db = defaultDb,
): Promise<Dataset[]> {
  const rows = await database.select().from(datasets).where(eq(datasets.source_type, 'storage'));
  return rows.filter((r) => (r.connection_meta as { bucket?: string } | null)?.bucket === bucket);
}

/** All storage+webhook connectors in ONE tenant (the tenant-scoped notification reconcile
 *  enumerates these). Runs under the caller's request DB context (RLS-scoped); the explicit
 *  tenant_id filter mirrors `loadConnectorInTenant`. */
export async function listStorageWebhookConnectorsInTenant(
  tenantId: string,
  database: Db = defaultDb,
): Promise<Dataset[]> {
  return database
    .select()
    .from(datasets)
    .where(
      and(
        eq(datasets.tenant_id, tenantId),
        eq(datasets.source_type, 'storage'),
        eq(datasets.event_source, 'webhook'),
      ),
    );
}

/** ALL storage+webhook connectors across every tenant — for the opt-in boot reconcile, which
 *  must run as SYSTEM (RLS-bypass via `runAsSystem`) since it has no per-tenant request context. */
export async function listAllStorageWebhookConnectors(
  database: Db = defaultDb,
): Promise<Dataset[]> {
  return database
    .select()
    .from(datasets)
    .where(and(eq(datasets.source_type, 'storage'), eq(datasets.event_source, 'webhook')));
}
