// src/services/mcp-api-key.ts — issuable/revocable API keys for EXTERNAL MCP clients
// (Phase 2-D). A tenant_admin mints a key bound to their tenant; the raw
// `cp_mcp_<prefix>_<secret>` is returned ONCE and only its sha256 hash is stored
// (mirrors agent-session.ts' refresh-hash pattern). An external client presents it as
// `Authorization: Bearer cp_mcp_…` to /api/mcp, where resolveCtx → verifyKey resolves
// the tenant identity. Keys can carry coarse scopes and an expiry, and are revocable.
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db as defaultDb, mcpApiKeys, users, runAsSystem } from '../db/client';
import { UnauthorizedError } from '../types';

type Db = typeof defaultDb;

const KEY_NS = 'cp_mcp';
const SECRET_BYTES = 24; // 192-bit secret
export const DEFAULT_SCOPES = ['tools', 'resources', 'prompts'] as const;

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Cheap check (no DB) — is this bearer one of our MCP API keys? */
export function isMcpApiKey(raw: string | null | undefined): boolean {
  return !!raw && raw.startsWith(`${KEY_NS}_`);
}

export interface MintedKey {
  id: string;
  /** The raw key — returned ONCE; only its hash is persisted. */
  raw: string;
  keyPrefix: string;
}

export interface VerifiedKey {
  keyId: string;
  tenantId: string;
  /** The issuing user (the key acts on their behalf within the tenant). */
  userId: string;
  scopes: string[];
}

/** Mint a tenant-scoped MCP API key. Returns the raw key ONCE. */
export async function mintKey(
  args: {
    tenantId: string;
    issuedBy: string;
    name: string;
    scopes?: string[];
    expiresAt?: Date | null;
  },
  db: Db = defaultDb,
): Promise<MintedKey> {
  const prefix = randomBytes(4).toString('hex'); // 8 hex chars, shown in the UI
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const raw = `${KEY_NS}_${prefix}_${secret}`;
  const [row] = await db
    .insert(mcpApiKeys)
    .values({
      tenant_id: args.tenantId,
      issued_by: args.issuedBy,
      name: args.name,
      key_prefix: prefix,
      key_hash: hashKey(raw),
      scopes: args.scopes ?? [...DEFAULT_SCOPES],
      expires_at: args.expiresAt ?? null,
    })
    .returning({ id: mcpApiKeys.id });
  return { id: row!.id, raw, keyPrefix: prefix };
}

/** Verify a raw `cp_mcp_…` key → tenant identity. Throws Unauthorized on
 *  miss/revoked/expired/orphaned. Bumps last_used_at (best-effort). */
export async function verifyKey(raw: string, db: Db = defaultDb): Promise<VerifiedKey> {
  if (!isMcpApiKey(raw)) throw new UnauthorizedError('Not an MCP API key');
  // ⛔ runAsSystem IS LOAD-BEARING, and without it this whole authentication path was DEAD IN PROD.
  //
  // Chicken-and-egg: this lookup is how we DISCOVER which tenant the caller belongs to, so by
  // definition it runs before any tenant context exists. `routes/mcp.ts resolveCtx` calls it while
  // `server.ts` has already resolved a non-JWT bearer to `tenantId = null`, so no tenant GUC is set.
  // `mcp_api_keys` has strict RLS (0028 §4a: `tenant_id = app_current_tenant_uuid()`, with no
  // NULL passthrough), so under `cp_app` with no GUC the row is INVISIBLE and every valid,
  // non-revoked key failed as `Invalid MCP API key`. External MCP API-key auth never worked once
  // in production. Verified read-only against live prod:
  //
  //   SELECT count(*) FROM mcp_api_keys;                    -> 3   (1 active)
  //   SET ROLE cp_app; SELECT count(*) FROM mcp_api_keys;   -> 0   <- what verifyKey actually saw
  //
  // Tests never caught it because they call the handler directly and the local .env connects as the
  // table OWNER, which bypasses RLS entirely — the one configuration in which this cannot fail.
  // `routes/connectors.ts connectorEvents` already handles this identical hazard with runAsSystem.
  //
  // Safe because the key HASH is the credential: this is a lookup by a secret the caller had to
  // present, not an unscoped listing, and the tenant it returns is what every downstream check is
  // then scoped by.
  const [row] = await runAsSystem('credential-auth', () =>
    db.select().from(mcpApiKeys).where(eq(mcpApiKeys.key_hash, hashKey(raw))),
  );
  if (!row) throw new UnauthorizedError('Invalid MCP API key');
  if (row.revoked_at) throw new UnauthorizedError('MCP API key revoked');
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    throw new UnauthorizedError('MCP API key expired');
  }
  // The key acts on behalf of its issuer; an orphaned key (issuer deleted) is invalid.
  if (!row.issued_by) throw new UnauthorizedError('MCP API key issuer no longer exists');
  // …and so is a key whose issuer has been OFFBOARDED. Offboarding revokes these keys explicitly
  // (revokeKeysIssuedBy), so reaching here means either a key minted before that fix or a path that
  // skipped it. Defence in depth: this is an authentication boundary, so it fails closed rather
  // than trusting the write side to have swept correctly.
  // ⛔ This lookup is NOT wrapped in runAsSystem, deliberately, and that was checked rather than
  // assumed: verified against live prod that `SET ROLE cp_app` with no GUC still reads `users`
  // (24 rows), so unlike `mcp_api_keys` above it is genuinely visible here. Expanding an RLS
  // bypass further than it must reach is its own risk.
  const [issuer] = await db
    .select({ deletedAt: users.deleted_at })
    .from(users)
    .where(eq(users.id, row.issued_by))
    .limit(1);
  // ⛔ FAIL CLOSED on an ABSENT issuer row, not just a tombstoned one. `issuer?.deletedAt` alone is
  // fail-OPEN: if the row cannot be read for ANY reason — a hard delete via `removeLocalUser`'s
  // ghost-row cleanup, or a future RLS policy on `users` making it invisible here exactly as
  // `mcp_api_keys` already is — then `issuer` is undefined, the guard below is skipped, and the key
  // is ACCEPTED. An authentication boundary must not depend on a row being readable to refuse.
  if (!issuer) {
    throw new UnauthorizedError('MCP API key issuer could not be verified');
  }
  if (issuer.deletedAt) {
    throw new UnauthorizedError('MCP API key issuer has been removed from this workspace');
  }

  // Same RLS reasoning as the lookup above — still no tenant context at this point.
  await runAsSystem('credential-auth', () =>
    db.update(mcpApiKeys).set({ last_used_at: new Date() }).where(eq(mcpApiKeys.id, row.id)),
  );

  return {
    keyId: row.id,
    tenantId: row.tenant_id,
    userId: row.issued_by,
    scopes: row.scopes,
  };
}

/** List a tenant's keys (never returns the hash/raw). Newest first. */
export async function listKeys(tenantId: string, db: Db = defaultDb) {
  return db
    .select({
      id: mcpApiKeys.id,
      name: mcpApiKeys.name,
      keyPrefix: mcpApiKeys.key_prefix,
      scopes: mcpApiKeys.scopes,
      lastUsedAt: mcpApiKeys.last_used_at,
      expiresAt: mcpApiKeys.expires_at,
      revokedAt: mcpApiKeys.revoked_at,
      createdAt: mcpApiKeys.created_at,
    })
    .from(mcpApiKeys)
    .where(eq(mcpApiKeys.tenant_id, tenantId))
    .orderBy(desc(mcpApiKeys.created_at));
}

/**
 * Revoke every live key a user issued. Returns how many were revoked.
 *
 * Offboarding must call this EXPLICITLY. It used to be implicit: `issued_by` is ON DELETE SET NULL,
 * and `verifyKey` rejects a key whose issuer is gone — so hard-deleting the `users` row revoked
 * every key that person had minted. Tombstoning (0050) keeps the row, so `issued_by` stays
 * populated and that revocation silently stopped happening. A departed employee's MCP key would
 * have kept working indefinitely.
 */
export async function revokeKeysIssuedBy(userId: string, db: Db = defaultDb): Promise<number> {
  const rows = await db
    .update(mcpApiKeys)
    .set({ revoked_at: new Date() })
    .where(and(eq(mcpApiKeys.issued_by, userId), isNull(mcpApiKeys.revoked_at)))
    .returning({ id: mcpApiKeys.id });
  return rows.length;
}

/** Revoke a key within a tenant. Returns false if not found / already revoked. */
export async function revokeKey(
  tenantId: string,
  keyId: string,
  db: Db = defaultDb,
): Promise<boolean> {
  const rows = await db
    .update(mcpApiKeys)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(mcpApiKeys.id, keyId),
        eq(mcpApiKeys.tenant_id, tenantId),
        isNull(mcpApiKeys.revoked_at),
      ),
    )
    .returning({ id: mcpApiKeys.id });
  return rows.length > 0;
}
