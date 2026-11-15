// tests/tenant-admin-audit-tenant-id.test.ts — every audit row written by a tenant-administration
// route names the tenant it ACTED ON (`tenantId:`), never the request context's.
//
// ⛔ Why a source guard: `recordAudit` falls back to `currentRequestContext()?.tenantId` — the
// ACTOR's workspace. A super_admin repairing tenant X from their own workspace filed the row under
// their own tenant, so X's /audit never showed it (found on `tenant.license_issue`, 2026-10-13).
// These call sites have no shared harness that a behavioural test could cover all of; a missing
// `tenantId:` is exactly a one-line omission, which this catches at every site in these files.
// (`tenant.license_issue` additionally has a behavioural test in tenant-licence-revoke-queue.test.ts.)
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// services/offboarding.ts: the whole-workspace offboard's audit row moved there (offboardTenantFully).
const FILES = [
  'src/routes/admin.ts',
  'src/routes/tenant-users.ts',
  'src/routes/sso.ts',
  'src/routes/onboarding.ts',
  'src/services/offboarding.ts',
];
/** Platform-level actions with no single tenant (a rejected self-signup has none; `signup.invite`
 *  is written BEFORE approve creates the workspace — the `signup.approve` row that follows names it). */
const NO_TENANT = new Set(["'signup.reject'", "'signup.invite'"]);

/** Each `recordAudit({...})` call: its action expression and its TOP-LEVEL keys. */
function auditCalls(src: string): { action: string; topKeys: string[]; line: number }[] {
  const out: { action: string; topKeys: string[]; line: number }[] = [];
  let at = 0;
  for (;;) {
    const start = src.indexOf('recordAudit({', at);
    if (start < 0) break;
    let i = start + 'recordAudit('.length;
    let depth = 0;
    let topText = '';
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (c === '{' || c === '(' || c === '[') depth++;
      if (depth === 1) topText += c;
      if (c === '}' || c === ')' || c === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    const topKeys = [...topText.matchAll(/^\s*([A-Za-z_]+)\s*[:,]/gm)].map((m) => m[1]!);
    const action = /action:\s*([^,\n]+)/.exec(src.slice(start, i))?.[1]?.trim() ?? '?';
    out.push({ action, topKeys, line: src.slice(0, start).split('\n').length });
    at = i;
  }
  return out;
}

test('every recordAudit in the tenant-admin routes passes the target tenantId explicitly', () => {
  const missing: string[] = [];
  let total = 0;
  for (const f of FILES) {
    const src = readFileSync(join(import.meta.dir, '..', f), 'utf8');
    expect(src.length, f).toBeGreaterThan(1000); // an unreadable path must not pass vacuously
    const calls = auditCalls(src);
    expect(calls.length, f).toBeGreaterThan(0);
    total += calls.length;
    for (const c of calls) {
      if (NO_TENANT.has(c.action)) continue;
      if (!c.topKeys.includes('tenantId')) missing.push(`${f}:${c.line} ${c.action}`);
    }
  }
  expect(total).toBeGreaterThanOrEqual(17);
  expect(missing).toEqual([]);
});

test('the parser sees a nested metadata.tenantId as NOT top-level (the guard can go red)', () => {
  const [c] = auditCalls(`recordAudit({ actorId: a, action: 'x', metadata: { tenantId: t } });`);
  expect(c!.topKeys).not.toContain('tenantId');
  const [d] = auditCalls(`recordAudit({\n  actorId: a,\n  tenantId: t,\n  action: 'x',\n});`);
  expect(d!.topKeys).toContain('tenantId');
});
