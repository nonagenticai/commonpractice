// tests/migration-0088-signup-backfill.test.ts — 0088 executed, against the rows it exists for.
//
// ⛔ WHY THIS FILE EXISTS. `recordSignupStrand` (services/user-service.ts) already queues a
// no-claim user, and tests/stranded-signup-is-visible.test.ts pins that. But that path fires on an
// AUTHENTICATED REQUEST, so it reaches only people who sign in after it shipped. It says nothing
// whatever about the `users` rows that were already sitting there — which is the entire population
// 0088 addresses and the entire population `CommonPracticeSignupStrandedUnqueued` is firing on.
// This file plants those rows and asserts on what the shipped SQL does to them.
//
// ⛔ AND THE CENTRE OF IT IS NOT "SOME ROWS APPEARED". It is `EXPORTER_CENSUS_C` below: the
// migration's own predicate and the exporter's predicate must select the SAME SET, because a
// backfill that covers a smaller set inserts rows and leaves the alert firing, and one that covers
// a larger set writes queue entries nobody asked for. The test therefore measures the alert's own
// number (`unqueued`), not the row count of the table 0088 writes.
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { applyMigrations } from '../src/db/migration-runner';
import { config } from '../src/config';

const MIGRATION_0088 = join(
  import.meta.dir,
  '..',
  'migrations',
  '0088_backfill_pre_0027_signup_approvals.sql',
);

function migrationSql(): string {
  return readFileSync(MIGRATION_0088, 'utf8');
}

// ---------------------------------------------------------------------------
// Scratch database plumbing (migration-0078-review-panel-mock-data.test.ts idiom).
// ---------------------------------------------------------------------------

const SCRATCH_DB = 'cp_m0088_signup_backfill_scratch';

function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}

const OWNER_DSN = config.database.migrateUrl;
const SCRATCH_DSN = withDatabase(OWNER_DSN, SCRATCH_DB);
const MAINTENANCE_DSN = withDatabase(OWNER_DSN, 'postgres');

let scratch: postgres.Sql;

async function withMaintenance(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(MAINTENANCE_DSN, { max: 1, onnotice: () => {} });
  try {
    await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

// Fixture ids unique to this file — see tests/fixture-id-collisions.test.ts.
const TENANT = '00000000-0000-4000-8000-000000880101';
const U_STRANDED_A = '00000000-0000-4000-8000-000000880201'; // the plain case: pre-0027, unqueued
const U_STRANDED_B = '00000000-0000-4000-8000-000000880202'; // ditto, second address
const U_DUP_UPPER = '00000000-0000-4000-8000-000000880203'; // 'Dup@…' — case-collides with…
const U_DUP_LOWER = '00000000-0000-4000-8000-000000880204'; // …'dup@…', both stranded
const U_QUEUED_PENDING = '00000000-0000-4000-8000-000000880205'; // stranded, already pending
const U_QUEUED_REJECTED = '00000000-0000-4000-8000-000000880206'; // stranded, already REJECTED
const U_SEATED = '00000000-0000-4000-8000-000000880207'; // holds a tenant — never queued
const U_DELETED = '00000000-0000-4000-8000-000000880208'; // tenant NULL but offboarded

const E_STRANDED_A = 'stranded-a@m0088.test';
const E_STRANDED_B = 'stranded-b@m0088.test';
const E_DUP_UPPER = 'Dup@m0088.test';
const E_DUP_LOWER = 'dup@m0088.test';
const E_QUEUED_PENDING = 'already-pending@m0088.test';
const E_QUEUED_REJECTED = 'already-rejected@m0088.test';
const E_SEATED = 'seated@m0088.test';
const E_DELETED = 'offboarded@m0088.test';

/**
 * The undeliverable-domain exclusion, as BOTH sides spell it: `UNDELIVERABLE_EMAIL_DOMAIN_PATTERN`
 * in src/host/onboarding-integrity.ts and the `!~*` clause in 0088 itself. Declared here as a
 * JS string (so `\\.` is one real backslash) and BOUND as a parameter, never interpolated — the
 * exporter binds it the same way, for the same reason: a `\.` written straight into a template
 * literal is silently eaten by JS and becomes `.`, i.e. "any character", which still passes every
 * happy-path test.
 *
 * ⚠️ Pinned against BOTH real sources by `⛔ the exclusion is spelled identically in the exporter
 * and in 0088` below, so this constant cannot drift away from the code it stands in for.
 */
const UNDELIVERABLE_DOMAIN_PATTERN = '@([^@]+\\.)?(local|invalid)$';

/**
 * ⛔ CENSUS C, TRANSCRIBED VERBATIM from src/host/onboarding-integrity.ts (the `orphanRow` query).
 * `unqueued` here IS `commonpractice_users_without_tenant{queued="false"}`, the series
 * `CommonPracticeSignupStrandedUnqueued` alerts on. It is copied rather than imported because the
 * exporter binds its query to `metricsClient` (DATABASE_URL), which is not this scratch database.
 * If the exporter's predicate is ever changed without changing 0088, this file keeps passing while
 * production stops clearing — so the transcription is pinned by `0088 and the exporter select the
 * SAME SET` below, which re-derives the migration's own population from this query, and by the
 * source-text check on the exclusion clause.
 */
const EXPORTER_CENSUS_C = `
  SELECT
    count(*) FILTER (WHERE s.id IS NOT NULL)::int AS queued,
    count(*) FILTER (WHERE s.id IS NULL)::int     AS unqueued
  FROM users u
  LEFT JOIN LATERAL (
    SELECT sa.id FROM signup_approvals sa WHERE lower(sa.email) = lower(u.email) LIMIT 1
  ) s ON true
  WHERE u.tenant_id IS NULL AND u.deleted_at IS NULL AND u.email !~* $1
`;

async function census(): Promise<{ queued: number; unqueued: number }> {
  const rows = (await scratch.unsafe(EXPORTER_CENSUS_C, [UNDELIVERABLE_DOMAIN_PATTERN])) as unknown as {
    queued: number;
    unqueued: number;
  }[];
  return rows[0]!;
}

async function approvalsFor(email: string): Promise<Record<string, unknown>[]> {
  return (await scratch.unsafe(
    `SELECT id::text AS id, email, name, status, keycloak_sub, matched_tenant_id, assigned_tenant_id,
            requested_role, note, xmin::text AS xmin
       FROM signup_approvals WHERE lower(email) = lower($1) ORDER BY id`,
    [email],
  )) as unknown as Record<string, unknown>[];
}

/** Every `users` row's full persisted state + row version — 0088 must not write this table. */
async function usersSnapshot(): Promise<Record<string, string>> {
  const rows = (await scratch.unsafe(
    `SELECT id::text AS id, email, name, coalesce(tenant_id::text, '-') AS t,
            coalesce(deleted_at::text, '-') AS d, xmin::text AS v
       FROM users ORDER BY id`,
  )) as unknown as { id: string; email: string; name: string; t: string; d: string; v: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, `${r.email}|${r.name}|${r.t}|${r.d}|${r.v}`]));
}

async function approvalsSnapshot(): Promise<Record<string, string>> {
  const rows = (await scratch.unsafe(
    `SELECT id::text AS id, email, status, coalesce(note, '-') AS n, xmin::text AS v
       FROM signup_approvals ORDER BY id`,
  )) as unknown as { id: string; email: string; status: string; n: string; v: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, `${r.email}|${r.status}|${r.n}|${r.v}`]));
}

async function runMigration(): Promise<void> {
  await scratch.unsafe(migrationSql());
}

async function reset(): Promise<void> {
  await scratch.unsafe('DELETE FROM signup_approvals');
  await scratch.unsafe('UPDATE users SET tenant_id = NULL');
  await scratch.unsafe('DELETE FROM users');
  await scratch.unsafe('DELETE FROM tenants');
  await scratch.unsafe(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'M0088', 'm0088')`,
    [TENANT],
  );

  // [id, email, name, tenant_id, deleted_at, created_at]
  const rows: [string, string, string, string | null, string | null, string][] = [
    [U_STRANDED_A, E_STRANDED_A, 'Stranded A', null, null, '2026-06-07T04:20:39Z'],
    [U_STRANDED_B, E_STRANDED_B, 'Stranded B', null, null, '2026-06-11T07:41:05Z'],
    [U_DUP_UPPER, E_DUP_UPPER, 'Dup Upper', null, null, '2026-06-08T00:00:00Z'],
    [U_DUP_LOWER, E_DUP_LOWER, 'Dup Lower', null, null, '2026-06-09T00:00:00Z'],
    [U_QUEUED_PENDING, E_QUEUED_PENDING, 'Already Pending', null, null, '2026-07-01T00:00:00Z'],
    [U_QUEUED_REJECTED, E_QUEUED_REJECTED, 'Already Rejected', null, null, '2026-07-02T00:00:00Z'],
    [U_SEATED, E_SEATED, 'Seated', TENANT, null, '2026-07-03T00:00:00Z'],
    [U_DELETED, E_DELETED, 'Offboarded', null, '2026-08-01T00:00:00Z', '2026-07-04T00:00:00Z'],
  ];
  for (const [id, email, name, tenant, deleted, created] of rows) {
    await scratch.unsafe(
      `INSERT INTO users (id, email, name, tenant_id, deleted_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, email, name, tenant, deleted, created],
    );
  }

  // The two pre-existing queue rows. Both are spelled in a DIFFERENT CASE from their `users` row
  // on purpose: the whole join is `lower(email)`, and an exact-match backfill would re-queue both.
  await scratch.unsafe(
    `INSERT INTO signup_approvals (email, name, status) VALUES ($1, 'Already Pending', 'pending')`,
    [E_QUEUED_PENDING.toUpperCase()],
  );
  await scratch.unsafe(
    `INSERT INTO signup_approvals (email, name, status) VALUES ($1, 'Already Rejected', 'rejected')`,
    [E_QUEUED_REJECTED.toUpperCase()],
  );
}

beforeAll(async () => {
  await withMaintenance(async (admin) => {
    // FORCE so a connection stranded by a previously-killed run cannot block the drop.
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  await applyMigrations(SCRATCH_DSN, {
    logger: { log: () => {}, warn: () => {}, error: console.error },
  });
  scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
}, 180_000);

beforeEach(reset, 30_000);

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

// ---------------------------------------------------------------------------
// ⛔ The alert's own number.
// ---------------------------------------------------------------------------

test('⛔ the fixture reproduces the defect: the exporter sees unqueued > 0 before 0088', async () => {
  // Without this the whole file could pass over a population of zero — a backfill that inserts
  // nothing satisfies every "no duplicates" assertion below perfectly.
  const before = await census();
  expect(before.unqueued).toBe(4); // A, B, and BOTH halves of the case-colliding pair
  expect(before.queued).toBe(2); // the already-pending and the already-rejected rows
});

test('⛔ 0088 drives commonpractice_users_without_tenant{queued="false"} to ZERO', async () => {
  await runMigration();
  const after = await census();
  expect(after.unqueued).toBe(0);
  // Every live, tenant-less user is now visible to the queue — nobody was dropped on the way.
  expect(after.queued).toBe(6);
});

test('⛔ 0088 and the exporter select the SAME SET — not a subset, not a superset', async () => {
  // Re-derives the migration's population from the EXPORTER's predicate and compares it to the
  // emails 0088 actually inserted. A `!==` here is the failure the header describes: rows written
  // with the alert still firing, or queue rows for people the alert never counted.
  const expected = (await scratch.unsafe(
    `SELECT DISTINCT lower(u.email) AS e
       FROM users u
       LEFT JOIN LATERAL (
         SELECT sa.id FROM signup_approvals sa WHERE lower(sa.email) = lower(u.email) LIMIT 1
       ) s ON true
      WHERE u.tenant_id IS NULL AND u.deleted_at IS NULL AND s.id IS NULL
        AND u.email !~* $1
      ORDER BY e`,
    [UNDELIVERABLE_DOMAIN_PATTERN],
  )) as unknown as { e: string }[];

  const beforeIds = new Set(Object.keys(await approvalsSnapshot()));
  await runMigration();
  const inserted = (await scratch.unsafe(
    `SELECT lower(email) AS e FROM signup_approvals ORDER BY e`,
  )) as unknown as { e: string }[];
  const insertedNew = (await scratch.unsafe(
    `SELECT id::text AS id, lower(email) AS e FROM signup_approvals ORDER BY e`,
  )) as unknown as { id: string; e: string }[];

  expect(inserted.length).toBeGreaterThan(0);
  expect(
    insertedNew.filter((r) => !beforeIds.has(r.id)).map((r) => r.e).sort(),
  ).toEqual(expected.map((r) => r.e).sort());
});

// ---------------------------------------------------------------------------
// ⛔ What the backfilled row is — and is not.
// ---------------------------------------------------------------------------

test('⛔ a backfilled row is PENDING and proposes no tenant at all', async () => {
  await runMigration();
  for (const email of [E_STRANDED_A, E_STRANDED_B]) {
    const rows = await approvalsFor(email);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe('pending');
    // The three columns that would constitute a machine-made routing decision. All must be NULL:
    // approve reads `body.tenantId ?? assigned_tenant_id ?? matched_tenant_id`, so a non-null
    // `matched_tenant_id` is a default a super_admin can accept by pressing one button.
    expect(row.matched_tenant_id).toBeNull();
    expect(row.assigned_tenant_id).toBeNull();
    expect(row.keycloak_sub).toBeNull();
    expect(row.requested_role).toBe('member'); // the column default; never an elevated role
    expect(String(row.note)).toContain('0088');
  }
});

test('⛔ 0088 does not write the users table — no tenant, no tombstone, no seat', async () => {
  const before = await usersSnapshot();
  await runMigration();
  // Compares `xmin` as well as the values: an UPDATE that rewrote a row to the same value would
  // pass a value-only comparison, and it is the WRITE this migration is forbidden to make.
  expect(await usersSnapshot()).toEqual(before);
  const seatedRows = (await scratch.unsafe(
    `SELECT count(*)::int AS seated FROM users WHERE tenant_id IS NOT NULL`,
  )) as unknown as { seated: number }[];
  expect(seatedRows[0]!.seated).toBe(1); // still only U_SEATED
});

test('a seated user and an offboarded user are never queued', async () => {
  await runMigration();
  expect(await approvalsFor(E_SEATED)).toHaveLength(0);
  expect(await approvalsFor(E_DELETED)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// ⛔ The undeliverable-domain exclusion: an address that can never receive mail is never queued,
//    and — since the exporter carries the identical clause — is never ALERTED ON either.
// ---------------------------------------------------------------------------
//
// RFC 6762 reserves `.local` for mDNS and RFC 2606 reserves `.invalid` for names guaranteed not to
// resolve — no MX, no deliverable mail — so such an account can never confirm a realm identity and
// can never complete onboarding. A queue row for it is unanswerable, and so is an alert on it.
// ⛔ `.test` is reserved too and is deliberately NOT excluded: this file uses `@m0088.test` as its
// stand-in for a DELIVERABLE address, so excluding it would make every "a real person IS queued"
// assertion below vacuously true.
// These fixtures are inserted per-test rather than into `reset()` on purpose: the census tests
// above measure the exporter's numbers over a population with no excluded domain in it, and folding
// these rows into the shared fixture would silently rewrite what those assertions are about.

const U_LOCAL_LOWER = '00000000-0000-4000-8000-000000880209';
const U_LOCAL_UPPER = '00000000-0000-4000-8000-000000880210';
const U_LOCAL_BARE = '00000000-0000-4000-8000-000000880211';
const U_LOCALPART = '00000000-0000-4000-8000-000000880212';
const U_INVALID = '00000000-0000-4000-8000-000000880213';

const E_LOCAL_LOWER = 'demo.fixture@m0088.local'; // the shape production actually holds
const E_LOCAL_UPPER = 'USER@EXAMPLE.LOCAL'; // same domain, screaming case
const E_LOCAL_BARE = 'bare@local'; // the TLD used bare, with no sub-label
const E_LOCALPART = 'a.local@m0088.test'; // ⚠️ `.local` in the LOCAL PART — a deliverable address
const E_INVALID = 'alice@example.invalid'; // RFC 2606 `.invalid` — the repo's own fixture domain

/** Plants one extra live, tenant-less, unqueued user. Same shape as `reset()`'s stranded rows. */
async function strand(id: string, email: string, name: string): Promise<void> {
  await scratch.unsafe(
    `INSERT INTO users (id, email, name, tenant_id, deleted_at, created_at)
     VALUES ($1, $2, $3, NULL, NULL, '2026-06-07T04:20:39Z')`,
    [id, email, name],
  );
}

test('⛔ a stranded `.local` user is NOT queued, while a normal stranded user IS', async () => {
  // Both halves in ONE test on ONE run: a "not queued" assertion alone would also pass if the
  // migration had inserted nothing at all, which is the failure mode it is meant to exclude.
  await strand(U_LOCAL_LOWER, E_LOCAL_LOWER, 'Demo Fixture');
  await runMigration();
  expect(await approvalsFor(E_LOCAL_LOWER)).toHaveLength(0);
  expect(await approvalsFor(E_STRANDED_A)).toHaveLength(1); // the deliverable address, queued
});

test('⛔ the `.local` exclusion is CASE-INSENSITIVE — `USER@EXAMPLE.LOCAL` is not queued', async () => {
  // `users.email` is not normalised on write, so an uppercase domain is a legal stored value and a
  // case-sensitive `NOT LIKE '%.local'` would let exactly this row through.
  await strand(U_LOCAL_UPPER, E_LOCAL_UPPER, 'Shouty Fixture');
  await runMigration();
  expect(await approvalsFor(E_LOCAL_UPPER)).toHaveLength(0);
});

test('the TLD is matched with no sub-label too: `bare@local` is not queued', async () => {
  await strand(U_LOCAL_BARE, E_LOCAL_BARE, 'Bare Local');
  await runMigration();
  expect(await approvalsFor(E_LOCAL_BARE)).toHaveLength(0);
});

test('⛔ the exclusion is anchored to the DOMAIN: `a.local@m0088.test` IS still queued', async () => {
  // The counter-case that keeps the filter honest. An unanchored `email ILIKE '%.local%'` — or any
  // match that ignores the `@` — would drop this deliverable address, and no other test would see
  // it. This is the row a real human could be sitting behind.
  await strand(U_LOCALPART, E_LOCALPART, 'Dot Local Localpart');
  await runMigration();
  expect(await approvalsFor(E_LOCALPART)).toHaveLength(1);
});

test('⛔ an `example.invalid` user is NOT queued either — RFC 2606, same principle as `.local`', async () => {
  await strand(U_INVALID, E_INVALID, 'Invalid Fixture');
  await runMigration();
  expect(await approvalsFor(E_INVALID)).toHaveLength(0);
  expect(await approvalsFor(E_STRANDED_A)).toHaveLength(1); // non-vacuity, same run
});

// ⚠️ NAME CORRECTED after audit. This test used to imply it would go red if only
// ONE of the two files were filtered. It does NOT: its `census()` helper runs
// this file's own EXPORTER_CENSUS_C copy, so deleting the clause from the real
// exporter leaves it green. The coupling IS caught — by onboarding-integrity.test.ts,
// which drives the real readOnboardingCensus(); verified by mutation. What THIS
// test pins is narrower and still worth having: that 0088's own predicate and the
// census shape agree on the same rows.
test('0088 and the census SHAPE agree on undeliverable rows (see note: not the cross-file coupling)', async () => {
  // THE POINT OF THE WHOLE CHANGE. The exporter carries the identical exclusion, so a `.local` /
  // `.invalid` row is not counted in the first place — `CommonPracticeSignupStrandedUnqueued`
  // clears instead of firing forever on rows no human can action. If someone adds the filter to
  // only ONE of the two files, this goes red: a census WIDER than the backfill leaves `unqueued`
  // above 0 after a complete run, a NARROWER one is caught by the SAME SET test above.
  await strand(U_LOCAL_LOWER, E_LOCAL_LOWER, 'Demo Fixture');
  await strand(U_INVALID, E_INVALID, 'Invalid Fixture');
  const before = await census();
  expect(before.unqueued).toBe(4); // the undeliverable pair is invisible to the alert already
  await runMigration();
  const after = await census();
  expect(after.unqueued).toBe(0);

  // …and the rows really are still there, unqueued — the zero above is an EXCLUSION, not a
  // deletion, and not an empty table. Without this the assertion would also pass if `strand()`
  // had silently failed to insert anything.
  const skipped = (await scratch.unsafe(
    `SELECT lower(u.email) AS e
       FROM users u
       LEFT JOIN LATERAL (
         SELECT sa.id FROM signup_approvals sa WHERE lower(sa.email) = lower(u.email) LIMIT 1
       ) s ON true
      WHERE u.tenant_id IS NULL AND u.deleted_at IS NULL AND s.id IS NULL
      ORDER BY e`,
  )) as unknown as { e: string }[];
  expect(skipped.map((r) => r.e)).toEqual([E_INVALID.toLowerCase(), E_LOCAL_LOWER.toLowerCase()]);
});

test('⛔ the exclusion is spelled identically in the exporter and in 0088', async () => {
  // The two predicates must select the SAME SET (see this file's header). Both are checked as
  // SOURCE TEXT against the one constant this file binds, so a change to either file that this
  // test file was not updated for reddens here rather than passing locally and silently leaving
  // production's gauge unable to clear. Read as text — importing the exporter would build its
  // postgres-js clients against DATABASE_URL, which is not this scratch database.
  const exporter = readFileSync(join(import.meta.dir, '..', 'src/host/onboarding-integrity.ts'), 'utf8');
  // The exporter writes the pattern as a JS string literal, so its source carries `\\.`, exactly
  // as this file's own constant does before JS unescapes it.
  expect(exporter).toContain("'@([^@]+\\\\.)?(local|invalid)$'");
  expect(exporter).toMatch(/u\.email\s*!~\*\s*\$\{UNDELIVERABLE_EMAIL_DOMAIN_PATTERN\}/);
  // 0088 writes it as a SQL string literal — one real backslash, no JS escaping layer.
  expect(migrationSql()).toContain("u.email !~* '@([^@]+\\.)?(local|invalid)$'");
  // Non-vacuity: prove the two spellings really are the same regex, not two strings that merely
  // both got found. Postgres is the arbiter, not a string compare.
  const [agree] = (await scratch.unsafe(
    `SELECT ($1 ~* $3) AS a, ($1 ~* $2) AS b, ($4 ~* $3) AS c, ($4 ~* $2) AS d`,
    [E_LOCAL_LOWER, UNDELIVERABLE_DOMAIN_PATTERN, '@([^@]+\\.)?(local|invalid)$', E_LOCALPART],
  )) as unknown as { a: boolean; b: boolean; c: boolean; d: boolean }[];
  expect([agree!.a, agree!.b]).toEqual([true, true]); // `.local` domain: both spellings match
  expect([agree!.c, agree!.d]).toEqual([false, false]); // `.local` local-part: neither matches
});

/** The migration text with the undeliverable-domain filter deleted, asserting the cut landed. */
function mutantWithoutDomainFilter(): string {
  const original = migrationSql();
  const mutant = original.replace(
    /^\s*AND u\.email !~\* '@\(\[\^@\]\+\\\.\)\?\(local\|invalid\)\$'\n/m,
    '',
  );
  expect(mutant).not.toBe(original); // the filter moved or was rewritten → this mutant is inert
  return mutant;
}

test('⛔ MUTATION: with the domain filter removed, the undeliverable fixtures ARE queued', async () => {
  // Without this, every assertion above could be passing for a reason that has nothing to do with
  // the filter — e.g. if `strand()` silently failed to insert, "not queued" is vacuously true.
  // Running the mutant on the identical fixture proves the filter is the only thing holding it out.
  await strand(U_LOCAL_LOWER, E_LOCAL_LOWER, 'Demo Fixture');
  await strand(U_LOCAL_UPPER, E_LOCAL_UPPER, 'Shouty Fixture');
  await strand(U_INVALID, E_INVALID, 'Invalid Fixture');
  await scratch.unsafe(mutantWithoutDomainFilter());
  expect(await approvalsFor(E_LOCAL_LOWER)).toHaveLength(1);
  expect(await approvalsFor(E_LOCAL_UPPER)).toHaveLength(1);
  expect(await approvalsFor(E_INVALID)).toHaveLength(1);
  // ⚠️ NOT asserted via `census()`. The exporter now carries the same exclusion, so `unqueued`
  // reads 0 whether or not these rows were queued — it is blind to this mutant BY DESIGN, which is
  // the whole fix. The queue table is the only instrument that can see it, so it is the one used.
});

test('⛔ the note states only what the statement measured — no claim that a person is waiting', async () => {
  // Defect 2. `users.created_at` and a NULL tenant cannot distinguish an abandoned signup from
  // someone actively expecting an answer, so the note must not tell the approving super_admin that
  // one is. The timestamp itself stays — that IS measured.
  await runMigration();
  const note = String((await approvalsFor(E_STRANDED_B))[0]!.note);
  expect(note).toContain('2026-06-11T07:41:05Z'); // the users row's own creation time, kept
  expect(note).toMatch(/tenant_id NULL/i);
  expect(note).not.toMatch(/waiting|has been waiting|expecting|wait(ed|s)?\b/i);
});

// ---------------------------------------------------------------------------
// ⛔ Not re-queuing, and not overturning, anyone already in the queue.
// ---------------------------------------------------------------------------

test('⛔ an already-REJECTED request is left decided, not resurrected as pending', async () => {
  await runMigration();
  const rows = await approvalsFor(E_QUEUED_REJECTED);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('rejected');
});

test('an already-pending request gains no second row (the join is case-insensitive)', async () => {
  // The fixture's queue row is UPPERCASE and the users row is lowercase; an `=` join instead of
  // `lower() = lower()` would insert a duplicate here and the partial unique index would raise.
  await runMigration();
  const rows = await approvalsFor(E_QUEUED_PENDING);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.note).toBeNull(); // untouched — the pre-existing row, not a backfilled one
});

test('⛔ two stranded users differing only in email CASE produce exactly ONE queue row', async () => {
  await runMigration();
  const rows = await approvalsFor(E_DUP_LOWER);
  expect(rows).toHaveLength(1);
  // `DISTINCT ON … ORDER BY lower(email), created_at ASC` — the OLDER of the pair wins.
  expect(rows[0]!.email).toBe(E_DUP_UPPER);
});

/** The migration text with one or both case-collision guards removed. Asserts the replacement
 *  actually fired — a mutant identical to the original passes every test below vacuously. */
function mutantWithout(opts: { distinctOn?: boolean; onConflict?: boolean }): string {
  const original = migrationSql();
  let mutant = original;
  if (opts.distinctOn) mutant = mutant.replace('SELECT DISTINCT ON (lower(u.email))', 'SELECT');
  if (opts.onConflict) mutant = mutant.replace('ON CONFLICT DO NOTHING;', ';');
  expect(mutant).not.toBe(original); // a string moved → this mutant stopped mutating anything
  return mutant;
}

test('⛔ the case-collision hazard is REAL: with BOTH guards removed the statement raises', async () => {
  // This is the case the two guards exist for, and it is asserted rather than reasoned about
  // because a raise inside the runner's single transaction aborts the boot and crash-loops the pod
  // (the 0077 scar in src/db/migration-runner.ts). Without it, the two tests below would be
  // proving that guards prevent a problem that never existed.
  // ⚠️ try/catch, NOT `await expect(...).rejects.toThrow(...)`. Measured on bun 1.3.14: `.rejects`
  // never settles against a postgres.js PendingQuery — the process spins at ~98% CPU indefinitely,
  // and because bun buffers stdout when it is redirected the whole file looks like it produced no
  // output rather than like it hung on one line. Cost 7+ minutes to find; do not "tidy" it back.
  let raised: unknown;
  try {
    await scratch.unsafe(mutantWithout({ distinctOn: true, onConflict: true }));
  } catch (err) {
    raised = err;
  }
  expect(raised).toBeDefined();
  expect(String((raised as Error).message)).toMatch(/signup_approvals_pending_email|duplicate key/i);
});

test('EITHER guard alone is sufficient — ON CONFLICT DO NOTHING absorbs an intra-statement dup', async () => {
  // ⚠️ MEASURED, NOT ASSUMED, and the migration's header says so: `ON CONFLICT DO NOTHING` skips a
  // row that collides with one inserted EARLIER IN THE SAME COMMAND (speculative insertion — the
  // documented difference from DO UPDATE, which errors). So DISTINCT ON is NOT what stops the
  // raise, and no comment in this repo may claim it is. What DISTINCT ON buys is determinism, and
  // that is what the next test pins.
  await scratch.unsafe(mutantWithout({ distinctOn: true }));
  expect(await approvalsFor(E_DUP_LOWER)).toHaveLength(1);
});

test('EITHER guard alone is sufficient — DISTINCT ON collapses the pair before the index sees it', async () => {
  await scratch.unsafe(mutantWithout({ onConflict: true }));
  expect(await approvalsFor(E_DUP_LOWER)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// ⛔ Idempotence — this file is read at every boot until `_migrations` records it.
// ---------------------------------------------------------------------------

test('⛔ 0088 is idempotent: a second apply inserts nothing and re-touches no row', async () => {
  await runMigration();
  const after1 = await approvalsSnapshot();
  await runMigration();
  const after2 = await approvalsSnapshot();
  expect(after2).toEqual(after1); // ids AND xmin — no insert, no update, no churn
  // FIVE rows, not six: the census counts USERS (6 live tenant-less users), while the table holds
  // one row per lower(email) — and the case-colliding pair shares one. Measured, not assumed.
  const total = (await scratch.unsafe(
    `SELECT count(*)::int AS n FROM signup_approvals`,
  )) as unknown as { n: number }[];
  expect(total[0]!.n).toBe(5);
});

test('0088 is a no-op on a database with nobody stranded', async () => {
  await scratch.unsafe('DELETE FROM signup_approvals');
  await scratch.unsafe(`UPDATE users SET tenant_id = $1 WHERE deleted_at IS NULL`, [TENANT]);
  await runMigration();
  const total = (await scratch.unsafe(
    `SELECT count(*)::int AS n FROM signup_approvals`,
  )) as unknown as { n: number }[];
  expect(total[0]!.n).toBe(0);
  expect((await census()).unqueued).toBe(0);
});
