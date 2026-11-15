// src/routes/translations.ts — Phase 2-G translation-management surface (platform-gated).
// The thin HTTP layer around host/translation-service.ts:
//   POST /api/admin/translations/queue  — enqueue/backfill jobs (the on-ramp for pre-G content)
//   POST /api/admin/translations/run    — drain the queue now (the live-verification path)
//   GET  /api/admin/translations/jobs   — coverage matrix + a recent-jobs list, each job carrying
//                                         the translation it ALREADY has (see the join below)
//   PATCH /api/admin/translations/:id    — human override of one translation (review)
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, translationJobs, contentTranslations } from '../db/client';
import { requireSuperAdmin } from '../middleware/admin-guards';
import { conflict, jsonResponse, readJson, readJsonOptional, route, notFound } from '../utils/http';
import { auditActorId, recordAudit } from '../host/audit-service';
import {
  backfillTranslations,
  processPendingBatch,
  jobStats,
} from '../host/translation-service';
import { config } from '../config';
import { BLOCK_I18N, BLOCK_TENANT_I18N } from '../blocks/i18n-key';
import { TEMPLATE_I18N, TEMPLATE_TENANT_I18N } from '../templates/i18n-key';
import type { Router } from '../utils/router';

// `block_template` covers TENANT-authored templates ONLY — the backfill branch in
// host/translation-service.ts filters `tenant_id IS NOT NULL`, because the 20 shipped globals'
// translations are hand-curated in migration 0079 and `processPendingBatch` would overwrite them.
// `flow` covers `flows.name` + `flows.description` — the Build-canvas working document's only
// prose. It was missing entirely until now: prod had 23 flows and ZERO `content_translations` rows
// under `entity_type='flow'`, so every flow name rendered English in all 8 locales while every
// other content type sat at ~100% coverage. There is no curated-row hazard here (nothing seeds
// flow translations by hand), so unlike `block_template` this branch needs no tenant filter beyond
// the RLS scope the whole backfill already runs in.
const entityTypeEnum = z.enum(['challenge', 'solution', 'block', 'block_template', 'flow']);

const queueSchema = z
  .object({
    entityType: entityTypeEnum.optional(),
    entityId: z.string().min(1).optional(),
    force: z.boolean().optional(),
  })
  .strict();

// POST /api/admin/translations/queue — enqueue jobs for one entity or backfill a whole
// type (or everything). `force` re-queues even unchanged cells.
const postQueue = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const body = queueSchema.parse(await readJsonOptional(req));
  // ⛔ THIS BACKFILL IS TENANT-SCOPED, AND MUST STAY THAT WAY — DO NOT WRAP IT IN `runAsSystem`.
  //
  // `backfillTranslations` reads `challenges`, `solutions` and `building_blocks`, all under RLS,
  // with no tenant filter of its own, so its reach is exactly the `app.current_tenant` server.ts
  // bound this request to — the operator's own workspace. "Enqueue every locale cell for ALL
  // platform content" reads like the intended feature and a `runAsSystem` wrap looks like the same
  // one-line fix routes/pipeline.ts applies to its cross-tenant READS. IT IS NOT THE SAME SEAM:
  //
  //   `translation_jobs` HAS NO `tenant_id`. The tenant billed for a job's LLM spend is derived
  //   downstream as `tenantOf(job.requested_by)` (host/translation-service.ts) and `/run` charges
  //   it through `withTenantTx` -> `usage_counters`. One `requestedBy` over every tenant's content
  //   therefore queues tenant B's rows and bills tenant A — the very harm the note on `/run` below
  //   refuses to cause. Under `force` it is worse: `enqueueTranslations`' `onConflictDoUpdate`
  //   sets `requested_by = excluded.requested_by` with the `setWhere` guard dropped, so the run
  //   RE-STAMPS cells tenant users legitimately queued and MOVES their bill onto the operator.
  //   (`building_blocks.docs_md` is also tenant-private, and both `translation_jobs.source_text`
  //   and `content_translations` are outside RLS.)
  //
  // Measured on the wrapped version: content tenant …ba50002, metered tenant …ba50001.
  // A platform-wide backfill needs the JOB to carry its own metering tenant (a
  // `translation_jobs.tenant_id`, or the tenant of the content row) before the read may widen.
  // tests/translations-backfill-billing-tenant.test.ts pins all of this.
  //
  // ⛔ AND `translation_jobs.requested_by` IS A FK TO `users.id` (schema.ts:1509), while a
  // super_admin granted directly in Keycloak has NO `users` row (`authenticateWithoutLicense`
  // never calls `ensureUser`). Writing `actor.id` raised 23503 and `route()` turned it into a bare
  // 500. But degrading to NULL the way `auditActorId` does for `audit_log` IS NOT AVAILABLE HERE:
  // `audit_log.actor_id` is a display column, whereas `requested_by` is the BILLING KEY, and
  // `processPendingBatch` fails every NULL-actor job with `no metering actor`. Answering
  // 200 {queued: N} for jobs that provably cannot drain replaces a loud 500 with a silent lie.
  // So this refuses, and says why.
  const requestedBy = await auditActorId(actor.id);
  if (!requestedBy) {
    throw conflict(
      'no_metering_actor',
      'This operator has no local user record, and `translation_jobs.requested_by` is what the ' +
        'drainer meters LLM spend against — jobs queued without it fail with "no metering actor". ' +
        'Sign in once through the normal flow (which provisions the record) and retry.',
      { actorSub: actor.id },
    );
  }
  const { queued, matched } = await backfillTranslations(
    { entityType: body.entityType, entityId: body.entityId, force: body.force },
    requestedBy,
  );
  // ⛔ `queued: 0` IS AMBIGUOUS AND MUST NOT RENDER AS A GREEN NO-OP. For an explicit `entityId` it
  // means either "already up to date" (the `setWhere` guard) or "that entity is not in your
  // workspace" — and the second one silently answering 200 is the falsely-low `queued` this route
  // was reported for. `matched` separates them.
  if (body.entityId && matched === 0) {
    throw notFound(
      'translation_entity_not_visible',
      `No ${body.entityType ?? 'content'} '${body.entityId}' is visible in this workspace. This ` +
        'backfill runs in the caller\'s own tenant scope; it is not platform-wide.',
      { entityId: body.entityId, entityType: body.entityType },
    );
  }
  await recordAudit({
    actorId: actor.id,
    action: 'translation.queue',
    category: 'system',
    targetType: 'translation_jobs',
    targetId: body.entityId ?? body.entityType ?? 'all',
    // The trail names the SCOPE, not just the count: this run covered the operator's own workspace,
    // and a reader who assumes "backfill" means "the platform" would otherwise read `Queued 0` as
    // "the platform is fully translated".
    result: `Queued ${queued} translation jobs from ${matched} entities in tenant ${actor.tenantId}`,
    resultTone: 'ok',
    metadata: { queued, matched, scopeTenantId: actor.tenantId, ...body },
  });
  return jsonResponse({ queued, matched });
});

// POST /api/admin/translations/run — drain the pending queue now (manual trigger).
const postRun = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const result = await processPendingBatch(new Date(), db, config.translation.batchSize);
  await recordAudit({
    actorId: actor.id,
    action: 'translation.run',
    category: 'system',
    targetType: 'translation_jobs',
    // A tick that translated NOTHING because every actor was capped is not an 'ok' outcome, and
    // reporting it as one is how a 608-job stall stayed invisible: "0 translated, 0 failed, 608
    // deferred" with a green tone reads as "nothing to do" rather than "blocked". Mirrors the
    // stall wording processPendingBatch writes for the scheduled path.
    result:
      result.processed === 0 && result.cappedActors > 0
        ? `NO PROGRESS — 0 translated, ${result.deferred} deferred, ${result.cappedActors} capped actor(s)`
        : `${result.processed} translated, ${result.failed} failed, ${result.deferred} deferred`,
    resultTone:
      result.failed > 0 || (result.processed === 0 && result.cappedActors > 0) ? 'warn' : 'ok',
    metadata: { ...result },
  });
  return jsonResponse(result);
});

const JOBS_LIMIT = 100;

// GET /api/admin/translations/jobs?status=&entityType= — coverage matrix + recent jobs.
const getJobs = route(async (req) => {
  await requireSuperAdmin(req);
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const entityType = url.searchParams.get('entityType');

  const filters = [];
  if (status) filters.push(eq(translationJobs.status, status));
  // `block` is the OPERATOR-facing selector and must keep meaning "all blocks". Since the
  // block-i18n tenant split, a TENANT-owned block's jobs carry entity_type 'block_tenant' (see
  // blocks/i18n-key.ts), so an equality filter would silently drop every tenant block from this
  // admin list — the list would look complete while hiding exactly the rows most likely to be
  // stuck. The `queue` selector deliberately still takes plain 'block'; only this filter widens.
  //
  // ⚠️ `block_template` needs the SAME widening, and needs it MORE: only TENANT templates are ever
  // enqueued (the shipped globals are curated in migration 0079 — see the queue selector above),
  // so every template job in the table carries `block_template_tenant`. A bare equality filter on
  // `block_template` would therefore return an EMPTY list, every time, on a queue that is not
  // empty — "no template jobs are stuck" rendered from a filter that cannot match one.
  const WIDENS: Record<string, string[]> = {
    [BLOCK_I18N]: [BLOCK_I18N, BLOCK_TENANT_I18N],
    [TEMPLATE_I18N]: [TEMPLATE_I18N, TEMPLATE_TENANT_I18N],
  };
  if (entityType) {
    const widened = WIDENS[entityType];
    filters.push(
      widened
        ? inArray(translationJobs.entity_type, widened)
        : eq(translationJobs.entity_type, entityType),
    );
  }
  const where = filters.length ? and(...filters) : undefined;

  // ⛔ THE JOB ROW DOES NOT CARRY THE TRANSLATION. `translation_jobs` holds the ENGLISH
  // `source_text` and the queue state; the translated value lives one table over, in
  // `content_translations`, written by the drainer and by patchOverride below. Without this join
  // the override editor had nothing to show but the English source, so it opened an EMPTY box on
  // a cell that was already translated (728 `done` jobs in prod) and any save silently replaced a
  // good translation with whatever was typed — the operator could not even see what they were
  // about to overwrite. The join is the whole point: `current_value` is the "before".
  //
  // The join tuple is exactly the tuple patchOverride upserts on (see the onConflictDoUpdate
  // target below) and exactly the one the drainer writes: (entity_type, entity_id, locale, field)
  // — note `content_translations.locale` pairs with `translation_jobs.target_locale`, the ONE
  // column whose name differs between the two tables.
  //
  // ⛔ IT CANNOT FAN OUT. `content_translations` is PRIMARY KEY (entity_type, entity_id, locale,
  // field) (migrations/0008_ai-substrate.sql:189) — the join predicate binds every one of those
  // four columns to an equality, so at most one row can match and the LEFT JOIN can never
  // multiply the job list. That PK is also what makes patchOverride's ON CONFLICT legal, so the
  // two cannot drift apart: lose the PK and the override route stops compiling in Postgres.
  //
  // No RLS concern: 0028_rls.sql:23 lists BOTH `content_translations` and `translation_jobs` on
  // the platform-exemption list (neither has a tenant_id), so this reads the same rows the
  // super-admin caller already reads from translation_jobs. Nothing here needs runAsSystem.
  const jobs = await db
    .select({
      id: translationJobs.id,
      entity_type: translationJobs.entity_type,
      entity_id: translationJobs.entity_id,
      field: translationJobs.field,
      target_locale: translationJobs.target_locale,
      source_text: translationJobs.source_text,
      source_hash: translationJobs.source_hash,
      status: translationJobs.status,
      attempts: translationJobs.attempts,
      error: translationJobs.error,
      requested_by: translationJobs.requested_by,
      created_at: translationJobs.created_at,
      updated_at: translationJobs.updated_at,
      // null ⇔ nothing stored for this cell yet. The editor MUST render that case differently
      // from an empty-but-present value, or "no translation yet" and "the translation is gone"
      // look identical.
      current_value: contentTranslations.value,
      current_updated_at: contentTranslations.updated_at,
    })
    .from(translationJobs)
    .leftJoin(
      contentTranslations,
      and(
        eq(contentTranslations.entity_type, translationJobs.entity_type),
        eq(contentTranslations.entity_id, translationJobs.entity_id),
        eq(contentTranslations.locale, translationJobs.target_locale),
        eq(contentTranslations.field, translationJobs.field),
      ),
    )
    .where(where)
    .orderBy(desc(translationJobs.updated_at))
    .limit(JOBS_LIMIT);

  // How many jobs the filter ACTUALLY matches, so the screen can say "showing 100 of 728" instead
  // of letting a hard truncation read as the full set. It is counted here rather than derived from
  // `stats.byStatus` on the client because jobStats() is unconditional — it ignores BOTH filters,
  // so an `entityType`-filtered request would pair its 100 rows with a total for the whole table.
  // (Full pagination is deliberately not in scope; the honest count is.)
  const [totalRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(translationJobs)
    .where(where);

  const stats = await jobStats();
  return jsonResponse({
    stats,
    jobs,
    jobsLimit: JOBS_LIMIT,
    jobsTotal: totalRow?.n ?? jobs.length,
  });
});

const overrideSchema = z.object({ value: z.string().min(1).max(20000) }).strict();

// PATCH /api/admin/translations/:id — human override: write the edited value into
// content_translations and mark the job done (translation review).
const patchOverride = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  const body = overrideSchema.parse(await readJson(req));
  const [job] = await db
    .select()
    .from(translationJobs)
    .where(eq(translationJobs.id, id!));
  if (!job) throw notFound('job_not_found', `No translation job '${id}'`);

  await db
    .insert(contentTranslations)
    .values({
      entity_type: job.entity_type,
      entity_id: job.entity_id,
      locale: job.target_locale,
      field: job.field,
      value: body.value,
    })
    .onConflictDoUpdate({
      target: [
        contentTranslations.entity_type,
        contentTranslations.entity_id,
        contentTranslations.locale,
        contentTranslations.field,
      ],
      set: { value: body.value, updated_at: sql`now()` },
    });
  await db
    .update(translationJobs)
    .set({ status: 'done', error: null, updated_at: sql`now()` })
    .where(eq(translationJobs.id, id!));

  await recordAudit({
    actorId: actor.id,
    action: 'translation.override',
    category: 'system',
    targetType: 'content_translation',
    targetId: `${job.entity_type}:${job.entity_id}:${job.target_locale}:${job.field}`,
    result: 'Manual override',
    resultTone: 'ok',
  });
  return jsonResponse({ ok: true });
});

export function registerTranslationRoutes(router: Router): void {
  router.add('POST', '/api/admin/translations/queue', postQueue);
  router.add('POST', '/api/admin/translations/run', postRun);
  router.add('GET', '/api/admin/translations/jobs', getJobs);
  router.add('PATCH', '/api/admin/translations/:id', patchOverride);
}
