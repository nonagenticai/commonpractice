// src/services/delivery-payload.ts — Phase 5 (solution-to-delivery), the canonical mapping core.
//
// A pure, unit-testable mapper from a CP solution (+ its challenge, flow, datasets, ontology
// entities) to the target-neutral delivery payload (spec Part 3). The per-target adapters
// (5B Jira / 5C Azure DevOps / 5D fr) render this intermediate; keeping the mapping here means
// the title/description/acceptance-criteria/labels/provenance are identical across every target.
//
// No db, no I/O — the caller resolves the inputs (resolveChallengeDatasets /
// resolveChallengeEntities, the flow row) and hands them in. See SPEC-PHASE5 Part 3.
import type { Challenge, Solution, Flow } from '../db/schema';
import type { ChallengeDatasetOut } from '../challenges/challenge-data-service';
import type { DeliveryPayload } from '../db/delivery-types';

export interface BuildDeliveryPayloadInput {
  solution: Solution;
  challenge: Challenge;
  /** The built flow on the Build canvas, if the solution has one (spec §1.1: nullable). */
  flow: Flow | null;
  /** Resolved applicable datasets (resolveChallengeDatasets). */
  datasets: ChallengeDatasetOut[];
  /** Resolved ontology entity labels (resolveChallengeEntities). */
  entities: string[];
  /** The tenant_admin initiating the forward (user id). */
  initiator: string;
}

/** Human-readable labels for the challenge metric keys (composed into the outcome + criteria). */
const METRIC_LABELS: Record<string, string> = {
  timeSavedPerWeek: 'Time saved per week',
  affectedStaff: 'Affected staff',
  backlogReduction: 'Backlog reduction',
};

/** Non-empty, trimmed metric entries as [label, value] pairs, in a stable order. */
function metricEntries(metrics: Challenge['metrics']): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const key of Object.keys(METRIC_LABELS)) {
    const value = (metrics as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) {
      out.push([METRIC_LABELS[key]!, value.trim()]);
    }
  }
  return out;
}

/** Build the canonical, target-neutral delivery payload (spec Part 3). Pure. */
export function buildDeliveryPayload(input: BuildDeliveryPayloadInput): DeliveryPayload {
  const { solution, challenge, flow, datasets, entities, initiator } = input;

  const metrics = metricEntries(challenge.metrics);

  // deliverables: one per flow node slug (in graph order); fall back to blocks_used when no flow.
  const flowChain = flow?.graph?.nodes?.map((n) => n.slug).filter(Boolean) ?? [];
  const blocksUsed = solution.blocks_used ?? [];
  const deliverables = (flowChain.length ? flowChain : blocksUsed).map(
    (slug) => `Implement the "${slug}" step`,
  );

  // requirements: the block chain + the work-area framing.
  const requirements = [
    `Deliver within the "${challenge.work_area}" work area`,
    ...blocksUsed.map((slug) => `Provide the "${slug}" capability`),
  ];

  // data_access: datasets (name/slug) + ontology entities the solution touches.
  const dataAccess = [
    ...datasets.map((d) => `${d.name} (${d.slug})`),
    ...entities.map((e) => `Ontology entity: ${e}`),
  ];

  // labels: work area + challenge tags + a stable provenance marker.
  const tags = challenge.tags ?? [];
  const labels = [challenge.work_area, ...tags, 'source:commonpractice'];

  const problem = challenge.business_impact?.trim() || challenge.description;
  const outcome = metrics.length
    ? metrics.map(([label, value]) => `${label}: ${value}`).join('; ')
    : `Deliver the outcome of "${challenge.title}".`;
  const acceptanceCriteria = metrics.map(([label, value]) => `${label} — target: ${value}`);

  // needs_human: fields the targets require that CP cannot supply (repo URL / PAT for fr, etc.).
  const needsHuman = [
    'Assign an owner / team in the target system',
    'Provide the target repository URL (fr) or component/assignee (Jira/ADO)',
  ];

  return {
    title: solution.title,
    summary: challenge.description,
    problem,
    outcome,
    acceptance_criteria: acceptanceCriteria,
    deliverables,
    requirements,
    data_access: dataAccess,
    labels,
    provenance: {
      cp_solution_id: solution.id,
      cp_challenge_id: challenge.id,
      cp_flow_id: solution.flow_id ?? null,
      cp_tenant_id: challenge.tenant_id,
      initiated_by: initiator,
      votes_count: solution.votes_count ?? 0,
      flow_chain: flowChain,
      blocks_used: blocksUsed,
      datasets: datasets.map((d) => d.slug),
      ontology_entities: entities,
    },
    needs_human: needsHuman,
  };
}
