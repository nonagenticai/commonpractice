// src/ontology/cell-context.ts — Phase 3.4 (SPEC §B4): resolve the (industry ×
// department) ontology cell from agent request context, used when the agent omits
// explicit args to a tool.
//
//   industry   ← the tenant's configured industry (tenants.industry)
//   department ← the active challenge's work_area, mapped via WORK_AREA_TO_DEPARTMENT
//
// challengeId is the PRIMARY department signal — reliable mid-build, before any
// solutions row links the flow. flowId is a fallback that only resolves once a
// solutions row links the flow to a challenge. Tools that receive explicit
// industry/department args skip this entirely: resolution only fills omitted args, and
// explicit args remain the always-works path (SPEC §B4/§B5).
import { eq } from 'drizzle-orm';
import { db as defaultDb, tenants, challenges, solutions } from '../db/client';
import { resolveCell } from './ontology-service';

type Db = typeof defaultDb;

export interface AgentCellContext {
  tenantId?: string | null;
  challengeId?: string | null;
  flowId?: string | null;
}

export interface ResolvedCell {
  industry: string | null;
  department: string | null;
}

/** Resolve { industry, department } from tenant + challenge/flow context. */
export async function resolveAgentCell(
  ctx: AgentCellContext,
  database: Db = defaultDb,
): Promise<ResolvedCell> {
  const industry = await resolveIndustry(ctx.tenantId ?? null, database);
  const workArea = await resolveWorkArea(ctx, database);
  return resolveCell(industry, workArea);
}

/** The tenant's configured industry (null tenant / unset industry → null). */
async function resolveIndustry(tenantId: string | null, database: Db): Promise<string | null> {
  if (!tenantId) return null;
  const [row] = await database
    .select({ industry: tenants.industry })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row?.industry ?? null;
}

/** The active challenge's work_area: by challengeId (primary), else via the flow's
 *  linking solutions row (fallback). Null when neither resolves. */
async function resolveWorkArea(ctx: AgentCellContext, database: Db): Promise<string | null> {
  if (ctx.challengeId) {
    const [row] = await database
      .select({ workArea: challenges.work_area })
      .from(challenges)
      .where(eq(challenges.id, ctx.challengeId));
    if (row?.workArea) return row.workArea;
  }
  if (ctx.flowId) {
    const [row] = await database
      .select({ workArea: challenges.work_area })
      .from(solutions)
      .innerJoin(challenges, eq(solutions.challenge_id, challenges.id))
      .where(eq(solutions.flow_id, ctx.flowId));
    if (row?.workArea) return row.workArea;
  }
  return null;
}
