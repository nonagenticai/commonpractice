// tests/pipeline-solution-status-guard.test.ts — the "a write that changed nothing must not report
// success" guard, driven directly.
//
// ⛔ WHY THIS FILE EXISTS. The cross-tenant promote defect had TWO halves: the write ran under the
// operator's own tenant GUC (so it matched zero `solutions` rows), and the zero-row result was
// discarded (so the route answered 200 `live:true` and wrote a `deploy.production` audit row while
// the owning tenant's marketplace still showed the solution in voting). The fix addressed both —
// `runAsSystem` for the scope, and this assert for the honesty.
//
// An adversarial review then deleted the `throw` on its own and ran the entire pipeline suite:
// `pipeline-cross-tenant-solution.test.ts` 4/0 and `pipeline.test.ts` 29/0 — GREEN. The original
// evidence only ever removed the assert TOGETHER with `runAsSystem`, which proves the combination,
// not the assert. The scope half is what makes today's zero-row case impossible, so with it in
// place nothing can reach this branch through a route: `pipeline_items.solution_id` is an FK with
// `ON DELETE SET NULL`, so a deleted solution nulls the card and the route never calls in.
//
// That is precisely why it is driven directly here. The branch guards a row that vanishes
// mid-request — unstageable through HTTP, and the reason the guard is worth having is that if the
// scope half ever regresses, THIS is what turns the regression into a 500 instead of a silent
// 200. A guard whose only proof is "it was removed alongside something else" is not proven.
import { test, expect } from 'bun:test';
import { setSolutionStatus } from '../src/routes/pipeline';
import { HttpError } from '../src/utils/http';

/** A writer whose UPDATE reports the rowcount we want, with no database involved. */
function writerReturning(rows: { id: string }[]) {
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => rows,
        }),
      }),
    }),
  } as unknown as Parameters<typeof setSolutionStatus>[0];
}

const SOLUTION = '00000000-0000-0000-0000-0000000c5501';

test('a status write that matched NO row throws — it must never report success', async () => {
  let thrown: unknown;
  try {
    await setSolutionStatus(writerReturning([]), SOLUTION, 'shipping');
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  const e = thrown as HttpError;
  expect(e.status).toBe(500);
  expect(e.code).toBe('solution_status_write_lost');
  // The message must name the solution and the status a reader is looking for in the logs.
  expect(e.message).toContain(SOLUTION);
  expect(e.message).toContain('shipping');
});

test('the rollback direction is guarded too, not just the promote', async () => {
  let thrown: unknown;
  try {
    await setSolutionStatus(writerReturning([]), SOLUTION, 'voting');
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).message).toContain('voting');
});

test('a write that DID move a row returns normally — the guard is not a blanket refusal', async () => {
  await setSolutionStatus(writerReturning([{ id: SOLUTION }]), SOLUTION, 'shipping');
  // no throw === pass; asserted explicitly so the case cannot be read as vacuous
  expect(true).toBe(true);
});
