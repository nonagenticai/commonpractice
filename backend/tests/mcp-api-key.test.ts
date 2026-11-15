// tests/mcp-api-key.test.ts — Phase 2-D external MCP API keys, unit-level against the
// live :5433 DB. admin.test.ts covers the issue→auth→revoke ROUTE happy path; this
// drills verifyKey's reject branches directly — notably the EXPIRED path, which the
// route test never exercises. Only the sha256 hash is stored, so lookup is by hash
// equality (constant-time w.r.t. the secret) — a wrong key never matches a row.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { db, tenants, users, mcpApiKeys } from '../src/db/client';
import {
  mintKey,
  verifyKey,
  revokeKey,
  isMcpApiKey,
} from '../src/services/mcp-api-key';
import { UnauthorizedError } from '../src/types';

const TENANT_ID = '00000000-0000-0000-0000-00000000ce01';
const USER_ID = '00000000-0000-0000-0000-00000000ce02';

async function cleanup() {
  await db.delete(mcpApiKeys).where(inArray(mcpApiKeys.tenant_id, [TENANT_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_ID]));
  await db.delete(users).where(inArray(users.id, [USER_ID]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  await cleanup();
  await db.insert(users)
    .values({ id: USER_ID, email: 'keymaker@test.dev', name: 'Key Maker' })
    .onConflictDoNothing({ target: users.id });
  await db.insert(tenants)
    .values({ id: TENANT_ID, name: 'Key Tenant', slug: `key-tenant-${TENANT_ID.slice(-6)}` })
    .onConflictDoNothing({ target: tenants.id });
}, 30_000);

afterAll(cleanup, 30_000);

test('isMcpApiKey discriminates the cp_mcp_ namespace', () => {
  expect(isMcpApiKey('cp_mcp_abcd_secret')).toBe(true);
  expect(isMcpApiKey('Bearer something')).toBe(false);
  expect(isMcpApiKey('')).toBe(false);
  expect(isMcpApiKey(null)).toBe(false);
});

test('mint → verify resolves the tenant identity + scopes', async () => {
  const minted = await mintKey({ tenantId: TENANT_ID, issuedBy: USER_ID, name: 'ext-client' });
  expect(minted.raw.startsWith('cp_mcp_')).toBe(true);

  const v = await verifyKey(minted.raw);
  expect(v.keyId).toBe(minted.id);
  expect(v.tenantId).toBe(TENANT_ID);
  expect(v.userId).toBe(USER_ID);
  expect(v.scopes).toEqual(['tools', 'resources', 'prompts']);
});

test('a non-MCP bearer is rejected before any DB lookup', async () => {
  await expect(verifyKey('not-an-mcp-key')).rejects.toBeInstanceOf(UnauthorizedError);
});

test('an unknown / tampered key never matches a stored hash', async () => {
  const minted = await mintKey({ tenantId: TENANT_ID, issuedBy: USER_ID, name: 'k' });
  // flip the last char of the secret → different sha256 → no row
  const tampered = `${minted.raw.slice(0, -1)}${minted.raw.endsWith('x') ? 'y' : 'x'}`;
  await expect(verifyKey(tampered)).rejects.toThrow(/Invalid MCP API key/);
  await expect(verifyKey('cp_mcp_dead_beef')).rejects.toThrow(/Invalid MCP API key/);
});

test('a revoked key is rejected', async () => {
  const minted = await mintKey({ tenantId: TENANT_ID, issuedBy: USER_ID, name: 'k' });
  expect(await verifyKey(minted.raw)).toBeTruthy(); // valid pre-revoke
  const revoked = await revokeKey(TENANT_ID, minted.id);
  expect(revoked).toBe(true);
  await expect(verifyKey(minted.raw)).rejects.toThrow(/revoked/);
  // a second revoke is a no-op (already revoked)
  expect(await revokeKey(TENANT_ID, minted.id)).toBe(false);
});

test('an expired key is rejected (the branch the route test never hits)', async () => {
  const minted = await mintKey({
    tenantId: TENANT_ID,
    issuedBy: USER_ID,
    name: 'k',
    expiresAt: new Date(Date.now() - 1000),
  });
  await expect(verifyKey(minted.raw)).rejects.toThrow(/expired/);
});
