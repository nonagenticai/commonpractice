// src/host/solution-demo.ts — the ONE definition of "how long does this solution's live demo take".
//
// WHY THIS FILE EXISTS. `solutions.demo_seconds` was a SEEDED CONSTANT. The five demo solutions
// carried 84/73/90/88/65 because someone typed those numbers into `seed-marketplace.ts`; every
// solution a real person submitted through Build → Submit had it NULL, and the marketplace board
// then hid the figure behind a truthiness check so the invention was indistinguishable from the
// absence. The demo timing is MEASURABLE — the product runs the thing — so it is measured here.
//
// The measurement is the most recent SUCCESSFUL run stamped to this solution: `flow_runs.solution_id`
// (migration 0065), written by `POST /api/runs {solutionId}`, which IS the "Try it" button on the
// solution page.
//
// ⛔ NOT A `flow_id` JOIN. This was considered and rejected, and re-deriving it that way would be a
// regression, not a simplification:
//   • `routes/flows.ts:119-126` lets a `submitted` flow keep being edited while
//     `solutions.published_graph` is frozen by the 0055 trigger, so a run found through `flow_id`
//     may have executed a graph that is not the published one — possibly one predating the solution.
//   • One flow can back SEVERAL solutions (`routes/flows.ts:165-167` uses `.limit(1)` for exactly
//     that reason), so a `flow_id` join reports a SIBLING solution's demo as this one's.
//   • Draft `/build` runs share the same `flow_id` bucket as published demos.
// `backend/tests/solutions.test.ts` pins this with a two-solutions-on-one-flow case; that test is
// the whole argument, and switching the key back to `flow_id` is what turns it red.
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db as defaultDb, flowRuns } from '../db/client';

type Db = typeof defaultDb;
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The duration of each solution's most recent successful demo run, in MILLISECONDS.
 *
 * ABSENT FROM THE MAP MEANS ABSENT — the caller must ship `null`, never `0`. A solution nobody has
 * run yet has no demo time; claiming `0` would put "0ms" beside it on the board, which is not a
 * smaller version of the truth but a different and more confident claim than "we don't know".
 *
 * ⛔ `total_ms IS NOT NULL` IS LOAD-BEARING, NOT DEFENSIVE PADDING. `RunHandle.totalMs` starts
 * `null` (`run-controller.ts:195`) and is only ever assigned from the `run_complete` trace frame
 * (`run-controller.ts:500`); `finalize` then persists whatever it holds. A run that ended without
 * that frame — runner killed, stream truncated, reconciler sweeping a stale lease — is therefore a
 * row with a terminal status and a NULL duration. Without this predicate such a row would coalesce
 * to `0` downstream and the board would advertise an instantaneous demo.
 *
 * ⛔ NO `triggered_by` FILTER, DELIBERATELY. A demo timed by someone ELSE is still this solution's
 * demo: the number describes the SOLUTION, not the viewer. Elsewhere in this codebase runs are
 * scoped to the caller — but that is for TRACE privacy (a trace carries the runner's own inputs,
 * outputs and dataset rows), and a DURATION carries none of that. Filtering here would make the
 * figure disappear on every page except the author's own, which is the seeded-constant problem
 * again in a new costume. This is not an oversight; do not "tighten" it.
 *
 * ⛔ Runs under the CALLER'S `db` (RLS), never `runAsSystem`. `flow_runs` is tenant-scoped and a
 * cross-tenant duration on a tenant's own board is a leak, not a spare number.
 */
export async function demoMsForSolutions(
  ids: string[],
  tenantId: string | null,
  database: DbOrTx = defaultDb,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;

  // DISTINCT ON over the id set — one index scan, one row per solution, no correlated subquery per
  // row. `status = 'ok'` is the SUCCESS value of the `flow_run_status` enum ('running' | 'ok' |
  // 'partial' | 'failed'); there is no 'succeeded'. `partial` is excluded on purpose: a run that
  // half-failed is not a demo whose duration belongs beside a solution.
  //
  // ORDER BY `finished_at DESC NULLS LAST, id DESC`: newest first, and a terminal row that somehow
  // never got a `finished_at` sorts last rather than winning the tie by accident. `id DESC` breaks
  // exact-timestamp ties totally (ids are UUIDv7, so it is also newest-first) — without it two runs
  // finishing in the same millisecond make the answer nondeterministic between requests.
  const rows = await database
    .selectDistinctOn([flowRuns.solution_id], {
      solutionId: flowRuns.solution_id,
      totalMs: flowRuns.total_ms,
    })
    .from(flowRuns)
    .where(
      and(
        inArray(flowRuns.solution_id, ids),
        eq(flowRuns.status, 'ok'),
        isNotNull(flowRuns.total_ms),
        // ⛔ BELT AND BRACES, AND IT IS THIS FILE'S OWN NEIGHBOURS' CONVENTION — not paranoia.
        // Two lines from the `/api/winner` call site, `marketplace-summary.ts` passes
        // `callerTenantId` into BOTH `weekSolutionStats` and `eligibleForWeek`, and says why in a
        // comment: RLS already scopes the read, and the explicit predicate is carried anyway.
        // The first draft of this helper filtered on the id set alone and relied ENTIRELY on RLS.
        // Measured under the runtime role that was fine — but it is one `runAsSystem` wrapper away
        // from a cross-tenant duration on a tenant's own board, and the backend suite runs as the
        // RLS-BYPASSING OWNER, so no test here could ever have caught that. `null` means "no
        // explicit predicate", which is only correct when something else is doing the scoping.
        ...(tenantId ? [eq(flowRuns.tenant_id, tenantId)] : []),
      ),
    )
    .orderBy(
      flowRuns.solution_id,
      sql`${flowRuns.finished_at} desc nulls last`,
      desc(flowRuns.id),
    );

  for (const row of rows) {
    if (row.solutionId != null && row.totalMs != null) out.set(row.solutionId, row.totalMs);
  }
  return out;
}
