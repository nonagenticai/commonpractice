// tests/fixture-id-collisions.test.ts — a ratchet against the suite's oldest flake class.
//
// Every test file runs against ONE database, and nearly every file DELETEs then re-INSERTs its
// fixtures in `beforeEach`/`beforeAll`. So when two files hard-code the same UUID, one file rips a
// row out from under the other's. It surfaces as an FK violation in a file that looks unrelated
// and never reproduces in isolation:
//
//   PostgresError: insert or update on table "usage_counters" violates foreign key
//   constraint "usage_counters_user_id_fkey"
//
// That was the 1-2 random failures per full-suite run this repo had lived with. Proven on
// 2026-08-05: `tests/{runs,mcp-server,policy-enforcement}.test.ts` all used user id
// `…0c0001`. Full suite before the fix: 1115/2 then 1116/1. After giving each file its own
// ids: 1117/0 twice.
//
// ⚠️ CORRECTED 2026-08-16 — THE RATCHET STANDS, ITS OPENING SENTENCE DID NOT. It used to begin
// "bun runs test FILES CONCURRENTLY against ONE database". Bun does not: `bun test --help` says
// `--parallel` is OPT-IN and *"Implies --isolate"* (separate worker processes ⇒ separate module
// instances), CI runs a plain `cd backend && bun run test` with neither `--parallel` nor
// `--shard`, and measured file durations are ADDITIVE — llm-broker 433 ms + metering-platform-calls
// 152 ms + agent-loop 254 ms when run alone, 730 ms for all three in one invocation (the sum minus
// two process startups, not the 433 ms max). Full canonical write-up: the header of
// tests/metering-platform-calls.test.ts.
//
// The premise this ratchet rests on is unchanged and was measured, so nothing below moves: ONE
// database, sequential files, each tearing the shared fixtures down. Two mechanisms reach across a
// file boundary without any concurrency at all — (1) file B's `beforeEach` deletes the row file A
// left behind and still needs (the collisions listed below), and (2) file A LEAKS WORK PAST ITS
// OWN END: an un-awaited broker call resumes during a later `beforeEach` and INSERTs between its
// `delete(usage_counters)` and its `delete(users)`. Both print the FK line above, which is why
// that fingerprint alone does not tell you which one you have. (2) was reproduced 2026-08-16 under
// a starved Postgres and fixed at its leak in llm-broker.test.ts (WS-7); (1) is what this ratchet
// bounds.
//
// This is a RATCHET, not a clean bill of health. The collisions below are the ones that
// still exist; the point is that no NEW one can be added. Removing entries as they are
// fixed is the intended direction — the test does not require the list to stay full.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TESTS_DIR = import.meta.dir;
const UUID = /'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g;

/**
 * Known, pre-existing collisions. Each is a latent version of the bug above — they have not
 * bitten yet only because those files happen not to contend on the same table. Fix by giving
 * each file its own ids (see the note at the top of mcp-server.test.ts), then delete the entry.
 */
const KNOWN: Record<string, string[]> = {
  '00000000-0000-0000-0000-000000000000': ['mcp-sdk-transport.test.ts', 'metering-emit.test.ts'],
  '00000000-0000-0000-0000-0000000000aa': [
    'acting-as-scope.test.ts', 'block-tests.test.ts', 'blocks.test.ts', 'licenses-admin.test.ts',
  ],
  '00000000-0000-0000-0000-0000000000bb': ['blocks.test.ts', 'licenses-admin.test.ts'],
  '00000000-0000-0000-0000-0000000c0001': ['delivery-payload.test.ts', 'runs.test.ts'],
  // Not an owned row: neither file INSERTs or DELETEs a `tenants` row for this id — it is
  // passed as a tenant GUC / column value only, so sharing it cannot tear anything down.
  // A sharper rule would flag only ids that appear in a `db.delete(...)`; until then this
  // is listed rather than "fixed", because renaming it would change nothing real.
  '00000000-0000-0000-0000-000000000001': [
    'connector-pool-budget.test.ts', 'delivery-payload.test.ts', 'sandbox-watchdog-tick.test.ts',
  ],
  '00000000-0000-0000-0000-00000c000001': ['ontology-samples.test.ts', 'ontology-tombstone.test.ts'],
  '00000000-0000-0000-0000-00000c000002': ['ontology-samples.test.ts', 'ontology-tombstone.test.ts'],
  '00000000-0000-0000-0000-00000c00be01': ['ontology-samples.test.ts', 'ontology-tombstone.test.ts'],
  '00000000-0000-0000-0000-00000c00cf01': ['ontology-samples.test.ts', 'ontology-tombstone.test.ts'],
  '00000000-0000-0000-0000-00000c200001': ['ontology.test.ts', 'votes.test.ts'],
  '00000000-0000-0000-0000-00000d000001': [
    'connector-tenant-scope.test.ts', 'data-block-derivation.test.ts', 'ontology-tenant-i18n.test.ts',
  ],
  '00000000-0000-0000-0000-00000d000002': [
    'connector-tenant-scope.test.ts', 'data-block-derivation.test.ts', 'ontology-tenant-i18n.test.ts',
  ],
  '00000000-0000-0000-0000-00000d00ad01': ['connector-tenant-scope.test.ts', 'ontology-tenant-i18n.test.ts'],
  '00000000-0000-0000-0000-00000d00be01': ['connector-tenant-scope.test.ts', 'ontology-tenant-i18n.test.ts'],
  '00000000-0000-0000-0000-00000d00cf01': [
    'connector-tenant-scope.test.ts', 'data-block-derivation.test.ts', 'ontology-tenant-i18n.test.ts',
  ],
  '00000000-0000-4000-8000-0000000c2bbb': ['onboarding.test.ts', 'tenant-users.test.ts'],
};

function collisions(): Map<string, string[]> {
  const owners = new Map<string, Set<string>>();
  const SELF = 'fixture-id-collisions.test.ts'; // this file lists the ids, it does not own them
  for (const name of readdirSync(TESTS_DIR)) {
    if (!name.endsWith('.test.ts') || name === SELF) continue;
    const body = readFileSync(join(TESTS_DIR, name), 'utf8');
    for (const m of body.matchAll(UUID)) {
      const id = m[1]!;
      (owners.get(id) ?? owners.set(id, new Set()).get(id)!).add(name);
    }
  }
  const out = new Map<string, string[]>();
  for (const [id, files] of owners) if (files.size > 1) out.set(id, [...files].sort());
  return out;
}

test('the scan actually reads the test files (guards against a vacuous pass)', () => {
  expect(readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts')).length).toBeGreaterThan(50);
});

test('no NEW fixture id is shared across test files that share one database', () => {
  const introduced: string[] = [];
  for (const [id, files] of collisions()) {
    const known = KNOWN[id];
    if (!known) {
      introduced.push(`${id} newly shared by ${files.join(', ')}`);
      continue;
    }
    // An existing collision that spreads to a further file is also new breakage.
    const extra = files.filter((f) => !known.includes(f));
    if (extra.length) introduced.push(`${id} additionally used by ${extra.join(', ')}`);
  }
  expect(
    introduced,
    'Give each test file its OWN fixture ids — every file uses the SAME database (sequentially, ' +
      'not concurrently) and deletes/recreates its fixtures, so a shared id makes one file break ' +
      'another. See this file\'s header.',
  ).toEqual([]);
});
