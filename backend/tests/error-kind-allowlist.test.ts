// tests/error-kind-allowlist.test.ts — the THREE places that decide what an `ErrorKind` may be all
// name the same ten, and none of them can be widened alone.
//
// ⛔ WHY THIS FILE EXISTS. `kind` is not a type on the wire, it is a STRING an untrusted block can
// set: `throw Object.assign(new Error('x'), {kind: 'WAARSCHUWING: uw account wordt geblokkeerd'})`.
// `classify()` copied it verbatim, and the browser's `errorKindLabel` rendered an unrecognised kind
// RAW AND UN-ISOLATED as product chrome — the author's sentence, in the reader's language, in the
// product's frame — and it was persisted into `block_test_results.error_detail.actualKind`.
//
// The fix is an allowlist, and an allowlist has exactly one failure mode: DRIFT. There are two
// runtime copies (the executor classifies node errors; the test-runner separately sanitises
// `expectedKind`/`actualKind`, one of whose sources is `block_tests.expected_error_kind`, a
// user-writable column that never passes through the executor at all) plus the `ErrorKind` union
// itself. Adding a tenth kind to the union and forgetting one copy silently REJECTS the new kind
// on that path — which looks like nothing at all, because the fallback is a legitimate state.
//
// SOURCE TEXT, not imports: `exec/flow-executor.ts` and `blocks/test-runner.ts` keep their sets
// module-private on purpose (an exported allowlist is an exported vocabulary, and the executor
// exports nothing an author could reach). Diffing the declarations is the only way to compare them
// without opening that door.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');
const read = (p: string) => readFileSync(p, 'utf8');

/** The members of the `ErrorKind` union in trace-types.ts. */
function unionMembers(): string[] {
  const src = read(join(SRC, 'db', 'trace-types.ts'));
  const decl = src.match(/export type ErrorKind =([\s\S]*?);/);
  if (!decl) throw new Error('ErrorKind union not found');
  return [...decl[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** The members of a file's `const ERROR_KINDS: ReadonlySet<string> = new Set<ErrorKind>([…])`. */
function runtimeSet(file: string): string[] {
  const src = read(file);
  const decl = src.match(/const ERROR_KINDS[^=]*=\s*new Set<ErrorKind>\(\[([\s\S]*?)\]\)/);
  if (!decl) throw new Error(`ERROR_KINDS runtime set not found in ${file}`);
  return [...decl[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

const EXECUTOR = join(SRC, 'exec', 'flow-executor.ts');
const TEST_RUNNER = join(SRC, 'blocks', 'test-runner.ts');

test('the ErrorKind union really has ten members (the non-vacuity anchor)', () => {
  // ⛔ FIRST ON PURPOSE. If the parser or the path breaks, every comparison below passes against
  // two empty arrays.
  const u = unionMembers();
  expect(u).toHaveLength(10);
  expect(u).toEqual(
    expect.arrayContaining([
      'timeout',
      'validation',
      'block_throw',
      'internal',
      'llm_capped',
      'seat_required',
    ]),
  );
});

test('⛔ both runtime allowlists name EXACTLY the union — no drift, no gap', () => {
  const union = [...unionMembers()].sort();
  expect(
    [...runtimeSet(EXECUTOR)].sort(),
    'exec/flow-executor.ts ERROR_KINDS drifted from the ErrorKind union — a kind it omits is ' +
      'silently downgraded to block_throw on every node error',
  ).toEqual(union);
  expect(
    [...runtimeSet(TEST_RUNNER)].sort(),
    'blocks/test-runner.ts ERROR_KINDS drifted from the ErrorKind union — a kind it omits is ' +
      'silently DROPPED from error_detail, and the panel reverts to English for that verdict',
  ).toEqual(union);
});

test('⛔ neither allowlist is exported (an exported vocabulary is a reachable one)', () => {
  // The executor's whole discriminator rests on a block author being unable to reach its module
  // scope. `export const ERROR_KINDS` would not by itself let anyone forge a rule — but it is the
  // first step of exactly the mistake that made `ProductError` stealable, so it is pinned shut.
  expect(read(EXECUTOR)).not.toContain('export const ERROR_KINDS');
  expect(read(TEST_RUNNER)).not.toContain('export const ERROR_KINDS');
});
