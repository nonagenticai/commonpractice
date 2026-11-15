// src/db/tenant-context.ts — Phase D (RLS): the per-request DB tenant context.
//
// An AsyncLocalStorage that, for the duration of one authenticated request, holds a RESERVED
// postgres-js connection that has had `app.current_tenant` set to the request's effective tenant.
// `client.ts` wraps the exported `db` in a Proxy that routes plain statements onto this reserved
// connection (so Postgres RLS scopes them) and falls back to the pool when there is no context
// (seed / migrations / schedulers / unauthenticated paths). Kept dependency-free of `client.ts`
// (one-directional: client → tenant-context) so there is no import cycle.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ReservedSql } from 'postgres';

export interface RequestDbContext {
  /** The effective tenant for this request (what `app.current_tenant` is set to). Mutable so the
   *  authoritative guards (resolveTenant / requireTenantAdmin) can correct it via refreshTenantGuc.
   *  Empty string for a SYSTEM context (see `system`), which carries no per-tenant GUC. */
  tenantId: string;
  /** The connection reserved for this request; released (after a GUC reset) when the request ends.
   *  Absent for a SYSTEM context — runAsSystem binds the shared owner pool, not a reserved conn. */
  reserved?: ReservedSql;
  /** A drizzle instance bound to `reserved` (request) or the owner pool (system) — the Proxy
   *  delegates plain statements here. Typed `unknown` to keep this module client-free; client.ts
   *  narrows it to its `Db` type at use. */
  boundDb: unknown;
  /** Phase 4 / D.1.1: a SYSTEM (owner) context established by runAsSystem for genuine cross-tenant
   *  work (schedulers, seed, platform reads). boundDb is the owner drizzle (bypasses RLS) and there
   *  is NO tenant GUC, so the Proxy must NOT inject `SET LOCAL app.current_tenant` into its txns. */
  system?: boolean;
  /** Integration-test only: make owner-backed dev connections execute as the production cp_app
   * role, including transactions, so route tests exercise real RLS instead of table-owner bypass. */
  enforceRuntimeRole?: boolean;
}

const store = new AsyncLocalStorage<RequestDbContext>();

export const currentDbContext = (): RequestDbContext | undefined => store.getStore();

export const runWithContext = <T>(
  ctx: RequestDbContext,
  fn: () => Promise<T>,
): Promise<T> => store.run(ctx, fn);
