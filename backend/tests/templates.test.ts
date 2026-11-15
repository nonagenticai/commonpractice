// tests/templates.test.ts — block-template starter catalog (0043 + seed-templates + routes/templates).
//
// Covers: the seed is idempotent (a second run creates nothing), the read API filters by category +
// search, and a logic template round-trips its formal structure (preconditions/postconditions/steps)
// into a runnable source scaffold + a matching descriptor. Runs against the owner connection (RLS
// bypassed in dev/test); auth via the __setAuthOverridesForTests seam (house rule — no mock.module).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerTemplateRoutes } from '../src/routes/templates';
import { seedTemplates } from '../src/db/seed-templates';
import { db, tenants, users } from '../src/db/client';
import type { User } from '../src/types';

const TENANT = '00000000-0000-0000-0000-00000713a001';
const TENANT_B = '00000000-0000-0000-0000-00000713a002';
const developer: User = {
  id: '00000000-0000-0000-0000-00000713a0de',
  email: 'tpl-dev@test',
  name: 'Tpl Dev',
  roles: ['developer'],
  tenantId: TENANT,
};
const viewer: User = {
  id: '00000000-0000-0000-0000-00000713a0f1',
  email: 'tpl-viewer@test',
  name: 'Tpl Viewer',
  roles: ['member'],
  tenantId: TENANT,
};
const developerB: User = {
  id: '00000000-0000-0000-0000-00000713a0db',
  email: 'tpl-dev-b@test',
  name: 'Tpl Dev B',
  roles: ['developer'],
  tenantId: TENANT_B,
};

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

const router = new Router();
registerTemplateRoutes(router);

async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  await db.delete(users).where(inArray(users.id, [developer.id, viewer.id, developerB.id]));
  // Deleting the tenants cascades any tenant-authored block_templates created by the 5D tests.
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, TENANT_B]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seedTemplates(); // idempotent — creates the global logic catalog if absent
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT, name: 'Tpl Tenant', slug: 'tpl-tenant' },
    { id: TENANT_B, name: 'Tpl Tenant B', slug: 'tpl-tenant-b' },
  ]);
  await db.insert(users).values([
    { id: developer.id, email: developer.email, name: developer.name, tenant_id: TENANT },
    { id: viewer.id, email: viewer.email, name: viewer.name, tenant_id: TENANT },
    { id: developerB.id, email: developerB.email, name: developerB.name, tenant_id: TENANT_B },
  ]).onConflictDoNothing();
}, 30_000);
afterAll(cleanup, 30_000);
afterEach(() => __setAuthOverridesForTests(undefined));

test('seedTemplates is idempotent (a second run creates nothing)', async () => {
  const again = await seedTemplates();
  expect(again.created).toBe(0);
  expect(again.total).toBeGreaterThan(0);
});

test('GET /api/templates?category=logic returns the logic catalog', async () => {
  asUser(developer);
  const { status, json } = await call('GET', '/api/templates?category=logic');
  expect(status).toBe(200);
  expect(json.templates.length).toBeGreaterThan(0);
  expect(json.templates.every((t: { category: string }) => t.category === 'logic')).toBe(true);
  // The facet list reflects what was returned.
  expect(json.categories).toContain('logic');
});

test('GET /api/templates?q= filters by search term', async () => {
  asUser(developer);
  const { json } = await call('GET', '/api/templates?category=logic&q=validate');
  expect(json.templates.length).toBeGreaterThan(0);
  expect(json.templates.some((t: { name: string }) => t.name === 'validate-record')).toBe(true);
  const { json: none } = await call('GET', '/api/templates?category=logic&q=zzz-no-such-template');
  expect(none.templates.length).toBe(0);
});

test('an unknown category is rejected', async () => {
  asUser(developer);
  const { status } = await call('GET', '/api/templates?category=nope');
  expect(status).toBe(400);
});

test('a logic template round-trips its formal structure into a runnable scaffold', async () => {
  asUser(developer);
  const { json: list } = await call('GET', '/api/templates?category=logic');
  const summary = list.templates.find((t: { name: string }) => t.name === 'validate-record');
  expect(summary).toBeTruthy();

  const { status, json } = await call('GET', `/api/templates/${summary.id}`);
  expect(status).toBe(200);
  const t = json.template;
  // Formal structure present.
  expect(t.preconditions.length).toBeGreaterThan(0);
  expect(t.postconditions.length).toBeGreaterThan(0);
  expect(t.steps.length).toBeGreaterThan(0);
  // Descriptor inputs/outputs surfaced.
  expect(Object.keys(t.descriptor.inputs)).toContain('record');
  expect(Object.keys(t.descriptor.outputs)).toContain('valid');
  // Rendered source is a runnable SDK module that embeds the descriptor + the steps as guidance.
  expect(t.source_ts).toContain('export default {');
  expect(t.source_ts).toContain('async run(inputs, ctx)');
  expect(t.source_ts).toContain('Validate the record'.slice(0, 0) + t.steps[0].label);
  // Rendered docs carry the label + a steps section.
  expect(t.docs_md).toContain(`# ${t.label}`);
  expect(t.docs_md).toContain('## Steps');
});

test('the ui + ai catalogs are seeded and category-filterable', async () => {
  asUser(developer);
  const { json: ui } = await call('GET', '/api/templates?category=ui');
  expect(ui.templates.length).toBeGreaterThan(0);
  expect(ui.templates.every((t: { category: string }) => t.category === 'ui')).toBe(true);

  const { json: ai } = await call('GET', '/api/templates?category=ai');
  expect(ai.templates.length).toBeGreaterThan(0);
  expect(ai.templates.some((t: { name: string }) => t.name === 'classify')).toBe(true);
});

test('an ai template scaffolds with the llm capability enabled', async () => {
  asUser(developer);
  const { json: list } = await call('GET', '/api/templates?category=ai');
  const summary = list.templates.find((t: { name: string }) => t.name === 'summarize');
  expect(summary).toBeTruthy();
  const { json } = await call('GET', `/api/templates/${summary.id}`);
  expect(json.template.descriptor.capabilities.llm).toBe(true);
  expect(json.template.source_ts).toContain('export default {');
});

test('GET /api/templates/:id 404s for an unknown id', async () => {
  asUser(developer);
  const { status } = await call('GET', '/api/templates/00000000-0000-0000-0000-0000000000ff');
  expect(status).toBe(404);
});

// ---- Phase 5D: POST /api/templates (save as template) ----

test('POST /api/templates creates a tenant template (developer); 403 for non-developer; 409 on dup; tenant-isolated', async () => {
  const body = {
    name: 'tpl-save-a',
    label: 'Tpl Save A',
    category: 'logic',
    description: 'a saved block',
    descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },
    source_ts: 'export default {};',
    docs_md: 'docs',
  };

  // Developer → 201, tenant-owned.
  asUser(developer);
  const created = await call('POST', '/api/templates', body);
  expect(created.status).toBe(201);
  expect(created.json.template).toMatchObject({ name: 'tpl-save-a', label: 'Tpl Save A', tenantOwned: true });
  const id = created.json.template.id as string;

  // Visible to its own tenant's list…
  const listA = await call('GET', '/api/templates?category=logic');
  expect((listA.json.templates as { id: string }[]).some((t) => t.id === id)).toBe(true);

  // …but not to another tenant's developer.
  asUser(developerB);
  const listB = await call('GET', '/api/templates?category=logic');
  expect((listB.json.templates as { id: string }[]).some((t) => t.id === id)).toBe(false);

  // Non-developer → 403.
  asUser(viewer);
  const denied = await call('POST', '/api/templates', { ...body, name: 'tpl-save-x' });
  expect(denied.status).toBe(403);
  expect(denied.json.error).toBe('developer_required');

  // Duplicate (category, domain, name) for the same tenant → 409.
  asUser(developer);
  const dup = await call('POST', '/api/templates', body);
  expect(dup.status).toBe(409);
  expect(dup.json.error).toBe('template_name_taken');
  // The clashing name must be a named field a catalog can interpolate, not English-only prose.
  expect(dup.json.details.name).toBe('tpl-save-a');
});

test('POST /api/templates persists PKO/PDDL formal structure', async () => {
  asUser(developer);
  const body = {
    name: 'tpl-formal',
    label: 'Tpl Formal',
    category: 'logic',
    descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },
    preconditions: ['input has rows'],
    postconditions: ['rows deduped'],
    steps: [{ label: 'Dedupe', detail: 'remove duplicate ids' }],
  };
  const created = await call('POST', '/api/templates', body);
  expect(created.status).toBe(201);
  const { json } = await call('GET', `/api/templates/${created.json.template.id}`);
  expect(json.template.preconditions).toEqual(['input has rows']);
  expect(json.template.postconditions).toEqual(['rows deduped']);
  expect(json.template.steps).toEqual([{ label: 'Dedupe', detail: 'remove duplicate ids' }]);
});

// ---- DELETE /api/templates/:id (remove an own-tenant template) ----

test('DELETE /api/templates/:id removes own-tenant only; 403 non-dev; 404 cross-tenant + global', async () => {
  asUser(developer);
  const created = await call('POST', '/api/templates', {
    name: 'tpl-del-a',
    label: 'Tpl Del A',
    category: 'logic',
    descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },
  });
  expect(created.status).toBe(201);
  const id = created.json.template.id as string;

  // Non-developer → 403 (and the row survives).
  asUser(viewer);
  const denied = await call('DELETE', `/api/templates/${id}`);
  expect(denied.status).toBe(403);
  expect(denied.json.error).toBe('developer_required');

  // Another tenant's developer → 404 (own-tenant clause is a clean no-match).
  asUser(developerB);
  const cross = await call('DELETE', `/api/templates/${id}`);
  expect(cross.status).toBe(404);

  // A shipped GLOBAL template id → 404 (globals are seed-only, never deletable).
  asUser(developer);
  const { json: list } = await call('GET', '/api/templates?category=logic');
  const globalRow = (list.templates as { id: string; tenantOwned: boolean }[]).find((t) => !t.tenantOwned);
  expect(globalRow).toBeTruthy();
  const globalDel = await call('DELETE', `/api/templates/${globalRow!.id}`);
  expect(globalDel.status).toBe(404);

  // Owner deletes own row → 200, then it's gone from the list and a re-delete 404s.
  const ok = await call('DELETE', `/api/templates/${id}`);
  expect(ok.status).toBe(200);
  expect(ok.json.ok).toBe(true);
  const after = await call('GET', '/api/templates?category=logic');
  expect((after.json.templates as { id: string }[]).some((t) => t.id === id)).toBe(false);
  const again = await call('DELETE', `/api/templates/${id}`);
  expect(again.status).toBe(404);
});
