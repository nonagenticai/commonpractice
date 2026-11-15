// tests/ontology-tenant-i18n.test.ts — Phase 3.7: per-locale i18n for TENANT-authored
// ontology. Proves over real CI Postgres :5433:
//   (a) an admin sets a non-en label/desc on a custom entity → compile(locale) overlays it;
//   (b) translations are isolated per org even when two tenants override the SAME global
//       entity (shared natural key) — a tenant override never inherits the global's nor the
//       other tenant's translation;
//   (c) GET returns the authored set; a member cannot write (403); en / unknown locale 400.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerOntologyRoutes } from '../src/routes/ontology';
import { seedOntology } from '../src/db/seed-ontology';
import {
  db, users, tenants, ontologyEntities, ontologyRelations, contentTranslations,
} from '../src/db/client';
import type { User } from '../src/types';
import { ONTOLOGY_ENTITY_TENANT_I18N } from '../src/ontology/ontology-service';
import type { CompiledOntology } from '../src/ontology/ontology-service';

const ORG = '00000000-0000-0000-0000-00000d000001';
const OTHER = '00000000-0000-0000-0000-00000d000002';
const ADMIN_ID = '00000000-0000-0000-0000-00000d00ad01';
const MEMBER_ID = '00000000-0000-0000-0000-00000d00be01';
const OUTSIDER_ID = '00000000-0000-0000-0000-00000d00cf01';
const admin: User = { id: ADMIN_ID, email: 'ti18n-admin@test', name: 'Ada Admin', roles: ['employee', 'tenant_admin'], tenantId: ORG };
const member: User = { id: MEMBER_ID, email: 'ti18n-member@test', name: 'Manny Member', roles: ['employee'], tenantId: ORG };
const outsider: User = { id: OUTSIDER_ID, email: 'ti18n-outsider@test', name: 'Otto Outsider', roles: ['employee', 'tenant_admin'], tenantId: OTHER };

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

const router = new Router();
registerOntologyRoutes(router);

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

const cell = async (u: User, locale = 'en'): Promise<CompiledOntology> => {
  asUser(u);
  const r = await call('GET', `/api/ontology?industry=insurance&department=Claims&locale=${locale}`);
  return r.json;
};

async function cleanup() {
  await db
    .delete(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, ONTOLOGY_ENTITY_TENANT_I18N),
        or(like(contentTranslations.entity_id, `${ORG}:%`), like(contentTranslations.entity_id, `${OTHER}:%`)),
      ),
    );
  await db.delete(ontologyRelations).where(inArray(ontologyRelations.tenant_id, [ORG, OTHER]));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.tenant_id, [ORG, OTHER]));
  await db.delete(users).where(inArray(users.id, [ADMIN_ID, MEMBER_ID, OUTSIDER_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [ORG, OTHER]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seedOntology();
  await cleanup();
  await db.insert(tenants).values([
    { id: ORG, name: 'Acme Ins', slug: 'acme-ins-ti18n', industry: 'insurance' },
    { id: OTHER, name: 'Other Ins', slug: 'other-ins-ti18n', industry: 'insurance' },
  ]);
  await db.insert(users).values([
    { id: ADMIN_ID, email: admin.email, name: admin.name, tenant_id: ORG },
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: ORG },
    { id: OUTSIDER_ID, email: outsider.email, name: outsider.name, tenant_id: OTHER },
  ]);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

let customId = '';

test('admin sets a nl label/desc on a custom entity → compile(nl) overlays it; GET returns it', async () => {
  asUser(admin);
  const created = await call('POST', '/api/ontology/entities', {
    scope: 'industry_dept', industry: 'insurance', department: 'Claims',
    name: 'ZZCustomNote', label: 'Custom Note', description: 'EN base.',
  });
  expect(created.status).toBe(201);
  customId = created.json.id;

  const put = await call('PUT', `/api/ontology/entities/${customId}/translations`, {
    locale: 'nl', label: 'Aangepaste notitie', description: 'NL beschrijving.',
  });
  expect(put.status).toBe(200);

  // en base unchanged; nl overlaid.
  const en = await cell(admin, 'en');
  expect(en.entities.find((e) => e.name === 'ZZCustomNote')!.label).toBe('Custom Note');
  const nl = await cell(admin, 'nl');
  const note = nl.entities.find((e) => e.name === 'ZZCustomNote')!;
  expect(note.label).toBe('Aangepaste notitie');
  expect(note.description).toBe('NL beschrijving.');

  const got = await call('GET', `/api/ontology/entities/${customId}/translations`);
  expect(got.json.translations.nl.label).toBe('Aangepaste notitie');
  expect(got.json.translations.nl.description).toBe('NL beschrijving.');
});

test('a PUT that OMITS a field leaves it alone; only an explicit blank/null clears it', async () => {
  asUser(admin);
  // Re-saving just the label must not touch the nl description authored above. The route used to
  // build BOTH keys unconditionally (`description: undefined`), and `'description' in {...}` is
  // true, so the service read the absent field as "cleared" and deleted the row — a silent 200.
  const labelOnly = await call('PUT', `/api/ontology/entities/${customId}/translations`, {
    locale: 'nl', label: 'Aangepaste notitie 2',
  });
  expect(labelOnly.status).toBe(200);
  let got = await call('GET', `/api/ontology/entities/${customId}/translations`);
  expect(got.json.translations.nl.label).toBe('Aangepaste notitie 2');
  expect(got.json.translations.nl.description).toBe('NL beschrijving.');

  // Symmetrically, sending only the description must not drop the label.
  const descOnly = await call('PUT', `/api/ontology/entities/${customId}/translations`, {
    locale: 'nl', description: 'NL beschrijving 2.',
  });
  expect(descOnly.status).toBe(200);
  got = await call('GET', `/api/ontology/entities/${customId}/translations`);
  expect(got.json.translations.nl.label).toBe('Aangepaste notitie 2');
  expect(got.json.translations.nl.description).toBe('NL beschrijving 2.');

  // The clear path still works — that is what an explicit null / '' is for.
  const cleared = await call('PUT', `/api/ontology/entities/${customId}/translations`, {
    locale: 'nl', description: null,
  });
  expect(cleared.status).toBe(200);
  got = await call('GET', `/api/ontology/entities/${customId}/translations`);
  expect(got.json.translations.nl.label).toBe('Aangepaste notitie 2');
  expect(got.json.translations.nl.description).toBeUndefined();
});

test('tenant translations are isolated when two orgs override the same global entity', async () => {
  // Both orgs override the global insurance Policy (shared natural key).
  asUser(admin);
  const a = await call('POST', '/api/ontology/entities', {
    scope: 'industry', industry: 'insurance', name: 'Policy', label: 'ORG Policy',
  });
  expect(a.status).toBe(201);
  await call('PUT', `/api/ontology/entities/${a.json.id}/translations`, { locale: 'nl', label: 'ORG Polis NL' });

  asUser(outsider);
  const b = await call('POST', '/api/ontology/entities', {
    scope: 'industry', industry: 'insurance', name: 'Policy', label: 'OTHER Policy',
  });
  expect(b.status).toBe(201);

  // ORG sees its own nl translation.
  const orgNl = await cell(admin, 'nl');
  expect(orgNl.entities.find((e) => e.name === 'Policy')!.label).toBe('ORG Polis NL');

  // OTHER overrode Policy but authored NO nl translation → it keeps its own EN label, and
  // must NOT inherit ORG's translation NOR the global's nl label ('Polis').
  const otherNl = await cell(outsider, 'nl');
  expect(otherNl.entities.find((e) => e.name === 'Policy')!.label).toBe('OTHER Policy');
});

test('a member cannot write (403); en / unknown locale rejected (400)', async () => {
  asUser(member);
  const denied = await call('PUT', `/api/ontology/entities/${customId}/translations`, { locale: 'nl', label: 'x' });
  expect(denied.status).toBe(403);

  asUser(admin);
  const enReject = await call('PUT', `/api/ontology/entities/${customId}/translations`, { locale: 'en', label: 'x' });
  expect(enReject.status).toBe(400);
  const badReject = await call('PUT', `/api/ontology/entities/${customId}/translations`, { locale: 'xx', label: 'x' });
  expect(badReject.status).toBe(400);
});
