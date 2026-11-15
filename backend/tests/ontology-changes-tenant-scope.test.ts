// tests/ontology-changes-tenant-scope.test.ts — WS-4: the /ontology "Recent changes" panel must not
// show one workspace another workspace's ontology history.
//
// ⛔ THE DEFECT, MEASURED. `routes/ontology/+page.svelte` called
//
//     auditApi.list({ category: 'data', q: 'ontology', range: '30d' })   →  GET /api/audit
//
// which is the PLATFORM audit feed — the same endpoint /audit renders. It has no tenant predicate
// and cannot have one: `audit_log` carries no `tenant_id` column and sits outside RLS by design
// (migration 0028), because being the one cross-tenant record is its job. The endpoint is
// `requireSuperAdmin`, so an ordinary member simply got a 403 and an empty panel — but a
// super_admin, INCLUDING one scope-switched into a customer's workspace via `X-Active-Tenant-Id`,
// read every other tenant's `ontology.*` rows in a panel captioned "Recent changes", sitting
// directly under a graph that IS tenant-scoped. Reproduced against a live stack: an operator acting
// into tenant A saw tenant B's "Custom entity 'rival_margin_secret'" as the top row.
//
// WHAT THIS FILE PINS, and why each half is here:
//   1. a row belonging to ANOTHER workspace is absent — the leak itself;
//   2. ⛔ THIS workspace's own row is still PRESENT. A "fix" that returned nothing would pass (1)
//      and be a worse product than the leak. Every scoping assertion below is paired with its
//      positive twin for exactly this reason;
//   3. a row that belongs to NO resolvable workspace is not shown AND is counted, so the panel can
//      say out loud that it hid something (this codebase ships "absent collapsed into empty"
//      repeatedly, and a silent filter is that same defect wearing a security fix's clothes);
//   4. the unattributed count does NOT swallow other tenants' rows — which is what happens the
//      moment the attribution join runs on a tenant-scoped connection instead of `runAsSystem`,
//      because both joined ontology tables carry RLS;
//   5. a REAL write through `POST /api/ontology/entities` persists its workspace into
//      `audit_log.metadata`, so the ambiguity in (3) drains to historical rows only and never
//      grows again. Read back out of the column, not grepped out of the source — the grep at the
//      bottom of this file is green with the stamp deleted;
//   6. the reader's own id is compared CASE-INSENSITIVELY. `owner_tenant` is text (it has to be —
//      `metadata->>'tenantId'` is jsonb text), unlike every other tenant comparison in this repo,
//      which is a case-normalising `uuid` one. An uppercase `X-Active-Tenant-Id` is valid per
//      `UUID_RE`'s `/i` and used to blank the reader's own panel;
//   7. `unattributed` is a PLATFORM figure with no tenant predicate and cannot have one — pinned
//      so the eight catalogs that now say so out loud stay true.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerOntologyRoutes } from '../src/routes/ontology';
import { runAsSystem } from '../src/db/client';
import { listTenantOntologyChanges } from '../src/ontology/ontology-changes';
import {
  db,
  users,
  tenants,
  auditLog,
  ontologyEntities,
  ontologyRelations,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import type { User } from '../src/types';

const TENANT_A = '00000000-0000-0000-0000-00000c4a0001'; // the workspace being read
const TENANT_B = '00000000-0000-0000-0000-00000c4a0002'; // the workspace that must stay invisible
const SUPER_ID = '00000000-0000-0000-0000-00000c4aad01';
const ACTOR_B_ID = '00000000-0000-0000-0000-00000c4aad02'; // a user whose HOME is the other workspace
const MARK = 'ztest-ws4';

// A super_admin whose HOME is A. The scope-switch case drives the same user with the header.
const superAdmin: User = {
  id: SUPER_ID,
  email: 'ws4-super@test',
  name: 'Sue Super',
  roles: ['super_admin'],
  tenantId: TENANT_A,
};
const member: User = {
  id: SUPER_ID,
  email: 'ws4-super@test',
  name: 'Sue Super',
  roles: ['member'],
  tenantId: TENANT_A,
};

let currentUser: User = superAdmin;
function asUser(u: User) {
  currentUser = u;
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

const router = new Router();
registerOntologyRoutes(router);

async function call(path: string, headers: Record<string, string> = {}) {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const req = new Request(`http://localhost${path}`, { method: 'GET', headers });
  // Mirrors server.ts's peekEffectiveTenant wrapper: a valid super-admin scope header establishes
  // the acting GUC before the route runs. Running the request under the RUNTIME role (not the
  // RLS-bypassing owner) is what makes assertion (4) below meaningful — see its comment.
  const activeHeader = headers['X-Active-Tenant-Id'];
  const initialTenant =
    currentUser.roles.includes('super_admin') && /^[0-9a-f-]{36}$/i.test(activeHeader ?? '')
      ? activeHeader!
      : currentUser.tenantId!;
  const res = await withTenantDbAsRuntimeRoleForTests(initialTenant, () =>
    matched.handler(req, ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** The same, for a WRITE — the half of this fix that nothing used to drive. See the behavioural
 *  stamp test at the bottom of this file for why a source grep was not enough. */
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const matched = router.match('POST', path);
  if (!matched) throw new Error(`no route for POST ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const activeHeader = headers['X-Active-Tenant-Id'];
  const initialTenant =
    currentUser.roles.includes('super_admin') && /^[0-9a-f-]{36}$/i.test(activeHeader ?? '')
      ? activeHeader!
      : currentUser.tenantId!;
  const res = await withTenantDbAsRuntimeRoleForTests(initialTenant, () =>
    matched.handler(req, ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// Ids fixed so the audit rows can name them without a round-trip.
const ENTITY_A = '00000000-0000-0000-0000-00000c4ae001';
const ENTITY_B = '00000000-0000-0000-0000-00000c4ae002';
const RELATION_A = '00000000-0000-0000-0000-00000c4a4001';
const GONE = '00000000-0000-0000-0000-00000c4a9999'; // a target that no longer exists

/**
 * `unattributed` is a PLATFORM figure — every ontology row in the window that no workspace can
 * claim, whoever wrote it — so asserting an absolute number would make this file hostage to
 * whatever the seed and the other ontology suites left behind. The two counted tests assert the
 * DELTA this file's own fixtures add, which is exact and cannot drift.
 */
let baselineUnattributed = 0;

async function cleanup() {
  await db.delete(auditLog).where(like(auditLog.action, `ontology.${MARK}%`));
  // The behavioural stamp test below drives the REAL `POST /api/ontology/entities`, which writes an
  // un-marked `ontology.entity_create`. Deleting by actor also clears the `audit_log` FK on `users`
  // below — without it this cleanup deletes the user out from under its own audit rows.
  await db.delete(auditLog).where(inArray(auditLog.actor_id, [SUPER_ID, ACTOR_B_ID]));
  await db.delete(ontologyRelations).where(inArray(ontologyRelations.tenant_id, [TENANT_A, TENANT_B]));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.tenant_id, [TENANT_A, TENANT_B]));
  await db.delete(users).where(inArray(users.id, [SUPER_ID, ACTOR_B_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Alpha Org', slug: `alpha-${MARK}` },
    { id: TENANT_B, name: 'Rival Logistics', slug: `rival-${MARK}` },
  ]);
  await db.insert(users).values([
    { id: SUPER_ID, email: superAdmin.email, name: superAdmin.name, tenant_id: TENANT_A },
    { id: ACTOR_B_ID, email: 'ws4-b@test', name: 'Bob Rival', tenant_id: TENANT_B },
  ]);
  await db.insert(ontologyEntities).values([
    { id: ENTITY_A, scope: 'generic', department: 'ops', name: `${MARK}_alpha`, label: 'Alpha Shipment', tenant_id: TENANT_A },
    { id: ENTITY_B, scope: 'generic', department: 'ops', name: `${MARK}_rival`, label: 'Rival Margin Model', tenant_id: TENANT_B },
  ]);
  await db.insert(ontologyRelations).values([
    { id: RELATION_A, from_entity: ENTITY_A, to_entity: ENTITY_A, predicate: `${MARK}_rel`, tenant_id: TENANT_A },
  ]);
  baselineUnattributed = (await runAsSystem('platform-admin', () => listTenantOntologyChanges(TENANT_A))).unattributed;
  await db.insert(auditLog).values([
    // A's own edit, resolvable through the TARGET ROW (this is pre-metadata history).
    { actor_id: SUPER_ID, action: `ontology.${MARK}_entity_create`, category: 'data', target_type: 'ontology_entity', target_id: ENTITY_A, result: "Custom entity 'alpha_shipment'" },
    // A's own relation edit, same route, different table.
    { actor_id: SUPER_ID, action: `ontology.${MARK}_relation_create`, category: 'data', target_type: 'ontology_relation', target_id: RELATION_A, result: "Custom relation 'ships_via'" },
    // A's own edit, resolvable through METADATA — the forward-looking path, and the one that
    // survives the target row being deleted.
    { actor_id: SUPER_ID, action: `ontology.${MARK}_entity_delete`, category: 'data', target_type: 'ontology_entity', target_id: GONE, result: 'Deleted custom entity', metadata: { tenantId: TENANT_A } },
    // ⛔ THE LEAKED ROW. Another workspace's ontology edit, with a result string a reader would
    // remember seeing.
    { actor_id: SUPER_ID, action: `ontology.${MARK}_entity_create`, category: 'data', target_type: 'ontology_entity', target_id: ENTITY_B, result: "Custom entity 'rival_margin_secret'" },
    // Attributable to NOBODY: a delete from before audit rows carried their tenant. Might be A's,
    // might be B's — must not render as A's, must not vanish without a word.
    { actor_id: SUPER_ID, action: `ontology.${MARK}_entity_delete`, category: 'data', target_type: 'ontology_entity', target_id: GONE, result: 'Deleted custom entity (unknowable era)' },
    // ⛔ A'S OWN EDIT, STAMPED IN A DIFFERENT CASE. `readActiveTenantHeader`'s `UUID_RE` carries
    // `/i`, so an uppercase `X-Active-Tenant-Id` was accepted and stamped into `metadata.tenantId`
    // VERBATIM by every release before the canonicalisation below. Historical data this code does
    // not own, and `coalesce` puts metadata FIRST — so before the `lower()` guard this row resolved
    // NON-NULL and NON-MATCHING, i.e. "belongs to another workspace": absent from the panel AND
    // excluded from `unattributed` (which keys on `owner_tenant IS NULL`). A row about A's own
    // entity that A could neither see nor be told about.
    { actor_id: SUPER_ID, action: `ontology.${MARK}_entity_update`, category: 'data', target_type: 'ontology_entity', target_id: ENTITY_A, result: "Edited 'alpha_shipment' (upper-cased stamp)", metadata: { tenantId: TENANT_A.toUpperCase() } },
    // ⛔ A ROW NO HUMAN WROTE — `actor_id IS NULL`, which is what every sweeper, cron and webhook
    // that touches the ontology leaves behind. It belongs to A (metadata stamp), so it DOES render
    // in A's panel; the question this fixture asks is what the `actor` field says about it.
    { actor_id: null, action: `ontology.${MARK}_entity_hide`, category: 'data', target_type: 'ontology_entity', target_id: ENTITY_A, result: 'Hidden by the nightly sweeper', metadata: { tenantId: TENANT_A } },
  ]);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

const results = (json: { items: { result: string | null }[] }) => json.items.map((i) => i.result);

test('⛔ a super_admin reading /ontology sees THEIR workspace’s ontology history — and not another’s', async () => {
  // REVERT THAT TURNS THIS RED: point the panel back at `GET /api/audit`. Every row below comes
  // back, `rival_margin_secret` included — which is exactly the screen the operator saw.
  asUser(superAdmin);
  const res = await call('/api/ontology/recent-changes');
  expect(res.status).toBe(200);

  // POSITIVE HALF FIRST, deliberately: a route that returned `{ items: [] }` would satisfy every
  // negative assertion in this file and be a worse product than the leak it replaced.
  expect(results(res.json), 'this workspace’s own ontology history stopped rendering').toContain(
    "Custom entity 'alpha_shipment'",
  );
  expect(results(res.json), 'the relation-table half of the attribution join is dead').toContain(
    "Custom relation 'ships_via'",
  );
  expect(results(res.json), 'metadata attribution is dead — deletes can be attributed no other way').toContain(
    'Deleted custom entity',
  );

  // THE LEAK.
  expect(results(res.json), 'another workspace’s ontology edit rendered as this one’s').not.toContain(
    "Custom entity 'rival_margin_secret'",
  );
  // …and nothing unattributable was passed off as this workspace's either.
  expect(results(res.json)).not.toContain('Deleted custom entity (unknowable era)');
});

test('⛔ the same super_admin SCOPE-SWITCHED into the other workspace sees ITS history, and not the first’s', async () => {
  // The mirror image, and the case the operator console actually hits. It is also the one that
  // catches an "attribute by the reader's claim" shortcut: the claim still says A here.
  asUser(superAdmin);
  const res = await call('/api/ontology/recent-changes', { 'X-Active-Tenant-Id': TENANT_B });
  expect(res.status).toBe(200);
  expect(results(res.json), 'the scope-switch was ignored — B’s own history is missing').toContain(
    "Custom entity 'rival_margin_secret'",
  );
  expect(results(res.json), 'A’s history leaked into B’s workspace').not.toContain(
    "Custom entity 'alpha_shipment'",
  );
});

test('⛔ rows that belong to NO workspace are counted, not silently dropped', async () => {
  // The honesty half. One unattributable row was seeded; A's OWN delete carries `metadata.tenantId`
  // and must NOT be counted here, which is what stops "count everything I could not join" from
  // passing this test.
  asUser(superAdmin);
  const res = await call('/api/ontology/recent-changes');
  expect(
    res.json.unattributed - baselineUnattributed,
    'the hidden row was dropped in silence',
  ).toBe(1);
});

test('⛔ the count does NOT swallow the other workspace’s rows — the join must see every tenant', async () => {
  // ⛔ THE RLS TRAP THIS PINS. `ontology_entities` and `ontology_relations` BOTH carry RLS
  // (relrowsecurity = t). Drop the `runAsSystem` wrapper in the route and the request runs on a
  // connection scoped to A: B's entity row is INVISIBLE, the join yields NULL, and B's create —
  // a row that is definitively someone else's — is counted as "might be yours" and disclosed to A.
  // The rows stay correctly hidden either way, so ONLY this number moves; without this assertion
  // the regression is invisible. The call above runs under the RUNTIME role for exactly this
  // reason: on the RLS-bypassing owner the trap cannot spring and the test would prove nothing.
  asUser(superAdmin);
  const res = await call('/api/ontology/recent-changes');
  expect(
    res.json.unattributed - baselineUnattributed,
    'B’s create was counted as unattributable — the attribution join is not seeing every tenant',
  ).toBeLessThan(2);
});

test('⛔ an UPPERCASE X-Active-Tenant-Id still shows the reader their own workspace', async () => {
  // ⛔ THE DEFECT, MEASURED THROUGH THE REAL ROUTE. `readActiveTenantHeader`'s `UUID_RE` has the
  // `/i` flag and DELIBERATELY accepts uppercase hex (RFC 9562: a UUID is case-insensitive on
  // input), and the value travelled verbatim into a TEXT comparison —
  // `coalesce(al.metadata->>'tenantId', e.tenant_id::text, …) = $1`. Every other tenant comparison
  // in this codebase is a `uuid` one and normalises for free; this one did not. Before the fix:
  //
  //   lower: 200 ["Custom entity 'alpha_shipment'", …]
  //   UPPER: 200 {"items":[],"unattributed":0}      ← accepted, graph renders, panel BLANK,
  //                                                   and the disclosure says nothing was hidden
  //
  // That is this repo's signature failure — the reader's own rows disappearing in silence — reached
  // through a header the guard says is valid.
  //
  // ⚠️ AND THIS ONE TEST IS DELIBERATELY NOT THE WHOLE PROOF, BECAUSE THE FIX IS TWO LAYERS.
  // `canonicalTenantId` at the header and `lower(owner_tenant) = lower($1)` in the query each close
  // this path ALONE, which is the point of defence in depth and also means reverting either one
  // alone leaves this assertion green. Measured, exactly: query-guard reverted → 9 pass / 1 fail
  // (the stray-case test below, not this one); header-canonicalisation reverted → 10 pass / 0 fail
  // HERE and 2 fail in `tests/admin-guards.test.ts`, which is where that layer is pinned; BOTH
  // reverted → this test and the next one red together. So: this file owns the query guard and the
  // end-to-end behaviour, `admin-guards.test.ts` owns the source guard, and nothing is left standing
  // on one assertion.
  asUser(superAdmin);
  const upper = await call('/api/ontology/recent-changes', {
    'X-Active-Tenant-Id': TENANT_A.toUpperCase(),
  });
  expect(upper.status).toBe(200);
  // POSITIVE HALF. An empty panel satisfies "no other workspace leaked" and is the whole defect.
  expect(
    results(upper.json),
    'an uppercase scope header blanked the reader’s own history',
  ).toContain("Custom entity 'alpha_shipment'");
  expect(results(upper.json)).toContain("Custom relation 'ships_via'");
  // …and it is genuinely A's panel, not "everything".
  expect(
    results(upper.json),
    'the uppercase header widened the scope instead of normalising it',
  ).not.toContain("Custom entity 'rival_margin_secret'");
  // The lowercase request must answer the SAME thing — the two spellings are one workspace.
  const lower = await call('/api/ontology/recent-changes', { 'X-Active-Tenant-Id': TENANT_A });
  expect(
    new Set(results(upper.json)),
    'the same workspace answered differently in two spellings of its own id',
  ).toEqual(new Set(results(lower.json)));
});

test('⛔ a row NO HUMAN wrote ships `actor: null` — the server never invents the word "System"', async () => {
  // ⛔ THE DEFECT. This mapper answered "who did this?" for an `actor_id IS NULL` row with the
  // literal object `{ name: 'System', initials: 'SYS' }`. /ontology's "Recente wijzigingen" panel
  // is otherwise fully localized — `ontologyActionLabel` for the action, `timeAgo` for the stamp —
  // so a Dutch reader got "System · Aangepaste entiteit aangemaakt · 2u geleden": one English word,
  // minted on a server that cannot know who is reading, in the slot the eye scans for a NAME.
  //
  // The absence of a human actor is the FACT and it is what belongs on the wire; the word for it is
  // `m.audit_actor_system()` in the browser
  // (frontend/src/routes/ontology/ontology-page.system-actor.render.test.ts drives that half).
  asUser(superAdmin);
  const r = await call('/api/ontology/recent-changes', { 'X-Active-Tenant-Id': TENANT_A });
  expect(r.status).toBe(200);
  const sweeper = r.json.items.find((i: { result: string | null }) => i.result === 'Hidden by the nightly sweeper');
  expect(sweeper, 'the unattributed row is not in the feed at all, so this case tests nothing').toBeTruthy();
  expect(sweeper.actor).toBeNull();
  // ⛔ AND THE WORD IS GONE FROM THE ROW, not merely moved to a sibling field: a "fix" shipping
  // `{ name: 'System', system: true }` would pass a nested-field null check and still put the
  // untranslatable noun on the wire.
  expect(JSON.stringify(sweeper)).not.toContain('System');
  // ⛔ NON-VACUITY — a mapper that dropped `actor` for EVERY row would satisfy both lines above.
  const human = r.json.items.find((i: { result: string | null }) => i.result === "Custom entity 'alpha_shipment'");
  expect(human.actor.name).toBe(superAdmin.name);
});

test('⛔ a row about the reader’s OWN entity, stamped in a stray case, renders — never “absent and uncounted”', async () => {
  // The WRITER-side half, and the worse one. `coalesce` puts `metadata->>'tenantId'` FIRST, so a
  // non-canonical stamp resolves NON-NULL and NON-MATCHING — classified "belongs to another
  // workspace", which means absent AND excluded from `unattributed`, because the entire disclosure
  // keys on `owner_tenant IS NULL`. Measured before the fix, on a row about A's OWN entity:
  //
  //   items 0 -> 0    unattributed 47 -> 47      ← not rendered, and not counted either
  //
  // The disclosure structurally cannot see this class, which is why the fix has to be the
  // comparison and not a wider `unattributed`.
  //
  // REVERT THAT TURNS THIS RED: `lower(owner_tenant) = lower(${'$1'})` → `owner_tenant = ${'$1'}`.
  asUser(superAdmin);
  const res = await call('/api/ontology/recent-changes');
  expect(
    results(res.json),
    'a row about this workspace’s own entity was neither shown nor counted',
  ).toContain("Edited 'alpha_shipment' (upper-cased stamp)");
  // ⛔ AND IT IS ATTRIBUTED, NOT MERELY DISCLOSED. If the fix had been "widen unattributed" the
  // assertion above would fail and this delta would be 2 — the row would be counted as nobody's
  // rather than shown as the reader's. Pinned so that weaker fix cannot pass this file.
  expect(
    res.json.unattributed - baselineUnattributed,
    'the stray-case row was swept into the unattributed count instead of being attributed',
  ).toBe(1);
});

test('⛔ a real POST /api/ontology/entities PERSISTS its workspace in audit_log.metadata', async () => {
  // ⛔ WHY THIS EXISTS AND WHY THE SOURCE GREP BELOW IS NOT ENOUGH. The whole forward half of this
  // change is "every ontology write stamps `metadata.tenantId`", and until this test nothing drove
  // it: the attribution tests above hand-seed `metadata: { tenantId: TENANT_A }` straight into
  // `audit_log`, and the only guard on the writer was a `readFileSync` + `/await recordAudit\(/`
  // over routes/ontology.ts. Measured: deleting the stamp itself —
  //
  //   perl -0pi -e "s/metadata: \{ \.\.\.entry\.metadata, tenantId: ctx\.tenantId \}/metadata: { ...entry.metadata }/" src/routes/ontology.ts
  //   bun test tests/ontology-changes-tenant-scope.test.ts   ->   6 pass  0 fail
  //
  // left the suite fully green. The grep is also defeated by a reformat (`await recordAudit(\n {`)
  // and by any `ontology.*` writer added in another file. This is the shape of the memory
  // `a-skipped-test-passes-a-name-grep-gate`: the guard reads a NAME, never a behaviour.
  //
  // So: drive the real route, then read the real column back out of Postgres.
  asUser(superAdmin);
  const created = await post('/api/ontology/entities', {
    scope: 'generic',
    department: 'ops',
    name: `${MARK}_stamped`,
    label: 'Stamped Entity',
  });
  expect(created.status, 'the write itself failed — nothing below is a proof').toBe(201);
  const newId = created.json.id as string;

  const [row] = (await db.execute(sql`
    select metadata->>'tenantId' as tenant_id, action
      from audit_log
     where target_id = ${newId} and action = 'ontology.entity_create'
     limit 1
  `)) as unknown as { tenant_id: string | null; action: string }[];
  expect(row, 'the route wrote no audit row at all for a successful create').toBeDefined();
  expect(
    row!.tenant_id,
    'a real ontology write persisted NO tenantId — every such row is unattributable forever',
  ).toBe(TENANT_A);

  // ⛔ AND THE END-TO-END HALF: the row this write just produced reaches THIS reader's panel
  // through metadata alone. `target_id` does point at a live `ontology_entities` row here, so the
  // join could also attribute it — the assertion above is what pins the metadata path itself.
  const res = await call('/api/ontology/recent-changes');
  expect(
    results(res.json),
    'the workspace’s own brand-new entity did not reach its own Recent changes panel',
  ).toContain(`Custom entity '${MARK}_stamped'`);
});

test('⛔ `unattributed` is a PLATFORM figure — which is why the copy has to say so', async () => {
  // ⛔ THE FALSE CLAIM THIS REPLACES. `ontology-changes.ts`'s header and
  // `frontend/src/routes/ontology/+page.svelte` both used to assert the screen states the count is
  // an upper bound "as such". It did not — all 8 catalogs said only "{n} changes in this period
  // could not be linked to a workspace and are not shown", with no hedge, under a caption about the
  // reader's OWN workspace.
  //
  // And the number really is cross-tenant: `ontology-changes.ts` has NO tenant predicate on the
  // count, and cannot have one — the defining property of these rows is that no workspace can be
  // derived for them, so there is nothing to filter on. Measured here rather than argued: five
  // unattributable rows written by a user whose home is the OTHER workspace raise THIS reader's
  // number by exactly five.
  //
  // This is the assertion that keeps the comment and the copy honest. If someone ever does give the
  // count a tenant predicate, this test reds and the catalogs must be rewritten in the same commit.
  asUser(superAdmin);
  const before = (await call('/api/ontology/recent-changes')).json.unattributed as number;
  await db.insert(auditLog).values(
    Array.from({ length: 5 }, (_, i) => ({
      actor_id: ACTOR_B_ID,
      action: `ontology.${MARK}_sample_unbind`,
      category: 'data',
      target_type: 'ontology_entity_sample',
      target_id: `${GONE}-${i}`,
      result: 'Unbound test data (row already gone)',
    })),
  );
  const after = (await call('/api/ontology/recent-changes')).json.unattributed as number;
  expect(
    after - before,
    'the count stopped being platform-wide — rewrite the 8 catalogs, they claim it is',
  ).toBe(5);
  // POSITIVE HALF: those five rows are still NOT rendered as this reader's.
  const res = await call('/api/ontology/recent-changes');
  expect(results(res.json)).not.toContain('Unbound test data (row already gone)');
  await db.delete(auditLog).where(eq(auditLog.actor_id, ACTOR_B_ID));
});

test('an ordinary member still gets a 403 — the panel’s silence for most readers is unchanged', async () => {
  // ⛔ NOT AN OVERSIGHT, AND NOT A CANDIDATE FOR "IMPROVEMENT". The rows come from `audit_log`, the
  // one table outside RLS; reading it is a platform capability and scoping the ANSWER to a
  // workspace is no reason to widen it. `routes/ontology/+page.svelte` treats 401/403 as the
  // EXPECTED answer and stays quiet — see ontology-page.recent-changes-failure.render.test.ts.
  asUser(member);
  const res = await call('/api/ontology/recent-changes');
  expect(res.status).toBe(403);
  asUser(superAdmin);
});

test('every `ontology.*` audit call site is ROUTED through the stamping helper (cheap extra)', () => {
  // ⚠️ A CHEAP EXTRA, AND NO LONGER THE THING STANDING BETWEEN THE STAMP AND ITS ABSENCE.
  // This used to be the ONLY guard on the writer half, and it is a `readFileSync` + regex: it
  // survives deleting `tenantId: ctx.tenantId` from the helper itself (measured — 6 pass, 0 fail),
  // it is defeated by a reformat (`await recordAudit(\n  {`), and it cannot see an `ontology.*`
  // writer added in another file. The behaviour is now driven end-to-end against Postgres by
  // "a real POST /api/ontology/entities PERSISTS its workspace" above; this is kept because it
  // still catches the ELEVENTH call site cheaply — a new route in THIS file that reaches past the
  // helper writes a row no workspace can ever claim, and the only symptom is a number on a panel
  // slowly going up.
  const src = readFileSync(resolve(import.meta.dir, '../src/routes/ontology.ts'), 'utf8');
  const stray = src
    .split('\n')
    .filter((l) => /await recordAudit\(/.test(l))
    .map((l) => l.trim());
  expect(
    stray,
    'an ontology route calls recordAudit directly — use recordOntologyAudit so the row names its workspace',
  ).toEqual([]);
  // Non-vacuity: the file really does audit, and really does audit through the helper.
  expect(src.match(/await recordOntologyAudit\(ctx, \{/g)?.length ?? 0).toBeGreaterThanOrEqual(11);
});
