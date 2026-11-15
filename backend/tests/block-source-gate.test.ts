// tests/block-source-gate.test.ts — the block-source safety scan as an ENFORCED gate.
//
// ⛔ WHY THIS FILE EXISTS AND WHY `blocks.test.ts` DID NOT CATCH THE DEFECT.
// `blocks.test.ts` tests `scanBlockSource` as a PURE FUNCTION. Every one of those assertions passes
// with the function having ZERO call sites — which is very nearly what it had: only
// `publishVersionCore` and `deriveDataBlock` ever called it, while `createBlockCore`,
// `addVersionCore`, `saveVersionCore` and both DRAFT-RUN paths wrote / executed `source_ts` with no
// check at all. Meanwhile `policy_desc_models_code_exec_outside_blocks` told a compliance reader
// that "arbitrary code/eval is banned at save time and refused at run time".
//
// So the tests here assert THROUGH THE REAL ROUTE, and each negative asserts THREE things:
//   1. the status + error code the caller sees,
//   2. THE RESIDUE — that the row's `source_ts` is byte-unchanged in the DB. A gate that 422s
//      *after* writing is still a bypass, and a status-code-only assertion cannot tell them apart,
//   3. the VACUITY GUARD — that the CLEAN version of the same source through the SAME route DOES
//      save. Without it a 404 (wrong path, renamed route, missing fixture) passes the negative.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import { registerTemplateRoutes } from '../src/routes/templates';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setSnapshotOverrideForTests, getSnapshot } from '../src/host/policy-store';
import { mcpHost } from '../src/ai/mcp-server';
import type { McpAuthContext } from '../src/ai/mcp-server';
import { PLATFORM_TOOLS } from '../src/ai/mcp/tools';
import { scanBlockSource, maskNonCode } from '../src/exec/static-scan';
import { compileDataBlock } from '../src/ontology/data-block-compiler';
import { renderSource } from '../src/db/seed-templates';
import { requireScannedSource, assertBlockSourceSafe } from '../src/blocks/source-gate';
import type { ScannedSource } from '../src/blocks/scanned-source';
import { db, buildingBlocks, blockVersions, blockTests, tenants, users } from '../src/db/client';
import { seed } from '../src/db/seed';
import type { User } from '../src/types';
import type { GovernanceSnapshot } from '../src/host/policy-store';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TAIL = 'export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ return {}; } };';
/** Lint-clean, and the CONTROL for every negative below: same shape, one line different. */
const CLEAN_SRC = `// a perfectly ordinary block\n${TAIL}`;
/** Rejected by the scan: the ambient network global instead of the ctx capability. */
const BANNED_SRC = `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ await fetch("https://x.invalid"); return {}; } };`;

/** A token unique to the banned fixture, so a residue query cannot match anything else. */
const BANNED_MARKER = 'https://x.invalid';
/** …and its control, for proving the residue query can SEE a write. */
const CLEAN_MARKER = 'wsb-clean-probe-marker';

const SLUG_PREFIX = 'wsb-gate-blk';
const SLUG = 'wsb-gate-blk';
const SLUG2 = 'wsb-gate-blk2';
const TENANT = '0000000b-1b00-0000-0000-00000000t001'.replace('t', 'a');
const DEV = '0000000b-1b00-0000-0000-0000000000d1';

// ⛔ `tenantId` IS NOT DECORATION — WITHOUT IT THE TEMPLATE PROBES PROVE NOTHING.
// `POST /api/templates` goes through `requireDeveloper` → `resolveTenantScope`, which for a
// super_admin with no own-tenant claim and no `X-Active-Tenant-Id` header throws
// `403 tenant_id_claim_required` BEFORE the body is parsed. Every one of the four probe body shapes
// therefore got the same 403, the banned source never reached `createTemplate`, and the residue
// query found nothing because nothing was ever attempted. The block routes are unaffected:
// `requireBlockAuthor` returns scope 'global' for a super_admin without `?scope=tenant`, so it never
// reads this field.
const devUser: User = { id: DEV, email: 'wsb-dev@test', name: 'WSB Dev', roles: ['super_admin', 'developer', 'employee'], tenantId: TENANT };

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
// ⛔ `POST /api/templates` IS A `source_ts` WRITER AND IT DOES NOT GO THROUGH THE `*Core` FUNCTIONS
// — it reaches `templates-service.createTemplate` directly, as does the `create_template` MCP tool.
// Registering it here is what puts it inside the DERIVED route set below instead of outside it.
registerTemplateRoutes(router);

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The stored source, read straight from the row — the RESIDUE assertion's only honest source. */
async function storedSource(slug: string, version: string): Promise<string | null> {
  const [row] = await db
    .select({ src: blockVersions.source_ts })
    .from(blockVersions)
    .innerJoin(buildingBlocks, eq(buildingBlocks.id, blockVersions.block_id))
    .where(sql`${buildingBlocks.slug} = ${slug} and ${blockVersions.version} = ${version}`);
  return row?.src ?? null;
}

/**
 * Plant a banned source in an EXISTING row, bypassing the gate with raw SQL.
 *
 * ⛔ THE ONLY WAY TO BUILD THE FIXTURE THE RUN-PATH TESTS NEED, and it is not a cheat — it is
 * exactly the state this branch inherits. Every row written before this change went in was written
 * with no scan, so "a draft whose stored source is banned" is a REAL production state that the run
 * paths must refuse. It cannot be produced through the API any more (that is the point of the save
 * gate), so it is produced the way history produced it: a write that never saw the gate.
 */
async function plantSource(slug: string, version: string, source: string): Promise<void> {
  await db.execute(sql`
    update block_versions set source_ts = ${source}
    where version = ${version}
      and block_id = (select id from building_blocks where slug = ${slug} limit 1)
  `);
}

/**
 * Remove everything this file creates, matched by PREFIX rather than by an explicit slug list.
 *
 * ⚠️ It has to be a prefix: the derived route-probe test does not know in advance which slugs the
 * routes it fires at will create (that is the point of deriving them), and a leftover block holds a
 * `maintainer_id` FK onto this file's test user — so an exact-list cleanup left rows behind and
 * `afterAll`'s user delete died on `building_blocks_maintainer_id_fkey`, as an UNNAMED hook failure
 * that named neither the table nor the test.
 */
async function cleanup() {
  const rows = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(sql`${buildingBlocks.slug} like ${`${SLUG_PREFIX}%`}`);
  for (const r of rows) {
    await db.update(buildingBlocks).set({ current_version_id: null }).where(eq(buildingBlocks.id, r.id));
    await db.delete(blockTests).where(eq(blockTests.block_id, r.id));
    await db.delete(blockVersions).where(eq(blockVersions.block_id, r.id));
  }
  await db.delete(buildingBlocks).where(sql`${buildingBlocks.slug} like ${`${SLUG_PREFIX}%`}`);
  await db.execute(sql`delete from block_templates where name like ${`${SLUG_PREFIX}%`}`);
}

/** Create a block through the route and return its 0.1.0 draft, for tests that need a target row. */
async function makeBlock(slug: string, source = CLEAN_SRC) {
  const res = await call('POST', '/api/blocks', {
    slug, name: slug, category: 'logic', source_ts: source,
    descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  });
  expect(res.status).toBe(201);
  return res;
}

beforeAll(async () => {
  await seed();
  await cleanup();
  await db.delete(users).where(inArray(users.id, [DEV]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
  await db.insert(tenants).values({ id: TENANT, name: 'WSB Tenant', slug: 'wsb-tenant' }).onConflictDoNothing();
  await db.insert(users).values({ id: DEV, email: 'wsb-dev@test', name: 'WSB Dev', tenant_id: TENANT }).onConflictDoNothing();
  asUser(devUser);
}, 60_000);

afterAll(async () => {
  await cleanup();
  await db.delete(users).where(inArray(users.id, [DEV]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
  __setAuthOverridesForTests(undefined);
  __setSnapshotOverrideForTests(undefined);
}, 60_000);

// Explicit hook timeout — bun 1.3.14 ignores bunfig's [test] timeout for HOOKS, so a slow one
// fails as an unnamed "(unnamed) [5003ms]" naming neither the file nor the cause. This hook does
// DB work (cleanup()), so it needs the argument. See tests/license-provisioning.test.ts.
afterEach(async () => {
  __setSnapshotOverrideForTests(undefined);
  asUser(devUser);
  await cleanup();
}, 30_000);

// ===========================================================================
// 1. THE SCANNER MUST BE ACCURATE BEFORE IT MAY BE A GATE
// ===========================================================================
//
// Turning the pre-existing raw-regex scan into a hard gate would have been an outage class, and not
// only for hand-written blocks: TWO code paths in this product GENERATE block source by
// interpolating user-controlled English into it (§1d). `static-scan.ts` therefore masks comment /
// string / template / regex INTERIORS using TypeScript's own parser before any rule runs.
//
// ⛔ THE THREE THINGS THIS SECTION EXISTS TO STOP, in descending order of danger:
//   1. a mask that swallows REAL CODE (false negative — banned code runs). §1c.
//   2. a mask that is trusted after a failed parse (same thing, silently). §1c.
//   3. prose flagged as code (false positive — an author or a tenant is locked out). §1a, §1d.

/** Sources that must be CLEAN. Each one was, or would have been, a false positive. */
const MUST_PASS: [string, string][] = [
  ['a comment mentioning fetch(', `// we deliberately do not use fetch( here\n${TAIL}`],
  ['a trailing comment mentioning fetch( at EOF', `${TAIL} /* fetch( */`],
  ['a string mentioning eval()', `const msg = "call eval() at your peril";\n${TAIL}`],
  ['a docstring mentioning import()', `/** use import() never */\n${TAIL}`],
  ['a string containing "eval("', `const s = "eval(";\n${TAIL}`],
  ['a string containing "process.env"', `const s = "process.env";\n${TAIL}`],
  ['a comment mentioning a banned import', `// import fs from "node:fs" would be banned\n${TAIL}`],
  ['a comment mentioning process.env', `// never read process.env here\n${TAIL}`],
  ['a template literal mentioning eval(', 'const t = `see eval( in the docs`;\n' + TAIL],
  ['a JSON string mentioning import (the compileDataBlock shape)', `const d = {"description":"Set on import from the broker feed."};\n${TAIL}`],
  ['a JSON string mentioning fetch() (the compileDataBlock shape)', `const d = {"description":"Populated by the nightly fetch() job."};\n${TAIL}`],
  // ⛔ NOT "the capability the rule tells you to use" — THERE IS NO `ctx.fetch`. `BlockContext`
  // declares llm/mockData/dataset/log/signal and the runner injects loadBlock/llm/mockData/dataset/
  // emit/now; `capabilities.network` is read only by host/run-policy.ts, to REFUSE a run. This case
  // is here because a MEMBER call named `fetch` must not be mistaken for the ambient global — which
  // is exactly what `\bfetch\s*\(` did, on the rule whose message named ctx.fetch.
  ['a member call named fetch (`ctx.fetch(`), which is not the ambient global', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(i,ctx){ const r = await ctx.fetch("https://x"); return { s: r.status }; } };`],
  ['an identifier that merely contains fetch', `function prefetch(){return 1}\nexport default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ return {n:prefetch()}; } };`],
  ['an apostrophe inside a regex literal', `const re = /don't/;\n${TAIL}`],
  ['a clean SDK block', `import type { Block } from "./sdk";\nconst b: Block = { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ return {}; } };\nexport default b;`],
];

const MUST_FAIL: [string, string, string][] = [
  ['bare fetch(', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ await fetch("x"); return {}; } };`, 'no-fetch'],
  ['globalThis.fetch(', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ await globalThis.fetch("x"); return {}; } };`, 'no-fetch'],
  ['bare eval(', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ eval("1"); return {}; } };`, 'no-eval'],
  ['globalThis.eval(', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ globalThis.eval("1"); return {}; } };`, 'no-eval'],
  ['globalThis.XMLHttpRequest', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ const x = new globalThis.XMLHttpRequest(); return {}; } };`, 'no-xhr'],
  ['a banned node builtin import', `import { execSync } from "node:child_process";\n${TAIL}`, 'banned-import'],
  ['require()', `const fs = require("node:fs");\n${TAIL}`, 'no-require'],
  ['dynamic import()', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ await import("y"); return {}; } };`, 'no-dynamic-import'],
  ['process.env', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ return { k: process.env.SECRET }; } };`, 'no-process'],
  ['new WebSocket', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ const w = new WebSocket("x"); return {}; } };`, 'no-websocket'],
  ['Bun.connect', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ Bun.connect({}); return {}; } };`, 'no-bun-socket'],
  ['a non-allowlisted import', `import x from "lodash";\n${TAIL}`, 'import-not-allowlisted'],
  // ---- §1b THE THREE BYPASSES. Each reaches eval-equivalent power without the token the old rules
  // looked for. They were tolerable while the scan was ADVISORY; they are not once
  // `models.code_exec_outside_blocks` is classified `enforced`. Each measures 0/44 on the shipped
  // corpus, so none of them costs a real block anything today.
  ['new Function(…) — eval under another name', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ const f = new Function("return 1"); return { n: f() }; } };`, 'no-function-constructor'],
  ['indirect eval `(0, eval)(…)`', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ (0, eval)("1"); return {}; } };`, 'no-eval'],
  ['computed global access — the token `eval` never appears', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ globalThis["ev"+"al"]("1"); return {}; } };`, 'no-computed-global'],
  ['optional computed global access', `export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ return { n: globalThis?.["process"] }; } };`, 'no-computed-global'],
];

test('§1a the scan does not fire on comments, string/template literals, or member calls', () => {
  const wrong = MUST_PASS.filter(([, src]) => !scanBlockSource(src).ok)
    .map(([name, src]) => `${name}: ${scanBlockSource(src).findings.map((f) => f.rule).join(',')}`);
  expect(wrong).toEqual([]);
  expect(MUST_PASS.length).toBeGreaterThanOrEqual(15);
});

test('§1b the scan still catches every real violation, including the three bypasses', () => {
  for (const [name, src, rule] of MUST_FAIL) {
    const r = scanBlockSource(src);
    expect(`${name}: ok=${r.ok}`).toBe(`${name}: ok=false`);
    expect(`${name}: ${r.findings.map((f) => f.rule).join(',')}`).toContain(rule);
  }
  // Non-vacuity for the bypass half specifically: three rule ids that did not exist before the gate.
  const byRule = new Set(MUST_FAIL.map(([, , r]) => r));
  expect(byRule.has('no-function-constructor') && byRule.has('no-computed-global')).toBe(true);
});

// ---------------------------------------------------------------------------
// §1c THE MASK MUST NOT SWALLOW REAL CODE — the seven measured false negatives.
// ---------------------------------------------------------------------------
//
// ⛔ EVERY STRING BELOW WAS SILENTLY CLEAN under the hand-rolled state machine that a previous
// attempt shipped, and each one is a DIFFERENT mechanism, not seven spellings of one:
//   1-2  an apostrophe inside a regex literal opens a "string" that closes on a later quote
//   3    a backtick inside a regex literal opens a "template"
//   4    a `/*` inside a regex character class opens a "block comment"
//   5    a `"` inside a regex literal, same as 1-2 with the other quote
//   6    the same, swallowing an `import` rather than a call
//   7    `isDefinitionSite` — an INDEPENDENT mechanism: a call followed by a bare block `{` reads
//        as a parameter list, so the branch skipped it. It is not carried; this pins that.
// The machine reported `reliable: true` for all of them, so its own raw-source fallback never fired.
// That is why the mask is now `ts.createSourceFile`, and why these are pinned by string.
const MUST_NOT_BE_SWALLOWED: [string, string, string][] = [
  ['apostrophes in a regex literal + a later quote', String.raw`const APOS = /(\w)'(\w)/g; const leak = eval("2+2"); const DASH = '-';`, 'no-eval'],
  ['an apostrophe in a regex literal before a require', String.raw`const R = /it's/g; const fs = require('node:fs');`, 'no-require'],
  ['a backtick inside a regex literal', 'const A = /`/; eval("boom"); const B = /`/;', 'no-eval'],
  ['a /* inside a regex character class', 'const RE = /[/*]/; eval("boom"); const B = 2; /* end */', 'no-eval'],
  ['a double quote inside a regex literal', String.raw`const Q = /"/; const fs = require("node:fs"); const B = /"/;`, 'no-require'],
  ['a regex apostrophe swallowing a following import', String.raw`const A = /o'clock/; import net from 'node:net';`, 'banned-import'],
  ['a call followed by a bare block (the isDefinitionSite miss)', 'export default { async run(){ if (ok) eval(payload)\n{ log(); }\n} };', 'no-eval'],
  ['a template EXPRESSION is code, not template text', "const s = `${eval('x')}`;\n" + TAIL, 'no-eval'],
];

test('§1c the mask never swallows real code — the seven measured false negatives', () => {
  const missed = MUST_NOT_BE_SWALLOWED
    .filter(([, src, rule]) => !scanBlockSource(src).findings.some((f) => f.rule === rule))
    .map(([name]) => name);
  expect(missed).toEqual([]);
  expect(MUST_NOT_BE_SWALLOWED.length).toBeGreaterThanOrEqual(8);
});

test('§1c a trailing comment and an EOF comment are masked too', () => {
  // ⛔ TWO SEPARATE TypeScript FACTS, EACH MEASURED AS A LIVE FALSE POSITIVE.
  //   * a comment on the SAME LINE as preceding code is a TRAILING comment, so
  //     `getLeadingCommentRanges` returns undefined for it;
  //   * `ts.forEachChild(sourceFile, …)` does not visit `endOfFileToken`, so a comment after the
  //     last statement belongs to a node the walk never reaches.
  // `const x = 1; /* fetch( */` is both at once, and was flagged `no-fetch`.
  expect(scanBlockSource('const x = 1; /* fetch( */').ok).toBe(true);
  expect(scanBlockSource('const x = 1; // fetch(').ok).toBe(true);
  expect(scanBlockSource(`${TAIL}\n// trailing eval( note\n`).ok).toBe(true);
  // …and the vacuity control: the same token OUTSIDE a comment still flags, so the three
  // assertions above cannot be passing because the scanner stopped working.
  expect(scanBlockSource('const x = 1; fetch("u");').ok).toBe(false);
});

test('§1c an UNPARSEABLE source falls back to the RAW text — fail safe, not fail open', () => {
  // ⛔ THE DIRECTION MATTERS. A mask built from a failed parse has guessed node positions, and a
  // wrong guess BLANKS REAL CODE. So a parse that throws or reports diagnostics discards the mask
  // and the rules run on raw text: over-reporting, which an author can see and argue with.
  const broken = 'export default { async run( {{{ ;  // fetch(\nawait fetch("x");';
  const m = maskNonCode(broken);
  expect(m.reliable).toBe(false);
  expect(m.masked).toBe(broken); // the unreliable projection IS the raw source
  const r = scanBlockSource(broken);
  expect(r.findings.map((f) => f.rule)).toContain('syntax');
  expect(r.findings.map((f) => f.rule)).toContain('no-fetch');
  // Vacuity: a source that DOES parse gets a real mask, or the assertion above proves nothing.
  expect(maskNonCode(`// fetch(\n${TAIL}`).reliable).toBe(true);
});

test('§1c masking is length-preserving and newline-preserving, and ${} returns to code', () => {
  const src = 'const a = "xx"; // yy\nconst b = `p${ eval("1") }q`;\n';
  const { masked, reliable } = maskNonCode(src);
  expect(reliable).toBe(true);
  // Byte-for-byte length equality is what makes every reported line number trustworthy.
  expect(masked.length).toBe(src.length);
  expect(masked.split('\n').length).toBe(src.split('\n').length);
  expect(masked).not.toContain('xx');
  expect(masked).not.toContain('yy');
  // …but the interpolation is REAL CODE and must survive the mask.
  expect(masked).toContain('eval(');
  expect(scanBlockSource(src).findings.some((f) => f.rule === 'no-eval')).toBe(true);
});

test('§1c a violation AFTER a decoy comment is reported on the RIGHT line', () => {
  const r = scanBlockSource(`// eval( is bad, never do it\nexport default { async run(){ eval("1"); return {}; } };`);
  expect(r.ok).toBe(false);
  expect(r.findings.filter((f) => f.rule === 'no-eval')).toHaveLength(1);
  expect(r.findings.find((f) => f.rule === 'no-eval')?.line).toBe(2);
});

test('§1c a module specifier is reported from the RAW source even though the rules read the mask', () => {
  const r = scanBlockSource('import net from "node:net";\nexport default {};');
  const f = r.findings.find((x) => x.rule === 'banned-import');
  // The masked projection has eight blanks between the quotes; `spec` must still be the real text.
  expect(f?.spec).toBe('node:net');
  expect(f?.line).toBe(1);
});

// ---------------------------------------------------------------------------
// §1d THE GENERATORS — a unit test on the pure function does not prove the generator path
// ---------------------------------------------------------------------------
//
// ⛔ THIS IS A LIVE DEFECT ON MAIN, NOT A HYPOTHETICAL ONE THIS BRANCH INTRODUCES.
// `deriveDataBlock` already calls `lintBlock` and throws `derived_lint_failed`, so a tenant whose
// ontology attribute description contains the word "import" — or "fetch()" or "eval()" — could not
// derive a data block at all. Widening the scan to `createTemplate` and to every draft save and run
// would have spread the same failure across a dozen more call sites.
//
// Driven through the REAL generators. A fixture that merely LOOKS like generated source proves the
// regex, not the path; the defect is that these functions interpolate user text into code.

test('§1d compileDataBlock: user prose in an attribute description is not code', () => {
  const compile = (description: string | null, columnMap: Record<string, string> = {}) =>
    compileDataBlock({
      entity: {
        key: 'global:x:y:invoice', name: 'invoice', label: 'Invoice', description: null,
        attributes: [{ name: 'amount', type: 'number', pii: false, description }],
      },
      datasetSlug: 'wsb-ds',
      columnMap,
    }).source_ts;

  const flagged: string[] = [];
  for (const d of [
    'Set on import from the broker feed.',
    'Populated by the nightly fetch() job.',
    'Do not eval() this value.',
    'Use require() elsewhere, never here.',
  ]) {
    const r = scanBlockSource(compile(d));
    if (!r.ok) flagged.push(`${d} -> ${r.findings.map((f) => f.rule).join(',')}`);
  }
  expect(flagged).toEqual([]);
  // A user-controlled COLUMN NAME reaches the source the same way.
  expect(scanBlockSource(compile(null, { 'import "x"': 'amount' })).ok).toBe(true);

  // ⛔ VACUITY: the generator must really be producing scannable source, or every assertion above
  // passes on an empty string. A clean description compiles to something the scanner accepts and
  // that is long enough to be a block.
  expect(compile('An ordinary description.').length).toBeGreaterThan(200);
  expect(scanBlockSource(compile('An ordinary description.')).ok).toBe(true);
});

test('§1d renderSource: user prose in a template step detail is not code', () => {
  const render = (detail: string) =>
    renderSource({
      name: 'wsb-tpl', label: 'T', category: 'logic',
      descriptor: { inputs: { a: { type: 'string' } }, outputs: { b: { type: 'string' } }, capabilities: {} },
      steps: [{ label: 'Step', detail }],
    } as never);

  const flagged: string[] = [];
  for (const d of ['Call the nightly fetch() job here.', 'Never eval() untrusted input.', 'Do not import "node:fs" in a block.']) {
    const r = scanBlockSource(render(d));
    if (!r.ok) flagged.push(`${d} -> ${r.findings.map((f) => f.rule).join(',')}`);
  }
  expect(flagged).toEqual([]);
  expect(render('An ordinary step.').length).toBeGreaterThan(100);
  expect(scanBlockSource(render('An ordinary step.')).ok).toBe(true);
});

// ===========================================================================
// 2. EVERY SEEDED / SHIPPED SOURCE MUST SURVIVE THE GATE
// ===========================================================================
//
// The seeders write `published`/`stable` versions that no lint had ever seen. Retro-linting them at
// RUNTIME would break tenants; the honest place to catch a bad shipped example is here.

test('every block source the product ships passes the scan', async () => {
  const rows = await db
    .select({ id: blockVersions.id, version: blockVersions.version, src: blockVersions.source_ts })
    .from(blockVersions);
  expect(rows.length).toBeGreaterThan(10); // vacuity: a seeded DB, not an empty table
  const failures = rows
    .map((r) => ({ r, scan: scanBlockSource(r.src) }))
    .filter((x) => !x.scan.ok)
    .map((x) => `${x.r.version}/${x.r.id}: ${x.scan.findings.map((f) => `${f.rule}@${f.line}`).join(',')}`);
  expect(failures).toEqual([]);
});

test('every template source the product ships passes the scan', async () => {
  const rows = await db.execute<{ name: string; source_ts: string }>(
    sql`select name, source_ts from block_templates`,
  );
  const list = rows as unknown as { name: string; source_ts: string }[];
  expect(list.length).toBeGreaterThan(0);
  const failures = list
    .filter((t) => !scanBlockSource(t.source_ts ?? '').ok)
    .map((t) => `${t.name}: ${scanBlockSource(t.source_ts).findings.map((f) => f.rule).join(',')}`);
  expect(failures).toEqual([]);
});

// ===========================================================================
// 3. THE WRITE PATHS — status, RESIDUE, and a vacuity control for each
// ===========================================================================

test('POST /api/blocks refuses a banned source AND creates no row (clean source does create)', async () => {
  const bad = await call('POST', '/api/blocks', {
    slug: SLUG, name: SLUG, category: 'logic', source_ts: BANNED_SRC,
    descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  });
  expect(bad.status).toBe(422);
  expect(bad.json.error).toBe('lint_failed');
  expect(bad.json.findings.map((f: any) => f.rule)).toContain('no-fetch');
  expect(bad.json.findings.every((f: any) => f.source === 'scan')).toBe(true);

  // RESIDUE: not "the response was 422" — "the block does not exist".
  const rows = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
  expect(rows).toEqual([]);

  // VACUITY: the same route, the same shape, one line different — must succeed.
  await makeBlock(SLUG, CLEAN_SRC);
  expect(await storedSource(SLUG, '0.1.0')).toBe(CLEAN_SRC);
});

test('PATCH a draft refuses a banned source AND leaves source_ts byte-unchanged', async () => {
  await makeBlock(SLUG, CLEAN_SRC);

  const bad = await call('PATCH', `/api/blocks/${SLUG}/versions/0.1.0`, { source_ts: BANNED_SRC });
  expect(bad.status).toBe(422);
  expect(bad.json.error).toBe('lint_failed');

  // RESIDUE — the whole point. A gate that 422s AFTER the UPDATE is still a bypass, and only this
  // assertion can tell the two apart.
  expect(await storedSource(SLUG, '0.1.0')).toBe(CLEAN_SRC);

  // VACUITY: a clean edit through the same route does land.
  const good = await call('PATCH', `/api/blocks/${SLUG}/versions/0.1.0`, { source_ts: `${CLEAN_SRC}\n// edited` });
  expect(good.status).toBe(200);
  expect(await storedSource(SLUG, '0.1.0')).toBe(`${CLEAN_SRC}\n// edited`);
});

test('POST a new version refuses a banned source AND creates no version row', async () => {
  await makeBlock(SLUG, CLEAN_SRC);

  const bad = await call('POST', `/api/blocks/${SLUG}/versions`, { version: '0.2.0', source_ts: BANNED_SRC });
  expect(bad.status).toBe(422);
  expect(bad.json.error).toBe('lint_failed');
  expect(await storedSource(SLUG, '0.2.0')).toBeNull();

  const good = await call('POST', `/api/blocks/${SLUG}/versions`, { version: '0.2.0', source_ts: CLEAN_SRC });
  expect(good.status).toBe(201);
  expect(await storedSource(SLUG, '0.2.0')).toBe(CLEAN_SRC);
});

// ===========================================================================
// 4. THE RUN PATHS — "…and refused at run time" is half the claim
// ===========================================================================

test('simulate refuses a DRAFT whose stored source is banned (clean draft simulates)', async () => {
  await makeBlock(SLUG, CLEAN_SRC);

  // Vacuity FIRST: prove the route reaches the runner at all on this fixture, so the negative
  // below cannot be passing because of a 404 / a broken fixture.
  const okRun = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/simulate`, { inputs: {} });
  expect(okRun.status).toBe(200);

  await plantSource(SLUG, '0.1.0', BANNED_SRC);
  const bad = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/simulate`, { inputs: {} });
  expect(bad.status).toBe(422);
  expect(bad.json.error).toBe('lint_failed');
  expect(bad.json.findings.map((f: any) => f.rule)).toContain('no-fetch');
}, 60_000);

test('run-tests refuses a DRAFT whose stored source is banned', async () => {
  await makeBlock(SLUG, CLEAN_SRC);
  const t = await call('POST', `/api/blocks/${SLUG}/tests`, { name: 'noop', inputs: {} });
  expect(t.status).toBe(201);

  const okRun = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/test`, {});
  expect(okRun.status).toBe(200);

  await plantSource(SLUG, '0.1.0', BANNED_SRC);
  const bad = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/test`, {});
  expect(bad.status).toBe(422);
  expect(bad.json.error).toBe('lint_failed');
}, 60_000);

test('a PUBLISHED version with a legacy banned source is NOT retro-linted at run time', async () => {
  // ⛔ THE DELIBERATE ASYMMETRY, PINNED. A published version is frozen and may predate the gate
  // (seeded, derived, or published before it existed). Refusing to RUN it would break a tenant's
  // live block to make a governance string true — a strictly worse trade than the string. If a
  // future change makes the run path retro-lint published rows, this test goes red on purpose.
  await makeBlock(SLUG, CLEAN_SRC);
  const pub = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/publish`, { status: 'beta' });
  expect(pub.status).toBe(200);

  await plantSource(SLUG, '0.1.0', BANNED_SRC);
  const res = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/simulate`, { inputs: {} });
  expect(res.status).not.toBe(422);
  expect(res.status).toBe(200);
}, 60_000);

// ===========================================================================
// 5. POLARITY — both settings of the policy that governs this
// ===========================================================================

async function snapshotWith(codeExecOutsideBlocks: boolean): Promise<GovernanceSnapshot> {
  __setSnapshotOverrideForTests(undefined);
  const live = await getSnapshot();
  return { ...live, codeExecOutsideBlocks };
}

test('models.code_exec_outside_blocks=false ENFORCES; =true lets the same source through', async () => {
  // The seeded value is false (= not allowed), so enforcement is active by default.
  __setSnapshotOverrideForTests(undefined);
  expect((await getSnapshot()).codeExecOutsideBlocks).toBe(false);

  __setSnapshotOverrideForTests(await snapshotWith(false));
  const refused = await call('POST', '/api/blocks', {
    slug: SLUG, name: SLUG, category: 'logic', source_ts: BANNED_SRC,
    descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  });
  expect(refused.status).toBe(422);
  expect(refused.json.error).toBe('lint_failed');

  // Flipped ON, the operator has declared arbitrary code may run — the gate must NOT refuse, or it
  // would be enforcing a policy that is switched off.
  __setSnapshotOverrideForTests(await snapshotWith(true));
  const allowed = await call('POST', '/api/blocks', {
    slug: SLUG2, name: SLUG2, category: 'logic', source_ts: BANNED_SRC,
    descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  });
  expect(allowed.status).toBe(201);
  expect(await storedSource(SLUG2, '0.1.0')).toBe(BANNED_SRC);
});

test('a clean source needs NO governance read at all (the hot path stays query-free)', async () => {
  // Ordering matters for latency: the snapshot is only consulted once the scan has already found
  // something. Pinning it here stops a future refactor from putting a DB round trip on every save.
  let reads = 0;
  const real = await snapshotWith(false);
  __setSnapshotOverrideForTests(new Proxy(real, {
    get(t, k, r) {
      if (k === 'codeExecOutsideBlocks') reads++;
      return Reflect.get(t, k, r);
    },
  }) as GovernanceSnapshot);

  await assertBlockSourceSafe(CLEAN_SRC);
  expect(reads).toBe(0);

  await expect(assertBlockSourceSafe(BANNED_SRC)).rejects.toThrow();
  expect(reads).toBe(1);
});

test('the unconditional gate ignores the policy — a seed cannot be waved through', () => {
  // `requireScannedSource` is what the four seeders and deriveDataBlock use. It must not be
  // governable: an operator switching a runtime policy is not a licence to ship a bad example.
  expect(() => requireScannedSource(CLEAN_SRC)).not.toThrow();
  expect(() => requireScannedSource(BANNED_SRC)).toThrow();
});

// ===========================================================================
// 6. DERIVED COVERAGE — no hand-listed entrypoints
// ===========================================================================
//
// ⛔ A HAND-LIST IS HOW THIS SHIPPED. Three write cores were added across three phases and the lint
// was only ever wired into a fourth. Both tests below DERIVE the surface from the registry that
// actually decides what is reachable, so a NEW writer added without the gate fails the suite
// instead of being noticed later.

test('no block-write ROUTE persists a banned source (derived from the router table)', async () => {
  // ⛔ THE ASSERTION IS THE RESIDUE, NOT THE STATUS CODE. A first version of this test flagged any
  // 2xx and went red on `POST …/versions/:version/test`, which simply IGNORES an unknown `source_ts`
  // in its body and runs the suite — a 200 there means nothing was written. Status codes cannot
  // distinguish "wrote the banned source" from "ignored it"; the stored bytes can.
  //
  // ⛔ AND THE VACUITY GUARD AT THE BOTTOM IS NOT DECORATION — IT CAUGHT THIS TEST BEING VACUOUS.
  // The first working version fired ONE superset body at every route. Every write schema here is
  // zod `.strict()`, so the superset was rejected as `unrecognized_keys` by ALL of them and the
  // banned source never reached a single writer: the residue query found nothing because nothing
  // was ever attempted. Hence the SHAPES list — each route is probed with several plausible bodies
  // — and hence the closing assertion that a clean, uniquely-marked source DOES land somewhere.
  const routes = router.list().filter((r) => ['POST', 'PATCH', 'PUT'].includes(r.method));
  expect(routes.length).toBeGreaterThan(4); // vacuity: the router really was populated

  await makeBlock(SLUG, CLEAN_SRC);
  const t = await call('POST', `/api/blocks/${SLUG}/tests`, { name: 'noop', inputs: {} });
  const testId = t.json?.id ?? '0000000b-1b00-0000-0000-00000000f001';
  const bind = (tpl: string) => tpl.replace(':slug', SLUG).replace(':version', '0.1.0').replace(':id', testId);

  /** One body per known write SHAPE. The route SET is derived; only the shapes are enumerated. */
  const shapes = (src: string, tag: string) => [
    { source_ts: src },
    { version: `9.9.${tag}`, source_ts: src },
    { slug: `${SLUG_PREFIX}-p${tag}`, name: 'probe', category: 'logic', source_ts: src, descriptor: { inputs: {}, outputs: {}, capabilities: {} } },
    { name: `${SLUG_PREFIX}-t${tag}`, label: 'probe', category: 'logic', source_ts: src, descriptor: { inputs: {}, outputs: {}, capabilities: {} } },
  ];

  const fire = async (src: string, tag: string) => {
    for (const r of routes) {
      for (const body of shapes(src, tag)) {
        await call(r.method, bind(r.template), body).catch(() => null);
      }
    }
  };

  await fire(BANNED_SRC, '1');
  const versions = await db.select({ version: blockVersions.version, src: blockVersions.source_ts }).from(blockVersions);
  expect(versions.filter((row) => row.src.includes(BANNED_MARKER)).map((row) => row.version)).toEqual([]);
  const tpls = (await db.execute(sql`select name, source_ts from block_templates`)) as unknown as { name: string; source_ts: string }[];
  expect(tpls.filter((x) => (x.source_ts ?? '').includes(BANNED_MARKER)).map((x) => x.name)).toEqual([]);

  // ⛔ THE PROBE MUST BE ABLE TO SEE A WRITE. Same routes, same shapes, a CLEAN source carrying a
  // unique marker: at least one of them must land, or every assertion above proved nothing.
  await fire(`${CLEAN_SRC}\n// ${CLEAN_MARKER}`, '2');
  const after = await db.select({ src: blockVersions.source_ts }).from(blockVersions);
  const afterTpls = (await db.execute(sql`select source_ts from block_templates`)) as unknown as { source_ts: string }[];
  const landedVersions = after.filter((row) => row.src.includes(CLEAN_MARKER)).length;
  const landedTemplates = afterTpls.filter((x) => (x.source_ts ?? '').includes(CLEAN_MARKER)).length;
  // ⛔ BOTH TABLES SEPARATELY, NOT A SUM. A single combined `> 0` was satisfied entirely by
  // `block_versions`, which is exactly how the TEMPLATE half of this probe stayed vacuous:
  // `POST /api/templates` answered `403 tenant_id_claim_required` to all four body shapes before
  // parsing any of them, so the banned source never reached `createTemplate` and the residue query
  // above found nothing because nothing was ever attempted. `devUser` now carries a tenant claim;
  // this assertion is what proves it took effect.
  expect(landedVersions).toBeGreaterThan(0);
  expect(landedTemplates).toBeGreaterThan(0);
}, 180_000);

test('every MCP tool that takes a source_ts refuses a banned one', async () => {
  const ctx = (): McpAuthContext => ({ userId: DEV, tenantId: TENANT, roles: ['super_admin', 'developer'], flowId: null, challengeId: null });

  // DERIVED from the tool registry, not typed out. `lint_block` is excluded because it is the one
  // tool whose CONTRACT is to report findings rather than refuse — it writes nothing and runs
  // nothing, and an agent is told to call it precisely to see what is wrong.
  const writers = PLATFORM_TOOLS.filter(
    (t) => t.name !== 'lint_block' && !!(t.inputSchema as any)?.properties?.source_ts,
  );
  // If this number changes, a source-writing tool was added or removed — look at it.
  expect(writers.map((t) => t.name).sort()).toEqual(
    ['create_block', 'create_template', 'propose_block_draft', 'propose_block_patch', 'save_block_version'],
  );

  await makeBlock(SLUG, CLEAN_SRC);

  const args: Record<string, Record<string, unknown>> = {
    create_block: { slug: `${SLUG}-mcp`, name: 'mcp', category: 'logic' },
    create_template: { name: `${SLUG}-tpl`, label: 'tpl', category: 'logic', descriptor: { inputs: {}, outputs: {}, capabilities: {} } },
    save_block_version: { slug: SLUG, version: '0.1.0' },
    propose_block_draft: { name: `${SLUG}-mcp2`, category: 'logic', descriptor: { inputs: {}, outputs: {}, capabilities: {} } },
    propose_block_patch: { slug: SLUG, version: '0.1.0' },
  };

  const notRefused: string[] = [];
  for (const tool of writers) {
    const res = await mcpHost.callTool(tool.name, { ...args[tool.name], source_ts: BANNED_SRC }, ctx());
    const msg = JSON.stringify(res);
    // ⚠️ MATCHED ON THE MESSAGE, NOT THE CODE, AND THAT IS A LIMITATION OF THE MCP SURFACE, NOT A
    // CHOICE. `mcp-server.ts` flattens every thrown error to `{ error: err.message }` — the
    // HttpError's `code` (`lint_failed`) AND its `findings` are dropped on the floor for every
    // tool, not just these. So an agent told "Block failed lint" cannot see WHICH rule tripped,
    // which is exactly the information `propose_block_patch` needs to fix it. Reported upstream;
    // fixing it means changing the error mapping for all ~40 tools, which is not this lane.
    if (!res.isError || !msg.includes('Block failed lint')) notRefused.push(`${tool.name}: ${msg.slice(0, 200)}`);
  }
  expect(notRefused).toEqual([]);

  // VACUITY: the same tools with a CLEAN source must succeed — otherwise "refused" above could
  // just mean "every one of these tools is broken".
  const failedClean: string[] = [];
  for (const tool of writers) {
    const res = await mcpHost.callTool(tool.name, { ...args[tool.name], source_ts: CLEAN_SRC }, ctx());
    if (res.isError) failedClean.push(`${tool.name}: ${JSON.stringify(res).slice(0, 200)}`);
  }
  expect(failedClean).toEqual([]);
}, 120_000);

test('the branded column is still branded (the compile-time half of the gate)', async () => {
  // ⛔ GUARDING THE GUARD. The structural guarantee is `$type<ScannedSource>()` on the two source
  // columns: without it, `.values({ source_ts: someString })` compiles again and a future writer
  // silently skips the gate with a GREEN suite, because types are erased at runtime and no
  // behavioural test can see the difference. This is the one assertion that can.
  const schema = await Bun.file(new URL('../src/db/schema.ts', import.meta.url)).text();
  const branded = schema.match(/source_ts: text\('source_ts'\)\.\$type<ScannedSource>\(\)/g) ?? [];
  expect(branded.length).toBe(2); // block_versions + block_templates
  expect(schema).not.toMatch(/source_ts: text\('source_ts'\)\.notNull\(\)\.default\(''\)/);
});

// ===========================================================================
// 7. MUTATION PINS — the two things a mutant walked past with a GREEN suite AND green tsc
// ===========================================================================

test('⛔ a governance read that THROWS still refuses — fail closed, not fail open', async () => {
  // ⛔ THE MUTANT THIS EXISTS FOR: `catch { allowed = true }` in `assertBlockSourceSafe`. Nothing in
  // the suite saw it. Failing OPEN silently reinstates the exact lie this workstream removes — a
  // banned source written while the governance screen still says it cannot be — and it does so
  // precisely when the system is least healthy, which is when nobody is reading a warn line.
  //
  // The seam takes a snapshot OBJECT, not a thrower, so the throw is put on the property read the
  // gate actually performs. That is the same surface: `(await getSnapshot()).codeExecOutsideBlocks`.
  const live = await snapshotWith(false);
  __setSnapshotOverrideForTests(new Proxy(live, {
    get(t, k, r) {
      if (k === 'codeExecOutsideBlocks') throw new Error('governance read failed (simulated)');
      return Reflect.get(t, k, r);
    },
  }) as GovernanceSnapshot);

  await expect(assertBlockSourceSafe(BANNED_SRC)).rejects.toThrow('Block failed lint');

  // …and through the real route, because a unit-level throw does not prove the 422 reaches a caller.
  const refused = await call('POST', '/api/blocks', {
    slug: SLUG, name: SLUG, category: 'logic', source_ts: BANNED_SRC,
    descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  });
  expect(refused.status).toBe(422);
  expect(refused.json.error).toBe('lint_failed');
  const rows = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
  expect(rows).toEqual([]);

  // ⛔ VACUITY: a CLEAN source must still save while the governance read is broken. Without this the
  // assertions above are satisfied by "the gate refuses everything when the DB hiccups", which is an
  // outage, not a guard — and the whole fail-closed argument rests on the clean path never reading
  // the snapshot at all.
  await makeBlock(SLUG2, CLEAN_SRC);
  expect(await storedSource(SLUG2, '0.1.0')).toBe(CLEAN_SRC);
});

test('⛔ the gate MINTS the brand — the return type is pinned at typecheck, in this file', () => {
  // ⛔ THE MUTANT: widen `requireScannedSource` / `assertBlockSourceSafe` back to `string`. Every
  // behavioural test still passes (the runtime value is identical) — types are erased. The two
  // annotations below are the assertion: they are checked by `bun run typecheck`, which runs this
  // directory, and they fail to COMPILE if the gate stops minting `ScannedSource`.
  const minted: ScannedSource = requireScannedSource(CLEAN_SRC);
  const empty: ScannedSource = requireScannedSource('');
  // …and the runtime half: minting must return the SOURCE, not a copy, a trim, or an empty string.
  expect(minted as string).toBe(CLEAN_SRC);
  expect(empty as string).toBe('');
  const promised: Promise<ScannedSource> = assertBlockSourceSafe(CLEAN_SRC);
  return promised.then((v) => {
    expect(v as string).toBe(CLEAN_SRC);
  });
});

test('⛔ `as ScannedSource` exists in exactly ONE module — the brand keeps its minting monopoly', async () => {
  // ⛔ THE MUTANT NEITHER tsc NOR THE SUITE CATCHES. A future writer that needs to satisfy the
  // branded column can simply write `source_ts: body.source_ts as ScannedSource`. That compiles, the
  // suite stays green, and the gate is bypassed — the brand's whole value is that the cast is rare
  // enough to be reviewable, which is only true if it is confined.
  const files = [...new Bun.Glob('**/*.ts').scanSync({ cwd: new URL('../src', import.meta.url).pathname })];
  expect(files.length).toBeGreaterThan(100); // vacuity: the glob really walked the tree
  const offenders: string[] = [];
  for (const f of files) {
    const text = await Bun.file(new URL(`../src/${f}`, import.meta.url)).text();
    if (!/\bas\s+(unknown\s+as\s+)?ScannedSource\b/.test(text)) continue;
    if (f === 'blocks/scanned-source.ts' || f === 'blocks/source-gate.ts') continue;
    offenders.push(f);
  }
  expect(offenders).toEqual([]);
  // Vacuity: the two legitimate sites really do contain the cast, so the filter above is not
  // silently excluding an empty set.
  const gate = await Bun.file(new URL('../src/blocks/source-gate.ts', import.meta.url)).text();
  const brand = await Bun.file(new URL('../src/blocks/scanned-source.ts', import.meta.url)).text();
  expect(/\bas\s+ScannedSource\b/.test(gate)).toBe(true);
  expect(/\bas\s+ScannedSource\b/.test(brand)).toBe(true);
});

// ⛔ THE OPTIONAL-CALL SPELLING. A fresh adversarial verifier EXECUTED `eval?.("2+2")` through the
// live routes on BOTH trees: `?.(` is one character away from `(` and walked straight past a rule
// whose entire claim — now shown to a compliance reader as an ENFORCED rail, because this branch
// reclassifies `models.code_exec_outside_blocks` — is that eval is banned at save time. The tagged
// template form is the same class. Both cost 0/47 on the shipped corpus, so there was no reason to
// leave them open. The `evaluator?.(` / `api.eval(` cases are the false-positive floor: tightening
// the rule must not start flagging ordinary identifiers that merely begin with `eval`.
test('the eval rule has no one-token spelling that walks past it', () => {
  for (const src of [
    'const x = eval?.("2+2");',
    'const x = eval`2+2`;',
    'const x = globalThis.eval?.("2+2");',
    'const x = (0, eval)("2+2");',
    'const x = eval("2+2");',
  ]) {
    const r = scanBlockSource(src as never);
    expect(r.ok, `must be refused: ${src}`).toBe(false);
    expect(r.findings.map((f) => f.rule), src).toContain('no-eval');
  }

  // NON-VACUITY: the tightened rule must not swallow ordinary code.
  for (const src of [
    'const r = evaluator?.("x");',
    'const r = api.eval("x");',
    'const r = evaluate("x");',
    '// never eval() this\nexport default {};',
    'const s = "call eval() later";',
  ]) {
    const r = scanBlockSource(src as never);
    expect(r.ok, `must stay clean: ${src}`).toBe(true);
  }
});
