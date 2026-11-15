// tests/rls-coverage.test.ts — Phase D (RLS) anti-drift guard.
//
// Enumerates every public table carrying a `tenant_id` column and asserts it is RLS-enabled with at
// least one policy (minus an explicit platform allowlist), and that the runtime role `cp_app` is
// non-superuser + NOBYPASSRLS. A new tenant-scoped table that forgets a policy — or a regression that
// grants cp_app BYPASSRLS — fails the build. Runs as the owner/superuser default connection (which is
// all this needs: it only reads pg_catalog). The actual ENFORCEMENT is proven in rls-isolation.test.ts.
//
// ⚠ KNOWN BLIND SPOT — this guard enumerates only tables that CARRY a `tenant_id` column. The eight
// "child-via-parent" tables (0028 §4d / 0037 §4: block_versions, block_tests, block_test_results,
// ontology_attributes, mcp_prompt_versions, challenge_datasets, chat_messages, dataset_rows) carry
// none by design — they are scoped entirely through their parent's policy — so they never appear in
// the query below and this test can say nothing about them. That is exactly how five of them shipped
// a `FOR ALL` policy whose predicate only checked parent VISIBILITY, letting any tenant UPDATE /
// DELETE / INSERT the children of a platform-GLOBAL parent for months: RLS was enabled and a policy
// existed, so this test was green throughout. Migration 0057 split those five into read+write
// policies; the enforcement proof lives in tests/rls-child-write.test.ts, which also pins the policy
// SHAPE so a regression is caught here-adjacent rather than not at all.
import { test, expect } from 'bun:test';
import { queryClient } from '../src/db/client';

// Tables that carry a `tenant_id` column but are intentionally OUTSIDE the per-tenant RLS regime:
//   users               — read/written by resolveTenant→ensureUser BEFORE the tenant is known
//                          (chicken-and-egg); authz is claim-derived, not row-level.
//   email_domain_tenants — platform onboarding routing (domain → tenant); a super_admin surface.
//   audit_log            — 0083 gave it a `tenant_id` so rows are ATTRIBUTABLE; it stays outside
//                          RLS deliberately, and 0028_rls.sql:21-25 already lists it as a
//                          PLATFORM/GLOBAL table alongside `tenants`, `users` and
//                          `signup_approvals`. Two reasons it must not gain a policy: platform
//                          actions legitimately have a NULL tenant and would become invisible to
//                          the console that exists to show them, and an append-only trail scoped
//                          by the operator's current tenant is exactly the wrong thing to hand
//                          someone investigating a cross-tenant incident.
//                          ⚠️ THE GUARD WAS RIGHT TO FIRE HERE. Adding a tenant_id column to a
//                          table with no policy is precisely the drift it watches for; this entry
//                          is the documented exemption it asks for, not a way around it.
const ALLOWLIST = new Set(['users', 'email_domain_tenants', 'audit_log']);

test('every table with a tenant_id column is RLS-enabled with a policy (or explicitly allowlisted)', async () => {
  const rows = await queryClient<
    { relname: string; relrowsecurity: boolean; npol: number }[]
  >`
    SELECT c.relname,
           c.relrowsecurity,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS npol
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
      )
    ORDER BY c.relname
  `;

  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    if (ALLOWLIST.has(r.relname)) continue;
    expect(r.relrowsecurity, `${r.relname}: ROW LEVEL SECURITY must be enabled`).toBe(true);
    expect(Number(r.npol), `${r.relname}: must have at least one RLS policy`).toBeGreaterThan(0);
  }
});

// Phase 4 / D.1.1: the 11 tenant-scoped tables whose tenant_id 0028 added as NULLABLE are now NOT
// NULL (migration 0029). Lock that in: a future migration/schema drift that re-nulls a scoped column
// (re-opening the fail-closed-but-NULL hole) fails the build. pipeline_items has no tenant_id column
// (it is the platform-global Operate board, deliberately outside the tenant regime).
test('the D.1.1 tenant-scoped columns are NOT NULL', async () => {
  const TABLES = [
    'flows', 'sandboxes', 'usage_counters', 'agent_sessions', 'chat_sessions',
    'flow_runs', 'flow_snapshots', 'solutions', 'votes', 'comments', 'weekly_winners',
  ];
  const rows = await queryClient<{ table_name: string; is_nullable: string }[]>`
    SELECT table_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
      AND table_name IN ${queryClient(TABLES)}
  `;
  const seen = new Map(rows.map((r) => [r.table_name, r.is_nullable]));
  for (const t of TABLES) {
    expect(seen.get(t), `${t}.tenant_id must exist`).toBeDefined();
    expect(seen.get(t), `${t}.tenant_id must be NOT NULL (migration 0029)`).toBe('NO');
  }
});

test('the runtime role cp_app is non-superuser and NOBYPASSRLS', async () => {
  const [role] = await queryClient<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'cp_app'`;
  expect(role, 'cp_app role must exist (created by migration 0028)').toBeDefined();
  expect(role!.rolsuper, 'cp_app must NOT be a superuser').toBe(false);
  expect(role!.rolbypassrls, 'cp_app must NOT have BYPASSRLS').toBe(false);
});
