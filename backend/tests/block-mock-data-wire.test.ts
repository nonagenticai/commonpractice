// tests/block-mock-data-wire.test.ts — the "Gesimuleerd" badge's WIRE contract.
//
// ⛔ THE DEFECT, MEASURED. `routes/blocks.ts` projects ONE bit onto every card row:
//
//     mock_data: v?.descriptor?.capabilities?.mockData === true,
//
// Delete that line and the whole backend suite stays at 1931 pass / 0 fail. Nothing asserted it.
// It is the ONLY thing that carries `descriptor.capabilities.mockData` to a browser — `GET
// /api/blocks` serves no descriptor at all, deliberately — and it feeds three of the five badged
// surfaces (the /blocks catalogue card, the build palette, and ExistingBlockPicker, which was
// added alongside this file).
//
// ⛔ AND THE FAILURE IS SILENT AND POINTS THE WRONG WAY. `BlockListItem.mock_data` is OPTIONAL on
// the wire, deliberately (an old pod mid-roll serves rows without it), and every render site reads
// it as `{#if b.mock_data ?? false}`. So the field going missing does not blank the card or throw:
// it renders "NOT simulated" for a block that answers from `ctx.mockData()`. That is precisely the
// false negative this feature exists to prevent, delivered with a green suite and a green screen.
//
// ⛔ WHY THE FRONTEND TESTS COULD NOT SEE IT. Every one of them hand-builds a `BlockListItem`
// literal with `mock_data` already set. They prove the component renders the bit it is handed;
// they cannot prove anything hands it over. This file drives the REAL route through the same
// `Router` + `registerBlockRoutes` in-process harness as blocks.test.ts and block-source-gate.
// test.ts, so the assertion is on the bytes a browser receives.
//
// ⚠️ THE FIXTURES ARE CREATED THROUGH `POST /api/blocks`, not planted with drizzle inserts. The
// descriptor has to survive save-time validation (`descriptorSchema`, `.strict()` on the
// capability bag) and the version row it lands in has to be the one `displayVersion` picks. A
// planted row would prove the SELECT and skip both.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { seed } from '../src/db/seed';
import { db, buildingBlocks, blockVersions } from '../src/db/client';
import type { BlockDescriptor } from '../src/db/block-types';
import type { User } from '../src/types';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Lint-clean and scan-clean — the source gate runs on every `POST /api/blocks`. */
const SRC =
  'export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ return {}; } };';

/**
 * ⚠️ ONE PREFIX, AND THE NARROW LIST IS SCOPED TO IT WITH `?q=`.
 * A parallel lane owns `src/db/seed.ts`, so an assertion phrased against a seeded slug would go
 * red for a reason that has nothing to do with this projection. These three blocks are created,
 * asserted and deleted by this file alone.
 */
const PREFIX = 'mdw-wire';
const SIM = `${PREFIX}-simulated`;
const REAL = `${PREFIX}-real`;
const DATASET = `${PREFIX}-dataset`;

/** Global (tenant_id NULL) authoring: super_admin with no `?scope=tenant` — same as blocks.test.ts. */
const platformUser: User = {
  id: '0000000b-1b00-0000-0000-0000000000e1',
  email: 'mdw-super@test',
  name: 'MDW Super',
  roles: ['super_admin', 'developer', 'employee'],
};

function asUser(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, role) => {
      if (!u.roles.includes(role)) {
        const { UnauthorizedError } = await import('../src/types');
        throw new UnauthorizedError(`Role '${role}' required`);
      }
      return u;
    },
  });
}

const router = new Router();
registerBlockRoutes(router);

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
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

/** The list route's rows, keyed by slug — this is the shape the browser actually parses. */
async function listBySlug(query = `?q=${PREFIX}`): Promise<Map<string, Record<string, unknown>>> {
  const res = await call('GET', `/api/blocks${query}`);
  expect(res.status).toBe(200);
  const items = (res.json?.items ?? []) as Record<string, unknown>[];
  return new Map(items.map((i) => [String(i.slug), i]));
}

async function makeBlock(slug: string, capabilities: Record<string, boolean>): Promise<void> {
  const res = await call('POST', '/api/blocks', {
    slug,
    name: slug,
    description: `${PREFIX} fixture`,
    category: 'logic',
    source_ts: SRC,
    descriptor: { inputs: {}, outputs: {}, capabilities },
  });
  // The status AND the error code in one assertion, so a 403/422 names itself instead of failing
  // as a bare `expected 201, got 422`.
  expect(`${slug}: ${res.status} ${res.json?.error ?? ''}`.trim()).toBe(`${slug}: 201`);
}

/** The capability bag as it was actually STORED — the input side of the projection under test. */
async function storedCaps(slug: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ d: blockVersions.descriptor })
    .from(blockVersions)
    .innerJoin(buildingBlocks, eq(buildingBlocks.id, blockVersions.block_id))
    .where(eq(buildingBlocks.slug, slug));
  return ((row?.d as BlockDescriptor | null)?.capabilities ?? {}) as Record<string, unknown>;
}

/** `current_version_id` must be nulled before the versions go, or the FK blocks the delete. */
async function cleanup(): Promise<void> {
  const rows = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(sql`${buildingBlocks.slug} like ${`${PREFIX}%`}`);
  for (const r of rows) {
    await db
      .update(buildingBlocks)
      .set({ current_version_id: null })
      .where(eq(buildingBlocks.id, r.id));
    await db.delete(blockVersions).where(eq(blockVersions.block_id, r.id));
  }
  await db.delete(buildingBlocks).where(sql`${buildingBlocks.slug} like ${`${PREFIX}%`}`);
}

beforeAll(async () => {
  asUser(platformUser);
  await seed(); // idempotent — the catalogue-wide test below needs a populated library
  await cleanup(); // leftovers from a prior run
  // ⛔ THE CAPABILITY BAGS ARE CHOSEN TO DISCRIMINATE, NOT MERELY TO DIFFER. `llm` sits on the
  // block that must come back FALSE and on nothing else, so a projection reading the wrong key
  // INVERTS rather than degrades; `dataset` gets its own block because `|| capabilities.dataset`
  // is the one widening the source comment warns about by name. See the mutation notes below.
  await makeBlock(SIM, { network: false, mockData: true });
  await makeBlock(REAL, { network: false, llm: true });
  await makeBlock(DATASET, { network: false, dataset: true });
}, 60_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 60_000);

// ===========================================================================
// 1. BOTH DIRECTIONS, THROUGH THE REAL ROUTE
// ===========================================================================

test('⛔ GET /api/blocks carries capabilities.mockData as `mock_data`, in BOTH directions', async () => {
  // ⛔ THE PREMISE, ASSERTED BEFORE ANYTHING IS READ OFF THE WIRE. Every expectation below is
  // about a projection FROM the stored descriptor, so if the descriptor did not store what this
  // file thinks it stored, the whole test is measuring the wrong thing. Read individually rather
  // than with one `toEqual` on the bag, so a future default added by `createBlockCore` cannot fail
  // this for a reason unrelated to the bit under test.
  const simCaps = await storedCaps(SIM);
  const realCaps = await storedCaps(REAL);
  const dsCaps = await storedCaps(DATASET);
  expect(simCaps.mockData, `${SIM} did not store mockData`).toBe(true);
  expect(realCaps.mockData, `${REAL} must not store mockData`).not.toBe(true);
  expect(realCaps.llm, `${REAL} is the wrong-key discriminator and must store llm`).toBe(true);
  expect(dsCaps.mockData, `${DATASET} must not store mockData`).not.toBe(true);
  expect(dsCaps.dataset, `${DATASET} must store dataset`).toBe(true);

  const rows = await listBySlug();

  // ⛔ NON-VACUITY. Every negative below is satisfied for free by a list that returned nothing — a
  // renamed route, a `q` that matches no row, an auth override that stopped applying. Prove all
  // three fixtures are on the wire before reading a single bit off them.
  expect([...rows.keys()].sort()).toEqual([DATASET, REAL, SIM].sort());

  // --- the direction that dies when the projection line is DELETED -------------------------
  // `toBe(true)`, never `toBeTruthy()`: deleting the line makes the key ABSENT, and `undefined`
  // has to fail here. This is the assertion the whole file exists for.
  expect(rows.get(SIM)!.mock_data).toBe(true);

  // --- the direction that dies on an ALWAYS-TRUE mutant ------------------------------------
  // `mock_data: true`, `mock_data: !!v`, `mock_data: v?.descriptor !== undefined` — each badges
  // the entire catalogue "Gesimuleerd" and destroys the badge's meaning as thoroughly as omitting
  // it. `toBe(false)` additionally kills the TRI-STATE mutant (`v?.descriptor?.capabilities
  // ?.mockData` with the `=== true` dropped, which yields `undefined` here): the field's
  // documented contract is a boolean, never absent, because the badge's absence must not be
  // ambiguous between "this block is real" and "this backend is too old to say".
  expect(rows.get(REAL)!.mock_data).toBe(false);

  // --- the direction that dies on `|| capabilities.dataset` ---------------------------------
  // ⛔ THE WIDENING THE SOURCE COMMENT NAMES, and the one a well-meaning future edit reaches for
  // ("dataset is the same trust class"). It is not: `dataset` grants access to the TENANT'S OWN
  // ROWS. ORing it in badges `load-dataset` and every ontology-derived data block as a simulation
  // — telling a customer their own data is invented, which is strictly worse than saying nothing,
  // and is the exact defect migration 0077 split the capability to undo.
  expect(rows.get(DATASET)!.mock_data).toBe(false);

  // --- the direction that dies on a WRONG-KEY mutant ----------------------------------------
  // `capabilities.llm` is declared on REAL and nowhere else and `network: false` is on all three,
  // so a projection reading `llm` inverts the first two assertions and one reading `network`
  // cannot make SIM true. Both are covered by the three expectations above given the premise
  // block at the top of this test — nothing further to assert, but do not "simplify" the bags.
}, 60_000);

// ===========================================================================
// 2. THE FIELD IS PRESENT ON EVERY ROW, NOT ONLY ON THIS FILE'S FIXTURES
// ===========================================================================

test('⛔ `mock_data` is a boolean on EVERY row the catalogue serves — never absent', async () => {
  // ⛔ THE SAME MUTANT AS ABOVE, CAUGHT WITHOUT DEPENDING ON THIS FILE'S FIXTURES SURVIVING.
  // A future edit that renames the prefix, drops a fixture or reworks the assertions above still
  // meets this one: deleting the projection line makes the key absent from every row in the
  // catalogue at once, and `typeof undefined` is not 'boolean'.
  //
  // It is also where the OPTIONALITY doctrine gets its other half. `BlockListItem.mock_data` is
  // optional so an OLD POD mid-roll may omit it; that is a tolerance for a deploy window, NOT a
  // licence for the current build to omit it. This is where the current build is held to sending
  // it on every row it serves.
  const rows = await listBySlug('');
  expect(rows.size, 'no blocks in this database — run `bun run migrate && bun run seed`').toBeGreaterThan(10);

  const bad = [...rows.entries()]
    .filter(([, r]) => typeof r.mock_data !== 'boolean')
    .map(([slug, r]) => `${slug}: ${JSON.stringify(r.mock_data)}`);
  expect(
    bad,
    bad.length
      ? `these rows reached the browser without a boolean \`mock_data\`: ${JSON.stringify(bad)}. ` +
          `Every render site reads it as \`?? false\`, so an absent field renders "not simulated" ` +
          `for a block that answers from ctx.mockData() — silently, with no error anywhere.`
      : undefined,
  ).toEqual([]);

  // …and the sample really carries BOTH polarities, or "every row is a boolean" is satisfied by a
  // constant. This file's own three fixtures guarantee it independently of what `seed.ts`
  // declares, which matters because a parallel lane owns that file.
  const values = [...rows.values()].map((r) => r.mock_data);
  expect(values, 'no row is simulated — the true direction is untested here').toContain(true);
  expect(values, 'every row is simulated — the false direction is untested here').toContain(false);
}, 60_000);
