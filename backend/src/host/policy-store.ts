// src/host/policy-store.ts — the LIVE governance store (Session 6).
// Reads the `policies` table and parses each row into the typed shape its
// enforcement point consumes. This is the single source of truth behind
// getGovernanceLimits() (broker), getSandboxLimits() (idle sweep), and
// enforceRunPolicies() (the run-gate) — editing a policy row changes runtime
// behaviour. config.governance.* is only the code-level fallback when a row is
// ABSENT (fresh DB before seed, or a key the migration didn't ship).
//
// Cached with a short TTL so a brokered LLM call / per-minute watchdog tick does
// not hit the DB every time; invalidatePolicyCache() is called by the governance
// PATCH route so an edit is visible immediately (no restart, no TTL wait).
import { db as defaultDb, policies } from '../db/client';
import type { Policy, PolicyValue } from '../db/schema';
import { config } from '../config';
import {
  defaultModelPricing,
  DEFAULT_WORK_TIER_MODELS,
  type WorkTier,
} from '../ai/llm/provider-catalog';
import { parsePricingTable, type PricingTable } from '../ai/llm/pricing';
import { isCadence, type Cadence } from './period';

type Db = typeof defaultDb;

export interface GovernanceSnapshot {
  // spend & quotas
  dailyLlmCap: number;
  weeklySpendUsd: number;
  autoSuspendIdleMinutes: number;
  // models & tools
  allowlistedModels: string[];
  externalHttp: boolean;
  codeExecOutsideBlocks: boolean;
  /** Hosts (host or host:port) a read-only data connector may reach. Empty = none.
   *  Enforced host-side in egress-guard.ts together with externalHttp + an SSRF
   *  private-IP reject. */
  egressAllowlist: string[];
  // data & isolation
  piiScrubbing: boolean;
  /** ⚠️ NO CONSUMER, AND THAT IS THE POINT. `blockProdData` and `crossSandboxIsolation` are parsed
   *  and carried but nothing reads them (measured across src/, tests/ and scripts/): the properties
   *  they name are true because the runner is spawned through `scrubbedEnv()` and gets its own OS
   *  process, not because these booleans exist. They are classified `'architectural'` in
   *  `policy-enforcement.ts`, which is what /governance renders — do not "wire them up" to a refusal
   *  without moving the classification with it, or the screen goes back to lying in the other
   *  direction. `codeExecOutsideBlocks` below is the same case. */
  blockProdData: boolean;
  crossSandboxIsolation: boolean;
  // ⛔ `euOnly` USED TO SIT HERE AND WAS DELETED, DELIBERATELY. `data.eu_only` is a RETIRED rail: no
  // residency check exists anywhere in this codebase, so parsing the row into a typed field only
  // invited a future caller to trust it. The `policies` ROW still exists (it is the FK target of
  // `policy_changes.policy_key`) and /api/governance still ships it, marked `enforcement: 'retired'`
  // and read-only. `policy-enforcement.ts` maps it to `field: null`, and the contract test asserts
  // that no `by.get('data.eu_only')` reappears below — that absence IS the retirement.
  /** Phase 4: run-time validation of datasets bound to an ontology entity. 'block' refuses the
   *  run (422) on a type/PII finding; 'warn' records a finding and proceeds. Default 'warn'. */
  dataValidation: 'warn' | 'block';
  // promotion
  mandatoryReview: boolean;
  requiredReviewers: number;
  stagingCanaryPct: number;
  /** Block publish gate (Phase 2-B): publishing to `stable` requires ≥1 enabled
   *  per-block test and all passing (re-run at publish). Default true. */
  requirePassingTests: boolean;
  /** Which model each work tier resolves to (migration 0045, `models.work_tiers`). Operator-
   *  editable on the Governance screen so a model id can change without a deploy; falls back to
   *  DEFAULT_WORK_TIER_MODELS when the row is absent. */
  workTierModels: Record<WorkTier, string>;
  /**
   * Per-model prices the broker charges a call at (migration 0053, `models.pricing`).
   *
   * Operator-editable for the same reason as `models.work_tiers`, only more urgently: the five
   * direct providers (Anthropic, OpenAI, DeepSeek, xAI, Cohere) publish NO pricing API, so this
   * table is hand-maintained and nothing can verify it. Keeping it in a governance row means a
   * stale price is a one-field correction on the Governance screen, not a release.
   */
  modelPricing: PricingTable;
  /** The marketplace voting-cycle cadence (`cycle.cadence`, 0107): off | week | month | quarter | year. The
   *  engine and the vote gate read the row through host/cycle-cadence.ts (uncached, so a change is
   *  seen by the very next tick); this field is the same value for snapshot readers. Falls back to
   *  the CYCLE_ENABLED bootstrap when the row is absent. */
  cycleCadence: Cadence;
  /** A PENDING cadence switch (0107 `policies.effective_from` / `previous_value` on the
   *  `cycle.cadence` row): before `cycleCadenceSwitchAt` the previous value is still in force.
   *  Optional so hand-built test snapshots need not carry it; absent = no switch pending. */
  cycleCadenceSwitchAt?: Date | null;
  cycleCadencePrevious?: Cadence | null;
}

const CACHE_TTL_MS = 5_000;
let cache: { snapshot: GovernanceSnapshot; at: number } | undefined;

/** Clear the snapshot cache so the next read reflects a just-applied edit. */
export function invalidatePolicyCache(): void {
  cache = undefined;
}

// Test seam (house pattern — like __setAuthOverridesForTests / __setEgressHooksForTests). When
// set, getSnapshot() returns this snapshot verbatim (no DB read, no cache) so a route test can
// pin externalHttp + the egress allowlist for a delivery dispatch WITHOUT mutating the shared
// `policies` table (which would leak into other test files). Production never sets it.
let _override: GovernanceSnapshot | undefined;
export function __setSnapshotOverrideForTests(snapshot?: GovernanceSnapshot): void {
  _override = snapshot;
}

const asBool = (v: PolicyValue | undefined, fb: boolean): boolean =>
  typeof v === 'boolean' ? v : fb;
const asNum = (v: PolicyValue | undefined, fb: number): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fb;
};
const asList = (v: PolicyValue | undefined): string[] =>
  Array.isArray(v) ? v.map(String) : [];
const asValidationMode = (v: PolicyValue | undefined): 'warn' | 'block' =>
  v === 'block' ? 'block' : 'warn';
/** Merge a stored `map` policy over the defaults so a missing/partial row degrades per key
 *  rather than wiping the whole tier map. */
const asWorkTiers = (v: PolicyValue | undefined): Record<WorkTier, string> => {
  const out = { ...DEFAULT_WORK_TIER_MODELS } as Record<WorkTier, string>;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const tier of Object.keys(out) as WorkTier[]) {
      const model = (v as Record<string, unknown>)[tier];
      if (typeof model === 'string' && model.trim()) out[tier] = model.trim();
    }
  }
  return out;
};

/**
 * Merge the stored `models.pricing` map over the catalog defaults, per key.
 *
 * Same degrade-per-key discipline as `asWorkTiers`: a row that is absent, partial, or contains one
 * malformed entry must not wipe the whole table — an unpriced model silently falling back to the
 * flat Sonnet-ish rate is precisely the bug this work exists to remove. A stored key always wins
 * over the default, so an operator correction sticks.
 */
const asModelPricing = (v: PolicyValue | undefined): PricingTable => {
  const defaults = parsePricingTable(defaultModelPricing());
  return { ...defaults, ...parsePricingTable(v) };
};

const asCadence = (v: PolicyValue | undefined): Cadence =>
  isCadence(v) ? v : config.cycle.enabled ? 'week' : 'off';

/** The pending-switch fields of the `cycle.cadence` row (null when none is pending). */
function cadenceSwitchOf(row: Policy | undefined): { cycleCadenceSwitchAt: Date | null; cycleCadencePrevious: Cadence | null } {
  const at = row?.effective_from ?? null;
  const prev = row?.previous_value;
  return at && isCadence(prev) ? { cycleCadenceSwitchAt: at, cycleCadencePrevious: prev } : { cycleCadenceSwitchAt: null, cycleCadencePrevious: null };
}

/** Build the typed snapshot from raw rows, falling back to config per key. */
export function buildSnapshot(rows: Policy[]): GovernanceSnapshot {
  const by = new Map(rows.map((r) => [r.key, r.value]));
  const g = config.governance;
  // "7 days" / "14 days" → minutes; "2" → reviewers.
  const idleRaw = by.get('spend.auto_suspend_idle');
  const idleDays = idleRaw ? Number.parseInt(String(idleRaw), 10) : NaN;
  const idleMinutes = Number.isFinite(idleDays)
    ? idleDays * 24 * 60
    : g.autoSuspendIdleMinutes;
  return {
    dailyLlmCap: asNum(by.get('spend.daily_llm_cap'), g.dailyLlmCap),
    weeklySpendUsd: asNum(by.get('spend.weekly_spend_ceiling'), g.weeklySpendUsd),
    autoSuspendIdleMinutes: idleMinutes,
    allowlistedModels: asList(by.get('models.allowlist')),
    externalHttp: asBool(by.get('models.external_http'), false),
    codeExecOutsideBlocks: asBool(by.get('models.code_exec_outside_blocks'), false),
    egressAllowlist: asList(by.get('data.egress_allowlist')),
    piiScrubbing: asBool(by.get('data.pii_scrubbing'), true),
    blockProdData: asBool(by.get('data.block_prod_data'), true),
    crossSandboxIsolation: asBool(by.get('data.cross_sandbox_isolation'), true),
    dataValidation: asValidationMode(by.get('data.validation_mode')),
    mandatoryReview: asBool(by.get('promotion.mandatory_review'), true),
    requiredReviewers: Math.max(0, Math.trunc(asNum(by.get('promotion.required_reviewers'), 2))),
    stagingCanaryPct: asNum(by.get('promotion.staging_canary_pct'), 5),
    requirePassingTests: asBool(by.get('block_publish.require_passing_tests'), true),
    workTierModels: asWorkTiers(by.get('models.work_tiers')),
    modelPricing: asModelPricing(by.get('models.pricing')),
    cycleCadence: asCadence(by.get('cycle.cadence')),
    ...cadenceSwitchOf(rows.find((r) => r.key === 'cycle.cadence')),
  };
}

/** The current governance snapshot (cached ≤5s). */
export async function getSnapshot(
  database: Db = defaultDb,
  now: number = Date.now(),
): Promise<GovernanceSnapshot> {
  if (_override) return _override;
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.snapshot;
  const rows = await database.select().from(policies);
  const snapshot = buildSnapshot(rows);
  cache = { snapshot, at: now };
  return snapshot;
}
