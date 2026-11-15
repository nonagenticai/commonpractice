// src/services/agent-session.ts — the agent two-token model (SPEC §5A; mirror
// fr/backend/src/services/agent-session.ts). A Keycloak-authenticated user exchanges
// their login for a short-lived HS256 ACCESS token (Bearer on /api/agent/chat) plus a
// long-lived REFRESH token. Only the sha256 HASH of the refresh token is stored; on
// rotation the consumed row's `replaced_by` points at its successor, and a replay of a
// consumed refresh revokes the whole forward chain (replay protection).
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, agentSessions, users, runAsSystem, withTenantDb } from '../db/client';
import { config } from '../config';
import { UnauthorizedError } from '../types';

type Db = typeof db;

const AUD = 'cp-agent';

function secret(): Uint8Array {
  return new TextEncoder().encode(config.agent.jwtSecret);
}
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function newRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

/** Mint a short-lived HS256 access token (the Bearer on the chat endpoint). Carries the user's
 *  realm `roles` so the agent's developer-gated MCP authoring tools can authorize the caller without
 *  a Keycloak round-trip. (The refresh flow re-mints with no roles — fail-closed — but the chat FE
 *  re-issues a fresh Keycloak-authed token per turn, so a developer's roles are always current.)
 *
 *  ⛔ `tid` IS THE WHOLE POINT OF THIS PARAMETER AND IT IS NOT OPTIONAL. Before it existed the token
 *  carried only a `sub`, so every consumer (`routes/agent.ts`, `routes/mcp.ts`) had to re-derive the
 *  workspace from `users.tenant_id` via `homeTenantOf` — a column written ONCE on first touch and
 *  never reconciled against a later Keycloak `tenant_id` claim. The browser resolves the claim
 *  (`middleware/tenant.ts resolveTenant`), the copilot resolved the stale column, and the two
 *  answered about DIFFERENT workspaces: measured in prod as one user's 17 `agent_sessions` rows
 *  spread across THREE tenants, and `chat_sessions`/`chat_messages` split across two. Baking the
 *  tenant in at MINT time — where a Keycloak claim is in hand and the RLS GUC is already bound to
 *  it — makes token ≡ GUC ≡ row by construction for every later request that presents this token. */
export async function signAccessToken(
  userId: string,
  roles: string[],
  tenantId: string,
): Promise<string> {
  return new SignJWT({ roles, tid: tenantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(`${config.agent.accessTtlSec}s`)
    .sign(secret());
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string; // raw — returned ONCE, only its hash is stored
  accessToken: string;
  expiresIn: number; // access-token TTL (seconds)
}

/**
 * Exchange a Keycloak login for a fresh agent session. `roles` AND `tenantId` are baked into the
 * access token.
 *
 * ⚠️ `tenant_id` IS PASSED EXPLICITLY RATHER THAN LEFT TO THE COLUMN DEFAULT, and the difference
 * matters even though the two agree on the happy path. The column defaults to
 * `app_current_tenant_uuid()` (schema.ts), i.e. to whatever RLS GUC the caller happens to be under
 * — so the row's tenant and the TOKEN's tenant had two independent derivations and nothing forced
 * them to agree. Writing the same `tenantId` into both is what makes "the token says B" and "the
 * session row says B" one fact instead of two. It also makes this function honest outside a
 * request: `runAsSystem` sets no GUC at all, where the default would have raised a NOT NULL
 * violation on a column that looks like it has a default.
 */
export async function issueAgentSession(
  userId: string,
  roles: string[],
  tenantId: string,
): Promise<IssuedSession> {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + config.agent.refreshTtlSec * 1000);
  const [row] = await db
    .insert(agentSessions)
    .values({
      user_id: userId,
      tenant_id: tenantId,
      refresh_token_hash: hashToken(refreshToken),
      expires_at: expiresAt,
    })
    .returning();
  const accessToken = await signAccessToken(userId, roles, tenantId);
  return {
    sessionId: row!.id,
    refreshToken,
    accessToken,
    expiresIn: config.agent.accessTtlSec,
  };
}

/** Revoke a session and every successor along the replaced_by chain. */
async function revokeChain(startId: string): Promise<void> {
  let id: string | null = startId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const rows: { replaced_by: string | null }[] = await db
      .update(agentSessions)
      .set({ revoked_at: new Date() })
      .where(eq(agentSessions.id, id))
      .returning({ replaced_by: agentSessions.replaced_by });
    id = rows[0]?.replaced_by ?? null;
  }
}

/**
 * Revoke every live agent session a user holds. Returns how many were revoked.
 *
 * Offboarding must call this EXPLICITLY. `agent_sessions.user_id` is ON DELETE CASCADE, so hard-
 * deleting the `users` row destroyed the refresh chains implicitly; tombstoning (0050) keeps the
 * row, so that stopped happening and a departed user's refresh token stayed renewable forever.
 */
export async function revokeSessionsFor(userId: string, database: Db = db): Promise<number> {
  const rows = await database
    .update(agentSessions)
    .set({ revoked_at: new Date() })
    .where(and(eq(agentSessions.user_id, userId), isNull(agentSessions.revoked_at)))
    .returning({ id: agentSessions.id });
  return rows.length;
}

/**
 * Rotate a refresh token → a new session. Detects replay (a consumed token) and revokes the chain.
 *
 * ⛔ THE LOOKUP RUNS UNDER `runAsSystem`, AND WITHOUT THAT THIS ENDPOINT IS DEAD IN PRODUCTION.
 * `POST /api/agent/session/refresh` presents an OPAQUE refresh token and no Keycloak header, so
 * `server.ts`'s `peekEffectiveTenant` resolves null and NO `app.current_tenant` GUC is bound. Under
 * the production `cp_app` role (NOBYPASSRLS) the `agent_sessions` SELECT below therefore matched
 * ZERO rows for every caller and the endpoint answered "Invalid refresh token" — a live token read
 * as forged. It was invisible because the tests wrap the call in `withTenantDb` as the OWNER, which
 * both binds a GUC the real request never has and bypasses RLS anyway.
 *
 * The lookup cannot be tenant-scoped by definition: the token hash is the ONLY thing the request
 * carries, and which tenant it belongs to is precisely what we are looking up. So the read (and the
 * replay/offboard revocations that hang off it, which have the same problem) is a genuine
 * cross-tenant SYSTEM operation. The moment the row IS known, its `tenant_id` is the scope — the
 * successor is minted inside `withTenantDb(row.tenant_id)` so the new row, its GUC and the new
 * token's `tid` all carry the SAME tenant the consumed session carried. Rotation therefore
 * preserves the workspace instead of re-deriving it from `users.tenant_id`.
 *
 * ⛔ THE `db` PARAMETER IS GONE FROM THIS FUNCTION AND FROM `issueAgentSession`, DELIBERATELY, AND
 * IT MUST NOT COME BACK. `runAsSystem` and `withTenantDb` steer queries by re-binding an
 * AsyncLocalStorage context that ONLY the module-level `db` Proxy (db/client.ts:355) reads — it
 * resolves its target per property access (`ctx?.boundDb ?? target`). A caller that passed its own
 * drizzle handle or a transaction handle would bypass the Proxy entirely, and both scopes above
 * would become SILENT NO-OPS: the RLS-blind SELECT would run back on the caller's connection and
 * this endpoint would go straight back to answering "Invalid refresh token" in production while
 * every test stayed green. That is not a hypothetical shape in this codebase —
 * `services/offboarding.ts:87` passes an explicit handle to the sibling `revokeSessionsFor`. Taking
 * the parameter away is what makes the scoping unbypassable rather than merely documented.
 */
export async function refreshAgentSession(refreshToken: string): Promise<IssuedSession> {
  const row = await runAsSystem('credential-auth', async () => {
    const [found] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.refresh_token_hash, hashToken(refreshToken)));
    if (!found) throw new UnauthorizedError('Invalid refresh token');
    if (found.revoked_at) throw new UnauthorizedError('Refresh token revoked');
    if (found.replaced_by) {
      await revokeChain(found.id); // replay of an already-rotated token
      throw new UnauthorizedError('Refresh token replay detected');
    }
    if (found.expires_at.getTime() < Date.now()) {
      throw new UnauthorizedError('Refresh token expired');
    }
  // An OFFBOARDED user must not be able to keep renewing. `agent_sessions.user_id` is ON DELETE
  // CASCADE, so hard-deleting the `users` row used to destroy the whole refresh chain; tombstoning
  // (0050) keeps the row, so that implicit revocation stopped happening. Offboarding now revokes
  // these chains explicitly (revokeSessionsFor), and this is the fail-closed backstop — it is the
  // renewal boundary, so blocking here caps a departed user's remaining access at the access
  // token's TTL (AGENT_ACCESS_TTL_SEC, 15 min) rather than forever.
    const [owner] = await db
      .select({ deletedAt: users.deleted_at })
      .from(users)
      .where(eq(users.id, found.user_id))
      .limit(1);
    if (owner?.deletedAt) {
      await revokeChain(found.id);
      throw new UnauthorizedError('This account has been removed from its workspace');
    }
    return found;
  });
  // Refresh has no role source (the refresh token is opaque) — re-mint with no roles (fail-closed
  // for the developer-gated authoring tools); the chat FE re-issues a Keycloak-authed token per turn.
  // The tenant, by contrast, IS carried: it is the consumed row's, so a rotation can never move a
  // session to a different workspace (nor re-derive one from the stale `users.tenant_id` column).
  return withTenantDb(row.tenant_id, async () => {
    const next = await issueAgentSession(row.user_id, [], row.tenant_id);
    await db
      .update(agentSessions)
      .set({ replaced_by: next.sessionId })
      .where(eq(agentSessions.id, row.id));
    return next;
  });
}

/**
 * Verify the access token on an incoming request → the user id, the roles, and the TENANT baked in
 * at issue.
 *
 * `tenantId` is `string | null` and the null is load-bearing: a token minted before `tid` existed
 * (or by any other path that did not carry a tenant) verifies fine and reports no tenant. Callers
 * MUST fail closed on that — `routes/agent.ts` and `routes/mcp.ts` answer 401
 * `agent_token_no_tenant`. Falling back to `homeTenantOf` here would reinstate the exact drift this
 * claim exists to remove, and it would not rescue the users whose `users.tenant_id` is NULL anyway.
 */
export async function verifyAgentToken(
  req: Request,
): Promise<{ userId: string; roles: string[]; tenantId: string | null }> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing agent token');
  }
  try {
    const { payload } = await jwtVerify(auth.slice(7), secret(), { audience: AUD });
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new Error('no subject');
    }
    const roles = Array.isArray(payload.roles)
      ? (payload.roles as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];
    const tenantId = typeof payload.tid === 'string' && payload.tid ? payload.tid : null;
    return { userId: payload.sub, roles, tenantId };
  } catch {
    throw new UnauthorizedError('Invalid or expired agent token');
  }
}
