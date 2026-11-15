// src/lib/admin/act-as-refusal.ts — the sentence that explains WHY a super_admin cannot act as a
// workspace, from the backend's refusal code (`activeTenantRejected` on /api/me).
//
// ⛔ NEVER A SILENT DROP (George 2026-10-27). The backend judges a scope-switched super_admin against
// the tenant they act into — tenant-admin routes run `validateAuth`, i.e. Gate 2 (licence) and the
// suspension gate — so an unlicensed or suspended workspace refuses every tenant-admin screen. The
// SPA therefore refuses the switch UP FRONT with this reason, and if a selection is refused later
// (licence revoked while acting) the shell says so with the same reason.
//
// ⚠️ NOT `errorText`: those licence sentences address the workspace's own members ("your workspace
// doesn't have an active licence") — false for an operator looking at someone else's workspace.
import * as m from '$lib/paraglide/messages';

export function actAsReasonText(code: string): string {
	// Every Gate-2 verdict (`license_required`, `license_inactive`, `license_expired`,
	// `license_app_mismatch`, `license_tenant_mismatch`, `license_unreadable`, …) has one remedy
	// from the operator's chair: issue or repair the licence.
	if (code.startsWith('license_')) return m.act_as_reason_licence();
	if (code === 'tenant_suspended') return m.act_as_reason_suspended();
	if (code === 'tenant_offboarded') return m.act_as_reason_offboarded();
	if (code === 'tenant_not_provisioned') return m.act_as_reason_not_provisioned();
	return m.act_as_reason_other({ code });
}
