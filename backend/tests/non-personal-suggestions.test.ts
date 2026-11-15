// tests/non-personal-suggestions.test.ts — "Suggested: not personal" for data managers
// (owner decision 2026-10-15, datasets/column-suggestions.ts).
//
// The design, pinned from both sides:
//   • Members see a column's real values (previews AND test runs) only after a data manager marks it
//     not personal (`nonPersonal`, through the existing data-manager `PATCH /api/datasets/:slug`).
//   • The suggestion rule only LABELS columns for the data manager. A suggestion changes nothing for
//     a member until it is confirmed. (An automatic version leaked names — "J. de Vries" under
//     `behandelaar` is 3 repeating short values, exactly like a tier.)
//   • Upload inference (`isPiiName`) is unchanged from origin/main: the wider person-role matcher is
//     suggestions-only, because upload-time PII flags make information-requests store "[redacted]".
//
// ⛔ Member reads run as `cp_app` (withTenantDbAsRuntimeRoleForTests): the decision reads mappings
// and the ontology under RLS, which the owner connection would bypass.
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerDatasetRoutes } from '../src/routes/datasets';
import {
  db,
  tenants,
  users,
  datasets,
  datasetRows,
  datasetMappings,
  ontologyEntities,
  ontologyAttributes,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { mergeRefreshedColumns, type DatasetColumn } from '../src/db/dataset-types';
import { maskInjectedForReader, memberMasks } from '../src/datasets/member-view';
import {
  isSuggestibleColumn,
  looksLikePersonColumnName,
  suggestDistinctLimit,
} from '../src/datasets/column-suggestions';
import { inferColumns, isPiiName } from '../src/datasets/parse/infer';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts).
const T = '00000000-0000-0000-0000-00000a5f0001';
const DEV_ID = '00000000-0000-0000-0000-00000a5f0011';
const ENTITY_ID = '00000000-0000-0000-0000-00000a5f0021';
const DS_ID = '00000000-0000-0000-0000-00000a5f0031';
const SLUG = 'np-suggest-policies';

const developer: User = { id: DEV_ID, email: 'npsuggest-dev@test', name: 'NP Dev', roles: ['developer'], tenantId: T };
const member: User = { id: DEV_ID, email: developer.email, name: developer.name, roles: [], tenantId: T };

const TIERS = ['gold', 'silver', 'bronze'];
const N = 30;
const NAMES = Array.from({ length: N }, (_, i) => `person${String.fromCharCode(97 + (i % 26))}${i}`);
// The first audit's probe: 3 first names REPEATED over 30 rows under person-role column names.
const FIRST = ['Anna', 'Bram', 'Cees'];
const PROBE = ['account_manager', 'customer', 'customerName', 'patient', 'assigned_to', 'klantnaam'] as const;
// The re-audit's probe: 3 handlers as initials + surname.
const HANDLERS = ['J. de Vries', 'P. Bakker', 'K. Smit'];
const ROWS: Record<string, unknown>[] = Array.from({ length: N }, (_, i) => ({
  tier: TIERS[i % 3]!,
  status: ['open', 'closed'][i % 2]!,
  country: ['NL', 'BE', 'DE'][i % 3]!,
  active: i % 2 === 0,
  tier_flagged: TIERS[i % 3]!,
  tier_personal: TIERS[i % 3]!,
  buyer: NAMES[i]!,
  reach: `user${i % 3}@example.com`,
  ref: `REF-${String(i).padStart(3, '0')}`,
  ...Object.fromEntries(PROBE.map((c) => [c, FIRST[i % 3]!])),
  behandelaar: HANDLERS[i % 3]!,
  lead: ['Anna de Vries', 'Bram van der Berg', 'Cees Jansen'][i % 3]!,
  employee_id: 101 + (i % 3),
  level: 1 + (i % 3),
  region: i < 10 ? 'north' : null,
}));
const COLUMNS: DatasetColumn[] = [
  { name: 'tier', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'country', type: 'string' },
  { name: 'active', type: 'boolean' },
  { name: 'tier_flagged', type: 'string', pii: true },
  { name: 'tier_personal', type: 'string' }, // confirmed mapping to a PII attribute
  { name: 'buyer', type: 'string' },
  { name: 'reach', type: 'string' },
  { name: 'ref', type: 'string' }, // confirmed mapping to a non-PII attribute
  ...PROBE.map((name) => ({ name, type: 'string' as const })),
  { name: 'behandelaar', type: 'string' },
  { name: 'lead', type: 'string' },
  { name: 'employee_id', type: 'number' },
  { name: 'level', type: 'number' },
  { name: 'region', type: 'string' },
];
const SUGGESTED = ['tier', 'status', 'country', 'active'];
const NEVER_SUGGESTED = [
  'buyer', 'reach', ...PROBE, 'behandelaar', 'lead', 'employee_id', 'level', 'region',
];

const router = new Router();
registerDatasetRoutes(router);

async function cleanup() {
  await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, DS_ID));
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, DS_ID));
  await db.delete(datasets).where(eq(datasets.id, DS_ID));
  await db.delete(ontologyAttributes).where(eq(ontologyAttributes.entity_id, ENTITY_ID));
  await db.delete(ontologyEntities).where(eq(ontologyEntities.id, ENTITY_ID));
  await db.delete(users).where(inArray(users.id, [DEV_ID]));
  await db.delete(tenants).where(eq(tenants.id, T));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: T, name: 'NP Suggest Tenant', slug: 'np-suggest' });
  await db.insert(users).values({ id: DEV_ID, email: developer.email, name: developer.name, tenant_id: T });
  await db.insert(ontologyEntities).values({
    id: ENTITY_ID, scope: 'generic', department: 'NPSuggestDept', name: 'NPSuggestPolicy', label: 'Policy', tenant_id: T,
  });
  await db.insert(ontologyAttributes).values([
    { entity_id: ENTITY_ID, name: 'reference', type: 'string', pii: false },
    { entity_id: ENTITY_ID, name: 'holder', type: 'string', pii: true },
  ]);
  await db.insert(datasets).values({
    id: DS_ID, owner_id: DEV_ID, tenant_id: T, name: 'NP Policies', slug: SLUG, source_type: 'csv', columns: COLUMNS, row_count: N,
  });
  await db.insert(datasetRows).values(ROWS.map((data, idx) => ({ dataset_id: DS_ID, idx, data })));
  await db.insert(datasetMappings).values({
    dataset_id: DS_ID, entity_id: ENTITY_ID, industry: '', department: 'NPSuggestDept',
    column_map: { ref: 'reference', tier_personal: 'holder' }, confirmed: true, tenant_id: T,
  });
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

function as(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

async function call(method: 'GET' | 'PATCH', path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!)!;
  const req = new Request(`http://localhost${path}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const res = await withTenantDbAsRuntimeRoleForTests(T, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** What a member's test run reads: the stored columns + rows through the real run masking. */
async function memberRun() {
  const [d] = await db.select().from(datasets).where(eq(datasets.id, DS_ID));
  const injected = { [SLUG]: { columns: d!.columns ?? [], rows: ROWS.map((r) => ({ ...r })) } };
  const out = await withTenantDbAsRuntimeRoleForTests(T, () => maskInjectedForReader(T, injected, false));
  return out[SLUG]!.rows;
}

const column = (rows: Record<string, unknown>[], name: string) => rows.map((r) => r[name]);
const original = (name: string) => ROWS.map((r) => r[name]);

describe('suggestions are shown to data managers only, and change nothing until confirmed', () => {
  test('a data manager gets exactly the suggestible columns', async () => {
    as(developer);
    const res = await call('GET', `/api/datasets/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.json.suggestedNonPersonal).toEqual(SUGGESTED);
    for (const name of NEVER_SUGGESTED) expect(res.json.suggestedNonPersonal).not.toContain(name);
  });

  test('a member never receives suggestions', async () => {
    as(member);
    const res = await call('GET', `/api/datasets/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.json.suggestedNonPersonal).toBeUndefined();
  });

  test('a SUGGESTED column is still a placeholder in a member run and hidden in the preview', async () => {
    const run = await memberRun();
    for (const [i, v] of column(run, 'tier').entries()) expect(v).not.toBe(original('tier')[i]);
    as(member);
    const res = await call('GET', `/api/datasets/${SLUG}?limit=50`);
    for (const name of SUGGESTED) expect(res.json.maskedColumns).toContain(name);
    // Positive control: the explicitly non-personal (mapped) column IS real for the member.
    expect(column(run, 'ref')).toEqual(original('ref'));
  });

  test('a member cannot mark a column not personal (existing data-manager permission)', async () => {
    as(member);
    const res = await call('PATCH', `/api/datasets/${SLUG}`, {
      columns: COLUMNS.map((c) => (c.name === 'tier' ? { ...c, nonPersonal: true } : c)),
    });
    expect(res.status).toBe(403);
    const [d] = await db.select().from(datasets).where(eq(datasets.id, DS_ID));
    expect(d!.columns!.find((c) => c.name === 'tier')!.nonPersonal).toBeUndefined();
  });

  test('after a data manager confirms `tier`, the member run and preview use the real values', async () => {
    as(developer);
    const res = await call('PATCH', `/api/datasets/${SLUG}`, {
      columns: COLUMNS.map((c) => (c.name === 'tier' ? { ...c, nonPersonal: true } : c)),
    });
    expect(res.status).toBe(200);

    expect(column(await memberRun(), 'tier')).toEqual(original('tier'));
    as(member);
    const preview = await call('GET', `/api/datasets/${SLUG}?limit=50`);
    expect(preview.json.maskedColumns).not.toContain('tier');
    expect(column(preview.json.rows, 'tier')).toEqual(original('tier'));
    // The still-unconfirmed suggestions stay hidden.
    for (const name of ['status', 'country']) expect(preview.json.maskedColumns).toContain(name);

    // And a confirmed column is no longer suggested.
    as(developer);
    const dm = await call('GET', `/api/datasets/${SLUG}`);
    expect(dm.json.suggestedNonPersonal).toEqual(['status', 'country', 'active']);
  });

  test('`pii: true` overrides `nonPersonal` (fail closed on a conflict)', async () => {
    const masks = await withTenantDbAsRuntimeRoleForTests(T, () =>
      memberMasks(T, [{ id: DS_ID, columns: [{ name: 'tier', type: 'string', pii: true, nonPersonal: true }] }], false),
    );
    expect(masks.get(DS_ID)).toEqual(['tier']);
  });

  test('a connector refresh keeps a human `nonPersonal` mark', () => {
    const merged = mergeRefreshedColumns(
      [{ name: 'tier', type: 'string', nonPersonal: true }],
      [{ name: 'tier', type: 'string' }],
    );
    expect(merged.columns[0]!.nonPersonal).toBe(true);
  });
});

describe('the suggestion rule', () => {
  const col = (name: string): DatasetColumn => ({ name, type: 'string' });
  const rowsOf = (name: string, values: unknown[]) => values.map((v) => ({ [name]: v }));
  const times = (v: unknown, n: number) => Array.from({ length: n }, () => v);
  const cycle = (vals: unknown[], n: number) => Array.from({ length: n }, (_, i) => vals[i % vals.length]);

  test('"J. de Vries" under `behandelaar` is never suggested — by name AND by value shape', () => {
    expect(isSuggestibleColumn(col('behandelaar'), rowsOf('behandelaar', cycle(HANDLERS, 30)))).toBe(false);
    // The same values under a neutral name: the value shape alone refuses them.
    expect(isSuggestibleColumn(col('queue'), rowsOf('queue', cycle(HANDLERS, 30)))).toBe(false);
    // Positive control: three repeating categories under that neutral name ARE suggested.
    expect(isSuggestibleColumn(col('queue'), rowsOf('queue', cycle(TIERS, 30)))).toBe(true);
  });

  for (const name of PROBE) {
    test(`audit probe: \`${name}\` with 3 repeating first names is never suggested`, () => {
      expect(isSuggestibleColumn(col(name), rowsOf(name, cycle(FIRST, 30)))).toBe(false);
    });
  }

  test('identifiers, integers, null-heavy and small samples are never suggested; booleans are', () => {
    expect(isSuggestibleColumn(col('employee_id'), rowsOf('employee_id', cycle([101, 102, 103], 30)))).toBe(false);
    expect(isSuggestibleColumn(col('level'), rowsOf('level', cycle([1, 2, 3], 30)))).toBe(false);
    expect(isSuggestibleColumn(col('region'), rowsOf('region', [...times('north', 10), ...times(null, 20)]))).toBe(false);
    expect(isSuggestibleColumn(col('kind'), rowsOf('kind', times('gold', 5)))).toBe(false);
    expect(isSuggestibleColumn(col('active'), rowsOf('active', cycle([true, false], 30)))).toBe(true);
  });

  test('values must repeat: 10 distinct first names over 10 rows are not categorical', () => {
    const names = ['anna', 'bram', 'cees', 'daan', 'eva', 'fleur', 'gijs', 'hugo', 'iris', 'joost'];
    expect(isSuggestibleColumn(col('given'), rowsOf('given', names))).toBe(false);
    expect(suggestDistinctLimit(10)).toBe(3);
    expect(suggestDistinctLimit(1000)).toBe(10);
  });
});

describe('upload inference is unchanged (pinned against origin/main)', () => {
  // The wider matcher flagged these as PII at upload, and information-requests then stored their
  // values as "[redacted]" for good. They must stay non-PII at upload…
  const HARMLESS = ['member_count', 'user_agent', 'agent_type', 'contact_rate', 'customer_segment', 'client_version', 'staff_count'];

  test('isPiiName and inferColumns leave member_count, user_agent, agent_type… unflagged', () => {
    for (const name of HARMLESS) expect(isPiiName(name)).toBe(false);
    const cols = inferColumns(HARMLESS, [Object.fromEntries(HARMLESS.map((n) => [n, 'x']))]);
    for (const c of cols) expect(c.pii, c.name).toBeFalsy();
    // origin/main's flags still hold.
    for (const name of ['email', 'first_name', 'name', 'iban', 'phone']) expect(isPiiName(name)).toBe(true);
  });

  test('…while the suggestion-only matcher may still decline to suggest them', () => {
    expect(looksLikePersonColumnName('user_agent')).toBe(true);
    expect(looksLikePersonColumnName('tier')).toBe(false);
  });
});
