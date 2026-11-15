// src/host/translation-service.ts — Phase 2-G: the deep i18n content pipeline.
//
// §5B wired the READ side (content_translations + getTranslation*); this is the WRITE
// side. Three pure-ish entry points, all db-injectable + unit-testable:
//   • enqueueTranslations() — best-effort, called from content create/edit + the admin
//     backfill. One job per translatable cell × target locale, edit-aware via source_hash.
//   • processPendingBatch() — the single idempotent drain step the scheduler AND the
//     manual /run route call. Translates each pending job via the metered broker and
//     UPSERTs content_translations. A cap reject DEFERS that ACTOR's remaining jobs (they
//     stay pending, attempts untouched) and the batch continues with everyone else; a hard
//     error retries up to maxAttempts then marks the job 'failed'.
//   • translateText() — one broker round-trip (host-side key, metered spend).
//
// The broker (host/llm-broker.ts) resolves the real per-tenant/env provider — in prod
// the in-cluster inference-router (openai-compatible) — so this produces REAL
// translations with no per-tenant key. Metering is attributed to requested_by (the
// content creator for auto-enqueue, the admin for a backfill) — but as PLATFORM load
// (`usage_counters.platform_llm_calls`), not against that person's daily call quota. See
// `BrokerCallMeta.platformActor` and migration 0061 for why that distinction is load-bearing.
import { createHash } from 'node:crypto';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import {
  db as defaultDb,
  withTenantDb,
  withTenantTx,
  translationJobs,
  contentTranslations,
  users,
  challenges,
  solutions,
  flows,
  buildingBlocks,
  blockVersions,
  blockTemplates,
} from '../db/client';
import { config } from '../config';
import { blockI18nKey } from '../blocks/i18n-key';
// ⛔ The KEY module, not templates-service: `templates/templates-service.ts` imports
// `enqueueTranslations` from THIS file, so importing it back would be a require cycle.
import { templateI18nKey } from '../templates/i18n-key';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type Locale } from '../utils/locale';
import { brokerChatCall } from './llm-broker';
import { recordAudit } from './audit-service';
import { log } from './logger';

type Db = typeof defaultDb;

/** The 7 non-default target locales (en is the base, never a translation target). */
export const TARGET_LOCALES: Locale[] = SUPPORTED_LOCALES.filter(
  (l) => l !== DEFAULT_LOCALE,
);

/** Human-readable language names for the translator prompt (one per target locale). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  nl: 'Dutch',
  pl: 'Polish',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  ar: 'Arabic',
  he: 'Hebrew',
};

/** Thrown when the broker rejects on the daily-call / weekly-spend cap. The drainer
 *  catches this to DEFER the batch (leave the job pending) rather than fail it. */
export class CapReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapReached';
  }
}

/** sha256 of the source text — the staleness key for edit-aware enqueue. */
export function sourceHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface TranslatableField {
  field: string;
  value: string | null | undefined;
}

/**
 * Enqueue (or refresh) translation jobs for one entity. For each non-empty field ×
 * each target locale, UPSERT a pending job; the `source_hash <> EXCLUDED.source_hash`
 * guard makes an unchanged cell a no-op and resets an edited cell to pending. Returns
 * the number of cells touched (inserted or reset). BEST-EFFORT: callers wrap this so a
 * translation hiccup never blocks content creation.
 */
export async function enqueueTranslations(
  entityType: string,
  entityId: string,
  fields: TranslatableField[],
  requestedBy: string | null,
  opts: { force?: boolean; db?: Db } = {},
): Promise<number> {
  const db = opts.db ?? defaultDb;
  const rows = fields
    .filter((f) => typeof f.value === 'string' && f.value.trim().length > 0)
    .flatMap((f) =>
      TARGET_LOCALES.map((locale) => ({
        entity_type: entityType,
        entity_id: entityId,
        field: f.field,
        target_locale: locale,
        source_text: f.value as string,
        source_hash: sourceHash(f.value as string),
        status: 'pending' as const,
        attempts: 0,
        error: null,
        requested_by: requestedBy,
      })),
    );
  if (rows.length === 0) return 0;

  const result = await db
    .insert(translationJobs)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        translationJobs.entity_type,
        translationJobs.entity_id,
        translationJobs.field,
        translationJobs.target_locale,
      ],
      set: {
        source_text: sql`excluded.source_text`,
        source_hash: sql`excluded.source_hash`,
        status: 'pending',
        attempts: 0,
        error: null,
        requested_by: sql`excluded.requested_by`,
        updated_at: sql`now()`,
      },
      // only reset a job when the source actually changed — an unchanged cell is a no-op.
      // `force` (admin re-queue) drops the guard and resets every matched cell.
      ...(opts.force
        ? {}
        : { setWhere: sql`${translationJobs.source_hash} <> excluded.source_hash` }),
    });
  return (result as { count?: number }).count ?? rows.length;
}

/** Resolve the actor's active tenant (for per-tenant BYO-key selection + attribution);
 *  null when the user has no active tenant (the broker treats null as the personal
 *  tenant and the env-fallback provider ignores it). */
export async function tenantOf(
  userId: string | null,
  db: Db = defaultDb,
): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ tenantId: users.tenant_id })
    .from(users)
    .where(eq(users.id, userId));
  return row?.tenantId ?? null;
}

/** Translate `text` into `targetLocale` via the metered broker. Throws CapReached on a
 *  cap reject (so the drainer defers), or Error on any other failure (so the job retries
 *  then fails). The provider key never leaves the broker. */
export async function translateText(
  text: string,
  targetLocale: Locale,
  actorUserId: string,
  tenantId: string | null,
  signal: AbortSignal,
): Promise<string> {
  const language = LOCALE_NAMES[targetLocale] ?? targetLocale;
  const system =
    `You are a professional translator. Translate the user's message into ${language}. ` +
    'Preserve technical terms, product names, code, URLs, and any markdown/formatting ' +
    'exactly. Do not add notes, explanations, or quotation marks. Output ONLY the ' +
    'translated text.';
  const outcome = await brokerChatCall(
    actorUserId,
    tenantId,
    {
      model: config.agent.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
      // headroom for long docs_md; the broker meters the real provider-counted usage.
      maxTokens: 4000,
    },
    { signal },
    // ⛔ `platformActor` is a GOVERNANCE opt-in, not a label — see BrokerCallMeta. This call is
    // made by the drainer, on a schedule, with no human in the loop; `actorUserId` is the person
    // who ASKED FOR THE CONTENT TO EXIST (audit data), not someone spending their allowance right
    // now. Without this flag the 608-job backlog measured in prod is permanently blocked by that
    // person's 50/day call cap at a total cost of $0.00 (migration 0061). The weekly SPEND ceiling
    // still applies, so this is not an unbounded exemption.
    { stage: 'content-translation', platformActor: true },
  );
  if (!outcome.ok) {
    if (outcome.kind === 'llm_capped') throw new CapReached(outcome.error);
    throw new Error(outcome.error);
  }
  const out = (outcome.result.text ?? '').trim();
  if (!out) throw new Error('empty translation');
  return out;
}

export interface BatchResult {
  processed: number;
  failed: number;
  deferred: number;
  /**
   * How many DISTINCT (tenant, actor) pairs hit a cap during this tick and had their remaining
   * jobs skipped. `cappedActors > 0` with `processed === 0` is a STALL: the drainer ran, did
   * work-shaped nothing, and will do the same on the next tick until an operator changes
   * something. That state used to be invisible — a pure-defer tick wrote no audit row and the
   * scheduler logged nothing — which is how a 608-job backlog sat still for long enough to be
   * discovered from the OUTPUT side (untranslated blocks) rather than from the queue.
   */
  cappedActors: number;
}

/** The translate step, injectable so the batch engine is unit-testable without the
 *  broker's global override seam (mirrors the `db` injection). Defaults to the real
 *  metered translateText in production. */
export type TranslateFn = (
  text: string,
  targetLocale: Locale,
  actorUserId: string,
  tenantId: string | null,
  signal: AbortSignal,
) => Promise<string>;

/**
 * Drain up to `limit` pending jobs (the single idempotent step the scheduler AND the
 * manual /run route call). For each: translate → UPSERT content_translations → mark
 * the job done. Any error other than a cap increments attempts and marks the job 'failed'
 * past maxAttempts.
 *
 * ⛔ A CapReached SKIPS THAT ACTOR, IT NO LONGER STOPS THE BATCH. This used to `break`, which
 * made ONE capped actor a total outage for every other tenant's queued content: the pending
 * select is ordered by `created_at`, so the capped actor's jobs sort first forever and no later
 * job is ever reached. In prod that was 608 pending jobs behind a single user, and every other
 * tenant's translations queued behind them indefinitely. Now the capped (tenant, actor) pair is
 * recorded and its remaining jobs are deferred one by one while the rest of the batch proceeds.
 */
export async function processPendingBatch(
  _now: Date,
  db: Db = defaultDb,
  limit = config.translation.batchSize,
  translate: TranslateFn = translateText,
): Promise<BatchResult> {
  const jobs = await db
    .select()
    .from(translationJobs)
    .where(eq(translationJobs.status, 'pending'))
    .orderBy(asc(translationJobs.created_at))
    .limit(limit);

  const out: BatchResult = { processed: 0, failed: 0, deferred: 0, cappedActors: 0 };
  const tenantCache = new Map<string, string | null>();
  const controller = new AbortController();
  /**
   * (tenant, actor) pairs already known to be capped on THIS tick → the cap message.
   *
   * ⛔ KEYED `${tenantId}:${actor}`, NOT by actor alone. Since 0061 the only cap that can still
   * fire for the drainer is the WEEKLY SPEND ceiling (the daily CALL cap is skipped for platform
   * calls), and `reserveCall` scopes that ceiling to exactly `(tenant_id, user_id)` — one user
   * legitimately holds a separate counter row, and a separate ceiling, per tenant. Keying on the
   * actor alone would suppress work for a tenant whose budget is untouched.
   */
  const capped = new Map<string, string>();

  for (const job of jobs) {
    const actor = job.requested_by;
    if (!actor) {
      // no metering actor (e.g. a creator deleted) → cannot meter; mark failed, don't block.
      await markFailed(db, job.id, 'no metering actor', config.translation.maxAttempts);
      out.failed += 1;
      continue;
    }
    let tenantId = tenantCache.get(actor);
    if (tenantId === undefined) {
      tenantId = await tenantOf(actor, db);
      tenantCache.set(actor, tenantId);
    }
    if (!tenantId) {
      // No home tenant → the broker cannot meter under RLS (usage_counters/usage_events are
      // tenant-scoped and would fail the GUC/NOT-NULL check). Fail closed; don't block the batch.
      await markFailed(db, job.id, 'no home tenant for metering actor', config.translation.maxAttempts);
      out.failed += 1;
      continue;
    }
    // Already capped on this tick → do NO work for this job. Not a retry, not an attempt bump:
    // we already know the answer for this (tenant, actor) and re-asking costs a broker round-trip
    // per job. With 608 jobs behind one actor that is 608 pointless transactions per tick.
    if (capped.has(`${tenantId}:${actor}`)) {
      out.deferred += 1;
      continue;
    }
    try {
      // The broker meters into usage_counters/usage_events (RLS-scoped) — run the job under the
      // actor's tenant so those writes carry app.current_tenant. withTenantTx, NOT withTenantDb:
      // the latter RESERVES one of only 6 request connections and would hold it across the whole
      // provider call (`translate`), so a batch of slow translations starves the request pool.
      // The broker's metering is transaction-only, so it stays RLS-scoped with nothing reserved;
      // the two plain-statement writes below take their own short-lived withTenantDb.
      await withTenantTx(tenantId, async () => {
        const value = await translate(
          job.source_text,
          job.target_locale as Locale,
          actor,
          tenantId!,
          controller.signal,
        );
        // Plain statements get NO GUC under withTenantTx — reserve narrowly for the writes only.
        await withTenantDb(tenantId, async () => {
          await db
            .insert(contentTranslations)
            .values({
              entity_type: job.entity_type,
              entity_id: job.entity_id,
              locale: job.target_locale,
              field: job.field,
              value,
            })
            .onConflictDoUpdate({
              target: [
                contentTranslations.entity_type,
                contentTranslations.entity_id,
                contentTranslations.locale,
                contentTranslations.field,
              ],
              set: { value, updated_at: sql`now()` },
            });
          await db
            .update(translationJobs)
            .set({ status: 'done', error: null, updated_at: sql`now()` })
            .where(eq(translationJobs.id, job.id));
        });
      });
      out.processed += 1;
    } catch (err) {
      if (err instanceof CapReached) {
        // ⛔ INVARIANT 1: A CAP MUST NOT CALL `markFailed`. A cap is not a job failure — nothing
        // is wrong with this job and nothing about retrying it differently would help. markFailed
        // bumps `attempts`, and `attempts >= maxAttempts` flips the row to 'failed', so routing a
        // cap through it would burn a healthy job's three lives on three consecutive capped ticks
        // and permanently drop content that was never even attempted. `attempts` stays put and
        // the job stays 'pending'.
        const msg = err instanceof Error ? err.message : String(err);
        capped.set(`${tenantId}:${actor}`, msg);
        out.deferred += 1;
        log.warn('translation_actor_capped', { component: 'translation', actor, tenantId, error: msg });
        continue; // was `break` — one capped actor must not stall every other tenant's queue.
      }
      // ⛔ INVARIANT 2: `model_not_allowed` MUST KEEP FALLING THROUGH TO HERE. The broker raises
      // it as a plain Error, not a CapReached, and that is correct: an un-allowlisted AGENT_MODEL
      // is a CONFIGURATION FAULT, not a quota. It must burn attempts and land the job in 'failed'
      // where the admin panel shows it with the message attached. Reclassifying it as a defer
      // would make a permanently-broken config look exactly like a temporarily-capped tenant —
      // an infinitely-retrying silent queue, which is the failure shape this whole change exists
      // to remove.
      const msg = err instanceof Error ? err.message : String(err);
      await markFailed(db, job.id, msg, config.translation.maxAttempts);
      out.failed += 1;
    }
  }
  out.cappedActors = capped.size;

  // ⛔ A PURE-DEFER TICK MUST WRITE AN AUDIT ROW. This block used to gate on
  // `processed > 0 || failed > 0`, so the one outcome that actually needed an operator's
  // attention — the drainer ran, could do nothing, and will do nothing again next tick — was the
  // single outcome that left no trace anywhere. That is how a 608-job backlog went unnoticed
  // until it was spotted from the OUTPUT side (blocks rendering English in every locale).
  if (out.processed > 0 || out.failed > 0 || out.cappedActors > 0) {
    const stalled = out.processed === 0 && out.cappedActors > 0;
    await recordAudit({
      action: 'translation.batch',
      category: 'system',
      targetType: 'translation_jobs',
      result: stalled
        ? `NO PROGRESS — ${out.cappedActors} capped actor(s), ${out.deferred} deferred, ` +
          `${out.failed} failed. The queue is not draining.`
        : `${out.processed} translated, ${out.failed} failed, ${out.deferred} deferred` +
          (out.cappedActors > 0 ? `, ${out.cappedActors} capped actor(s)` : ''),
      resultTone: stalled || out.failed > 0 ? 'warn' : 'ok',
      metadata: { ...out },
    });
  }
  return out;
}

/** Bump attempts; mark 'failed' once attempts reach maxAttempts, else keep 'pending'. */
async function markFailed(
  db: Db,
  jobId: string,
  error: string,
  maxAttempts: number,
): Promise<void> {
  await db
    .update(translationJobs)
    .set({
      attempts: sql`${translationJobs.attempts} + 1`,
      error,
      status: sql`CASE WHEN ${translationJobs.attempts} + 1 >= ${maxAttempts} THEN 'failed' ELSE 'pending' END`,
      updated_at: sql`now()`,
    })
    .where(eq(translationJobs.id, jobId));
}

/** Count pending jobs (the drainer skips work when zero; the admin panel shows it). */
export async function pendingCount(db: Db = defaultDb): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(translationJobs)
    .where(eq(translationJobs.status, 'pending'));
  return row?.n ?? 0;
}

/** What one backfill run touched. `matched` is the number of CONTENT ROWS the per-type SELECTs below
 *  could see; `queued` is the number of locale cells written. The two are reported separately
 *  because `queued === 0` is ambiguous on its own — it means EITHER "every cell was already
 *  up to date" (the `setWhere` guard made them no-ops) OR "this caller cannot see that entity at
 *  all". `matched` is what tells the caller which, and routes/translations.ts turns
 *  `matched === 0` on an explicit `entityId` into a 404 instead of a green `{queued: 0}`. */
export interface BackfillResult {
  queued: number;
  matched: number;
}

/**
 * Admin backfill: enqueue jobs for EXISTING content (the on-ramp for pre-G rows that
 * were created before auto-enqueue existed). Scoped by entityType (+ optional entityId);
 * `force` re-queues even unchanged cells.
 *
 * ⛔ THIS RUNS IN THE CALLER'S RLS SCOPE, AND THAT IS DELIBERATE — DO NOT WRAP IT IN `runAsSystem`.
 * `challenges`, `solutions`, `flows` and `building_blocks` are all under RLS (0028_rls.sql) and
 * this function adds no tenant filter of its own, so its reach is exactly whatever
 * `app.current_tenant` the caller is
 * bound to. Widening it to every tenant looks like the obvious fix for "the backfill only covered
 * one workspace", and it is a CROSS-TENANT BILLING BUG:
 *
 *   `translation_jobs` HAS NO `tenant_id`. The tenant that gets metered for a job's LLM spend is
 *   derived downstream as `tenantOf(job.requested_by)` (see `processPendingBatch`), i.e. the home
 *   tenant of whoever asked. A platform-wide read with a single `requestedBy` therefore queues
 *   tenant B's content and bills the requester's tenant A — the exact harm `/run` refuses to cause
 *   when it re-enters each job's OWN tenant via `withTenantTx`. It is worse under `force`, which
 *   drops the `setWhere` guard: `onConflictDoUpdate` sets `requested_by = excluded.requested_by`,
 *   so a wide backfill RE-STAMPS cells a tenant's own user legitimately queued and MOVES their
 *   bill. (And `building_blocks.docs_md` is tenant-private text that would land in
 *   `translation_jobs.source_text` / `content_translations`, neither of which is under RLS.)
 *
 * Making this genuinely platform-wide requires the job to carry its own metering tenant — a
 * `translation_jobs.tenant_id` column, or deriving the tenant from the CONTENT row — not a wider
 * read. Until that exists, tenant-scoped-and-honest beats platform-wide-and-mis-billed.
 */
export async function backfillTranslations(
  args: {
    entityType?: 'challenge' | 'solution' | 'block' | 'block_template' | 'flow';
    entityId?: string;
    force?: boolean;
  },
  /** May be NULL only because the column is nullable: a NULL `requested_by` is UNDRAINABLE —
   *  `processPendingBatch` fails every such job with `no metering actor`. Callers that cannot
   *  resolve a real id must refuse, not queue (routes/translations.ts). */
  requestedBy: string | null,
  db: Db = defaultDb,
): Promise<BackfillResult> {
  const types = args.entityType
    ? [args.entityType]
    : (['challenge', 'solution', 'block', 'block_template', 'flow'] as const);
  let queued = 0;
  let matched = 0;
  const opts = { force: args.force === true, db };

  for (const type of types) {
    if (type === 'challenge') {
      const rows = await db
        .select({
          id: challenges.id,
          title: challenges.title,
          description: challenges.description,
          business_impact: challenges.business_impact,
        })
        .from(challenges)
        .where(args.entityId ? eq(challenges.id, args.entityId) : undefined);
      matched += rows.length;
      for (const r of rows) {
        queued += await enqueueTranslations(
          'challenge',
          r.id,
          [
            { field: 'title', value: r.title },
            { field: 'description', value: r.description },
            { field: 'business_impact', value: r.business_impact },
          ],
          requestedBy,
          opts,
        );
      }
    } else if (type === 'solution') {
      const rows = await db
        .select({ id: solutions.id, title: solutions.title })
        .from(solutions)
        .where(args.entityId ? eq(solutions.id, args.entityId) : undefined);
      matched += rows.length;
      for (const r of rows) {
        queued += await enqueueTranslations(
          'solution',
          r.id,
          [{ field: 'title', value: r.title }],
          requestedBy,
          opts,
        );
      }
    } else if (type === 'flow') {
      // `name` + `description` — the ONLY two prose columns on `flows` (schema.ts:462). Everything
      // else on the row is machine state: `graph` is JSONB the executor reads by key (its node
      // `label`s are the BLOCK's prose and are already translated under the `block`/`block_tenant`
      // keys — translating them again here would give one block two independent editions), and
      // `version`/`status`/timestamps are not language. `description` is `NOT NULL DEFAULT ''`, so
      // the common empty case costs nothing: `enqueueTranslations` drops blank values before it
      // builds a single row.
      //
      // Keyed by the bare `flows.id` (a uuid), NOT a tenant-scoped composite. The `block` and
      // `block_template` branches need `blockI18nKey`/`templateI18nKey` because their natural key
      // is a SLUG that two tenants can both hold, so a bare key collides on `translation_jobs_cell`
      // and mis-meters the second tenant. A uuid PK cannot collide, so `challenge`'s plain-id
      // shape is the right one to copy here.
      const rows = await db
        .select({ id: flows.id, name: flows.name, description: flows.description })
        .from(flows)
        .where(args.entityId ? eq(flows.id, args.entityId) : undefined);
      matched += rows.length;
      for (const r of rows) {
        queued += await enqueueTranslations(
          'flow',
          r.id,
          [
            { field: 'name', value: r.name },
            { field: 'description', value: r.description },
          ],
          requestedBy,
          opts,
        );
      }
    } else if (type === 'block_template') {
      // ⛔ `WHERE tenant_id IS NOT NULL` — TENANT-AUTHORED TEMPLATES ONLY, AND THE FILTER IS THE
      // POINT OF THIS BRANCH.
      //
      // The 20 SHIPPED templates (tenant_id IS NULL) have HAND-CURATED translations, committed as
      // migration 0079_template_i18n.sql: 20 templates × 7 locales × 4 fields = 560 reviewed cells
      // under `entity_type='block_template'`. `processPendingBatch` UPSERTs its LLM output into
      // `content_translations` with `ON CONFLICT … DO UPDATE SET value = excluded.value` and NO
      // curated-row guard (see :319-326 above) — it cannot tell a reviewed cell from an empty one.
      // So the first `{"entityType":"block_template"}` backfill an operator ran on prod would
      // silently replace all 560 with machine output, in place, with the migration still in git
      // claiming otherwise. Nothing would fail; the only symptom would be prose quietly getting
      // worse. Onboarding the globals to the pipeline needs a curated-row guard FIRST (an
      // `is_curated` column on content_translations, or a source-of-truth check against the
      // migration) — not a widened SELECT.
      //
      // Tenant templates have no such curation: they are whatever an author typed, and the
      // pipeline is the only thing that will ever translate them. They are keyed
      // `block_template_tenant` + `${tenant}:${natural}` (templates/i18n-key.ts), never the bare
      // natural key — the same collision hazard `block` has, for the same reason. `tags` is not a
      // pipeline field: it is a facet the gallery renders as chips, and a machine-translated tag
      // list would fragment the tag facet without a reviewer ever seeing it.
      const rows = await db
        .select({
          id: blockTemplates.id,
          tenant_id: blockTemplates.tenant_id,
          category: blockTemplates.category,
          domain: blockTemplates.domain,
          name: blockTemplates.name,
          label: blockTemplates.label,
          description: blockTemplates.description,
          docs_md: blockTemplates.docs_md,
        })
        .from(blockTemplates)
        .where(
          args.entityId
            ? and(isNotNull(blockTemplates.tenant_id), eq(blockTemplates.id, args.entityId))
            : isNotNull(blockTemplates.tenant_id),
        );
      matched += rows.length;
      for (const r of rows) {
        const key = templateI18nKey(r);
        queued += await enqueueTranslations(
          key.entityType,
          key.entityId,
          [
            { field: 'label', value: r.label },
            { field: 'description', value: r.description },
            { field: 'docs_md', value: r.docs_md },
          ],
          requestedBy,
          opts,
        );
      }
    } else {
      // blocks: name/description from the block + docs_md from the current published version.
      // ⛔ `tenant_id` is in the projection deliberately: without it every row would be enqueued
      // under the bare slug, and a tenant block's job would collide with another tenant's on
      // `translation_jobs_cell` — overwriting its source_text AND its requested_by, so the wrong
      // tenant is metered for the translation. See blocks/i18n-key.ts.
      const rows = await db
        .select({
          slug: buildingBlocks.slug,
          tenant_id: buildingBlocks.tenant_id,
          name: buildingBlocks.name,
          description: buildingBlocks.description,
          docs_md: blockVersions.docs_md,
        })
        .from(buildingBlocks)
        .leftJoin(
          blockVersions,
          eq(blockVersions.id, buildingBlocks.current_version_id),
        )
        .where(args.entityId ? eq(buildingBlocks.slug, args.entityId) : undefined);
      matched += rows.length;
      for (const r of rows) {
        const key = blockI18nKey(r);
        queued += await enqueueTranslations(
          key.entityType,
          key.entityId,
          [
            { field: 'name', value: r.name },
            { field: 'description', value: r.description },
            { field: 'docs_md', value: r.docs_md },
          ],
          requestedBy,
          opts,
        );
      }
    }
  }
  return { queued, matched };
}

export interface JobStats {
  byStatus: Record<string, number>;
  byLocale: Record<string, { pending: number; done: number; failed: number }>;
}

/** Aggregate job counts for the admin panel — totals per status + a per-locale matrix. */
export async function jobStats(db: Db = defaultDb): Promise<JobStats> {
  const rows = await db
    .select({
      status: translationJobs.status,
      locale: translationJobs.target_locale,
      n: sql<number>`count(*)::int`,
    })
    .from(translationJobs)
    .groupBy(translationJobs.status, translationJobs.target_locale);
  const byStatus: Record<string, number> = {};
  const byLocale: JobStats['byLocale'] = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
    const slot = (byLocale[r.locale] ??= { pending: 0, done: 0, failed: 0 });
    if (r.status === 'pending') slot.pending += r.n;
    else if (r.status === 'done') slot.done += r.n;
    else if (r.status === 'failed') slot.failed += r.n;
  }
  return { byStatus, byLocale };
}
