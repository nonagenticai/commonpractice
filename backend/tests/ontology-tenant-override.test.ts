// tests/ontology-tenant-override.test.ts — Phase 3.5 (SPEC §B2/§8): per-tenant ontology
// overrides/extensions. Proves over real CI Postgres :5433:
//   (a) an org admin (tenant_admin) adds a custom entity → it appears in that org's compiled
//       graph (tenantOwned) and a MEMBER browses it but CANNOT author (403);
//   (b) a DIFFERENT org does not see it (cross-tenant isolation);
//   (c) overriding a GLOBAL entity's label wins the merge for that tenant only;
//   (d) a custom relation appears; deleting the entity removes it and the entity;
//   (e) the entity-write REFUSALS carry their localization fields on `details` (`reason` for the two
//       codes routes/ontology.ts also throws with a different sentence, `attribute`/`name` for the
//       two that interpolate a value) while the English `message` stays byte-identical.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerOntologyRoutes } from '../src/routes/ontology';
import { seedOntology } from '../src/db/seed-ontology';
import { db, users, tenants, ontologyEntities, ontologyAttributes, ontologyRelations } from '../src/db/client';
import type { User } from '../src/types';
import type { CompiledOntology } from '../src/ontology/ontology-service';

const ORG = '00000000-0000-0000-0000-00000b000001';
const OTHER = '00000000-0000-0000-0000-00000b000002';
const ADMIN_ID = '00000000-0000-0000-0000-00000b00ad01'; // tenant_admin of ORG
const MEMBER_ID = '00000000-0000-0000-0000-00000b00be01'; // member of ORG
const OUTSIDER_ID = '00000000-0000-0000-0000-00000b00cf01'; // tenant_admin of OTHER
const admin: User = { id: ADMIN_ID, email: 'onto-admin@test', name: 'Ada Admin', roles: ['employee', 'tenant_admin'], tenantId: ORG };
const member: User = { id: MEMBER_ID, email: 'onto-member@test', name: 'Manny Member', roles: ['employee'], tenantId: ORG };
const outsider: User = { id: OUTSIDER_ID, email: 'onto-outsider@test', name: 'Otto Outsider', roles: ['employee', 'tenant_admin'], tenantId: OTHER };

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

const cell = (u: User) => {
  asUser(u);
  return call('GET', '/api/ontology?industry=insurance&department=Claims');
};

/** The stored attribute names for an entity, read straight from the table. */
async function attributeNames(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ name: ontologyAttributes.name })
    .from(ontologyAttributes)
    .where(eq(ontologyAttributes.entity_id, entityId));
  return rows.map((r) => r.name).sort();
}

async function cleanup() {
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
    { id: ORG, name: 'Acme Ins', slug: 'acme-ins-onto', industry: 'insurance' },
    { id: OTHER, name: 'Other Ins', slug: 'other-ins-onto', industry: 'insurance' },
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

let entityId = '';

test('admin adds a custom entity; a member browses it but cannot author (403)', async () => {
  asUser(admin);
  const created = await call('POST', '/api/ontology/entities', {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'ZZBrokerNote',
    label: 'Broker Note',
    synonyms: ['broker_memo'],
    description: 'A custom org object.',
    attributes: [{ name: 'author', type: 'string', pii: true }],
  });
  expect(created.status).toBe(201);
  entityId = created.json.id;

  // The member sees it (tenantOwned) but canManage is false.
  const view = await cell(member);
  expect(view.status).toBe(200);
  expect(view.json.canManage).toBe(false);
  const g = view.json as CompiledOntology & { canManage: boolean };
  const note = g.entities.find((e) => e.name === 'ZZBrokerNote')!;
  expect(note).toBeTruthy();
  expect((note as unknown as { tenantOwned: boolean }).tenantOwned).toBe(true);
  expect(note.attributes.map((a) => a.name)).toContain('author');

  // A member may not author the ontology.
  asUser(member);
  const denied = await call('POST', '/api/ontology/entities', {
    scope: 'industry_dept', industry: 'insurance', department: 'Claims', name: 'Sneaky', label: 'Sneaky',
  });
  expect(denied.status).toBe(403);
});

test('a different org does not see the custom entity (isolation)', async () => {
  const view = await cell(outsider);
  const names = (view.json as CompiledOntology).entities.map((e) => e.name);
  expect(names).not.toContain('ZZBrokerNote');
});

test('overriding a global entity label wins the merge for that tenant only', async () => {
  asUser(admin);
  const created = await call('POST', '/api/ontology/entities', {
    scope: 'industry',
    industry: 'insurance',
    name: 'Policy',
    label: 'Org Policy',
    description: 'Our own policy definition.',
  });
  expect(created.status).toBe(201);

  const orgView = await cell(admin);
  const orgPolicy = (orgView.json as CompiledOntology).entities.find((e) => e.name === 'Policy')!;
  expect(orgPolicy.label).toBe('Org Policy');
  expect((orgPolicy as unknown as { tenantOwned: boolean }).tenantOwned).toBe(true);

  // The other org still sees the shipped global label.
  const otherView = await cell(outsider);
  const otherPolicy = (otherView.json as CompiledOntology).entities.find((e) => e.name === 'Policy')!;
  expect(otherPolicy.label).toBe('Policy');
});

test('a custom relation appears; deleting the entity removes it and the entity', async () => {
  asUser(admin);
  // Find the Claim id in the org's compiled graph to connect the custom entity to it.
  const before = await cell(admin);
  const claim = (before.json as CompiledOntology).entities.find((e) => e.name === 'Claim')!;
  const rel = await call('POST', '/api/ontology/relations', {
    fromEntityId: entityId,
    toEntityId: claim.id,
    predicate: 'annotates',
    label: 'annotates',
    cardinality: 'many-to-one',
  });
  expect(rel.status).toBe(201);

  const withRel = await cell(admin);
  const edge = (withRel.json as CompiledOntology).relations.find(
    (r) => r.from === 'ZZBrokerNote' && r.to === 'Claim' && r.predicate === 'annotates',
  )!;
  expect(edge).toBeTruthy();
  expect((edge as unknown as { tenantOwned: boolean }).tenantOwned).toBe(true);

  // Deleting the entity cascades the edge.
  const del = await call('DELETE', `/api/ontology/entities/${entityId}`);
  expect(del.status).toBe(200);
  const after = await cell(admin);
  const g = after.json as CompiledOntology;
  expect(g.entities.some((e) => e.name === 'ZZBrokerNote')).toBe(false);
  expect(g.relations.some((r) => r.from === 'ZZBrokerNote')).toBe(false);
});

test('a PATCH with duplicate attribute names is refused and keeps the stored attributes', async () => {
  asUser(admin);
  const created = await call('POST', '/api/ontology/entities', {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'ZZAdjusterNote',
    label: 'Adjuster Note',
    attributes: [
      { name: 'author', type: 'string' },
      { name: 'severity', type: 'string' },
    ],
  });
  expect(created.status).toBe(201);
  const id = created.json.id;

  // Two attributes sharing a name violate ontology_attributes_entity_name_uq. The edit used to
  // DELETE the whole set and then fail the multi-row insert outside any transaction, so the 500
  // left the entity with ZERO attributes.
  const dupe = await call('PATCH', `/api/ontology/entities/${id}`, {
    attributes: [
      { name: 'author', type: 'string' },
      { name: 'author', type: 'number' },
    ],
  });
  expect(dupe.status).toBe(400);
  expect(dupe.json.error).toBe('duplicate_attribute');
  // ⛔ THE NAME MUST BE A FIELD, NOT ONLY PROSE. `writeErrorText` has no catalog entry for this code,
  // so a Dutch tenant reads the English "Attribute 'author' is listed more than once" verbatim. A
  // catalog can only rebuild that sentence if the offending name is on the wire as a NAMED value —
  // regex-scraping it back out of an English sentence is not a localization strategy. Asserted on
  // `details` (the seam) and NOT on the spread top-level copy, which is legacy.
  expect(dupe.json.details).toEqual({ attribute: 'author' });

  // Read the ROWS, not the compiled graph: compileEffective memoizes per (tenant, locale, cell)
  // and only a completed write clears it, so a failed edit would be served from cache and any
  // assertion made through `cell()` would pass without proving a thing.
  expect(await attributeNames(id)).toEqual(['author', 'severity']);

  // The OTHER half of the fix: any insert failure — not just the duplicate the validation now
  // catches — must roll the delete back. A NUL byte in a name is rejected by Postgres itself
  // (22021), so it exercises the atomicity of delete+insert with the name guard satisfied.
  let insertFailed = false;
  try {
    await call('PATCH', `/api/ontology/entities/${id}`, {
      attributes: [{ name: 'author\u0000x', type: 'string' }],
    });
  } catch {
    insertFailed = true; // an unmapped driver error — a 500 through server.ts, not a 4xx
  }
  expect(insertFailed).toBe(true);
  expect(await attributeNames(id)).toEqual(['author', 'severity']);

  // A legitimate replace still works.
  const ok = await call('PATCH', `/api/ontology/entities/${id}`, {
    attributes: [{ name: 'reviewer', type: 'string' }],
  });
  expect(ok.status).toBe(200);
  expect(await attributeNames(id)).toEqual(['reviewer']);
});

test('the entity-write refusals carry their localization fields on `details`', async () => {
  // ⛔ WHAT THIS PINS, AND WHY A STATUS CODE WOULD NOT PIN IT. `writeErrorText`
  // (frontend/src/lib/api/error-message.ts) renders the backend's ENGLISH `message` verbatim for any
  // 400/409/422 code it holds no catalog entry for, and `/ontology` calls it at three sites. So the
  // status assertions these tests already make are satisfied by a body no Dutch reader can read.
  // Each case below asserts the FIELD a catalog needs; every one of them fails if `details` is
  // dropped from the throw.
  asUser(admin);

  // `reason` — one code, TWO refusals. routes/ontology.ts throws `department_required` /
  // `industry_required` for a missing QUERY PARAM on GET /api/ontology; these two are the ENTITY
  // SCOPE invariant, a different sentence. Without the discriminator a catalog can only pick one of
  // the two sentences and will be wrong half the time.
  const noDept = await call('POST', '/api/ontology/entities', {
    scope: 'generic', name: 'ZZScopeless', label: 'Scopeless',
  });
  expect(noDept.status).toBe(400);
  expect(noDept.json.error).toBe('department_required');
  expect(noDept.json.details?.reason).toBe('entity_scope');

  const noInd = await call('POST', '/api/ontology/entities', {
    scope: 'industry', name: 'ZZScopeless', label: 'Scopeless',
  });
  expect(noInd.status).toBe(400);
  expect(noInd.json.error).toBe('industry_required');
  expect(noInd.json.details?.reason).toBe('entity_scope');

  // …and the English sentences stay byte-identical, because a rolling deploy serves a NEW bundle
  // from an OLD pod for the length of the roll and the message is the only fallback it has.
  expect(noDept.json.message).toBe('generic-scope entities need a department');
  expect(noInd.json.message).toBe('industry-scope entities need an industry');

  // `name` — the 409 interpolates the colliding name into its sentence. Same argument as
  // `duplicate_attribute` above: the value has to arrive as a field.
  const first = await call('POST', '/api/ontology/entities', {
    scope: 'industry_dept', industry: 'insurance', department: 'Claims',
    name: 'ZZDupeEntity', label: 'Dupe Entity',
  });
  expect(first.status).toBe(201);
  const again = await call('POST', '/api/ontology/entities', {
    scope: 'industry_dept', industry: 'insurance', department: 'Claims',
    name: 'ZZDupeEntity', label: 'Dupe Entity',
  });
  expect(again.status).toBe(409);
  expect(again.json.error).toBe('entity_exists');
  expect(again.json.details).toEqual({ name: 'ZZDupeEntity' });
  expect(again.json.message).toBe("A custom entity 'ZZDupeEntity' already exists in this cell");
});

test('a member cannot delete a tenant entity (403) and unknown ids 404', async () => {
  asUser(member);
  const denied = await call('DELETE', `/api/ontology/entities/${ORG}`);
  expect(denied.status).toBe(403);
  asUser(admin);
  const missing = await call('DELETE', `/api/ontology/entities/${OTHER}`); // not a tenant-owned entity id
  expect(missing.status).toBe(404);
});
