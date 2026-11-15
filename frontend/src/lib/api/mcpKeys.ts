// src/lib/api/mcpKeys.ts — typed client for tenant MCP API-key issuance/revocation
// (Phase 2-D). The issue response carries the raw key ONCE (shown then discarded).
import { authFetch } from './auth-fetch';
import { unwrap } from './admin';
import type { McpKeyRow, IssuedKey } from '$lib/types/admin';

export const mcpKeysApi = {
	async list(tenantId: string): Promise<{ keys: McpKeyRow[] }> {
		return unwrap(await authFetch(`/api/tenants/${tenantId}/mcp-keys`));
	},
	async issue(
		tenantId: string,
		name: string,
		scopes?: string[]
	): Promise<IssuedKey> {
		return unwrap(
			await authFetch(`/api/tenants/${tenantId}/mcp-keys`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(scopes ? { name, scopes } : { name })
			})
		);
	},
	async revoke(tenantId: string, keyId: string): Promise<{ ok: true }> {
		return unwrap(
			await authFetch(`/api/tenants/${tenantId}/mcp-keys/${keyId}`, { method: 'DELETE' })
		);
	}
};
