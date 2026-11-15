// src/routes/flow-templates.ts — the Flow Template API (0108). Business rules: flow-templates/service.ts.
//
//   GET    /api/flow-templates              any member — starters + own organisation, with availability
//   GET    /api/flow-templates/:id          any member
//   POST   /api/flow-templates              developer / tenant_admin / super_admin — save from an OWN flow;
//                                           super_admin may pass ?scope=global (platform starter)
//   POST   /api/flow-templates/:id/use      any member — new draft flow from the template
//   DELETE /api/flow-templates/:id          archive: org template by its creator or a tenant_admin;
//                                           starter by a super_admin
//   POST   /api/solutions/:id/use-as-start  any member — new draft flow from a solution of their own
//                                           tenant (its published graph). Registered here, not in
//                                           solutions.ts, because it is the same instantiate path.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, flows, flowTemplates, solutions, runAsSystem } from '../db/client';
import type { FlowGraph } from '../db/flow-types';
import { resolveTenant } from '../middleware/tenant';
import { requireDeveloper, isSuperAdmin, hasTenantAdmin } from '../middleware/admin-guards';
import { jsonResponse, route, notFound, forbidden, unprocessable, readJson, readJsonOptional } from '../utils/http';
import { negotiateLocale } from '../utils/locale';
import { recordAudit } from '../host/audit-service';
import { enqueueTranslations } from '../host/translation-service';
import { log } from '../host/logger';
import {
  FLOW_TEMPLATE_I18N,
  deriveBlockSlugs,
  descriptorsFor,
  instantiateGraph,
  listFlowTemplates,
  loadVisibleTemplate,
  nonGlobalBlockSlugs,
  structureOnlyGraph,
  viewOf,
} from '../flow-templates/service';
import type { Router } from '../utils/router';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z
  .object({
    flowId: z.string().regex(UUID_RE),
    name: z.string().trim().min(1).max(140),
    description: z.string().trim().max(500).optional(),
    category: z.string().trim().max(60).optional(),
  })
  .strict();

// ---- GET /api/flow-templates ----
const listRoute = route(async (req) => {
  const ctx = await resolveTenant(req);
  const items = await listFlowTemplates(ctx.tenantId, negotiateLocale(req), viewerOf(ctx.user));
  return jsonResponse({
    templates: items.map((t) => ({ ...t, canArchive: canArchive(t, ctx.user) })),
  });
});

function viewerOf(user: Parameters<typeof isSuperAdmin>[0]) {
  return { superAdmin: isSuperAdmin(user) };
}

function canArchive(
  t: { scope: 'global' | 'tenant'; createdBy: string | null },
  user: Parameters<typeof isSuperAdmin>[0],
): boolean {
  if (t.scope === 'global') return isSuperAdmin(user);
  return hasTenantAdmin(user) || (t.createdBy !== null && t.createdBy === user.id);
}

// ---- GET /api/flow-templates/:id ----
const getRoute = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  const row = await loadVisibleTemplate(id!, ctx.tenantId);
  if (!row) throw notFound('flow_template_not_found', 'No such flow template');
  const view = await viewOf(row, ctx.tenantId, negotiateLocale(req), viewerOf(ctx.user));
  return jsonResponse({ template: { ...view, canArchive: canArchive(view, ctx.user) } });
});

// ---- POST /api/flow-templates ----
const createRoute = route(async (req) => {
  const ctx = await requireDeveloper(req); // members do not save templates (403 developer_required)
  const body = createSchema.parse(await readJson(req));
  const wantsGlobal = new URL(req.url).searchParams.get('scope') === 'global';
  if (wantsGlobal && !isSuperAdmin(ctx.user)) {
    throw forbidden('super_admin_required', 'Only a platform admin can save a starter for every organisation');
  }

  // An OWN flow in the effective tenant. 404, never 403, so another person's flow id reveals nothing.
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, body.flowId), eq(flows.owner_id, ctx.user.id), eq(flows.tenant_id, ctx.effectiveTenantId)));
  if (!flow) throw notFound('flow_not_found', `No flow '${body.flowId}'`);
  let graph = (flow.graph ?? { nodes: [], edges: [] }) as FlowGraph;
  if (!graph.nodes?.some((n) => n.kind !== 'foreach')) {
    throw unprocessable('flow_template_empty', 'A template needs at least one block.');
  }

  let stripped: { nodeId: string; key: string }[] = [];
  if (wantsGlobal) {
    const tenantBlocks = await nonGlobalBlockSlugs(graph);
    if (tenantBlocks.length) {
      throw unprocessable(
        'flow_template_tenant_blocks',
        `A starter can only use platform blocks; this flow uses: ${tenantBlocks.join(', ')}.`,
        { blockSlugs: tenantBlocks },
      );
    }
    ({ graph, stripped } = structureOnlyGraph(graph, await descriptorsFor(graph)));
  }

  const values = {
    name: body.name,
    description: body.description ?? '',
    category: body.category ?? '',
    graph,
    block_slugs: deriveBlockSlugs(graph),
    source_flow_id: flow.id,
    created_by: ctx.user.id,
  };
  const [row] = wantsGlobal
    ? // Global rows are platform content: the owner pool, behind the isSuperAdmin check above.
      await runAsSystem('platform-admin', () =>
        db.insert(flowTemplates).values({ ...values, tenant_id: null }).returning(),
      )
    : await db.insert(flowTemplates).values({ ...values, tenant_id: ctx.effectiveTenantId }).returning();

  try {
    await enqueueTranslations(
      FLOW_TEMPLATE_I18N,
      row!.id,
      [
        { field: 'name', value: row!.name },
        { field: 'description', value: row!.description },
      ],
      ctx.user.id,
    );
  } catch (e) {
    log.warn('translation_enqueue_failed', { entity: FLOW_TEMPLATE_I18N, entityId: row!.id, err: e });
  }
  await recordAudit({
    actorId: ctx.user.id,
    action: 'flow_template.create',
    category: 'block',
    targetType: 'flow_template',
    targetId: row!.id,
    result: row!.name,
    resultTone: 'ok',
    metadata: { scope: wantsGlobal ? 'global' : 'tenant', sourceFlowId: flow.id, strippedConfig: stripped },
  });
  const view = await viewOf(row!, ctx.effectiveTenantId, negotiateLocale(req), viewerOf(ctx.user));
  return jsonResponse({ template: { ...view, canArchive: true }, strippedConfig: stripped }, 201);
});

// ---- POST /api/flow-templates/:id/use ----
// Optional body `{ into }`: the empty draft on the reader's canvas — see `instantiateGraph`.
const useSchema = z.object({ into: z.guid().optional() }).strict();
const useRoute = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  const body = useSchema.parse(await readJsonOptional(req));
  const row = await loadVisibleTemplate(id!, ctx.tenantId);
  if (!row) throw notFound('flow_template_not_found', 'No such flow template');
  // The reader's own words for the name: it becomes THEIR flow's name, and they read it in their language.
  const view = await viewOf(row, ctx.tenantId, negotiateLocale(req), viewerOf(ctx.user));
  const out = await instantiateGraph(row.graph as FlowGraph, {
    name: view.name,
    description: view.description,
    ownerId: ctx.user.id,
    tenantId: ctx.tenantId,
    intoFlowId: body.into,
  });
  return jsonResponse(out, 201);
});

// ---- DELETE /api/flow-templates/:id ----
const archiveRoute = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  const row = await loadVisibleTemplate(id!, ctx.tenantId);
  if (!row) throw notFound('flow_template_not_found', 'No such flow template');
  const scope = row.tenant_id === null ? 'global' : 'tenant';
  if (!canArchive({ scope, createdBy: row.created_by }, ctx.user)) {
    // Existing codes, so the SPA already has copy: a starter is platform content, an organisation
    // template belongs to its creator and the organisation's admins.
    throw scope === 'global'
      ? forbidden('super_admin_required', 'Only a platform admin can remove a starter')
      : forbidden('tenant_admin_required', 'Only its creator or an admin can remove this template');
  }
  const set = { archived_at: new Date(), updated_at: new Date() };
  if (scope === 'global') {
    await runAsSystem('platform-admin', () =>
      db.update(flowTemplates).set(set).where(eq(flowTemplates.id, row.id)),
    );
  } else {
    await db
      .update(flowTemplates)
      .set(set)
      .where(and(eq(flowTemplates.id, row.id), eq(flowTemplates.tenant_id, ctx.tenantId)));
  }
  await recordAudit({
    actorId: ctx.user.id,
    action: 'flow_template.archive',
    category: 'block',
    targetType: 'flow_template',
    targetId: row.id,
    result: row.name,
    resultTone: 'warn',
    metadata: { scope },
  });
  return new Response(null, { status: 204 });
});

// ---- POST /api/solutions/:id/use-as-start ----
const useSolutionRoute = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  if (!UUID_RE.test(id!)) throw notFound('solution_not_found', 'No such solution');
  // Own tenant only — written out here as well as enforced by the solutions RLS policy.
  const [sol] = await db
    .select({ id: solutions.id, title: solutions.title, graph: solutions.published_graph })
    .from(solutions)
    .where(and(eq(solutions.id, id!), eq(solutions.tenant_id, ctx.tenantId)));
  if (!sol) throw notFound('solution_not_found', 'No such solution');
  if (!sol.graph || !(sol.graph as FlowGraph).nodes?.length) {
    throw unprocessable('solution_no_flow', 'This solution has no flow to start from.');
  }
  const out = await instantiateGraph(sol.graph as FlowGraph, {
    name: sol.title,
    description: '',
    ownerId: ctx.user.id,
    tenantId: ctx.tenantId,
  });
  return jsonResponse(out, 201);
});

export function registerFlowTemplateRoutes(router: Router): void {
  router.add('GET', '/api/flow-templates', listRoute);
  router.add('POST', '/api/flow-templates', createRoute);
  router.add('GET', '/api/flow-templates/:id', getRoute);
  router.add('DELETE', '/api/flow-templates/:id', archiveRoute);
  router.add('POST', '/api/flow-templates/:id/use', useRoute);
  router.add('POST', '/api/solutions/:id/use-as-start', useSolutionRoute);
}
