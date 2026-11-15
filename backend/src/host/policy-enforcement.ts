// src/host/policy-enforcement.ts — WHAT BACKS EACH GOVERNANCE RAIL, as data.
//
// ⛔ THE DEFECT THIS EXISTS TO CLOSE. /governance was headed "Policy rails · enforced at the
// boundary" in all eight languages, over EIGHTEEN rails, FOUR of which no code reads at all:
// `models.code_exec_outside_blocks`, `data.block_prod_data`, `data.cross_sandbox_isolation` and
// `data.eu_only`. Their GovernanceSnapshot fields had zero consumers anywhere in `backend/src`,
// `backend/tests` or `backend/scripts` — measured, not estimated — so flipping one of those
// toggles OFF changed nothing whatsoever while the screen kept promising a boundary. The words in
// `frontend/messages/*.json` promised users, in eight languages, something the code disproves.
//
// The codebase was already honest about it IN A COMMENT: run-policy.ts's header has split the
// rails into "REAL behaviour-changing gates" and "ARCHITECTURE/symbolic (asserted, never block)"
// since Session 6. A comment cannot reach the wire, cannot be rendered, and cannot be asserted
// against. This module is that comment turned into a TYPE, put on `/api/governance`, and pinned
// by `frontend/src/lib/i18n/policy-enforcement.backend-contract.test.ts`.
//
// ⛔ WHY THIS IS CODE AND NOT A `policies` COLUMN. Two independent reasons, either sufficient:
//   1. `seedPlatform` inserts policies ON CONFLICT DO NOTHING, so any metadata carried in a row is
//      unfixable on an already-seeded deployment without a migration AND a reconciler. That is not
//      hypothetical: `spend.weekly_spend_ceiling` still reads `unit: '€'` on every database seeded
//      before the `'$'` correction, and there is no reconciler for policy metadata. A classification
//      that says "enforced" on old databases and "architectural" on new ones is worse than none.
//   2. A column can be written to say anything. This map is DERIVABLE-CHECKABLE: the contract test
//      reads `buildSnapshot()` for the key→field mapping and then scans `backend/src` for a real
//      property read of that field, so `enforcement: 'enforced'` is red the moment the last
//      consumer of its field disappears — and `'architectural'` is red the moment one appears.
//      A row in Postgres is invisible to every static check in this repo.
import type { GovernanceSnapshot } from './policy-store';

/**
 * How a rail is backed.
 *
 *   'enforced'      — some code path reads the snapshot field and REFUSES on it: a run, a brokered
 *                     call, a publish or a promotion is turned away, and the refusal names the
 *                     rail. The rail states a bound something can be on the wrong side of.
 *   'applied'       — the rail is a live SETTING, not a boundary. Some code path really does read
 *                     the field and an edit really does change what happens on the next run or
 *                     call — but NOTHING IS REFUSED for it and no refusal names it. A canary
 *                     percentage, a tier→model mapping and a price table are values the platform
 *                     APPLIES; there is no predicate a run could violate, so there is nothing to
 *                     turn a run away for. This is the kind that was missing: three rails sat in
 *                     'enforced' because they had a consumer, under a band note promising a
 *                     refusal that no code anywhere performs.
 *   'architectural' — the property is true because of how the platform is built (a scrubbed
 *                     runner env, one OS process per run, published blocks in the executor), not
 *                     because of the switch. Flipping it OFF is recorded and audited and changes
 *                     nothing. It is a STATED POSTURE, not a control.
 *   'retired'       — the claim has been WITHDRAWN. Nothing enforces it and nothing asserts it;
 *                     `buildSnapshot` does not even parse the row. The row itself survives because
 *                     `policy_changes.policy_key` is a foreign key onto `policies.key` and deleting
 *                     it would cascade away real recorded history.
 */
export type PolicyEnforcement = 'enforced' | 'applied' | 'architectural' | 'retired';

export interface PolicyEnforcementEntry {
  enforcement: PolicyEnforcement;
  /**
   * The `GovernanceSnapshot` field this rail parses into, or `null` when the runtime does not read
   * the row at all.
   *
   * `null` is the machine-checkable definition of 'retired': the contract test asserts that
   * `buildSnapshot()` contains a `by.get('<key>')` for every non-null field and for NO null one, so
   * "retired" cannot degrade into "still quietly consulted" without going red.
   */
  field: keyof GovernanceSnapshot | null;
}

/**
 * Every policy key the backend can ship, classified.
 *
 * ⚠️ THE SET MUST BE COMPLETE. Two of the eighteen keys (`models.work_tiers` from migration 0045,
 * `models.pricing` from 0053) are INSERTed by SQL and appear in no TypeScript array, which is
 * exactly the pair a hand-copied list drops. The contract test diffs this map against the seeder's
 * POLICIES[] *and* the migrations, so a rail added by either route fails the build until it is
 * classified here.
 */
export const POLICY_ENFORCEMENT: Record<string, PolicyEnforcementEntry> = {
  // ---- data & isolation ----
  // No consumer. The property holds because `run-backend.ts` spawns the runner through
  // `scrubbedEnv()` (no DATABASE_URL, no provider keys) and `ctx.mockData()` resolves inside the
  // runner (`exec/mock-data.ts`). The toggle is a statement, not a gate.
  'data.block_prod_data': { enforcement: 'architectural', field: 'blockProdData' },
  // `run-policy.ts` refuses a run whose PII-typed input is fed by a non-mock source, and the
  // injection path masks at execution (`run-controller.ts`, `blocks/test-runner.ts`, `ai/mcp/*`).
  'data.pii_scrubbing': { enforcement: 'enforced', field: 'piiScrubbing' },
  // No consumer. One OS subprocess per run is what isolates; nothing consults the row.
  'data.cross_sandbox_isolation': { enforcement: 'architectural', field: 'crossSandboxIsolation' },
  // ⛔ RETIRED, NOT DELETED — see the file header and `policy-store.ts`. There is no residency
  // check anywhere in this codebase: `egress-guard.ts` resolves addresses and inspects them for
  // PRIVACY (SSRF) only, never for geography, and `sandboxes.region` is a column that defaults to
  // 'eu-west', is written by the seeders and echoed in DTOs, and is never compared to anything.
  // The seeded egress allowlist is built from the SAME provider catalog that ships
  // `api.anthropic.com`, `api.openai.com`, `api.deepseek.com`, `api.x.ai`, `api.cohere.ai` and
  // `openrouter.ai` — none of them EU-region, all of them seeded by the same file that seeded
  // `eu_only: true`.
  'data.eu_only': { enforcement: 'retired', field: null },
  // `run-controller.ts` refuses the run (422) in 'block' mode on a type/PII finding.
  'data.validation_mode': { enforcement: 'enforced', field: 'dataValidation' },
  // ---- spend & quotas ----
  'spend.daily_llm_cap': { enforcement: 'enforced', field: 'dailyLlmCap' },
  'spend.weekly_spend_ceiling': { enforcement: 'enforced', field: 'weeklySpendUsd' },
  // ⛔ 'applied' SINCE 2026-10-15 — IT WAS 'enforced' AND THAT STOPPED BEING TRUE. The sweep
  // (`sweepIdleSandboxes`) still turns this window into a cutoff and UPDATEs matching sandboxes to
  // `status='suspended', suspension_reason='idle'` — an ACTION. It used to END in a refusal: every
  // `POST /api/runs` on an idle-suspended sandbox threw `sandbox_suspended`. It no longer does: an
  // explicit run by the owner resumes the idle suspension inside the claim transaction
  // (`resumeOwnIdleSandbox`), and a sandbox is only ever run by its owner. So no run is turned away
  // for being on the wrong side of this window; an edit changes WHEN a sandbox is suspended (and an
  // audit row is written on the next run) — a live setting, which is what 'applied' says.
  // The refusal that remains (`sandbox_suspended` with `suspension_reason='admin'`) belongs to the
  // operator's pause, which this rail does not drive.
  'spend.auto_suspend_idle': { enforcement: 'applied', field: 'autoSuspendIdleMinutes' },
  // ⛔ APPLIED, NOT ENFORCED — and this is the closest call on the map, so the reasoning is written
  // down. `llm-broker.ts:324` prices a COMPLETED call; the cost it produces accumulates into
  // `usage_counters.spend_usd`, and THAT sum is what `spend.weekly_spend_ceiling` refuses on
  // (`llm-broker.ts:872`). So an edit here can change whether a LATER call is refused —
  // transitively. It is still not a boundary. A price is not a bound: nothing can violate a price
  // table, there is no value of it a call could be on the wrong side of, and the refusal that
  // eventually fires names `spend.weekly_spend_ceiling`, the rail that actually holds the line.
  // Letting an input to another rail's arithmetic claim that rail's enforcement would let every
  // number feeding a capped sum inherit the cap's boundary. `ai/llm/pricing.ts:352`
  // (`findUnpricedAllowlistedModels`) is a DRIFT REPORT for the Usage screen, not a refusal.
  'models.pricing': { enforcement: 'applied', field: 'modelPricing' },
  // ---- models & tools ----
  'models.allowlist': { enforcement: 'enforced', field: 'allowlistedModels' },
  // ⛔ ARCHITECTURAL SINCE 0099 — IT LOST ITS ONLY CONSUMER. The retired welcome budget
  // (host/budget-service.ts) was the one reader: it picked the grant key's model out of this map.
  // With the grant gone nothing reads `workTierModels`, so `applied` ("an edit changes the next
  // call") would be a false promise. The row stays seeded and parsed (policy_changes history FKs it);
  // if a reader comes back, the contract test reddens with the remedy: move it back to `applied`.
  'models.work_tiers': { enforcement: 'architectural', field: 'workTierModels' },
  'models.external_http': { enforcement: 'enforced', field: 'externalHttp' },
  // ⛔ RECLASSIFIED AT INTEGRATION, AND THE CONTRACT TEST IS WHY. This rail was written
  // `architectural` and that was TRUE at the time: nothing read `codeExecOutsideBlocks` on any path.
  // A sibling lane then added `blocks/source-gate.ts`, which reads it to decide whether a source that
  // trips the static scan is refused — so the rail acquired a real consumer and the classification
  // went stale in the merge, not in either branch. `policy-enforcement.backend-contract.test.ts`
  // failed the union with the exact remedy ("is 'architectural' but .codeExecOutsideBlocks is read by
  // src/blocks/source-gate.ts"). That is the guard earning its place: neither branch was wrong alone,
  // and only the merged tree could see it.
  //
  // ⚠️ THEREFORE THIS ENTRY IS MERGE-ORDER DEPENDENT. It is only correct once source-gate.ts exists.
  // Ship it in the same PR as the gate, never ahead of it — flipped early, the test reds for the
  // opposite reason (classified enforced, no consumer found).
  'models.code_exec_outside_blocks': {
    enforcement: 'enforced',
    field: 'codeExecOutsideBlocks',
  },
  // `data.` prefix, `models_tools` category — the key predates the regrouping and is an FK target.
  'data.egress_allowlist': { enforcement: 'enforced', field: 'egressAllowlist' },
  // ---- promotion to production ----
  'promotion.mandatory_review': { enforcement: 'enforced', field: 'mandatoryReview' },
  'promotion.required_reviewers': { enforcement: 'enforced', field: 'requiredReviewers' },
  // ⛔ APPLIED, NOT ENFORCED — flagged as needing a third kind by the commit that shipped the
  // bands (f0f3932) and left 'enforced' only because inventing one was out of that branch's scope.
  // `pipeline.ts:445` writes `set.rollout_pct = snapshot.stagingCanaryPct` when a card enters
  // Staging, and that assignment is the ONLY read of this rail anywhere. The number is echoed in
  // DTOs and rendered as a badge; it is never compared to anything (`rollout_pct` next to a
  // comparison operator matches NOWHERE in backend/src or frontend/src) and there is no
  // traffic-splitting code in this repo at all. Editing it changes the number the next promotion
  // records. Nothing can break it, so nothing can be refused for breaking it.
  'promotion.staging_canary_pct': { enforcement: 'applied', field: 'stagingCanaryPct' },
  'block_publish.require_passing_tests': { enforcement: 'enforced', field: 'requirePassingTests' },
  // Applied, not a refusal: it decides the next period's length (or that there is none). Read by
  // host/cycle-cadence.ts → cycle-service tickCycles / the vote gate.
  'cycle.cadence': { enforcement: 'applied', field: 'cycleCadence' },
};

/**
 * How a rail is backed — the value `/api/governance` puts on the wire.
 *
 * ⛔ AN UNKNOWN KEY IS 'architectural', NOT 'enforced' AND NOT 'applied'. A rail added by a
 * migration that nobody classified must not be able to CLAIM a boundary it may not have;
 * understating is the only safe direction for a compliance surface. 'applied' is NOT the safer
 * default either, even though it is weaker than 'enforced': it asserts that an edit DOES change
 * what happens on the next call, which is a positive claim about a rail nobody has looked at.
 * 'architectural' is the only kind whose note promises nothing. The contract test makes the default
 * unreachable in practice by demanding set equality with the real backend key set — it is a floor,
 * not the plan.
 */
export function policyEnforcement(key: string): PolicyEnforcement {
  return POLICY_ENFORCEMENT[key]?.enforcement ?? 'architectural';
}

/** True when the rail no longer makes its claim and must not accept an edit. */
export function isRetiredPolicy(key: string): boolean {
  return policyEnforcement(key) === 'retired';
}
