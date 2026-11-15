// src/host/run-policy.ts — the run-gate (Session 6). Pure + unit-testable.
// Given a flow graph, its resolved block descriptors, the governance snapshot, and
// the sandbox, decide whether the run may proceed. This is where the governance
// toggles become real preconditions (MAXIMAL enforcement, honestly tiered):
//
//   REAL behaviour-changing gates:
//     • models.external_http OFF → a node with capabilities.network is refused.
//     • data.pii_scrubbing ON → a pii-typed input fed by a non-mock source is
//       refused (taint-by-source convention; the runner also masks at execution).
//   ARCHITECTURE/symbolic (asserted, never block — the runtime is already in the
//   safe posture; flipping them off is accepted + audited, not a real teleport):
//     • data.block_prod_data — the runner env is scrubbed (no DB url to leak).
//     • data.cross_sandbox_isolation — one OS subprocess per run already isolates.
//     • models.code_exec_outside_blocks — a FLOW RUN executes pinned, published block
//       versions. ⚠️ NOT "only published blocks ever run": the authoring paths (block
//       test, flow simulate) run the DRAFT source being edited, by design.
//
// ⛔ THIS SPLIT IS NO LONGER ONLY A COMMENT. It is `host/policy-enforcement.ts`
// (`'enforced' | 'architectural' | 'retired'`), which /api/governance puts on the wire so the
// Governance screen can stop claiming a boundary for the symbolic half. Change one, change both —
// the frontend contract test checks the classification against the real consumers of each
// GovernanceSnapshot field, so a rail that gains an enforcement point here goes red until it is
// reclassified there.
//
// ⛔ TWO LINES THAT USED TO SIT IN THAT LIST WERE FALSE, AND WERE THE REASON THE SCREEN'S COPY WAS
// WRONG IN EIGHT LANGUAGES:
//   • "data.eu_only — single-region host; the sandbox region is asserted." NOTHING asserts a
//     region. `sandboxes.region` is a column defaulting to 'eu-west' that the seeders write and
//     the DTOs echo, and it is never compared to anything; `egress-guard.ts` resolves addresses and
//     inspects them for PRIVACY (SSRF) only, never for geography; and the default provider
//     endpoints seeded into the egress allowlist are api.anthropic.com, api.openai.com,
//     api.deepseek.com, api.x.ai, api.cohere.ai and openrouter.ai. The rail is RETIRED — it is not
//     in the snapshot at all any more, only in the `policies` table so its change history resolves.
//   • "only published blocks ever run" — see the correction above it.
import type { FlowGraph } from '../db/flow-types';
import type { BlockDescriptor } from '../db/block-types';
import type { GovernanceSnapshot } from './policy-store';

export interface RunPolicyViolation {
  policyKey: string;
  code: string; // e.g. 'policy_network_blocked'
  reason: string;
  /**
   * The slug of the node that tripped the policy — the same name `reason` quotes, carried as a
   * FIELD so a caller can put it in a refusal without parsing English prose out of `reason`.
   *
   * ⛔ THE REASON THIS EXISTS. Both callers (routes/solutions.ts, host/run-controller.ts) turn a
   * violation into `unprocessable(code, reason, details)`, and the SPA replaces `reason` with
   * localized copy (frontend/src/lib/api/error-message.ts). Without this field the localized
   * sentence can only say "a block in this flow", which on a 40-node graph is not actionable — it
   * would trade a named offender for an anonymous one, which is half of the defect that copy was
   * written to fix. `policyKey` cannot stand in: it names the POLICY, not the block.
   */
  nodeSlug: string;
}

/** Resolve the descriptor for a node, by its pinned block version id. */
type DescriptorsById = Map<string, BlockDescriptor>;

/** Returns the FIRST violation, or null if the run may proceed. The architecture
 *  rails are checked but cannot fail here (they hold by construction). */
export function enforceRunPolicies(
  graph: FlowGraph,
  descriptorsById: DescriptorsById,
  snapshot: GovernanceSnapshot,
): RunPolicyViolation | null {
  // --- models.external_http: refuse network-capable blocks when off ---
  if (!snapshot.externalHttp) {
    for (const node of graph.nodes) {
      const d = descriptorsById.get(node.blockVersionId);
      if (d?.capabilities?.network === true) {
        return {
          policyKey: 'models.external_http',
          code: 'policy_network_blocked',
          nodeSlug: node.slug,
          reason: `Block '${node.slug}' needs external HTTP, which is disabled by policy.`,
        };
      }
    }
  }

  // --- data.pii_scrubbing: a pii input must be fed by a mock-data source ---
  if (snapshot.piiScrubbing) {
    for (const node of graph.nodes) {
      const d = descriptorsById.get(node.blockVersionId);
      if (!d) continue;
      for (const [inputName, spec] of Object.entries(d.inputs ?? {})) {
        if (!spec.pii) continue;
        const edge = graph.edges.find(
          (e) => e.target === node.id && e.targetHandle === inputName,
        );
        if (edge) {
          // Fed by an upstream node — the producer must be a mock-data source.
          //
          // ⛔ `mockData` ONLY, AND DELIBERATELY NOT `dataset`. When the two were one flag this read
          // "may read sample data"; now that they are split it reads what the policy actually means:
          // "this producer FABRICATES its output". A `dataset`-capable producer emits the tenant's
          // REAL rows, which is precisely what `data.pii_scrubbing` exists to keep out of a PII port
          // — so widening this to `|| caps.dataset` would silently disarm the policy.
          //
          // ⚠️ THIS TIGHTENS AN EXISTING PATH, ON PURPOSE, AND IT IS THE ONE RETROACTIVE BEHAVIOUR
          // CHANGE IN THE `dataset` SPLIT. Before the split, `load-dataset` and every ontology-derived
          // data block declared `mockData: true` to pass the executor's dataset gate, and that
          // declaration ALSO bought them a free pass here — a flow could feed real dataset rows into a
          // `pii`-marked input with pii_scrubbing ON and be allowed. Migration `0077` DELETES that bit
          // from the persisted descriptor, and this gate reads the `block_versions.descriptor` COLUMN
          // (both callers build `descriptorsById` from `resolveExecutableBlocks`, never from
          // `source_ts`), so such a flow is refused from the moment 0077 applies. It is the policy
          // doing its stated job rather than a regression — but it IS a change, so:
          //
          // ⛔ THE ARGUMENT, BOTH WAYS, BECAUSE THE ANSWER IS NOT OBVIOUS AND THE NEXT PERSON WILL
          // REACH FOR `|| caps.dataset` THE FIRST TIME A CUSTOMER FLOW BREAKS.
          //
          //   FOR widening (`mockData || dataset`): the split was advertised as display-only and
          //   ADDITIVE; a bit that existed to open the executor's dataset gate should not, by being
          //   renamed, change what a run is allowed to do. The flows this refuses are the SAME flows,
          //   running the SAME blocks over the SAME rows, as the day before the migration — nothing
          //   about their risk changed, only the spelling of a capability. A governance rail that
          //   starts refusing on a refactor teaches operators that the rail is noise.
          //
          //   AGAINST (what this code does): the two readings are not symmetric. `pii_scrubbing`'s
          //   whole content is taint-by-source — a PII port may only be fed by a producer whose output
          //   is INVENTED. `mockData` asserts exactly that. `dataset` asserts the OPPOSITE and is
          //   strictly worse for this purpose than a bare capability-less block: it is the grant to
          //   read the tenant's REAL uploaded rows, which is the precise thing the policy exists to
          //   keep out of a `pii`-marked input. Widening would make the ONLY enforced data rail
          //   unfalsifiable — every dataset block would pass it — while the Governance screen keeps
          //   calling it 'enforced' (host/policy-enforcement.ts). And the old pass was never a
          //   decision: it was a side effect of one flag meaning two things, which is the defect the
          //   split removes. The pre-0077 behaviour is the bug; this is the repair.
          //
          // DECIDED: `mockData` only. If a real flow needs to move real dataset rows through a `pii`
          // port, the answer is to turn `data.pii_scrubbing` OFF for that tenant — an audited,
          // visible, reversible act — not to make the toggle quietly mean nothing while it is ON.
          // Pinned by `tests/policy-enforcement.test.ts` (the `fromDataset` arm) and by
          // `tests/migration-0077-dataset-capability.test.ts` (which proves the migration is what
          // moves a real row across that line).
          const src = graph.nodes.find((n) => n.id === edge.source);
          const srcDesc = src ? descriptorsById.get(src.blockVersionId) : undefined;
          if (srcDesc?.capabilities?.mockData !== true) {
            return {
              policyKey: 'data.pii_scrubbing',
              code: 'policy_pii_violation',
              nodeSlug: node.slug,
              reason: `PII input '${inputName}' on '${node.slug}' is fed by a non-mock source.`,
            };
          }
        } else {
          // Fed by a config literal — allowed only if marked as mock data.
          const literal = node.config?.[inputName] as { mock?: boolean } | undefined;
          const isMockLiteral =
            literal !== undefined &&
            typeof literal === 'object' &&
            literal?.mock === true;
          if (!isMockLiteral) {
            return {
              policyKey: 'data.pii_scrubbing',
              code: 'policy_pii_violation',
              nodeSlug: node.slug,
              reason: `PII input '${inputName}' on '${node.slug}' is set from a non-mock literal.`,
            };
          }
        }
      }
    }
  }

  // Architecture/symbolic rails hold by construction — nothing to block.
  return null;
}
