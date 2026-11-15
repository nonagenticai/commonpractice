// tests/pipeline-authors-for.test.ts — `authorsFor` must filter in POSTGRES, not in JS.
//
// ⛔ WHY THIS FILE ASSERTS ON THE QUERY AND NOT ON THE RESULT. The old implementation was
//
//     const rows = await database.select({...}).from(users);          // no WHERE
//     for (const r of rows) { if (!ids.includes(r.id)) continue; … }  // O(n·m) in the pod
//
// which returns EXACTLY the same map as the fixed one. A behavioural test therefore cannot tell
// the two apart — it would be green before and after and would prove nothing at all. The defect is
// not in the answer, it is in the cost of getting it: `users` is a platform-global, NON-RLS table
// (migrations/0028_rls.sql), so the unfiltered select dragged every user of every tenant into the
// pod, on every board load and on every card move (routes/pipeline.ts × 4).
//
// So the assertion is on the SHAPE OF THE QUERY: a stub `database` records the builder calls, and
// the test demands a `where` carrying both requested ids. Paired with the initials cases, which
// pin the `displayPerson` swap that replaced a hand-rolled duplicate of it.
import { test, expect } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { authorsFor } from '../src/host/pipeline-service';
import { users } from '../src/db/client';

type Row = { id: string; name: string; initials: string | null };

/**
 * A `select().from().where()` builder that resolves to `rows`. Thenable, like drizzle's own, so
 * `await` on it works whether or not `.where()` was called — which is the whole point: the stub
 * must be able to satisfy BOTH implementations, or "it did not throw" would be the assertion.
 */
function stubDb(rows: Row[]) {
  const calls: { froms: number; wheres: unknown[] } = { froms: 0, wheres: [] };
  const builder = {
    from() {
      calls.froms++;
      return builder;
    },
    where(condition: unknown) {
      calls.wheres.push(condition);
      return builder;
    },
    then<T>(onOk: (v: Row[]) => T) {
      return Promise.resolve(rows).then(onOk);
    },
  };
  const database = { select: () => builder };
  return { database: database as unknown as Parameters<typeof authorsFor>[1], calls };
}

const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b2';

test('authorsFor filters in the database — the query carries a WHERE over the requested ids', async () => {
  const { database, calls } = stubDb([
    { id: A, name: 'Ada Lovelace', initials: null },
    { id: B, name: 'Prince', initials: null },
  ]);

  await authorsFor([A, B], database);

  expect(calls.froms).toBe(1);
  // RED on the old implementation: it never called `.where` at all.
  expect(calls.wheres, 'authorsFor selected `users` with no WHERE — that is a full table scan').toHaveLength(1);

  // And the predicate is the right one: both ids, bound as parameters.
  const dialect = new PgDialect();
  const actual = dialect.sqlToQuery(calls.wheres[0] as Parameters<PgDialect['sqlToQuery']>[0]);
  const expected = dialect.sqlToQuery(inArray(users.id, [A, B]));
  expect(actual.sql).toBe(expected.sql);
  expect(actual.params).toEqual(expected.params);
});

test('authorsFor issues no query at all for an empty / all-falsy id list', async () => {
  const { database, calls } = stubDb([]);
  expect(await authorsFor([], database)).toEqual(new Map());
  expect(await authorsFor(['', ''], database)).toEqual(new Map());
  expect(calls.froms).toBe(0);
});

test('initials come from displayPerson: two words → first+last, one word → first two letters', async () => {
  const { database } = stubDb([
    { id: A, name: 'Ada Lovelace', initials: null },
    { id: B, name: 'Prince', initials: null },
  ]);
  const people = await authorsFor([A, B], database);
  expect(people.get(A)).toEqual({ name: 'Ada Lovelace', initials: 'AL' });
  expect(people.get(B)).toEqual({ name: 'Prince', initials: 'PR' });
});

test('a stored avatar_initials wins over the derived fallback, verbatim', async () => {
  const { database } = stubDb([{ id: A, name: 'Ada Lovelace', initials: 'aL' }]);
  // Not upper-cased: `??` binds looser than the member access, so `.toUpperCase()` applies to the
  // FALLBACK only. Deliberate — a stored value is a choice, not raw material.
  expect((await authorsFor([A], database)).get(A)).toEqual({ name: 'Ada Lovelace', initials: 'aL' });
});

test('duplicate ids are deduped before the query, so one card moved twice asks for one row', async () => {
  const { database, calls } = stubDb([{ id: A, name: 'Ada Lovelace', initials: null }]);
  await authorsFor([A, A, A], database);
  const dialect = new PgDialect();
  const actual = dialect.sqlToQuery(calls.wheres[0] as Parameters<PgDialect['sqlToQuery']>[0]);
  expect(actual.params).toEqual([A]);
});
