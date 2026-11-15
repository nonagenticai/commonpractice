// tests/migration-0092-signup-backfill.test.ts
//
// 0092 re-runs 0088's backfill to queue users stranded by a claim naming an UNPROVISIONED tenant
// (see the 0092 header). Its correctness argument is entirely "it is 0088's statement" — and
// migration-0088-signup-backfill.test.ts pins 0088 against the exporter's census C on a real
// database, mutation-tested. So the one thing this file must prove is that the two executable
// statements are the same, modulo the migration number in `note`. If they drift, this reds — and
// the fix is to make 0092 match 0088 (or re-argue 0092 against the exporter with its own DB suite).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', 'migrations');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');

/** The executable SQL only: `--` comments and blank lines stripped, whitespace collapsed. */
function statement(sql: string): string {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trimEnd())
    .filter((l) => l.trim() !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const S88 = statement(read('0088_backfill_pre_0027_signup_approvals.sql'));
const S92 = statement(read('0092_backfill_unprovisioned_claim_signup_approvals.sql'));

test('⛔ 0092 executes exactly 0088s statement, differing only in the migration number in `note`', () => {
  expect(S92).not.toBe(S88); // the note does name its own migration
  expect(S92.replace('migration 0092', 'migration 0088')).toBe(S88);
});

test('the comparison is not vacuous — the stripped statement still carries the predicate', () => {
  for (const s of [S88, S92]) {
    expect(s).toStartWith('INSERT INTO signup_approvals');
    expect(s).toContain("u.email !~* '@([^@]+\\.)?(local|invalid)$'");
    expect(s).toContain('NOT EXISTS');
    expect(s).toEndWith('ON CONFLICT DO NOTHING;');
  }
});
