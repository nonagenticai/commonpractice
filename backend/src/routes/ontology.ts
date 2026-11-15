// src/routes/ontology.ts — the Ontology API (Phase 3.2 read; 3.5 per-tenant authoring).
// READS are tenant-scoped: the (industry × department) matrix + the compiled effective
// graph, overlaid with the caller's tenant overrides/extensions and localized to the
// request locale. WRITES (create/edit/delete tenant entities + relations) require an
// ontology manager — tenant_admin (the "IT department") or platform — exactly mirroring
// the datasets data-manager gate (3.6). Global rows stay immutable from here. Unversioned
// /api per the hard rule. Mutations are audited (category 'data', action 'ontology.*').
import { z } from 'zod';
import { resolveTenant, type TenantContext } from '../middleware/tenant';
import {
  effectiveHomeTenant,
  isDeveloper,
  readActiveTenantHeader,
  requireSuperAdmin,
  requireTenantExists,
} from '../middleware/admin-guards';
import { runAsSystem } from '../db/client';
import { recordAudit } from '../host/audit-service';
import { listTenantOntologyChanges } from '../ontology/ontology-changes';
import { jsonResponse, readJson, route, badRequest, forbidden } from '../utils/http';
import { negotiateLocale } from '../utils/locale';
import {
  compileEffective,
  listMatrix,
  createTenantEntity,
  updateTenantEntity,
  deleteTenantEntity,
  createTenantRelation,
  deleteTenantRelation,
  hideGlobalEntity,
  unhideGlobalEntity,
  getEntityTranslations,
  setEntityTranslations,
} from '../ontology/ontology-service';
import {
  listEntitySamples,
  bindEntitySample,
  unbindEntitySample,
} from '../ontology/sample-service';
import { deriveDataBlock } from '../ontology/data-block-derivation';
import type { Router } from '../utils/router';

/** May the caller author the org's ontology? = developer (the tenant block/ontology author)
 *  OR an admin (tenant_admin / super_admin). The developer role is the dedicated authoring
 *  role; admins author too (isDeveloper is composite). */
function canManageOntology(ctx: TenantContext): boolean {
  return isDeveloper(ctx.user);
}

async function requireOntologyManager(req: Request): Promise<TenantContext> {
  const ctx = await resolveTenant(req);
  if (!canManageOntology(ctx)) {
    throw forbidden('ontology_manager_required', 'Only an org admin (IT) may edit the ontology');
  }
  return ctx;
}

/**
 * Record an `ontology.*` audit row, stamped with the WORKSPACE it happened in.
 *
 * ⛔ WHY THIS EXISTS INSTEAD OF ELEVEN `recordAudit` CALLS. `audit_log` has no `tenant_id` column
 * and sits outside RLS by design (migration 0028) — it is the one deliberately cross-tenant table.
 * That is correct for `/audit`, whose subject IS the platform log, and wrong for the /ontology
 * "Recent changes" panel, which sits under a tenant-scoped graph and was rendering every other
 * tenant's edits as though they were the reader's (see `ontology/ontology-changes.ts`).
 *
 * `metadata` is an existing jsonb column, so writing the tenant into it needs no migration and no
 * backfill of history whose tenant is genuinely unknowable. It is the ONLY thing that can ever
 * attribute a `*_delete` (the target row is gone before the reader arrives) or a `entity_hide` /
 * `entity_unhide` (the target is a GLOBAL entity, owned by nobody) — the target-row join in
 * ontology-changes.ts cannot reach either.
 *
 * ⚠️ USE THIS, NOT `recordAudit`, FOR EVERY FUTURE `ontology.*` ACTION. A call site that reaches
 * past it writes a row no workspace can claim, which the panel then reports to the reader as
 * "could not be attributed" forever. `tests/ontology-changes-tenant-scope.test.ts` walks this
 * file's `ontology.` actions and fails on one that is not routed through here.
 */
function recordOntologyAudit(
  ctx: TenantContext,
  entry: {
    action: string;
    targetType: string;
    targetId: string | null;
    result?: string | null;
    resultTone?: 'ok' | 'warn' | 'error';
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  return recordAudit({
    actorId: ctx.user.id,
    action: entry.action,
    category: 'data',
    targetType: entry.targetType,
    targetId: entry.targetId,
    result: entry.result ?? null,
    resultTone: entry.resultTone,
    metadata: { ...entry.metadata, tenantId: ctx.tenantId },
  });
}

// ---- GET /api/ontology/matrix ----
const getMatrix = route(async (req) => {
  const ctx = await resolveTenant(req);
  const matrix = await listMatrix({ tenantId: ctx.tenantId });
  return jsonResponse({ ...matrix, canManage: canManageOntology(ctx) });
});

// ---- GET /api/ontology?industry=<i>&department=<d>&locale=<l> ----
const getOntology = route(async (req) => {
  const ctx = await resolveTenant(req);
  const url = new URL(req.url);
  const industry = url.searchParams.get('industry')?.trim();
  const department = url.searchParams.get('department')?.trim();
  // `reason: 'query_param'` — ontology-service.ts throws these same two codes for the ENTITY SCOPE
  // invariant (`reason: 'entity_scope'`), a different sentence entirely. One code, two refusals: the
  // discriminator is what lets the browser catalog pick the right localized sentence.
  if (!industry)
    throw badRequest('industry_required', 'industry query param is required', {
      reason: 'query_param',
    });
  if (!department)
    throw badRequest('department_required', 'department query param is required', {
      reason: 'query_param',
    });
  const locale = negotiateLocale(req, url.searchParams.get('locale'));
  const compiled = await compileEffective(industry, department, {
    tenantId: ctx.tenantId,
    locale,
  });
  return jsonResponse({ ...compiled, locale, canManage: canManageOntology(ctx) });
});

// ---- entity write schemas ----
const attributeSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.string().min(1).max(40),
  synonyms: z.array(z.string()).optional(),
  pii: z.boolean().optional(),
  description: z.string().max(2000).nullish(),
});

const createEntitySchema = z
  .object({
    scope: z.enum(['generic', 'industry', 'industry_dept']),
    industry: z.string().max(80).nullish(),
    department: z.string().max(80).nullish(),
    name: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    synonyms: z.array(z.string()).optional(),
    description: z.string().max(2000).nullish(),
    attributes: z.array(attributeSchema).optional(),
  })
  .strict();

const updateEntitySchema = z
  .object({
    label: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).nullish(),
    synonyms: z.array(z.string()).optional(),
    attributes: z.array(attributeSchema).optional(),
  })
  .strict();

// ---- POST /api/ontology/entities ----
const createEntityRoute = route(async (req) => {
  const ctx = await requireOntologyManager(req);
  const body = createEntitySchema.parse(await readJson(req));
  const row = await createTenantEntity(ctx.tenantId, {
    scope: body.scope,
    industry: body.industry ?? null,
    department: body.department ?? null,
    name: body.name,
    label: body.label,
    synonyms: body.synonyms,
    description: body.description ?? null,
    attributes: body.attributes,
  });
  await recordOntologyAudit(ctx, {
    action: 'ontology.entity_create',
    targetType: 'ontology_entity',
    targetId: row.id,
    result: `Custom entity '${row.name}'`,
    resultTone: 'ok',
    metadata: { scope: row.scope, industry: row.industry, department: row.department },
  });
  return jsonResponse({ id: row.id }, 201);
});

// ---- PATCH /api/ontology/entities/:id ----
const updateEntityRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  const body = updateEntitySchema.parse(await readJson(req));
  const row = await updateTenantEntity(ctx.tenantId, id!, {
    label: body.label,
    description: body.description === undefined ? undefined : (body.description ?? null),
    synonyms: body.synonyms,
    attributes: body.attributes,
  });
  await recordOntologyAudit(ctx, {
    action: 'ontology.entity_update',
    targetType: 'ontology_entity',
    targetId: row.id,
    result: `Edited '${row.name}'`,
    resultTone: 'ok',
    metadata: { scope: row.scope },
  });
  return jsonResponse({ id: row.id });
});

// ---- DELETE /api/ontology/entities/:id ----
const deleteEntityRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  await deleteTenantEntity(ctx.tenantId, id!);
  await recordOntologyAudit(ctx, {
    action: 'ontology.entity_delete',
    targetType: 'ontology_entity',
    targetId: id!,
    result: 'Deleted custom entity',
    resultTone: 'warn',
  });
  return jsonResponse({ ok: true });
});

// ---- POST /api/ontology/entities/:id/hide (:id = a GLOBAL entity) ----
const hideEntityRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  await hideGlobalEntity(ctx.tenantId, id!);
  await recordOntologyAudit(ctx, {
    action: 'ontology.entity_hide',
    targetType: 'ontology_entity',
    targetId: id!,
    result: 'Hid a global entity for the org',
    resultTone: 'warn',
  });
  return jsonResponse({ ok: true });
});

// ---- POST /api/ontology/entities/:id/unhide ----
const unhideEntityRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  await unhideGlobalEntity(ctx.tenantId, id!);
  await recordOntologyAudit(ctx, {
    action: 'ontology.entity_unhide',
    targetType: 'ontology_entity',
    targetId: id!,
    result: 'Restored a hidden global entity',
    resultTone: 'ok',
  });
  return jsonResponse({ ok: true });
});

// ---- entity translation schema (3.7) ----
const setTranslationsSchema = z
  .object({
    locale: z.string().min(2).max(8),
    label: z.string().max(160).nullish(),
    description: z.string().max(2000).nullish(),
  })
  .strict();

// ---- GET /api/ontology/entities/:id/translations ----
const getTranslationsRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  const translations = await getEntityTranslations(ctx.tenantId, id!);
  return jsonResponse({ translations });
});

// ---- PUT /api/ontology/entities/:id/translations ----
const putTranslationsRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  const body = setTranslationsSchema.parse(await readJson(req));
  // SPARSE on purpose: the service's `if (!(field in fields)) continue` guard is a KEY-PRESENCE
  // test, and `'description' in { description: undefined }` is true. Spelling both keys out
  // unconditionally therefore made every partial save (label only, from the editor's two separate
  // inputs) fall through to the blank branch and DELETE the other field's translation, 200 OK.
  // An explicit null still means "clear" — it becomes '' here, which is the blank branch.
  const fields: { label?: string; description?: string } = {};
  if (body.label !== undefined) fields.label = body.label ?? '';
  if (body.description !== undefined) fields.description = body.description ?? '';
  await setEntityTranslations(ctx.tenantId, id!, body.locale, fields);
  await recordOntologyAudit(ctx, {
    action: 'ontology.entity_translate',
    targetType: 'ontology_entity',
    targetId: id!,
    result: `Translated to ${body.locale}`,
    resultTone: 'ok',
    metadata: { locale: body.locale },
  });
  return jsonResponse({ ok: true });
});

// ---- entity test-data (sample) binding (ontology-data-blocks Phase 1) ----
const bindSampleSchema = z
  .object({
    datasetId: z.string().uuid(),
    mappingId: z.string().uuid().nullish(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

// ---- GET /api/ontology/entities/:id/samples ----
const listSamplesRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  const samples = await listEntitySamples(ctx.tenantId, id!);
  return jsonResponse({ samples });
});

// ---- PUT /api/ontology/entities/:id/samples (bind a dataset as test data) ----
const bindSampleRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  const body = bindSampleSchema.parse(await readJson(req));
  const sample = await bindEntitySample(ctx.tenantId, id!, {
    datasetId: body.datasetId,
    mappingId: body.mappingId ?? null,
    isPrimary: body.isPrimary,
  });
  await recordOntologyAudit(ctx, {
    action: 'ontology.sample_bind',
    targetType: 'ontology_entity',
    targetId: id!,
    result: `Bound dataset '${sample.datasetSlug}' as test data${sample.isPrimary ? ' (primary)' : ''}`,
    resultTone: 'ok',
    metadata: { datasetId: sample.datasetId, isPrimary: sample.isPrimary },
  });
  return jsonResponse({ sample });
});

// ---- DELETE /api/ontology/samples/:sampleId (unbind) ----
const unbindSampleRoute = route(async (req, sampleId) => {
  const ctx = await requireOntologyManager(req);
  await unbindEntitySample(ctx.tenantId, sampleId!);
  await recordOntologyAudit(ctx, {
    action: 'ontology.sample_unbind',
    targetType: 'ontology_entity_sample',
    targetId: sampleId!,
    result: 'Removed an entity test-data binding',
    resultTone: 'warn',
  });
  return jsonResponse({ ok: true });
});

// ---- POST /api/ontology/entities/:id/derive-block (Phase 3: entity → data block) ----
const deriveBlockRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  const result = await deriveDataBlock(ctx.tenantId, id!, ctx.user.id);
  await recordOntologyAudit(ctx, {
    action: 'ontology.derive_block',
    targetType: 'block',
    targetId: result.block.slug,
    result: result.created
      ? `Derived data block '${result.block.slug}' (v${result.version.version})`
      : `Re-derived data block '${result.block.slug}' (v${result.version.version})`,
    resultTone: 'ok',
    metadata: { entityId: id, sourceEntityKey: result.block.source_entity_key, created: result.created },
  });
  return jsonResponse(
    { block: result.block, version: result.version, created: result.created },
    result.created ? 201 : 200,
  );
});

// ---- relation write schema ----
const createRelationSchema = z
  .object({
    fromEntityId: z.string().uuid(),
    toEntityId: z.string().uuid(),
    predicate: z.string().min(1).max(60),
    label: z.string().max(120).optional(),
    cardinality: z.string().max(20).optional(),
  })
  .strict();

// ---- POST /api/ontology/relations ----
const createRelationRoute = route(async (req) => {
  const ctx = await requireOntologyManager(req);
  const body = createRelationSchema.parse(await readJson(req));
  const row = await createTenantRelation(ctx.tenantId, body);
  await recordOntologyAudit(ctx, {
    action: 'ontology.relation_create',
    targetType: 'ontology_relation',
    targetId: row.id,
    result: `Custom relation '${row.predicate}'`,
    resultTone: 'ok',
  });
  return jsonResponse({ id: row.id }, 201);
});

// ---- DELETE /api/ontology/relations/:id ----
const deleteRelationRoute = route(async (req, id) => {
  const ctx = await requireOntologyManager(req);
  await deleteTenantRelation(ctx.tenantId, id!);
  await recordOntologyAudit(ctx, {
    action: 'ontology.relation_delete',
    targetType: 'ontology_relation',
    targetId: id!,
    result: 'Deleted custom relation',
    resultTone: 'warn',
  });
  return jsonResponse({ ok: true });
});

// ---- GET /api/ontology/recent-changes ----
/**
 * The /ontology "Recent changes" panel, scoped to the workspace the reader is looking at.
 *
 * ⛔ WHAT THIS REPLACES. The panel called `GET /api/audit?category=data&q=ontology&range=30d` — the
 * PLATFORM feed — so a super_admin read every tenant's ontology history under a tenant-scoped
 * graph. See `ontology/ontology-changes.ts` for the attribution rules and for why filtering in the
 * browser could not work.
 *
 * ⚠️ `requireSuperAdmin`, DELIBERATELY, AND IT IS NOT A LEFTOVER. The rows come from `audit_log`,
 * the one table that is outside RLS by design; reading it is a platform capability and this change
 * does not widen it. Loosening the gate to `resolveTenant` would hand the platform audit trail to
 * every member through a side door AND would silently retire the 401/403 branch that
 * `routes/ontology/+page.svelte` depends on — for most readers of that page a 403 here is the
 * EXPECTED answer, and the panel stays quiet rather than reporting the product working as designed
 * as a fault. That discrimination is asserted in
 * `frontend/src/routes/ontology/ontology-page.recent-changes-failure.render.test.ts`.
 *
 * ⚠️ AND `requireSuperAdmin`, NOT `resolveTenant`, FOR A SECOND REASON: `resolveTenant` runs
 * `validateAuth`, i.e. licence Gate 2 against the ACTING tenant. An operator scope-switched into an
 * unlicensed workspace would 402 on this panel — the exact bug WS-2 fixed for the rest of the
 * operator console (see the comment on `requireSuperAdmin`). The tenant is therefore resolved here
 * with the same precedence `resolveTenant` uses (valid `X-Active-Tenant-Id` > `tenant_id` claim),
 * minus the licence gate.
 */
const getRecentChanges = route(async (req) => {
  const user = await requireSuperAdmin(req);
  const active = readActiveTenantHeader(req, user);
  if (active) await requireTenantExists(active); // fail-closed: a bogus acting tenant → 403
  const tenantId = active ?? effectiveHomeTenant(user);
  // runAsSystem: the attribution join must see EVERY tenant's ontology rows to tell "belongs to
  // someone else" (correctly absent) from "belongs to nobody" (disclosed as a count). Both joined
  // tables carry RLS — see the warning on listTenantOntologyChanges.
  const feed = await runAsSystem('platform-admin', () => listTenantOntologyChanges(tenantId));
  return jsonResponse(feed);
});

export function registerOntologyRoutes(router: Router): void {
  // Order: more specific paths before the bare collection so the router resolves them
  // unambiguously (matches the datasets-routes convention).
  router.add('GET', '/api/ontology/matrix', getMatrix);
  router.add('GET', '/api/ontology/recent-changes', getRecentChanges);
  router.add('POST', '/api/ontology/entities', createEntityRoute);
  router.add('POST', '/api/ontology/entities/:id/hide', hideEntityRoute);
  router.add('POST', '/api/ontology/entities/:id/unhide', unhideEntityRoute);
  router.add('GET', '/api/ontology/entities/:id/translations', getTranslationsRoute);
  router.add('PUT', '/api/ontology/entities/:id/translations', putTranslationsRoute);
  router.add('GET', '/api/ontology/entities/:id/samples', listSamplesRoute);
  router.add('PUT', '/api/ontology/entities/:id/samples', bindSampleRoute);
  router.add('POST', '/api/ontology/entities/:id/derive-block', deriveBlockRoute);
  router.add('DELETE', '/api/ontology/samples/:sampleId', unbindSampleRoute);
  router.add('PATCH', '/api/ontology/entities/:id', updateEntityRoute);
  router.add('DELETE', '/api/ontology/entities/:id', deleteEntityRoute);
  router.add('POST', '/api/ontology/relations', createRelationRoute);
  router.add('DELETE', '/api/ontology/relations/:id', deleteRelationRoute);
  router.add('GET', '/api/ontology', getOntology);
}
