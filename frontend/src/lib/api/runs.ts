// src/lib/api/runs.ts — typed client for /api/runs over authFetch. start() kicks
// a run (returns the runId; progress arrives via the SSE stream — see
// services/sse.ts), get() reads the persisted run for a post-hoc trace view.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage } from './parse';
import { graphIssuesFrom } from './graph-issues';
import { dataFindingsFrom, type DataValidationReport } from './data-findings';
import type { FlowRun } from '$lib/types/trace';
import type { DataValidationFinding, GraphIssue } from '$lib/types/flows';

export interface RunStartErrorDetails {
  issues?: unknown[];
  findings?: unknown[];
  policyKey?: string;
  requestId?: string;
  sandboxId?: string;
  suspensionReason?: 'idle' | 'admin' | null;
  resumable?: boolean;
  [key: string]: unknown;
}

export class RunApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: RunStartErrorDetails = {},
  ) {
    super(message);
    this.name = 'RunApiError';
  }
}

/**
 * The actionable per-node issues carried by a failed `runsApi.start()`, or `[]` when there are none.
 *
 * `POST /api/runs` answers a graph that will not run with
 * `unprocessable('flow_invalid', 'The flow is not ready to run.', { issues })`
 * (backend/src/host/run-controller.ts). Every caller used to render only the top-level message, so a
 * tester was told the flow "is not ready" and never which node — the one thing the backend had
 * already computed for them.
 *
 * Deliberately NOT gated on `e.code === 'flow_invalid'`. The code is the backend's routing label,
 * not a promise about the body: any 4xx that ships `details.issues` is telling the user something
 * per-node, and gating on one code would drop the rest for no gain. The structural guard already
 * ensures nothing malformed is rendered, so an unexpected code costs nothing and a future
 * issue-carrying code works with no frontend change.
 *
 * The reading + structural guard now live in `./graph-issues` because `POST /api/solutions` answers
 * an unpublishable graph with the identical body (`solutionErrorIssues` in `./solutions`), and one
 * shape read by one guard is the point.
 */
export function runErrorIssues(e: unknown): GraphIssue[] {
  if (!(e instanceof RunApiError)) return [];
  return graphIssuesFrom(e.details);
}

/**
 * The data-contract violations behind a REFUSED run, or `[]` when there are none.
 *
 * `POST /api/runs` answers a run whose injected test data fails the ontology contract with
 * `unprocessable('data_validation_failed', …, { findings })` — but ONLY when the governance policy
 * `data.validation_mode` is `block`. Under the shipped default, `warn`, the same findings ride the
 * SUCCESS body instead (`dataValidation` on the 201), which is why this has a partner in
 * `data-findings.dataValidationFrom` rather than being the only reader.
 *
 * Same deliberate non-gating as `runErrorIssues`: not conditioned on
 * `e.code === 'data_validation_failed'`, because the code is the backend's routing label and not a
 * promise about the body. The structural guard is what keeps a Zod issue or a GraphIssue out of the
 * list, so an unexpected code costs nothing and a future finding-carrying code works untouched.
 */
export function runErrorDataFindings(e: unknown): DataValidationFinding[] {
  if (!(e instanceof RunApiError)) return [];
  return dataFindingsFrom(e.details);
}

/**
 * A started run, plus the data-contract violations it started DESPITE.
 *
 * `dataValidation` is present only when there were findings — see the conditional spread in
 * backend/src/host/run-controller.ts. A clean run's body is byte-for-byte what it always was, so
 * every caller that ignores this field keeps compiling and keeps working.
 */
export interface RunStarted {
  runId: string;
  status: string;
  sandboxId?: string;
  idempotent?: boolean;
  dataValidation?: DataValidationReport;
  /** W8/P4: present on a sample test — which step read which sample data. */
  sampleTest?: unknown;
}

export interface MySandbox {
  id: string;
  slug: string;
  status: 'running' | 'idle' | 'suspended' | 'error';
  suspensionReason: 'idle' | 'admin' | null;
  isPrimary: boolean;
  region: string;
}

async function unwrap<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = parseBody(text);
  if (!res.ok) {
    throw new RunApiError(
      res.status,
      body?.error ?? 'error',
      body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
      { ...(body?.details ?? {}), ...body, requestId: body?.requestId },
    );
  }
  return body as T;
}

export const runsApi = {
  /** `sampleChallengeId` (W8/P4): run on that challenge's linked sample data, bound by the server. */
  async start(flowId: string, opts?: { sampleChallengeId?: string }): Promise<RunStarted> {
    return unwrap(
      await authFetch('/api/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(
          opts?.sampleChallengeId ? { flowId, sampleChallengeId: opts.sampleChallengeId } : { flowId },
        ),
      }),
    );
  },

  async startSolution(solutionId: string): Promise<RunStarted> {
    return unwrap(
      await authFetch('/api/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ solutionId }),
      }),
    );
  },

  async getMySandbox(): Promise<MySandbox | null> {
    return unwrap(await authFetch('/api/sandboxes/me'));
  },

  async resumeMySandbox(): Promise<MySandbox> {
    return unwrap(await authFetch('/api/sandboxes/me/resume', { method: 'POST' }));
  },

  async get(runId: string): Promise<FlowRun> {
    return unwrap(await authFetch(`/api/runs/${encodeURIComponent(runId)}`));
  },
};
