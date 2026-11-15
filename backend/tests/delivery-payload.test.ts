// tests/delivery-payload.test.ts — Phase 5 / 5A: the pure canonical-payload mapper (spec Part 3).
// No DB; constructs in-memory rows and asserts the target-neutral mapping.
import { test, expect } from 'bun:test';
import { buildDeliveryPayload } from '../src/services/delivery-payload';
import type { Challenge, Solution, Flow } from '../src/db/schema';
import type { ChallengeDatasetOut } from '../src/challenges/challenge-data-service';

const CH_ID = '00000000-0000-0000-0000-0000000c0001';
const SOL_ID = '00000000-0000-0000-0000-0000000501001';
const FLOW_ID = '00000000-0000-0000-0000-00000f100001';
const TENANT = '00000000-0000-0000-0000-000000000001';
const INITIATOR = '00000000-0000-0000-0000-000000005001';

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: CH_ID,
    title: 'Cut claims triage time',
    description: 'Claims handlers spend hours manually triaging inbound claims.',
    business_impact: 'High operational cost and SLA breaches in the claims unit.',
    work_area: 'Claims',
    submitter_id: INITIATOR,
    status: 'solution_phase',
    tenant_id: TENANT,
    week: '',
    metrics: { timeSavedPerWeek: '12 hours', affectedStaff: '8 handlers' },
    tags: ['triage', 'automation'],
    code: 'CLM-1',
    votes_count: 5,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Challenge;
}

function solution(overrides: Partial<Solution> = {}): Solution {
  return {
    id: SOL_ID,
    challenge_id: CH_ID,
    tenant_id: TENANT,
    title: 'Auto-triage flow with LLM classifier',
    author_id: INITIATOR,
    flow_id: FLOW_ID,
    status: 'voting',
    week: '',
    build_time_minutes: 45,
    demo_seconds: 90,
    blocks_used: ['ingest-csv', 'llm-classify', 'route-queue'],
    votes_count: 7,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Solution;
}

function flow(slugs: string[]): Flow {
  return {
    id: FLOW_ID,
    name: 'Triage flow',
    description: '',
    owner_id: INITIATOR,
    tenant_id: TENANT,
    status: 'submitted',
    graph: {
      nodes: slugs.map((slug, i) => ({
        id: `n${i}`,
        blockId: `b${i}`,
        blockVersionId: `v${i}`,
        slug,
        label: slug,
        category: 'transform' as never,
        config: {},
        position: { x: i, y: 0 },
      })),
      edges: [],
    },
    version: '0.1.0',
    solution_id: SOL_ID,
    last_saved_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as Flow;
}

const DATASETS: ChallengeDatasetOut[] = [
  { slug: 'claims', name: 'Claims register', columns: [], rowCount: 1200, note: '' },
];

test('maps the core fields from solution + challenge', () => {
  const p = buildDeliveryPayload({
    solution: solution(),
    challenge: challenge(),
    flow: flow(['ingest-csv', 'llm-classify', 'route-queue']),
    datasets: DATASETS,
    entities: ['Claim', 'Policy'],
    initiator: INITIATOR,
  });
  expect(p.title).toBe('Auto-triage flow with LLM classifier');
  expect(p.summary).toBe('Claims handlers spend hours manually triaging inbound claims.');
  expect(p.problem).toBe('High operational cost and SLA breaches in the claims unit.');
});

test('deliverables come from the flow node slugs (in order) when a flow exists', () => {
  const p = buildDeliveryPayload({
    solution: solution(),
    challenge: challenge(),
    flow: flow(['a', 'b', 'c']),
    datasets: [],
    entities: [],
    initiator: INITIATOR,
  });
  expect(p.deliverables).toEqual([
    'Implement the "a" step',
    'Implement the "b" step',
    'Implement the "c" step',
  ]);
  expect(p.provenance.flow_chain).toEqual(['a', 'b', 'c']);
});

test('deliverables fall back to blocks_used when there is no flow', () => {
  const p = buildDeliveryPayload({
    solution: solution({ flow_id: null }),
    challenge: challenge(),
    flow: null,
    datasets: [],
    entities: [],
    initiator: INITIATOR,
  });
  expect(p.deliverables).toEqual([
    'Implement the "ingest-csv" step',
    'Implement the "llm-classify" step',
    'Implement the "route-queue" step',
  ]);
  expect(p.provenance.flow_chain).toEqual([]);
  expect(p.provenance.cp_flow_id).toBeNull();
});

test('acceptance_criteria + outcome are derived from non-empty challenge metrics', () => {
  const p = buildDeliveryPayload({
    solution: solution(),
    challenge: challenge(),
    flow: null,
    datasets: [],
    entities: [],
    initiator: INITIATOR,
  });
  expect(p.acceptance_criteria).toEqual([
    'Time saved per week — target: 12 hours',
    'Affected staff — target: 8 handlers',
  ]);
  expect(p.outcome).toBe('Time saved per week: 12 hours; Affected staff: 8 handlers');
});

test('with no metrics, outcome falls back to the challenge title and criteria are empty', () => {
  const p = buildDeliveryPayload({
    solution: solution(),
    challenge: challenge({ metrics: {} }),
    flow: null,
    datasets: [],
    entities: [],
    initiator: INITIATOR,
  });
  expect(p.acceptance_criteria).toEqual([]);
  expect(p.outcome).toBe('Deliver the outcome of "Cut claims triage time".');
});

test('labels include work_area, tags, and the source marker', () => {
  const p = buildDeliveryPayload({
    solution: solution(),
    challenge: challenge(),
    flow: null,
    datasets: [],
    entities: [],
    initiator: INITIATOR,
  });
  expect(p.labels).toEqual(['Claims', 'triage', 'automation', 'source:commonpractice']);
});

test('data_access lists datasets and ontology entities', () => {
  const p = buildDeliveryPayload({
    solution: solution(),
    challenge: challenge(),
    flow: null,
    datasets: DATASETS,
    entities: ['Claim'],
    initiator: INITIATOR,
  });
  expect(p.data_access).toEqual(['Claims register (claims)', 'Ontology entity: Claim']);
});

test('provenance carries the full CP lineage', () => {
  const p = buildDeliveryPayload({
    solution: solution(),
    challenge: challenge(),
    flow: flow(['a']),
    datasets: DATASETS,
    entities: ['Claim'],
    initiator: INITIATOR,
  });
  expect(p.provenance).toEqual({
    cp_solution_id: SOL_ID,
    cp_challenge_id: CH_ID,
    cp_flow_id: FLOW_ID,
    cp_tenant_id: TENANT,
    initiated_by: INITIATOR,
    votes_count: 7,
    flow_chain: ['a'],
    blocks_used: ['ingest-csv', 'llm-classify', 'route-queue'],
    datasets: ['claims'],
    ontology_entities: ['Claim'],
  });
  expect(p.needs_human.length).toBeGreaterThan(0);
});
