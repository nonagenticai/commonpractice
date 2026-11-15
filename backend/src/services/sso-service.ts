// src/services/sso-service.ts — Phase 4 / E.1: the per-tenant Entra OIDC broker chain.
//
// Spec: SPEC-PHASE4-admin-tenant-isolation.md Part 8. A tenant_admin registers their company's
// Microsoft Entra ID; CP brokers it to a Keycloak Identity Provider on the single `portal` realm
// (alias `entra-<slug>`) and keeps an editable mirror row (`identity_providers`) as the source of
// truth + audit anchor. KC-first then mirror, mirroring provisioning.ts: identity writes are FATAL
// (→ 502); the CP row is written only after Keycloak accepts.
//
// TENANT BINDING: the alias is derived from the caller's OWN tenant slug — never the form — and is
// unique in `identity_providers`. A brokered first login carries that alias (`idp_alias` claim), and
// `services/cp-identity.ts` seats the user as a `member` of the tenant that owns it. Keycloak holds
// no tenant attribute and no role mapper for it (the realm is shared with fr). The Entra
// client_secret is encrypted at rest (secret-box) and never returned by a read.
import { and, eq } from 'drizzle-orm';
import { db, identityProviders, tenants } from '../db/client';
import { config } from '../config';
import { encryptSecret, tryDecryptSecret } from '../host/secret-box';
import {
  KeycloakAdminError,
  DuplicateIdpError,
  type KeycloakAdminClient,
  type IdpRepresentation,
  type IdpMapperRepresentation,
} from './keycloak-admin';
import { conflict, notFound, HttpError } from '../utils/http';
import { log } from '../host/logger';
import type { IdpOidcConfig } from '../db/schema';

export interface CreateTenantIdpInput {
  tenantId: string;
  /** Entra "Directory (tenant) ID" GUID — the path segment in the Entra OIDC endpoints. */
  entraTenantGuid: string;
  /** Entra App Registration "Application (client) ID". */
  clientId: string;
  /** A client secret on that App Registration — encrypted at rest, never returned. */
  clientSecret: string;
  /** OIDC scopes; defaults to 'openid profile email'. */
  scopes?: string;
  /** Trust Entra-verified emails (default true — Entra emails are verified). */
  trustEmail?: boolean;
  /** Part 8.5 opt-in: true rejects first-login users with no pre-existing CP account. */
  linkOnly?: boolean;
}

export interface UpdateTenantIdpInput {
  enabled?: boolean;
  scopes?: string;
  trustEmail?: boolean;
  linkOnly?: boolean;
  /** Optional new client secret; absent = keep the stored one. */
  clientSecret?: string;
}

/** The read shape — the encrypted secret is NEVER projected (Part 8.7 secret hygiene). */
export interface PublicIdp {
  id: string;
  tenantId: string;
  alias: string;
  displayName: string;
  providerType: string;
  enabled: boolean;
  config: IdpOidcConfig;
  linkOnly: boolean;
  /** Whether a client secret is stored (so the UI can show "set / not set" without the value). */
  hasSecret: boolean;
  /** The redirect URI the admin must register in their Entra App Registration (read-only). */
  redirectUri: string;
  /** The owning tenant's display name. Set ONLY by `listAllIdps` (the platform cross-tenant
   *  overview, which is the one reader that does not already know whose tenant it is looking at).
   *  `listTenantIdps` leaves it undefined on purpose — that screen is scoped to one tenant and
   *  renders its name from the tenant it already loaded. Optional so the per-tenant read shape
   *  is unchanged. Undefined on the overview too if the row is orphaned (no `tenants` row). */
  tenantName?: string;
  createdAt: Date;
  updatedAt: Date;
}

type IdpRow = typeof identityProviders.$inferSelect;

/** `entra-<slug>` — the Keycloak alias + routing key. Derived from the tenant's OWN slug. */
export function aliasForSlug(slug: string): string {
  return `entra-${slug}`;
}

/** The Entra-side redirect URI to paste into the App Registration (Part 8.4). Built from the
 *  PUBLIC issuer of KEYCLOAK_USER_REALM (config.keycloak.userRealmIssuer), e.g.
 *  https://auth.nonagentic.ai/realms/commonpractice/broker/entra-<slug>/endpoint (realm = KEYCLOAK_USER_REALM) */
export function redirectUriForAlias(alias: string): string {
  // The IdP lives in CP's USER realm (KEYCLOAK_USER_REALM; default KEYCLOAK_REALM ⇒ KEYCLOAK_ISSUER).
  return `${config.keycloak.userRealmIssuer.replace(/\/+$/, '')}/broker/${alias}/endpoint`;
}

/** Entra OIDC endpoints are all derived from the directory (tenant) GUID. */
function entraOidcConfig(guid: string): {
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  userInfoUrl: string;
  discoveryUrl: string;
} {
  const base = `https://login.microsoftonline.com/${guid}`;
  return {
    issuer: `${base}/v2.0`,
    authorizationUrl: `${base}/oauth2/v2.0/authorize`,
    tokenUrl: `${base}/oauth2/v2.0/token`,
    jwksUrl: `${base}/discovery/v2.0/keys`,
    userInfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    discoveryUrl: `${base}/v2.0/.well-known/openid-configuration`,
  };
}

/** Build the Keycloak OIDC IdP representation. All `config` values are strings (KC requirement). */
function buildIdpRep(
  alias: string,
  displayName: string,
  guid: string,
  clientId: string,
  clientSecret: string,
  scopes: string,
  trustEmail: boolean,
  linkOnly: boolean,
): IdpRepresentation {
  const e = entraOidcConfig(guid);
  return {
    alias,
    displayName,
    providerId: 'oidc',
    enabled: true,
    trustEmail,
    linkOnly,
    storeToken: false,
    config: {
      clientId,
      clientSecret,
      clientAuthMethod: 'client_secret_post',
      issuer: e.issuer,
      authorizationUrl: e.authorizationUrl,
      tokenUrl: e.tokenUrl,
      jwksUrl: e.jwksUrl,
      userInfoUrl: e.userInfoUrl,
      defaultScope: scopes,
      validateSignature: 'true',
      useJwksUrl: 'true',
      syncMode: 'IMPORT',
    },
  };
}

/**
 * The IdP mappers, authored backend-side: standard email / given_name / family_name importers.
 * No tenant or role mapper — tenancy and role are CP's (see the header).
 */
export function buildIdpMappers(alias: string): IdpMapperRepresentation[] {
  return [
    {
      name: 'email',
      identityProviderAlias: alias,
      identityProviderMapper: 'oidc-user-attribute-idp-mapper',
      config: { syncMode: 'INHERIT', claim: 'email', 'user.attribute': 'email' },
    },
    {
      name: 'first-name',
      identityProviderAlias: alias,
      identityProviderMapper: 'oidc-user-attribute-idp-mapper',
      config: { syncMode: 'INHERIT', claim: 'given_name', 'user.attribute': 'firstName' },
    },
    {
      name: 'last-name',
      identityProviderAlias: alias,
      identityProviderMapper: 'oidc-user-attribute-idp-mapper',
      config: { syncMode: 'INHERIT', claim: 'family_name', 'user.attribute': 'lastName' },
    },
  ];
}

/** Project a stored row to the public read shape (secret stripped). `tenantName` is passed in by
 *  the ONE caller that joins for it (`listAllIdps`); every other caller omits it. */
function toPublicIdp(row: IdpRow, tenantName?: string | null): PublicIdp {
  return {
    ...(tenantName ? { tenantName } : {}),
    id: row.id,
    tenantId: row.tenant_id,
    alias: row.alias,
    displayName: row.display_name,
    providerType: row.provider_type,
    enabled: row.enabled,
    config: row.config,
    linkOnly: row.link_only,
    hasSecret: !!row.client_secret_encrypted,
    redirectUri: redirectUriForAlias(row.alias),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a Keycloak write failure to the right HTTP status (502 fatal / 409 duplicate). */
function rethrowKc(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof DuplicateIdpError) {
    throw conflict('idp_exists', 'An identity provider already exists for this tenant');
  }
  if (err instanceof KeycloakAdminError) {
    throw new HttpError(502, 'keycloak_idp_failed', err.message);
  }
  throw err;
}

/**
 * Register a tenant's Entra IdP. KC-first (create IdP → author the attribute mappers), then the
 * CP mirror row. The alias is derived from the tenant's OWN slug — caller input can never point
 * the IdP at another tenant (Part 8.6).
 */
export async function createTenantIdp(
  kc: KeycloakAdminClient,
  input: CreateTenantIdpInput,
): Promise<PublicIdp> {
  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId))
    .limit(1);
  if (!tenant) throw notFound('tenant_not_found', 'No such tenant');

  const alias = aliasForSlug(tenant.slug);
  // One Entra IdP per tenant in E.1 (DB UNIQUE(tenant_id, alias)) — pre-check for a clean 409.
  const [dupe] = await db
    .select({ id: identityProviders.id })
    .from(identityProviders)
    .where(and(eq(identityProviders.tenant_id, input.tenantId), eq(identityProviders.alias, alias)))
    .limit(1);
  if (dupe) throw conflict('idp_exists', 'An identity provider already exists for this tenant');

  const scopes = input.scopes?.trim() || 'openid profile email';
  const trustEmail = input.trustEmail ?? true;
  const linkOnly = input.linkOnly ?? false;
  const displayName = `Microsoft Entra ID (${tenant.name})`;

  try {
    await kc.createIdentityProvider(
      buildIdpRep(alias, displayName, input.entraTenantGuid, input.clientId, input.clientSecret, scopes, trustEmail, linkOnly),
    );
    for (const mapper of buildIdpMappers(alias)) {
      await kc.createIdpMapper(alias, mapper);
    }
  } catch (err) {
    rethrowKc(err);
  }

  const oidcConfig: IdpOidcConfig = {
    discovery_url: entraOidcConfig(input.entraTenantGuid).discoveryUrl,
    client_id: input.clientId,
    scopes,
    trust_email: trustEmail,
  };
  try {
    const [row] = await db
      .insert(identityProviders)
      .values({
        tenant_id: input.tenantId,
        alias,
        display_name: displayName,
        provider_type: 'oidc',
        enabled: true,
        config: oidcConfig,
        client_secret_encrypted: encryptSecret(input.clientSecret),
        link_only: linkOnly,
      })
      .returning();
    return toPublicIdp(row!);
  } catch (err) {
    // The IdP is ALREADY LIVE in Keycloak at this point. Without this compensation the tenant is
    // permanently stuck: the mirror row is missing, so every retry hits the `dupe` check in
    // Keycloak and 409s `idp_exists`, while `deleteTenantIdp` 404s `idp_not_found` because it
    // looks the alias up in the DB first. The tenant could then NEVER create or delete their SSO
    // connector again without an operator running kcadm by hand.
    //
    // Roll the realm back to match the DB rather than leave the two diverged.
    await kc.deleteIdentityProvider(alias).catch((cleanupErr: unknown) =>
      log.error('orphaned_keycloak_idp', {
        component: 'sso',
        alias,
        tenantId: input.tenantId,
        err: cleanupErr,
      }),
    );
    throw err;
  }
}

/** Update a tenant's IdP (enable/scopes/trust/link-only, optional new secret). Keycloak rep is
 *  re-PUT; the mappers are not touched. */
export async function updateTenantIdp(
  kc: KeycloakAdminClient,
  tenantId: string,
  idpId: string,
  patch: UpdateTenantIdpInput,
): Promise<PublicIdp> {
  const [row] = await db
    .select()
    .from(identityProviders)
    .where(and(eq(identityProviders.id, idpId), eq(identityProviders.tenant_id, tenantId)))
    .limit(1);
  if (!row) throw notFound('idp_not_found', 'No such identity provider in this tenant');

  const scopes = patch.scopes?.trim() || row.config.scopes;
  const trustEmail = patch.trustEmail ?? row.config.trust_email;
  const linkOnly = patch.linkOnly ?? row.link_only;
  const enabled = patch.enabled ?? row.enabled;
  // Reuse the stored secret unless a new one was supplied. The GUID is recoverable from the
  // stored discovery URL so the KC rep stays complete.
  const guid = guidFromDiscoveryUrl(row.config.discovery_url);
  const secret = patch.clientSecret?.trim()
    ? patch.clientSecret.trim()
    : decryptStoredSecret(row.client_secret_encrypted);

  try {
    const rep = buildIdpRep(row.alias, row.display_name, guid, row.config.client_id, secret, scopes, trustEmail, linkOnly);
    rep.enabled = enabled;
    await kc.updateIdentityProvider(row.alias, rep);
  } catch (err) {
    rethrowKc(err);
  }

  const nextConfig: IdpOidcConfig = { ...row.config, scopes, trust_email: trustEmail };
  const [updated] = await db
    .update(identityProviders)
    .set({
      enabled,
      link_only: linkOnly,
      config: nextConfig,
      ...(patch.clientSecret?.trim() ? { client_secret_encrypted: encryptSecret(patch.clientSecret.trim()) } : {}),
      updated_at: new Date(),
    })
    .where(and(eq(identityProviders.id, idpId), eq(identityProviders.tenant_id, tenantId)))
    .returning();
  return toPublicIdp(updated!);
}

/** Delete a tenant's IdP from Keycloak then drop the mirror row. */
export async function deleteTenantIdp(
  kc: KeycloakAdminClient,
  tenantId: string,
  idpId: string,
): Promise<void> {
  const [row] = await db
    .select({ alias: identityProviders.alias })
    .from(identityProviders)
    .where(and(eq(identityProviders.id, idpId), eq(identityProviders.tenant_id, tenantId)))
    .limit(1);
  if (!row) throw notFound('idp_not_found', 'No such identity provider in this tenant');
  try {
    await kc.deleteIdentityProvider(row.alias);
  } catch (err) {
    rethrowKc(err);
  }
  await db
    .delete(identityProviders)
    .where(and(eq(identityProviders.id, idpId), eq(identityProviders.tenant_id, tenantId)));
}

/** List a single tenant's IdPs (own-tenant; RLS + explicit predicate). Secret stripped. */
export async function listTenantIdps(tenantId: string): Promise<PublicIdp[]> {
  const rows = await db
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.tenant_id, tenantId));
  // ⚠️ NOT `.map(toPublicIdp)`. `toPublicIdp` now takes a second parameter and `Array.map` passes
  // the INDEX as it — which typechecks as far as arity and would set `tenantName: 1`. Caught by
  // tsc only because the parameter is typed `string | null`.
  return rows.map((row) => toPublicIdp(row));
}

/** Platform overview: ALL tenants' IdPs. MUST be called inside runAsSystem (cp_app is
 *  NOBYPASSRLS) so the super_admin cross-tenant read returns every row. Secret stripped.
 *
 * ⛔ THE TENANT NAME IS JOINED HERE, SERVER-SIDE, AND THAT IS THE POINT. `/sso-overview` exists to
 * answer "which tenant has which IdP" and its Tenant column rendered a raw UUID in a mono font
 * under an ellipsis — the one fact the screen is for was the one fact unreadable on it.
 *
 * ⛔ DO NOT REPLACE THIS WITH THE CLIENT-SIDE RESOLUTION `(tenant)/sso/+page.svelte:52-57` DOES.
 * That precedent is a latent bug, not a pattern:
 *   • It costs a second request to `GET /api/admin/tenants`, which is PAGINATED (routes/admin.ts:
 *     default limit 500, max 1000). `all.tenants.find(...)` silently misses tenant 501, and its
 *     own fallback — `name: scopeTenantId` — RENDERS THE UUID AGAIN. The fallback is the proof.
 *   • `/sso-overview` is otherwise a single-fetch page; a second round-trip would be new.
 *   • `listAllIdps` has exactly ONE consumer, and this module already imports `tenants`, so the
 *     server-side cost is one indexed leftJoin on the FK.
 * The join is LEFT deliberately. `identity_providers.tenant_id` is a FK ON DELETE CASCADE, so an
 * orphan cannot arise through the product today — but an INNER join would make the platform's list
 * of every broker silently conditional on that constraint holding, and losing a row is a worse
 * failure here than losing a name. That LEFT half IS covered: sso.test.ts drops the FK for the
 * length of one insert, asserts the orphan is still listed (`before + 1`) with `tenantName`
 * undefined and every other row's name intact, then restores the constraint. The frontend keeps the
 * matching `?? p.tenantId` fallback, which is covered by its own render test. */
export async function listAllIdps(): Promise<PublicIdp[]> {
  const rows = await db
    .select({ idp: identityProviders, tenantName: tenants.name })
    .from(identityProviders)
    .leftJoin(tenants, eq(identityProviders.tenant_id, tenants.id));
  return rows.map((r) => toPublicIdp(r.idp, r.tenantName));
}

// ---- small helpers ----

/** Decrypt a stored secret, or '' if absent/corrupt (update keeps KC's existing secret). */
function decryptStoredSecret(blob: string | null): string {
  if (!blob) return '';
  return tryDecryptSecret(blob) ?? '';
}

/** Recover the Entra directory GUID from the stored discovery URL (login.microsoftonline.com/<guid>/...). */
function guidFromDiscoveryUrl(url: string): string {
  const m = url.match(/login\.microsoftonline\.com\/([^/]+)\//);
  return m?.[1] ?? '';
}
