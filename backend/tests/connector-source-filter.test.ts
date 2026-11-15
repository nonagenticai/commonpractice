// tests/connector-source-filter.test.ts — `GET /api/connectors?source=` (the server half of the
// /connectors search fix).
//
// ⛔ THE DEFECT THIS PARAMETER EXISTS FOR. The /connectors table renders its source column through
// `sourceLabel()` — `m.connectors_source_storage()` is "Opslagdienst" in the demo locale — while
// this route's `q` predicate matches `name`, `slug`, `source_type::text` and
// `connection_meta->>'host'`: the raw enum `storage`, never the label. A Dutch tester typed the
// badge word off their own screen and was told there was no match, with rows carrying that badge in
// front of them. The route's own comment concluded that fixing it "means giving the enum labels a
// DB-side representation, which is a schema change" — which is wrong, and is retracted in the same
// commit: the enum has three members and the browser already owns all eight translations of each,
// so the page resolves the word and sends the ENUM. This file is the endpoint that receives it.
//
// ⛔ THE FOUR THINGS ASSERTED, AND WHY EACH IS NOT THE OTHERS:
//   1. `?source=storage` returns the storage connector and EXCLUDES the postgres one. The exclusion
//      is the half that fails if `source` were ignored — a dropped param answers a filtered request
//      with an unfiltered list, and an "it contains the row I wanted" assertion passes on that.
//   2. `total` tracks the filter. The count query and the row query build from the same `where`; if
//      they ever diverge the pager lies about a result set the reader can see.
//   3. `?source=` composes with `q` as an AND, not as a widening of it.
//   4. An unknown `source` is a 400 `invalid_source`, not a silently unfiltered 200. That is the
//      whole reason the parameter is validated rather than best-effort.
//
// ⚠️ FIXTURES ARE THIS FILE'S OWN, in this file's own tenant, and are deleted in `afterAll`. The
// shared harness DB is re-seeded by other lanes; a case phrased against a seeded connector would go
// red for reasons that have nothing to do with this route. Rows are INSERTed directly rather than
// created through `POST /api/connectors`, because that path performs a live refresh through the
// egress guard and the behaviour under test is the WHERE clause. (The create path is covered by
// connectors-routes.test.ts.)
//
// ⚠️ FIXTURE WRITES GO THROUGH `runAsSystem`, WHICH IS NOT A CONVENIENCE. `datasets` carries an RLS
// policy scoped to `app_current_tenant_uuid()`; the plain `db` handle runs as the RUNTIME role, and
// under a `cp_app`-shaped DSN (`rolbypassrls = false` — production's shape) a bare
// `db.insert(datasets)` fails with "new row violates row-level security policy". `runAsSystem`
// binds the OWNER pool, which is how the seeders plant global/tenant rows. The READS below stay on
// the ordinary request path, because the WHERE clause is what is under test.
//
// ⚠️ AND THE READS THEREFORE STILL NEED AN RLS-BYPASSING DSN, exactly like every sibling in this
// directory. This in-process router harness calls the handler directly, so nothing sets the
// `app.current_tenant` GUC the way the server pipeline (`withTenantDb`) does; CI runs the backend
// suite as `postgres` (.github/workflows/ci-cd.yaml) and that is what makes these reads visible.
// Pointed at a `cp_app`-shaped DSN this file returns zero rows — and so does the pre-existing
// tests/connector-tenant-scope.test.ts, measured. That is a property of the harness, not of the
// route: it is the reason the fixture WRITES were moved to runAsSystem rather than an argument
// that the reads should be too.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerConnectorRoutes } from '../src/routes/connectors';
import { db, runAsSystem, users, tenants, datasets, datasetRows } from '../src/db/client';
import { CONNECTOR_SOURCE_TYPES, type ConnectorMeta } from '../src/db/dataset-types';
import type { User } from '../src/types';

const ORG = '00000000-0000-0000-0000-00000e5f0001';
const ADMIN_ID = '00000000-0000-0000-0000-00000e5fad01';
const admin: User = {
  id: ADMIN_ID,
  email: 'srcfilter-admin@test',
  name: 'Ada Admin',
  roles: ['employee', 'tenant_admin'],
  tenantId: ORG,
};

/**
 * ⛔ NEITHER NAME CONTAINS THE OTHER'S BADGE WORD, IN ANY LOCALE, AND THAT IS THE FIXTURE'S WHOLE
 * DESIGN. If the storage connector were called "Storage archive", `?source=storage` would return it
 * through the plain `q`/name path too and the case would pass with the new predicate deleted.
 * "Schade-archief 2024" and "Polisregister" share no substring with `storage`, `postgres`, `http`
 * or any `connectors_source_*` label, so the ONLY thing that can select one and exclude the other
 * is the `source` filter.
 */
const STORAGE_SLUG = 'schade-archief-2024';
const PG_SLUG = 'polisregister';
const HTTP_SLUG = 'koersen-feed';
/**
 * ⛔ AND ONE FIXTURE THAT IS DELIBERATELY THE OPPOSITE: an `http` connector whose NAME is another
 * kind's source label. `connectors_source_postgres` is **"Postgres" in all eight catalogs** — the
 * localized label and the enum value are the same word — so the page's first version, which sent
 * `?source=` INSTEAD of `?q=` for any input that resolved to a label, turned a name search into a
 * whole-category filter and made this row unfindable by the word printed in its own name column.
 * `?qSource=` exists to union the two readings instead of substituting one for the other.
 */
const BRIDGE_SLUG = 'postgres-bridge';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

const router = new Router();
registerConnectorRoutes(router);

async function call(method: string, path: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, { method });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function slugs(json: { items: { slug: string }[] }): string[] {
  return json.items.map((c) => c.slug).sort();
}

async function cleanup() {
  await runAsSystem('boot-seed', async () => {
    const ds = await db
      .select({ id: datasets.id })
      .from(datasets)
      .where(eq(datasets.tenant_id, ORG));
    for (const d of ds) await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
    await db.delete(datasets).where(eq(datasets.tenant_id, ORG));
    await db.delete(users).where(inArray(users.id, [ADMIN_ID]));
    await db.delete(tenants).where(eq(tenants.id, ORG));
  });
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks, so a slow one fails as
// "(unnamed) [5003ms]" with no file/cause. See license-provisioning.test.ts.
beforeAll(async () => {
  await cleanup();
  await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values({ id: ORG, name: 'Source Filter Org', slug: 'srcfilter-org' });
    await db
      .insert(users)
      .values({ id: ADMIN_ID, email: admin.email, name: admin.name, tenant_id: ORG });
    // ⚠️ ONE INSERT PER ROW, NOT ONE ARRAY. `connection_meta` is the `ConnectorMeta` DISCRIMINATED
    // UNION, so an array literal of three differently-shaped rows infers as an array-of-union and
    // drizzle's `.values()` overloads reject it — `bun test` runs fine and `bunx tsc --noEmit`
    // does not, which is the failure that reaches CI rather than this terminal.
    for (const [name, slug, source, host] of [
      ['Schade-archief 2024', STORAGE_SLUG, 'storage', 'minio.example.com'],
      ['Polisregister', PG_SLUG, 'postgres', 'pg.example.com'],
      ['Koersen feed', HTTP_SLUG, 'http', 'rates.example.test'],
      ['Postgres bridge', BRIDGE_SLUG, 'http', 'bridge.example.test'],
    ] as const) {
      await db.insert(datasets).values({
        owner_id: ADMIN_ID,
        tenant_id: ORG,
        name,
        slug,
        source_type: source,
        connection_meta: { kind: source, host } as ConnectorMeta,
        columns: [{ name: 'a', type: 'number' }],
        row_count: 1,
        size_bytes: 16,
        status: 'ready',
        event_source: 'none',
      });
    }
  });
  asUser(admin);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('the fixture is three connectors of three different kinds — otherwise every case below is vacuous', async () => {
  const all = await call('GET', '/api/connectors');
  expect(all.status).toBe(200);
  expect(slugs(all.json)).toEqual([HTTP_SLUG, PG_SLUG, STORAGE_SLUG, BRIDGE_SLUG].sort());
  expect(all.json.total).toBe(4);
  // …and the regression fixture really is an `http` row whose NAME is the postgres LABEL, which is
  // the only thing that makes the `qSource` cases below discriminating.
  const bridge = (await call('GET', `/api/connectors?q=${encodeURIComponent('Postgres bridge')}`)).json;
  expect(slugs(bridge)).toEqual([BRIDGE_SLUG]);
  expect(bridge.items[0].sourceType).toBe('http');
  // …and the enum really has exactly the three members the page's label map covers.
  expect([...CONNECTOR_SOURCE_TYPES]).toEqual(['postgres', 'storage', 'http']);
});

test('⛔ ?source=storage returns the storage connector AND excludes the others', async () => {
  const res = await call('GET', '/api/connectors?source=storage');
  expect(res.status).toBe(200);
  // The EXCLUSION is the half a dropped parameter fails. `toEqual` on the whole set asserts both
  // directions at once — "contains STORAGE_SLUG" would pass on an unfiltered list.
  expect(slugs(res.json)).toEqual([STORAGE_SLUG]);
  // `total` is built from the same `where` as the rows. If it ever is not, the pager offers pages
  // of a result set the reader cannot reach.
  expect(res.json.total).toBe(1);
});

test('each of the three enum members filters to its own row', async () => {
  for (const [source, expected] of [
    ['postgres', [PG_SLUG]],
    ['storage', [STORAGE_SLUG]],
    ['http', [HTTP_SLUG, BRIDGE_SLUG]],
  ] as const) {
    const res = await call('GET', `/api/connectors?source=${source}`);
    expect(slugs(res.json), `?source=${source}`).toEqual([...expected].sort());
  }
});

test('?source= composes with ?q= as an AND, not as a widening of it', async () => {
  // `Polis` matches the postgres row's NAME. Combined with `source=storage` the answer must be
  // empty — if `source` were OR'd into the `q` predicate this would return the storage row.
  const conflicting = await call('GET', '/api/connectors?source=storage&q=Polis');
  expect(conflicting.status).toBe(200);
  expect(slugs(conflicting.json)).toEqual([]);
  expect(conflicting.json.total).toBe(0);

  // NON-VACUITY: the same `q` alone does find that row, so the empty answer above is the AND and
  // not a broken `q`.
  const qOnly = await call('GET', '/api/connectors?q=Polis');
  expect(slugs(qOnly.json)).toEqual([PG_SLUG]);

  // …and an agreeing pair narrows rather than widens.
  const agreeing = await call('GET', '/api/connectors?source=storage&q=Schade');
  expect(slugs(agreeing.json)).toEqual([STORAGE_SLUG]);
});

test('⛔ an unknown source is a 400, not a silently unfiltered 200', async () => {
  // A dropped-and-ignored param answers a FILTERED request with an UNFILTERED list — the reader is
  // shown more than they asked for and told nothing. `csv` is a real `dataset_source_type` member
  // and is deliberately NOT a connector kind, so it is the value most likely to be sent by mistake.
  for (const bad of ['csv', 'STORAGE', 'storage; drop', 'nonsense']) {
    const res = await call('GET', `/api/connectors?source=${encodeURIComponent(bad)}`);
    expect(res.status, `?source=${bad}`).toBe(400);
    expect(res.json.error, `?source=${bad}`).toBe('invalid_source');
  }
});

test('an absent or empty source is not a filter at all', async () => {
  // The page omits the parameter entirely for an ordinary text query; an empty string must behave
  // the same rather than filtering on '' and returning nothing.
  expect(slugs((await call('GET', '/api/connectors?source=')).json).length).toBe(4);
  expect(slugs((await call('GET', '/api/connectors?q=&source=')).json).length).toBe(4);
  // `qSource` is the same: absent and empty both mean "no second reading", not "match nothing".
  expect(slugs((await call('GET', '/api/connectors?qSource=')).json).length).toBe(4);
  expect(slugs((await call('GET', '/api/connectors?q=&qSource=')).json).length).toBe(4);
});

// ---------------------------------------------------------------------------
// `?qSource=` — the SECOND source parameter, and the one the page actually sends.
//
// ⛔ IT EXISTS BECAUSE `?source=` ALONE SWALLOWED A LEGITIMATE NAME SEARCH. The /connectors box
// resolves the typed word against its own label catalog; for "Opslagdienst" that is the only way to
// reach the storage rows, so the first fix sent `?source=storage` INSTEAD of `?q=`. But
// `connectors_source_postgres` is **"Postgres" in all eight catalogs** — the enum value spelled
// exactly as its own label — so typing it stopped being a text search and an `http` connector named
// "Postgres bridge" became unfindable by the word in its own name row. It was findable before.
// Replacing a text search with a category filter can only ever LOSE rows.
//
// So the two readings are UNIONED: `qSource` is an extra ARM of the `q` predicate, never an extra
// AND. `source` keeps its narrowing AND — they are different questions, so they are different
// parameters, and the case above ('?source= composes with ?q= as an AND') is what pins that the
// widening did not leak into the narrowing one.
// ---------------------------------------------------------------------------

test('⛔ ?q=Postgres&qSource=postgres finds the http row NAMED "Postgres bridge" as well as the postgres one', async () => {
  const res = await call('GET', '/api/connectors?q=Postgres&qSource=postgres');
  expect(res.status).toBe(200);
  // ⛔ THE REGRESSION HALF FIRST: the row whose NAME is the typed word.
  //
  // ⚠️ AND THIS ROUTE IS NOT WHERE THE REGRESSION LIVED, WHICH IS WORTH STATING SO THIS CASE IS NOT
  // MISTAKEN FOR THE PROOF. `q` here already matches `source_type::text`, so `?q=Postgres` ALONE
  // returns both rows and this case passes against the pre-`qSource` route. The regression was in
  // what the PAGE sent — `{ source: 'postgres' }` INSTEAD of `q` — and it is pinned RED in
  // frontend/src/routes/connectors/connectors-page.source-label-search.render.test.ts. What THIS
  // file proves is the contract the page now depends on: `qSource` is honoured, and it is an OR.
  expect(slugs(res.json), 'the connector named "Postgres bridge" is missing').toContain(BRIDGE_SLUG);
  // …and the LABEL half is not lost either — dropping `qSource` would pass the line above and fail
  // the original defect, so both readings are asserted on the SAME query.
  expect(slugs(res.json)).toEqual([PG_SLUG, BRIDGE_SLUG].sort());
  // `total` is built from the same `where` as the rows; a pager that disagrees offers pages of a
  // result set the reader cannot reach.
  expect(res.json.total).toBe(2);
});

test('⛔ and the ORIGINAL defect stays fixed — the Dutch label still selects exactly the storage row', async () => {
  // ⚠️ THE CHEAPEST REPAIR FOR THE REGRESSION ABOVE IS TO STOP SENDING THE ENUM AT ALL, which
  // reinstates the bug this parameter was written for: no column holds "Opslagdienst". This case is
  // the guard on that — the badge word a Dutch reader copies off their own screen selects the
  // storage row and EXCLUDES the other three, which a plain `?q=` cannot do.
  const res = await call('GET', '/api/connectors?q=Opslagdienst&qSource=storage');
  expect(res.status).toBe(200);
  expect(slugs(res.json), 'the badge word found nothing — the original defect is back').toEqual([
    STORAGE_SLUG,
  ]);
  expect(res.json.total).toBe(1);

  // NON-VACUITY: the same `q` ALONE finds nothing, so the storage row above arrived through the
  // `qSource` arm and not through some accidental text match.
  const qOnly = await call('GET', '/api/connectors?q=Opslagdienst');
  expect(slugs(qOnly.json)).toEqual([]);
});

test('⛔ qSource WIDENS where source NARROWS — the same pair of values, the opposite answer', async () => {
  // The one case that tells the two parameters apart, on identical inputs. `Polis` matches the
  // postgres row's name; `storage` is a different kind.
  //   · as an AND  → nothing can be both, so the answer is empty (pinned above, repeated here so
  //     the contrast is inside one case);
  //   · as an OR   → the postgres row (text) plus the storage row (kind).
  const narrowed = await call('GET', '/api/connectors?q=Polis&source=storage');
  expect(slugs(narrowed.json), '`source` stopped being an AND').toEqual([]);

  const widened = await call('GET', '/api/connectors?q=Polis&qSource=storage');
  expect(slugs(widened.json), '`qSource` is not being OR-ed into the q predicate').toEqual(
    [PG_SLUG, STORAGE_SLUG].sort(),
  );
  expect(widened.json.total).toBe(2);
});

test('qSource alone, with no q, is simply that kind — an OR of one arm', async () => {
  // The page always sends both, but a one-armed OR must not degrade into "no filter at all"
  // (an unfiltered list answering a filtered request) or into `or()` of nothing (a SQL error).
  const res = await call('GET', '/api/connectors?qSource=storage');
  expect(res.status).toBe(200);
  expect(slugs(res.json)).toEqual([STORAGE_SLUG]);
  expect(res.json.total).toBe(1);
});

test('⛔ an unknown qSource is a 400, not a silently unfiltered 200', async () => {
  // Same reasoning as `?source=`: a dropped-and-ignored param answers a FILTERED request with an
  // UNFILTERED list. `csv` is a real `dataset_source_type` member deliberately not a connector kind.
  for (const bad of ['csv', 'STORAGE', 'nonsense']) {
    const res = await call('GET', `/api/connectors?qSource=${encodeURIComponent(bad)}`);
    expect(res.status, `?qSource=${bad}`).toBe(400);
    expect(res.json.error, `?qSource=${bad}`).toBe('invalid_source');
    // The message names WHICH parameter was wrong — `source` and `qSource` mean opposite things,
    // so "source must be one of …" in answer to a bad `qSource` sends the caller to the wrong one.
    expect(res.json.message, `?qSource=${bad}`).toContain('qSource');
  }
});

test('the two parameters compose: qSource widens INSIDE the narrowing that source applies', async () => {
  // `source=http` restricts to the two http rows; `q=Polis` alone matches neither, but
  // `qSource=http` widens the text predicate to "…or is http". The AND still holds — the postgres
  // row is excluded by `source`, which is the half that fails if `source` were folded into the OR.
  const res = await call('GET', '/api/connectors?source=http&q=Polis&qSource=http');
  expect(slugs(res.json)).toEqual([HTTP_SLUG, BRIDGE_SLUG].sort());
  expect(slugs(res.json)).not.toContain(PG_SLUG);
});
