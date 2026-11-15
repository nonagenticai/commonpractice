// tests/graph-issue-machine-fields.test.ts — every graph rule that names something puts that name
// on the wire as a MACHINE FIELD, and puts the RIGHT one there. Pure unit, no DB.
//
// ⛔ WHY THIS FILE EXISTS AND WHY NOTHING ELSE CAN REPLACE IT. `/build` no longer renders
// `issue.message`; it renders `graphIssueLabel(issue)`, which builds the reader's sentence from the
// RULE plus `detail` (frontend/src/lib/i18n/graph-issue-label.ts). NINE of the twelve rules
// interpolate a field, and each has a deliberate `if (!has(d, …)) return issue.message` branch for
// the rolling-deploy window when an old pod ships no `detail` at all.
//
// That branch is what makes this file load-bearing, in TWO directions:
//
//   * DROP a bag and the frontend takes the fallback FOREVER — that rule renders English in all
//     eight locales and EVERY frontend test stays green, because returning the English is a
//     legitimate, separately tested behaviour. Nothing on the frontend side can tell "mid-roll"
//     from "permanently broken".
//   * SUBSTITUTE the value — `src!.id` where the sentence names `src!.slug` — and NOTHING anywhere
//     notices. The sentence still renders, in perfect Dutch, naming an opaque id the author has
//     never seen. Type-checking cannot see it: both are `string`.
//
// ⛔ MEASURED, NOT ASSUMED. Before this file existed, all four of these mutations left the whole
// repo green (backend 53/0, frontend 30 files / 451 tests):
//     `unknown-source-handle` detail `src!.slug` → `src!.id`
//     `nested-foreach` + `orphan-loop-body` slug → id
//     delete `missing-descriptor`'s whole bag
//     delete `unknown-source-handle`'s bag AND add one to `duplicate-node-id`  ← count stays 9
// The last one is why the guard is PER RULE BY NAME and why a global `detail:` occurrence count was
// deleted from `graph-issue-label.backend-contract.test.ts`: a count is not a contract.
//
// Standard set by `tests/static-scan-machine-fields.test.ts` (WS-1b), which already kills both the
// drop and the wrong-value substitution for the lint vocabulary. This is the same test for graphs.
//
// The English `message` is asserted beside each one where it is the thing that proves the VALUE is
// the author-visible one — it is kept byte-identical on purpose, because it is the fallback.
import { test, expect } from 'bun:test';
import {
  validateGraphStructure,
  validateGraphAgainstBlocks,
  type GraphIssue,
  type GraphIssueRule,
} from '../src/exec/flow-validate';
import type { FlowGraph, FlowNode } from '../src/db/flow-types';
import type { BlockDescriptor } from '../src/db/block-types';

/** The nine rules whose sentence names something, and the three that name nothing. */
const DETAIL_CARRYING: GraphIssueRule[] = [
  'edge-missing-source',
  'edge-missing-target',
  'unknown-source-handle',
  'unknown-target-handle',
  'incompatible-handle-type',
  'missing-required-input',
  'missing-descriptor',
  'nested-foreach',
  'orphan-loop-body',
];
const NO_DETAIL: GraphIssueRule[] = ['cycle', 'duplicate-node-id', 'duplicate-edge-id'];

function node(id: string, slug: string, extra: Partial<FlowNode> = {}): FlowNode {
  return {
    id,
    blockId: 'b1',
    blockVersionId: 'bv1',
    slug,
    label: 'Samenvatten',
    category: 'data',
    config: {},
    position: { x: 0, y: 0 },
    ...extra,
  };
}

/** The one issue for `rule`, or a failure naming what was actually produced. */
function only(issues: readonly GraphIssue[], rule: string): GraphIssue {
  const hit = issues.filter((i) => i.rule === rule);
  expect(hit.length, `expected exactly one \`${rule}\`, got: ${issues.map((i) => i.rule).join(', ')}`).toBe(1);
  return hit[0]!;
}

const desc = (
  inputs: Record<string, { type: string; required?: boolean }>,
  outputs: Record<string, { type: string }>,
): BlockDescriptor => ({ inputs, outputs, capabilities: {} }) as unknown as BlockDescriptor;

// ---------------------------------------------------------------- validateGraphStructure

test('edge-missing-source / edge-missing-target ship the RAW ENDPOINT ID the edge still points at', () => {
  // ⚠️ The one place an id is right for a node-naming field: the node is GONE from the graph, so
  // there is no slug to take. The English quotes the same id, so nothing is lost.
  const graph: FlowGraph = {
    nodes: [node('n1', 'read-claim-form')],
    edges: [
      { id: 'e1', source: 'ghost-src', sourceHandle: 'out', target: 'n1', targetHandle: 'in' },
      { id: 'e2', source: 'n1', sourceHandle: 'out', target: 'ghost-tgt', targetHandle: 'in' },
    ],
  };
  const { issues } = validateGraphStructure(graph);

  const src = only(issues, 'edge-missing-source');
  expect(src.detail).toEqual({ sourceNode: 'ghost-src' });
  expect(src.ref).toBe('e1');
  expect(src.message).toBe("Edge e1 references missing source node 'ghost-src'");

  const tgt = only(issues, 'edge-missing-target');
  expect(tgt.detail).toEqual({ targetNode: 'ghost-tgt' });
  expect(tgt.ref).toBe('e2');
  expect(tgt.message).toBe("Edge e2 references missing target node 'ghost-tgt'");
});

test('⛔ nested-foreach names the two loops by ID, because every foreach shares the slug `foreach`', () => {
  // ⛔ THE INFORMATION-LOSS GUARD, DRIVEN WITH TWO REAL CONTAINERS. The builder stamps EVERY
  // foreach it creates with `slug: 'foreach'` and `label: 'For each row'`
  // (frontend/src/lib/stores/builder-graph.ts). A slug-carrying `detail` therefore rendered
  //     "Lus “foreach” zit in lus “foreach”."
  // — both loops named identically, so the sentence could no longer say which one to move, while
  // the English it replaced named `fe2` and `fe1`. `issueNodeLabel(ref)` cannot break the tie
  // either: it resolves to the same default label for both. This case is the reason the two loop
  // rules are the deliberate exception to the slug doctrine.
  const graph: FlowGraph = {
    nodes: [
      node('fe1', 'foreach', { kind: 'foreach', label: 'For each row' }),
      node('fe2', 'foreach', { kind: 'foreach', parentId: 'fe1', label: 'For each row' }),
    ],
    edges: [],
  };
  const nested = only(validateGraphStructure(graph).issues, 'nested-foreach');

  expect(nested.detail).toEqual({ node: 'fe2', parent: 'fe1' });
  // ⛔ THE POSITIVE HALF, STATED AS THE PROPERTY AND NOT AS TWO LITERALS: the two identifiers the
  // reader is given must DIFFER, or the sentence names one loop twice.
  expect(nested.detail!.node, 'both loops rendered the same name').not.toBe(nested.detail!.parent);
  // …and they are exactly what the English names, so the localized sentence loses nothing.
  expect(nested.message).toContain("'fe2'");
  expect(nested.message).toContain("'fe1'");
  expect(nested.detail!.node).not.toBe('foreach');
});

test('orphan-loop-body names the node and its claimed parent by ID', () => {
  // The parent here is not in the graph at all — the id is the only value that exists — and the
  // node's own id is what the English quotes, so both halves stay in step with the fallback.
  const graph: FlowGraph = {
    nodes: [node('n9', 'read-claim-form', { parentId: 'not-a-node' })],
    edges: [],
  };
  const orphan = only(validateGraphStructure(graph).issues, 'orphan-loop-body');
  expect(orphan.detail).toEqual({ node: 'n9', parent: 'not-a-node' });
  expect(orphan.message).toBe("Node 'n9' claims parent 'not-a-node', which is not a loop node");
});

test('the three rules that name nothing invent nothing — cycle and the duplicate-* pair', () => {
  // ⛔ THE OVER-CORRECTION GUARD. "Put a `detail` on every push site" would satisfy the per-rule
  // assertions above and would make the frontend's mid-roll branches unreachable for the rules that
  // have nothing to interpolate — `cycle` takes no parameters, and the duplicate-* pair reads
  // `ref`, which predates this change.
  const dup: FlowGraph = {
    nodes: [node('n1', 'a'), node('n1', 'a')],
    edges: [
      { id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n1', targetHandle: 'in' },
      { id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n1', targetHandle: 'in' },
    ],
  };
  const { issues } = validateGraphStructure(dup);
  const seen = new Set(issues.map((i) => i.rule));
  for (const rule of ['duplicate-node-id', 'duplicate-edge-id', 'cycle'] as const) {
    expect(seen, `${rule} was not raised — this case would prove nothing`).toContain(rule);
    for (const i of issues.filter((x) => x.rule === rule)) {
      expect(i.detail, `${rule} invented a \`detail\``).toBeUndefined();
      // The duplicate-* pair renders `ref` (which predates this change) — losing it would send
      // them down the fallback exactly as losing a `detail` does. `cycle` renders nothing at all.
      if (rule !== 'cycle') {
        expect(i.ref, `${rule} must still carry its ref — that is what it renders`).toBeTruthy();
      }
    }
  }
});

// ---------------------------------------------------------------- validateGraphAgainstBlocks

test('missing-descriptor ships the node SLUG and the block version', () => {
  const graph: FlowGraph = {
    nodes: [node('n1', 'read-claim-form', { blockVersionId: 'bv-unpublished' })],
    edges: [],
  };
  const issue = only(validateGraphAgainstBlocks(graph, new Map()).issues, 'missing-descriptor');
  expect(issue.detail).toEqual({ node: 'read-claim-form', blockVersion: 'bv-unpublished' });
  // ⛔ THE SUBSTITUTION GUARD, SPELLED OUT: `n1` is the id and is what `ref` carries. Swapping it
  // into `detail` renders a perfectly Dutch sentence about a token the author has never seen.
  expect(issue.detail!.node).not.toBe('n1');
  expect(issue.ref).toBe('n1');
});

test('unknown-source-handle / unknown-target-handle ship the node SLUG and the handle NAME', () => {
  const graph: FlowGraph = {
    nodes: [node('n1', 'read-claim-form'), node('n2', 'ai-summarize', { blockVersionId: 'bv2' })],
    edges: [
      { id: 'e1', source: 'n1', sourceHandle: 'gone-out', target: 'n2', targetHandle: 'gone-in' },
    ],
  };
  const descriptors = new Map<string, BlockDescriptor>([
    ['bv1', desc({ in: { type: 'string' } }, { text: { type: 'string' } })],
    ['bv2', desc({ text: { type: 'string' } }, { out: { type: 'string' } })],
  ]);
  const { issues } = validateGraphAgainstBlocks(graph, descriptors);

  const src = only(issues, 'unknown-source-handle');
  expect(src.detail).toEqual({ sourceNode: 'read-claim-form', sourceHandle: 'gone-out' });
  expect(src.detail!.sourceNode).not.toBe('n1');
  expect(src.message).toBe("Edge e1: 'read-claim-form' has no output 'gone-out'");

  const tgt = only(issues, 'unknown-target-handle');
  expect(tgt.detail).toEqual({ targetNode: 'ai-summarize', targetHandle: 'gone-in' });
  expect(tgt.detail!.targetNode).not.toBe('n2');
  expect(tgt.message).toBe("Edge e1: 'ai-summarize' has no input 'gone-in'");
});

test('incompatible-handle-type ships all SIX fields — two slugs, two handles, two FieldType tokens', () => {
  const graph: FlowGraph = {
    nodes: [node('n1', 'read-claim-form'), node('n2', 'ai-summarize', { blockVersionId: 'bv2' })],
    edges: [{ id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'text' }],
  };
  const descriptors = new Map<string, BlockDescriptor>([
    ['bv1', desc({ in: { type: 'string' } }, { text: { type: 'string' } })],
    ['bv2', desc({ text: { type: 'number' } }, { out: { type: 'string' } })],
  ]);
  const issue = only(validateGraphAgainstBlocks(graph, descriptors).issues, 'incompatible-handle-type');

  expect(issue.detail).toEqual({
    sourceNode: 'read-claim-form',
    sourceHandle: 'text',
    sourceType: 'string',
    targetNode: 'ai-summarize',
    targetHandle: 'text',
    targetType: 'number',
  });
  // The six-field sentence is the one the browser joins into two compounds (`slug.handle`), so the
  // slugs must be slugs — an id here reads as `“n1.text” levert string`.
  expect(issue.detail!.sourceNode).not.toBe('n1');
  expect(issue.detail!.targetNode).not.toBe('n2');
});

test('missing-required-input ships the node SLUG and the input NAME', () => {
  const graph: FlowGraph = {
    nodes: [node('n2', 'ai-summarize', { blockVersionId: 'bv2' })],
    edges: [],
  };
  const descriptors = new Map<string, BlockDescriptor>([
    ['bv2', desc({ prompt: { type: 'string', required: true } }, { out: { type: 'string' } })],
  ]);
  const issue = only(validateGraphAgainstBlocks(graph, descriptors).issues, 'missing-required-input');
  expect(issue.detail).toEqual({ node: 'ai-summarize', handle: 'prompt' });
  expect(issue.detail!.node).not.toBe('n2');
  expect(issue.message).toBe("Node 'ai-summarize' requires input 'prompt'");
});

// ---------------------------------------------------------------- the closure argument

test('⛔ EVERY rule the union declares was raised, and its `detail` half is what its rule says', () => {
  // ⛔ THE NON-VACUITY ANCHOR, AND IT IS BEHAVIOURAL, NOT A SOURCE SCRAPE. The per-rule cases above
  // are the contract; this is what stops one of them being deleted with its push site and nobody
  // noticing. Two graphs between them raise all TWELVE rules, and the loop asserts the property
  // both ways: the nine that name something carry a bag of non-empty strings, the three that name
  // nothing carry none. A push site that quietly drops its bag reds here even if its own case was
  // deleted; a push site that GROWS one on `cycle` reds here too.
  const structural: FlowGraph = {
    nodes: [
      node('dup', 'alpha'),
      node('dup', 'alpha'),
      node('fe1', 'foreach', { kind: 'foreach', label: 'For each row' }),
      node('fe2', 'foreach', { kind: 'foreach', parentId: 'fe1', label: 'For each row' }),
      node('orph', 'beta', { parentId: 'not-a-node' }),
    ],
    edges: [
      { id: 'eGhostS', source: 'ghost', sourceHandle: 'out', target: 'dup', targetHandle: 'in' },
      { id: 'eGhostT', source: 'dup', sourceHandle: 'out', target: 'ghost2', targetHandle: 'in' },
      { id: 'eDup', source: 'dup', sourceHandle: 'out', target: 'fe1', targetHandle: 'in' },
      { id: 'eDup', source: 'fe1', sourceHandle: 'item', target: 'dup', targetHandle: 'in' },
    ],
  };
  const wired: FlowGraph = {
    nodes: [
      node('n1', 'read-claim-form'),
      node('n2', 'ai-summarize', { blockVersionId: 'bv2' }),
      node('n3', 'orphan-block', { blockVersionId: 'bv-unpublished' }),
    ],
    edges: [
      { id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'text' },
      { id: 'e2', source: 'n1', sourceHandle: 'gone-out', target: 'n2', targetHandle: 'text' },
      { id: 'e3', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'gone-in' },
    ],
  };
  const descriptors = new Map<string, BlockDescriptor>([
    ['bv1', desc({ in: { type: 'string' } }, { text: { type: 'string' } })],
    ['bv2', desc({ text: { type: 'number' }, prompt: { type: 'string', required: true } }, { out: { type: 'string' } })],
  ]);

  const issues = [
    ...validateGraphStructure(structural).issues,
    ...validateGraphAgainstBlocks(wired, descriptors).issues,
  ];
  const seen = new Set(issues.map((i) => i.rule));

  for (const rule of [...DETAIL_CARRYING, ...NO_DETAIL]) {
    expect(seen, `\`${rule}\` was never raised — the loop below would say nothing about it`).toContain(rule);
  }
  for (const issue of issues) {
    if (NO_DETAIL.includes(issue.rule)) {
      expect(issue.detail, `\`${issue.rule}\` invented a \`detail\``).toBeUndefined();
      continue;
    }
    const bag = issue.detail;
    expect(bag, `\`${issue.rule}\` shipped NO detail — every locale renders the English forever`).toBeDefined();
    expect(Object.keys(bag!).length, `\`${issue.rule}\` shipped an EMPTY detail`).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(bag!)) {
      // An empty string is what `graphIssueLabel`'s `has()` treats as absent, so it is the same
      // silent revert-to-English wearing a different hat.
      expect(typeof v, `${issue.rule}.${k} is not a string`).toBe('string');
      expect((v as string).length, `${issue.rule}.${k} is empty`).toBeGreaterThan(0);
    }
  }

  expect(DETAIL_CARRYING).toHaveLength(9);
  expect(new Set([...DETAIL_CARRYING, ...NO_DETAIL]).size, 'the two lists overlap').toBe(12);
});
