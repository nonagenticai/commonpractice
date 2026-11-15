// src/host/usage-metrics.ts — the Enterprise "Usage & Spend" aggregates (Phase 2-D).
// Every number is a REAL aggregate over the append-only usage_events ledger (one row
// per brokered LLM call, written in the metering txn), scoped to a tenant + time
// range. Mirrors ops-metrics.ts' raw-SQL query style.
//   * stats    — total spend + calls this period, distinct models + members
//   * byModel  — spend/calls per model (the BarRows)
//   * byDay    — zero-filled daily spend/calls (the Sparkline)
//   * byMember — spend/calls per member (the table)
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * How the spend in this period was priced (migration 0053 `usage_events.price_source`).
 *
 * The UI needs this to stop lying in BOTH directions. Before per-model pricing every figure was a
 * flat two-constant guess and was correctly hedged as `~$x`; now a call priced from OpenRouter's
 * reported charge is the actual invoice and should not carry a tilde. Conversely a range that
 * still contains flat-estimated or pre-0053 rows must keep it.
 *
 * `legacy` is rows written before `price_source` existed — deliberately never backfilled, because
 * there is no per-call price record to reconstruct one from. A range spanning the cutover mixes
 * two pricing regimes and cannot be reconciled; this field is what makes that visible.
 */
export interface PricingProvenance {
  provider: number;
  table: number;
  flat: number;
  legacy: number;
}

export interface UsageStats {
  spendUsd: number;
  calls: number;
  models: number;
  members: number;
  pricing: PricingProvenance;
  /**
   * The COMPLEMENT of HUMAN_ONLY below, additive rather than a change to any figure above.
   * `spendUsd`/`calls` on this object stay HUMAN-only on purpose (see HUMAN_ONLY) — this
   * answers a different question: how much did the PLATFORM's own background work (the
   * translation drainer; whatever follows it) cost while filed under this tenant's users over
   * the same period. Since the 2026-08-12 pricing correction (`ai/llm/pricing.ts:32-61`) that
   * cost is no longer structurally zero (see the note in `host/llm-broker.ts`'s
   * `BrokerCallMeta.platformActor` docblock), so it is now worth surfacing. This does NOT
   * change attribution — those rows still correctly carry a real human `user_id` — and it does
   * NOT add a ceiling; the existing weekly spend ceiling already bounds it.
   */
  platformSpendUsd: number;
  platformCalls: number;
}
export interface ModelUsage {
  model: string;
  provider: string;
  calls: number;
  spendUsd: number;
  /** True when ANY call for this model was flat-estimated or predates price_source, so the row's
   *  total is only approximate. False means every call was priced from a published rate or the
   *  provider's own charge. */
  estimated: boolean;
}
export interface DayUsage {
  day: string; // ISO date (UTC midnight)
  calls: number;
  spendUsd: number;
}
export interface MemberUsage {
  userId: string;
  name: string;
  calls: number;
  spendUsd: number;
}
export interface TenantUsage {
  rangeDays: number;
  stats: UsageStats;
  byModel: ModelUsage[];
  byDay: DayUsage[];
  byMember: MemberUsage[];
}

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>): Promise<Row[]> =>
  (await db.execute(q)) as unknown as Row[];

/**
 * ⛔ HUMAN-CAUSED ROWS ONLY. Applied to ALL FOUR aggregates below (migration 0063).
 * ONE fragment, defined once, so the four sites cannot drift apart — which they would, because
 * three of them append it to a WHERE and the fourth deliberately does not (see getByDay).
 *
 * WHY. /usage is the TENANT-ADMIN's screen and every decision it supports — budget, chargeback,
 * per-person coaching — is about work the tenant CAUSED and PAYS FOR. Platform background work
 * (the translation drainer; whatever follows it) is none of those three. 0061 split the COUNTER
 * so background work stopped eating a person's daily quota, but /usage reads `usage_events`, not
 * `usage_counters`, so the reporting half went unfixed. Measured in prod: 608 backfill rows, all
 * carrying ONE real person's `user_id`, all $0.00 — `getStats.calls` read 878 where humans made
 * 270; `getByModel` grew a `local-llm` row with 608 calls and a zero-width bar; the `getByDay`
 * sparkline is plotted on CALLS so the backfill burst set `dayMax` and flattened every genuine
 * human day; and `getByMember` printed 608 + that person's own calls as ONE INTEGER NEXT TO
 * THEIR NAME — sortable, and exported to a CSV that leaves the product.
 *
 * ⛔ THE ASYMMETRIC TRIO — DO NOT "HARMONISE" THESE. Three screens, three questions:
 *   host/ops-metrics.ts     /it-dash fleet headline = SUM(llm_calls + platform_llm_calls)  BOTH
 *   routes/sandboxes.ts     per-person sandbox row  = SUM(llm_calls)                      HUMAN
 *   host/usage-metrics.ts   /usage, all four        = NOT platform_actor  (this file)     HUMAN
 * Each is pinned by its own test — tests/ops-metrics.test.ts, tests/sandboxes-routes.test.ts and
 * tests/usage-metrics-platform.test.ts — which seed the SAME shape and assert DIFFERENT numbers
 * on purpose. Making any one match another reds exactly one of the three.
 *
 * ⛔ WHY NOT `stage <> 'content-translation'`, WHICH NEEDS NO COLUMN. `stage` is a CORRELATION
 * LABEL; its live values are 'flow-run', 'agent-chat', 'dataset-mapping' and
 * 'content-translation' — THREE OF THE FOUR ARE HUMAN. Filtering on it means hand-maintaining a
 * blacklist of the platform ones inside a SQL string, which breaks SILENTLY the day a second
 * platform drainer ships with a new stage: no error, no failing test, /usage quietly bills a
 * human again. `platformActor` is the real discriminator, it already exists, and it is already
 * load-bearing — it decides the daily-cap exemption and the counter split. A future platform
 * caller that forgets it therefore ALSO loses its cap exemption and stalls at 50 calls/day, i.e.
 * it fails LOUDLY instead of mis-attributing quietly.
 *
 * NO INDEX ON THIS COLUMN, on purpose. `usage_events_tenant_created_idx` already serves the
 * selective half of every predicate here (tenant + created_at); the table is low-thousands of
 * rows; and this is a ~69/31 boolean, which the planner will never choose over that index. A
 * b-tree on it would buy nothing and cost write amplification on the hottest INSERT path in the
 * product (one row per brokered LLM call). If it ever does matter the right shape is PARTIAL —
 * `(tenant_id, created_at) WHERE NOT platform_actor` — not a plain index on the boolean.
 *
 * RESIDUAL, measured rather than assumed. 0063 backfills in TWO steps: 608 rows carrying
 * `stage = 'content-translation'`, plus 106 PRE-0061 rows (written before `stage` existed) claimed
 * by correlating `created_at` against `translation_jobs.updated_at WHERE status = 'done'` — the
 * same drainer, the same call, a record in a different table. An earlier draft of this comment
 * claimed those 106 were "not separable from the 144 human NULL-stage rows"; that was false in
 * both halves (144 is the TOTAL, of which 106 are platform and 38 human) and it is exactly the
 * kind of unmeasured residual note that stops the next reader from looking. The 38 that remain
 * ARE genuinely human — zero translation jobs completed on those days. The only true residual is
 * a platform call that leaves no job row, of which none is currently known to exist.
 *
 * QUALIFIED `ue.` — which is why getStats and getByModel below now alias `usage_events AS ue`
 * even though neither joins anything. One fragment can only be shared by four queries if it
 * resolves identically in all four, and two of them DO join (`users u`, and the `days` series);
 * an unqualified `platform_actor` would resolve today only because nothing else in scope has
 * that name, and would become an ambiguous-column error the moment a join brought one in. The
 * alias is the cheap half of that trade.
 */
const HUMAN_ONLY = sql`NOT ue.platform_actor`;

async function getStats(tenantId: string, rangeDays: number): Promise<UsageStats> {
  const [[r], platform] = await Promise.all([
    rows(sql`
      SELECT COALESCE(SUM(ue.cost_usd), 0) AS spend,
             COUNT(*)::int AS calls,
             COUNT(DISTINCT ue.model)::int AS models,
             COUNT(DISTINCT ue.user_id)::int AS members,
             COUNT(*) FILTER (WHERE ue.price_source = 'provider')::int AS priced_provider,
             COUNT(*) FILTER (WHERE ue.price_source = 'table')::int AS priced_table,
             COUNT(*) FILTER (WHERE ue.price_source = 'flat')::int AS priced_flat,
             COUNT(*) FILTER (WHERE ue.price_source IS NULL)::int AS priced_legacy
      FROM usage_events ue
      WHERE ue.tenant_id = ${tenantId}
        AND ue.created_at >= now() - make_interval(days => ${rangeDays})
        -- NOTE: no backticks anywhere in these SQL comments — this is a TS template literal, and a
        --       backtick here terminates it mid-query. See the HUMAN_ONLY block at the top.
        -- ⛔ See HUMAN_ONLY at the top of this file. This also un-pads the four price_source
        --    buckets, which the UI reads to decide whether to hedge every figure with a tilde.
        AND ${HUMAN_ONLY}
    `),
    getPlatformCost(tenantId, rangeDays),
  ]);
  return {
    spendUsd: Number(r?.spend ?? 0),
    calls: Number(r?.calls ?? 0),
    models: Number(r?.models ?? 0),
    members: Number(r?.members ?? 0),
    pricing: {
      provider: Number(r?.priced_provider ?? 0),
      table: Number(r?.priced_table ?? 0),
      flat: Number(r?.priced_flat ?? 0),
      legacy: Number(r?.priced_legacy ?? 0),
    },
    platformSpendUsd: platform.spendUsd,
    platformCalls: platform.calls,
  };
}

/**
 * The COMPLEMENT of HUMAN_ONLY — a SEPARATE query, not a widened WHERE on getStats above, so
 * the four HUMAN-only aggregates (pinned by tests/usage-metrics-platform.test.ts) cannot drift
 * just because this one exists. Answers "how much of this tenant's ledger over this period was
 * the platform's own background work" — real money since the 2026-08-12 pricing correction
 * (`ai/llm/pricing.ts:32-61` stopped pricing `local-llm` at zero), where before it was
 * structurally $0.00 and not worth a query. Read-only visibility: this does not change
 * attribution (the rows still correctly carry a real human `user_id`, migration 0063) and does
 * not add a ceiling (the existing weekly spend ceiling in `host/llm-broker.ts` already bounds
 * platform spend — see `BrokerCallMeta.platformActor`).
 *
 * NO INDEX here either, same reasoning as HUMAN_ONLY above: `usage_events_tenant_created_idx`
 * already serves tenant + created_at, and the table is low-thousands of rows.
 */
async function getPlatformCost(
  tenantId: string,
  rangeDays: number,
): Promise<{ spendUsd: number; calls: number }> {
  const [r] = await rows(sql`
    SELECT COALESCE(SUM(ue.cost_usd), 0) AS spend,
           COUNT(*)::int AS calls
    FROM usage_events ue
    WHERE ue.tenant_id = ${tenantId}
      AND ue.created_at >= now() - make_interval(days => ${rangeDays})
      AND ue.platform_actor
  `);
  return {
    spendUsd: Number(r?.spend ?? 0),
    calls: Number(r?.calls ?? 0),
  };
}

async function getByModel(tenantId: string, rangeDays: number): Promise<ModelUsage[]> {
  const r = await rows(sql`
    SELECT ue.model AS model,
           MAX(ue.provider) AS provider,
           COUNT(*)::int AS calls,
           COALESCE(SUM(ue.cost_usd), 0) AS spend,
           BOOL_OR(ue.price_source IS NULL OR ue.price_source = 'flat') AS estimated
    FROM usage_events ue
    WHERE ue.tenant_id = ${tenantId}
      AND ue.created_at >= now() - make_interval(days => ${rangeDays})
      -- ⛔ See HUMAN_ONLY at the top of this file. Without it prod grows a local-llm row of 608
      --    calls at $0.00 which, because this is ORDER BY spend, sorts LAST and renders as a
      --    zero-width bar — the largest row by count, drawn as nothing.
      AND ${HUMAN_ONLY}
    GROUP BY ue.model
    ORDER BY spend DESC, calls DESC
    LIMIT 20
  `);
  return r.map((x) => ({
    model: String(x.model),
    provider: x.provider == null ? '' : String(x.provider),
    calls: Number(x.calls),
    spendUsd: Number(x.spend),
    estimated: x.estimated === true,
  }));
}

async function getByDay(tenantId: string, rangeDays: number): Promise<DayUsage[]> {
  const r = await rows(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', now()) - make_interval(days => ${rangeDays - 1}),
        date_trunc('day', now()),
        interval '1 day'
      ) AS d
    )
    SELECT days.d AS day,
           COALESCE(COUNT(ue.id), 0)::int AS calls,
           COALESCE(SUM(ue.cost_usd), 0) AS spend
    FROM days
    LEFT JOIN usage_events ue
      ON date_trunc('day', ue.created_at) = days.d
     AND ue.tenant_id = ${tenantId}
     -- ⛔ HUMAN_ONLY BELONGS IN THIS ON CLAUSE AND **NEVER** IN A WHERE. Moved to WHERE it
     --    degenerates the LEFT JOIN into an INNER JOIN (for a day with no matching row every
     --    ue.* is NULL, and NOT NULL is NULL, which is not TRUE), destroying the
     --    generate_series zero-fill: byDay collapses from rangeDays entries to only the days
     --    that happen to have rows, the sparkline silently re-scales, and the x-axis lies about
     --    which days those are. The TOTALS stay correct, which is precisely what makes it
     --    dangerous — tests/usage-metrics-platform.test.ts asserts byDay.length SEPARATELY from
     --    the sum of byDay[].calls for exactly this reason: the sum-only test stays GREEN.
     AND ${HUMAN_ONLY}
    GROUP BY days.d
    ORDER BY days.d
  `);
  return r.map((x) => ({
    day: new Date(x.day as string).toISOString(),
    calls: Number(x.calls),
    spendUsd: Number(x.spend),
  }));
}

async function getByMember(tenantId: string, rangeDays: number): Promise<MemberUsage[]> {
  const r = await rows(sql`
    SELECT ue.user_id AS user_id,
           COALESCE(u.name, '—') AS name,
           COUNT(*)::int AS calls,
           COALESCE(SUM(ue.cost_usd), 0) AS spend
    FROM usage_events ue
    LEFT JOIN users u ON u.id = ue.user_id
    WHERE ue.tenant_id = ${tenantId}
      AND ue.created_at >= now() - make_interval(days => ${rangeDays})
      -- ⛔ See HUMAN_ONLY at the top of this file. THIS IS THE LOAD-BEARING ONE: without it a real
      --    person's row reads 608 platform calls + their own as a single integer beside their
      --    name, the "Calls" header is sortable so they lead a per-person table on work they did
      --    not do, and the client-side CSV writes that number to a file that leaves the product.
      AND ${HUMAN_ONLY}
    GROUP BY ue.user_id, u.name
    ORDER BY spend DESC, calls DESC
    LIMIT 20
  `);
  return r.map((x) => ({
    userId: String(x.user_id),
    name: String(x.name),
    calls: Number(x.calls),
    spendUsd: Number(x.spend),
  }));
}

/** Aggregate one tenant's usage over the last `rangeDays` days. */
export async function getTenantUsage(
  tenantId: string,
  rangeDays: number,
): Promise<TenantUsage> {
  const [stats, byModel, byDay, byMember] = await Promise.all([
    getStats(tenantId, rangeDays),
    getByModel(tenantId, rangeDays),
    getByDay(tenantId, rangeDays),
    getByMember(tenantId, rangeDays),
  ]);
  return { rangeDays, stats, byModel, byDay, byMember };
}
