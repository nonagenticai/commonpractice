// tests/check-hook-timeouts.test.ts — unit tests for scripts/check-hook-timeouts.ts, the CI guard
// for "bun 1.3.14 ignores bunfig's [test] timeout for HOOKS" (#164/#167/#169). Pure AST analysis,
// no DB, no network — fixture SOURCE STRINGS fed straight into the analyzer, not real files on
// disk, so these can't be accidentally swept into the DB-backed suite or pollute `tests/`.
//
// #164's own hand-rolled sweep put 3 of 69 timeouts on an unrelated `test(...)` below the intended
// hook and the diff still looked right — so every fixture here that has a decoy statement asserts
// on the LINE the violation is reported at, not just the count, to catch exactly that class of bug
// in the guard itself.
import { test, expect } from 'bun:test';
import { findHookTimeoutViolations } from '../scripts/check-hook-timeouts';

const HEADER = `import { test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';\n`;

test('inline hook body calling db.* directly is flagged when timeout is missing', () => {
  const src = `${HEADER}
import { db, tenants } from '../src/db/client';

beforeAll(async () => {
  await db.insert(tenants).values({ id: '1' });
});
`;
  const v = findHookTimeoutViolations(src);
  expect(v.length).toBe(1);
  expect(v[0]!.hook).toBe('beforeAll');
  expect(v[0]!.line).toBe(5);
  expect(v[0]!.reason).toContain('db call');
});

test('inline hook body calling db.* is NOT flagged when an explicit numeric timeout is given', () => {
  const src = `${HEADER}
import { db, tenants } from '../src/db/client';

beforeAll(async () => {
  await db.insert(tenants).values({ id: '1' });
}, 30_000);
`;
  expect(findHookTimeoutViolations(src)).toEqual([]);
});

test('bare-reference hook (afterAll(cleanup)) resolved through a local helper is flagged', () => {
  const src = `${HEADER}
import { db, tenants } from '../src/db/client';

async function cleanup() {
  await db.delete(tenants);
}

afterAll(cleanup);
`;
  const v = findHookTimeoutViolations(src);
  expect(v.length).toBe(1);
  expect(v[0]!.hook).toBe('afterAll');
  expect(v[0]!.reason).toContain('local helper `cleanup()`');
});

test('bare-reference hook is NOT flagged once it carries an explicit timeout', () => {
  const src = `${HEADER}
import { db, tenants } from '../src/db/client';

async function cleanup() {
  await db.delete(tenants);
}

afterAll(cleanup, 30_000);
`;
  expect(findHookTimeoutViolations(src)).toEqual([]);
});

test('resolution is transitive through two levels of locally-defined helpers', () => {
  const src = `${HEADER}
import { db, tenants } from '../src/db/client';

async function wipeTenants() {
  await db.delete(tenants);
}

async function cleanup() {
  await wipeTenants();
}

beforeEach(async () => {
  await cleanup();
});
`;
  const v = findHookTimeoutViolations(src);
  expect(v.length).toBe(1);
  expect(v[0]!.reason).toContain('local helper `cleanup()`');
  expect(v[0]!.reason).toContain('wipeTenants()');
});

test('imported seed*() helper from a db/seed-* module is flagged when missing a timeout', () => {
  const src = `${HEADER}
import { seedOntology } from '../src/db/seed-ontology';

beforeAll(async () => {
  await seedOntology();
});
`;
  const v = findHookTimeoutViolations(src);
  expect(v.length).toBe(1);
  expect(v[0]!.reason).toContain('imported seed helper `seedOntology`');
});

test('bare-reference to an imported seed helper is flagged too', () => {
  const src = `${HEADER}
import { seedOntology } from '../src/db/seed-ontology';

beforeAll(seedOntology);
`;
  const v = findHookTimeoutViolations(src);
  expect(v.length).toBe(1);
  expect(v[0]!.reason).toContain('imported seed helper `seedOntology`');
});

test('a pure in-memory hook is NOT flagged (no db, no seed helper)', () => {
  const src = `${HEADER}
import { __setAuthOverridesForTests } from '../src/middleware/auth';

afterEach(() => __setAuthOverridesForTests(undefined));
`;
  expect(findHookTimeoutViolations(src)).toEqual([]);
});

test('a local helper that only does in-memory work is NOT flagged even when a hook calls it bare', () => {
  const src = `${HEADER}
import { __setAuthOverridesForTests } from '../src/middleware/auth';

function reset() {
  __setAuthOverridesForTests(undefined);
}

afterEach(reset);
`;
  expect(findHookTimeoutViolations(src)).toEqual([]);
});

test('a non-DB helper imported from src/db/seed.ts (getSeedBlock, not seed*-shaped) is NOT flagged', () => {
  const src = `${HEADER}
import { getSeedBlock } from '../src/db/seed';

beforeAll(() => {
  const block = getSeedBlock('foo');
  void block;
});
`;
  expect(findHookTimeoutViolations(src)).toEqual([]);
});

test('regression for the #164 misplacement bug: a decoy test(...) below the hook must not confuse line attribution', () => {
  const src = `${HEADER}
import { db, tenants } from '../src/db/client';

beforeAll(async () => {
  await db.insert(tenants).values({ id: '1' });
});

test('an unrelated pure sync test', () => {
  expect(1).toBe(1);
});
`;
  const v = findHookTimeoutViolations(src);
  expect(v.length).toBe(1);
  expect(v[0]!.line).toBe(5); // the beforeAll's own line, not the decoy test()'s
});

test('multiple hooks in one file are each evaluated independently, with correct per-hook line numbers', () => {
  const src = `${HEADER}
import { db, tenants } from '../src/db/client';
import { __setAuthOverridesForTests } from '../src/middleware/auth';

async function cleanup() {
  await db.delete(tenants);
}

beforeAll(cleanup, 30_000); // has a timeout -> OK
afterEach(() => __setAuthOverridesForTests(undefined)); // in-memory -> OK
afterAll(cleanup); // missing timeout -> flagged
`;
  const v = findHookTimeoutViolations(src);
  expect(v.length).toBe(1);
  expect(v[0]!.hook).toBe('afterAll');
  expect(v[0]!.line).toBe(12);
});

// ── adversarial hunt: two ways a hook can reach `db` without a static named import, reproduced
// against the real findHookTimeoutViolations export (both used to report 0 violations). ─────────
test('dynamic import destructured directly (`const { db } = await import(...)`) is flagged', () => {
  const src = `${HEADER}
beforeAll(async () => {
  const { db } = await import('../src/db/client');
  await db.delete(x);
});
`;
  const v = findHookTimeoutViolations(src);
  expect(v.length).toBe(1);
  expect(v[0]!.hook).toBe('beforeAll');
  expect(v[0]!.line).toBe(3);
});

test('dynamic import destructured directly is NOT flagged once it carries an explicit timeout', () => {
  const src = `${HEADER}
beforeAll(async () => {
  const { db } = await import('../src/db/client');
  await db.delete(x);
}, 30_000);
`;
  expect(findHookTimeoutViolations(src)).toEqual([]);
});

test('namespace import + destructuring (`import * as client …; const { db: d } = client`) is flagged', () => {
  const src = `${HEADER}
import * as client from '../src/db/client';

const { db: d } = client;

afterEach(async () => {
  await d.delete(x);
});
`;
  const v = findHookTimeoutViolations(src);
  expect(v.length).toBe(1);
  expect(v[0]!.hook).toBe('afterEach');
  expect(v[0]!.reason).toContain('db call');
});

test('namespace import + destructuring is NOT flagged once it carries an explicit timeout', () => {
  const src = `${HEADER}
import * as client from '../src/db/client';

const { db: d } = client;

afterEach(async () => {
  await d.delete(x);
}, 30_000);
`;
  expect(findHookTimeoutViolations(src)).toEqual([]);
});

test('a shadowed identifier named beforeAll that is NOT imported from bun:test is ignored', () => {
  const src = `${HEADER}
function beforeAll(fn: () => void) {
  fn();
}

beforeAll(() => {
  console.log('not a real hook');
});
`;
  // The re-declared local \`beforeAll\` shadows the bun:test import in this file's own scope; the
  // guard's import-binding check must not treat every identifier named "beforeAll" as the real hook.
  expect(findHookTimeoutViolations(src)).toEqual([]);
});
