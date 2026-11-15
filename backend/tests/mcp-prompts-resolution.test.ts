// tests/mcp-prompts-resolution.test.ts — DB-FREE unit test for `pickPromptRow`, the
// mcp_prompts resolution order extracted from `getPrompt` (src/ai/mcp/prompts.ts).
//
// Adversarial hunt: getPrompt used to fetch EVERY tenant's rows for a given prompt `name`
// (no tenant filter in the query) and, when neither the exact (tenant, locale) nor either
// global tier matched, fell back to `rows[0]!` — whichever row the DB happened to return
// first, including a FOREIGN tenant's override. Only global rows exist in prod today
// (seed-ai.ts always writes tenant_id: null, verified: 24 rows, all NULL) so this was
// LATENT, not live — but 0028_rls.sql's schema explicitly supports tenant-scoped overrides,
// so the first one ever written is one unlucky row-ordering away from leaking into another
// tenant's agent session.
//
// This file exercises the pure resolver directly (no DB, no network) so it can run today
// despite the local Postgres being in crash recovery — see the handoff note in the PR.
import { test, expect } from 'bun:test';
import { pickPromptRow, type PromptRowLike } from '../src/ai/mcp/prompts';

const TENANT_A = '10000000-0000-4000-8000-00000000000a';
const TENANT_B = '10000000-0000-4000-8000-00000000000b';

function row(tenant_id: string | null, locale: string, template: string): PromptRowLike {
  return { tenant_id, locale, template };
}

test('exact (tenant, locale) match wins over a global row', () => {
  const rows = [row(null, 'en', 'GLOBAL_EN'), row(TENANT_A, 'en', 'TENANT_A_EN')];
  const pick = pickPromptRow(rows, { locale: 'en', tenantId: TENANT_A });
  expect(pick?.template).toBe('TENANT_A_EN');
});

test('falls back to the global row in the requested locale when the tenant has none', () => {
  const rows = [row(null, 'de', 'GLOBAL_DE'), row(null, 'en', 'GLOBAL_EN')];
  const pick = pickPromptRow(rows, { locale: 'de', tenantId: TENANT_A });
  expect(pick?.template).toBe('GLOBAL_DE');
});

test('falls back to the global en row when neither the tenant nor the requested locale has one', () => {
  const rows = [row(null, 'en', 'GLOBAL_EN'), row(null, 'fr', 'GLOBAL_FR')];
  const pick = pickPromptRow(rows, { locale: 'de', tenantId: TENANT_A });
  expect(pick?.template).toBe('GLOBAL_EN');
});

// ── the regression case: this is the exact shape the old `rows[0]!` fallback got wrong.
// Reproduces what the OLD (unscoped) query would have handed the resolver: tenant B's row
// sorts first, tenant A is asking, and there is no exact match and no global row at all for
// the requested locale/en. The old code would return tenant B's row here. ─────────────────
test('NEVER falls back to a foreign tenant row — even when it sorts first and no global row matches', () => {
  const rows = [row(TENANT_B, 'de', 'TENANT_B_DE'), row(TENANT_A, 'fr', 'TENANT_A_FR')];
  const pick = pickPromptRow(rows, { locale: 'de', tenantId: TENANT_A });
  expect(pick).toBeNull(); // no exact match, no global row — refuse, don't guess
  expect(pick).not.toBe(rows[0]);
});

test('NEVER falls back to a foreign tenant row even when a global row exists but in another locale', () => {
  // Old logic: (tenant,locale) miss, (global,locale) miss, (global,en) miss → rows[0]! →
  // could still be TENANT_B's row if it happens to sort before the global 'fr' row.
  const rows = [row(TENANT_B, 'de', 'TENANT_B_DE'), row(null, 'fr', 'GLOBAL_FR')];
  const pick = pickPromptRow(rows, { locale: 'de', tenantId: TENANT_A });
  expect(pick?.template).toBe('GLOBAL_FR'); // the safe global row, not tenant B's
});

test('a platform/global caller (tenantId: null) never receives a tenant-scoped row', () => {
  const rows = [row(TENANT_B, 'en', 'TENANT_B_EN'), row(null, 'en', 'GLOBAL_EN')];
  const pick = pickPromptRow(rows, { locale: 'en', tenantId: null });
  expect(pick?.template).toBe('GLOBAL_EN');
});

test('returns null (not a throw, not an arbitrary row) when nothing eligible exists', () => {
  const rows = [row(TENANT_B, 'de', 'TENANT_B_DE')];
  const pick = pickPromptRow(rows, { locale: 'en', tenantId: TENANT_A });
  expect(pick).toBeNull();
});
