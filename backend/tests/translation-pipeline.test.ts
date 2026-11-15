// tests/translation-pipeline.test.ts — Phase 2-G deep i18n content pipeline.
// Unit (pure helpers) + integration (real CI/dev Postgres :5433). The batch engine is
// driven through its injectable `translate` seam (a deterministic fake) rather than through the
// broker's GLOBAL override singleton.
//
// ⚠️ CORRECTED 2026-08-16 — the reason given here used to be "bun runs test files concurrently",
// which is FALSE (`--parallel` is opt-in and implies `--isolate`; CI runs a plain `bun run test`;
// file durations are additive). See the canonical note at the top of
// tests/metering-platform-calls.test.ts. The seam is kept for the reason that survives: a
// multi-await drain through the real broker would hold work across `await` points, and work that
// outlives the test that started it is exactly what tears the NEXT test's fixtures down (the
// `usage_counters_user_id_fkey` fingerprint). A deterministic fake finishes when the drain does.
// The real translateText→broker path is proven live in the G9 verification (the in-cluster
// inference-router / stub).
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, desc, eq, gt, inArray, like, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerTranslationRoutes } from '../src/routes/translations';
import {
  db,
  users,
  tenants,
  auditLog,
  buildingBlocks,
  blockVersions,
  translationJobs,
  contentTranslations,
} from '../src/db/client';
import { blockI18nKey } from '../src/blocks/i18n-key';
import { publishVersionCore } from '../src/blocks/authoring-service';
import {
  sourceHash,
  enqueueTranslations,
  processPendingBatch,
  backfillTranslations,
  CapReached,
  TARGET_LOCALES,
  LOCALE_NAMES,
  type TranslateFn,
} from '../src/host/translation-service';
import { msUntilNextDrain } from '../src/host/translation-scheduler';
import { SUPPORTED_LOCALES } from '../src/utils/locale';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';
import { requireScannedSource } from '../src/blocks/source-gate';

const UID = '00000000-0000-0000-0000-00007a000001';
const admin: User = { id: UID, email: 'transtest@test', name: 'Tess Trans', roles: ['super_admin'] };
const EID = 'ZTRANSTEST-c1'; // text entity_id; the cleanup key
// A SECOND actor + entity for the per-actor cap-isolation cases below. Both stay under the SAME
// `00007a…` / `ZTRANSTEST` fixture prefixes this file already owns, so `cleanup()` keeps working
// and tests/fixture-id-collisions.test.ts stays satisfied.
const UID_B = '00000000-0000-0000-0000-00007a000002';
const EID_B = 'ZTRANSTEST-c2';

const router = new Router();
registerTranslationRoutes(router);

/** A deterministic translator: echoes the source text tagged so assertions are exact. */
const echo: TranslateFn = async (text) => `T:${text}`;

async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  // processPendingBatch drains the WHOLE pending queue (global by design). Files share ONE
  // database (they do NOT run concurrently — corrected 2026-08-16, see this file's header), and
  // the challenges/solutions/blocks route tests enqueue jobs as a side effect of the G4 hooks, so
  // whatever they left behind is still sitting there when we run → orphaned pending jobs from an
  // EARLIER file would land in our drains.
  // Clearing the table here (no other test READS translation_jobs) keeps each drain
  // scoped to this file's jobs. Assertions are additionally entity-scoped to EID.
  await db.delete(translationJobs);
  await db.delete(contentTranslations).where(like(contentTranslations.entity_id, 'ZTRANSTEST%'));
  await db.delete(users).where(inArray(users.id, [UID, UID_B]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  await cleanup();
  await db
    .insert(users)
    .values([
      { id: UID, email: admin.email, name: admin.name, tenant_id: DEMO_TENANT_ID },
      { id: UID_B, email: 'transtest-b@test', name: 'Bee Trans', tenant_id: DEMO_TENANT_ID },
    ])
    .onConflictDoNothing({ target: users.id });
  __setAuthOverridesForTests({ validateAuth: async () => admin, requireRole: async () => admin });
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

// ---- unit (pure) ----

test('sourceHash is deterministic + differs on change', () => {
  expect(sourceHash('hello')).toBe(sourceHash('hello'));
  expect(sourceHash('hello')).not.toBe(sourceHash('hello!'));
});

test('TARGET_LOCALES = the 7 non-en locales, all named', () => {
  expect(TARGET_LOCALES).toHaveLength(SUPPORTED_LOCALES.length - 1);
  expect(TARGET_LOCALES).not.toContain('en');
  for (const l of TARGET_LOCALES) expect(LOCALE_NAMES[l]).toBeTruthy();
});

test('msUntilNextDrain = interval minutes in ms (floored at 1 min)', () => {
  expect(msUntilNextDrain(5)).toBe(5 * 60_000);
  expect(msUntilNextDrain(0)).toBe(60_000);
});

// ---- integration ----

test('enqueue creates one pending job per field × target locale (idempotent)', async () => {
  const n = await enqueueTranslations(
    'challenge',
    EID,
    [
      { field: 'title', value: 'English title' },
      { field: 'description', value: 'English description' },
      { field: 'business_impact', value: '' }, // empty → skipped
    ],
    UID,
  );
  expect(n).toBe(2 * TARGET_LOCALES.length); // 2 non-empty fields × 7 locales

  const jobs = await db.select().from(translationJobs).where(eq(translationJobs.entity_id, EID));
  expect(jobs).toHaveLength(2 * TARGET_LOCALES.length);
  expect(jobs.every((j) => j.status === 'pending')).toBe(true);

  // Re-enqueue the SAME values → no reset (hash guard), still the same job count.
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'English title' }], UID);
  const again = await db.select().from(translationJobs).where(eq(translationJobs.entity_id, EID));
  expect(again).toHaveLength(2 * TARGET_LOCALES.length);
});

test('drain translates every pending cell + UPSERTs content_translations; second drain is a no-op', async () => {
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'Hello' }], UID);
  const r1 = await processPendingBatch(new Date(), db, 100, echo);
  expect(r1.processed).toBeGreaterThanOrEqual(TARGET_LOCALES.length);

  const tx = await db
    .select()
    .from(contentTranslations)
    .where(eq(contentTranslations.entity_id, EID));
  expect(tx).toHaveLength(TARGET_LOCALES.length);
  expect(tx.every((t) => t.value === 'T:Hello')).toBe(true);
  const jobs = await db.select().from(translationJobs).where(eq(translationJobs.entity_id, EID));
  expect(jobs.every((j) => j.status === 'done')).toBe(true);

  // No pending left → a second drain does nothing.
  const r2 = await processPendingBatch(new Date(), db, 100, echo);
  expect(r2.processed).toBe(0);
});

test('editing a field re-enqueues only that cell and re-translates', async () => {
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'V1' }], UID);
  await processPendingBatch(new Date(), db, 100, echo);

  // Edit → new value, new hash → the 7 title cells reset to pending.
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'V2' }], UID);
  const pending = await db
    .select()
    .from(translationJobs)
    .where(and(eq(translationJobs.entity_id, EID), eq(translationJobs.status, 'pending')));
  expect(pending).toHaveLength(TARGET_LOCALES.length);

  await processPendingBatch(new Date(), db, 100, echo);
  const tx = await db
    .select()
    .from(contentTranslations)
    .where(eq(contentTranslations.entity_id, EID));
  expect(tx.every((t) => t.value === 'T:V2')).toBe(true);
});

test('a CapReached from translate DEFERS the batch — jobs stay pending, no content written', async () => {
  const capped: TranslateFn = async () => {
    throw new CapReached('daily LLM call cap reached');
  };
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'Hello' }], UID);
  const r = await processPendingBatch(new Date(), db, 100, capped);
  expect(r.processed).toBe(0);
  expect(r.deferred).toBeGreaterThan(0);

  const jobs = await db.select().from(translationJobs).where(eq(translationJobs.entity_id, EID));
  expect(jobs.every((j) => j.status === 'pending')).toBe(true);
  const tx = await db.select().from(contentTranslations).where(eq(contentTranslations.entity_id, EID));
  expect(tx).toHaveLength(0);
});

// ---- per-actor cap isolation (the 608-job stall) ----
//
// ⛔ WHY THE INJECTED `TranslateFn` SEAM IS KEPT AND NOT REPLACED BY THE REAL BROKER. FOURTEEN test
// files share the ONE global `__setBrokerDepsForTests` singleton against ONE database. ⚠️ Bun does
// NOT run them concurrently — see the corrected header of this file and the canonical note in
// tests/metering-platform-calls.test.ts — so the seam is not here to dodge a race. It is here
// because a multi-await drain through the real broker holds broker work across `await` points, and
// work that outlives its own test is what tears the next test's fixtures down. The BROKER half of 0061
// (platform calls bypass the daily cap, count into platform_llm_calls, still hit the weekly
// ceiling) is proven directly in tests/metering-platform-calls.test.ts. What is proven HERE is the
// DRAINER's response to a cap, which is a different mechanism and needs no provider at all.
//
// THE BUG. `processPendingBatch` used to `break` out of the whole batch on the first CapReached.
// The pending select is `ORDER BY created_at`, so a capped actor's jobs sort FIRST and keep
// sorting first — one capped actor was therefore a total outage for every other tenant's queued
// content, forever. In prod that was 608 jobs behind one user, and it is why block descriptions
// render English in all 8 locales.

/** Force a strict created_at ordering. Two statements are NOT guaranteed distinct `now()`s (they
 *  can share a transaction timestamp, and the column has second-or-better resolution but no
 *  monotonicity guarantee across fast inserts), and this file's whole point is which job the
 *  drainer reaches FIRST. So the order is written explicitly rather than hoped for. */
async function orderJobs(entityId: string, minutesAgo: number): Promise<void> {
  await db
    .update(translationJobs)
    .set({ created_at: sql`now() - (${minutesAgo} || ' minutes')::interval` })
    .where(eq(translationJobs.entity_id, entityId));
}

test('one capped actor does NOT stall another actor\'s jobs', async () => {
  // REVERT THAT TURNS THIS RED: restore the `break` in processPendingBatch's CapReached branch.
  // Actor A sorts first, caps on its very first job, and the batch stops — `processed` drops from
  // 7 to 0 and none of B's jobs are ever reached.
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'A-source' }], UID);
  await enqueueTranslations('challenge', EID_B, [{ field: 'title', value: 'B-source' }], UID_B);
  await orderJobs(EID, 120); // A strictly first…
  await orderJobs(EID_B, 60); // …B strictly second.

  const perActor: TranslateFn = async (text, _locale, actorUserId) => {
    if (actorUserId === UID) throw new CapReached('weekly spend ceiling reached ($1)');
    return `T:${text}`;
  };

  const r = await processPendingBatch(new Date(), db, 100, perActor);

  expect(r.processed, "the uncapped actor's jobs must all drain").toBe(TARGET_LOCALES.length);
  expect(r.deferred, "the capped actor's jobs are deferred, not lost").toBe(TARGET_LOCALES.length);
  expect(r.failed).toBe(0);
  expect(r.cappedActors, 'exactly one (tenant, actor) pair hit a cap').toBe(1);

  const aJobs = await db.select().from(translationJobs).where(eq(translationJobs.entity_id, EID));
  expect(aJobs).toHaveLength(TARGET_LOCALES.length);
  expect(aJobs.every((j) => j.status === 'pending')).toBe(true);

  const bJobs = await db.select().from(translationJobs).where(eq(translationJobs.entity_id, EID_B));
  expect(bJobs).toHaveLength(TARGET_LOCALES.length);
  expect(bJobs.every((j) => j.status === 'done')).toBe(true);

  const aTx = await db
    .select()
    .from(contentTranslations)
    .where(eq(contentTranslations.entity_id, EID));
  expect(aTx, 'a capped actor writes no content').toHaveLength(0);
  const bTx = await db
    .select()
    .from(contentTranslations)
    .where(eq(contentTranslations.entity_id, EID_B));
  expect(bTx).toHaveLength(TARGET_LOCALES.length);
  expect(bTx.every((t) => t.value === 'T:B-source')).toBe(true);
});

test('a capped actor is tried ONCE per tick, then skipped without burning attempts', async () => {
  // TWO REVERTS, EACH TURNS THIS RED IN A DIFFERENT PLACE:
  //   1. delete the `if (capped.has(...)) { out.deferred += 1; continue; }` pre-check — the
  //      drainer then re-asks the broker for every one of the 7 jobs and `invocations` is 7. In
  //      prod that is 608 pointless metered round-trips per tick, every tick, forever.
  //   2. route the CapReached through `markFailed` instead — `attempts` becomes 1 on every job,
  //      and three capped ticks would flip healthy, never-attempted content to 'failed'.
  //      A cap is NOT a job failure: nothing is wrong with the job.
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'A-source' }], UID);
  expect(TARGET_LOCALES.length, 'this case needs ≥7 jobs behind the one capped actor')
    .toBeGreaterThanOrEqual(7);

  let invocations = 0;
  const alwaysCapped: TranslateFn = async () => {
    invocations += 1;
    throw new CapReached('weekly spend ceiling reached ($1)');
  };

  const r = await processPendingBatch(new Date(), db, 100, alwaysCapped);

  expect(invocations, 'the capped actor must be asked exactly once, not once per job').toBe(1);
  expect(r.deferred).toBe(TARGET_LOCALES.length);
  expect(r.cappedActors).toBe(1);
  expect(r.processed).toBe(0);
  expect(r.failed).toBe(0);

  const jobs = await db.select().from(translationJobs).where(eq(translationJobs.entity_id, EID));
  expect(jobs).toHaveLength(TARGET_LOCALES.length);
  expect(jobs.every((j) => j.attempts === 0), 'a cap must not consume a retry').toBe(true);
  expect(jobs.every((j) => j.status === 'pending')).toBe(true);
});

test('a PURE-DEFER tick writes a NO PROGRESS audit row', async () => {
  // REVERT THAT TURNS THIS RED: restore the `processed > 0 || failed > 0` guard on the audit
  // block. A tick that did nothing but defer then writes NOTHING — which is precisely how a
  // 608-job backlog stayed invisible until someone noticed English text in the Dutch UI. The one
  // outcome that needs an operator was the one outcome that left no trace.
  // ⛔ THE MARKER COMES FROM THE DATABASE'S CLOCK, NOT THIS PROCESS'S, AND THAT IS THE WHOLE POINT.
  // `audit_log.created_at` is `defaultNow()` — generated by Postgres. Marking `new Date()` here and
  // then filtering `created_at > t0` compares two DIFFERENT clocks. Measured on this host, the
  // Postgres container runs 1–2 ms BEHIND the Node process:
  //     skew(pg_now - js) = -1ms, -1ms, -2ms, -1ms
  // This test body completes in ~5 ms, so whenever the write lands inside that skew window the
  // audit row is stamped at or before `t0`, the filter excludes it, and the assertion below reads
  // ZERO rows — a failure that has nothing to do with the behaviour under test. Measured on merged
  // main: 2 of 4 full-suite runs on a FRESH database. It never reproduces in isolation or in a
  // 3-file subset, because those runs are slower and clear the skew.
  // `db.execute` hands the timestamp back as a STRING, and the `gt()` below feeds it through
  // drizzle's timestamp mapper, which calls `.toISOString()` — so it has to become a Date here.
  const [row0] = (await db.execute(
    sql`select clock_timestamp() as t0`,
  )) as unknown as Array<{ t0: string | Date }>;
  const t0 = new Date(row0!.t0);
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'A-source' }], UID);
  const alwaysCapped: TranslateFn = async () => {
    throw new CapReached('weekly spend ceiling reached ($1)');
  };

  const r = await processPendingBatch(new Date(), db, 100, alwaysCapped);
  expect(r.processed).toBe(0);
  expect(r.failed).toBe(0);
  expect(r.cappedActors).toBe(1);

  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'translation.batch'), gt(auditLog.created_at, t0)))
    .orderBy(desc(auditLog.created_at))
    .limit(1);
  expect(rows, 'a pure-defer tick MUST leave an audit trail').toHaveLength(1);
  expect(rows[0]!.result_tone).toBe('warn');
  expect(rows[0]!.result).toMatch(/NO PROGRESS/);
  expect((rows[0]!.metadata as { cappedActors?: number }).cappedActors).toBe(1);
});

test('a hard translate error marks the job failed after maxAttempts', async () => {
  const boom: TranslateFn = async () => {
    throw new Error('provider exploded');
  };
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'Hello' }], UID);
  // maxAttempts defaults to 3 → drain 3× to exhaust, then the job is 'failed'.
  for (let i = 0; i < 3; i++) await processPendingBatch(new Date(), db, 100, boom);
  const jobs = await db.select().from(translationJobs).where(eq(translationJobs.entity_id, EID));
  expect(jobs.every((j) => j.status === 'failed')).toBe(true);
  expect(jobs.every((j) => j.attempts >= 3)).toBe(true);
  expect(jobs[0]!.error).toContain('provider exploded');
});

// ---- admin routes (broker-free: queue/jobs/override touch no LLM; run is shape-only) ----

test('queue route backfills, jobs route surfaces stats, override writes a translation', async () => {
  // Seed jobs directly, then read + override via the routes.
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'Routed' }], UID);
  await processPendingBatch(new Date(), db, 100, echo); // mark them done so stats has 'done'

  const jobs = await call('GET', '/api/admin/translations/jobs?status=done');
  expect(jobs.status).toBe(200);
  expect(jobs.json.stats.byStatus.done).toBeGreaterThanOrEqual(TARGET_LOCALES.length);
  expect(Array.isArray(jobs.json.jobs)).toBe(true);

  const [job] = await db
    .select()
    .from(translationJobs)
    .where(eq(translationJobs.entity_id, EID))
    .limit(1);
  const ov = await call('PATCH', `/api/admin/translations/${job!.id}`, { value: 'manual-override' });
  expect(ov.status).toBe(200);
  const [t] = await db
    .select()
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_id, EID),
        eq(contentTranslations.locale, job!.target_locale),
        eq(contentTranslations.field, job!.field),
      ),
    );
  expect(t!.value).toBe('manual-override');
});

// ---- the jobs route carries the EXISTING translation (the override-editor data-loss fix) ----
//
// A job row holds `source_text` — the ENGLISH source — and never the translation; that lives one
// table over in `content_translations`. The override editor therefore had nothing to prefill with
// and opened an EMPTY box beside English prose on cells that were already translated (prod: 728
// jobs `done`, 0 pending, `nl` the primary demo locale), so every save replaced a good translation
// with whatever was typed and the operator never saw what they destroyed. The route now LEFT JOINs
// the value in as `current_value`. These tests live in THIS file, not a new one, for the reason
// stated further down: this file's `beforeEach` does a table-wide `DELETE FROM translation_jobs`,
// so any cross-file assertion on that table is a guaranteed flake.

/** The jobs the route returned for one entity, in the flat shape the frontend consumes. */
type JobRow = {
  entity_type: string;
  entity_id: string;
  field: string;
  target_locale: string;
  current_value: string | null;
  current_updated_at: string | null;
};
const rowsFor = (json: { jobs: JobRow[] }, entityId: string) =>
  json.jobs.filter((j) => j.entity_id === entityId);

// A status value NO other file uses. The jobs list is truncated at `jobsLimit` over the WHOLE
// table, which every file shares (they run one after another, NOT concurrently — corrected
// 2026-08-16, see this file's header), so an unfiltered read could push this file's rows out of
// the returned window whenever an earlier route test enqueued a burst of jobs and left it there —
// the assertions below would then fail for a reason that has nothing to do with the join.
// Re-stamping the status after the drain (the join does not look at `status`) makes `?status=`
// select exactly this file's fixture, and it also parks the untranslated job where no later or
// leaked drain can translate it out from under the null assertion.
const OWN_STATUS = 'ztranstest-join';

test('jobs route returns the translation each job ALREADY has, null when there is none', async () => {
  // EID: enqueued AND drained → a content_translations row exists for every one of its cells.
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'Hello' }], UID);
  await processPendingBatch(new Date(), db, 100, echo);
  // EID_B: enqueued and NEVER drained → no content_translations row at all.
  await enqueueTranslations('challenge', EID_B, [{ field: 'title', value: 'Untranslated' }], UID_B);
  await db
    .update(translationJobs)
    .set({ status: OWN_STATUS })
    .where(inArray(translationJobs.entity_id, [EID, EID_B]));

  const res = await call('GET', `/api/admin/translations/jobs?status=${OWN_STATUS}`);
  expect(res.status).toBe(200);
  expect(res.json.jobs).toHaveLength(2 * TARGET_LOCALES.length);

  const translated = rowsFor(res.json, EID);
  expect(translated).toHaveLength(TARGET_LOCALES.length);
  // The whole point: the value the editor must prefill with…
  expect(translated.every((j) => j.current_value === 'T:Hello')).toBe(true);
  expect(translated.every((j) => typeof j.current_updated_at === 'string')).toBe(true);
  // …which is emphatically NOT the English source the row already carried.
  expect(translated.every((j) => j.current_value !== 'Hello')).toBe(true);

  // NULL, not '' — `content_translations.value` is NOT NULL and the override route rejects an
  // empty string, so null is the ONLY "nothing stored yet" signal the editor can key its
  // empty-state off. An empty string here would make "never translated" indistinguishable from
  // "translated to blank", which is the ambiguity the fix exists to remove.
  const untranslated = rowsFor(res.json, EID_B);
  expect(untranslated).toHaveLength(TARGET_LOCALES.length);
  expect(untranslated.every((j) => j.current_value === null)).toBe(true);
  expect(untranslated.every((j) => j.current_updated_at === null)).toBe(true);
});

test('the LEFT JOIN cannot multiply rows — every one of the four key columns is bound', async () => {
  await enqueueTranslations('challenge', EID, [{ field: 'title', value: 'Hello' }], UID);
  await processPendingBatch(new Date(), db, 100, echo);
  await db
    .update(translationJobs)
    .set({ status: OWN_STATUS })
    .where(eq(translationJobs.entity_id, EID));
  const locale = TARGET_LOCALES[0]!;

  // Three DECOYS, each differing from the real row in exactly ONE join column. A join that
  // forgot that column would return a SECOND row for the same job — the list would grow and an
  // operator would be shown another entity's prose as "the current translation". Note none of
  // these can be a duplicate of the real row: content_translations is PRIMARY KEY
  // (entity_type, entity_id, locale, field) — migrations/0008_ai-substrate.sql:189 — which is
  // precisely why at most one row can ever match a fully-bound predicate. The decoys prove the
  // predicate IS fully bound; the PK proves one match is the ceiling.
  await db.insert(contentTranslations).values([
    { entity_type: 'solution', entity_id: EID, locale, field: 'title', value: 'DECOY-entity-type' },
    { entity_type: 'challenge', entity_id: EID, locale: 'zz', field: 'title', value: 'DECOY-locale' },
    { entity_type: 'challenge', entity_id: EID, locale, field: 'summary', value: 'DECOY-field' },
  ]);
  // …and one on a different entity_id, which is the fourth column.
  await db.insert(contentTranslations).values({
    entity_type: 'challenge',
    entity_id: `${EID}-other`,
    locale,
    field: 'title',
    value: 'DECOY-entity-id',
  });

  const res = await call('GET', `/api/admin/translations/jobs?status=${OWN_STATUS}`);
  const rows = rowsFor(res.json, EID);

  // Row count is EXACTLY the number of job rows for this entity — the join added none.
  const [jobCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(translationJobs)
    .where(eq(translationJobs.entity_id, EID));
  expect(rows).toHaveLength(jobCount!.n);
  expect(rows).toHaveLength(TARGET_LOCALES.length);
  // …and no decoy value leaked into any of them.
  expect(rows.every((j) => j.current_value === 'T:Hello')).toBe(true);
  expect(rows.some((j) => j.current_value?.startsWith('DECOY'))).toBe(false);
});

test('jobsTotal counts every matching job, not just the truncated first page', async () => {
  // The list is capped server-side and NOT paged, while the coverage matrix on the same screen
  // counts every job — 100 rows next to a total of 728, with nothing saying which is which.
  // `jobsTotal` is that count under the SAME filter as the rows.
  //
  // Same private-status trick as above (and a DIFFERENT marker, so the two tests cannot see each
  // other's rows): the count has to be exact rather than >= to mean anything, and a shared status
  // value would race the neighbouring files' real 'pending'/'done' jobs.
  const JOIN_STATUS = 'ztranstest-jobstotal';
  const probe = await call('GET', '/api/admin/translations/jobs');
  const limit: number = probe.json.jobsLimit;
  expect(limit).toBeGreaterThan(0);

  const overflow = limit + 1;
  await db.insert(translationJobs).values(
    Array.from({ length: overflow }, (_, i) => ({
      entity_type: 'challenge',
      entity_id: `${EID}-total-${i}`,
      field: 'title',
      target_locale: 'nl',
      source_text: `Overflow ${i}`,
      source_hash: sourceHash(`Overflow ${i}`),
      status: JOIN_STATUS,
    })),
  );

  const res = await call('GET', `/api/admin/translations/jobs?status=${JOIN_STATUS}`);
  expect(res.status).toBe(200);
  expect(res.json.jobs).toHaveLength(limit); // truncated…
  expect(res.json.jobsTotal).toBe(overflow); // …and the screen can say so.
  // The truncated rows still carry the joined column (null here — none are translated), so the
  // editor behaves identically on row 1 and row 100.
  expect(res.json.jobs.every((j: JobRow) => j.current_value === null)).toBe(true);
});

test('run route returns a 200 BatchResult (drives the real drain)', async () => {
  // Shape-only: the run route uses the REAL broker path (stub in test) — asserting exact
  // counts would race the shared broker global. The drain logic itself is covered above.
  const run = await call('POST', '/api/admin/translations/run');
  expect(run.status).toBe(200);
  expect(typeof run.json.processed).toBe('number');
  expect(typeof run.json.failed).toBe('number');
  expect(typeof run.json.deferred).toBe('number');
});

test('admin routes are platform-gated', async () => {
  const { UnauthorizedError } = await import('../src/types');
  __setAuthOverridesForTests({
    validateAuth: async () => ({ ...admin, roles: ['employee'] }),
    requireRole: async () => {
      throw new UnauthorizedError('Role required');
    },
  });
  const jobs = await call('GET', '/api/admin/translations/jobs');
  expect(jobs.status).toBe(403);
  // restore for afterAll
  __setAuthOverridesForTests({ validateAuth: async () => admin, requireRole: async () => admin });
});

// ---- block i18n keying (0060): the WRITE half of the tenant-leak fix ----
//
// The read half lives in tests/block-i18n-tenant-key.test.ts (route-level, under cp_app). This is
// the write half, and it lives HERE rather than there because this file owns `translation_jobs` —
// its `beforeEach` does an unconditional table-wide delete, so a cross-file assertion on that table
// from anywhere else is a guaranteed flake (bun runs files against ONE database).
//
// Why it matters: `translation_jobs` is UNIQUE (entity_type, entity_id, field, target_locale). With
// tenant blocks keyed by the BARE SLUG, two tenants publishing the same slug collided on the JOB
// row too — `enqueueTranslations`' onConflictDoUpdate overwrote the other tenant's source_text AND
// `requested_by`, so only one tenant's prose was ever translated and the LLM spend for it was
// metered against whoever published last.

const B60C_TENANT = '00000000-0000-0000-0000-00000b60c001';
const B60C_USER = '00000000-0000-0000-0000-00000b60c0a1';
const B60C_TENANT_BLOCK = '00000000-0000-0000-0000-00000b60c01a';
const B60C_GLOBAL_BLOCK = '00000000-0000-0000-0000-00000b60c02a';
const B60C_SLUG = 'ztranstest-b60c-tenant-block';
const B60C_GLOBAL_SLUG = 'ztranstest-b60c-global-block';

test('blockI18nKey: global keeps the bare slug, tenant is tenant-scoped (pure)', () => {
  expect(blockI18nKey({ tenant_id: null, slug: 'invoice-parser' })).toEqual({
    entityType: 'block',
    entityId: 'invoice-parser',
  });
  expect(blockI18nKey({ tenant_id: B60C_TENANT, slug: 'invoice-parser' })).toEqual({
    entityType: 'block_tenant',
    entityId: `${B60C_TENANT}:invoice-parser`,
  });
});

test('the admin backfill enqueues a TENANT block under block_tenant, a global one under block', async () => {
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.slug, [B60C_SLUG, B60C_GLOBAL_SLUG]));
  await db.delete(users).where(eq(users.id, B60C_USER));
  await db.delete(tenants).where(eq(tenants.id, B60C_TENANT));
  await db.insert(tenants).values({ id: B60C_TENANT, name: 'B60C', slug: 'b60c-tenant' });
  await db
    .insert(users)
    .values({ id: B60C_USER, email: 'b60c@test', name: 'B60C', tenant_id: B60C_TENANT });
  await db.insert(buildingBlocks).values([
    {
      id: B60C_TENANT_BLOCK, slug: B60C_SLUG, name: 'Tenant Block', description: 'tenant desc',
      category: 'logic', tenant_id: B60C_TENANT, maintainer_id: B60C_USER,
    },
    {
      id: B60C_GLOBAL_BLOCK, slug: B60C_GLOBAL_SLUG, name: 'Global Block', description: 'global desc',
      category: 'logic', tenant_id: null, maintainer_id: B60C_USER,
    },
  ]);

  try {
    await backfillTranslations({ entityType: 'block', entityId: B60C_SLUG }, B60C_USER);
    await backfillTranslations({ entityType: 'block', entityId: B60C_GLOBAL_SLUG }, B60C_USER);

    const jobs = await db
      .select({ entity_type: translationJobs.entity_type, entity_id: translationJobs.entity_id })
      .from(translationJobs)
      .where(like(translationJobs.entity_id, '%ztranstest-b60c%'));

    const tenantJobs = jobs.filter((j) => j.entity_type === 'block_tenant');
    const globalJobs = jobs.filter((j) => j.entity_type === 'block');

    // Both blocks have a non-empty name + description ⇒ 2 fields × 7 target locales each.
    expect(tenantJobs.length).toBe(TARGET_LOCALES.length * 2);
    expect(globalJobs.length).toBe(TARGET_LOCALES.length * 2);
    // ⛔ The tenant block's id must carry its tenant — a bare slug here is the leak.
    expect(new Set(tenantJobs.map((j) => j.entity_id))).toEqual(
      new Set([`${B60C_TENANT}:${B60C_SLUG}`]),
    );
    expect(new Set(globalJobs.map((j) => j.entity_id))).toEqual(new Set([B60C_GLOBAL_SLUG]));
  } finally {
    await db.delete(translationJobs).where(like(translationJobs.entity_id, '%ztranstest-b60c%'));
    await db.delete(buildingBlocks).where(inArray(buildingBlocks.slug, [B60C_SLUG, B60C_GLOBAL_SLUG]));
    await db.delete(users).where(eq(users.id, B60C_USER));
    await db.delete(tenants).where(eq(tenants.id, B60C_TENANT));
  }
}, 30_000);

// ---- the invariant that migration 0061 was going to carry ----
//
// ⛔ WHY THIS IS A TEST AND NOT A MIGRATION. 0061 was specced to delete the legacy bare-slug
// `content_translations` rows belonging to tenant blocks, guarded by a RAISE EXCEPTION if any
// legacy row lacked its `block_tenant` counterpart. It was RETIRED unwritten after measuring prod:
// `content_translations` holds ZERO rows with entity_type='block' and ZERO with 'block_tenant'
// (0060's orphan branch removed all 14 legacy rows, every one of which matched no live block
// slug). So 0061's DELETE would have matched nothing and its guard would have been VACUOUSLY
// satisfied — a migration that proves nothing, run against prod, is worse than no migration.
//
// The durable half of 0061 is the invariant, not the cleanup: a tenant-owned block must never get
// its translations filed under the bare slug, because that is precisely what let tenant B overwrite
// tenant A's document. `backfillTranslations` is already covered above. This covers the OTHER and
// primary write seam — `publishVersionCore`, which `authoring-service.ts:375-378` documents as the
// single path shared by the HTTP publish route and the MCP `publish_block` tool. Nothing tested it.
const B61_TENANT = '00000000-0000-0000-0000-00000b61c001';
const B61_USER = '00000000-0000-0000-0000-00000b61c0a1';
const B61_BLOCK = '00000000-0000-0000-0000-00000b61c01a';
const B61_VERSION = '00000000-0000-0000-0000-00000b61c01b';
const B61_SLUG = 'ztranstest-b61c-tenant-block';

test('publishing a TENANT block files its translations under block_tenant, never the bare slug', async () => {
  await db.delete(buildingBlocks).where(eq(buildingBlocks.slug, B61_SLUG));
  await db.delete(users).where(eq(users.id, B61_USER));
  await db.delete(tenants).where(eq(tenants.id, B61_TENANT));
  await db.insert(tenants).values({ id: B61_TENANT, name: 'B61C', slug: 'b61c-tenant' });
  await db
    .insert(users)
    .values({ id: B61_USER, email: 'b61c@test', name: 'B61C', tenant_id: B61_TENANT });
  const [block] = await db
    .insert(buildingBlocks)
    .values({
      id: B61_BLOCK, slug: B61_SLUG, name: 'B61 Tenant Block', description: 'b61 desc',
      category: 'logic', tenant_id: B61_TENANT, maintainer_id: B61_USER,
    })
    .returning();
  const [version] = await db
    .insert(blockVersions)
    .values({
      id: B61_VERSION, block_id: B61_BLOCK, version: '0.1.0', status: 'draft',
      source_ts: requireScannedSource('export default { async run(){ return {}; } };'),
      docs_md: 'B61 docs body',
      descriptor: { inputs: {}, outputs: {}, capabilities: {} },
    })
    .returning();

  try {
    // 'beta', not 'stable': the stable path additionally requires a passing block test
    // (block_publish.require_passing_tests), which is not what this test is about.
    // 'beta' skips the test gate, so `tenantId` is never read here — null states that plainly
    // rather than inventing a tenant this assertion does not depend on.
    await publishVersionCore(
      { userId: B61_USER, tenantId: null, isGlobal: false },
      block!,
      version!,
      'beta',
    );

    const jobs = await db
      .select({ entity_type: translationJobs.entity_type, entity_id: translationJobs.entity_id })
      .from(translationJobs)
      .where(like(translationJobs.entity_id, `%${B61_SLUG}%`));

    expect(jobs.length, 'publish must enqueue translation work').toBeGreaterThan(0);
    // THE INVARIANT. A single bare-slug row here is the cross-tenant leak reopening.
    expect(
      jobs.filter((j) => j.entity_type === 'block'),
      'a tenant block must NEVER be filed under the bare-slug key — that is the leak',
    ).toEqual([]);
    expect(new Set(jobs.map((j) => j.entity_type))).toEqual(new Set(['block_tenant']));
    expect(new Set(jobs.map((j) => j.entity_id))).toEqual(
      new Set([`${B61_TENANT}:${B61_SLUG}`]),
    );
  } finally {
    await db.delete(translationJobs).where(like(translationJobs.entity_id, `%${B61_SLUG}%`));
    await db.delete(buildingBlocks).where(eq(buildingBlocks.slug, B61_SLUG));
    await db.delete(users).where(eq(users.id, B61_USER));
    await db.delete(tenants).where(eq(tenants.id, B61_TENANT));
  }
}, 30_000);
