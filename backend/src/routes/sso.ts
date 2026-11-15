// src/routes/sso.ts — Phase 4 / E.1: per-tenant Entra OIDC SSO management (spec Part 8 / 6.2).
//
// The tenant-scoped counterpart pattern to tenant-users.ts. A tenant_admin manages their OWN
// tenant's Entra Identity Provider (a super_admin may scope-switch in, audited via
// requireTenantAdmin). Every write is force-scoped to the effective tenant — the body can carry
// neither an `alias` nor a `tenant_id` (the keystone `tenant_id` mapper is derived backend-side in
// sso-service, Part 8.4), so a tenant_admin can never wire an IdP to another tenant.
//
//   • GET    /api/tenants/:id/sso/providers        — list this tenant's IdPs (secret stripped).
//   • POST   /api/tenants/:id/sso/providers        — register the Entra IdP (KC-first then mirror).
//   • PATCH  /api/tenants/:id/sso/providers/:pid    — update (enable/scopes/trust/link-only/secret).
//   • DELETE /api/tenants/:id/sso/providers/:pid    — remove (KC + mirror row).
//   • GET    /api/admin/sso/providers               — platform overview (super_admin, runAsSystem).
import { z } from 'zod';
import { runAsSystem } from '../db/client';
import { requireTenantAdmin, requireSuperAdmin } from '../middleware/admin-guards';
import { recordAudit } from '../host/audit-service';
import { keycloakAdmin } from '../services/keycloak-admin';
import {
  createTenantIdp,
  updateTenantIdp,
  deleteTenantIdp,
  listTenantIdps,
  listAllIdps,
} from '../services/sso-service';
import { jsonResponse, readJson, route } from '../utils/http';
import type { Router } from '../utils/router';

// Entra "Directory (tenant) ID" is a GUID. Accept any RFC-4122 form.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `.strip()` (not `.strict()`) so a client that echoes `alias`/`tenantId` doesn't 422 — those
// fields are simply dropped, and the IdP is force-scoped to the path tenant (spec §6.3 posture).
const createIdpSchema = z
  .object({
    entraTenantGuid: z.string().regex(GUID_RE, 'must be a directory (tenant) GUID'),
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(400),
    scopes: z.string().min(1).max(200).optional(),
    trustEmail: z.boolean().optional(),
    linkOnly: z.boolean().optional(),
  })
  .strip();

const patchIdpSchema = z
  .object({
    enabled: z.boolean().optional(),
    scopes: z.string().min(1).max(200).optional(),
    trustEmail: z.boolean().optional(),
    linkOnly: z.boolean().optional(),
    clientSecret: z.string().min(1).max(400).optional(),
  })
  .strip();

/** GET /api/tenants/:id/sso/providers — this tenant's IdPs (secret stripped). */
const listProviders = route(async (req, id) => {
  const { effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  return jsonResponse({ providers: await listTenantIdps(effectiveTenantId) });
});

/** POST /api/tenants/:id/sso/providers — register the tenant's Entra IdP (force-scoped). */
const createProvider = route(async (req, id) => {
  const { user: actor, effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  const body = createIdpSchema.parse(await readJson(req));

  const provider = await createTenantIdp(keycloakAdmin(), {
    tenantId: effectiveTenantId, // the keystone — never the body
    entraTenantGuid: body.entraTenantGuid,
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    scopes: body.scopes,
    trustEmail: body.trustEmail,
    linkOnly: body.linkOnly,
  });

  await recordAudit({
    actorId: actor.id,
    tenantId: effectiveTenantId,
    action: 'idp.create',
    category: 'auth',
    targetType: 'identity_provider',
    targetId: provider.id,
    result: provider.alias,
    resultTone: 'ok',
    metadata: { tenantId: effectiveTenantId, alias: provider.alias },
  });
  return jsonResponse({ provider }, 201);
});

/** PATCH /api/tenants/:id/sso/providers/:pid — update the tenant's IdP. */
const updateProvider = route(async (req, id, pid) => {
  const { user: actor, effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  const body = patchIdpSchema.parse(await readJson(req));

  const provider = await updateTenantIdp(keycloakAdmin(), effectiveTenantId, pid!, body);

  await recordAudit({
    actorId: actor.id,
    tenantId: effectiveTenantId,
    action: 'idp.update',
    category: 'auth',
    targetType: 'identity_provider',
    targetId: provider.id,
    result: provider.alias,
    resultTone: 'ok',
    metadata: { tenantId: effectiveTenantId, alias: provider.alias },
  });
  return jsonResponse({ provider });
});

/** DELETE /api/tenants/:id/sso/providers/:pid — remove the tenant's IdP. */
const deleteProvider = route(async (req, id, pid) => {
  const { user: actor, effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  await deleteTenantIdp(keycloakAdmin(), effectiveTenantId, pid!);

  await recordAudit({
    actorId: actor.id,
    tenantId: effectiveTenantId,
    action: 'idp.delete',
    category: 'auth',
    targetType: 'identity_provider',
    targetId: pid,
    result: 'deleted',
    resultTone: 'warn',
    metadata: { tenantId: effectiveTenantId },
  });
  return jsonResponse({ ok: true });
});

/** GET /api/admin/sso/providers — platform cross-tenant overview (super_admin). Reads through
 *  runAsSystem because the runtime cp_app role is NOBYPASSRLS (Part 3.6 narrow platform path). */
const listAllProviders = route(async (req) => {
  await requireSuperAdmin(req);
  const providers = await runAsSystem('platform-admin', () => listAllIdps());
  return jsonResponse({ providers });
});

export function registerSsoRoutes(router: Router): void {
  router.add('GET', '/api/tenants/:id/sso/providers', listProviders);
  router.add('POST', '/api/tenants/:id/sso/providers', createProvider);
  router.add('PATCH', '/api/tenants/:id/sso/providers/:pid', updateProvider);
  router.add('DELETE', '/api/tenants/:id/sso/providers/:pid', deleteProvider);
  router.add('GET', '/api/admin/sso/providers', listAllProviders);
}
