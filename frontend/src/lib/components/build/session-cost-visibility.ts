// src/lib/components/build/session-cost-visibility.ts — who sees the assistant's running LLM spend.
//
// Spend is an administrator's number. A member or developer building a flow sees the assistant,
// not its bill. Delegates to `roleAllows` so this gate and the sidebar's /usage item (tenant_admin)
// are the same rule: super_admin ⊇ tenant_admin.
import { roleAllows } from '$lib/layout/navConfig';

export function canSeeSessionCost(roles: readonly string[]): boolean {
	return roleAllows('tenant_admin', roles);
}
