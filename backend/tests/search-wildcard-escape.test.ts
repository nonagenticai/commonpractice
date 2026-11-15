// tests/search-wildcard-escape.test.ts — a search box must search for what the user typed.
//
// ⛔ THE DEFECT. `%` and `_` are ILIKE metacharacters. Eleven predicates across seven files
// interpolated the user's raw query straight into `` `%${q}%` ``, so the two characters the user
// typed as TEXT were handed to the pattern matcher as WILDCARDS:
//
//   typed `Korting 100% eraf` → pattern `%Korting 100% eraf%` → `100` then ANYTHING then ` eraf`
//   typed `rij_a`             → pattern `%rij_a%`             → `rij` then ANY ONE CHAR then `a`
//
// `src/utils/search.ts` has exported `likeTerm(q)` — the three-character escape — since the
// topbar was fixed, and exactly two callers used it. This file is the behavioural proof for
// EVERY predicate the sweep touched — the four tenant-facing boards (the challenge board, the
// solution board, the block library and the dataset list), the two SUPER-ADMIN consoles (the
// audit feed and the sandbox list), and the AGENT-facing block catalogue behind the MCP
// `search_blocks` tool. (The static ratchet that stops an eighth copy being written is
// tests/search-escape-source.guard.test.ts.)
//
// ⚠️ ALL SEVEN CHANGED SITES ARE REACHED BY A BEHAVIOURAL CASE HERE, and that is the property to
// preserve when editing this file. An earlier revision covered only the four tenant boards, so
// reverting `routes/audit.ts`, `routes/sandboxes.ts` or `ai/block-catalog-service.ts` failed
// nothing but the source-text ratchet — which bans a SPELLING, not a behaviour, and would have
// scored a semantically-identical rewrite of the raw pattern clean. `routes/audit.ts` was the
// worst of the three to leave unproven: `dataset_created` matching `dataset<any char>created`
// is the live symptom the code's own comments name.
//
// ⛔ AN ABSENCE-ONLY ASSERTION WOULD BE WORTHLESS HERE, and that is the trap this file is
// shaped around. "the decoy is not in the results" is satisfied by an EMPTY result set — by a
// broken fixture, an RLS scope that hid both rows, a 500 swallowed into `items: []`, or a
// per-group cap that truncated the list. So EVERY surface is asserted in BOTH directions, in
// the same test:
//
//   • the WILDCARD query returns EXACTLY the literal row — `toEqual([literalId])`, an equality
//     on the whole returned list, not a `.find()` that ignores what else came back; and
//   • a CONTROL query with no metacharacter in it returns BOTH rows — which is what proves the
//     decoy row exists, is visible to this caller, and is reachable by this predicate. Without
//     it, deleting the fixture would make the first assertion pass.
//
// ⚠️ AND THE COUNT IS ASSERTED ALONGSIDE THE ROWS, so a cap cannot do the work of the escape —
// ON THE ROUTES WHERE THE COUNT IS INDEPENDENT, which is not all of them:
//
//   • /api/challenges, /api/solutions, /api/datasets, /api/sandboxes and /api/audit each run a
//     SEPARATE aggregate over the SAME predicate (`counts`/`count(*)`), and `items` is a
//     `limit`/`offset` slice of it. There `total` is a genuinely independent witness: a cap that
//     truncated `items` would leave `total` disagreeing.
//   • /api/blocks is NOT one of them. routes/blocks.ts:413 returns `total: items.length` — the
//     length of the very array the assertion above already pinned — so the `total` expectation on
//     that surface is IMPLIED by the `ids` expectation and proves nothing extra. It is asserted
//     anyway (it costs nothing and pins the shape of the response), but it must not be read as an
//     anti-cap witness. The library route does its filtering in memory and is unpaginated, so
//     there is no cap for it to hide.
//   • The MCP `search_blocks` tool returns no count at all — see its own case at the foot of this
//     file for how the cap question is answered there instead.
//
// Four rows against a page size of 10-12 cannot be truncated regardless.
//
// ⚠️ EVERY QUERY IS MARK-SCOPED. The database is shared with other suites and with seeded demo
// content, so a bare `100%` would be answered partly by rows this file did not write. Each query
// carries the file's unique MARK prefix, which makes `toEqual([literalId])` an exact statement
// rather than a bet on what else is in the table.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError } from '../src/types';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { registerSolutionRoutes } from '../src/routes/solutions';
import { registerBlockRoutes } from '../src/routes/blocks';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { registerAuditRoutes } from '../src/routes/audit';
import { registerSandboxRoutes } from '../src/routes/sandboxes';
import { McpHost, type McpAuthContext } from '../src/ai/mcp-server';
import {
  db,
  users,
  challenges,
  solutions,
  votes,
  buildingBlocks,
  blockVersions,
  datasets,
  datasetRows,
  auditLog,
  sandboxes,
  contentTranslations,
  withTenantDb,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { emptyDescriptor } from '../src/db/block-types';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00005ca9e001';
const user: User = {
  id: UID,
  email: 'wildcard@test',
  name: 'Wanda Wildcard',
  // `developer` so the dataset route's data-manager gate is satisfied; the read path this file
  // exercises does not need it, but `canManage` is computed on every response.
  roles: ['employee', 'developer'],
  tenantId: DEMO_TENANT_ID,
};

// The super-admin the two platform consoles are read by. A SECOND user rather than more roles on
// the first: /api/blocks and /api/challenges branch on `isSuperAdmin` in places, and widening the
// tenant reader's roles would quietly change what the four board cases above are measuring.
const ADMIN_ID = '00000000-0000-0000-0000-00005ca9e002';
const admin: User = {
  id: ADMIN_ID,
  email: 'wildcard-admin@test',
  name: 'Wanda Admin',
  roles: ['super_admin', 'employee'],
  tenantId: DEMO_TENANT_ID,
};

/** The file's baseline seam: the tenant reader, with `requireRole` waved through. */
function installBase() {
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
}

/**
 * The ROLE-ENFORCING seam, copied from tests/audit.test.ts / tests/sandboxes-routes.test.ts —
 * `requireSuperAdmin` is a real gate on both consoles and the default test seam bypasses it, so a
 * case that installed the permissive override would be asserting against a route it had disarmed.
 * Every caller restores `installBase()` in a `finally`.
 */
function installEnforcing(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, role) => {
      if (!u.roles.includes(role)) throw new UnauthorizedError(`Role '${role}' required`);
      return u;
    },
  });
}

const MARK = 'ZWILDESC';

// ---------------------------------------------------------------------------
// The four rows every surface gets, twice over: one PAIR for `%` and one for `_`.
//
// The decoy differs from the literal by exactly the character the wildcard would have matched:
// `%` stands for "any run of characters" (→ `X`), `_` for "exactly one character" (→ `x`). So a
// route that escapes correctly separates them and a route that does not returns both. Nothing
// else about the two strings differs, which is what makes the pair a controlled comparison
// rather than two unrelated rows.
// ---------------------------------------------------------------------------
const PCT_LITERAL = `${MARK} Korting Q100% eraf`;
const PCT_DECOY = `${MARK} Korting Q100X eraf`;
const US_LITERAL = `${MARK} rij_a`;
const US_DECOY = `${MARK} rijxa`;

/** The query a user types into the box. Both carry a metacharacter; both are MARK-scoped. */
const PCT_QUERY = `${MARK} Korting Q100%`;
const US_QUERY = `${MARK} rij_a`;
/** The controls — the same rows, reached without a metacharacter. */
const PCT_CONTROL = `${MARK} Korting`;
const US_CONTROL = `${MARK} rij`;

// ---------------------------------------------------------------------------
// THE BACKSLASH PAIR. `\` is Postgres's default LIKE/ILIKE escape character, which makes it the
// metacharacter an escape function can get wrong IN THE OTHER DIRECTION, and it needs a pair of
// its own for the same reason `%` and `_` do.
//
// Unescaped, the pattern `%…pad\a%` reads `\a` as "the literal character a", so it matches
// `…pada` — the DECOY — and does NOT match `…pad\a`, the row the user typed. The two answers are
// therefore mirror images and no assertion can be satisfied by both:
//
//   fixed  (`\` escaped to `\\`) → the literal row `pad\a`, and only it
//   broken (`\` left raw)        → the decoy row `pada`, and only it
//
// ⚠️ THIS REPLACED A MUTATION-VACUOUS CASE. The previous revision typed a query with a trailing
// backslash at a table containing no backslash at all and asserted `items: []`, `total: 0`,
// `status: 200` — which is the same answer on the fixed code, on origin/main, and on a `likeTerm`
// that escapes `%`/`_` and leaves `\` alone. It was named "nor eats the next character" and no
// seeded row had a next character to eat.
// ---------------------------------------------------------------------------
const BS_LITERAL = `${MARK} pad\\a`;
const BS_DECOY = `${MARK} pada`;
const BS_QUERY = `${MARK} pad\\a`;
const BS_CONTROL = `${MARK} pad`;

// ---------------------------------------------------------------------------
// THE TRANSLATED ARM. `routes/challenges.ts` feeds ONE pattern to TWO predicates — the English
// base column and `translatedMatchSql`, the correlated EXISTS over `content_translations` — and
// `translatedMatchSql` returns `undefined` for the default locale. So under `en` the translated
// arm is not merely unexercised, it is not in the query, and every case above ran under `en`.
//
// These two rows carry their `%` pair ONLY in Dutch: the base titles hold no `Vergoeding` token,
// which is what forces an `nl` hit to have come through the EXISTS rather than through a base
// column that happened to contain the term. The `en` half of the case asserts exactly that.
// ---------------------------------------------------------------------------
const NL_BASE_LIT = `${MARK} nlbase literal`;
const NL_BASE_DEC = `${MARK} nlbase decoy`;
const NL_LITERAL = `${MARK} Vergoeding Q300% af`;
const NL_DECOY = `${MARK} Vergoeding Q300X af`;
const NL_QUERY = `${MARK} Vergoeding Q300%`;
const NL_CONTROL = `${MARK} Vergoeding Q300`;

// ---------------------------------------------------------------------------
// THE AUDIT FEED (`routes/audit.ts`). `action` values are literally underscore-separated machine
// codes, so `_` is not a hypothetical here — it is in almost every row the box is used on, and
// `dataset_created` matching `dataset<any char>created` is the symptom the route's own comment
// names. The pairs live in `action`; `target_id` and the joined `users.name` are the other two
// arms and carry nothing that could answer these queries.
// ---------------------------------------------------------------------------
const AUD_US_LITERAL = 'zwildaud.dataset_created';
const AUD_US_DECOY = 'zwildaud.datasetXcreated';
const AUD_US_CONTROL = 'zwildaud.dataset';
const AUD_PCT_LITERAL = 'zwildaud.pct100%x';
const AUD_PCT_DECOY = 'zwildaud.pct100zx';
const AUD_PCT_CONTROL = 'zwildaud.pct100';

// ---------------------------------------------------------------------------
// THE SANDBOX LIST (`routes/sandboxes.ts`). Two different arms of the same predicate: the `_`
// pair sits in `slug` (slugs are hyphen/underscore-shaped, which is the route's stated symptom)
// and the `%` pair sits in `project`. The slug prefixes are deliberately DISJOINT so the `_`
// control cannot reach the `%` rows.
// ---------------------------------------------------------------------------
const SB_US_LIT_SLUG = 'zwildesc-sb_a';
const SB_US_DEC_SLUG = 'zwildesc-sbxa';
const SB_US_CONTROL = 'zwildesc-sb';
const SB_PCT_LIT_SLUG = 'zwildesc-pctsb-lit';
const SB_PCT_DEC_SLUG = 'zwildesc-pctsb-dec';
const SB_PCT_LIT_PROJECT = `${MARK} Sandkorting Q100% eraf`;
const SB_PCT_DEC_PROJECT = `${MARK} Sandkorting Q100X eraf`;
const SB_PCT_QUERY = `${MARK} Sandkorting Q100%`;
const SB_PCT_CONTROL = `${MARK} Sandkorting`;
const SB_US_PROJECT = `${MARK}SBUS`;

const BLK_PCT_LIT = '00000000-0000-0000-0000-00005ca9e011';
const BLK_PCT_DEC = '00000000-0000-0000-0000-00005ca9e012';
const BLK_US_LIT = '00000000-0000-0000-0000-00005ca9e013';
const BLK_US_DEC = '00000000-0000-0000-0000-00005ca9e014';
const VER_PCT_LIT = '00000000-0000-0000-0000-00005ca9e021';
const VER_PCT_DEC = '00000000-0000-0000-0000-00005ca9e022';
const VER_US_LIT = '00000000-0000-0000-0000-00005ca9e023';
const VER_US_DEC = '00000000-0000-0000-0000-00005ca9e024';
const BLOCK_IDS = [BLK_PCT_LIT, BLK_PCT_DEC, BLK_US_LIT, BLK_US_DEC];
const VERSION_IDS = [VER_PCT_LIT, VER_PCT_DEC, VER_US_LIT, VER_US_DEC];
const BLOCK_SLUGS = {
  [BLK_PCT_LIT]: 'zwildesc-pct-literal',
  [BLK_PCT_DEC]: 'zwildesc-pct-decoy',
  [BLK_US_LIT]: 'zwildesc-us-literal',
  [BLK_US_DEC]: 'zwildesc-us-decoy',
} as const;

const router = new Router();
registerChallengeRoutes(router);
registerSolutionRoutes(router);
registerBlockRoutes(router);
registerDatasetRoutes(router);
registerAuditRoutes(router);
registerSandboxRoutes(router);

/** The in-process MCP host — the real path `search_blocks` reaches the block catalogue by. */
const mcpHost = new McpHost();
const mcpCtx: McpAuthContext = { userId: UID, tenantId: null, roles: ['employee'] };

/**
 * `q` is put through `encodeURIComponent` rather than being pasted into the path. A bare `%`
 * in a URL is the start of a percent-escape — `?q=100% eraf` is not "the user typed 100%", it is
 * a malformed URL, and asserting against it would be testing the URL parser rather than the SQL
 * pattern. This is exactly what the browser's own `URLSearchParams` does with the box's value.
 */
async function call(path: string, q: string, locale = 'en') {
  const full = `${path}${path.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}`;
  const matched = router.match('GET', full.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${full}`);
  const req = new Request(`http://localhost${full}`, {
    method: 'GET',
    headers: { 'accept-language': locale },
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/**
 * The AUDIT console's own harness. Deliberately NOT `call()`: `routes/audit.ts` reads `db`
 * directly with no tenant scoping (audit_log is a platform table), and tests/audit.test.ts calls
 * the handler unwrapped for that reason. Wrapping it in `withTenantDb` would be inventing a
 * calling convention the route does not have.
 *
 * `range=all` because the feed's default window is the last 7 days and a fixture row is inserted
 * with whatever `now()` is — fine today, but a rounding or clock question is not what this case
 * is about.
 */
async function callAudit(q: string) {
  const path = `/api/audit?range=all&q=${encodeURIComponent(q)}`;
  const matched = router.match('GET', '/api/audit');
  if (!matched) throw new Error('no route for GET /api/audit');
  const req = new Request(`http://localhost${path}`, { method: 'GET' });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/**
 * The SANDBOX console's own harness — `withTenantDbAsRuntimeRoleForTests`, exactly as
 * tests/sandboxes-routes.test.ts does it. The route escalates through `runAsSystem` internally,
 * and the runtime role is what makes that escalation the real one rather than a superuser
 * connection that would be allowed everything anyway.
 */
async function callSandboxes(q: string) {
  const path = `/api/sandboxes?q=${encodeURIComponent(q)}`;
  const matched = router.match('GET', '/api/sandboxes');
  if (!matched) throw new Error('no route for GET /api/sandboxes');
  const req = new Request(`http://localhost${path}`, { method: 'GET' });
  const res = await withTenantDbAsRuntimeRoleForTests(DEMO_TENANT_ID, () =>
    matched.handler(req, ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const sorted = (xs: string[]) => [...xs].sort();

let chPctLit = '';
let chPctDec = '';
let chUsLit = '';
let chUsDec = '';
let solPctLit = '';
let solPctDec = '';
let solUsLit = '';
let solUsDec = '';
let dsPctLit = '';
let dsPctDec = '';
let dsUsLit = '';
let dsUsDec = '';
let chBsLit = '';
let chBsDec = '';
let chNlLit = '';
let chNlDec = '';
let sbUsLit = '';
let sbUsDec = '';
let sbPctLit = '';
let sbPctDec = '';
/** The parent challenge the solutions hang off — solutions.challenge_id is NOT NULL. */
let parentChallenge = '';

async function cleanup() {
  const chIds = (
    await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))
  ).map((r) => r.id);
  const solIds = (
    await db.select({ id: solutions.id }).from(solutions).where(like(solutions.title, `${MARK}%`))
  ).map((r) => r.id);
  const allSolIds = chIds.length
    ? [
        ...new Set([
          ...solIds,
          ...(
            await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, chIds))
          ).map((r) => r.id),
        ]),
      ]
    : solIds;
  if (allSolIds.length) {
    await db.delete(votes).where(inArray(votes.target_id, allSolIds));
    await db.delete(solutions).where(inArray(solutions.id, allSolIds));
  }
  if (chIds.length) {
    await db.delete(votes).where(inArray(votes.target_id, chIds));
    await db.delete(challenges).where(inArray(challenges.id, chIds));
  }
  const dsIds = (
    await db.select({ id: datasets.id }).from(datasets).where(like(datasets.name, `${MARK}%`))
  ).map((r) => r.id);
  if (dsIds.length) {
    await db.delete(datasetRows).where(inArray(datasetRows.dataset_id, dsIds));
    await db.delete(datasets).where(inArray(datasets.id, dsIds));
  }
  // Drop the back-pointer before the versions, else `building_blocks_current_version_fk` blocks
  // the delete — the same order tests/search-i18n.test.ts uses.
  await db
    .update(buildingBlocks)
    .set({ current_version_id: null })
    .where(inArray(buildingBlocks.id, BLOCK_IDS));
  await db.delete(blockVersions).where(inArray(blockVersions.id, VERSION_IDS));
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, BLOCK_IDS));
  // The nl overlay rows for the challenges deleted above. Keyed by entity_id, and the challenge
  // ids are freshly minted every run, so the delete is by the file's MARK on the VALUE — the only
  // handle that survives across runs.
  await db.delete(contentTranslations).where(like(contentTranslations.value, `${MARK}%`));
  // Audit rows: both the fixture actions AND the `mcp.tool_call` rows every `callTool` below
  // writes. `actor_id` is unique to this file, which covers both without naming either.
  await db.delete(auditLog).where(eq(auditLog.actor_id, UID));
  await db.delete(auditLog).where(like(auditLog.action, 'zwildaud.%'));
  // BEFORE the users delete — sandboxes.owner_id is an FK.
  await db.delete(sandboxes).where(inArray(sandboxes.owner_id, [UID, ADMIN_ID]));
  await db.delete(users).where(inArray(users.id, [UID, ADMIN_ID]));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeAll(async () => {
  await cleanup();
  await db
    .insert(users)
    .values({ id: UID, email: user.email, name: user.name, avatar_initials: 'WW', tenant_id: DEMO_TENANT_ID })
    .onConflictDoNothing();
  await db
    .insert(users)
    .values({ id: ADMIN_ID, email: admin.email, name: admin.name, avatar_initials: 'WA', tenant_id: DEMO_TENANT_ID })
    .onConflictDoNothing();
  installBase();

  // ---- challenges. Distinct vote counts so the default `top` sort is TOTAL over the pair and
  // the returned order is a fact rather than heap order.
  const chRows = await db
    .insert(challenges)
    .values(
      [
        [PCT_LITERAL, 9],
        [PCT_DECOY, 8],
        [US_LITERAL, 7],
        [US_DECOY, 6],
        [`${MARK} parent`, 5],
        // Appended AFTER `parent` so the destructure below keeps its existing indices.
        [BS_LITERAL, 4],
        [BS_DECOY, 3],
        [NL_BASE_LIT, 2],
        [NL_BASE_DEC, 1],
      ].map(([title, v]) => ({
        title: title as string,
        work_area: 'Claims' as const,
        submitter_id: UID,
        tenant_id: DEMO_TENANT_ID,
        status: 'voting' as const,
        votes_count: v as number,
        week: '2026-W21',
      })),
    )
    .returning();
  [chPctLit, chPctDec, chUsLit, chUsDec, parentChallenge, chBsLit, chBsDec, chNlLit, chNlDec] =
    chRows.map((r) => r.id) as [
      string, string, string, string, string, string, string, string, string,
    ];

  // The Dutch edition of the nl pair. `content_translations` is where every discover surface
  // OVERLAYS its prose from, and `translatedMatchSql` is the arm that searches it — the arm no
  // case in this file reached while every query ran under the default locale.
  await db.insert(contentTranslations).values([
    { entity_type: 'challenge', entity_id: chNlLit, locale: 'nl', field: 'title', value: NL_LITERAL },
    { entity_type: 'challenge', entity_id: chNlDec, locale: 'nl', field: 'title', value: NL_DECOY },
  ]);

  // ---- solutions. Hung off a MARK'd parent challenge so cleanup reaches them either way.
  const solRows = await db
    .insert(solutions)
    .values(
      [
        [PCT_LITERAL, 9],
        [PCT_DECOY, 8],
        [US_LITERAL, 7],
        [US_DECOY, 6],
      ].map(([title, v]) => ({
        challenge_id: parentChallenge,
        title: title as string,
        author_id: UID,
        status: 'voting' as const,
        votes_count: v as number,
        blocks_used: [],
        tenant_id: DEMO_TENANT_ID,
        week: '2026-W21',
      })),
    )
    .returning();
  [solPctLit, solPctDec, solUsLit, solUsDec] = solRows.map((r) => r.id) as [
    string, string, string, string,
  ];

  // ---- blocks. `building_blocks.current_version_id` and `block_versions.block_id` reference
  // each other, so blocks go in first WITHOUT a current version, then the versions, then the
  // back-pointer — the dance search-i18n.test.ts documents. The library route does not itself
  // require a published version, but a block with none renders `version: null`, which is not the
  // row a reader would ever be looking at.
  //
  // The MARK lives in the NAME only: a slug cannot hold a space, so the queries below (which all
  // contain one) can only be answered by the name arm.
  await db.insert(buildingBlocks).values(
    (
      [
        [BLK_PCT_LIT, PCT_LITERAL],
        [BLK_PCT_DEC, PCT_DECOY],
        [BLK_US_LIT, US_LITERAL],
        [BLK_US_DEC, US_DECOY],
      ] as const
    ).map(([id, name]) => ({
      id,
      slug: BLOCK_SLUGS[id],
      name,
      description: 'base prose',
      category: 'logic' as const,
      tenant_id: DEMO_TENANT_ID,
      maintainer_id: UID,
    })),
  );
  await db.insert(blockVersions).values(
    (
      [
        [VER_PCT_LIT, BLK_PCT_LIT],
        [VER_PCT_DEC, BLK_PCT_DEC],
        [VER_US_LIT, BLK_US_LIT],
        [VER_US_DEC, BLK_US_DEC],
      ] as const
    ).map(([id, blockId]) => ({
      id,
      block_id: blockId,
      version: '1.0.0',
      docs_md: 'docs',
      status: 'stable' as const,
      descriptor: emptyDescriptor(),
    })),
  );
  for (const [blockId, versionId] of [
    [BLK_PCT_LIT, VER_PCT_LIT],
    [BLK_PCT_DEC, VER_PCT_DEC],
    [BLK_US_LIT, VER_US_LIT],
    [BLK_US_DEC, VER_US_DEC],
  ] as const) {
    await db.update(buildingBlocks).set({ current_version_id: versionId }).where(eq(buildingBlocks.id, blockId));
  }

  // ---- datasets. Same rule as blocks: the MARK is in `name`, never in `slug`.
  const dsRows = await db
    .insert(datasets)
    .values(
      (
        [
          [PCT_LITERAL, 'zwildesc-ds-pct-literal'],
          [PCT_DECOY, 'zwildesc-ds-pct-decoy'],
          [US_LITERAL, 'zwildesc-ds-us-literal'],
          [US_DECOY, 'zwildesc-ds-us-decoy'],
        ] as const
      ).map(([name, slug]) => ({
        owner_id: UID,
        tenant_id: DEMO_TENANT_ID,
        name,
        slug,
        source_type: 'csv' as const,
        columns: [],
      })),
    )
    .returning();
  [dsPctLit, dsPctDec, dsUsLit, dsUsDec] = dsRows.map((r) => r.id) as [string, string, string, string];

  // ---- audit rows. `category` is one of the feed's real chips so the `counts.all` the route
  // derives its `total` from is computed the way production computes it.
  await db.insert(auditLog).values(
    [AUD_US_LITERAL, AUD_US_DECOY, AUD_PCT_LITERAL, AUD_PCT_DECOY].map((action) => ({
      actor_id: UID,
      action,
      category: 'sandbox' as const,
      target_type: 'dataset',
      // Deliberately NOT derived from `action`: `target_id` is the second arm of the same OR, and
      // letting it echo the action would mean a passing case could not tell the two arms apart.
      target_id: 'zwildaud-target',
      result: 'Success',
      result_tone: 'ok' as const,
    })),
  );

  // ---- sandboxes. Owned by the tenant reader (the console joins `users` for the owner name);
  // the row is read through the super-admin console, not by its owner.
  const sbRows = await db
    .insert(sandboxes)
    .values(
      (
        [
          [SB_US_LIT_SLUG, SB_US_PROJECT],
          [SB_US_DEC_SLUG, SB_US_PROJECT],
          [SB_PCT_LIT_SLUG, SB_PCT_LIT_PROJECT],
          [SB_PCT_DEC_SLUG, SB_PCT_DEC_PROJECT],
        ] as const
      ).map(([slug, project]) => ({
        owner_id: UID,
        tenant_id: DEMO_TENANT_ID,
        slug,
        project,
        status: 'idle' as const,
        last_active_at: new Date(),
      })),
    )
    .returning();
  [sbUsLit, sbUsDec, sbPctLit, sbPctDec] = sbRows.map((r) => r.id) as [string, string, string, string];
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

// ---------------------------------------------------------------------------
// The table. One row per (surface × metacharacter): how to call it, how to read an identity out
// of the response, how to read the predicate's own count, and which pair it is about.
//
// Driving all eight cases off ONE assertion body is deliberate: the four routes had four
// separately-written copies of the same broken predicate, so a per-route hand-written test is
// four chances to assert something subtly weaker on the one route that is still broken.
// ---------------------------------------------------------------------------
interface Surface {
  name: string;
  path: string;
  /** Identity of each returned row, in the order the route returned them. */
  ids: (json: any) => string[];
  /** The route's own count over the SAME predicate as the rows — the anti-cap assertion. */
  total: (json: any) => number;
}

const SURFACES: Surface[] = [
  {
    name: 'GET /api/challenges (the challenge board)',
    path: '/api/challenges',
    ids: (j) => j.items.map((i: { id: string }) => i.id),
    total: (j) => j.total,
  },
  {
    name: 'GET /api/solutions (the solution board)',
    path: '/api/solutions',
    ids: (j) => j.items.map((i: { id: string }) => i.id),
    total: (j) => j.total,
  },
  {
    // The library keys rows by slug, not id — `items[].id` does not exist on this response.
    name: 'GET /api/blocks (the block library)',
    path: '/api/blocks',
    ids: (j) => j.items.map((i: { slug: string }) => i.slug),
    total: (j) => j.total,
  },
  {
    name: 'GET /api/datasets (the dataset list)',
    path: '/api/datasets',
    ids: (j) => j.items.map((i: { id: string }) => i.id),
    total: (j) => j.total,
  },
];

/** Per surface: [literal identity, decoy identity] for the `%` pair and for the `_` pair. */
function pairsFor(surface: string): { pct: [string, string]; us: [string, string] } {
  switch (surface) {
    case '/api/challenges':
      return { pct: [chPctLit, chPctDec], us: [chUsLit, chUsDec] };
    case '/api/solutions':
      return { pct: [solPctLit, solPctDec], us: [solUsLit, solUsDec] };
    case '/api/blocks':
      return {
        pct: [BLOCK_SLUGS[BLK_PCT_LIT], BLOCK_SLUGS[BLK_PCT_DEC]],
        us: [BLOCK_SLUGS[BLK_US_LIT], BLOCK_SLUGS[BLK_US_DEC]],
      };
    case '/api/datasets':
      return { pct: [dsPctLit, dsPctDec], us: [dsUsLit, dsUsDec] };
    default:
      throw new Error(`no fixture pair for ${surface}`);
  }
}

for (const s of SURFACES) {
  for (const [meta, query, control, which] of [
    ['%', PCT_QUERY, PCT_CONTROL, 'pct'],
    ['_', US_QUERY, US_CONTROL, 'us'],
  ] as const) {
    test(`${s.name}: a literal '${meta}' matches only the row that contains it`, async () => {
      const [literal, decoy] = pairsFor(s.path)[which];

      // ---- HALF ONE: the control. Without a metacharacter both rows are reachable, so the
      // decoy DEMONSTRABLY exists, is visible to this caller, and is matched by this predicate.
      // Every "the decoy is absent" claim below rests on this, and this is the half that a
      // broken fixture, an RLS scope or a swallowed 500 would fail.
      const ctl = await call(s.path, control);
      expect(ctl.status).toBe(200);
      expect(
        sorted(s.ids(ctl.json)),
        'CONTROL: the two fixture rows are not both reachable — every assertion below is vacuous',
      ).toEqual(sorted([literal, decoy]));
      expect(
        s.total(ctl.json),
        'the count is computed from the same predicate as the rows; 2 rows must count as 2',
      ).toBe(2);

      // ---- HALF TWO: the metacharacter. EXACTLY the literal row, asserted as an equality on
      // the WHOLE returned list — a `.find(...) === undefined` would be satisfied by the empty
      // set, and a `.toContain(literal)` would be satisfied by the broken both-rows answer.
      const hit = await call(s.path, query);
      expect(hit.status).toBe(200);
      expect(
        s.ids(hit.json),
        `THE DEFECT: '${meta}' is an ILIKE metacharacter and the predicate interpolated the raw ` +
          `query, so searching '${query}' also matched the decoy row it should not reach`,
      ).toEqual([literal]);
      expect(
        s.total(hit.json),
        'and the count agrees — so no per-page cap did the work the escape is supposed to do',
      ).toBe(1);
    });
  }
}

// ---------------------------------------------------------------------------
// The solution board's FOURTH arm. `searchOver` carries four predicates — title, author name, a
// lateral over `blocks_used`, and the translated-title EXISTS — and the raw pattern was written
// out four times. Three of them are covered by the table above; the `blocks_used` arm is a hand
// -written `sql` template rather than a drizzle `ilike`, which is the one most likely to be
// missed by a sweep and the one where "is the pattern still a bind parameter?" is a real
// question rather than a rhetorical one.
// ---------------------------------------------------------------------------
test('GET /api/solutions: the blocks_used arm escapes too, and stays a bind parameter', async () => {
  const litSlug = `${MARK.toLowerCase()}-b100%x`;
  const decSlug = `${MARK.toLowerCase()}-b100zx`;
  await db.update(solutions).set({ blocks_used: [litSlug] }).where(eq(solutions.id, solPctLit));
  await db.update(solutions).set({ blocks_used: [decSlug] }).where(eq(solutions.id, solPctDec));
  try {
    // Control first: both rows are reachable through the blocks_used arm alone.
    const ctl = await call('/api/solutions', `${MARK.toLowerCase()}-b100`);
    expect(sorted(ctl.json.items.map((i: { id: string }) => i.id))).toEqual(
      sorted([solPctLit, solPctDec]),
    );

    const hit = await call('/api/solutions', litSlug);
    expect(
      hit.json.items.map((i: { id: string }) => i.id),
      "THE DEFECT: the jsonb_array_elements_text arm interpolated `%${q}%` as well",
    ).toEqual([solPctLit]);
    expect(hit.json.total).toBe(1);
  } finally {
    await db.update(solutions).set({ blocks_used: [] }).where(inArray(solutions.id, [solPctLit, solPctDec]));
  }
});

// ---------------------------------------------------------------------------
// THE BACKSLASH PAIR — the metacharacter an escape function gets wrong in the OTHER direction.
// `\` is Postgres's DEFAULT LIKE/ILIKE escape, so a `likeTerm` that escaped `%` and `_` and left
// `\` alone would hand the pattern matcher the user's own backslash as an escape introducer: the
// pattern `%…pad\a%` would mean "…pad" then a LITERAL `a`, matching the decoy `…pada` and NOT the
// row the user actually typed. (utils/search.ts escapes all three in ONE pass, which is also why
// it cannot double-escape the backslashes it just added.) There is no `ESCAPE` clause anywhere in
// the fixed predicates and none is needed — `\` is the default and the pattern is a bind
// parameter, so `standard_conforming_strings` does not enter into it.
//
// The two answers are mirror images, which is what makes this case mutation-sensitive:
//   fixed  → [chBsLit]   (the row whose name really contains a backslash)
//   broken → [chBsDec]   (the row whose name has an `a` where the backslash should be)
// ---------------------------------------------------------------------------
test('a query containing a backslash matches the row that HAS one, not its escape-eaten neighbour', async () => {
  // The fixture must actually contain a backslash, or the whole case is about nothing. (This is
  // the assertion the previous, vacuous revision of this test had no way to make: it queried a
  // table in which no row contained a backslash at all.)
  expect(BS_LITERAL.includes('\\'), 'the literal fixture has no backslash in it').toBe(true);
  expect(BS_DECOY.includes('\\')).toBe(false);

  // ---- CONTROL: without the backslash both rows are reachable.
  const ctl = await call('/api/challenges', BS_CONTROL);
  expect(ctl.status).toBe(200);
  expect(
    sorted(ctl.json.items.map((i: { id: string }) => i.id)),
    'CONTROL: the backslash pair is not both reachable — the assertion below would be vacuous',
  ).toEqual(sorted([chBsLit, chBsDec]));
  expect(ctl.json.total).toBe(2);

  // ---- THE CASE.
  const hit = await call('/api/challenges', BS_QUERY);
  expect(hit.status, 'a backslash in the box must not 500 the board').toBe(200);
  expect(
    hit.json.items.map((i: { id: string }) => i.id),
    'THE DEFECT: `\\` is the default LIKE escape, so leaving it raw makes `\\a` mean a literal ' +
      '`a` — the search finds the NEIGHBOUR and misses the row the user typed',
  ).toEqual([chBsLit]);
  expect(hit.json.total).toBe(1);
});

// ---------------------------------------------------------------------------
// THE TRANSLATED ARM (`db/translation-search.ts`, reached from routes/challenges.ts). Every case
// above runs under `en`, and `translatedMatchSql` returns `undefined` for the default locale — so
// until this case existed, the second of the two predicates the sweep had to fix on that route
// was never in the query at all. routes/challenges.ts builds ONE `likeTerm` pattern and hands the
// SAME value to both arms, deliberately, so that the overlay cannot match strings the base column
// cannot; an unescaped pattern would have been unescaped on both.
//
// The Dutch tokens exist ONLY in `content_translations` — the base titles are `…nlbase literal` /
// `…nlbase decoy` — so the `en` half below is what proves the nl hit came through the EXISTS.
// (Same discipline as tests/search-i18n.test.ts, which is where this pairing comes from.)
// ---------------------------------------------------------------------------
test("GET /api/challenges under `nl`: a literal '%' in the TRANSLATED title matches only its row", async () => {
  // ---- CONTROL: both translations are reachable under nl…
  const ctl = await call('/api/challenges', NL_CONTROL, 'nl');
  expect(ctl.status).toBe(200);
  expect(
    sorted(ctl.json.items.map((i: { id: string }) => i.id)),
    'CONTROL: the nl overlay rows are not both reachable — is content_translations seeded?',
  ).toEqual(sorted([chNlLit, chNlDec]));
  expect(ctl.json.total).toBe(2);

  // ---- …and NOT under en, which is what proves the match came from the translated arm rather
  // than from a base column that happened to contain the term.
  const enCtl = await call('/api/challenges', NL_CONTROL, 'en');
  expect(
    enCtl.json.items,
    'the Dutch token is answerable under `en` — the base columns carry it and this case is not ' +
      'measuring translatedMatchSql at all',
  ).toEqual([]);
  expect(enCtl.json.total).toBe(0);

  // ---- THE CASE.
  const hit = await call('/api/challenges', NL_QUERY, 'nl');
  expect(hit.status).toBe(200);
  expect(
    hit.json.items.map((i: { id: string }) => i.id),
    "THE DEFECT: the translated EXISTS took the same raw `%${q}%` the base arm did, so a Dutch " +
      'reader searching a price in their own language wildcarded across the overlay too',
  ).toEqual([chNlLit]);
  expect(hit.json.total).toBe(1);
});

// ---------------------------------------------------------------------------
// THE AUDIT FEED — `routes/audit.ts`, the site the sweep's own comments name as the live symptom
// and the one no behavioural case reached before this one. `action` values are underscore-
// separated machine codes, so on this route `_` is not an edge case: `dataset_created` matched
// `dataset<any char>created` for every auditor who pasted a code back into the box.
//
// `requireSuperAdmin` is REAL here, so the role-enforcing seam from tests/audit.test.ts is
// installed for the duration and the permissive one restored in a `finally` — a case that ran
// under the file's default override would be asserting against a disarmed route.
//
// `total` on this route is `counts.all`, a SEPARATE `count(*) … GROUP BY category` over the same
// predicate, so it is an independent witness that no page cap did the escape's work.
// ---------------------------------------------------------------------------
for (const [meta, literal, decoy, control] of [
  ['_', AUD_US_LITERAL, AUD_US_DECOY, AUD_US_CONTROL],
  ['%', AUD_PCT_LITERAL, AUD_PCT_DECOY, AUD_PCT_CONTROL],
] as const) {
  test(`GET /api/audit (the audit feed): a literal '${meta}' in an action matches only its row`, async () => {
    installEnforcing(admin);
    try {
      const ctl = await callAudit(control);
      expect(ctl.status).toBe(200);
      expect(
        sorted(ctl.json.items.map((i: { action: string }) => i.action)),
        'CONTROL: the two fixture rows are not both reachable — every assertion below is vacuous',
      ).toEqual(sorted([literal, decoy]));
      expect(ctl.json.total, 'counts.all is computed from the same predicate as the rows').toBe(2);

      const hit = await callAudit(literal);
      expect(hit.status).toBe(200);
      expect(
        hit.json.items.map((i: { action: string }) => i.action),
        `THE DEFECT: '${meta}' is an ILIKE metacharacter and buildAuditFilters interpolated the ` +
          `raw query, so searching '${literal}' also matched '${decoy}'`,
      ).toEqual([literal]);
      expect(
        hit.json.total,
        'and the count agrees — so no per-page cap did the work the escape is supposed to do',
      ).toBe(1);
    } finally {
      installBase();
    }
  });
}

test('GET /api/audit still enforces its super-admin gate (the seam above is not a bypass)', async () => {
  installEnforcing(user); // employee + developer, no super_admin
  try {
    // Without this, the two cases above could be passing against a route whose guard the test
    // seam had removed — and the same permissive override is what the rest of this file runs on.
    expect((await callAudit(AUD_US_CONTROL)).status).toBe(403);
  } finally {
    installBase();
  }
});

// ---------------------------------------------------------------------------
// THE SANDBOX LIST — `routes/sandboxes.ts`, the second super-admin console the sweep touched and
// the second site no behavioural case reached. Two arms of the same OR are exercised: the `_`
// pair sits in `slug` (the route's stated symptom — slugs are hyphen/underscore-shaped) and the
// `%` pair in `project`. `total` here is `counts.all`, again a separate aggregate.
// ---------------------------------------------------------------------------
for (const [meta, arm, query, control, pair] of [
  ['_', 'slug', SB_US_LIT_SLUG, SB_US_CONTROL, 'us'],
  ['%', 'project', SB_PCT_QUERY, SB_PCT_CONTROL, 'pct'],
] as const) {
  test(`GET /api/sandboxes (the sandbox console): a literal '${meta}' in ${arm} matches only its row`, async () => {
    const [literal, decoy] = pair === 'us' ? [sbUsLit, sbUsDec] : [sbPctLit, sbPctDec];
    installEnforcing(admin);
    try {
      const ctl = await callSandboxes(control);
      expect(ctl.status).toBe(200);
      expect(
        sorted(ctl.json.items.map((i: { id: string }) => i.id)),
        'CONTROL: the two fixture sandboxes are not both reachable — the assertion below is vacuous',
      ).toEqual(sorted([literal, decoy]));
      expect(ctl.json.total).toBe(2);

      const hit = await callSandboxes(query);
      expect(hit.status).toBe(200);
      expect(
        hit.json.items.map((i: { id: string }) => i.id),
        `THE DEFECT: '${meta}' is an ILIKE metacharacter and listSandboxes interpolated the raw ` +
          `query, so searching '${query}' also matched the neighbouring ${arm}`,
      ).toEqual([literal]);
      expect(hit.json.total).toBe(1);
    } finally {
      installBase();
    }
  });
}

test('GET /api/sandboxes still enforces its super-admin gate', async () => {
  installEnforcing(user);
  try {
    expect((await callSandboxes(SB_US_CONTROL)).status).toBe(403);
  } finally {
    installBase();
  }
});

// ---------------------------------------------------------------------------
// THE AGENT-FACING CATALOGUE — `ai/block-catalog-service.ts`, reached through the MCP tool
// `search_blocks` (src/ai/mcp/tools.ts:190), which is the third and last site the sweep touched
// without behavioural cover.
//
// ⛔ WHY THIS ONE MATTERS AT LEAST AS MUCH AS THE HUMAN BOARDS. Its `query` is a TOOL ARGUMENT
// written by a model, not a string a person typed into a box — so it is the input most likely to
// arrive carrying a `%` or `_` verbatim out of a block name the model just read back to itself,
// and its failure is silent: the agent gets extra rows, believes the catalogue said so, and picks
// one. There is no screen for anybody to notice the wrong result on.
//
// Driven through `McpHost.callTool` rather than by importing `searchBlocks` directly — the tool's
// zod parse and the host's audit write are part of the path, and a direct import would prove the
// function works while leaving open whether the tool reaches it. (The harness is the one in
// tests/mcp-server.test.ts.)
//
// ⚠️ THE CAP QUESTION IS ANSWERED DIFFERENTLY HERE. `searchBlocks` returns `{ items }` with NO
// count, so there is no independent total to assert; instead the tool is called with an explicit
// `limit` well above the fixture size, which removes the truncation the assertion would otherwise
// be unable to distinguish from a working escape.
// ---------------------------------------------------------------------------
for (const [meta, query, control, litSlug, decSlug] of [
  ['%', PCT_QUERY, PCT_CONTROL, BLOCK_SLUGS[BLK_PCT_LIT], BLOCK_SLUGS[BLK_PCT_DEC]],
  ['_', US_QUERY, US_CONTROL, BLOCK_SLUGS[BLK_US_LIT], BLOCK_SLUGS[BLK_US_DEC]],
] as const) {
  test(`MCP search_blocks: a literal '${meta}' matches only the block that contains it`, async () => {
    const slugs = async (q: string) => {
      const out = await mcpHost.callTool('search_blocks', { query: q, limit: 50 }, mcpCtx);
      expect(out.isError, `search_blocks errored: ${JSON.stringify(out.result)}`).toBe(false);
      return (out.result as { items: { slug: string }[] }).items.map((b) => b.slug);
    };

    expect(
      sorted(await slugs(control)),
      'CONTROL: the two fixture blocks are not both reachable through the tool',
    ).toEqual(sorted([litSlug, decSlug]));

    expect(
      await slugs(query),
      `THE DEFECT: the agent-facing catalogue interpolated the raw tool argument into ` +
        `\`%\${query}%\`, so a '${meta}' in a block name the model read back handed the agent a ` +
        `row the catalogue was never asked for`,
    ).toEqual([litSlug]);
  });
}
