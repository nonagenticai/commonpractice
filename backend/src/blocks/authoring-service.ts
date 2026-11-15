// src/blocks/authoring-service.ts — the single code path for AUTHORING building blocks (create block,
// add/save a draft version, publish), shared by the HTTP routes (routes/blocks.ts) and the MCP
// authoring tools (ai/mcp/tools.ts). Mirrors how flow-edit-service backs both the flow routes and the
// MCP flow tools, so human and AI authoring can never drift.
//
// Auth is the CALLER's job (the route resolves it from the Request via the admin-guards; the MCP tool
// resolves it from the caller's roles via the *ByRoles helpers here). Both then call the same write
// cores, which use the request/agent-scoped `db` proxy + runForBlock so RLS ownership is identical:
//   • GLOBAL block (tenant_id NULL) → super_admin, written via runAsSystem (owner — the 4c policies
//     reject NULL-tenant writes under the cp_app runtime role);
//   • TENANT block → a developer/admin of that tenant, written under the ambient tenant-bound context.
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db, buildingBlocks, blockVersions, users, runAsSystem } from '../db/client';
import type { BlockVersion, BuildingBlock } from '../db/schema';
import {
  emptyDescriptor,
  type BlockCategory,
  type BlockDescriptor,
  type BlockExample,
} from '../db/block-types';
import { conflict, forbidden, notFound, unprocessable } from '../utils/http';
import { lintBlock } from './lint';
import { assertBlockSourceSafe, EMPTY_SCANNED_SOURCE } from './source-gate';
import { runBlockTests } from './test-runner';
import { getSnapshot } from '../host/policy-store';
import { recordAudit } from '../host/audit-service';
import { enqueueTranslations } from '../host/translation-service';
import { blockI18nKey } from './i18n-key';
import { log } from '../host/logger';

// ---- role helpers (the MCP path has no Request; it authorizes from the caller's realm roles) ----

const SUPER_ADMIN = 'super_admin';
const TENANT_ADMIN = 'tenant_admin';
const DEVELOPER = 'developer';

/** A developer or an admin (tenant_admin / super_admin, composite) — the tenant-authoring gate. */
export function isDeveloperRoles(roles: string[]): boolean {
  return roles.includes(SUPER_ADMIN) || roles.includes(TENANT_ADMIN) || roles.includes(DEVELOPER);
}
function isSuperAdminRoles(roles: string[]): boolean {
  return roles.includes(SUPER_ADMIN);
}

export interface AuthorScope {
  userId: string;
  scope: 'global' | 'tenant';
  tenantId: string | null;
}

/**
 * Resolve the authoring scope for CREATING a block from the caller's roles (MCP path — there's no
 * `?scope` query). super_admin → global (platform); developer/tenant_admin → their own tenant.
 * Throws if the caller can't author at all, or is tenant-scoped with no tenant.
 */
export function resolveCreateScopeByRoles(
  userId: string,
  roles: string[],
  tenantId: string | null,
): AuthorScope {
  if (!isDeveloperRoles(roles)) throw forbidden('developer_required', 'Developer role required');
  if (isSuperAdminRoles(roles)) return { userId, scope: 'global', tenantId: null };
  if (!tenantId) throw forbidden('tenant_id_claim_required', 'No tenant for block authoring');
  return { userId, scope: 'tenant', tenantId };
}

/**
 * Authorize a write to an EXISTING block from the caller's roles + effective tenant (MCP path).
 *  - global block → super_admin only;
 *  - tenant block → a developer/admin whose effective tenant owns it (else 404, mirroring the route).
 */
export function authorizeBlockWriteByRoles(
  roles: string[],
  effectiveTenantId: string | null,
  block: BuildingBlock,
): { isGlobal: boolean } {
  if (block.tenant_id === null) {
    if (!isSuperAdminRoles(roles)) throw forbidden('super_admin_required', 'Super admin role required');
    return { isGlobal: true };
  }
  if (!isDeveloperRoles(roles)) throw forbidden('developer_required', 'Developer role required');
  if (block.tenant_id !== effectiveTenantId) {
    throw notFound('block_not_found', `No block '${block.slug}'`);
  }
  return { isGlobal: false };
}

// ---- shared low-level helpers (also imported by routes/blocks.ts) ----

/** Bump the patch component of a 2- or 3-part semver ("2.3" → "2.3.1"). */
export function bumpVersion(latest: string): string {
  const nums = latest.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
  while (nums.length < 3) nums.push(0);
  nums[2] = (nums[2] ?? 0) + 1;
  return nums.join('.');
}

export async function maintainerExists(userId: string): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return rows.length > 0;
}

/** Load a block by slug under the caller's RLS scope (global ∪ own tenant). 404 if absent. */
export async function loadBlockBySlug(slug: string): Promise<BuildingBlock> {
  const [block] = await db
    .select()
    .from(buildingBlocks)
    .where(eq(buildingBlocks.slug, slug))
    .orderBy(asc(buildingBlocks.tenant_id));
  if (!block) throw notFound('block_not_found', `No block '${slug}'`);
  return block;
}

export const ownerOf = (b: { tenant_id: string | null }): 'global' | 'tenant' =>
  b.tenant_id === null ? 'global' : 'tenant';

/** Load a block + one of its versions by (slug, version). 404 if either is absent. */
export async function loadBlockVersion(
  slug: string,
  version: string,
): Promise<{ block: BuildingBlock; version: BlockVersion }> {
  const block = await loadBlockBySlug(slug);
  const [v] = await db
    .select()
    .from(blockVersions)
    .where(and(eq(blockVersions.block_id, block.id), eq(blockVersions.version, version)));
  if (!v) throw notFound('version_not_found', `No version ${version} for '${slug}'`);
  return { block, version: v };
}

/** Run a block mutation in the DB context matching its ownership (global → owner; tenant → request). */
export function runForBlock<T>(isGlobal: boolean, fn: () => Promise<T>): Promise<T> {
  return isGlobal ? runAsSystem('platform-admin', fn) : fn();
}

// ---- write cores (shared by the routes + the MCP tools) ----

export interface CreateBlockInput {
  slug: string;
  name: string;
  description?: string;
  category: BlockCategory;
  region?: string;
  cost_class?: string;
  license?: string;
  docs_md?: string;
  source_ts?: string;
  descriptor?: BlockDescriptor;
  examples?: BlockExample[];
}

/** Create a block + its initial `0.1.0` draft. Dup-checks the slug (global always reserves it; a
 *  tenant block also rejects a same-tenant dup; v1 forbids a tenant reusing a global slug). */
export async function createBlockCore(
  ctx: AuthorScope,
  body: CreateBlockInput,
): Promise<{ block: BuildingBlock; version: BlockVersion; owner: 'global' | 'tenant' }> {
  const isGlobal = ctx.scope === 'global';

  const [globalDup] = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(and(eq(buildingBlocks.slug, body.slug), isNull(buildingBlocks.tenant_id)));
  if (globalDup) {
    // `slug` rides as a named detail so a locale rebuilds the sentence instead of regexing it out.
    if (isGlobal) throw conflict('slug_taken', `A block '${body.slug}' already exists`, { slug: body.slug });
    throw conflict('slug_reserved_global', `'${body.slug}' is a platform block slug`, { slug: body.slug });
  }
  if (!isGlobal) {
    const [tenantDup] = await db
      .select({ id: buildingBlocks.id })
      .from(buildingBlocks)
      .where(and(eq(buildingBlocks.slug, body.slug), eq(buildingBlocks.tenant_id, ctx.tenantId!)));
    // Same code, same `slug` detail as the global arm above — one catalog entry serves both.
    if (tenantDup) throw conflict('slug_taken', `A block '${body.slug}' already exists`, { slug: body.slug });
  }

  // ⛔ BEFORE THE TRANSACTION, NOT INSIDE IT. A gate that 422s after the INSERT is not a gate —
  // the row is already on disk and a later `simulate` would load it. Throwing here means the
  // block and its 0.1.0 draft are never created at all.
  const source = await assertBlockSourceSafe(body.source_ts ?? '');

  const maintainerId = (await maintainerExists(ctx.userId)) ? ctx.userId : null;
  const descriptor: BlockDescriptor = body.descriptor ?? emptyDescriptor();
  const examples: BlockExample[] = body.examples ?? [];

  const created = await runForBlock(isGlobal, () =>
    db.transaction(async (tx) => {
      const [block] = await tx
        .insert(buildingBlocks)
        .values({
          slug: body.slug,
          name: body.name,
          description: body.description ?? '',
          category: body.category,
          tenant_id: ctx.tenantId, // NULL for global; the tenant uuid for tenant-authored
          maintainer_id: maintainerId,
          region: body.region ?? null,
          cost_class: body.cost_class ?? null,
          license: body.license ?? null,
        })
        .returning();
      const [version] = await tx
        .insert(blockVersions)
        .values({
          block_id: block!.id,
          version: '0.1.0',
          status: 'draft',
          docs_md: body.docs_md ?? '',
          source_ts: source,
          descriptor,
          examples,
        })
        .returning();
      return { block: block!, version: version! };
    }),
  );

  return { ...created, owner: ctx.scope };
}

export interface AddVersionInput {
  version?: string;
  from_version?: string;
  docs_md?: string;
  source_ts?: string;
  descriptor?: BlockDescriptor;
  examples?: BlockExample[];
  changelog?: string;
}

/** Add a new draft version to an existing block (patch-bumped off `from_version` / latest). */
export async function addVersionCore(
  ctx: { isGlobal: boolean },
  block: BuildingBlock,
  body: AddVersionInput,
): Promise<BlockVersion> {
  const versions = await db
    .select()
    .from(blockVersions)
    .where(eq(blockVersions.block_id, block.id))
    .orderBy(desc(blockVersions.created_at));
  const base = body.from_version
    ? versions.find((v) => v.version === body.from_version)
    : versions[0];

  const version = body.version ?? bumpVersion(base?.version ?? '0.0.0');
  if (versions.some((v) => v.version === version)) {
    // `version` named on the wire; the English sentence is only the rolling-deploy fallback.
    throw conflict('version_exists', `Version ${version} already exists`, { version });
  }

  // ⚠️ ONLY THE AUTHOR-SUPPLIED SOURCE IS GATED. When `body.source_ts` is absent the new draft
  // INHERITS `base.source_ts` verbatim, and that value is carried through untouched on purpose:
  // `base` is very often a PUBLISHED version, and refusing to fork it would be retro-linting a
  // frozen row — breaking a tenant's ability to iterate on their own shipped block in order to
  // make a policy string true. A source that only ever existed before this gate is still caught
  // at the two places where it MATTERS: the draft run paths (test / simulate) and publish.
  const source = body.source_ts !== undefined
    ? await assertBlockSourceSafe(body.source_ts)
    : (base?.source_ts ?? EMPTY_SCANNED_SOURCE);

  const [draft] = await runForBlock(ctx.isGlobal, () =>
    db
      .insert(blockVersions)
      .values({
        block_id: block.id,
        version,
        status: 'draft',
        docs_md: body.docs_md ?? base?.docs_md ?? '',
        source_ts: source,
        descriptor: body.descriptor ?? base?.descriptor ?? emptyDescriptor(),
        examples: body.examples ?? base?.examples ?? [],
        changelog: body.changelog ?? '',
      })
      .returning(),
  );
  return draft!;
}

export interface SaveVersionInput {
  docs_md?: string;
  source_ts?: string;
  descriptor?: BlockDescriptor;
  examples?: BlockExample[];
  changelog?: string;
}

/** Edit a DRAFT version's fields. Throws if the version isn't a draft. */
export async function saveVersionCore(
  ctx: { isGlobal: boolean },
  v: BlockVersion,
  body: SaveVersionInput,
): Promise<BlockVersion> {
  if (v.status !== 'draft') {
    // Both interpolated values named: `status` is a closed enum a locale translates on its own.
    throw conflict('not_a_draft', `Version ${v.version} is ${v.status}; only drafts are editable`, {
      version: v.version,
      status: v.status,
    });
  }
  // ⛔ BEFORE THE UPDATE. This is the path the block editor's Save button and the agent's
  // `save_block_version` / `propose_block_patch` tools all land on, and it wrote whatever it was
  // given. A 422 raised after the UPDATE would leave the banned source in the row.
  const source = body.source_ts !== undefined ? await assertBlockSourceSafe(body.source_ts) : undefined;
  const [updated] = await runForBlock(ctx.isGlobal, () =>
    db
      .update(blockVersions)
      .set({
        ...(body.docs_md !== undefined ? { docs_md: body.docs_md } : {}),
        ...(source !== undefined ? { source_ts: source } : {}),
        ...(body.descriptor !== undefined ? { descriptor: body.descriptor } : {}),
        ...(body.examples !== undefined ? { examples: body.examples } : {}),
        ...(body.changelog !== undefined ? { changelog: body.changelog } : {}),
      })
      .where(eq(blockVersions.id, v.id))
      .returning(),
  );
  return updated!;
}

/**
 * Publish a draft. Lint gate (scan + tsc) always; for a `stable` publish (when governance requires it)
 * re-run the block's tests and require ≥1 enabled test all passing. Throws `unprocessable` carrying
 * `findings` (lint) or `summary` (tests) so the caller surfaces the exact 422 body. Records the
 * publish audit and queues translations on success.
 */
export async function publishVersionCore(
  /** `tenantId` is the request's tenant, forwarded to the test gate's fixture resolution — a
   *  publish re-runs the suite, and those fixtures are tenant-scoped shared data. */
  ctx: { userId: string; tenantId: string | null; isGlobal: boolean },
  block: BuildingBlock,
  v: BlockVersion,
  requestedStatus: 'beta' | 'stable' | undefined,
): Promise<BlockVersion> {
  // Same guard as saveVersionCore, and for the same reason: a published version is frozen. Without
  // it, `{"status":"beta"}` on a SUPERSEDED version skipped the test gate below, restamped
  // published_at, and repointed current_version_id backwards — the library silently reverted.
  if (v.status !== 'draft') {
    // Both interpolated values named: `status` is a closed enum a locale translates on its own.
    throw conflict('not_a_draft', `Version ${v.version} is ${v.status}; only drafts are editable`, {
      version: v.version,
      status: v.status,
    });
  }
  const lint = lintBlock(v.source_ts);
  if (!lint.ok) {
    throw unprocessable('lint_failed', 'Block failed lint', { findings: lint.findings });
  }

  const status = requestedStatus ?? 'stable';

  if (status === 'stable') {
    const snapshot = await getSnapshot();
    if (snapshot.requirePassingTests) {
      // NOT wrapped in runForBlock, on purpose. Since migration 0057 the block_test_results /
      // block_versions policies require the parent block to be OWNED by the current tenant, so
      // publishing a GLOBAL block to stable does need the owner pool for its result rows — but
      // runBlockTests owns that decision internally (it re-reads the block and wraps ONLY the two
      // persist statements). Wrapping the whole call here instead would also run the test's
      // fixture resolution as the system, and loadInjectedDatasets would then range over every
      // tenant's datasets. See the note at the top of runBlockTests.
      const summary = await runBlockTests(v.id, { ctxUserId: ctx.userId, tenantId: ctx.tenantId });
      if (summary.total === 0 || !summary.testsPassing) {
        await recordAudit({
          actorId: ctx.userId,
          action: 'block.publish_blocked',
          category: 'block',
          targetType: 'block',
          targetId: `${block.slug}@${v.version}`,
          result: summary.total === 0 ? 'Blocked · no tests' : `Blocked · ${summary.passed}/${summary.total} passing`,
          resultTone: 'error',
        });
        // TWO CODES BEHIND ONE THROW, hoisted out of the argument list so both literals are
        // greppable by eye and by a plain `grep 'tests_failing'`, which a ternary inside the call
        // arguments makes needlessly hard to read.
        //
        // ⚠️ IT BUYS NO GUARD COVERAGE, and an earlier version of this comment claimed it did.
        // `error-message.backend-contract.test.ts` walks the call graph from
        // `routes/solutions#createSolution`, which does not reach `publishVersionCore`, so neither
        // code was ever in that scraper's input; and its `literalOrUnresolved` treats a bare
        // identifier exactly as it treated the ternary — unresolved either way. Both codes already
        // have localized copy at `frontend/src/routes/block-edit/+page.svelte:584-589`.
        //
        // Neither gains a `reason` — each carries exactly ONE sentence — and neither gains a new
        // named param: the `summary` bag below already holds the counts a locale interpolates.
        // The wire bytes and both branches are byte-identical to before.
        const noTests = summary.total === 0;
        const code = noTests ? 'tests_required' : 'tests_failing';
        const message = noTests
          ? 'Publishing to stable requires at least one passing test.'
          : 'All enabled tests must pass before publishing to stable.';
        throw unprocessable(code, message, { summary });
      }
    }
  }

  const published = await runForBlock(ctx.isGlobal, () =>
    db.transaction(async (tx) => {
      const [pub] = await tx
        .update(blockVersions)
        .set({
          status,
          published_by: (await maintainerExists(ctx.userId)) ? ctx.userId : null,
          published_at: new Date(),
        })
        .where(eq(blockVersions.id, v.id))
        .returning();
      await tx
        .update(buildingBlocks)
        .set({ current_version_id: v.id, updated_at: new Date() })
        .where(eq(buildingBlocks.id, block.id));
      return pub!;
    }),
  );

  await recordAudit({
    actorId: ctx.userId,
    action: 'block.publish',
    category: 'block',
    targetType: 'block',
    targetId: `${block.slug}@${v.version}`,
    result: `Published · ${status}`,
    resultTone: 'ok',
  });

  try {
    // Keyed by the block's OWN tenant_id — see blocks/i18n-key.ts. This is the single seam that
    // covers both the HTTP publish (routes/blocks.ts) and the MCP `publish_block` agent tool, and
    // re-keying the JOBS is what makes the drainer correct for free: it and the admin override
    // both write `job.entity_type`/`entity_id` verbatim.
    const key = blockI18nKey(block);
    await enqueueTranslations(
      key.entityType,
      key.entityId,
      [
        { field: 'name', value: block.name },
        { field: 'description', value: block.description },
        { field: 'docs_md', value: published.docs_md },
      ],
      ctx.userId,
    );
  } catch (e) {
    log.warn('translation_enqueue_failed', { component: 'translation', slug: block.slug, err: e });
  }

  return published;
}
