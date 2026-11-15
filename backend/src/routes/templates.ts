// src/routes/templates.ts — the Block Template API (seeded starter-scaffold catalog).
//
// READS only (v1): list templates (filtered by category / domain / search, with facets) and fetch
// one template's full scaffold. Tenant-scoped reads return global ∪ own-tenant (own-tenant is
// reserved for a later "save as template"). Unversioned /api per the hard rule. No writes, so no
// manager gate / audit yet.
import { z } from 'zod';
import { resolveTenant } from '../middleware/tenant';
import { requireDeveloper } from '../middleware/admin-guards';
import { jsonResponse, route, badRequest, notFound, readJson } from '../utils/http';
import { listTemplates, getTemplate, createTemplate, deleteTemplate } from '../templates/templates-service';
import { descriptorSchema } from '../blocks/descriptor-schema';
import { recordAudit } from '../host/audit-service';
import { BLOCK_CATEGORIES, type BlockCategory, type BlockDescriptor } from '../db/block-types';
import { negotiateLocale } from '../utils/locale';
import type { Router } from '../utils/router';

function parseCategory(raw: string | null): BlockCategory | undefined {
  if (!raw) return undefined;
  if (!(BLOCK_CATEGORIES as readonly string[]).includes(raw)) {
    // `categories` goes over as an ARRAY, not the joined string: a locale picks its own separator
    // (and its own list conjunction), which it cannot do once ', ' is baked into one value.
    throw badRequest('bad_category', `category must be one of: ${BLOCK_CATEGORIES.join(', ')}`, {
      categories: [...BLOCK_CATEGORIES],
    });
  }
  return raw as BlockCategory;
}

// ---- GET /api/templates?category=<c>&domain=<d>&q=<q> ----
const listRoute = route(async (req) => {
  const ctx = await resolveTenant(req);
  const url = new URL(req.url);
  // Negotiated HERE and handed to the service, not applied to the DTO afterwards: the gallery's
  // SEARCH and its SORT both run over the localized prose (see the ⛔ in templates-service.ts
  // `listTemplates`), so the locale has to reach the filter, not just the output.
  const result = await listTemplates({
    tenantId: ctx.tenantId,
    category: parseCategory(url.searchParams.get('category')),
    domain: url.searchParams.get('domain')?.trim() || undefined,
    q: url.searchParams.get('q')?.trim() || undefined,
    locale: negotiateLocale(req),
  });
  return jsonResponse(result);
});

// ---- GET /api/templates/:id ----
const getRoute = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  // ⚠️ The picked template's prose is COPIED into the author's new block by the SPA's
  // `applyTemplate` (block-edit/+page.svelte), so serving it in `en` writes English into a Dutch
  // author's own block, permanently. The locale has to be on THIS request, not only on the list.
  const template = await getTemplate(id!, { tenantId: ctx.tenantId, locale: negotiateLocale(req) });
  if (!template) throw notFound('template_not_found', 'No such template');
  return jsonResponse({ template });
});

// ---- POST /api/templates (Phase 5D "save as template") ----
// Developer-gated, TENANT-scoped: creates a tenant-authored template (globals stay seed-only; RLS
// rejects a NULL tenant on INSERT). requireDeveloper binds the RLS GUC to the effective tenant.
const createTemplateSchema = z
  .object({
    name: z.string().min(1).max(120),
    label: z.string().min(1).max(120),
    category: z.enum(BLOCK_CATEGORIES),
    description: z.string().max(500).optional(),
    domain: z.string().max(60).nullable().optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    descriptor: descriptorSchema,
    source_ts: z.string().optional(),
    docs_md: z.string().optional(),
    preconditions: z.array(z.string()).optional(),
    postconditions: z.array(z.string()).optional(),
    steps: z.array(z.object({ label: z.string(), detail: z.string() }).strict()).optional(),
  })
  .strict();

const createRoute = route(async (req) => {
  const ctx = await requireDeveloper(req);
  const body = createTemplateSchema.parse(await readJson(req));
  const template = await createTemplate(
    {
      name: body.name,
      label: body.label,
      category: body.category,
      description: body.description,
      domain: body.domain,
      tags: body.tags,
      descriptor: body.descriptor as unknown as BlockDescriptor,
      source_ts: body.source_ts,
      docs_md: body.docs_md,
      preconditions: body.preconditions,
      postconditions: body.postconditions,
      steps: body.steps,
    },
    { tenantId: ctx.effectiveTenantId, userId: ctx.user.id },
  );
  await recordAudit({
    actorId: ctx.user.id,
    action: 'template.create',
    category: 'block',
    targetType: 'template',
    targetId: `${template.category}/${template.name}`,
    result: 'Template created',
    resultTone: 'ok',
  });
  return jsonResponse({ template }, 201);
});

// ---- DELETE /api/templates/:id (remove an own-tenant "save as template" row) ----
// Developer-gated, TENANT-scoped: only deletes own-tenant rows (RLS + explicit clause). A global or
// cross-tenant id is a no-match → 404 (never a silent 200, and globals stay seed-only).
const deleteRoute = route(async (req, id) => {
  const ctx = await requireDeveloper(req);
  const deletedId = await deleteTemplate(id!, { tenantId: ctx.effectiveTenantId });
  if (!deletedId) throw notFound('template_not_found', 'No such tenant template');
  await recordAudit({
    actorId: ctx.user.id,
    action: 'template.delete',
    category: 'block',
    targetType: 'template',
    targetId: deletedId,
    result: 'Template deleted',
    resultTone: 'warn',
  });
  return jsonResponse({ ok: true });
});

export function registerTemplateRoutes(router: Router): void {
  router.add('GET', '/api/templates', listRoute);
  router.add('POST', '/api/templates', createRoute);
  router.add('GET', '/api/templates/:id', getRoute);
  router.add('DELETE', '/api/templates/:id', deleteRoute);
}
